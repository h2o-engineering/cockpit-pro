/*
 * P02 V8-B — scoped local-folder storage substrate for the generic v2 writer.
 *
 * `sync-writer-transport-v2.mjs` (Z4) already owns everything protocol-shaped:
 * create-or-verify immutable semantics, pointer replacement, hash verification,
 * temporary naming, publication phase ordering and collision classification.
 * This module owns exactly one thing Z4 cannot: durable, confined, byte-exact
 * filesystem operations inside the resolver-authorized P02 repository.
 *
 * It is object-domain agnostic by construction. It never parses a payload and
 * never learns what a chat, note, folder, label or tag is; it sees opaque bytes
 * at whitelisted §J.1 paths, so a future domain uses it unchanged.
 *
 * Confinement is structural rather than sanitizing: a caller-supplied relative
 * path is PARSED into known segments and the real path is REBUILT from the
 * validated parts. Anything that is not one of the three frozen §J.1 shapes (or
 * its temporary form) never becomes a path at all, so traversal, absolute
 * paths, alternate separators and alternate roots are unrepresentable rather
 * than merely filtered. `library.info.json` matches no shape, so the writer
 * substrate cannot reach the V7 authority, and the parent P01 compatibility
 * artifacts live outside the root entirely.
 */

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::item11_delivery_destination::{
    authorization_root, write_exact_temporary, DELIVERY_TEMP_EXISTS,
};
use crate::p02_activation::{resolve_target_core, P02_AUTHORITY_FILE, P02_LIBRARY_INFO_SCHEMA};
use crate::p02_publication_authority::{
    authorize_mutation, resolved_container_hash, MutationTarget,
};
use crate::sync_contract_v2::{
    FORMAT_VERSION_V2, LAYOUT_EPOCH_V2, MAX_HEADS_SNAPSHOT_BYTES_V2, MAX_POINTER_BYTES_V2,
    MAX_REVISION_BYTES_V2, PROTOCOL_VERSION_V2,
};

/*
 * Local base64 codec.
 *
 * An earlier revision reused the accepted local-publication intake's private
 * helpers by widening their visibility. That was a two-word, behaviour-free
 * change, but it broke a deliberate byte-pin protecting that accepted P01
 * module - a duplicated codec is a far smaller cost than drift in a pinned
 * module, so P02 carries its own.
 */
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let value = (b0 << 16) | (b1 << 8) | b2;
        output.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 { ALPHABET[((value >> 6) & 63) as usize] as char } else { '=' });
        output.push(if chunk.len() > 2 { ALPHABET[(value & 63) as usize] as char } else { '=' });
    }
    output
}

fn base64_decode_exact(value: &str) -> Result<Vec<u8>, &'static str> {
    if value.is_empty() || value.len() % 4 != 0 {
        return Err(STORAGE_BYTES_INVALID);
    }
    let padding = value.bytes().rev().take_while(|byte| *byte == b'=').count();
    if padding > 2
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || byte == b'+'
                || byte == b'/'
                || (byte == b'=' && index >= value.len() - padding)
        })
    {
        return Err(STORAGE_BYTES_INVALID);
    }
    let mut output = Vec::with_capacity(value.len() / 4 * 3);
    let mut buffer = 0_u32;
    let mut bits = 0_u32;
    for byte in value.bytes().filter(|byte| *byte != b'=') {
        let index = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(STORAGE_BYTES_INVALID),
        } as u32;
        buffer = (buffer << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(output)
}

pub const P02_WRITER_STORAGE_SCHEMA: &str = "h2o.studio.syncWriterStorageLocal.p02.v1";

pub const STORAGE_PATH_REJECTED: &str = "p02-v8b-storage-path-rejected";
pub const STORAGE_ROOT_UNAVAILABLE: &str = "p02-v8b-repository-root-unavailable";
pub const STORAGE_NOT_ACTIVATED: &str = "p02-v8b-format-authority-not-activated";
pub const STORAGE_READ_FAILED: &str = "p02-v8b-storage-read-failed";
pub const STORAGE_WRITE_FAILED: &str = "p02-v8b-storage-write-failed";
pub const STORAGE_TEMPORARY_EXISTS: &str = "p02-v8b-storage-temporary-exists";
pub const STORAGE_TARGET_EXISTS: &str = "p02-v8b-storage-target-exists";
pub const STORAGE_PROMOTE_FAILED: &str = "p02-v8b-storage-promote-failed";
pub const STORAGE_LIMIT_EXCEEDED: &str = "p02-v8b-storage-limit-exceeded";
pub const STORAGE_BYTES_INVALID: &str = "p02-v8b-storage-bytes-invalid";

/* The three frozen §J.1 document classes this substrate will carry. */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StorageKind {
    RevisionBlob,
    HeadsSnapshot,
    WriterState,
}

