//! M09 P0.3c — FD-bound portable saved-chat ZIP publication.
//!
//! The renderer supplies verified ZIP bytes plus an expected SHA-256/length,
//! one governed final leaf, and a 128-bit lowercase-hex operation token. This
//! module resolves both the immutable governed export root and a fixed
//! native-only sibling staging root, stages the bytes exclusively, retains the
//! created handle through write/sync/readback, and creates the final name
//! from that verified handle — never from the staging pathname.
//!
//! Platform realization (T02, frozen contract §11.1 class D3):
//! * macOS — named exclusive stage in the sibling staging root, published by
//!   `fclonefileat` (an atomic clone of the object the retained descriptor
//!   selects; `CAP-CLONE` probed per (staging root, final root) pair);
//! * Linux — an anonymous `O_TMPFILE` inode created IN the final directory,
//!   published by descriptor-bound `linkat` (no staging pathname exists);
//! * Windows — named exclusive stage in the sibling staging root, published
//!   by a handle-bound `ReplaceIfExists = FALSE` rename into the final
//!   directory, then re-identified under the final name (class H′).
//!
//! No renderer-callable operation accepts a pre-existing staged pathname. The
//! publication syscall never resolves the staging pathname, so a post-check
//! substitution cannot redirect the published bytes. Cleanup touches the
//! staging pathname only while it still identifies the owned object.
//! Publication into a root whose filesystem cannot prove the required
//! primitives is refused before staging (`capability-unproven`); a volume that
//! cannot clone (macOS) or that is not the staging volume (Windows) reports
//! the filesystem condition (`unsupported-filesystem-capability`), and a
//! platform without a compiled arm reports `unsupported-platform`.

use serde::Serialize;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, RawFd};
use std::path::Path;

#[cfg(test)]
use std::path::PathBuf;

use crate::archive_durable_write::confined::{self, ObjectIdentity};
use crate::archive_filesystem_capability as capability;

const FINAL_SUFFIX: &str = ".h2ochat.zip";
const TEMP_SUFFIX_PREFIX: &str = ".tmp-";
const TOKEN_HEX_LENGTH: usize = 32;
const SHA256_PREFIX: &str = "sha256-";
const SHA256_HEX_LENGTH: usize = 64;
const RESULT_SCHEMA: &str = "h2o.savedChatZipPublish.v1";

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatZipPublishOptions {
    final_name: String,
    token: String,
    expected_sha256: String,
    expected_byte_length: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatZipPublishResult {
    schema: &'static str,
    ok: bool,
    status: &'static str,
    staging_removed: bool,
    committed: bool,
    durability_complete: bool,
    byte_length: u64,
    sha256: String,
    /// True only when the macOS `F_FULLFSYNC` media fence succeeded. On Linux
    /// and Windows this stays `false` while the platform's documented fence
    /// was issued; durability is carried by `committed` / `durabilityComplete`.
    full_fsync: bool,
}

impl SavedChatZipPublishResult {
    fn published(
        staging_removed: bool,
        byte_length: u64,
        sha256: String,
        full_fsync: bool,
        durability_complete: bool,
    ) -> Self {
        Self {
            schema: RESULT_SCHEMA,
            ok: true,
            status: "published",
            staging_removed,
            committed: true,
            durability_complete,
            byte_length,
            sha256,
            full_fsync,
        }
    }

    fn refused(status: &'static str, staging_removed: bool) -> Self {
        Self {
            schema: RESULT_SCHEMA,
            ok: false,
            status,
            staging_removed,
            committed: false,
            durability_complete: false,
            byte_length: 0,
            sha256: String::new(),
            full_fsync: false,
        }
    }
}

/// Governed ASCII leaf admission (contract §12): trimmed, no separators, no
/// drive prefix, no `..`, ASCII `[A-Za-z0-9._ -]`, no leading `.`, and no
/// Windows reserved device stem (whole stem or the segment before the first
/// `.`) on ANY platform. Nothing is normalized, case-folded or trimmed to fit.
fn is_safe_ascii_leaf(name: &str) -> bool {
    if name.is_empty()
        || name != name.trim()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || Path::new(name).is_absolute()
    {
        return false;
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    if crate::archive_durable_write::has_reserved_device_stem(name) {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b'-' | b' '))
}

fn final_name_is_governed(final_name: &str) -> bool {
    is_safe_ascii_leaf(final_name)
        && final_name
            .strip_suffix(FINAL_SUFFIX)
            .is_some_and(|stem| !stem.is_empty())
}

fn token_is_governed(token: &str) -> bool {
    token.len() == TOKEN_HEX_LENGTH
        && token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn expected_sha256_hex(value: &str) -> Option<&str> {
    let hex = value.strip_prefix(SHA256_PREFIX)?;
    (hex.len() == SHA256_HEX_LENGTH
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
    .then_some(hex)
}

fn stage_name(final_name: &str, token: &str) -> String {
    format!("{final_name}{TEMP_SUFFIX_PREFIX}{token}")
}

/// Unix identity of the retained staging descriptor: `fstat` on the
/// descriptor itself (`st_dev` + `st_ino`) — the accepted macOS mechanism.
#[cfg(unix)]
fn fstat(fd: RawFd) -> io::Result<libc::stat> {
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::fstat(fd, &mut stat) };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(stat)
}

/// Identity and regular-file-ness of the object the retained handle selects.
#[cfg(unix)]
fn owned_identity(handle: &File) -> io::Result<Option<ObjectIdentity>> {
    let stat = fstat(handle.as_raw_fd())?;
    if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Ok(None);
    }
    Ok(Some(ObjectIdentity {
        device: stat.st_dev as u64,
        object: stat.st_ino as u128,
    }))
}

#[cfg(not(unix))]
fn owned_identity(handle: &File) -> io::Result<Option<ObjectIdentity>> {
    confined::file_identity(handle).map(Some)
}

fn staged_is_regular(stat: &confined::EntryStat) -> bool {
    stat.is_regular()
}

fn hash_owned_file(handle: &mut File) -> io::Result<(u64, String)> {
    use sha2::{Digest, Sha256};

    handle.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = handle.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
        hasher.update(&buffer[..read]);
    }
    Ok((total, format!("{SHA256_PREFIX}{:x}", hasher.finalize())))
}