impl StorageKind {
    /* V9/§E byte admission: reuse the frozen per-document limits, do not invent
     * a storage-pressure policy here. Capacity ABOVE a single document (retained
     * evidence totals, per-object row counts) stays with the V9 authority. */
    fn maximum_bytes(self) -> usize {
        match self {
            StorageKind::RevisionBlob => MAX_REVISION_BYTES_V2,
            StorageKind::HeadsSnapshot => MAX_HEADS_SNAPSHOT_BYTES_V2,
            StorageKind::WriterState => MAX_POINTER_BYTES_V2,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct StoragePath {
    kind: StorageKind,
    temporary: bool,
    segments: Vec<String>,
    /* Identity the governed lease binds against: the object key plus the exact
     * revision blob for a revision document, or the writer key for anything
     * under a writer subtree. Derived from the same validated segments as the
     * path itself, so the two can never disagree. */
    object_key: Option<String>,
    revision_blob_sha256: Option<String>,
    writer_key: Option<String>,
}

impl StoragePath {
    pub(crate) fn mutation_target(&self) -> Result<MutationTarget<'_>, &'static str> {
        match (&self.object_key, &self.revision_blob_sha256, &self.writer_key) {
            (Some(object_key), Some(blob), _) => Ok(MutationTarget::ObjectRevision {
                object_key,
                revision_blob_sha256: blob,
            }),
            (_, _, Some(writer_key)) => Ok(MutationTarget::WriterSubtree { writer_key }),
            _ => Err(STORAGE_PATH_REJECTED),
        }
    }
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/* `<64hex>.json`, optionally suffixed `.pending-<64hex>`. */
fn parse_document_leaf(leaf: &str) -> Option<(String, bool)> {
    let (base, temporary) = match leaf.split_once(".json.pending-") {
        Some((stem, identity)) => {
            if !is_lower_hex_64(identity) {
                return None;
            }
            (stem, true)
        }
        None => (leaf.strip_suffix(".json")?, false),
    };
    if !is_lower_hex_64(base) {
        return None;
    }
    Some((format!("{base}.json"), temporary))
}

/* `state.json`, optionally suffixed `.pending-<64hex>`. */
fn parse_state_leaf(leaf: &str) -> Option<bool> {
    match leaf.split_once(".pending-") {
        Some((stem, identity)) => {
            if stem != "state.json" || !is_lower_hex_64(identity) {
                return None;
            }
            Some(true)
        }
        None => {
            if leaf != "state.json" {
                return None;
            }
            Some(false)
        }
    }
}

/*
 * Whitelist parser. Only the frozen §J.1 shapes are representable:
 *
 *   objects/<objectKey>/revisions/<revisionBlobSha256>.json
 *   writers/<writerKey>/heads/<headsSnapshotSha256>.json
 *   writers/<writerKey>/state.json
 *
 * plus each one's `.pending-<64hex>` temporary form. Every other input - an
 * absolute path, `..`, an empty segment, a backslash, a colon, a control
 * character, `library.info.json`, any other root - is rejected before a path
 * is ever constructed.
 */
pub(crate) fn parse_storage_path(relative: &str) -> Result<StoragePath, &'static str> {
    if relative.is_empty()
        || relative.len() > 512
        || relative.starts_with('/')
        || relative.contains('\\')
        || relative.contains(':')
        || relative.contains("//")
        || relative.chars().any(|character| character.is_control())
    {
        return Err(STORAGE_PATH_REJECTED);
    }
    let parts: Vec<&str> = relative.split('/').collect();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == ".." || part.trim() != *part)
    {
        return Err(STORAGE_PATH_REJECTED);
    }
    let (kind, temporary, segments) = match parts.as_slice() {
        ["objects", object_key, "revisions", leaf] if is_lower_hex_64(object_key) => {
            let (name, temporary) = parse_document_leaf(leaf).ok_or(STORAGE_PATH_REJECTED)?;
            (
                StorageKind::RevisionBlob,
                temporary,
                vec![
                    "objects".to_string(),
                    (*object_key).to_string(),
                    "revisions".to_string(),
                    if temporary { (*leaf).to_string() } else { name },
                ],
            )
        }
        ["writers", writer_key, "heads", leaf] if is_lower_hex_64(writer_key) => {
            let (name, temporary) = parse_document_leaf(leaf).ok_or(STORAGE_PATH_REJECTED)?;
            (
                StorageKind::HeadsSnapshot,
                temporary,
                vec![
                    "writers".to_string(),
                    (*writer_key).to_string(),
                    "heads".to_string(),
                    if temporary { (*leaf).to_string() } else { name },
                ],
            )
        }
        ["writers", writer_key, leaf] if is_lower_hex_64(writer_key) => {
            let temporary = parse_state_leaf(leaf).ok_or(STORAGE_PATH_REJECTED)?;
            (
                StorageKind::WriterState,
                temporary,
                vec![
                    "writers".to_string(),
                    (*writer_key).to_string(),
                    (*leaf).to_string(),
                ],
            )
        }
        _ => return Err(STORAGE_PATH_REJECTED),
    };
    let (object_key, revision_blob_sha256, writer_key) = match kind {
        StorageKind::RevisionBlob => (
            Some(segments[1].clone()),
            Some(
                segments[3]
                    .split_once(".json")
                    .map(|(base, _)| base.to_string())
                    .ok_or(STORAGE_PATH_REJECTED)?,
            ),
            None,
        ),
        StorageKind::HeadsSnapshot | StorageKind::WriterState => {
            (None, None, Some(segments[1].clone()))
        }
    };
    Ok(StoragePath {
        kind,
        temporary,
        segments,
        object_key,
        revision_blob_sha256,
        writer_key,
    })
}

impl StoragePath {
    /* Rebuilt from validated segments; the caller's string is never joined. */
    fn resolve(&self, root: &Path) -> PathBuf {
        let mut path = root.to_path_buf();
        for segment in &self.segments {
            path.push(segment);
        }
        path
    }
}

/*
 * Repository authority is resolver-derived on EVERY operation, so a destination
 * that was moved, replaced or rebound since the last call fails closed rather
 * than writing into a stale location. No caller-supplied root is accepted.
 */
fn repository_root(app: &tauri::AppHandle) -> Result<PathBuf, &'static str> {
    let root = authorization_root(app).map_err(|_| STORAGE_ROOT_UNAVAILABLE)?;
    let target = resolve_target_core(&root)?;
    let repository = PathBuf::from(&target.repository_root);
    if !repository.is_dir() {
        return Err(STORAGE_ROOT_UNAVAILABLE);
    }
    Ok(repository)
}

/*
 * Y-10 write eligibility. V8-B never activates anything; it refuses to write
 * into a repository whose V7 format authority is absent or unsupported.
 */
fn require_activated(repository: &Path) -> Result<(), &'static str> {
    let authority = repository.join(P02_AUTHORITY_FILE);
    let bytes = fs::read(&authority).map_err(|_| STORAGE_NOT_ACTIVATED)?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| STORAGE_NOT_ACTIVATED)?;
    let supported = value.get("schema").and_then(|item| item.as_str()) == Some(P02_LIBRARY_INFO_SCHEMA)
        && value.get("formatVersion").and_then(|item| item.as_u64()) == Some(FORMAT_VERSION_V2)
        /* Same compatibility-range rule as the publication gate: the field
         * states the OLDEST protocol that can safely read this layout, so a
         * lower declared minimum is readable, not unreadable. Schema, format
         * version and layout epoch remain exact identity checks. */
        && value
            .get("minimumCompatibleProtocolVersion")
            .and_then(|item| item.as_u64())
            .is_some_and(|version| (1..=PROTOCOL_VERSION_V2).contains(&version))
        && value.get("layoutEpoch").and_then(|item| item.as_u64()) == Some(LAYOUT_EPOCH_V2);
    if !supported {
        return Err(STORAGE_NOT_ACTIVATED);
    }
    Ok(())
}