fn path_still_names_owned_file(
    dir: &confined::Dir,
    staged_name: &[u8],
    owned: ObjectIdentity,
) -> io::Result<bool> {
    let Some(stat) = dir.stat_child_nofollow(staged_name)? else {
        return Ok(false);
    };
    Ok(staged_is_regular(&stat) && stat.identity() == owned)
}

/// Removes the staging pathname only while it still names the object this
/// transaction exclusively created. A missing path is already clean; a
/// substituted path is foreign and deliberately left untouched.
fn cleanup_owned_stage(dir: &confined::Dir, staged_name: &[u8], owned: ObjectIdentity) -> bool {
    match path_still_names_owned_file(dir, staged_name, owned) {
        Ok(false) => matches!(dir.stat_child_nofollow(staged_name), Ok(None)),
        Err(_) => false,
        Ok(true) => {
            if dir.unlink_child(staged_name).is_err() {
                return false;
            }
            matches!(dir.stat_child_nofollow(staged_name), Ok(None))
        }
    }
}

/// Compile-time arm absent (contract §10: `…-unsupported-platform`).
fn publication_is_unsupported(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported
}

/// The volume lacks the publication primitive (macOS: no clone capability or
/// a foreign volume, `ENOTSUP` / `EXDEV`; Windows: not the same volume,
/// `STATUS_NOT_SAME_DEVICE`): a FILESYSTEM condition, no longer misreported
/// as a platform one.
fn publication_is_filesystem_refusal(error: &io::Error) -> bool {
    !publication_is_unsupported(error) && confined::is_capability_absent(error)
}

/// Where this platform stages the bytes before publication.
enum StagePlacement {
    /// Named exclusive stage in the sibling staging root (macOS, Windows).
    SiblingNamed,
    /// Anonymous inode in the final directory (Linux).
    AnonymousInFinal,
}

fn stage_placement() -> StagePlacement {
    if cfg!(target_os = "linux") {
        StagePlacement::AnonymousInFinal
    } else {
        StagePlacement::SiblingNamed
    }
}

/// Explicit NAME_MAX admission on the admitted directory object (contract
/// §12): the longer staged name is admitted where it is created, the final
/// name where it is published.
fn name_fits(dir: &confined::Dir, name: &str) -> Result<(), &'static str> {
    match dir.name_max() {
        Ok(limit) if name.len() as u64 <= limit => Ok(()),
        Ok(_) => Err("name-exceeds-filesystem-limit"),
        Err(_) => Err("name-limit-indeterminate"),
    }
}