fn fsync_directory(path: &Path) -> Result<(), &'static str> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| STORAGE_WRITE_FAILED)
}

/* Symlinks are refused rather than followed, matching the accepted reader. */
fn read_exact_file(path: &Path, maximum: usize) -> Result<Option<Vec<u8>>, &'static str> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(STORAGE_READ_FAILED),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(STORAGE_PATH_REJECTED);
    }
    if metadata.len() as usize > maximum {
        return Err(STORAGE_LIMIT_EXCEEDED);
    }
    let bytes = fs::read(path).map_err(|_| STORAGE_READ_FAILED)?;
    if bytes.len() > maximum {
        return Err(STORAGE_LIMIT_EXCEEDED);
    }
    Ok(Some(bytes))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageReadResult {
    pub schema: &'static str,
    pub present: bool,
    /* base64 so multi-MiB revision blobs do not cross the IPC as number arrays. */
    pub base64: Option<String>,
    pub byte_length: usize,
}

pub(crate) fn read_core(root: &Path, relative: &str) -> Result<StorageReadResult, &'static str> {
    let parsed = parse_storage_path(relative)?;
    let path = parsed.resolve(root);
    let bytes = read_exact_file(&path, parsed.kind.maximum_bytes())?;
    Ok(match bytes {
        Some(value) => StorageReadResult {
            schema: P02_WRITER_STORAGE_SCHEMA,
            present: true,
            byte_length: value.len(),
            base64: Some(base64_encode(&value)),
        },
        None => StorageReadResult {
            schema: P02_WRITER_STORAGE_SCHEMA,
            present: false,
            base64: None,
            byte_length: 0,
        },
    })
}

pub(crate) fn write_temporary_core(
    root: &Path,
    relative: &str,
    base64: &str,
    authorize: impl FnOnce(MutationTarget<'_>) -> Result<(), &'static str>,
) -> Result<usize, &'static str> {
    let parsed = parse_storage_path(relative)?;
    if !parsed.temporary {
        return Err(STORAGE_PATH_REJECTED);
    }
    /* Governed authority is checked before any byte is decoded or written. */
    authorize(parsed.mutation_target()?)?;
    let bytes = base64_decode_exact(base64).map_err(|_| STORAGE_BYTES_INVALID)?;
    if bytes.len() > parsed.kind.maximum_bytes() {
        return Err(STORAGE_LIMIT_EXCEEDED);
    }
    let path = parsed.resolve(root);
    let parent = path.parent().ok_or(STORAGE_PATH_REJECTED)?;
    fs::create_dir_all(parent).map_err(|_| STORAGE_WRITE_FAILED)?;
    /* create_new + O_NOFOLLOW + fsync, from the accepted writer. */
    write_exact_temporary(&path, &bytes).map_err(|code| {
        if code == DELIVERY_TEMP_EXISTS {
            STORAGE_TEMPORARY_EXISTS
        } else {
            STORAGE_WRITE_FAILED
        }
    })?;
    fsync_directory(parent)?;
    Ok(bytes.len())
}

pub(crate) fn read_temporary_core(
    root: &Path,
    relative: &str,
) -> Result<StorageReadResult, &'static str> {
    let parsed = parse_storage_path(relative)?;
    if !parsed.temporary {
        return Err(STORAGE_PATH_REJECTED);
    }
    read_core(root, relative)
}

/*
 * Promotion.
 *
 * `replace_existing = false` is the immutable case and uses `hard_link`, which
 * fails atomically when the target already exists: contradictory immutable
 * evidence can never be overwritten, and there is no check-then-rename window.
 * `replace_existing = true` is the writer pointer and uses `rename`, the atomic
 * replace Z4 requires for later publications.
 */
pub(crate) fn promote_temporary_core(
    root: &Path,
    pending_relative: &str,
    final_relative: &str,
    replace_existing: bool,
    authorize: impl FnOnce(MutationTarget<'_>) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    let pending = parse_storage_path(pending_relative)?;
    let final_parsed = parse_storage_path(final_relative)?;
    authorize(final_parsed.mutation_target()?)?;
    if !pending.temporary || final_parsed.temporary {
        return Err(STORAGE_PATH_REJECTED);
    }
    if pending.kind != final_parsed.kind {
        return Err(STORAGE_PATH_REJECTED);
    }
    /* A temporary may only ever promote onto its own final document. */
    let expected_prefix = format!("{}.pending-", final_parsed.segments.last().unwrap());
    if !pending
        .segments
        .last()
        .unwrap()
        .starts_with(&expected_prefix)
        || pending.segments[..pending.segments.len() - 1]
            != final_parsed.segments[..final_parsed.segments.len() - 1]
    {
        return Err(STORAGE_PATH_REJECTED);
    }
    if replace_existing && final_parsed.kind != StorageKind::WriterState {
        /* Only the mutable pointer may be replaced. */
        return Err(STORAGE_PATH_REJECTED);
    }

    let pending_path = pending.resolve(root);
    let final_path = final_parsed.resolve(root);
    let parent = final_path.parent().ok_or(STORAGE_PATH_REJECTED)?;

    if replace_existing {
        fs::rename(&pending_path, &final_path).map_err(|_| STORAGE_PROMOTE_FAILED)?;
    } else {
        match fs::hard_link(&pending_path, &final_path) {
            Ok(()) => {
                let _ = fs::remove_file(&pending_path);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                return Err(STORAGE_TARGET_EXISTS);
            }
            Err(_) => return Err(STORAGE_PROMOTE_FAILED),
        }
    }
    fsync_directory(parent)
}

#[tauri::command]
pub fn h2o_p02_storage_read(
    app: tauri::AppHandle,
    relative_path: String,
) -> Result<StorageReadResult, String> {
    let root = repository_root(&app).map_err(str::to_string)?;
    read_core(&root, &relative_path).map_err(str::to_string)
}


/*
 * O1-R3 B2 — one storage gate, TWO accepted lease authorities.
 *
 * A mutation is authorized by the V8-D first-publication lease OR by the steady
 * publication lease. Both are accepted authorities over the same targets, and
 * neither is widened here: this asks each in turn and takes the first YES.
 *
 * It matters because the two windows govern different moments. The first-writer
 * lease refuses once a writer pointer exists, and the steady lease requires the
 * CAS base that pointer establishes - so at any instant at most one of them can
 * possibly say yes. Consulting only the first left the steady window granting
 * capabilities that authorized nothing, which surfaced as an opaque
 * "publish-failed" rather than as a refusal naming its reason.
 *
 * The refusal reported on failure is the STEADY one when a steady lease is what
 * the caller holds, so the operator receipt names the check that actually said
 * no rather than the other authority's generic "capability invalid".
 */
fn authorize_publication_or_steady(
    app: &tauri::AppHandle,
    capability: &str,
    container: &str,
    target: MutationTarget<'_>,
) -> Result<(), &'static str> {
    let publication = authorize_mutation(capability, container, target);
    if publication.is_ok() {
        return publication;
    }
    let steady_target = match target {
        MutationTarget::ObjectRevision {
            object_key,
            revision_blob_sha256,
        } => crate::p02_steady_authority::SteadyMutationTarget::ObjectRevision {
            object_key,
            revision_blob_sha256,
        },
        MutationTarget::WriterSubtree { writer_key } => {
            crate::p02_steady_authority::SteadyMutationTarget::WriterSubtree { writer_key }
        }
    };
    /* The steady window binds a capability to the live profile-lock session,
     * exactly as the first-publication window does. */
    let boot_id = crate::sync_object_transport::live_session_boot_id(app)
        .map_err(|_| "p02-steady-boot-session-unavailable")?;
    match crate::p02_steady_authority::steady_authorize_core(
        capability,
        container,
        &boot_id,
        steady_target,
    ) {
        Ok(()) => Ok(()),
        /* Neither authority accepted. Report the steady refusal, which is the
         * specific one when a steady capability is in play. */
        Err(steady) => Err(steady),
    }
}