/// Proves the capabilities this platform's publication relies on, on the
/// roots it uses, BEFORE any staging exists.
fn require_publication_capabilities(
    final_dir: &confined::Dir,
    staging_dir: Option<&confined::Dir>,
) -> Result<(), &'static str> {
    // A root this process cannot write is a permission condition, reported
    // with the accepted infrastructure codes, never as a capability verdict.
    fn refusal(err: capability::CapabilityRefusal, infrastructure: &'static str) -> &'static str {
        if err.is_root_not_writable() {
            infrastructure
        } else {
            "capability-unproven"
        }
    }
    match stage_placement() {
        StagePlacement::AnonymousInFinal => {
            capability::require(final_dir, capability::file_publication_requirements())
                .map(|_| ())
                .map_err(|err| refusal(err, "stage-create-failed"))
        }
        StagePlacement::SiblingNamed => {
            let staging = staging_dir.ok_or("capability-unproven")?;
            capability::require(staging, &[capability::Capability::Exclusive])
                .map_err(|err| refusal(err, "stage-create-failed"))?;
            if cfg!(target_os = "macos") {
                capability::require(final_dir, &[capability::Capability::DirectoryFence])
                    .map_err(|err| refusal(err, "publish-failed"))?;
                match capability::probe_clone_pair(staging, final_dir) {
                    capability::CapabilityState::Proven => Ok(()),
                    capability::CapabilityState::Absent(_) => {
                        Err("unsupported-filesystem-capability")
                    }
                    capability::CapabilityState::NotApplicable => Err("unsupported-platform"),
                }
            } else {
                capability::require(final_dir, capability::directory_publication_requirements())
                    .map(|_| ())
                    .map_err(|err| refusal(err, "publish-failed"))
            }
        }
    }
}

/// The retained staging object of one transaction.
struct Stage {
    handle: File,
    /// `None` for an anonymous inode (nothing to clean, nothing to swap).
    named: Option<(confined::Dir, Vec<u8>)>,
    owned: ObjectIdentity,
}