#[tauri::command]
pub fn h2o_p02_storage_write_temporary(
    app: tauri::AppHandle,
    relative_path: String,
    base64: String,
    capability: String,
) -> Result<usize, String> {
    let root = repository_root(&app).map_err(str::to_string)?;
    require_activated(&root).map_err(str::to_string)?;
    let container = resolved_container_hash(&app).map_err(str::to_string)?;
    write_temporary_core(&root, &relative_path, &base64, |target| {
        authorize_publication_or_steady(&app, &capability, &container, target)
    })
    .map_err(str::to_string)
}

#[tauri::command]
pub fn h2o_p02_storage_read_temporary(
    app: tauri::AppHandle,
    relative_path: String,
) -> Result<StorageReadResult, String> {
    let root = repository_root(&app).map_err(str::to_string)?;
    read_temporary_core(&root, &relative_path).map_err(str::to_string)
}

#[tauri::command]
pub fn h2o_p02_storage_promote_temporary(
    app: tauri::AppHandle,
    pending_path: String,
    final_path: String,
    replace_existing: bool,
    capability: String,
) -> Result<(), String> {
    let root = repository_root(&app).map_err(str::to_string)?;
    require_activated(&root).map_err(str::to_string)?;
    let container = resolved_container_hash(&app).map_err(str::to_string)?;
    promote_temporary_core(&root, &pending_path, &final_path, replace_existing, |target| {
        authorize_publication_or_steady(&app, &capability, &container, target)
    })
    .map_err(str::to_string)
}

#[cfg(test)]
pub(crate) fn base64_encode_for_tests(bytes: &[u8]) -> String {
    base64_encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    const KEY_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const KEY_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const KEY_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    /* Self-clearing disposable repository; nothing canonical is ever touched. */
    struct Fixture {
        container: PathBuf,
        root: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.container);
        }
    }

    fn fixture(label: &str) -> Fixture {
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let container = std::env::temp_dir().join(format!(
            "p02-v8b-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&container);
        let root = container.join("h2o-object-sync");
        fs::create_dir_all(&root).unwrap();
        /* A parent P01 compatibility artifact, outside the repository root. */
        fs::write(container.join("h2o-local-publication.v1.json"), b"p01-parent").unwrap();
        fs::write(
            root.join(P02_AUTHORITY_FILE),
            format!(
                /* Full ceremony shape, matching the V7 activation writer:
                 * seven top-level keys with the receipt embedded. */
                "{{\"activatedAt\":\"2026-08-25T20:02:31.477Z\",\
                  \"activatedByWriterSyncPeerId\":\"studio-desktop:test-peer\",\
                  \"formatVersion\":{FORMAT_VERSION_V2},\
                  \"layoutEpoch\":{LAYOUT_EPOCH_V2},\
                  \"legacyBaselineReceipt\":{{\"artifacts\":[],\
                    \"capturedAt\":\"2026-08-25T20:02:31.477Z\",\
                    \"schema\":\"h2o.studio.syncLegacyBaseline.p02.v1\"}},\
                  \"minimumCompatibleProtocolVersion\":{PROTOCOL_VERSION_V2},\
                  \"schema\":\"{P02_LIBRARY_INFO_SCHEMA}\"}}"
            ),
        )
        .unwrap();
        Fixture { container, root }
    }

    fn revision_path(blob: &str) -> String {
        format!("objects/{KEY_A}/revisions/{blob}.json")
    }

    /* H, I, J, L, M: only the frozen shapes are representable at all. */
    /*
     * Same range rule as the publication gate, pinned independently: these are
     * two separate write gates and A1 requires both to move together. A change
     * to one alone would silently leave half the surface refusing readable
     * repositories.
     */
    #[test]
    fn minimum_compatible_protocol_is_a_range_at_the_storage_gate() {
        fn authority_with_min(min: u64) -> String {
            format!(
                "{{\"activatedAt\":\"2026-08-25T20:02:31.477Z\",\
                  \"activatedByWriterSyncPeerId\":\"studio-desktop:test-peer\",\
                  \"formatVersion\":{FORMAT_VERSION_V2},\
                  \"layoutEpoch\":{LAYOUT_EPOCH_V2},\
                  \"legacyBaselineReceipt\":{{\"artifacts\":[],\
                    \"capturedAt\":\"2026-08-25T20:02:31.477Z\",\
                    \"schema\":\"h2o.studio.syncLegacyBaseline.p02.v1\"}},\
                  \"minimumCompatibleProtocolVersion\":{min},\
                  \"schema\":\"{P02_LIBRARY_INFO_SCHEMA}\"}}"
            )
        }
        let fx = fixture("min-protocol-range");
        for accepted in 1..=PROTOCOL_VERSION_V2 {
            fs::write(fx.root.join(P02_AUTHORITY_FILE), authority_with_min(accepted)).unwrap();
            assert!(
                require_activated(&fx.root).is_ok(),
                "minimum {accepted} is within the supported range"
            );
        }
        fs::write(
            fx.root.join(P02_AUTHORITY_FILE),
            authority_with_min(PROTOCOL_VERSION_V2 + 1),
        )
        .unwrap();
        assert_eq!(require_activated(&fx.root), Err(STORAGE_NOT_ACTIVATED));
    }

    #[test]
    fn only_frozen_j1_shapes_parse() {
        for good in [
            format!("objects/{KEY_A}/revisions/{KEY_B}.json"),
            format!("objects/{KEY_A}/revisions/{KEY_B}.json.pending-{KEY_C}"),
            format!("writers/{KEY_A}/heads/{KEY_B}.json"),
            format!("writers/{KEY_A}/heads/{KEY_B}.json.pending-{KEY_C}"),
            format!("writers/{KEY_A}/state.json"),
            format!("writers/{KEY_A}/state.json.pending-{KEY_C}"),
        ] {
            assert!(parse_storage_path(&good).is_ok(), "must accept {good}");
        }
        for bad in [
            "library.info.json".to_string(),
            format!("objects/{KEY_A}/revisions/../../library.info.json"),
            format!("../h2o-local-publication.v1.json"),
            "../../etc/passwd".to_string(),
            "/etc/passwd".to_string(),
            format!("/objects/{KEY_A}/revisions/{KEY_B}.json"),
            format!("objects\\{KEY_A}\\revisions\\{KEY_B}.json"),
            format!("objects/{KEY_A}//revisions/{KEY_B}.json"),
            format!("objects/{KEY_A}/revisions/{KEY_B}.txt"),
            format!("objects/{KEY_A}/revisions/not-hex.json"),
            format!("objects/{KEY_A}/{KEY_B}.json"),
            format!("writers/{KEY_A}/heads/{KEY_B}.json/extra"),
            format!("writers/{KEY_A}/other.json"),
            format!("writers/{KEY_A}/state.json.pending-not-hex"),
            format!("objects/{KEY_A}/revisions/{KEY_B}.json.pending-{KEY_C}.pending-{KEY_C}"),
            "objects/../writers/x/state.json".to_string(),
            format!("C:/objects/{KEY_A}/revisions/{KEY_B}.json"),
            "".to_string(),
            " ".to_string(),
        ] {
            assert_eq!(
                parse_storage_path(&bad).unwrap_err(),
                STORAGE_PATH_REJECTED,
                "must reject {bad:?}"
            );
        }
    }

    /* A: a missing target reads as absent, not as an error. */
    #[test]
    fn missing_target_reads_absent() {
        let fx = fixture("missing");
        let result = read_core(&fx.root, &revision_path(KEY_B)).unwrap();
        assert!(!result.present && result.base64.is_none() && result.byte_length == 0);
    }

    /* B, C: temporary write, byte-exact readback, promote to final. */
    #[test]
    fn temporary_write_readback_and_promote_are_byte_exact() {
        let fx = fixture("promote");
        let final_rel = revision_path(KEY_B);
        let pending_rel = format!("{final_rel}.pending-{KEY_C}");
        let payload = b"{\"immutable\":true}".to_vec();
        let encoded = base64_encode(&payload);
        assert_eq!(
            write_temporary_core(&fx.root, &pending_rel, &encoded, |_| Ok(())).unwrap(),
            payload.len()
        );
        let pending = read_temporary_core(&fx.root, &pending_rel).unwrap();
        assert_eq!(base64_decode_exact(&pending.base64.unwrap()).unwrap(), payload);
        promote_temporary_core(&fx.root, &pending_rel, &final_rel, false, |_| Ok(())).unwrap();
        let finalized = read_core(&fx.root, &final_rel).unwrap();
        assert!(finalized.present);
        assert_eq!(
            base64_decode_exact(&finalized.base64.unwrap()).unwrap(),
            payload
        );
        /* The temporary is consumed, leaving no stale pending file. */
        assert!(!read_temporary_core(&fx.root, &pending_rel).unwrap().present);
    }

    /* E: contradictory immutable evidence is never overwritten. */
    #[test]
    fn immutable_collision_fails_closed_and_preserves_original() {
        let fx = fixture("collision");
        let final_rel = revision_path(KEY_B);
        let original = b"{\"first\":true}".to_vec();
        let first_pending = format!("{final_rel}.pending-{KEY_C}");
        write_temporary_core(&fx.root, &first_pending, &base64_encode(&original), |_| Ok(())).unwrap();
        promote_temporary_core(&fx.root, &first_pending, &final_rel, false, |_| Ok(())).unwrap();

        let contradictory = b"{\"second\":true}".to_vec();
        let second_pending = format!("{final_rel}.pending-{KEY_A}");
        write_temporary_core(&fx.root, &second_pending, &base64_encode(&contradictory), |_| Ok(())).unwrap();
        assert_eq!(
            promote_temporary_core(&fx.root, &second_pending, &final_rel, false, |_| Ok(())).unwrap_err(),
            STORAGE_TARGET_EXISTS
        );
        let kept = read_core(&fx.root, &final_rel).unwrap();
        assert_eq!(base64_decode_exact(&kept.base64.unwrap()).unwrap(), original);
        /* Retained contradictory evidence is not deleted to make retry pass. */
        assert!(read_temporary_core(&fx.root, &second_pending).unwrap().present);
    }

    /* F, G: the mutable pointer is created and then atomically replaced. */
    #[test]
    fn writer_pointer_creates_then_replaces_atomically() {
        let fx = fixture("pointer");
        let final_rel = format!("writers/{KEY_A}/state.json");
        for (identity, body) in [(KEY_B, b"{\"v\":1}".to_vec()), (KEY_C, b"{\"v\":2}".to_vec())] {
            let pending = format!("{final_rel}.pending-{identity}");
            write_temporary_core(&fx.root, &pending, &base64_encode(&body), |_| Ok(())).unwrap();
            promote_temporary_core(&fx.root, &pending, &final_rel, true, |_| Ok(())).unwrap();
            let current = read_core(&fx.root, &final_rel).unwrap();
            assert_eq!(base64_decode_exact(&current.base64.unwrap()).unwrap(), body);
        }
    }

    /* Immutable documents can never take the replacing promotion path. */
    #[test]
    fn immutable_targets_refuse_replacement() {
        let fx = fixture("no-replace");
        let final_rel = revision_path(KEY_B);
        let pending = format!("{final_rel}.pending-{KEY_C}");
        write_temporary_core(&fx.root, &pending, &base64_encode(b"x"), |_| Ok(())).unwrap();
        assert_eq!(
            promote_temporary_core(&fx.root, &pending, &final_rel, true, |_| Ok(())).unwrap_err(),
            STORAGE_PATH_REJECTED
        );
    }

    /* A temporary may only promote onto its own final document. */
    #[test]
    fn temporary_cannot_promote_onto_a_foreign_final() {
        let fx = fixture("foreign");
        let mine = revision_path(KEY_B);
        let other = revision_path(KEY_C);
        let pending = format!("{mine}.pending-{KEY_A}");
        write_temporary_core(&fx.root, &pending, &base64_encode(b"x"), |_| Ok(())).unwrap();
        assert_eq!(
            promote_temporary_core(&fx.root, &pending, &other, false, |_| Ok(())).unwrap_err(),
            STORAGE_PATH_REJECTED
        );
        assert_eq!(
            promote_temporary_core(&fx.root, &pending, &pending, false, |_| Ok(())).unwrap_err(),
            STORAGE_PATH_REJECTED
        );
    }

    /* J: a symlink standing in for a document is refused, never followed. */
    #[test]
    #[cfg(unix)]
    fn symlink_targets_are_refused() {
        let fx = fixture("symlink");
        let secret = fx.container.join("h2o-local-publication.v1.json");
        let revisions = fx.root.join("objects").join(KEY_A).join("revisions");
        fs::create_dir_all(&revisions).unwrap();
        std::os::unix::fs::symlink(&secret, revisions.join(format!("{KEY_B}.json"))).unwrap();
        assert_eq!(
            read_core(&fx.root, &revision_path(KEY_B)).unwrap_err(),
            STORAGE_PATH_REJECTED
        );
        /* The parent artifact is untouched by the attempt. */
        assert_eq!(fs::read(&secret).unwrap(), b"p01-parent");
    }

    /* L, M: neither the V7 authority nor the parent artifacts are reachable. */
    #[test]
    fn v7_authority_and_parent_artifacts_are_unreachable() {
        let fx = fixture("preserve");
        for attempt in [
            "library.info.json",
            "../h2o-local-publication.v1.json",
            "../../h2o-local-publication.v1.json",
        ] {
            assert_eq!(
                write_temporary_core(&fx.root, attempt, &base64_encode(b"x"), |_| Ok(())).unwrap_err(),
                STORAGE_PATH_REJECTED
            );
            assert_eq!(read_core(&fx.root, attempt).unwrap_err(), STORAGE_PATH_REJECTED);
        }
        assert!(fx.root.join(P02_AUTHORITY_FILE).is_file());
        assert_eq!(
            fs::read(fx.container.join("h2o-local-publication.v1.json")).unwrap(),
            b"p01-parent"
        );
    }

    /* O: per-document byte admission reuses the frozen limits. */
    #[test]
    fn capacity_limits_are_the_frozen_per_document_bounds() {
        let fx = fixture("capacity");
        let pointer = format!("writers/{KEY_A}/state.json.pending-{KEY_B}");
        let oversize = vec![b'x'; MAX_POINTER_BYTES_V2 + 1];
        assert_eq!(
            write_temporary_core(&fx.root, &pointer, &base64_encode(&oversize), |_| Ok(())).unwrap_err(),
            STORAGE_LIMIT_EXCEEDED
        );
        let allowed = vec![b'x'; MAX_POINTER_BYTES_V2];
        assert!(write_temporary_core(&fx.root, &pointer, &base64_encode(&allowed), |_| Ok(())).is_ok());
        assert_eq!(StorageKind::RevisionBlob.maximum_bytes(), MAX_REVISION_BYTES_V2);
        assert_eq!(StorageKind::HeadsSnapshot.maximum_bytes(), MAX_HEADS_SNAPSHOT_BYTES_V2);
    }

    /* N: an interrupted temporary never becomes a final document. */
    #[test]
    fn interrupted_temporary_leaves_no_final_state() {
        let fx = fixture("interrupted");
        let final_rel = revision_path(KEY_B);
        let pending = format!("{final_rel}.pending-{KEY_C}");
        write_temporary_core(&fx.root, &pending, &base64_encode(b"partial"), |_| Ok(())).unwrap();
        /* Crash here: the temporary exists, the final does not. */
        assert!(read_temporary_core(&fx.root, &pending).unwrap().present);
        assert!(!read_core(&fx.root, &final_rel).unwrap().present);
        /* A second temporary write onto the same pending path fails closed. */
        assert_eq!(
            write_temporary_core(&fx.root, &pending, &base64_encode(b"other"), |_| Ok(())).unwrap_err(),
            STORAGE_TEMPORARY_EXISTS
        );
    }

    /* K: writes refuse a repository whose V7 authority is absent or unsupported. */
    #[test]
    fn writes_require_supported_v7_authority() {
        let fx = fixture("gate");
        assert!(require_activated(&fx.root).is_ok());
        fs::write(fx.root.join(P02_AUTHORITY_FILE), b"{\"schema\":\"other\"}").unwrap();
        assert_eq!(require_activated(&fx.root).unwrap_err(), STORAGE_NOT_ACTIVATED);
        fs::remove_file(fx.root.join(P02_AUTHORITY_FILE)).unwrap();
        assert_eq!(require_activated(&fx.root).unwrap_err(), STORAGE_NOT_ACTIVATED);
    }

    /* The substrate carries opaque bytes; it never parses a domain payload. */
    #[test]
    fn substrate_is_domain_agnostic() {
        let fx = fixture("agnostic");
        let final_rel = format!("objects/{KEY_C}/revisions/{KEY_B}.json");
        let pending = format!("{final_rel}.pending-{KEY_A}");
        let opaque = b"\x00\x01\x02 not json at all \xff".to_vec();
        write_temporary_core(&fx.root, &pending, &base64_encode(&opaque), |_| Ok(())).unwrap();
        promote_temporary_core(&fx.root, &pending, &final_rel, false, |_| Ok(())).unwrap();
        let stored = read_core(&fx.root, &final_rel).unwrap();
        assert_eq!(base64_decode_exact(&stored.base64.unwrap()).unwrap(), opaque);
    }
}