fn publish_bytes_within_roots_with<B, P, S>(
    final_root: &Path,
    staging_root: &Path,
    options: &SavedChatZipPublishOptions,
    bytes: &[u8],
    after_path_check_before_publish: B,
    publish: P,
    sync_final_parent: S,
) -> SavedChatZipPublishResult
where
    B: FnOnce(&confined::Dir, &[u8]) -> io::Result<()>,
    P: FnOnce(&confined::Dir, &File, &[u8]) -> io::Result<bool>,
    S: FnOnce(&confined::Dir) -> io::Result<()>,
{
    if !final_name_is_governed(&options.final_name) {
        return SavedChatZipPublishResult::refused("invalid-name", false);
    }
    if !token_is_governed(&options.token) {
        return SavedChatZipPublishResult::refused("invalid-token", false);
    }
    if expected_sha256_hex(&options.expected_sha256).is_none() {
        return SavedChatZipPublishResult::refused("invalid-expected-sha256", false);
    }
    if options.expected_byte_length == 0 || options.expected_byte_length > usize::MAX as u64 {
        return SavedChatZipPublishResult::refused("invalid-expected-length", false);
    }
    let final_dir = match confined::Dir::open_root(final_root) {
        Ok(dir) => dir,
        Err(err) if publication_is_unsupported(&err) => {
            return SavedChatZipPublishResult::refused("unsupported-platform", false)
        }
        Err(_) => return SavedChatZipPublishResult::refused("publish-root-unavailable", false),
    };
    if let Err(status) = name_fits(&final_dir, &options.final_name) {
        return SavedChatZipPublishResult::refused(status, false);
    }
    let staged_name = stage_name(&options.final_name, &options.token);
    let staged_bytes = staged_name.as_bytes();

    let staging_dir = match stage_placement() {
        StagePlacement::SiblingNamed => match confined::Dir::open_root(staging_root) {
            Ok(dir) => Some(dir),
            Err(_) => return SavedChatZipPublishResult::refused("stage-create-failed", false),
        },
        StagePlacement::AnonymousInFinal => None,
    };
    if let Err(status) = require_publication_capabilities(&final_dir, staging_dir.as_ref()) {
        return SavedChatZipPublishResult::refused(status, false);
    }

    let mut stage = match stage_placement() {
        StagePlacement::SiblingNamed => {
            let staging_dir = staging_dir.expect("sibling placement opened its root");
            if let Err(status) = name_fits(&staging_dir, &staged_name) {
                return SavedChatZipPublishResult::refused(status, false);
            }
            let handle = match staging_dir.create_new_child(staged_bytes) {
                Ok(file) => file,
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                    return SavedChatZipPublishResult::refused("stage-exists", false);
                }
                Err(_) => return SavedChatZipPublishResult::refused("stage-create-failed", false),
            };
            let owned = match owned_identity(&handle) {
                Ok(Some(owned)) => owned,
                _ => {
                    drop(handle);
                    let _ = staging_dir.unlink_child(staged_bytes);
                    return SavedChatZipPublishResult::refused("staged-not-regular", false);
                }
            };
            Stage {
                handle,
                named: Some((staging_dir, staged_bytes.to_vec())),
                owned,
            }
        }
        StagePlacement::AnonymousInFinal => {
            let handle = match final_dir.create_anonymous_child() {
                Ok(file) => file,
                Err(err) if publication_is_unsupported(&err) => {
                    return SavedChatZipPublishResult::refused("unsupported-platform", false)
                }
                Err(_) => return SavedChatZipPublishResult::refused("stage-create-failed", false),
            };
            let owned = match owned_identity(&handle) {
                Ok(Some(owned)) => owned,
                _ => return SavedChatZipPublishResult::refused("staged-not-regular", false),
            };
            Stage {
                handle,
                named: None,
                owned,
            }
        }
    };

    let full_fsync = match stage
        .handle
        .write_all(bytes)
        .and_then(|_| crate::archive_durable_write::sync_file_contents(&stage.handle))
    {
        Ok(full_fsync) => full_fsync,
        Err(_) => {
            let removed = release_and_cleanup(stage);
            return SavedChatZipPublishResult::refused("stage-write-failed", removed);
        }
    };
    let (staged_length, staged_sha256) = match hash_owned_file(&mut stage.handle) {
        Ok(identity) => identity,
        Err(_) => {
            let removed = release_and_cleanup(stage);
            return SavedChatZipPublishResult::refused("stage-readback-failed", removed);
        }
    };
    let received_sha256 = format!(
        "{SHA256_PREFIX}{}",
        crate::archive_durable_write::sha256_hex(bytes)
    );
    if staged_length != bytes.len() as u64 || staged_sha256 != received_sha256 {
        let removed = release_and_cleanup(stage);
        return SavedChatZipPublishResult::refused("staged-bytes-mismatch", removed);
    }
    if staged_length != options.expected_byte_length {
        let removed = release_and_cleanup(stage);
        return SavedChatZipPublishResult::refused("staged-length-mismatch", removed);
    }
    if staged_sha256 != options.expected_sha256 {
        let removed = release_and_cleanup(stage);
        return SavedChatZipPublishResult::refused("staged-hash-mismatch", removed);
    }
    if let Some((staging_dir, name)) = stage.named.as_ref() {
        // This check remains useful for refusing an already-displaced stage,
        // but it is deliberately NOT publication authority: the following
        // syscall selects `handle` itself, so a path replaced after this
        // point cannot redirect what is published.
        if !matches!(
            path_still_names_owned_file(staging_dir, name, stage.owned),
            Ok(true)
        ) {
            let removed = release_and_cleanup(stage);
            return SavedChatZipPublishResult::refused("staging-identity-mismatch", removed);
        }
        if after_path_check_before_publish(staging_dir, name).is_err() {
            let removed = release_and_cleanup(stage);
            return SavedChatZipPublishResult::refused("pre-publication-failed", removed);
        }
    }

    // Commit point (class H): the platform inserts the exact object selected
    // by the retained handle under an absent final name. The staging path is
    // not an input and cannot redirect the namespace mutation.
    match publish(&final_dir, &stage.handle, options.final_name.as_bytes()) {
        Ok(false) => {
            let removed = release_and_cleanup(stage);
            SavedChatZipPublishResult::refused("destination-exists", removed)
        }
        Err(error) => {
            let status = if publication_is_unsupported(&error) {
                "unsupported-platform"
            } else if publication_is_filesystem_refusal(&error) {
                "unsupported-filesystem-capability"
            } else {
                "publish-failed"
            };
            let removed = release_and_cleanup(stage);
            SavedChatZipPublishResult::refused(status, removed)
        }
        Ok(true) => {
            // Class H′ on the handle-renamed arm: the object under the final
            // name must be the retained object. The staging handle is released
            // first (Windows staging handles share nothing). macOS publishes a
            // clone (a new object by construction) and Linux links the
            // anonymous inode by descriptor, so identity is theirs by
            // construction and only the namespace fence remains.
            let owned = stage.owned;
            let named = stage.named.take();
            drop(stage.handle);
            if cfg!(windows) {
                let verified = match final_dir.stat_child_nofollow(options.final_name.as_bytes()) {
                    Ok(Some(st)) => st.is_regular() && st.identity() == owned,
                    _ => false,
                };
                if !verified {
                    let removed = match named.as_ref() {
                        Some((dir, name)) => cleanup_owned_stage(dir, name, owned),
                        None => true,
                    };
                    return SavedChatZipPublishResult::refused(
                        "publication-identity-mismatch",
                        removed,
                    );
                }
            }
            // Publication is already committed. A parent fence failure is
            // reported separately and never rewritten as "nothing happened".
            let durability_complete = sync_final_parent(&final_dir).is_ok();
            let removed = match named.as_ref() {
                Some((dir, name)) => cleanup_owned_stage(dir, name, owned),
                None => true,
            };
            SavedChatZipPublishResult::published(
                removed,
                staged_length,
                staged_sha256,
                full_fsync,
                durability_complete,
            )
        }
    }
}

/// Releases the retained handle, then cleans the staging name identity-checked.
fn release_and_cleanup(stage: Stage) -> bool {
    let Stage {
        handle,
        named,
        owned,
    } = stage;
    drop(handle);
    match named {
        Some((dir, name)) => cleanup_owned_stage(&dir, &name, owned),
        None => true,
    }
}

/// This platform's create-only publication of the retained staging object:
/// `fclonefileat` on macOS; descriptor-bound `linkat` on Linux; handle-bound
/// no-replace rename on Windows. Never a pathname-based fallback.
fn platform_publish(dir: &confined::Dir, source: &File, to: &[u8]) -> io::Result<bool> {
    if cfg!(target_os = "macos") {
        dir.publish_open_file_clone_exclusive(source, to)
    } else {
        dir.publish_file_by_handle(source, to)
    }
}

pub fn publish_saved_chat_zip_bytes_within_roots(
    final_root: &Path,
    staging_root: &Path,
    options: &SavedChatZipPublishOptions,
    bytes: &[u8],
) -> SavedChatZipPublishResult {
    publish_bytes_within_roots_with(
        final_root,
        staging_root,
        options,
        bytes,
        |_dir, _staged| Ok(()),
        platform_publish,
        |dir| dir.sync(),
    )
}

/// Purpose-bounded raw-body command. The body is the exact ZIP byte sequence;
/// governed leaf/token/hash/length metadata travels in the established encoded
/// `options` header. No arbitrary filesystem path or staged pathname is
/// accepted.
#[tauri::command]
pub async fn h2o_publish_saved_chat_zip_bytes_create_only(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<SavedChatZipPublishResult, String> {
    let options: SavedChatZipPublishOptions =
        match crate::archive_durable_write::required_options(&request) {
            Ok(options) => options,
            Err(_) => return Ok(SavedChatZipPublishResult::refused("invalid-request", false)),
        };
    let bytes = match crate::archive_durable_write::body_bytes(&request) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(SavedChatZipPublishResult::refused("invalid-body", false)),
    };
    let roots = match crate::saved_chat_export_root_policy::production_roots(&app) {
        Ok(roots) => roots,
        Err(status) => return Ok(SavedChatZipPublishResult::refused(status, false)),
    };
    Ok(publish_saved_chat_zip_bytes_within_roots(
        &roots.final_root,
        &roots.zip_staging_root,
        &options,
        &bytes,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    const FINAL_NAME: &str = "round-trip.h2ochat.zip";
    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn scratch_roots(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let parent = std::env::temp_dir().join(format!(
            "h2o-saved-chat-zip-publish-{name}-{}-{counter}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&parent);
        fs::create_dir_all(&parent).expect("scratch parent");
        let final_root = parent.join("exports");
        let staging_root = parent.join("native-only-staging");
        (parent, final_root, staging_root)
    }

    fn options_for(bytes: &[u8]) -> SavedChatZipPublishOptions {
        SavedChatZipPublishOptions {
            final_name: FINAL_NAME.to_string(),
            token: TOKEN.to_string(),
            expected_sha256: format!("sha256-{}", crate::archive_durable_write::sha256_hex(bytes)),
            expected_byte_length: bytes.len() as u64,
        }
    }

    fn staged_path(root: &Path, options: &SavedChatZipPublishOptions) -> PathBuf {
        root.join(stage_name(&options.final_name, &options.token))
    }

    #[test]
    fn normal_transaction_publishes_exact_verified_bytes_and_consumes_stage() {
        let (parent, final_root, staging_root) = scratch_roots("normal");
        let bytes = b"verified-portable-zip-bytes";
        let options = options_for(bytes);
        let result =
            publish_saved_chat_zip_bytes_within_roots(&final_root, &staging_root, &options, bytes);
        assert_eq!(result.status, "published");
        assert!(result.ok);
        assert!(result.committed);
        assert!(result.durability_complete);
        assert!(result.staging_removed);
        assert_eq!(result.byte_length, bytes.len() as u64);
        assert_eq!(result.sha256, options.expected_sha256);
        assert_eq!(fs::read(final_root.join(FINAL_NAME)).unwrap(), bytes);
        assert!(!staged_path(&staging_root, &options).exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn staging_collision_preserves_foreign_bytes_and_creates_no_final() {
        let (parent, final_root, staging_root) = scratch_roots("stage-collision");
        let bytes = b"our-zip-bytes";
        let options = options_for(bytes);
        fs::create_dir_all(&staging_root).unwrap();
        let staged = staged_path(&staging_root, &options);
        fs::write(&staged, b"foreign-stage-bytes").unwrap();
        let result =
            publish_saved_chat_zip_bytes_within_roots(&final_root, &staging_root, &options, bytes);
        assert_eq!(result.status, "stage-exists");
        assert!(!result.ok);
        assert!(!result.staging_removed);
        assert_eq!(fs::read(staged).unwrap(), b"foreign-stage-bytes");
        assert!(!final_root.join(FINAL_NAME).exists());
        let _ = fs::remove_dir_all(parent);
    }

    /// T02 (contract §12): ZIP leaves refuse a leading `.` and every Windows
    /// reserved device stem on every platform; the result schema is unchanged.
    #[test]
    fn zip_leaves_refuse_leading_dots_and_reserved_device_stems() {
        for refused in [
            ".hidden.h2ochat.zip",
            "CON.h2ochat.zip",
            "nul.h2ochat.zip",
            "LPT1.h2ochat.zip",
        ] {
            assert!(
                !final_name_is_governed(refused),
                "{refused} must be refused"
            );
        }
        for admitted in [
            "console.h2ochat.zip",
            "com10.h2ochat.zip",
            "a.CON.h2ochat.zip",
        ] {
            assert!(
                final_name_is_governed(admitted),
                "{admitted} must be admitted"
            );
        }
        let refused =
            serde_json::to_value(SavedChatZipPublishResult::refused("invalid-name", false))
                .unwrap();
        let mut keys: Vec<_> = refused.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "byteLength",
                "committed",
                "durabilityComplete",
                "fullFsync",
                "ok",
                "schema",
                "sha256",
                "stagingRemoved",
                "status",
            ]
        );
    }

    #[test]
    fn directory_and_symlink_stage_collisions_are_never_followed_or_removed() {
        use std::os::unix::fs::symlink;

        let (parent, final_root, staging_root) = scratch_roots("wrong-type-collision");
        let bytes = b"our-zip-bytes";
        let options = options_for(bytes);
        let staged = staged_path(&staging_root, &options);

        fs::create_dir_all(&staged).unwrap();
        fs::write(staged.join("foreign.txt"), b"foreign-directory-bytes").unwrap();
        let directory_result =
            publish_saved_chat_zip_bytes_within_roots(&final_root, &staging_root, &options, bytes);
        assert_eq!(directory_result.status, "stage-exists");
        assert!(!directory_result.staging_removed);
        assert_eq!(
            fs::read(staged.join("foreign.txt")).unwrap(),
            b"foreign-directory-bytes"
        );

        fs::remove_dir_all(&staged).unwrap();
        let foreign = parent.join("foreign-target");
        fs::write(&foreign, b"foreign-symlink-target").unwrap();
        symlink(&foreign, &staged).unwrap();
        let symlink_result =
            publish_saved_chat_zip_bytes_within_roots(&final_root, &staging_root, &options, bytes);
        assert_eq!(symlink_result.status, "stage-exists");
        assert!(!symlink_result.staging_removed);
        assert!(fs::symlink_metadata(&staged)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(foreign).unwrap(), b"foreign-symlink-target");
        assert!(!final_root.join(FINAL_NAME).exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn two_creators_with_the_same_token_cannot_both_own_the_stage() {
        let (parent, _final_root, staging_root) = scratch_roots("two-creators");
        let options = options_for(b"bytes");
        let dir = crate::archive_durable_write::confined::Dir::open_root(&staging_root).unwrap();
        let staged = stage_name(&options.final_name, &options.token);
        let first = dir
            .create_new_child(staged.as_bytes())
            .expect("first owns stage");
        let second = dir.create_new_child(staged.as_bytes()).unwrap_err();
        assert_eq!(second.kind(), io::ErrorKind::AlreadyExists);
        drop(first);
        assert!(staged_path(&staging_root, &options).exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn expected_hash_mismatch_refuses_and_cleans_only_owned_stage() {
        let (parent, final_root, staging_root) = scratch_roots("hash-mismatch");
        let bytes = b"verified-zip-bytes";
        let mut options = options_for(bytes);
        options.expected_sha256 = format!("sha256-{}", "0".repeat(64));
        let result =
            publish_saved_chat_zip_bytes_within_roots(&final_root, &staging_root, &options, bytes);
        assert_eq!(result.status, "staged-hash-mismatch");
        assert!(result.staging_removed);
        assert!(!result.committed);
        assert!(!final_root.join(FINAL_NAME).exists());
        assert!(!staged_path(&staging_root, &options).exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn expected_length_mismatch_refuses_and_cleans_only_owned_stage() {
        let (parent, final_root, staging_root) = scratch_roots("length-mismatch");
        let bytes = b"verified-zip-bytes";
        let mut options = options_for(bytes);
        options.expected_byte_length += 1;
        let result =
            publish_saved_chat_zip_bytes_within_roots(&final_root, &staging_root, &options, bytes);
        assert_eq!(result.status, "staged-length-mismatch");
        assert!(result.staging_removed);
        assert!(!result.committed);
        assert!(!final_root.join(FINAL_NAME).exists());
        assert!(!staged_path(&staging_root, &options).exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn final_destination_collision_preserves_winner_and_cleans_owned_stage() {
        let (parent, final_root, staging_root) = scratch_roots("final-collision");
        let bytes = b"our-verified-zip";
        let options = options_for(bytes);
        fs::create_dir_all(&final_root).unwrap();
        fs::write(final_root.join(FINAL_NAME), b"independent-winner").unwrap();
        let result =
            publish_saved_chat_zip_bytes_within_roots(&final_root, &staging_root, &options, bytes);
        assert_eq!(result.status, "destination-exists");
        assert!(!result.ok);
        assert!(result.staging_removed);
        assert_eq!(
            fs::read(final_root.join(FINAL_NAME)).unwrap(),
            b"independent-winner"
        );
        assert!(!staged_path(&staging_root, &options).exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn post_check_regular_path_substitution_cannot_redirect_fd_bound_publication() {
        let (parent, final_root, staging_root) = scratch_roots("substituted-file");
        let bytes = b"verified-owned-bytes";
        let options = options_for(bytes);
        let staged = staged_path(&staging_root, &options);
        let result = publish_bytes_within_roots_with(
            &final_root,
            &staging_root,
            &options,
            bytes,
            |_dir, staged_name| {
                fs::remove_file(&staged)?;
                fs::write(
                    staging_root.join(std::str::from_utf8(staged_name).unwrap()),
                    b"substitute",
                )
            },
            |dir, source, to| dir.publish_open_file_clone_exclusive(source, to),
            |dir| dir.sync(),
        );
        assert_eq!(result.status, "published");
        assert!(result.ok);
        assert!(result.committed);
        assert!(!result.staging_removed);
        assert_eq!(fs::read(staged).unwrap(), b"substitute");
        assert_eq!(fs::read(final_root.join(FINAL_NAME)).unwrap(), bytes);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn post_check_symlink_substitution_is_not_followed_or_published() {
        use std::os::unix::fs::symlink;

        let (parent, final_root, staging_root) = scratch_roots("substituted-symlink");
        let bytes = b"verified-owned-bytes";
        let options = options_for(bytes);
        let staged = staged_path(&staging_root, &options);
        let foreign = parent.join("foreign-bytes");
        fs::write(&foreign, b"foreign-target").unwrap();
        let result = publish_bytes_within_roots_with(
            &final_root,
            &staging_root,
            &options,
            bytes,
            |_dir, _staged_name| {
                fs::remove_file(&staged)?;
                symlink(&foreign, &staged)
            },
            |dir, source, to| dir.publish_open_file_clone_exclusive(source, to),
            |dir| dir.sync(),
        );
        assert_eq!(result.status, "published");
        assert!(result.ok);
        assert!(result.committed);
        assert!(!result.staging_removed);
        assert!(fs::symlink_metadata(&staged)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(foreign).unwrap(), b"foreign-target");
        assert_eq!(fs::read(final_root.join(FINAL_NAME)).unwrap(), bytes);
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn path_token_and_identity_confinement_rejects_unsafe_inputs() {
        let (parent, final_root, staging_root) = scratch_roots("confinement");
        let bytes = b"bytes";
        let valid = options_for(bytes);
        let invalid = [
            SavedChatZipPublishOptions {
                final_name: "../x.h2ochat.zip".into(),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                final_name: "a/b.h2ochat.zip".into(),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                final_name: "a\\b.h2ochat.zip".into(),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                final_name: "/absolute.h2ochat.zip".into(),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                final_name: "C:drive.h2ochat.zip".into(),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                final_name: "wrong.zip".into(),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                token: String::new(),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                token: "a".repeat(31),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                token: "A".repeat(32),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                token: "g".repeat(32),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                expected_sha256: "sha256-bad".into(),
                ..valid.clone()
            },
            SavedChatZipPublishOptions {
                expected_byte_length: 0,
                ..valid.clone()
            },
        ];
        for options in invalid {
            let result = publish_saved_chat_zip_bytes_within_roots(
                &final_root,
                &staging_root,
                &options,
                bytes,
            );
            assert!(!result.ok, "unsafe input was admitted: {options:?}");
        }
        assert!(fs::read_dir(&parent).unwrap().next().is_none());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn non_collision_publication_error_fails_closed_without_fallback() {
        let (parent, final_root, staging_root) = scratch_roots("fail-closed");
        let bytes = b"verified-staged-bytes";
        let options = options_for(bytes);
        let mut calls = 0;
        let result = publish_bytes_within_roots_with(
            &final_root,
            &staging_root,
            &options,
            bytes,
            |_dir, _staged| Ok(()),
            |_dir, _source, _to| {
                calls += 1;
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            },
            |_dir| panic!("parent sync must not follow failed publication"),
        );
        assert_eq!(calls, 1);
        assert_eq!(result.status, "publish-failed");
        assert!(!result.ok);
        assert!(result.staging_removed);
        assert!(!result.committed);
        assert!(!final_root.join(FINAL_NAME).exists());
        assert!(!staged_path(&staging_root, &options).exists());
        let _ = fs::remove_dir_all(parent);
    }

    #[test]
    fn post_commit_parent_fence_failure_is_reported_without_retracting_publication() {
        let (parent, final_root, staging_root) = scratch_roots("parent-fence-failure");
        let bytes = b"verified-and-committed";
        let options = options_for(bytes);
        let result = publish_bytes_within_roots_with(
            &final_root,
            &staging_root,
            &options,
            bytes,
            |_dir, _staged| Ok(()),
            |dir, source, to| dir.publish_open_file_clone_exclusive(source, to),
            |_dir| Err(io::Error::from(io::ErrorKind::PermissionDenied)),
        );
        assert_eq!(result.status, "published");
        assert!(result.ok);
        assert!(result.committed);
        assert!(!result.durability_complete);
        assert_eq!(fs::read(final_root.join(FINAL_NAME)).unwrap(), bytes);
        assert!(!staged_path(&staging_root, &options).exists());
        let _ = fs::remove_dir_all(parent);
    }
}
