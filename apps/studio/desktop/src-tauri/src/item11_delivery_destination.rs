use crate::sync_object_document::{
    canonical_head, canonical_value, object_key_hex, valid_identity, valid_writer_identity,
    PeerWriterRole, SyncHead, SyncRevision, HEAD_SCHEMA, REVISION_SCHEMA,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_sql::{DbInstances, DbPool};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

/* Destination identity is bound to the volume, not to the mount session.
 * `st_dev` is a mount-time ordinal: macOS renumbers APFS volumes across boots,
 * so a v1 binding written before a reboot reads as "moved or replaced" while
 * the folder sits untouched at the same path with the same inode. v2 binds the
 * durable volume UUID instead and never consults the ordinal. v1 is still read,
 * but only to say that it is one — see `classify_legacy_authorization`. */
const AUTHORIZATION_SCHEMA: &str = "h2o.round2.item11.delivery-authorization.v2";
const AUTHORIZATION_SCHEMA_LEGACY: &str = "h2o.round2.item11.delivery-authorization.v1";
const AUTHORIZATION_DIRECTORY: &str = "item11-delivery";
const AUTHORIZATION_FILE: &str = "authorization.v2.json";
const AUTHORIZATION_TEMP_FILE: &str = ".authorization.v2.json.tmp";
const AUTHORIZATION_FILE_LEGACY: &str = "authorization.v1.json";

/* Names the authority that produced the bytes, not the filesystem that stores
 * them: `getattrlist(ATTR_VOL_INFO | ATTR_VOL_UUID)` answers for APFS and
 * exFAT alike, and `diskutil` prints a separate "Disk / Partition UUID" beside
 * the volume one. A reader of this record must know exactly which was meant. */
const VOLUME_IDENTITY_KIND: &str = "macos-attr-vol-uuid";
const DELIVERY_SCHEMA: &str = "h2o.round2.item9.browser-delivery.v1";
const DELIVERY_SCHEMA_VERSION: u64 = 1;
const DEFAULT_FOLDER: &str = "H2O Studio Sync";
const DELIVERY_FILE: &str = "round2-item9-delivery.json";
const TEMPORARY_FILE: &str = ".round2-item9-delivery.json.tmp";
const MAX_PATH_BYTES: usize = 4096;
const MAX_DELIVERY_BYTES: usize = 8 * 1024 * 1024;
const MAX_OBJECT_ID_BYTES: usize = 512;
const DB_URL: &str = "sqlite:studio-v1.db";

pub const DELIVERY_FOLDER_NOT_CONFIGURED: &str = "round2-item11-delivery-folder-not-configured";
pub const DELIVERY_FOLDER_SELECTION_CANCELLED: &str =
    "round2-item11-delivery-folder-selection-cancelled";
pub const DELIVERY_FOLDER_CONFIG_MISMATCH: &str = "round2-item11-delivery-folder-config-mismatch";
pub const DELIVERY_FOLDER_INVALID: &str = "round2-item11-delivery-folder-invalid";
pub const DELIVERY_FOLDER_SYMLINK_REJECTED: &str = "round2-item11-delivery-folder-symlink-rejected";
pub const DELIVERY_FOLDER_MOVED_OR_REPLACED: &str =
    "round2-item11-delivery-folder-moved-or-replaced";
pub const DELIVERY_FOLDER_OWNER_MISMATCH: &str = "round2-item11-delivery-folder-owner-mismatch";
pub const DELIVERY_FOLDER_UNAVAILABLE: &str = "round2-item11-delivery-folder-unavailable";
pub const DELIVERY_FOLDER_PERMISSION_DENIED: &str =
    "round2-item11-delivery-folder-permission-denied";
pub const DELIVERY_TEMP_EXISTS: &str = "round2-item11-delivery-temp-exists";
pub const DELIVERY_TEMP_WRITE_FAILED: &str = "round2-item11-delivery-temp-write-failed";
pub const DELIVERY_TEMP_VERIFICATION_FAILED: &str =
    "round2-item11-delivery-temp-verification-failed";
pub const DELIVERY_ATOMIC_REPLACE_FAILED: &str = "round2-item11-delivery-atomic-replace-failed";
pub const DELIVERY_FINAL_VERIFICATION_FAILED: &str =
    "round2-item11-delivery-final-verification-failed";
pub const DELIVERY_ENVELOPE_INVALID: &str = "round2-item11-delivery-envelope-invalid";
pub const DELIVERY_AUTHORIZATION_WRITE_FAILED: &str =
    "round2-item11-delivery-authorization-write-failed";

/* Local-delivery lineage ledger. The single-slot delivery file cannot express
 * per-object lineage, so the parent revision authority is this protected
 * App Support ledger, scoped to one destination authorization binding. */
const LINEAGE_SCHEMA: &str = "h2o.round2.item11.delivery-lineage.v2";
/* The version lives in the filename, so a v1 ledger is never touched by the v2
 * path at all — neither read nor written. It stays on disk as evidence. */
const LINEAGE_FILE_PREFIX: &str = "lineage.v2.";
const LINEAGE_FILE_SUFFIX: &str = ".json";
const LINEAGE_TEMP_PREFIX: &str = ".lineage.v2.";
const LINEAGE_TEMP_SUFFIX: &str = ".json.tmp";
const MAX_LINEAGE_TIPS: usize = 4096;
const MAX_LINEAGE_BYTES: usize = 8 * 1024 * 1024;

pub const LINEAGE_MALFORMED: &str = "round2-item11-local-delivery-lineage-malformed";
pub const LINEAGE_OVERSIZE: &str = "round2-item11-local-delivery-lineage-oversize";
pub const LINEAGE_BINDING_MISMATCH: &str = "round2-item11-local-delivery-lineage-binding-mismatch";
pub const LINEAGE_UNSAFE_FILE_TYPE: &str = "round2-item11-local-delivery-lineage-unsafe-file-type";
pub const LINEAGE_UNSAFE_MODE: &str = "round2-item11-local-delivery-lineage-unsafe-mode";
pub const LINEAGE_TEMP_EXISTS: &str = "round2-item11-local-delivery-lineage-temp-exists";
pub const LINEAGE_WRITE_FAILED: &str = "round2-item11-local-delivery-lineage-write-failed";
pub const LINEAGE_FSYNC_FAILED: &str = "round2-item11-local-delivery-lineage-fsync-failed";
pub const LINEAGE_RENAME_FAILED: &str = "round2-item11-local-delivery-lineage-rename-failed";
pub const LINEAGE_UNRESOLVED: &str = "round2-item11-local-delivery-lineage-unresolved";
pub const LINEAGE_TIP_LIMIT_EXCEEDED: &str =
    "round2-item11-local-delivery-lineage-tip-limit-exceeded";
pub const LINEAGE_DESTINATION_PACKAGE_INVALID: &str =
    "round2-item11-local-delivery-destination-package-invalid";

/* True-local delivery preparation. Byte limits mirror the Chrome Item 9
 * admission contract (`sync-delivery-runtime.mjs`), which is the authority for
 * what the delivery package may carry; the transport module's own limits are
 * deliberately not imported, so this path stays free of WebDAV symbols. */
const MAX_LOCAL_HEAD_BYTES: usize = 64 * 1024;
const MAX_LOCAL_REVISION_BYTES: usize = 5 * 1024 * 1024;

pub const LOCAL_DELIVERY_REVISION_INVALID: &str = "round2-item11-local-delivery-revision-invalid";
pub const LOCAL_DELIVERY_OBJECT_KEY_MISMATCH: &str =
    "round2-item11-local-delivery-object-key-mismatch";
pub const LOCAL_DELIVERY_REVISION_HASH_MISMATCH: &str =
    "round2-item11-local-delivery-revision-hash-mismatch";
pub const LOCAL_DELIVERY_REVISION_NOT_CANONICAL: &str =
    "round2-item11-local-delivery-revision-not-canonical";
pub const LOCAL_DELIVERY_WRITER_IDENTITY_INVALID: &str =
    "round2-item11-local-delivery-writer-identity-invalid";
pub const LOCAL_DELIVERY_HEAD_INVALID: &str = "round2-item11-local-delivery-head-invalid";
pub const LOCAL_DELIVERY_ENVELOPE_INVALID: &str = "round2-item11-local-delivery-envelope-invalid";
pub const LOCAL_DELIVERY_SLOT_AHEAD: &str = "round2-item11-local-delivery-destination-ahead";
pub const LOCAL_DELIVERY_PREPARATION_FAILED: &str =
    "round2-item11-local-delivery-preparation-failed";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ConfiguredPathMode {
    Relative,
    Absolute,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AuthorizationBinding {
    schema: String,
    pub(crate) canonical_path: String,
    pub(crate) canonical_path_sha256_hex: String,
    pub(crate) destination_folder_leaf_name: String,
    configured_path_mode: ConfiguredPathMode,
    volume_identity_kind: String,
    volume_identity: String,
    inode: u64,
    owner_uid: u32,
}

/* Read-only view of a v1 record, used for one question only: is a recognizable
 * v1 authorization present? Every field is declared because `deny_unknown_fields`
 * makes the declaration the definition of the v1 shape — a real v1 record must
 * parse, and a foreign one must not. Nothing here is read as authority, and
 * nothing here is ever written. */
#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyAuthorizationBinding {
    schema: String,
    canonical_path: String,
    canonical_path_sha256_hex: String,
    destination_folder_leaf_name: String,
    configured_path_mode: ConfiguredPathMode,
    device_id: u64,
    inode: u64,
    owner_uid: u32,
}

/// What a caller already believes about the folder it is revalidating: the
/// durable volume the folder lives on, and its inode. There is deliberately no
/// ordinal-based form — with no v1 trust to evaluate, nothing in the product has
/// any reason to compare `st_dev` again.
#[derive(Clone, Copy, Debug)]
struct ExpectedFolderIdentity<'a> {
    volume_identity: &'a str,
    inode: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item11SelectDeliveryFolderResult {
    ok: bool,
    verdict: &'static str,
    configured_folder_path: String,
    destination_folder_leaf_name: String,
    destination_path_sha256_hex: String,
    destination_configured_path_mode: ConfiguredPathMode,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item11ValidateDeliveryAuthorizationRequest {
    expected_destination_path_sha256_hex: String,
    destination_configured_path_mode: ConfiguredPathMode,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item11ValidateDeliveryAuthorizationResult {
    ok: bool,
    verdict: &'static str,
    status: &'static str,
    destination_folder_leaf_name: String,
    destination_path_sha256_hex: String,
    destination_configured_path_mode: ConfiguredPathMode,
    read_only: bool,
    no_network: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item11PrepareDeliveryRequest {
    delivery_json: String,
    object_id: String,
    expected_destination_path_sha256_hex: String,
    destination_configured_path_mode: ConfiguredPathMode,
    configuration_absent: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item11PrepareDeliveryResult {
    ok: bool,
    verdict: &'static str,
    destination_folder_leaf_name: String,
    destination_path_sha256_hex: String,
    destination_configured_path_mode: ConfiguredPathMode,
    delivery_byte_length: usize,
    delivery_sha256_hex: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FaultStage {
    None,
    TempWrite,
    TempVerification,
    AtomicReplace,
    FinalVerification,
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

fn is_base64(value: &str) -> bool {
    if value.is_empty() || value.len() % 4 != 0 {
        return false;
    }
    let padding = value.bytes().rev().take_while(|byte| *byte == b'=').count();
    if padding > 2 {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| {
        let data = byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/';
        data || (byte == b'=' && index >= value.len() - padding)
    })
}

fn validate_delivery_envelope(text: &str, expected_object_id: &str) -> Result<(), &'static str> {
    if text.is_empty()
        || text.as_bytes().len() > MAX_DELIVERY_BYTES
        || expected_object_id.is_empty()
        || expected_object_id.as_bytes().len() > MAX_OBJECT_ID_BYTES
        || expected_object_id.trim() != expected_object_id
        || expected_object_id.chars().any(|value| value.is_control())
    {
        return Err(DELIVERY_ENVELOPE_INVALID);
    }
    let value: JsonValue = serde_json::from_str(text).map_err(|_| DELIVERY_ENVELOPE_INVALID)?;
    let object = value.as_object().ok_or(DELIVERY_ENVELOPE_INVALID)?;
    let expected_keys: BTreeSet<&str> = [
        "deliverySchemaVersion",
        "headBytesBase64",
        "headSha256Hex",
        "objectId",
        "producedAtIso",
        "revisionBlobSha256Hex",
        "revisionBytesBase64",
        "schema",
    ]
    .into_iter()
    .collect();
    let actual_keys: BTreeSet<&str> = object.keys().map(String::as_str).collect();
    if actual_keys != expected_keys
        || object.get("schema").and_then(JsonValue::as_str) != Some(DELIVERY_SCHEMA)
        || object
            .get("deliverySchemaVersion")
            .and_then(JsonValue::as_u64)
            != Some(DELIVERY_SCHEMA_VERSION)
        || object.get("objectId").and_then(JsonValue::as_str) != Some(expected_object_id)
    {
        return Err(DELIVERY_ENVELOPE_INVALID);
    }
    for key in ["headSha256Hex", "revisionBlobSha256Hex"] {
        if !object
            .get(key)
            .and_then(JsonValue::as_str)
            .map(is_sha256)
            .unwrap_or(false)
        {
            return Err(DELIVERY_ENVELOPE_INVALID);
        }
    }
    for key in ["headBytesBase64", "revisionBytesBase64"] {
        if !object
            .get(key)
            .and_then(JsonValue::as_str)
            .map(is_base64)
            .unwrap_or(false)
        {
            return Err(DELIVERY_ENVELOPE_INVALID);
        }
    }
    let produced_at = object
        .get("producedAtIso")
        .and_then(JsonValue::as_str)
        .ok_or(DELIVERY_ENVELOPE_INVALID)?;
    if produced_at.len() < 20 || produced_at.len() > 40 || !produced_at.ends_with('Z') {
        return Err(DELIVERY_ENVELOPE_INVALID);
    }
    Ok(())
}

fn path_text(path: &Path) -> Result<&str, &'static str> {
    let text = path.to_str().ok_or(DELIVERY_FOLDER_INVALID)?;
    if text.is_empty()
        || text.as_bytes().len() > MAX_PATH_BYTES
        || text.as_bytes().contains(&0)
        || !path.is_absolute()
        || path.file_name().is_none()
    {
        return Err(DELIVERY_FOLDER_INVALID);
    }
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(DELIVERY_FOLDER_INVALID);
    }
    Ok(text)
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and does not mutate process state.
    unsafe { libc::geteuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

#[cfg(unix)]
fn metadata_identity(metadata: &fs::Metadata) -> (u64, u64, u32) {
    (metadata.dev(), metadata.ino(), metadata.uid())
}

#[cfg(not(unix))]
fn metadata_identity(_metadata: &fs::Metadata) -> (u64, u64, u32) {
    (0, 0, 0)
}

fn format_uuid(bytes: &[u8; 16]) -> String {
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Canonical lowercase hyphenated form, nil UUID excluded. Persisted identity
/// is compared as text, so anything that is not exactly this shape is refused
/// rather than normalized — a record that cannot be compared cannot be trusted.
fn is_volume_identity(value: &str) -> bool {
    if value.len() != 36 || value == "00000000-0000-0000-0000-000000000000" {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            byte == b'-'
        } else {
            byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
        }
    })
}

/// Durable volume identity for the canonical directory.
///
/// `getattrlist` is the narrowest authority that answers this: no privilege, no
/// network, no DiskArbitration, no `diskutil` subprocess, and it is already
/// reachable through the `libc` dependency this crate carries. It is also not
/// universal — `devfs` refuses it outright — so every failure mode below is a
/// refusal. There is deliberately no `st_dev` fallback: falling back would
/// reintroduce exactly the ordinal this change exists to remove.
#[cfg(target_os = "macos")]
fn volume_identity(path: &Path) -> Result<String, &'static str> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    /* Exactly what ATTR_VOL_UUID returns: the u32 length the kernel always
     * writes first, followed by the 16 UUID bytes. 4 + 16 needs no padding at
     * alignment 4, so `size_of` is the 20 bytes the call reports back. */
    #[repr(C)]
    struct VolumeUuidBuffer {
        length: u32,
        uuid: [u8; 16],
    }

    let text = CString::new(path.as_os_str().as_bytes()).map_err(|_| DELIVERY_FOLDER_INVALID)?;
    let mut request = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: 0,
        volattr: libc::ATTR_VOL_INFO | libc::ATTR_VOL_UUID,
        dirattr: 0,
        fileattr: 0,
        forkattr: 0,
    };
    let mut buffer = VolumeUuidBuffer {
        length: 0,
        uuid: [0u8; 16],
    };
    /* SAFETY: `text` is a NUL-terminated path that outlives the call, `request`
     * is a fully initialised `attrlist`, and the size passed is the size of the
     * buffer actually handed over, so the kernel cannot write past it. */
    let status = unsafe {
        libc::getattrlist(
            text.as_ptr(),
            std::ptr::from_mut(&mut request).cast::<libc::c_void>(),
            std::ptr::from_mut(&mut buffer).cast::<libc::c_void>(),
            std::mem::size_of::<VolumeUuidBuffer>(),
            libc::FSOPT_NOFOLLOW,
        )
    };
    if status != 0 {
        return Err(DELIVERY_FOLDER_INVALID);
    }
    /* The kernel reports the length it wanted to write, which is short when the
     * filesystem does not carry the attribute at all and would be long if the
     * requested set ever changed. Demanding the exact size rejects both. */
    if buffer.length as usize != std::mem::size_of::<VolumeUuidBuffer>() {
        return Err(DELIVERY_FOLDER_INVALID);
    }
    if buffer.uuid.iter().all(|byte| *byte == 0) {
        return Err(DELIVERY_FOLDER_INVALID);
    }
    let identity = format_uuid(&buffer.uuid);
    if !is_volume_identity(&identity) {
        return Err(DELIVERY_FOLDER_INVALID);
    }
    Ok(identity)
}

/* No other platform has an equivalent this contract can lean on, so authorizing
 * a destination there fails closed rather than binding to something weaker. */
#[cfg(not(target_os = "macos"))]
fn volume_identity(_path: &Path) -> Result<String, &'static str> {
    Err(DELIVERY_FOLDER_INVALID)
}

fn validate_directory(
    path: &Path,
    expected_identity: Option<ExpectedFolderIdentity<'_>>,
    expected_uid: u32,
) -> Result<(PathBuf, fs::Metadata), &'static str> {
    path_text(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => DELIVERY_FOLDER_UNAVAILABLE,
        ErrorKind::PermissionDenied => DELIVERY_FOLDER_PERMISSION_DENIED,
        _ => DELIVERY_FOLDER_UNAVAILABLE,
    })?;
    if metadata.file_type().is_symlink() {
        return Err(DELIVERY_FOLDER_SYMLINK_REJECTED);
    }
    if !metadata.is_dir() {
        return Err(DELIVERY_FOLDER_INVALID);
    }
    let canonical = fs::canonicalize(path).map_err(|error| match error.kind() {
        ErrorKind::PermissionDenied => DELIVERY_FOLDER_PERMISSION_DENIED,
        _ => DELIVERY_FOLDER_UNAVAILABLE,
    })?;
    path_text(&canonical)?;
    let canonical_metadata =
        fs::symlink_metadata(&canonical).map_err(|_| DELIVERY_FOLDER_UNAVAILABLE)?;
    if canonical_metadata.file_type().is_symlink() || !canonical_metadata.is_dir() {
        return Err(DELIVERY_FOLDER_SYMLINK_REJECTED);
    }
    let (_, inode, owner_uid) = metadata_identity(&canonical_metadata);
    #[cfg(unix)]
    {
        if owner_uid != expected_uid {
            return Err(DELIVERY_FOLDER_OWNER_MISMATCH);
        }
        let mode = canonical_metadata.permissions().mode();
        if mode & 0o300 != 0o300 {
            return Err(DELIVERY_FOLDER_PERMISSION_DENIED);
        }
    }
    /* Short-circuits deliberately: a path or inode that already disagrees is a
     * replaced folder, and answering that costs no syscall. The native read is
     * reached only when everything cheaper already matches, and its failure
     * propagates as `DELIVERY_FOLDER_INVALID` rather than being folded into the
     * replacement verdict — an unreadable volume identity is not evidence of a
     * replacement, it is the absence of evidence either way. */
    let identity_matches = match expected_identity {
        None => true,
        Some(ExpectedFolderIdentity {
            volume_identity: expected_volume,
            inode: expected_inode,
        }) => {
            canonical == path
                && inode == expected_inode
                && volume_identity(&canonical)? == expected_volume
        }
    };
    if !identity_matches {
        return Err(DELIVERY_FOLDER_MOVED_OR_REPLACED);
    }
    Ok((canonical, canonical_metadata))
}

/// Shape checks that do not touch the filesystem. Kept separate so a binding
/// arriving from disk and one held in memory are held to the same contract.
fn validate_binding_shape(binding: &AuthorizationBinding) -> Result<(), &'static str> {
    if binding.schema != AUTHORIZATION_SCHEMA
        || !is_sha256(&binding.canonical_path_sha256_hex)
        || binding.destination_folder_leaf_name.is_empty()
        || binding.volume_identity_kind != VOLUME_IDENTITY_KIND
        || !is_volume_identity(&binding.volume_identity)
    {
        return Err(DELIVERY_FOLDER_INVALID);
    }
    Ok(())
}

pub(crate) fn binding_from_directory(
    directory: &Path,
    configured_path_mode: ConfiguredPathMode,
) -> Result<AuthorizationBinding, &'static str> {
    let (canonical, metadata) = validate_directory(directory, None, current_uid())?;
    let canonical_text = path_text(&canonical)?.to_string();
    let leaf = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && !value.chars().any(|character| character.is_control()))
        .ok_or(DELIVERY_FOLDER_INVALID)?
        .to_string();
    let (_, inode, owner_uid) = metadata_identity(&metadata);
    let volume_identity = volume_identity(&canonical)?;
    Ok(AuthorizationBinding {
        schema: AUTHORIZATION_SCHEMA.to_string(),
        canonical_path_sha256_hex: sha256_hex(canonical_text.as_bytes()),
        canonical_path: canonical_text,
        destination_folder_leaf_name: leaf,
        configured_path_mode,
        volume_identity_kind: VOLUME_IDENTITY_KIND.to_string(),
        volume_identity,
        inode,
        owner_uid,
    })
}

fn authorization_paths(root: &Path) -> (PathBuf, PathBuf) {
    (
        root.join(AUTHORIZATION_FILE),
        root.join(AUTHORIZATION_TEMP_FILE),
    )
}

fn legacy_authorization_path(root: &Path) -> PathBuf {
    root.join(AUTHORIZATION_FILE_LEGACY)
}

fn sync_directory(path: &Path) -> Result<(), &'static str> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| DELIVERY_AUTHORIZATION_WRITE_FAILED)
}

pub(crate) fn persist_binding(root: &Path, binding: &AuthorizationBinding) -> Result<(), &'static str> {
    fs::create_dir_all(root).map_err(|_| DELIVERY_AUTHORIZATION_WRITE_FAILED)?;
    let (canonical_root, _) = validate_directory(root, None, current_uid())
        .map_err(|_| DELIVERY_AUTHORIZATION_WRITE_FAILED)?;
    let (final_path, temporary_path) = authorization_paths(&canonical_root);
    if temporary_path.exists() {
        fs::remove_file(&temporary_path).map_err(|_| DELIVERY_AUTHORIZATION_WRITE_FAILED)?;
    }
    let bytes = serde_json::to_vec(binding).map_err(|_| DELIVERY_AUTHORIZATION_WRITE_FAILED)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&temporary_path)
        .map_err(|_| DELIVERY_AUTHORIZATION_WRITE_FAILED)?;
    if file.write_all(&bytes).is_err() || file.sync_all().is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(DELIVERY_AUTHORIZATION_WRITE_FAILED);
    }
    if fs::rename(&temporary_path, &final_path).is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(DELIVERY_AUTHORIZATION_WRITE_FAILED);
    }
    sync_directory(&canonical_root)
}

/// Reads one authorization file. Absence is `None`; anything present but not a
/// plain non-symlink file is refused rather than followed.
fn read_authorization_file(path: &Path) -> Result<Option<Vec<u8>>, &'static str> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(DELIVERY_FOLDER_UNAVAILABLE),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(DELIVERY_FOLDER_INVALID);
    }
    fs::read(path)
        .map(Some)
        .map_err(|_| DELIVERY_FOLDER_UNAVAILABLE)
}

/// Loading priority: a present v2 record is the only authority, and a corrupt
/// one is refused outright — silently reaching past it to an older, weaker
/// record would let a damaged current authority be downgraded rather than seen.
/// When no v2 record exists, v1 is examined only to say what it is; it is never
/// converted into one.
pub(crate) fn load_binding(root: &Path) -> Result<AuthorizationBinding, &'static str> {
    /* No authorization directory at all is the truthful "neither generation
     * exists" answer, and it has to be distinguishable from a directory that
     * exists but cannot be read — `resolve_request_binding` may only fall back
     * to a default destination on the former. */
    if matches!(fs::symlink_metadata(root), Err(ref error) if error.kind() == ErrorKind::NotFound) {
        return Err(DELIVERY_FOLDER_NOT_CONFIGURED);
    }
    let (canonical_root, _) =
        validate_directory(root, None, current_uid()).map_err(|_| DELIVERY_FOLDER_UNAVAILABLE)?;
    let (path, _) = authorization_paths(&canonical_root);
    let Some(bytes) = read_authorization_file(&path)? else {
        return Err(classify_legacy_authorization(&canonical_root));
    };
    let binding: AuthorizationBinding =
        serde_json::from_slice(&bytes).map_err(|_| DELIVERY_FOLDER_INVALID)?;
    validate_binding_shape(&binding)?;
    Ok(binding)
}

/// Says what a v1 record is. It never returns a binding, and nothing it reads
/// ever reaches a v2 file.
///
/// Trust is not transferable between these two generations. Nothing enforces one
/// writer per Application Support identity — there is no single-instance
/// authority, every installed bundle shares `org.h2o.studio.desktop`, and no
/// cross-process lock exists that a v1-era build would obey — so a v1-capable
/// build can be advancing `lineage.v1.*` in another process at any instant.
/// Deriving v2 authority from v1 state would mean reading that state and
/// activating on it a moment later, and a legitimate v1 writer landing in
/// between would have its revision silently dropped at the instant the new
/// authority took effect. A lock introduced here would be one the old build
/// never acquires, so that window cannot be closed from this side. It is
/// therefore never opened: the owner re-picks the folder once, and v2 is minted
/// from live measurements alone.
///
/// A recognizable v1 record reports as an invalid authorization rather than as
/// no configuration. That is what marks the destination unauthorized in the UI
/// and offers Change Folder — and, just as importantly, what stops the delivery
/// paths from treating the installation as unconfigured and creating a default
/// destination underneath a folder the owner already chose.
fn classify_legacy_authorization(canonical_root: &Path) -> &'static str {
    match read_authorization_file(&legacy_authorization_path(canonical_root)) {
        Err(code) => code,
        Ok(None) => DELIVERY_FOLDER_NOT_CONFIGURED,
        Ok(Some(bytes)) => match serde_json::from_slice::<LegacyAuthorizationBinding>(&bytes) {
            Ok(legacy)
                if legacy.schema == AUTHORIZATION_SCHEMA_LEGACY
                    && is_sha256(&legacy.canonical_path_sha256_hex)
                    && !legacy.destination_folder_leaf_name.is_empty() =>
            {
                DELIVERY_FOLDER_MOVED_OR_REPLACED
            }
            _ => DELIVERY_FOLDER_INVALID,
        },
    }
}

/// Resolves which authorization actually governs a delivery request.
///
/// The caller passes `configuration_absent`, which reports what the Studio-side
/// sync config says — not what is on disk. Letting that flag choose the branch
/// meant a request could route straight into `default_binding` while a
/// recognizable v1 record sat in the authorization directory: a v2 binding for a
/// freshly created default folder would be minted and delivery would proceed,
/// and the refusal that should have sent the owner to Change Folder never
/// happened. Persisted evidence outranks the caller's belief, so the
/// authorization files are resolved first and defaulting is reachable only when
/// neither generation is present.
fn resolve_request_binding(
    authorization_root: &Path,
    home: &Path,
    configuration_absent: bool,
    configured_path_mode: ConfiguredPathMode,
) -> Result<AuthorizationBinding, &'static str> {
    match load_binding(authorization_root) {
        Ok(binding) => Ok(binding),
        Err(DELIVERY_FOLDER_NOT_CONFIGURED) if configuration_absent => {
            if configured_path_mode != ConfiguredPathMode::Relative {
                return Err(DELIVERY_FOLDER_CONFIG_MISMATCH);
            }
            default_binding(authorization_root, home)
        }
        Err(code) => Err(code),
    }
}

pub(crate) fn revalidate_binding(binding: &AuthorizationBinding) -> Result<PathBuf, &'static str> {
    validate_binding_shape(binding)?;
    let path = PathBuf::from(&binding.canonical_path);
    let (canonical, metadata) = validate_directory(
        &path,
        Some(ExpectedFolderIdentity {
            volume_identity: &binding.volume_identity,
            inode: binding.inode,
        }),
        current_uid(),
    )?;
    let canonical_text = path_text(&canonical)?;
    let (_, inode, owner_uid) = metadata_identity(&metadata);
    if sha256_hex(canonical_text.as_bytes()) != binding.canonical_path_sha256_hex
        || canonical.file_name().and_then(|value| value.to_str())
            != Some(binding.destination_folder_leaf_name.as_str())
        || inode != binding.inode
        || owner_uid != binding.owner_uid
    {
        return Err(DELIVERY_FOLDER_MOVED_OR_REPLACED);
    }
    Ok(canonical)
}

pub(crate) fn authorization_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(AUTHORIZATION_DIRECTORY))
        .map_err(|_| DELIVERY_AUTHORIZATION_WRITE_FAILED.to_string())
}

pub(crate) fn resolve_authorized_delivery_directory(
    app: &tauri::AppHandle,
) -> Result<PathBuf, String> {
    let binding = load_binding(&authorization_root(app)?).map_err(str::to_string)?;
    revalidate_binding(&binding).map_err(str::to_string)
}

fn validate_delivery_authorization_core(
    authorization_root: &Path,
    request: &Item11ValidateDeliveryAuthorizationRequest,
) -> Result<Item11ValidateDeliveryAuthorizationResult, &'static str> {
    if !is_sha256(&request.expected_destination_path_sha256_hex) {
        return Err(DELIVERY_FOLDER_CONFIG_MISMATCH);
    }
    let binding = load_binding(authorization_root)?;
    if binding.canonical_path_sha256_hex != request.expected_destination_path_sha256_hex
        || binding.configured_path_mode != request.destination_configured_path_mode
    {
        return Err(DELIVERY_FOLDER_CONFIG_MISMATCH);
    }
    revalidate_binding(&binding)?;
    Ok(Item11ValidateDeliveryAuthorizationResult {
        ok: true,
        verdict: "delivery-authorization-validated",
        status: "authorized",
        destination_folder_leaf_name: binding.destination_folder_leaf_name,
        destination_path_sha256_hex: binding.canonical_path_sha256_hex,
        destination_configured_path_mode: binding.configured_path_mode,
        read_only: true,
        no_network: true,
    })
}

#[tauri::command]
pub fn h2o_item11_validate_delivery_authorization(
    app: tauri::AppHandle,
    request: Item11ValidateDeliveryAuthorizationRequest,
) -> Result<Item11ValidateDeliveryAuthorizationResult, String> {
    validate_delivery_authorization_core(&authorization_root(&app)?, &request)
        .map_err(str::to_string)
}

fn configured_selection_path(canonical: &Path, home: &Path) -> (String, ConfiguredPathMode) {
    let canonical_home = fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    if let Ok(relative) = canonical.strip_prefix(&canonical_home) {
        if !relative.as_os_str().is_empty()
            && !relative
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            if let Some(text) = relative.to_str() {
                return (text.to_string(), ConfiguredPathMode::Relative);
            }
        }
    }
    (
        canonical.to_string_lossy().into_owned(),
        ConfiguredPathMode::Absolute,
    )
}

#[tauri::command]
pub async fn h2o_item11_select_delivery_folder(
    app: tauri::AppHandle,
) -> Result<Item11SelectDeliveryFolderResult, String> {
    let selected = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .ok_or_else(|| DELIVERY_FOLDER_SELECTION_CANCELLED.to_string())?;
    let selected_path = selected
        .into_path()
        .map_err(|_| DELIVERY_FOLDER_INVALID.to_string())?;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| DELIVERY_FOLDER_UNAVAILABLE.to_string())?;
    let preliminary = binding_from_directory(&selected_path, ConfiguredPathMode::Absolute)
        .map_err(str::to_string)?;
    let canonical = PathBuf::from(&preliminary.canonical_path);
    let (configured_folder_path, configured_path_mode) =
        configured_selection_path(&canonical, &home);
    let binding =
        binding_from_directory(&canonical, configured_path_mode).map_err(str::to_string)?;
    persist_binding(&authorization_root(&app)?, &binding).map_err(str::to_string)?;
    Ok(Item11SelectDeliveryFolderResult {
        ok: true,
        verdict: "delivery-folder-selected",
        configured_folder_path,
        destination_folder_leaf_name: binding.destination_folder_leaf_name,
        destination_path_sha256_hex: binding.canonical_path_sha256_hex,
        destination_configured_path_mode: binding.configured_path_mode,
    })
}

fn open_read_nofollow(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    options.open(path)
}

pub(crate) fn read_bounded(path: &Path) -> Result<Vec<u8>, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| DELIVERY_FINAL_VERIFICATION_FAILED)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(DELIVERY_FINAL_VERIFICATION_FAILED);
    }
    if metadata.len() as usize > MAX_DELIVERY_BYTES {
        return Err(DELIVERY_FINAL_VERIFICATION_FAILED);
    }
    let mut file = open_read_nofollow(path).map_err(|_| DELIVERY_FINAL_VERIFICATION_FAILED)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| DELIVERY_FINAL_VERIFICATION_FAILED)?;
    Ok(bytes)
}

fn create_temporary(path: &Path) -> Result<File, &'static str> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    options.open(path).map_err(|error| match error.kind() {
        ErrorKind::AlreadyExists => DELIVERY_TEMP_EXISTS,
        ErrorKind::PermissionDenied => DELIVERY_FOLDER_PERMISSION_DENIED,
        _ => DELIVERY_TEMP_WRITE_FAILED,
    })
}

pub(crate) fn write_exact_temporary(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut file = create_temporary(path)?;
    if file.write_all(bytes).is_err() || file.sync_all().is_err() {
        let _ = fs::remove_file(path);
        return Err(DELIVERY_TEMP_WRITE_FAILED);
    }
    Ok(())
}

fn restore_previous(
    directory: &Path,
    temporary_path: &Path,
    final_path: &Path,
    previous: Option<&[u8]>,
) -> bool {
    let _ = fs::remove_file(temporary_path);
    match previous {
        Some(bytes) => {
            if write_exact_temporary(temporary_path, bytes).is_err() {
                return false;
            }
            if fs::rename(temporary_path, final_path).is_err() {
                let _ = fs::remove_file(temporary_path);
                return false;
            }
            sync_directory(directory).is_ok()
                && read_bounded(final_path)
                    .map(|value| value == bytes)
                    .unwrap_or(false)
        }
        None => fs::remove_file(final_path).is_ok() && sync_directory(directory).is_ok(),
    }
}

fn write_delivery_bytes(
    binding: &AuthorizationBinding,
    bytes: &[u8],
    fault: FaultStage,
) -> Result<(), &'static str> {
    let directory = revalidate_binding(binding)?;
    let temporary_path = directory.join(TEMPORARY_FILE);
    let final_path = directory.join(DELIVERY_FILE);
    let previous = match fs::symlink_metadata(&final_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(DELIVERY_ATOMIC_REPLACE_FAILED);
            }
            Some(read_bounded(&final_path).map_err(|_| DELIVERY_ATOMIC_REPLACE_FAILED)?)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return Err(DELIVERY_FOLDER_PERMISSION_DENIED)
        }
        Err(_) => return Err(DELIVERY_FOLDER_UNAVAILABLE),
    };
    if temporary_path.exists() {
        return Err(DELIVERY_TEMP_EXISTS);
    }
    if fault == FaultStage::TempWrite {
        return Err(DELIVERY_TEMP_WRITE_FAILED);
    }
    write_exact_temporary(&temporary_path, bytes)?;
    if fault == FaultStage::TempVerification {
        let _ = fs::remove_file(&temporary_path);
        return Err(DELIVERY_TEMP_VERIFICATION_FAILED);
    }
    let temporary_bytes = match read_bounded(&temporary_path) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = fs::remove_file(&temporary_path);
            return Err(DELIVERY_TEMP_VERIFICATION_FAILED);
        }
    };
    if temporary_bytes != bytes || sha256_hex(&temporary_bytes) != sha256_hex(bytes) {
        let _ = fs::remove_file(&temporary_path);
        return Err(DELIVERY_TEMP_VERIFICATION_FAILED);
    }
    if fault == FaultStage::AtomicReplace {
        let _ = fs::remove_file(&temporary_path);
        return Err(DELIVERY_ATOMIC_REPLACE_FAILED);
    }
    if fs::rename(&temporary_path, &final_path).is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(DELIVERY_ATOMIC_REPLACE_FAILED);
    }
    if sync_directory(&directory).is_err() {
        let _ = restore_previous(
            &directory,
            &temporary_path,
            &final_path,
            previous.as_deref(),
        );
        return Err(DELIVERY_ATOMIC_REPLACE_FAILED);
    }
    if fault == FaultStage::FinalVerification {
        let _ = restore_previous(
            &directory,
            &temporary_path,
            &final_path,
            previous.as_deref(),
        );
        return Err(DELIVERY_FINAL_VERIFICATION_FAILED);
    }
    let final_bytes = match read_bounded(&final_path) {
        Ok(bytes) => bytes,
        Err(_) => {
            let _ = restore_previous(
                &directory,
                &temporary_path,
                &final_path,
                previous.as_deref(),
            );
            return Err(DELIVERY_FINAL_VERIFICATION_FAILED);
        }
    };
    if final_bytes != bytes || sha256_hex(&final_bytes) != sha256_hex(bytes) {
        let _ = restore_previous(
            &directory,
            &temporary_path,
            &final_path,
            previous.as_deref(),
        );
        return Err(DELIVERY_FINAL_VERIFICATION_FAILED);
    }
    Ok(())
}

fn default_binding(
    authorization_root: &Path,
    home: &Path,
) -> Result<AuthorizationBinding, &'static str> {
    let directory = home.join(DEFAULT_FOLDER);
    fs::create_dir_all(&directory).map_err(|error| match error.kind() {
        ErrorKind::PermissionDenied => DELIVERY_FOLDER_PERMISSION_DENIED,
        _ => DELIVERY_FOLDER_UNAVAILABLE,
    })?;
    let binding = binding_from_directory(&directory, ConfiguredPathMode::Relative)?;
    persist_binding(authorization_root, &binding)?;
    Ok(binding)
}

fn prepare_delivery_core(
    authorization_root: &Path,
    home: &Path,
    request: &Item11PrepareDeliveryRequest,
    fault: FaultStage,
) -> Result<Item11PrepareDeliveryResult, &'static str> {
    validate_delivery_envelope(&request.delivery_json, &request.object_id)?;
    if !is_sha256(&request.expected_destination_path_sha256_hex) {
        return Err(DELIVERY_FOLDER_CONFIG_MISMATCH);
    }
    let binding = resolve_request_binding(
        authorization_root,
        home,
        request.configuration_absent,
        request.destination_configured_path_mode,
    )?;
    if binding.canonical_path_sha256_hex != request.expected_destination_path_sha256_hex
        || binding.configured_path_mode != request.destination_configured_path_mode
    {
        return Err(DELIVERY_FOLDER_CONFIG_MISMATCH);
    }
    let bytes = request.delivery_json.as_bytes();
    write_delivery_bytes(&binding, bytes, fault)?;
    Ok(Item11PrepareDeliveryResult {
        ok: true,
        verdict: "delivery-written",
        destination_folder_leaf_name: binding.destination_folder_leaf_name,
        destination_path_sha256_hex: binding.canonical_path_sha256_hex,
        destination_configured_path_mode: binding.configured_path_mode,
        delivery_byte_length: bytes.len(),
        delivery_sha256_hex: sha256_hex(bytes),
    })
}

#[tauri::command]
pub async fn h2o_item11_prepare_delivery(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    request: Item11PrepareDeliveryRequest,
) -> Result<Item11PrepareDeliveryResult, String> {
    /*
     * O1-T19. A JS refusal is a refusal only for callers that go through the
     * JS; this command is reachable from anything in the webview, so the
     * generation is observed here too. A positively-absent record permits
     * exactly as before, so pre-standdown behaviour is unchanged.
     */
    crate::p01_generation_gate::require_p01_mutation_permitted(&db_instances).await?;
    let root = authorization_root(&app)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| DELIVERY_FOLDER_UNAVAILABLE.to_string())?;
    prepare_delivery_core(&root, &home, &request, FaultStage::None).map_err(str::to_string)
}

/* ---------------------------------------------------------------------------
 * Local-delivery lineage ledger (Step 2A foundation).
 *
 * Authority: Desktop writer identity + destination authorization binding +
 * objectKey -> the latest revision this Desktop made visible at that
 * destination.  `round2-item9-delivery.json` is a single-slot artifact that may
 * hold another object's package, so it is evidence, never authority.
 * ------------------------------------------------------------------------ */

/// Timestamp shape accepted by the browser-delivery envelope contract.
fn is_accepted_timestamp(value: &str) -> bool {
    value.len() >= 20
        && value.len() <= 40
        && value.ends_with('Z')
        && !value.chars().any(char::is_control)
}

fn is_accepted_revision_id(value: &str) -> bool {
    valid_identity(value) && value.as_bytes().len() <= MAX_OBJECT_ID_BYTES
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LineageTip {
    revision_id: String,
    previous_revision_id: Option<String>,
    revision_blob_sha256_hex: String,
    delivery_sha256_hex: String,
    produced_at_iso: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ExternalApplyTip {
    revision_id: String,
    previous_revision_id: Option<String>,
    revision_blob_sha256_hex: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LineagePending {
    object_key: String,
    revision_id: String,
    previous_revision_id: Option<String>,
    revision_blob_sha256_hex: String,
    delivery_sha256_hex: String,
    produced_at_iso: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeliveryLineage {
    schema: String,
    writer_sync_peer_id_sha256_hex: String,
    destination_path_sha256_hex: String,
    destination_volume_identity_kind: String,
    destination_volume_identity: String,
    destination_inode: u64,
    destination_owner_uid: u32,
    tips: BTreeMap<String, LineageTip>,
    pending: Option<LineagePending>,
    updated_at: String,
}

/// M3 Settings reads one object's existing lineage through the same binding
/// and writer-identity checks used by preparation. The request carries no
/// ledger path and the result deliberately omits identity, destination and
/// delivery/head material. It exposes only the committed revision-blob digest
/// needed to cross-check local-publication provenance against canonical state.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item11ReadLineageRequest {
    object_id: String,
    writer_sync_peer_id: String,
    expected_destination_path_sha256_hex: String,
    destination_configured_path_mode: ConfiguredPathMode,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item11ReadLineageResult {
    ok: bool,
    verdict: &'static str,
    state: &'static str,
    object_id: String,
    current_revision_id: Option<String>,
    current_revision_blob_sha256_hex: Option<String>,
    previous_revision_id: Option<String>,
    pending_revision_id: Option<String>,
    chain: Vec<String>,
    updated_at: Option<String>,
    read_only: bool,
    no_network: bool,
}

/// Summary of the package currently visible in the destination slot. Callers
/// derive it from the delivery file itself; an undecodable package yields an
/// error rather than an absent observation, so lineage never silently resets.
#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedDelivery {
    object_key: String,
    revision_id: String,
    previous_revision_id: Option<String>,
    revision_blob_sha256_hex: String,
    delivery_sha256_hex: String,
    produced_at_iso: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LineageDisposition {
    /// A revision this destination has never made visible.
    NewRevision,
    /// The exact revision already recorded as unresolved pending intent.
    ResumedPending,
    /// The exact revision already committed as this object's tip.
    CommittedReplay,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LineagePlan {
    object_key: String,
    revision_id: String,
    previous_revision_id: Option<String>,
    produced_at_iso: String,
    disposition: LineageDisposition,
    /// Present for resume/replay: the delivery digest that must be reproduced.
    expected_delivery_sha256_hex: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LineageRecovery {
    /// No unresolved pending intent exists.
    Clean,
    /// Pending intent and the visible package agree: the write committed.
    PromoteReady,
    /// Pending intent is unresolved but the current request repeats it.
    ResumeRetry,
}

impl DeliveryLineage {
    fn empty(
        binding: &AuthorizationBinding,
        writer_sync_peer_id_sha256_hex: &str,
        updated_at: &str,
    ) -> Self {
        DeliveryLineage {
            schema: LINEAGE_SCHEMA.to_string(),
            writer_sync_peer_id_sha256_hex: writer_sync_peer_id_sha256_hex.to_string(),
            destination_path_sha256_hex: binding.canonical_path_sha256_hex.clone(),
            destination_volume_identity_kind: binding.volume_identity_kind.clone(),
            destination_volume_identity: binding.volume_identity.clone(),
            destination_inode: binding.inode,
            destination_owner_uid: binding.owner_uid,
            tips: BTreeMap::new(),
            pending: None,
            updated_at: updated_at.to_string(),
        }
    }
}

fn validate_lineage_tip(tip: &LineageTip) -> Result<(), &'static str> {
    if !is_accepted_revision_id(&tip.revision_id)
        || !is_sha256(&tip.revision_blob_sha256_hex)
        || !is_sha256(&tip.delivery_sha256_hex)
        || !is_accepted_timestamp(&tip.produced_at_iso)
    {
        return Err(LINEAGE_MALFORMED);
    }
    match tip.previous_revision_id.as_deref() {
        None => Ok(()),
        Some(previous) if is_accepted_revision_id(previous) && previous != tip.revision_id => {
            Ok(())
        }
        Some(_) => Err(LINEAGE_MALFORMED),
    }
}

fn validate_lineage_pending(pending: &LineagePending) -> Result<(), &'static str> {
    if !is_sha256(&pending.object_key) {
        return Err(LINEAGE_MALFORMED);
    }
    validate_lineage_tip(&LineageTip {
        revision_id: pending.revision_id.clone(),
        previous_revision_id: pending.previous_revision_id.clone(),
        revision_blob_sha256_hex: pending.revision_blob_sha256_hex.clone(),
        delivery_sha256_hex: pending.delivery_sha256_hex.clone(),
        produced_at_iso: pending.produced_at_iso.clone(),
    })
}

/// Structural validation plus an exact match against the live authorization
/// binding and Desktop writer identity. Any divergence fails closed.
fn validate_lineage(
    lineage: &DeliveryLineage,
    binding: &AuthorizationBinding,
    writer_sync_peer_id_sha256_hex: &str,
) -> Result<(), &'static str> {
    if lineage.schema != LINEAGE_SCHEMA
        || !is_sha256(&lineage.writer_sync_peer_id_sha256_hex)
        || !is_sha256(&lineage.destination_path_sha256_hex)
        || lineage.destination_volume_identity_kind != VOLUME_IDENTITY_KIND
        || !is_volume_identity(&lineage.destination_volume_identity)
        || !is_accepted_timestamp(&lineage.updated_at)
    {
        return Err(LINEAGE_MALFORMED);
    }
    if lineage.tips.len() > MAX_LINEAGE_TIPS {
        return Err(LINEAGE_TIP_LIMIT_EXCEEDED);
    }
    for (object_key, tip) in &lineage.tips {
        if !is_sha256(object_key) {
            return Err(LINEAGE_MALFORMED);
        }
        validate_lineage_tip(tip)?;
    }
    if let Some(pending) = &lineage.pending {
        validate_lineage_pending(pending)?;
        /* A pending intent for an object with no tip needs a free slot to be
         * promoted into. At capacity that state is unpromotable, so a correctly
         * operating writer can never produce it: the `begin_pending` preflight
         * refuses before any intent is persisted. Reject it on sight rather
         * than accept an authority that can never resolve. */
        if !lineage.tips.contains_key(&pending.object_key) && lineage.tips.len() >= MAX_LINEAGE_TIPS
        {
            return Err(LINEAGE_TIP_LIMIT_EXCEEDED);
        }
    }
    if !is_sha256(writer_sync_peer_id_sha256_hex)
        || lineage.writer_sync_peer_id_sha256_hex != writer_sync_peer_id_sha256_hex
        || lineage.destination_path_sha256_hex != binding.canonical_path_sha256_hex
        || lineage.destination_volume_identity_kind != binding.volume_identity_kind
        || lineage.destination_volume_identity != binding.volume_identity
        || lineage.destination_inode != binding.inode
        || lineage.destination_owner_uid != binding.owner_uid
    {
        return Err(LINEAGE_BINDING_MISMATCH);
    }
    Ok(())
}

/// The one canonical ledger serializer. Load verification and `persist_lineage`
/// both route through it so the on-disk representation cannot drift.
fn serialize_lineage(lineage: &DeliveryLineage) -> Result<Vec<u8>, &'static str> {
    serde_json::to_vec(lineage).map_err(|_| LINEAGE_WRITE_FAILED)
}

fn lineage_paths(root: &Path, destination_path_sha256_hex: &str) -> (PathBuf, PathBuf) {
    (
        root.join(format!(
            "{LINEAGE_FILE_PREFIX}{destination_path_sha256_hex}{LINEAGE_FILE_SUFFIX}"
        )),
        root.join(format!(
            "{LINEAGE_TEMP_PREFIX}{destination_path_sha256_hex}{LINEAGE_TEMP_SUFFIX}"
        )),
    )
}

/// Reads the ledger for one verified binding. Absence is an empty lineage and
/// mutates nothing: no directory is created and no file is written.
fn load_lineage(
    root: &Path,
    binding: &AuthorizationBinding,
    writer_sync_peer_id_sha256_hex: &str,
) -> Result<Option<DeliveryLineage>, &'static str> {
    if !is_sha256(&binding.canonical_path_sha256_hex) {
        return Err(LINEAGE_BINDING_MISMATCH);
    }
    let (path, _) = lineage_paths(root, &binding.canonical_path_sha256_hex);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return Err(DELIVERY_FOLDER_PERMISSION_DENIED)
        }
        Err(_) => return Err(LINEAGE_MALFORMED),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LINEAGE_UNSAFE_FILE_TYPE);
    }
    /* Creation-time 0600 is not enough: a later chmod would widen an authority
     * file that binds identity to lineage. Verify on every read and never
     * repair, so a widened ledger is surfaced rather than silently narrowed. */
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err(LINEAGE_UNSAFE_MODE);
    }
    if metadata.len() as usize > MAX_LINEAGE_BYTES {
        return Err(LINEAGE_OVERSIZE);
    }
    let mut file = open_read_nofollow(&path).map_err(|_| LINEAGE_UNSAFE_FILE_TYPE)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| LINEAGE_MALFORMED)?;
    if bytes.len() > MAX_LINEAGE_BYTES {
        return Err(LINEAGE_OVERSIZE);
    }
    let lineage: DeliveryLineage = serde_json::from_slice(&bytes).map_err(|_| LINEAGE_MALFORMED)?;
    validate_lineage(&lineage, binding, writer_sync_peer_id_sha256_hex)?;
    /* Single canonical representation: re-serializing the parsed, validated
     * value through the one writer must reproduce the file byte-for-byte.
     * serde_json accepts duplicate keys with last-wins semantics, so this is
     * what rejects duplicated top-level, tip and pending fields — along with
     * reformatting, reordering and any other noncanonical encoding. Never
     * rewrite the file to make it canonical. */
    if serialize_lineage(&lineage)? != bytes {
        return Err(LINEAGE_MALFORMED);
    }
    Ok(Some(lineage))
}

/// Redacted read-only projection for one object. This function intentionally
/// has no default-binding path and no call to `persist_lineage`: an absent
/// authorization fails closed, while an absent ledger is a truthful empty
/// result and never creates a directory or file.
fn read_lineage_core(
    authorization_root: &Path,
    request: &Item11ReadLineageRequest,
) -> Result<Item11ReadLineageResult, &'static str> {
    if !valid_identity(&request.object_id)
        || request.object_id.as_bytes().len() > MAX_OBJECT_ID_BYTES
        || !is_canonical_writer_identity(&request.writer_sync_peer_id)
        || !is_sha256(&request.expected_destination_path_sha256_hex)
    {
        return Err(LINEAGE_MALFORMED);
    }
    let binding = load_binding(authorization_root)?;
    if binding.canonical_path_sha256_hex != request.expected_destination_path_sha256_hex
        || binding.configured_path_mode != request.destination_configured_path_mode
    {
        return Err(DELIVERY_FOLDER_CONFIG_MISMATCH);
    }
    revalidate_binding(&binding)?;
    let writer_fingerprint = sha256_hex(request.writer_sync_peer_id.as_bytes());
    let Some(lineage) = load_lineage(authorization_root, &binding, &writer_fingerprint)? else {
        return Ok(Item11ReadLineageResult {
            ok: true,
            verdict: "delivery-lineage-read",
            state: "empty",
            object_id: request.object_id.clone(),
            current_revision_id: None,
            current_revision_blob_sha256_hex: None,
            previous_revision_id: None,
            pending_revision_id: None,
            chain: Vec::new(),
            updated_at: None,
            read_only: true,
            no_network: true,
        });
    };
    let object_key = object_key_hex(&request.object_id);
    let tip = resolve_tip(&lineage, &object_key);
    let pending = lineage
        .pending
        .as_ref()
        .filter(|candidate| candidate.object_key == object_key);
    let mut chain = Vec::with_capacity(2);
    if let Some(previous) = tip.and_then(|value| value.previous_revision_id.clone()) {
        chain.push(previous);
    }
    if let Some(current) = tip.map(|value| value.revision_id.clone()) {
        chain.push(current);
    }
    Ok(Item11ReadLineageResult {
        ok: true,
        verdict: "delivery-lineage-read",
        state: if pending.is_some() {
            "pending"
        } else if tip.is_some() {
            "current"
        } else {
            "empty"
        },
        object_id: request.object_id.clone(),
        current_revision_id: tip.map(|value| value.revision_id.clone()),
        current_revision_blob_sha256_hex: tip.map(|value| value.revision_blob_sha256_hex.clone()),
        previous_revision_id: tip.and_then(|value| value.previous_revision_id.clone()),
        pending_revision_id: pending.map(|value| value.revision_id.clone()),
        chain,
        updated_at: if tip.is_some() || pending.is_some() {
            Some(lineage.updated_at)
        } else {
            None
        },
        read_only: true,
        no_network: true,
    })
}

#[tauri::command]
pub fn h2o_item11_read_lineage(
    app: tauri::AppHandle,
    request: Item11ReadLineageRequest,
) -> Result<Item11ReadLineageResult, String> {
    let root = authorization_root(&app)?;
    read_lineage_core(&root, &request).map_err(str::to_string)
}

/// Atomic ledger replacement: create_new temp, fsync, rename, parent fsync.
fn persist_lineage(
    root: &Path,
    lineage: &DeliveryLineage,
    binding: &AuthorizationBinding,
    writer_sync_peer_id_sha256_hex: &str,
) -> Result<(), &'static str> {
    validate_lineage(lineage, binding, writer_sync_peer_id_sha256_hex)?;
    let bytes = serialize_lineage(lineage)?;
    if bytes.len() > MAX_LINEAGE_BYTES {
        return Err(LINEAGE_OVERSIZE);
    }
    fs::create_dir_all(root).map_err(|_| LINEAGE_WRITE_FAILED)?;
    let (canonical_root, _) =
        validate_directory(root, None, current_uid()).map_err(|_| LINEAGE_WRITE_FAILED)?;
    let (final_path, temporary_path) =
        lineage_paths(&canonical_root, &lineage.destination_path_sha256_hex);
    if fs::symlink_metadata(&temporary_path).is_ok() {
        return Err(LINEAGE_TEMP_EXISTS);
    }
    if let Ok(metadata) = fs::symlink_metadata(&final_path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(LINEAGE_UNSAFE_FILE_TYPE);
        }
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&temporary_path)
        .map_err(|error| match error.kind() {
            ErrorKind::AlreadyExists => LINEAGE_TEMP_EXISTS,
            _ => LINEAGE_WRITE_FAILED,
        })?;
    if file.write_all(&bytes).is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(LINEAGE_WRITE_FAILED);
    }
    if file.sync_all().is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(LINEAGE_FSYNC_FAILED);
    }
    if fs::rename(&temporary_path, &final_path).is_err() {
        let _ = fs::remove_file(&temporary_path);
        return Err(LINEAGE_RENAME_FAILED);
    }
    File::open(&canonical_root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| LINEAGE_FSYNC_FAILED)
}

fn resolve_tip<'a>(lineage: &'a DeliveryLineage, object_key: &str) -> Option<&'a LineageTip> {
    lineage.tips.get(object_key)
}

/// A package occupying the destination slot is only evidence once it decodes
/// into a well-formed summary. Anything else fails closed so that a corrupt or
/// truncated file can never be mistaken for "no delivery" and reset lineage.
fn validate_observed_delivery(observed: &ObservedDelivery) -> Result<(), &'static str> {
    if !is_sha256(&observed.object_key)
        || !is_accepted_revision_id(&observed.revision_id)
        || !is_sha256(&observed.revision_blob_sha256_hex)
        || !is_sha256(&observed.delivery_sha256_hex)
        || !is_accepted_timestamp(&observed.produced_at_iso)
    {
        return Err(LINEAGE_DESTINATION_PACKAGE_INVALID);
    }
    match observed.previous_revision_id.as_deref() {
        None => Ok(()),
        Some(previous) if is_accepted_revision_id(previous) && previous != observed.revision_id => {
            Ok(())
        }
        Some(_) => Err(LINEAGE_DESTINATION_PACKAGE_INVALID),
    }
}

fn pending_matches_observed(pending: &LineagePending, observed: &ObservedDelivery) -> bool {
    pending.object_key == observed.object_key
        && pending.revision_id == observed.revision_id
        && pending.previous_revision_id == observed.previous_revision_id
        && pending.revision_blob_sha256_hex == observed.revision_blob_sha256_hex
        && pending.delivery_sha256_hex == observed.delivery_sha256_hex
        && pending.produced_at_iso == observed.produced_at_iso
}

/// Classifies the recovery state without mutating anything. `observed` is
/// `None` when the destination slot is empty or holds a different package;
/// an undecodable package must be reported by the caller as an error before
/// reaching here, never as `None`.
fn reconcile_pending(
    lineage: &DeliveryLineage,
    observed: Option<&ObservedDelivery>,
    request_object_key: &str,
    request_revision_id: &str,
) -> Result<LineageRecovery, &'static str> {
    if let Some(observed) = observed {
        validate_observed_delivery(observed)?;
    }
    let Some(pending) = &lineage.pending else {
        return Ok(LineageRecovery::Clean);
    };
    if observed.is_some_and(|observed| pending_matches_observed(pending, observed)) {
        return Ok(LineageRecovery::PromoteReady);
    }
    if pending.object_key == request_object_key && pending.revision_id == request_revision_id {
        return Ok(LineageRecovery::ResumeRetry);
    }
    Err(LINEAGE_UNRESOLVED)
}

/// Chooses this operation's parent revision and `producedAtIso`.
///
/// `candidate_produced_at_iso` is used only for a genuinely new revision; a
/// resumed pending or a committed replay reuses the persisted timestamp so the
/// same logical revision reproduces byte-identical delivery bytes.
#[allow(dead_code)]
fn begin_pending(
    lineage: &DeliveryLineage,
    object_key: &str,
    revision_id: &str,
    revision_blob_sha256_hex: &str,
    candidate_produced_at_iso: &str,
) -> Result<LineagePlan, &'static str> {
    begin_pending_with_external(
        lineage,
        object_key,
        revision_id,
        revision_blob_sha256_hex,
        candidate_produced_at_iso,
        None,
    )
}

fn begin_pending_with_external(
    lineage: &DeliveryLineage,
    object_key: &str,
    revision_id: &str,
    revision_blob_sha256_hex: &str,
    candidate_produced_at_iso: &str,
    external_apply_tip: Option<&ExternalApplyTip>,
) -> Result<LineagePlan, &'static str> {
    if !is_sha256(object_key)
        || !is_accepted_revision_id(revision_id)
        || !is_sha256(revision_blob_sha256_hex)
        || !is_accepted_timestamp(candidate_produced_at_iso)
    {
        return Err(LINEAGE_MALFORMED);
    }
    if let Some(pending) = &lineage.pending {
        if pending.object_key != object_key || pending.revision_id != revision_id {
            return Err(LINEAGE_UNRESOLVED);
        }
        if pending.revision_blob_sha256_hex != revision_blob_sha256_hex {
            return Err(LINEAGE_UNRESOLVED);
        }
        return Ok(LineagePlan {
            object_key: object_key.to_string(),
            revision_id: revision_id.to_string(),
            previous_revision_id: pending.previous_revision_id.clone(),
            produced_at_iso: pending.produced_at_iso.clone(),
            disposition: LineageDisposition::ResumedPending,
            expected_delivery_sha256_hex: Some(pending.delivery_sha256_hex.clone()),
        });
    }
    match resolve_tip(lineage, object_key) {
        Some(tip) if tip.revision_id == revision_id => {
            if tip.revision_blob_sha256_hex != revision_blob_sha256_hex {
                return Err(LINEAGE_UNRESOLVED);
            }
            Ok(LineagePlan {
                object_key: object_key.to_string(),
                revision_id: revision_id.to_string(),
                previous_revision_id: tip.previous_revision_id.clone(),
                produced_at_iso: tip.produced_at_iso.clone(),
                disposition: LineageDisposition::CommittedReplay,
                expected_delivery_sha256_hex: Some(tip.delivery_sha256_hex.clone()),
            })
        }
        local_tip => {
            /* Capacity is decided here, before any intent can be persisted and
             * before a delivery could become visible. Admitting a brand-new
             * object at capacity would leave a pending intent that
             * `promote_pending` could never insert, stranding a visible
             * delivery with unresolvable lineage. The bound limits tracked
             * objects, not revisions, so an object already in `tips` is
             * unaffected. */
            if local_tip.is_none() && lineage.tips.len() >= MAX_LINEAGE_TIPS {
                return Err(LINEAGE_TIP_LIMIT_EXCEEDED);
            }
            let previous_revision_id = match (local_tip, external_apply_tip) {
                (None, None) => None,
                (Some(local), None) => Some(local.revision_id.clone()),
                (None, Some(remote)) => Some(remote.revision_id.clone()),
                (Some(local), Some(remote)) if local.revision_id == remote.revision_id => {
                    if local.revision_blob_sha256_hex != remote.revision_blob_sha256_hex {
                        return Err(LINEAGE_UNRESOLVED);
                    }
                    Some(local.revision_id.clone())
                }
                (Some(local), Some(remote))
                    if remote.previous_revision_id.as_deref()
                        == Some(local.revision_id.as_str()) =>
                {
                    Some(remote.revision_id.clone())
                }
                (Some(local), Some(remote))
                    if local.previous_revision_id.as_deref()
                        == Some(remote.revision_id.as_str()) =>
                {
                    Some(local.revision_id.clone())
                }
                (Some(_), Some(_)) => return Err(LINEAGE_UNRESOLVED),
            };
            Ok(LineagePlan {
                object_key: object_key.to_string(),
                revision_id: revision_id.to_string(),
                previous_revision_id,
                produced_at_iso: candidate_produced_at_iso.to_string(),
                disposition: LineageDisposition::NewRevision,
                expected_delivery_sha256_hex: None,
            })
        }
    }
}

/// Records the pending intent for a plan. A committed replay records nothing:
/// the chain must not advance, and the delivery digest must reproduce exactly.
fn record_pending(
    lineage: &mut DeliveryLineage,
    plan: &LineagePlan,
    revision_blob_sha256_hex: &str,
    delivery_sha256_hex: &str,
    updated_at: &str,
) -> Result<bool, &'static str> {
    if !is_sha256(delivery_sha256_hex) || !is_accepted_timestamp(updated_at) {
        return Err(LINEAGE_MALFORMED);
    }
    if let Some(expected) = &plan.expected_delivery_sha256_hex {
        if expected != delivery_sha256_hex {
            return Err(LINEAGE_UNRESOLVED);
        }
    }
    if plan.disposition == LineageDisposition::CommittedReplay {
        return Ok(false);
    }
    lineage.pending = Some(LineagePending {
        object_key: plan.object_key.clone(),
        revision_id: plan.revision_id.clone(),
        previous_revision_id: plan.previous_revision_id.clone(),
        revision_blob_sha256_hex: revision_blob_sha256_hex.to_string(),
        delivery_sha256_hex: delivery_sha256_hex.to_string(),
        produced_at_iso: plan.produced_at_iso.clone(),
    });
    lineage.updated_at = updated_at.to_string();
    Ok(true)
}

/// Promotes pending intent to this object's tip. Only the exact visible package
/// proves the delivery became visible, so nothing else may promote.
fn promote_pending(
    lineage: &mut DeliveryLineage,
    observed: &ObservedDelivery,
    updated_at: &str,
) -> Result<(), &'static str> {
    if !is_accepted_timestamp(updated_at) {
        return Err(LINEAGE_MALFORMED);
    }
    validate_observed_delivery(observed)?;
    let pending = lineage.pending.clone().ok_or(LINEAGE_UNRESOLVED)?;
    if !pending_matches_observed(&pending, observed) {
        return Err(LINEAGE_UNRESOLVED);
    }
    if !lineage.tips.contains_key(&pending.object_key) && lineage.tips.len() >= MAX_LINEAGE_TIPS {
        return Err(LINEAGE_TIP_LIMIT_EXCEEDED);
    }
    lineage.tips.insert(
        pending.object_key.clone(),
        LineageTip {
            revision_id: pending.revision_id,
            previous_revision_id: pending.previous_revision_id,
            revision_blob_sha256_hex: pending.revision_blob_sha256_hex,
            delivery_sha256_hex: pending.delivery_sha256_hex,
            produced_at_iso: pending.produced_at_iso,
        },
    );
    lineage.pending = None;
    lineage.updated_at = updated_at.to_string();
    Ok(())
}

/* ---------------------------------------------------------------------------
 * True-local delivery preparation (Step 2B).
 *
 * Produces the existing `h2o.round2.item9.browser-delivery.v1` package from
 * locally verified Desktop state alone. The parent revision comes only from the
 * lineage authority above, never from the destination slot and never from a
 * remote head, and no transport is reachable from this path.
 * ------------------------------------------------------------------------ */

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item11PrepareLocalDeliveryRequest {
    object_id: String,
    object_key_hex: String,
    revision_id: String,
    payload_sha256_hex: String,
    revision_blob_text: String,
    revision_blob_sha256_hex: String,
    writer_sync_peer_id: String,
    source_updated_at_iso: String,
    expected_destination_path_sha256_hex: String,
    destination_configured_path_mode: ConfiguredPathMode,
    configuration_absent: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalDeliveryDisposition {
    New,
    ResumedPending,
    CommittedReplay,
    RecoveredPending,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalDeliverySlotPosture {
    Absent,
    OtherObject,
    SameObjectCurrent,
    SameObjectBehind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item11PrepareLocalDeliveryResult {
    ok: bool,
    verdict: &'static str,
    object_id: String,
    revision_id: String,
    previous_revision_id: Option<String>,
    head_sha256_hex: String,
    revision_blob_sha256_hex: String,
    payload_sha256_hex: String,
    delivery_sha256_hex: String,
    produced_at_iso: String,
    delivery_byte_length: usize,
    destination_folder_leaf_name: String,
    destination_path_sha256_hex: String,
    destination_configured_path_mode: ConfiguredPathMode,
    lineage_disposition: LocalDeliveryDisposition,
    slot_posture: LocalDeliverySlotPosture,
    no_network: bool,
}

/// Test-only failure points at the load-bearing boundaries of the write
/// protocol. There is no production fault hook and no environment switch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LocalFaultStage {
    None,
    AfterPendingBeforeDelivery,
    AfterDeliveryBeforePromote,
    DuringPromotePersist,
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(triple >> 18) as usize & 63] as char);
        out.push(ALPHABET[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// The canonical Desktop writer identity form. Mirrors the shape the identity
/// authority itself enforces (`studio-desktop:tauri-desktop:sqlite:<installId>`)
/// so a non-canonical or foreign-surface identity cannot sign a local delivery.
fn is_canonical_writer_identity(value: &str) -> bool {
    valid_writer_identity(value, PeerWriterRole::DesktopOutbound)
}

#[derive(Clone, Debug)]
struct VerifiedLocalRevision {
    object_key_hex: String,
    head_object_key_hex: String,
    payload_sha256_hex: String,
    revision_blob_sha256_hex: String,
}

/// Verifies the caller's local projection before any ledger or destination
/// mutation can occur. Everything here is recomputed rather than trusted.
fn verify_local_revision(
    request: &Item11PrepareLocalDeliveryRequest,
) -> Result<VerifiedLocalRevision, &'static str> {
    if !valid_identity(&request.object_id)
        || request.object_id.as_bytes().len() > MAX_OBJECT_ID_BYTES
        || !is_accepted_revision_id(&request.revision_id)
    {
        return Err(LOCAL_DELIVERY_REVISION_INVALID);
    }
    if !is_sha256(&request.object_key_hex)
        || !is_sha256(&request.payload_sha256_hex)
        || !is_sha256(&request.revision_blob_sha256_hex)
    {
        return Err(LOCAL_DELIVERY_REVISION_INVALID);
    }
    if !is_accepted_timestamp(&request.source_updated_at_iso) {
        return Err(LOCAL_DELIVERY_REVISION_INVALID);
    }
    if !is_canonical_writer_identity(&request.writer_sync_peer_id) {
        return Err(LOCAL_DELIVERY_WRITER_IDENTITY_INVALID);
    }
    let derived_object_key = object_key_hex(&request.object_id);
    if derived_object_key != request.object_key_hex {
        return Err(LOCAL_DELIVERY_OBJECT_KEY_MISMATCH);
    }
    let revision_bytes = request.revision_blob_text.as_bytes();
    if revision_bytes.is_empty() || revision_bytes.len() > MAX_LOCAL_REVISION_BYTES {
        return Err(LOCAL_DELIVERY_REVISION_INVALID);
    }
    if sha256_hex(revision_bytes) != request.revision_blob_sha256_hex {
        return Err(LOCAL_DELIVERY_REVISION_HASH_MISMATCH);
    }
    let value: JsonValue = serde_json::from_str(&request.revision_blob_text)
        .map_err(|_| LOCAL_DELIVERY_REVISION_INVALID)?;
    /* Chrome re-canonicalizes the revision bytes during admission, so a
     * noncanonical encoding would be rejected there; refuse it here instead. */
    if canonical_value(&value).map_err(|_| LOCAL_DELIVERY_REVISION_INVALID)?
        != request.revision_blob_text
    {
        return Err(LOCAL_DELIVERY_REVISION_NOT_CANONICAL);
    }
    let revision: SyncRevision =
        serde_json::from_value(value).map_err(|_| LOCAL_DELIVERY_REVISION_INVALID)?;
    if revision.schema != REVISION_SCHEMA
        || revision.object_id != request.object_id
        || revision.object_key != request.object_key_hex
        || revision.revision_id != request.revision_id
        || revision.payload_sha256 != request.payload_sha256_hex
    {
        return Err(LOCAL_DELIVERY_REVISION_INVALID);
    }
    let payload_text =
        canonical_value(&revision.payload).map_err(|_| LOCAL_DELIVERY_REVISION_INVALID)?;
    if sha256_hex(payload_text.as_bytes()) != request.payload_sha256_hex {
        return Err(LOCAL_DELIVERY_REVISION_HASH_MISMATCH);
    }
    Ok(VerifiedLocalRevision {
        head_object_key_hex: derived_object_key.clone(),
        object_key_hex: derived_object_key,
        payload_sha256_hex: request.payload_sha256_hex.clone(),
        revision_blob_sha256_hex: request.revision_blob_sha256_hex.clone(),
    })
}

/// Decodes and cryptographically verifies the package currently occupying the
/// destination slot, then reduces it to the summary the recovery state needs.
/// Absence is `Ok(None)`; anything unreadable fails closed.
fn observe_delivery_slot(directory: &Path) -> Result<Option<ObservedDelivery>, &'static str> {
    let path = directory.join(DELIVERY_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            return Err(DELIVERY_FOLDER_PERMISSION_DENIED)
        }
        Err(_) => return Err(LINEAGE_DESTINATION_PACKAGE_INVALID),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(LINEAGE_DESTINATION_PACKAGE_INVALID);
    }
    let bytes = read_bounded(&path).map_err(|_| LINEAGE_DESTINATION_PACKAGE_INVALID)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| LINEAGE_DESTINATION_PACKAGE_INVALID)?;
    let envelope: JsonValue =
        serde_json::from_str(text).map_err(|_| LINEAGE_DESTINATION_PACKAGE_INVALID)?;
    let object = envelope
        .as_object()
        .ok_or(LINEAGE_DESTINATION_PACKAGE_INVALID)?;
    let object_id = object
        .get("objectId")
        .and_then(JsonValue::as_str)
        .ok_or(LINEAGE_DESTINATION_PACKAGE_INVALID)?;
    validate_delivery_envelope(text, object_id).map_err(|_| LINEAGE_DESTINATION_PACKAGE_INVALID)?;
    let field = |key: &str| {
        object
            .get(key)
            .and_then(JsonValue::as_str)
            .ok_or(LINEAGE_DESTINATION_PACKAGE_INVALID)
    };
    let head_bytes = base64_decode_exact(field("headBytesBase64")?)?;
    if head_bytes.len() > MAX_LOCAL_HEAD_BYTES || sha256_hex(&head_bytes) != field("headSha256Hex")?
    {
        return Err(LINEAGE_DESTINATION_PACKAGE_INVALID);
    }
    let revision_bytes = base64_decode_exact(field("revisionBytesBase64")?)?;
    if revision_bytes.len() > MAX_LOCAL_REVISION_BYTES
        || sha256_hex(&revision_bytes) != field("revisionBlobSha256Hex")?
    {
        return Err(LINEAGE_DESTINATION_PACKAGE_INVALID);
    }
    let head: SyncHead =
        serde_json::from_slice(&head_bytes).map_err(|_| LINEAGE_DESTINATION_PACKAGE_INVALID)?;
    let canonical_head_text =
        canonical_head(&head).map_err(|_| LINEAGE_DESTINATION_PACKAGE_INVALID)?;
    if canonical_head_text.as_bytes() != head_bytes.as_slice()
        || head.schema != HEAD_SCHEMA
        || head.object_id != object_id
        || head.object_key != object_key_hex(object_id)
        || head.revision_blob_sha256 != field("revisionBlobSha256Hex")?
    {
        return Err(LINEAGE_DESTINATION_PACKAGE_INVALID);
    }
    let observed = ObservedDelivery {
        object_key: head.object_key,
        revision_id: head.revision_id,
        previous_revision_id: head.previous_revision_id,
        revision_blob_sha256_hex: head.revision_blob_sha256,
        delivery_sha256_hex: sha256_hex(&bytes),
        produced_at_iso: field("producedAtIso")?.to_string(),
    };
    validate_observed_delivery(&observed)?;
    Ok(Some(observed))
}

fn base64_decode_exact(value: &str) -> Result<Vec<u8>, &'static str> {
    if !is_base64(value) {
        return Err(LINEAGE_DESTINATION_PACKAGE_INVALID);
    }
    let mut out = Vec::with_capacity(value.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in value.bytes().take_while(|byte| *byte != b'=') {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(LINEAGE_DESTINATION_PACKAGE_INVALID),
        };
        buffer = (buffer << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    if base64_encode(&out) != value {
        return Err(LINEAGE_DESTINATION_PACKAGE_INVALID);
    }
    Ok(out)
}

fn classify_slot_posture(
    observed: Option<&ObservedDelivery>,
    object_key_hex: &str,
    lineage: &DeliveryLineage,
) -> LocalDeliverySlotPosture {
    match observed {
        None => LocalDeliverySlotPosture::Absent,
        Some(observed) if observed.object_key != object_key_hex => {
            LocalDeliverySlotPosture::OtherObject
        }
        Some(observed) => match resolve_tip(lineage, object_key_hex) {
            Some(tip) if tip.revision_id == observed.revision_id => {
                LocalDeliverySlotPosture::SameObjectCurrent
            }
            _ => LocalDeliverySlotPosture::SameObjectBehind,
        },
    }
}

#[allow(clippy::too_many_arguments)]
fn prepare_local_delivery_core_with_external(
    authorization_root: &Path,
    home: &Path,
    request: &Item11PrepareLocalDeliveryRequest,
    candidate_produced_at_iso: &str,
    updated_at_iso: &str,
    external_apply_tip: Option<&ExternalApplyTip>,
    fault: LocalFaultStage,
) -> Result<Item11PrepareLocalDeliveryResult, &'static str> {
    /* 1. Destination authorization, resolved exactly as the existing writer
     *    resolves it so both paths share one authorization contract. */
    if !is_sha256(&request.expected_destination_path_sha256_hex) {
        return Err(DELIVERY_FOLDER_CONFIG_MISMATCH);
    }
    if !is_accepted_timestamp(candidate_produced_at_iso) || !is_accepted_timestamp(updated_at_iso) {
        return Err(LOCAL_DELIVERY_PREPARATION_FAILED);
    }
    /* 2. Local revision authority, before anything can be mutated. */
    let verified = verify_local_revision(request)?;
    let binding = resolve_request_binding(
        authorization_root,
        home,
        request.configuration_absent,
        request.destination_configured_path_mode,
    )?;
    if binding.canonical_path_sha256_hex != request.expected_destination_path_sha256_hex
        || binding.configured_path_mode != request.destination_configured_path_mode
    {
        return Err(DELIVERY_FOLDER_CONFIG_MISMATCH);
    }
    let directory = revalidate_binding(&binding)?;
    let writer_fingerprint = sha256_hex(request.writer_sync_peer_id.as_bytes());

    /* 3. Lineage authority for this destination binding. */
    let mut lineage = match load_lineage(authorization_root, &binding, &writer_fingerprint)? {
        Some(lineage) => lineage,
        None => DeliveryLineage::empty(&binding, &writer_fingerprint, updated_at_iso),
    };

    /* 4. The destination slot is evidence, never authority. */
    let observed = observe_delivery_slot(&directory)?;
    let slot_posture = classify_slot_posture(observed.as_ref(), &verified.object_key_hex, &lineage);

    /* 5. Resolve any unfinished operation before starting a new one. */
    let mut disposition = LocalDeliveryDisposition::New;
    match reconcile_pending(
        &lineage,
        observed.as_ref(),
        &verified.object_key_hex,
        &request.revision_id,
    )? {
        LineageRecovery::Clean => {}
        LineageRecovery::PromoteReady => {
            let observed = observed.as_ref().ok_or(LOCAL_DELIVERY_PREPARATION_FAILED)?;
            promote_pending(&mut lineage, observed, updated_at_iso)?;
            persist_lineage(authorization_root, &lineage, &binding, &writer_fingerprint)?;
            disposition = LocalDeliveryDisposition::RecoveredPending;
        }
        LineageRecovery::ResumeRetry => {}
    }
    /* A visible package for this object that no committed tip and no pending
     * intent accounts for has no admissible explanation, and the slot is
     * evidence rather than authority — it cannot license its own replacement.
     *
     * Two properties of the visible package are deliberately not consulted.
     * `previousRevisionId == null` says only that it began a chain, not that
     * the ledger ever knew of it, and exempting roots let an unrelated root
     * overwrite one already there. Matching the requested revision id is no
     * better: two writers can choose the same id, and pending intent is made
     * durable before any bytes become visible, so a slot with neither a tip nor
     * a pending intent cannot have come from a correct writer against this
     * ledger no matter what id it carries. What makes a slot safe to move past
     * is trusted lineage explaining it, and nothing else does. */
    if let (Some(observed), LocalDeliverySlotPosture::SameObjectBehind) =
        (observed.as_ref(), slot_posture)
    {
        let unexplained = resolve_tip(&lineage, &verified.object_key_hex)
            .is_none_or(|tip| tip.revision_id != observed.revision_id)
            && lineage.pending.is_none();
        if unexplained {
            return Err(LOCAL_DELIVERY_SLOT_AHEAD);
        }
    }

    /* 6. Lineage step: parent and producedAtIso come only from the ledger. */
    let plan = begin_pending_with_external(
        &lineage,
        &verified.object_key_hex,
        &request.revision_id,
        &verified.revision_blob_sha256_hex,
        candidate_produced_at_iso,
        external_apply_tip,
    )?;
    if disposition != LocalDeliveryDisposition::RecoveredPending {
        disposition = match plan.disposition {
            LineageDisposition::NewRevision => LocalDeliveryDisposition::New,
            LineageDisposition::ResumedPending => LocalDeliveryDisposition::ResumedPending,
            LineageDisposition::CommittedReplay => LocalDeliveryDisposition::CommittedReplay,
        };
    }

    /* 7. Head, built entirely from verified local authority. */
    let head = SyncHead {
        schema: HEAD_SCHEMA.to_string(),
        object_id: request.object_id.clone(),
        object_key: verified.head_object_key_hex.clone(),
        revision_id: request.revision_id.clone(),
        payload_sha256: verified.payload_sha256_hex.clone(),
        revision_blob_sha256: verified.revision_blob_sha256_hex.clone(),
        writer_sync_peer_id: request.writer_sync_peer_id.clone(),
        previous_revision_id: plan.previous_revision_id.clone(),
        source_updated_at_iso: request.source_updated_at_iso.clone(),
    };
    let head_text = canonical_head(&head).map_err(|_| LOCAL_DELIVERY_HEAD_INVALID)?;
    let head_bytes = head_text.as_bytes();
    if head_bytes.is_empty() || head_bytes.len() > MAX_LOCAL_HEAD_BYTES {
        return Err(LOCAL_DELIVERY_HEAD_INVALID);
    }
    let head_sha256_hex = sha256_hex(head_bytes);

    /* 8. The existing eight-key envelope, canonicalized exactly as the accepted
     *    producer emits it. */
    let envelope = serde_json::json!({
        "schema": DELIVERY_SCHEMA,
        "deliverySchemaVersion": DELIVERY_SCHEMA_VERSION,
        "objectId": request.object_id,
        "headBytesBase64": base64_encode(head_bytes),
        "headSha256Hex": head_sha256_hex,
        "revisionBytesBase64": base64_encode(request.revision_blob_text.as_bytes()),
        "revisionBlobSha256Hex": verified.revision_blob_sha256_hex,
        "producedAtIso": plan.produced_at_iso,
    });
    let delivery_json = canonical_value(&envelope).map_err(|_| LOCAL_DELIVERY_ENVELOPE_INVALID)?;
    let delivery_bytes = delivery_json.as_bytes();
    if delivery_bytes.len() > MAX_DELIVERY_BYTES {
        return Err(LOCAL_DELIVERY_ENVELOPE_INVALID);
    }
    validate_delivery_envelope(&delivery_json, &request.object_id)
        .map_err(|_| LOCAL_DELIVERY_ENVELOPE_INVALID)?;
    let delivery_sha256_hex = sha256_hex(delivery_bytes);

    /* 9-10. Pending intent is durable BEFORE any new bytes become visible. */
    let recorded = record_pending(
        &mut lineage,
        &plan,
        &verified.revision_blob_sha256_hex,
        &delivery_sha256_hex,
        updated_at_iso,
    )?;
    if recorded {
        persist_lineage(authorization_root, &lineage, &binding, &writer_fingerprint)?;
    }
    if fault == LocalFaultStage::AfterPendingBeforeDelivery {
        return Err(LOCAL_DELIVERY_PREPARATION_FAILED);
    }

    /* 11. VISIBILITY COMMIT POINT: the existing authorized destination writer
     *     performs the atomic rename. Its guards are reused, never re-derived. */
    write_delivery_bytes(&binding, delivery_bytes, FaultStage::None)?;
    if fault == LocalFaultStage::AfterDeliveryBeforePromote {
        return Err(LOCAL_DELIVERY_PREPARATION_FAILED);
    }

    /* 12-13. Promote only against the bytes actually made visible. */
    if recorded {
        let written = ObservedDelivery {
            object_key: verified.object_key_hex.clone(),
            revision_id: request.revision_id.clone(),
            previous_revision_id: plan.previous_revision_id.clone(),
            revision_blob_sha256_hex: verified.revision_blob_sha256_hex.clone(),
            delivery_sha256_hex: delivery_sha256_hex.clone(),
            produced_at_iso: plan.produced_at_iso.clone(),
        };
        promote_pending(&mut lineage, &written, updated_at_iso)?;
        if fault == LocalFaultStage::DuringPromotePersist {
            return Err(LOCAL_DELIVERY_PREPARATION_FAILED);
        }
        persist_lineage(authorization_root, &lineage, &binding, &writer_fingerprint)?;
    }

    Ok(Item11PrepareLocalDeliveryResult {
        ok: true,
        verdict: "browser-delivery-prepared",
        object_id: request.object_id.clone(),
        revision_id: request.revision_id.clone(),
        previous_revision_id: plan.previous_revision_id,
        head_sha256_hex,
        revision_blob_sha256_hex: verified.revision_blob_sha256_hex,
        payload_sha256_hex: verified.payload_sha256_hex,
        delivery_sha256_hex,
        produced_at_iso: plan.produced_at_iso,
        delivery_byte_length: delivery_bytes.len(),
        destination_folder_leaf_name: binding.destination_folder_leaf_name,
        destination_path_sha256_hex: binding.canonical_path_sha256_hex,
        destination_configured_path_mode: binding.configured_path_mode,
        lineage_disposition: disposition,
        slot_posture,
        no_network: true,
    })
}

#[allow(dead_code)]
fn prepare_local_delivery_core(
    authorization_root: &Path,
    home: &Path,
    request: &Item11PrepareLocalDeliveryRequest,
    candidate_produced_at_iso: &str,
    updated_at_iso: &str,
    fault: LocalFaultStage,
) -> Result<Item11PrepareLocalDeliveryResult, &'static str> {
    prepare_local_delivery_core_with_external(
        authorization_root,
        home,
        request,
        candidate_produced_at_iso,
        updated_at_iso,
        None,
        fault,
    )
}

/// Seconds-precision UTC stamp, minted natively so the timestamp authority
/// never crosses the JS boundary.
fn local_now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = crate::synthetic_marker::civil_from_days_pub(now.div_euclid(86_400));
    let seconds = now.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

async fn resolve_external_apply_tip(
    db_instances: &DbInstances,
    object_id: &str,
) -> Result<Option<ExternalApplyTip>, String> {
    let pool = {
        let instances = db_instances.0.read().await;
        match instances.get(DB_URL) {
            Some(DbPool::Sqlite(pool)) => pool.clone(),
            _ => return Err(LOCAL_DELIVERY_PREPARATION_FAILED.to_string()),
        }
    };
    let state_rows = sqlx::query(
        "SELECT DISTINCT last_applied_revision_id, last_applied_revision_blob_sha256 FROM sync_object_state WHERE object_id = ? AND last_applied_revision_id IS NOT NULL",
    )
    .bind(object_id)
    .fetch_all(&pool)
    .await
    .map_err(|_| LOCAL_DELIVERY_PREPARATION_FAILED.to_string())?;
    if state_rows.is_empty() {
        return Ok(None);
    }
    if state_rows.len() != 1 {
        return Err(LINEAGE_UNRESOLVED.to_string());
    }
    let revision_id: String = state_rows[0]
        .try_get("last_applied_revision_id")
        .map_err(|_| LOCAL_DELIVERY_PREPARATION_FAILED.to_string())?;
    let revision_blob_sha256_hex: String = state_rows[0]
        .try_get::<Option<String>, _>("last_applied_revision_blob_sha256")
        .map_err(|_| LOCAL_DELIVERY_PREPARATION_FAILED.to_string())?
        .ok_or_else(|| LINEAGE_UNRESOLVED.to_string())?;
    if !is_accepted_revision_id(&revision_id) || !is_sha256(&revision_blob_sha256_hex) {
        return Err(LINEAGE_UNRESOLVED.to_string());
    }
    let observation_rows = sqlx::query(
        "SELECT DISTINCT parent_revision_id, revision_blob_sha256_hex FROM sync_inbound_revision_observations WHERE object_id = ? AND revision_id = ? AND admission_disposition = 'accepted-linear' AND apply_state = 'not-applied'",
    )
    .bind(object_id)
    .bind(&revision_id)
    .fetch_all(&pool)
    .await
    .map_err(|_| LOCAL_DELIVERY_PREPARATION_FAILED.to_string())?;
    if observation_rows.len() != 1 {
        return Err(LINEAGE_UNRESOLVED.to_string());
    }
    let previous_revision_id: Option<String> = observation_rows[0]
        .try_get("parent_revision_id")
        .map_err(|_| LOCAL_DELIVERY_PREPARATION_FAILED.to_string())?;
    let observation_blob_hash: String = observation_rows[0]
        .try_get("revision_blob_sha256_hex")
        .map_err(|_| LOCAL_DELIVERY_PREPARATION_FAILED.to_string())?;
    if previous_revision_id
        .as_deref()
        .is_some_and(|value| !is_accepted_revision_id(value))
        || observation_blob_hash != revision_blob_sha256_hex
    {
        return Err(LINEAGE_UNRESOLVED.to_string());
    }
    Ok(Some(ExternalApplyTip {
        revision_id,
        previous_revision_id,
        revision_blob_sha256_hex,
    }))
}

#[tauri::command]
pub async fn h2o_item11_prepare_local_delivery(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    request: Item11PrepareLocalDeliveryRequest,
) -> Result<Item11PrepareLocalDeliveryResult, String> {
    /* O1-T19: same native gate as the delivery command above. */
    crate::p01_generation_gate::require_p01_mutation_permitted(&db_instances).await?;
    let root = authorization_root(&app)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|_| DELIVERY_FOLDER_UNAVAILABLE.to_string())?;
    let now = local_now_iso();
    let external_apply_tip = resolve_external_apply_tip(&db_instances, &request.object_id).await?;
    prepare_local_delivery_core_with_external(
        &root,
        &home,
        &request,
        &now,
        &now,
        external_apply_tip.as_ref(),
        LocalFaultStage::None,
    )
    .map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let id = NEXT_TEST.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("h2o-item11-{label}-{}-{id}", std::process::id()));
            fs::create_dir_all(&path).expect("create test root");
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn envelope(object_id: &str) -> String {
        serde_json::json!({
            "deliverySchemaVersion": 1,
            "headBytesBase64": "e30=",
            "headSha256Hex": "a".repeat(64),
            "objectId": object_id,
            "producedAtIso": "2026-08-02T12:00:00.000Z",
            "revisionBlobSha256Hex": "b".repeat(64),
            "revisionBytesBase64": "e30=",
            "schema": DELIVERY_SCHEMA
        })
        .to_string()
    }

    fn authorized_fixture(label: &str) -> (TestRoot, PathBuf, AuthorizationBinding) {
        let root = TestRoot::new(label);
        let directory = root.0.join("selected");
        fs::create_dir(&directory).expect("create selected directory");
        let binding = binding_from_directory(&directory, ConfiguredPathMode::Absolute)
            .expect("authorize directory");
        (root, directory, binding)
    }

    fn old_delivery(directory: &Path) -> PathBuf {
        let final_path = directory.join(DELIVERY_FILE);
        fs::write(&final_path, b"preserved previous delivery").expect("write previous");
        final_path
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn persisted_authorization_validation_is_read_only_and_rehydrates_exact_binding() {
        let (root, directory, binding) = authorized_fixture("read-only-rehydrate");
        let authority = root.0.join("authority");
        persist_binding(&authority, &binding).expect("persist authorization");
        let canonical_authority = fs::canonicalize(&authority).unwrap();
        let authorization_path = authorization_paths(&canonical_authority).0;
        let authorization_before = fs::read(&authorization_path).unwrap();
        let directory_before = fs::read_dir(&directory).unwrap().count();
        let request = Item11ValidateDeliveryAuthorizationRequest {
            expected_destination_path_sha256_hex: binding.canonical_path_sha256_hex.clone(),
            destination_configured_path_mode: ConfiguredPathMode::Absolute,
        };

        let result = validate_delivery_authorization_core(&authority, &request)
            .expect("valid persisted authorization rehydrates");

        assert!(result.ok);
        assert_eq!(result.verdict, "delivery-authorization-validated");
        assert_eq!(result.status, "authorized");
        assert_eq!(
            result.destination_folder_leaf_name,
            binding.destination_folder_leaf_name
        );
        assert_eq!(
            result.destination_path_sha256_hex,
            binding.canonical_path_sha256_hex
        );
        assert_eq!(
            result.destination_configured_path_mode,
            ConfiguredPathMode::Absolute
        );
        assert!(result.read_only);
        assert!(result.no_network);
        assert_eq!(fs::read(&authorization_path).unwrap(), authorization_before);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), directory_before);
        assert!(!directory.join(DELIVERY_FILE).exists());
        assert!(!directory.join(TEMPORARY_FILE).exists());
    }

    #[test]
    fn missing_persisted_authorization_validation_stays_fail_closed() {
        let root = TestRoot::new("read-only-missing");
        let authority = root.0.join("authority");
        fs::create_dir_all(&authority).unwrap();
        let request = Item11ValidateDeliveryAuthorizationRequest {
            expected_destination_path_sha256_hex: "a".repeat(64),
            destination_configured_path_mode: ConfiguredPathMode::Absolute,
        };

        assert_eq!(
            validate_delivery_authorization_core(&authority, &request).unwrap_err(),
            DELIVERY_FOLDER_NOT_CONFIGURED
        );
        assert_eq!(fs::read_dir(&authority).unwrap().count(), 0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn persisted_authorization_validation_rejects_config_and_physical_mismatch() {
        let (root, directory, binding) = authorized_fixture("read-only-mismatch");
        let authority = root.0.join("authority");
        persist_binding(&authority, &binding).expect("persist authorization");
        let authorization_before =
            fs::read(authorization_paths(&fs::canonicalize(&authority).unwrap()).0).unwrap();
        let wrong_config = Item11ValidateDeliveryAuthorizationRequest {
            expected_destination_path_sha256_hex: "f".repeat(64),
            destination_configured_path_mode: ConfiguredPathMode::Absolute,
        };
        assert_eq!(
            validate_delivery_authorization_core(&authority, &wrong_config).unwrap_err(),
            DELIVERY_FOLDER_CONFIG_MISMATCH
        );

        fs::remove_dir(&directory).unwrap();
        fs::create_dir(&directory).unwrap();
        let matching_config = Item11ValidateDeliveryAuthorizationRequest {
            expected_destination_path_sha256_hex: binding.canonical_path_sha256_hex,
            destination_configured_path_mode: ConfiguredPathMode::Absolute,
        };
        assert_eq!(
            validate_delivery_authorization_core(&authority, &matching_config).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );
        assert_eq!(
            fs::read(authorization_paths(&fs::canonicalize(&authority).unwrap()).0).unwrap(),
            authorization_before,
            "read-only validation never repairs or replaces the authority"
        );
    }

    #[test]
    fn valid_directory_inside_home_is_authorized() {
        let root = TestRoot::new("inside-home");
        let home = root.0.join("home");
        let directory = home.join("Shared Sync");
        fs::create_dir_all(&directory).unwrap();
        let binding = binding_from_directory(&directory, ConfiguredPathMode::Relative).unwrap();
        assert_eq!(binding.destination_folder_leaf_name, "Shared Sync");
        assert_eq!(binding.configured_path_mode, ConfiguredPathMode::Relative);
    }

    #[test]
    fn valid_directory_outside_home_is_authorized() {
        let (_root, directory, binding) = authorized_fixture("outside-home");
        assert_eq!(
            PathBuf::from(binding.canonical_path),
            fs::canonicalize(directory).unwrap()
        );
    }

    #[test]
    fn relative_path_is_rejected_at_authorization_boundary() {
        assert_eq!(
            validate_directory(Path::new("relative/folder"), None, current_uid()).unwrap_err(),
            DELIVERY_FOLDER_INVALID
        );
    }

    #[test]
    fn empty_nul_root_and_overlong_paths_are_rejected() {
        assert_eq!(path_text(Path::new("")), Err(DELIVERY_FOLDER_INVALID));
        assert_eq!(path_text(Path::new("/")), Err(DELIVERY_FOLDER_INVALID));
        assert_eq!(
            path_text(Path::new("/tmp/a\0b")),
            Err(DELIVERY_FOLDER_INVALID)
        );
        let long = format!("/tmp/{}", "x".repeat(MAX_PATH_BYTES));
        assert_eq!(path_text(Path::new(&long)), Err(DELIVERY_FOLDER_INVALID));
    }

    #[test]
    fn traversal_component_is_rejected() {
        assert_eq!(
            path_text(Path::new("/tmp/item11/../escape")),
            Err(DELIVERY_FOLDER_INVALID)
        );
    }

    #[cfg(unix)]
    #[test]
    fn destination_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let root = TestRoot::new("symlink");
        let real = root.0.join("real");
        let link = root.0.join("link");
        fs::create_dir(&real).unwrap();
        symlink(&real, &link).unwrap();
        assert_eq!(
            validate_directory(&link, None, current_uid()).unwrap_err(),
            DELIVERY_FOLDER_SYMLINK_REJECTED
        );
    }

    #[cfg(unix)]
    #[test]
    fn replaced_destination_inode_is_rejected() {
        let (_root, directory, binding) = authorized_fixture("replaced");
        fs::remove_dir(&directory).unwrap();
        fs::create_dir(&directory).unwrap();
        assert_eq!(
            revalidate_binding(&binding),
            Err(DELIVERY_FOLDER_MOVED_OR_REPLACED)
        );
    }

    #[test]
    fn regular_file_is_not_a_directory() {
        let root = TestRoot::new("regular-file");
        let file = root.0.join("file");
        fs::write(&file, b"x").unwrap();
        assert_eq!(
            validate_directory(&file, None, current_uid()).unwrap_err(),
            DELIVERY_FOLDER_INVALID
        );
    }

    #[test]
    fn missing_directory_is_unavailable() {
        let root = TestRoot::new("missing");
        assert_eq!(
            validate_directory(&root.0.join("missing"), None, current_uid()).unwrap_err(),
            DELIVERY_FOLDER_UNAVAILABLE
        );
    }

    #[cfg(unix)]
    #[test]
    fn non_writable_directory_is_rejected() {
        let root = TestRoot::new("not-writable");
        let directory = root.0.join("directory");
        fs::create_dir(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o500)).unwrap();
        assert_eq!(
            validate_directory(&directory, None, current_uid()).unwrap_err(),
            DELIVERY_FOLDER_PERMISSION_DENIED
        );
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn wrong_owner_is_rejected_without_chown() {
        let root = TestRoot::new("owner");
        let directory = root.0.join("directory");
        fs::create_dir(&directory).unwrap();
        assert_eq!(
            validate_directory(&directory, None, current_uid().wrapping_add(1)).unwrap_err(),
            DELIVERY_FOLDER_OWNER_MISMATCH
        );
    }

    #[test]
    fn preexisting_temporary_file_preserves_previous_delivery() {
        let (_root, directory, binding) = authorized_fixture("temp-exists");
        let final_path = old_delivery(&directory);
        fs::write(directory.join(TEMPORARY_FILE), b"unowned temp").unwrap();
        assert_eq!(
            write_delivery_bytes(&binding, b"new", FaultStage::None),
            Err(DELIVERY_TEMP_EXISTS)
        );
        assert_eq!(
            fs::read(final_path).unwrap(),
            b"preserved previous delivery"
        );
    }

    #[test]
    fn temporary_write_failure_preserves_previous_delivery() {
        let (_root, directory, binding) = authorized_fixture("temp-write");
        let final_path = old_delivery(&directory);
        assert_eq!(
            write_delivery_bytes(&binding, b"new", FaultStage::TempWrite),
            Err(DELIVERY_TEMP_WRITE_FAILED)
        );
        assert_eq!(
            fs::read(final_path).unwrap(),
            b"preserved previous delivery"
        );
        assert!(!directory.join(TEMPORARY_FILE).exists());
    }

    #[test]
    fn temporary_verification_failure_preserves_previous_delivery() {
        let (_root, directory, binding) = authorized_fixture("temp-verify");
        let final_path = old_delivery(&directory);
        assert_eq!(
            write_delivery_bytes(&binding, b"new", FaultStage::TempVerification),
            Err(DELIVERY_TEMP_VERIFICATION_FAILED)
        );
        assert_eq!(
            fs::read(final_path).unwrap(),
            b"preserved previous delivery"
        );
        assert!(!directory.join(TEMPORARY_FILE).exists());
    }

    #[test]
    fn atomic_replace_failure_preserves_previous_delivery() {
        let (_root, directory, binding) = authorized_fixture("rename");
        let final_path = old_delivery(&directory);
        assert_eq!(
            write_delivery_bytes(&binding, b"new", FaultStage::AtomicReplace),
            Err(DELIVERY_ATOMIC_REPLACE_FAILED)
        );
        assert_eq!(
            fs::read(final_path).unwrap(),
            b"preserved previous delivery"
        );
        assert!(!directory.join(TEMPORARY_FILE).exists());
    }

    #[test]
    fn final_verification_failure_restores_previous_delivery() {
        let (_root, directory, binding) = authorized_fixture("final-verify");
        let final_path = old_delivery(&directory);
        assert_eq!(
            write_delivery_bytes(&binding, b"new", FaultStage::FinalVerification),
            Err(DELIVERY_FINAL_VERIFICATION_FAILED)
        );
        assert_eq!(
            fs::read(final_path).unwrap(),
            b"preserved previous delivery"
        );
        assert!(!directory.join(TEMPORARY_FILE).exists());
    }

    #[test]
    fn successful_atomic_replacement_is_verified() {
        let (_root, directory, binding) = authorized_fixture("success");
        let final_path = old_delivery(&directory);
        write_delivery_bytes(&binding, b"verified replacement", FaultStage::None).unwrap();
        assert_eq!(fs::read(final_path).unwrap(), b"verified replacement");
        assert!(!directory.join(TEMPORARY_FILE).exists());
    }

    #[test]
    fn authorization_hash_mismatch_fails_before_write() {
        let (root, directory, binding) = authorized_fixture("mismatch");
        let auth_root = root.0.join("authorization");
        persist_binding(&auth_root, &binding).unwrap();
        let request = Item11PrepareDeliveryRequest {
            delivery_json: envelope("object-a"),
            object_id: "object-a".into(),
            expected_destination_path_sha256_hex: "f".repeat(64),
            destination_configured_path_mode: ConfiguredPathMode::Absolute,
            configuration_absent: false,
        };
        assert_eq!(
            prepare_delivery_core(&auth_root, &root.0, &request, FaultStage::None).map(|_| ()),
            Err(DELIVERY_FOLDER_CONFIG_MISMATCH)
        );
        assert!(!directory.join(DELIVERY_FILE).exists());
    }

    #[test]
    fn malformed_delivery_envelope_is_rejected() {
        assert_eq!(
            validate_delivery_envelope("{}", "object-a"),
            Err(DELIVERY_ENVELOPE_INVALID)
        );
        assert_eq!(
            validate_delivery_envelope(&envelope("object-a"), "object-b"),
            Err(DELIVERY_ENVELOPE_INVALID)
        );
    }

    #[test]
    fn successful_result_contains_only_redacted_destination_evidence() {
        let (root, directory, binding) = authorized_fixture("redaction");
        let auth_root = root.0.join("authorization");
        persist_binding(&auth_root, &binding).unwrap();
        let request = Item11PrepareDeliveryRequest {
            delivery_json: envelope("object-a"),
            object_id: "object-a".into(),
            expected_destination_path_sha256_hex: binding.canonical_path_sha256_hex.clone(),
            destination_configured_path_mode: ConfiguredPathMode::Absolute,
            configuration_absent: false,
        };
        let result =
            prepare_delivery_core(&auth_root, &root.0, &request, FaultStage::None).unwrap();
        let rendered = serde_json::to_string(&result).unwrap();
        assert!(!rendered.contains(directory.to_str().unwrap()));
        assert!(rendered.contains("destinationFolderLeafName"));
        assert!(rendered.contains("destinationPathSha256Hex"));
    }

    #[test]
    fn absent_configuration_uses_only_fixed_home_default() {
        let root = TestRoot::new("default");
        let home = root.0.join("home");
        fs::create_dir(&home).unwrap();
        let expected_path = home.join(DEFAULT_FOLDER);
        fs::create_dir(&expected_path).unwrap();
        let expected_hash = sha256_hex(
            fs::canonicalize(&expected_path)
                .unwrap()
                .to_str()
                .unwrap()
                .as_bytes(),
        );
        let request = Item11PrepareDeliveryRequest {
            delivery_json: envelope("object-a"),
            object_id: "object-a".into(),
            expected_destination_path_sha256_hex: expected_hash,
            destination_configured_path_mode: ConfiguredPathMode::Relative,
            configuration_absent: true,
        };
        let result = prepare_delivery_core(
            &root.0.join("authorization"),
            &home,
            &request,
            FaultStage::None,
        )
        .unwrap();
        assert_eq!(result.destination_folder_leaf_name, DEFAULT_FOLDER);
        assert!(expected_path.join(DELIVERY_FILE).is_file());
    }

    /* --------------------------------------------------------------------
     * Local-delivery lineage ledger (Step 2A).
     * ----------------------------------------------------------------- */

    const WRITER_FP: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const OBJECT_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OBJECT_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const NOW: &str = "2026-08-08T12:00:00.000Z";
    /// A well-formed volume UUID that is not the one any test directory lives
    /// on, so "different volume" is expressed without needing a second volume.
    const FOREIGN_VOLUME: &str = "0f0e0d0c-0b0a-0908-0706-050403020100";

    fn blob(seed: &str) -> String {
        sha256_hex(format!("revision-blob:{seed}").as_bytes())
    }

    fn delivery(seed: &str) -> String {
        sha256_hex(format!("delivery-bytes:{seed}").as_bytes())
    }

    fn lineage_fixture(label: &str) -> (TestRoot, PathBuf, AuthorizationBinding, DeliveryLineage) {
        let (root, _directory, binding) = authorized_fixture(label);
        let authority = root.0.join("authority");
        let lineage = DeliveryLineage::empty(&binding, WRITER_FP, NOW);
        (root, authority, binding, lineage)
    }

    /// Drives one full visible-delivery cycle: plan, record pending, promote.
    fn make_visible(
        lineage: &mut DeliveryLineage,
        object_key: &str,
        revision_id: &str,
        candidate_produced_at: &str,
    ) -> LineagePlan {
        let revision_blob = blob(revision_id);
        let plan = begin_pending(
            lineage,
            object_key,
            revision_id,
            &revision_blob,
            candidate_produced_at,
        )
        .expect("plan lineage step");
        let delivery_sha = delivery(revision_id);
        record_pending(lineage, &plan, &revision_blob, &delivery_sha, NOW).expect("record pending");
        let observed = ObservedDelivery {
            object_key: object_key.into(),
            revision_id: revision_id.into(),
            previous_revision_id: plan.previous_revision_id.clone(),
            revision_blob_sha256_hex: revision_blob,
            delivery_sha256_hex: delivery_sha,
            produced_at_iso: plan.produced_at_iso.clone(),
        };
        promote_pending(lineage, &observed, NOW).expect("promote pending");
        plan
    }

    #[test]
    fn lineage_first_revision_of_an_object_has_no_parent() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-a-r1");
        let plan = make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        assert_eq!(plan.previous_revision_id, None);
        assert_eq!(plan.disposition, LineageDisposition::NewRevision);
        assert_eq!(resolve_tip(&lineage, OBJECT_A).unwrap().revision_id, "a-r1");
    }

    #[test]
    fn remote_apply_tip_is_the_parent_when_no_local_publication_tip_exists() {
        let (_root, _authority, _binding, lineage) = lineage_fixture("external-apply-parent");
        let remote = ExternalApplyTip {
            revision_id: "remote-r1".into(),
            previous_revision_id: None,
            revision_blob_sha256_hex: blob("remote-r1"),
        };
        let plan = begin_pending_with_external(
            &lineage,
            OBJECT_A,
            "local-r2",
            &blob("local-r2"),
            NOW,
            Some(&remote),
        )
        .unwrap();
        assert_eq!(plan.previous_revision_id.as_deref(), Some("remote-r1"));
    }

    #[test]
    fn newest_comparable_provenance_tip_wins_and_incomparable_tips_fail() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("external-newest");
        make_visible(&mut lineage, OBJECT_A, "local-r1", NOW);
        let descendant = ExternalApplyTip {
            revision_id: "remote-r2".into(),
            previous_revision_id: Some("local-r1".into()),
            revision_blob_sha256_hex: blob("remote-r2"),
        };
        let plan = begin_pending_with_external(
            &lineage,
            OBJECT_A,
            "local-r3",
            &blob("local-r3"),
            NOW,
            Some(&descendant),
        )
        .unwrap();
        assert_eq!(plan.previous_revision_id.as_deref(), Some("remote-r2"));

        let fork = ExternalApplyTip {
            revision_id: "remote-fork".into(),
            previous_revision_id: Some("other-root".into()),
            revision_blob_sha256_hex: blob("remote-fork"),
        };
        assert_eq!(
            begin_pending_with_external(
                &lineage,
                OBJECT_A,
                "local-r3",
                &blob("local-r3"),
                NOW,
                Some(&fork),
            ),
            Err(LINEAGE_UNRESOLVED)
        );
    }

    #[test]
    fn lineage_second_object_starts_its_own_chain() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-b-r1");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        let plan = make_visible(&mut lineage, OBJECT_B, "b-r1", NOW);
        assert_eq!(plan.previous_revision_id, None);
        assert_eq!(resolve_tip(&lineage, OBJECT_A).unwrap().revision_id, "a-r1");
        assert_eq!(resolve_tip(&lineage, OBJECT_B).unwrap().revision_id, "b-r1");
    }

    #[test]
    fn lineage_interleaved_object_does_not_contaminate_the_parent() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-interleaved");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        make_visible(&mut lineage, OBJECT_B, "b-r1", NOW);
        let plan = make_visible(&mut lineage, OBJECT_A, "a-r2", NOW);
        assert_eq!(plan.previous_revision_id.as_deref(), Some("a-r1"));
    }

    #[test]
    fn lineage_four_step_interleaving_keeps_independent_tips() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-four-step");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        make_visible(&mut lineage, OBJECT_B, "b-r1", NOW);
        let b2 = make_visible(&mut lineage, OBJECT_B, "b-r2", NOW);
        let a2 = make_visible(&mut lineage, OBJECT_A, "a-r2", NOW);
        assert_eq!(a2.previous_revision_id.as_deref(), Some("a-r1"));
        assert_eq!(b2.previous_revision_id.as_deref(), Some("b-r1"));
        assert_eq!(resolve_tip(&lineage, OBJECT_A).unwrap().revision_id, "a-r2");
        assert_eq!(resolve_tip(&lineage, OBJECT_B).unwrap().revision_id, "b-r2");
    }

    #[test]
    fn lineage_ignores_the_package_occupying_the_destination_slot() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-slot");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        make_visible(&mut lineage, OBJECT_B, "b-r1", NOW);
        /* The slot now holds B, yet A's parent still comes from tips[A]. */
        let plan = begin_pending(&lineage, OBJECT_A, "a-r2", &blob("a-r2"), NOW).unwrap();
        assert_eq!(plan.previous_revision_id.as_deref(), Some("a-r1"));
    }

    #[test]
    fn lineage_survives_deletion_of_the_delivery_file() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-deleted-file");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        /* Slot emptied externally: no pending intent exists, so the committed
         * tip remains authoritative and lineage is not reset to null. */
        assert_eq!(
            reconcile_pending(&lineage, None, OBJECT_A, "a-r2").unwrap(),
            LineageRecovery::Clean
        );
        let plan = begin_pending(&lineage, OBJECT_A, "a-r2", &blob("a-r2"), NOW).unwrap();
        assert_eq!(plan.previous_revision_id.as_deref(), Some("a-r1"));
    }

    #[test]
    fn lineage_replaying_the_committed_tip_neither_advances_nor_restamps() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-replay");
        make_visible(&mut lineage, OBJECT_A, "a-r1", "2026-08-08T09:00:00.000Z");
        let before = lineage.clone();
        let plan = begin_pending(
            &lineage,
            OBJECT_A,
            "a-r1",
            &blob("a-r1"),
            "2026-08-08T23:59:59.000Z",
        )
        .unwrap();
        assert_eq!(plan.disposition, LineageDisposition::CommittedReplay);
        assert_eq!(plan.previous_revision_id, None);
        assert_eq!(plan.produced_at_iso, "2026-08-08T09:00:00.000Z");
        let recorded =
            record_pending(&mut lineage, &plan, &blob("a-r1"), &delivery("a-r1"), NOW).unwrap();
        assert!(!recorded, "a committed replay must not open pending intent");
        assert_eq!(lineage, before, "a replay must not mutate the ledger");
    }

    #[test]
    fn lineage_pending_retry_reuses_parent_and_timestamp_without_forking() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-retry");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        let first = begin_pending(
            &lineage,
            OBJECT_A,
            "a-r2",
            &blob("a-r2"),
            "2026-08-08T10:00:00.000Z",
        )
        .unwrap();
        record_pending(&mut lineage, &first, &blob("a-r2"), &delivery("a-r2"), NOW).unwrap();
        let retry = begin_pending(
            &lineage,
            OBJECT_A,
            "a-r2",
            &blob("a-r2"),
            "2026-08-08T23:59:59.000Z",
        )
        .unwrap();
        assert_eq!(retry.disposition, LineageDisposition::ResumedPending);
        assert_eq!(retry.previous_revision_id.as_deref(), Some("a-r1"));
        assert_eq!(retry.produced_at_iso, "2026-08-08T10:00:00.000Z");
        assert_eq!(
            retry.expected_delivery_sha256_hex.as_deref(),
            Some(delivery("a-r2").as_str())
        );
        assert_eq!(resolve_tip(&lineage, OBJECT_A).unwrap().revision_id, "a-r1");
    }

    #[test]
    fn lineage_promotion_carries_the_pending_timestamp_verbatim() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-promote-stamp");
        let minted = "2026-08-08T08:15:00.000Z";
        let plan = begin_pending(&lineage, OBJECT_A, "a-r1", &blob("a-r1"), minted).unwrap();
        record_pending(&mut lineage, &plan, &blob("a-r1"), &delivery("a-r1"), NOW).unwrap();
        let observed = ObservedDelivery {
            object_key: OBJECT_A.into(),
            revision_id: "a-r1".into(),
            previous_revision_id: None,
            revision_blob_sha256_hex: blob("a-r1"),
            delivery_sha256_hex: delivery("a-r1"),
            produced_at_iso: minted.into(),
        };
        promote_pending(&mut lineage, &observed, NOW).unwrap();
        assert_eq!(
            resolve_tip(&lineage, OBJECT_A).unwrap().produced_at_iso,
            minted
        );
        /* And a later replay still reproduces the original timestamp. */
        let replay = begin_pending(
            &lineage,
            OBJECT_A,
            "a-r1",
            &blob("a-r1"),
            "2026-08-09T00:00:00.000Z",
        )
        .unwrap();
        assert_eq!(replay.produced_at_iso, minted);
    }

    #[test]
    fn lineage_different_request_while_pending_is_unresolved_fails_closed() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-unresolved");
        let plan = begin_pending(&lineage, OBJECT_A, "a-r1", &blob("a-r1"), NOW).unwrap();
        record_pending(&mut lineage, &plan, &blob("a-r1"), &delivery("a-r1"), NOW).unwrap();
        assert_eq!(
            reconcile_pending(&lineage, None, OBJECT_B, "b-r1").unwrap_err(),
            LINEAGE_UNRESOLVED
        );
        assert_eq!(
            begin_pending(&lineage, OBJECT_B, "b-r1", &blob("b-r1"), NOW).unwrap_err(),
            LINEAGE_UNRESOLVED
        );
    }

    #[test]
    fn lineage_pending_with_matching_visible_package_self_heals() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-self-heal");
        let plan = begin_pending(&lineage, OBJECT_A, "a-r1", &blob("a-r1"), NOW).unwrap();
        record_pending(&mut lineage, &plan, &blob("a-r1"), &delivery("a-r1"), NOW).unwrap();
        let observed = ObservedDelivery {
            object_key: OBJECT_A.into(),
            revision_id: "a-r1".into(),
            previous_revision_id: None,
            revision_blob_sha256_hex: blob("a-r1"),
            delivery_sha256_hex: delivery("a-r1"),
            produced_at_iso: plan.produced_at_iso.clone(),
        };
        assert_eq!(
            reconcile_pending(&lineage, Some(&observed), OBJECT_B, "b-r1").unwrap(),
            LineageRecovery::PromoteReady
        );
        promote_pending(&mut lineage, &observed, NOW).unwrap();
        assert!(lineage.pending.is_none());
        assert_eq!(resolve_tip(&lineage, OBJECT_A).unwrap().revision_id, "a-r1");
    }

    #[test]
    fn lineage_pending_retry_is_recognised_when_the_package_is_absent() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-retry-absent");
        let plan = begin_pending(&lineage, OBJECT_A, "a-r1", &blob("a-r1"), NOW).unwrap();
        record_pending(&mut lineage, &plan, &blob("a-r1"), &delivery("a-r1"), NOW).unwrap();
        assert_eq!(
            reconcile_pending(&lineage, None, OBJECT_A, "a-r1").unwrap(),
            LineageRecovery::ResumeRetry
        );
    }

    #[test]
    fn lineage_divergent_visible_package_never_promotes() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-divergent");
        let plan = begin_pending(&lineage, OBJECT_A, "a-r1", &blob("a-r1"), NOW).unwrap();
        record_pending(&mut lineage, &plan, &blob("a-r1"), &delivery("a-r1"), NOW).unwrap();
        let before = lineage.clone();
        let divergent = ObservedDelivery {
            object_key: OBJECT_A.into(),
            revision_id: "a-r1".into(),
            previous_revision_id: None,
            revision_blob_sha256_hex: blob("a-r1"),
            delivery_sha256_hex: delivery("tampered"),
            produced_at_iso: plan.produced_at_iso.clone(),
        };
        assert_eq!(
            promote_pending(&mut lineage, &divergent, NOW).unwrap_err(),
            LINEAGE_UNRESOLVED
        );
        assert_eq!(
            lineage, before,
            "a failed promotion must not mutate lineage"
        );
    }

    #[test]
    fn lineage_binding_path_hash_mismatch_fails_closed() {
        let (_root, _authority, binding, lineage) = lineage_fixture("lineage-path-hash");
        let mut foreign = binding.clone();
        foreign.canonical_path_sha256_hex = "c".repeat(64);
        assert_eq!(
            validate_lineage(&lineage, &foreign, WRITER_FP).unwrap_err(),
            LINEAGE_BINDING_MISMATCH
        );
    }

    #[test]
    fn lineage_binding_volume_inode_and_owner_mismatches_fail_closed() {
        let (_root, _authority, binding, lineage) = lineage_fixture("lineage-binding-fields");
        for mutate in [0usize, 1, 2, 3] {
            let mut foreign = binding.clone();
            match mutate {
                0 => foreign.volume_identity = FOREIGN_VOLUME.to_string(),
                1 => foreign.volume_identity_kind = "macos-volume-uuid".to_string(),
                2 => foreign.inode = binding.inode.wrapping_add(1),
                _ => foreign.owner_uid = binding.owner_uid.wrapping_add(1),
            }
            assert_eq!(
                validate_lineage(&lineage, &foreign, WRITER_FP).unwrap_err(),
                LINEAGE_BINDING_MISMATCH
            );
        }
    }

    #[test]
    fn lineage_writer_fingerprint_mismatch_fails_closed() {
        let (_root, _authority, binding, lineage) = lineage_fixture("lineage-writer");
        assert_eq!(
            validate_lineage(&lineage, &binding, &"9".repeat(64)).unwrap_err(),
            LINEAGE_BINDING_MISMATCH
        );
        assert_eq!(
            validate_lineage(&lineage, &binding, "not-a-fingerprint").unwrap_err(),
            LINEAGE_BINDING_MISMATCH
        );
    }

    /// Fills the ledger to exactly `MAX_LINEAGE_TIPS` tracked objects and
    /// returns the object key of one of them.
    fn saturate_tips(lineage: &mut DeliveryLineage) -> String {
        let mut first = String::new();
        for index in 0..MAX_LINEAGE_TIPS {
            let object_key = sha256_hex(format!("saturated-object-{index}").as_bytes());
            if index == 0 {
                first = object_key.clone();
            }
            lineage.tips.insert(
                object_key,
                LineageTip {
                    revision_id: format!("sat-{index}-r1"),
                    previous_revision_id: None,
                    revision_blob_sha256_hex: blob(&format!("sat-{index}-r1")),
                    delivery_sha256_hex: delivery(&format!("sat-{index}-r1")),
                    produced_at_iso: NOW.into(),
                },
            );
        }
        assert_eq!(lineage.tips.len(), MAX_LINEAGE_TIPS);
        first
    }

    #[test]
    fn lineage_at_capacity_refuses_a_new_object_before_any_pending_intent() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-cap-new");
        saturate_tips(&mut lineage);
        let before = lineage.clone();
        assert_eq!(
            begin_pending(&lineage, OBJECT_A, "a-r1", &blob("a-r1"), NOW).unwrap_err(),
            LINEAGE_TIP_LIMIT_EXCEEDED
        );
        assert!(lineage.pending.is_none(), "no pending intent may be opened");
        assert_eq!(lineage, before, "the refusal must not mutate the ledger");
    }

    #[test]
    fn lineage_at_capacity_still_advances_an_object_already_tracked() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-cap-existing");
        let tracked = saturate_tips(&mut lineage);
        let plan = begin_pending(&lineage, &tracked, "sat-0-r2", &blob("sat-0-r2"), NOW).unwrap();
        assert_eq!(plan.disposition, LineageDisposition::NewRevision);
        assert_eq!(plan.previous_revision_id.as_deref(), Some("sat-0-r1"));
        record_pending(
            &mut lineage,
            &plan,
            &blob("sat-0-r2"),
            &delivery("sat-0-r2"),
            NOW,
        )
        .unwrap();
        let observed = ObservedDelivery {
            object_key: tracked.clone(),
            revision_id: "sat-0-r2".into(),
            previous_revision_id: Some("sat-0-r1".into()),
            revision_blob_sha256_hex: blob("sat-0-r2"),
            delivery_sha256_hex: delivery("sat-0-r2"),
            produced_at_iso: plan.produced_at_iso.clone(),
        };
        promote_pending(&mut lineage, &observed, NOW).unwrap();
        assert_eq!(lineage.tips.len(), MAX_LINEAGE_TIPS);
        assert_eq!(
            resolve_tip(&lineage, &tracked).unwrap().revision_id,
            "sat-0-r2"
        );
    }

    #[test]
    fn lineage_at_capacity_still_replays_a_committed_revision() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-cap-replay");
        let tracked = saturate_tips(&mut lineage);
        let before = lineage.clone();
        let plan = begin_pending(&lineage, &tracked, "sat-0-r1", &blob("sat-0-r1"), NOW).unwrap();
        assert_eq!(plan.disposition, LineageDisposition::CommittedReplay);
        assert_eq!(plan.produced_at_iso, NOW);
        let recorded = record_pending(
            &mut lineage,
            &plan,
            &blob("sat-0-r1"),
            &delivery("sat-0-r1"),
            NOW,
        )
        .unwrap();
        assert!(!recorded);
        assert_eq!(lineage, before, "a replay at capacity must change nothing");
    }

    #[test]
    fn lineage_persisted_unpromotable_pending_at_capacity_is_rejected() {
        let (_root, authority, binding, mut lineage) = lineage_fixture("lineage-cap-persisted");
        saturate_tips(&mut lineage);
        lineage.pending = Some(LineagePending {
            object_key: OBJECT_A.into(),
            revision_id: "a-r1".into(),
            previous_revision_id: None,
            revision_blob_sha256_hex: blob("a-r1"),
            delivery_sha256_hex: delivery("a-r1"),
            produced_at_iso: NOW.into(),
        });
        assert_eq!(
            validate_lineage(&lineage, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_TIP_LIMIT_EXCEEDED
        );
        /* Such a ledger can neither be written nor read back. */
        assert_eq!(
            persist_lineage(&authority, &lineage, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_TIP_LIMIT_EXCEEDED
        );
        fs::create_dir_all(&authority).unwrap();
        let (final_path, _) = lineage_paths(
            &fs::canonicalize(&authority).unwrap(),
            &binding.canonical_path_sha256_hex,
        );
        write_ledger_bytes(&final_path, &serialize_lineage(&lineage).unwrap());
        assert_eq!(
            load_lineage(&authority, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_TIP_LIMIT_EXCEEDED
        );
    }

    /// Writes raw ledger bytes at the authority's mandated mode, bypassing the
    /// canonical writer so noncanonical encodings can be exercised.
    fn write_ledger_bytes(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).expect("write ledger bytes");
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).expect("set ledger mode");
    }

    fn canonical_ledger_on_disk(
        authority: &Path,
        binding: &AuthorizationBinding,
        lineage: &DeliveryLineage,
    ) -> PathBuf {
        persist_lineage(authority, lineage, binding, WRITER_FP).expect("persist ledger");
        let (final_path, _) = lineage_paths(
            &fs::canonicalize(authority).unwrap(),
            &binding.canonical_path_sha256_hex,
        );
        final_path
    }

    #[test]
    fn lineage_canonical_bytes_round_trip_exactly() {
        let (_root, authority, binding, mut lineage) = lineage_fixture("lineage-canonical");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        make_visible(&mut lineage, OBJECT_B, "b-r1", NOW);
        let final_path = canonical_ledger_on_disk(&authority, &binding, &lineage);
        let raw = fs::read(&final_path).unwrap();
        let parsed: DeliveryLineage = serde_json::from_slice(&raw).unwrap();
        assert_eq!(serialize_lineage(&parsed).unwrap(), raw);
        assert_eq!(
            load_lineage(&authority, &binding, WRITER_FP)
                .unwrap()
                .unwrap(),
            lineage
        );
    }

    #[test]
    fn lineage_duplicate_json_keys_are_rejected_by_the_canonical_byte_contract() {
        let (_root, authority, binding, mut lineage) = lineage_fixture("lineage-duplicate-keys");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        let plan = begin_pending(&lineage, OBJECT_A, "a-r2", &blob("a-r2"), NOW).unwrap();
        record_pending(&mut lineage, &plan, &blob("a-r2"), &delivery("a-r2"), NOW).unwrap();
        let final_path = canonical_ledger_on_disk(&authority, &binding, &lineage);
        let canonical = String::from_utf8(fs::read(&final_path).unwrap()).unwrap();

        /* Duplicated *struct* fields are already refused by the derived
         * Deserialize; duplicated *map* keys inside `tips` are not, because a
         * BTreeMap takes the last value. Both must be rejected, and each is
         * asserted against the mechanism that actually catches it. */
        let duplicated_schema = canonical.replacen(
            "{\"schema\":",
            "{\"schema\":\"h2o.round2.item11.delivery-lineage.v1\",\"schema\":",
            1,
        );
        let duplicated_tip_field = canonical.replacen(
            "{\"revisionId\":\"a-r1\"",
            "{\"revisionId\":\"decoy\",\"revisionId\":\"a-r1\"",
            1,
        );
        let duplicated_pending_field = canonical.replacen(
            "\"producedAtIso\":\"2026-08-08T12:00:00.000Z\"}}",
            "\"producedAtIso\":\"2026-08-08T00:00:00.000Z\",\"producedAtIso\":\"2026-08-08T12:00:00.000Z\"}}",
            1,
        );
        for (label, text) in [
            ("top-level schema", &duplicated_schema),
            ("nested tip revisionId", &duplicated_tip_field),
            ("pending producedAtIso", &duplicated_pending_field),
        ] {
            assert_ne!(text, &canonical, "{label} fixture must differ");
            assert!(
                serde_json::from_str::<DeliveryLineage>(text).is_err(),
                "{label} is a duplicated struct field and must fail at parse"
            );
            write_ledger_bytes(&final_path, text.as_bytes());
            assert_eq!(
                load_lineage(&authority, &binding, WRITER_FP).unwrap_err(),
                LINEAGE_MALFORMED,
                "{label} must be rejected"
            );
            assert_eq!(
                fs::read(&final_path).unwrap(),
                text.as_bytes(),
                "{label} must not be rewritten"
            );
        }

        /* A duplicated `tips` map key survives parsing with last-wins
         * semantics, so only the canonical-byte contract rejects it. */
        let object_a_entry = format!("\"{OBJECT_A}\":");
        let duplicated_tip_key = canonical.replacen(
            &object_a_entry,
            &format!(
                "\"{OBJECT_A}\":{{\"revisionId\":\"decoy\",\"previousRevisionId\":null,\
                 \"revisionBlobSha256Hex\":\"{}\",\"deliverySha256Hex\":\"{}\",\
                 \"producedAtIso\":\"{NOW}\"}},{object_a_entry}",
                blob("decoy"),
                delivery("decoy")
            ),
            1,
        );
        assert_ne!(duplicated_tip_key, canonical);
        let reparsed: DeliveryLineage = serde_json::from_str(&duplicated_tip_key)
            .expect("a duplicated map key parses with last-wins semantics");
        assert_eq!(
            reparsed.tips.get(OBJECT_A).unwrap().revision_id,
            "a-r1",
            "last-wins confirms serde alone cannot reject this"
        );
        write_ledger_bytes(&final_path, duplicated_tip_key.as_bytes());
        assert_eq!(
            load_lineage(&authority, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_MALFORMED,
            "the canonical-byte contract must reject a duplicated tips key"
        );
        assert_eq!(
            fs::read(&final_path).unwrap(),
            duplicated_tip_key.as_bytes(),
            "the ledger must not be rewritten"
        );
    }

    #[test]
    fn lineage_reformatted_ledger_is_rejected_and_left_untouched() {
        let (_root, authority, binding, mut lineage) = lineage_fixture("lineage-reformatted");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        let final_path = canonical_ledger_on_disk(&authority, &binding, &lineage);
        let pretty = serde_json::to_vec_pretty(&lineage).unwrap();
        assert_ne!(pretty, serialize_lineage(&lineage).unwrap());
        write_ledger_bytes(&final_path, &pretty);
        assert_eq!(
            load_lineage(&authority, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_MALFORMED
        );
        assert_eq!(fs::read(&final_path).unwrap(), pretty, "file untouched");
    }

    #[cfg(unix)]
    #[test]
    fn lineage_ledger_must_be_mode_0600_on_every_read() {
        let (_root, authority, binding, mut lineage) = lineage_fixture("lineage-mode");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        let final_path = canonical_ledger_on_disk(&authority, &binding, &lineage);
        let canonical = fs::read(&final_path).unwrap();
        assert!(load_lineage(&authority, &binding, WRITER_FP)
            .unwrap()
            .is_some());
        for mode in [0o644u32, 0o400, 0o660, 0o666, 0o700] {
            fs::set_permissions(&final_path, fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(
                load_lineage(&authority, &binding, WRITER_FP).unwrap_err(),
                LINEAGE_UNSAFE_MODE,
                "mode {mode:o} must be rejected"
            );
            assert_eq!(
                fs::metadata(&final_path).unwrap().permissions().mode() & 0o777,
                mode,
                "mode {mode:o} must not be repaired"
            );
            assert_eq!(fs::read(&final_path).unwrap(), canonical, "bytes untouched");
        }
        fs::set_permissions(&final_path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(load_lineage(&authority, &binding, WRITER_FP)
            .unwrap()
            .is_some());
    }

    #[test]
    fn lineage_rejects_more_than_the_bounded_tip_count() {
        let (_root, _authority, binding, mut lineage) = lineage_fixture("lineage-bound");
        for index in 0..=MAX_LINEAGE_TIPS {
            lineage.tips.insert(
                sha256_hex(format!("object-{index}").as_bytes()),
                LineageTip {
                    revision_id: format!("r-{index}"),
                    previous_revision_id: None,
                    revision_blob_sha256_hex: blob("bounded"),
                    delivery_sha256_hex: delivery("bounded"),
                    produced_at_iso: NOW.into(),
                },
            );
        }
        assert_eq!(lineage.tips.len(), MAX_LINEAGE_TIPS + 1);
        assert_eq!(
            validate_lineage(&lineage, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_TIP_LIMIT_EXCEEDED
        );
    }

    #[test]
    fn lineage_rejects_malformed_schema_fields_and_unknown_keys() {
        let (_root, _authority, binding, lineage) = lineage_fixture("lineage-malformed");
        /* Neither the superseded version nor an unknown future one is accepted
         * here: a v1 ledger reaches v2 only through the proven migration. */
        for foreign in [
            "h2o.round2.item11.delivery-lineage.v1",
            "h2o.round2.item11.delivery-lineage.v3",
        ] {
            let mut wrong_schema = lineage.clone();
            wrong_schema.schema = foreign.into();
            assert_eq!(
                validate_lineage(&wrong_schema, &binding, WRITER_FP).unwrap_err(),
                LINEAGE_MALFORMED
            );
        }

        let mut bad_key = lineage.clone();
        bad_key.tips.insert(
            "not-a-64-hex-object-key".into(),
            LineageTip {
                revision_id: "a-r1".into(),
                previous_revision_id: None,
                revision_blob_sha256_hex: blob("a-r1"),
                delivery_sha256_hex: delivery("a-r1"),
                produced_at_iso: NOW.into(),
            },
        );
        assert_eq!(
            validate_lineage(&bad_key, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_MALFORMED
        );

        let mut self_parent = lineage.clone();
        self_parent.tips.insert(
            OBJECT_A.into(),
            LineageTip {
                revision_id: "a-r1".into(),
                previous_revision_id: Some("a-r1".into()),
                revision_blob_sha256_hex: blob("a-r1"),
                delivery_sha256_hex: delivery("a-r1"),
                produced_at_iso: NOW.into(),
            },
        );
        assert_eq!(
            validate_lineage(&self_parent, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_MALFORMED
        );

        let mut bad_stamp = lineage.clone();
        bad_stamp.updated_at = "2026-08-08 12:00:00".into();
        assert_eq!(
            validate_lineage(&bad_stamp, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_MALFORMED
        );

        /* deny_unknown_fields is enforced at the parse boundary. */
        let mut value = serde_json::to_value(&lineage).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("extra".into(), serde_json::json!(true));
        assert!(serde_json::from_value::<DeliveryLineage>(value).is_err());
    }

    #[test]
    fn lineage_absent_ledger_reads_empty_and_creates_nothing() {
        let (_root, authority, binding, _lineage) = lineage_fixture("lineage-absent");
        assert!(load_lineage(&authority, &binding, WRITER_FP)
            .unwrap()
            .is_none());
        assert!(
            !authority.exists(),
            "inspection must not create the authority directory"
        );
    }

    #[test]
    fn lineage_atomic_write_persists_exact_bytes_at_mode_0600() {
        let (_root, authority, binding, mut lineage) = lineage_fixture("lineage-atomic");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        persist_lineage(&authority, &lineage, &binding, WRITER_FP).unwrap();
        let (final_path, temporary_path) = lineage_paths(
            &fs::canonicalize(&authority).unwrap(),
            &binding.canonical_path_sha256_hex,
        );
        assert!(final_path.is_file());
        assert!(!temporary_path.exists(), "temp must not survive the write");
        assert_eq!(
            fs::read(&final_path).unwrap(),
            serde_json::to_vec(&lineage).unwrap()
        );
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&final_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let reloaded = load_lineage(&authority, &binding, WRITER_FP)
            .unwrap()
            .unwrap();
        assert_eq!(reloaded, lineage);
    }

    #[test]
    fn lineage_stale_temporary_blocks_the_write() {
        let (_root, authority, binding, lineage) = lineage_fixture("lineage-stale-temp");
        fs::create_dir_all(&authority).unwrap();
        let (_, temporary_path) = lineage_paths(
            &fs::canonicalize(&authority).unwrap(),
            &binding.canonical_path_sha256_hex,
        );
        fs::write(&temporary_path, b"stale").unwrap();
        assert_eq!(
            persist_lineage(&authority, &lineage, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_TEMP_EXISTS
        );
    }

    #[cfg(unix)]
    #[test]
    fn lineage_symlinked_ledger_is_rejected_on_read_and_write() {
        use std::os::unix::fs::symlink;
        let (_root, authority, binding, lineage) = lineage_fixture("lineage-symlink");
        fs::create_dir_all(&authority).unwrap();
        let canonical_authority = fs::canonicalize(&authority).unwrap();
        let (final_path, _) =
            lineage_paths(&canonical_authority, &binding.canonical_path_sha256_hex);
        let decoy = canonical_authority.join("decoy.json");
        fs::write(&decoy, b"{}").unwrap();
        symlink(&decoy, &final_path).unwrap();
        assert_eq!(
            load_lineage(&authority, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_UNSAFE_FILE_TYPE
        );
        assert_eq!(
            persist_lineage(&authority, &lineage, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_UNSAFE_FILE_TYPE
        );
    }

    #[test]
    fn lineage_oversize_ledger_is_rejected_before_parse() {
        let (_root, authority, binding, _lineage) = lineage_fixture("lineage-oversize");
        fs::create_dir_all(&authority).unwrap();
        let (final_path, _) = lineage_paths(
            &fs::canonicalize(&authority).unwrap(),
            &binding.canonical_path_sha256_hex,
        );
        write_ledger_bytes(&final_path, &vec![b'x'; MAX_LINEAGE_BYTES + 1]);
        assert_eq!(
            load_lineage(&authority, &binding, WRITER_FP).unwrap_err(),
            LINEAGE_OVERSIZE
        );
    }

    #[test]
    fn lineage_ledger_from_another_binding_is_rejected_on_load() {
        let (_root, authority, binding, mut lineage) = lineage_fixture("lineage-foreign-load");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        persist_lineage(&authority, &lineage, &binding, WRITER_FP).unwrap();
        let mut foreign = binding.clone();
        foreign.inode = binding.inode.wrapping_add(1);
        /* Same destination path hash, different inode: the ledger file resolves
         * but its recorded binding no longer matches the live authorization. */
        assert_eq!(
            load_lineage(&authority, &foreign, WRITER_FP).unwrap_err(),
            LINEAGE_BINDING_MISMATCH
        );
        assert_eq!(
            load_lineage(&authority, &binding, &"7".repeat(64)).unwrap_err(),
            LINEAGE_BINDING_MISMATCH
        );
    }

    #[test]
    fn lineage_switching_destination_starts_a_separate_ledger_file() {
        let (root, authority, binding, mut lineage) = lineage_fixture("lineage-switch");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        persist_lineage(&authority, &lineage, &binding, WRITER_FP).unwrap();

        let other_directory = root.0.join("other-destination");
        fs::create_dir(&other_directory).unwrap();
        let other_binding =
            binding_from_directory(&other_directory, ConfiguredPathMode::Absolute).unwrap();
        assert_ne!(
            other_binding.canonical_path_sha256_hex,
            binding.canonical_path_sha256_hex
        );
        assert!(load_lineage(&authority, &other_binding, WRITER_FP)
            .unwrap()
            .is_none());
        /* The original binding's ledger is untouched by the new destination. */
        assert_eq!(
            load_lineage(&authority, &binding, WRITER_FP)
                .unwrap()
                .unwrap(),
            lineage
        );
    }

    #[test]
    fn lineage_rejects_a_forked_blob_for_an_established_revision_id() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-fork");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        assert_eq!(
            begin_pending(&lineage, OBJECT_A, "a-r1", &blob("tampered"), NOW).unwrap_err(),
            LINEAGE_UNRESOLVED
        );
        let plan = begin_pending(&lineage, OBJECT_A, "a-r2", &blob("a-r2"), NOW).unwrap();
        record_pending(&mut lineage, &plan, &blob("a-r2"), &delivery("a-r2"), NOW).unwrap();
        assert_eq!(
            begin_pending(&lineage, OBJECT_A, "a-r2", &blob("tampered"), NOW).unwrap_err(),
            LINEAGE_UNRESOLVED
        );
    }

    #[test]
    fn lineage_corrupt_visible_package_fails_closed_without_mutating_the_ledger() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-corrupt");
        let plan = begin_pending(&lineage, OBJECT_A, "a-r1", &blob("a-r1"), NOW).unwrap();
        record_pending(&mut lineage, &plan, &blob("a-r1"), &delivery("a-r1"), NOW).unwrap();
        let before = lineage.clone();
        let corrupt = ObservedDelivery {
            object_key: "not-a-64-hex-object-key".into(),
            revision_id: "a-r1".into(),
            previous_revision_id: None,
            revision_blob_sha256_hex: blob("a-r1"),
            delivery_sha256_hex: delivery("a-r1"),
            produced_at_iso: plan.produced_at_iso.clone(),
        };
        assert_eq!(
            validate_observed_delivery(&corrupt).unwrap_err(),
            LINEAGE_DESTINATION_PACKAGE_INVALID
        );
        assert_eq!(
            reconcile_pending(&lineage, Some(&corrupt), OBJECT_A, "a-r1").unwrap_err(),
            LINEAGE_DESTINATION_PACKAGE_INVALID
        );
        assert_eq!(
            promote_pending(&mut lineage, &corrupt, NOW).unwrap_err(),
            LINEAGE_DESTINATION_PACKAGE_INVALID
        );
        assert_eq!(lineage, before, "a corrupt package must not mutate lineage");

        /* A malformed timestamp or a self-parent is equally inadmissible. */
        let mut bad_stamp = corrupt.clone();
        bad_stamp.object_key = OBJECT_A.into();
        bad_stamp.produced_at_iso = "yesterday".into();
        assert_eq!(
            validate_observed_delivery(&bad_stamp).unwrap_err(),
            LINEAGE_DESTINATION_PACKAGE_INVALID
        );
        let mut self_parent = bad_stamp.clone();
        self_parent.produced_at_iso = NOW.into();
        self_parent.previous_revision_id = Some("a-r1".into());
        assert_eq!(
            validate_observed_delivery(&self_parent).unwrap_err(),
            LINEAGE_DESTINATION_PACKAGE_INVALID
        );
    }

    #[test]
    fn lineage_replay_must_reproduce_the_recorded_delivery_digest() {
        let (_root, _authority, _binding, mut lineage) = lineage_fixture("lineage-reproduce");
        make_visible(&mut lineage, OBJECT_A, "a-r1", NOW);
        let plan = begin_pending(&lineage, OBJECT_A, "a-r1", &blob("a-r1"), NOW).unwrap();
        assert_eq!(
            record_pending(
                &mut lineage,
                &plan,
                &blob("a-r1"),
                &delivery("different-bytes"),
                NOW
            )
            .unwrap_err(),
            LINEAGE_UNRESOLVED
        );
    }

    /* --------------------------------------------------------------------
     * True-local delivery preparation (Step 2B), exercised through the real
     * command core rather than the pure ledger helpers.
     * ----------------------------------------------------------------- */

    const WRITER_ID: &str =
        "studio-desktop:tauri-desktop:sqlite:6f1c2f0e-9a4b-4d3c-8e2f-1a2b3c4d5e6f";
    const SOURCE_ISO: &str = "2026-08-08T07:00:00.000Z";

    struct LocalHarness {
        _root: TestRoot,
        authority: PathBuf,
        home: PathBuf,
        directory: PathBuf,
        binding: AuthorizationBinding,
        writer_fingerprint: String,
        clock: std::cell::Cell<u32>,
    }

    fn local_harness(label: &str) -> LocalHarness {
        let root = TestRoot::new(label);
        let home = root.0.join("home");
        let directory = home.join("Shared Sync");
        fs::create_dir_all(&directory).expect("create destination");
        let authority = root.0.join("authority");
        let binding = binding_from_directory(&directory, ConfiguredPathMode::Absolute)
            .expect("authorize destination");
        persist_binding(&authority, &binding).expect("persist authorization");
        let writer_fingerprint = sha256_hex(WRITER_ID.as_bytes());
        LocalHarness {
            _root: root,
            authority,
            home,
            directory: fs::canonicalize(&directory).unwrap(),
            binding,
            writer_fingerprint,
            clock: std::cell::Cell::new(0),
        }
    }

    /// Builds a canonical `h2o.studio.syncRevision.v1` blob for one revision.
    fn local_revision(object_id: &str, revision_id: &str, seed: &str) -> (String, String, String) {
        let payload = serde_json::json!({
            "schema": "h2o.studio.fullBundle.v2",
            "seed": seed,
            "chats": [{ "id": object_id, "revision": revision_id }]
        });
        let payload_text = canonical_value(&payload).unwrap();
        let payload_sha = sha256_hex(payload_text.as_bytes());
        let envelope = serde_json::json!({
            "schema": REVISION_SCHEMA,
            "objectId": object_id,
            "objectKey": object_key_hex(object_id),
            "revisionId": revision_id,
            "payloadSha256": payload_sha,
            "payload": payload
        });
        let blob = canonical_value(&envelope).unwrap();
        let blob_sha = sha256_hex(blob.as_bytes());
        (blob, blob_sha, payload_sha)
    }

    impl LocalHarness {
        fn request(&self, object_id: &str, revision_id: &str) -> Item11PrepareLocalDeliveryRequest {
            let (blob, blob_sha, payload_sha) = local_revision(object_id, revision_id, revision_id);
            Item11PrepareLocalDeliveryRequest {
                object_id: object_id.into(),
                object_key_hex: object_key_hex(object_id),
                revision_id: revision_id.into(),
                payload_sha256_hex: payload_sha,
                revision_blob_text: blob,
                revision_blob_sha256_hex: blob_sha,
                writer_sync_peer_id: WRITER_ID.into(),
                source_updated_at_iso: SOURCE_ISO.into(),
                expected_destination_path_sha256_hex: self
                    .binding
                    .canonical_path_sha256_hex
                    .clone(),
                destination_configured_path_mode: ConfiguredPathMode::Absolute,
                configuration_absent: false,
            }
        }

        fn lineage_request(&self, object_id: &str) -> Item11ReadLineageRequest {
            Item11ReadLineageRequest {
                object_id: object_id.into(),
                writer_sync_peer_id: WRITER_ID.into(),
                expected_destination_path_sha256_hex: self
                    .binding
                    .canonical_path_sha256_hex
                    .clone(),
                destination_configured_path_mode: ConfiguredPathMode::Absolute,
            }
        }

        /// A distinct candidate timestamp per call, so any accidental restamping
        /// is visible rather than masked by a constant clock.
        fn tick(&self) -> String {
            let value = self.clock.get() + 1;
            self.clock.set(value);
            format!("2026-08-08T{:02}:{:02}:00.000Z", 8 + value / 60, value % 60)
        }

        fn prepare(
            &self,
            request: &Item11PrepareLocalDeliveryRequest,
        ) -> Result<Item11PrepareLocalDeliveryResult, &'static str> {
            self.prepare_with_fault(request, LocalFaultStage::None)
        }

        fn prepare_with_fault(
            &self,
            request: &Item11PrepareLocalDeliveryRequest,
            fault: LocalFaultStage,
        ) -> Result<Item11PrepareLocalDeliveryResult, &'static str> {
            let stamp = self.tick();
            prepare_local_delivery_core(&self.authority, &self.home, request, &stamp, &stamp, fault)
        }

        fn deliver(&self, object_id: &str, revision_id: &str) -> Item11PrepareLocalDeliveryResult {
            let request = self.request(object_id, revision_id);
            self.prepare(&request).expect("prepare local delivery")
        }

        fn ledger(&self) -> Option<DeliveryLineage> {
            load_lineage(&self.authority, &self.binding, &self.writer_fingerprint).unwrap()
        }

        fn slot_bytes(&self) -> Vec<u8> {
            fs::read(self.directory.join(DELIVERY_FILE)).expect("delivery slot")
        }

        fn ledger_path(&self) -> PathBuf {
            lineage_paths(
                &fs::canonicalize(&self.authority).expect("canonical authority"),
                &self.binding.canonical_path_sha256_hex,
            )
            .0
        }

        /// The state a destination is in after the owner reauthorizes: the slot
        /// still holds whatever was last delivered, and the v2 ledger that used
        /// to explain it is gone.
        fn forget_ledger(&self) {
            fs::remove_file(self.ledger_path()).expect("drop the v2 ledger");
        }
    }

    #[test]
    fn local_r1_from_empty_state_writes_one_package_with_no_parent() {
        let harness = local_harness("local-r1");
        let result = harness.deliver("object-a", "a-r1");
        assert!(result.ok);
        assert_eq!(result.verdict, "browser-delivery-prepared");
        assert_eq!(result.previous_revision_id, None);
        assert_eq!(result.lineage_disposition, LocalDeliveryDisposition::New);
        assert_eq!(result.slot_posture, LocalDeliverySlotPosture::Absent);
        assert!(result.no_network);

        let bytes = harness.slot_bytes();
        assert_eq!(sha256_hex(&bytes), result.delivery_sha256_hex);
        assert_eq!(bytes.len(), result.delivery_byte_length);
        validate_delivery_envelope(std::str::from_utf8(&bytes).unwrap(), "object-a").unwrap();
        let observed = observe_delivery_slot(&harness.directory).unwrap().unwrap();
        assert_eq!(observed.revision_id, "a-r1");
        assert_eq!(observed.previous_revision_id, None);
        assert_eq!(observed.produced_at_iso, result.produced_at_iso);

        let ledger = harness.ledger().unwrap();
        assert!(ledger.pending.is_none());
        let tip = resolve_tip(&ledger, &object_key_hex("object-a")).unwrap();
        assert_eq!(tip.revision_id, "a-r1");
        assert_eq!(tip.delivery_sha256_hex, result.delivery_sha256_hex);
        assert_eq!(
            fs::read_dir(&harness.directory).unwrap().count(),
            1,
            "exactly one delivery file"
        );
    }

    #[test]
    fn local_r2_chains_onto_r1() {
        let harness = local_harness("local-r2");
        harness.deliver("object-a", "a-r1");
        let second = harness.deliver("object-a", "a-r2");
        assert_eq!(second.previous_revision_id.as_deref(), Some("a-r1"));
        let ledger = harness.ledger().unwrap();
        assert_eq!(
            resolve_tip(&ledger, &object_key_hex("object-a"))
                .unwrap()
                .revision_id,
            "a-r2"
        );
    }

    #[test]
    fn lineage_reader_reports_empty_without_creating_a_ledger() {
        let harness = local_harness("lineage-read-empty");
        let before = fs::read_dir(&harness.authority).unwrap().count();
        let result = read_lineage_core(&harness.authority, &harness.lineage_request("object-a"))
            .expect("read empty lineage");
        assert_eq!(result.state, "empty");
        assert!(result.chain.is_empty());
        assert!(result.current_revision_id.is_none());
        assert!(result.pending_revision_id.is_none());
        assert!(result.read_only && result.no_network);
        assert_eq!(fs::read_dir(&harness.authority).unwrap().count(), before);
        let (lineage_path, _) = lineage_paths(
            &harness.authority,
            &harness.binding.canonical_path_sha256_hex,
        );
        assert!(!lineage_path.exists());
    }

    #[test]
    fn lineage_reader_projects_tip_hash_and_pending_without_mutation() {
        let harness = local_harness("lineage-read-current-pending");
        harness.deliver("object-a", "a-r1");
        let mut lineage = harness.ledger().unwrap();
        let current_blob_hash = resolve_tip(&lineage, &object_key_hex("object-a"))
            .unwrap()
            .revision_blob_sha256_hex
            .clone();
        let plan = begin_pending(
            &lineage,
            &object_key_hex("object-a"),
            "a-r2",
            &blob("a-r2"),
            NOW,
        )
        .unwrap();
        record_pending(&mut lineage, &plan, &blob("a-r2"), &delivery("a-r2"), NOW).unwrap();
        persist_lineage(
            &harness.authority,
            &lineage,
            &harness.binding,
            &harness.writer_fingerprint,
        )
        .unwrap();
        let (lineage_path, _) = lineage_paths(
            &harness.authority,
            &harness.binding.canonical_path_sha256_hex,
        );
        let before = fs::read(&lineage_path).unwrap();
        let result = read_lineage_core(&harness.authority, &harness.lineage_request("object-a"))
            .expect("read lineage projection");
        assert_eq!(result.state, "pending");
        assert_eq!(result.current_revision_id.as_deref(), Some("a-r1"));
        assert_eq!(
            result.current_revision_blob_sha256_hex.as_deref(),
            Some(current_blob_hash.as_str())
        );
        assert_eq!(result.previous_revision_id, None);
        assert_eq!(result.pending_revision_id.as_deref(), Some("a-r2"));
        assert_eq!(result.chain, vec!["a-r1"]);
        assert_eq!(
            fs::read(&lineage_path).unwrap(),
            before,
            "read never rewrites ledger"
        );
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("currentRevisionBlobSha256Hex"));
        assert!(!json.contains(WRITER_ID));
        assert!(!json.contains(&harness.binding.canonical_path));
    }

    #[test]
    fn local_interleaved_objects_keep_independent_chains() {
        let harness = local_harness("local-interleaved");
        harness.deliver("object-a", "a-r1");
        let b1 = harness.deliver("object-b", "b-r1");
        assert_eq!(b1.previous_revision_id, None);
        assert_eq!(b1.slot_posture, LocalDeliverySlotPosture::OtherObject);
        let a2 = harness.deliver("object-a", "a-r2");
        assert_eq!(a2.previous_revision_id.as_deref(), Some("a-r1"));
        assert_eq!(a2.slot_posture, LocalDeliverySlotPosture::OtherObject);
    }

    #[test]
    fn local_four_step_interleaving_keeps_exact_chains() {
        let harness = local_harness("local-four-step");
        harness.deliver("object-a", "a-r1");
        harness.deliver("object-b", "b-r1");
        let b2 = harness.deliver("object-b", "b-r2");
        let a2 = harness.deliver("object-a", "a-r2");
        assert_eq!(a2.previous_revision_id.as_deref(), Some("a-r1"));
        assert_eq!(b2.previous_revision_id.as_deref(), Some("b-r1"));
        let ledger = harness.ledger().unwrap();
        assert_eq!(
            resolve_tip(&ledger, &object_key_hex("object-a"))
                .unwrap()
                .revision_id,
            "a-r2"
        );
        assert_eq!(
            resolve_tip(&ledger, &object_key_hex("object-b"))
                .unwrap()
                .revision_id,
            "b-r2"
        );
    }

    #[test]
    fn local_committed_replay_reproduces_byte_identical_bytes_without_advancing() {
        let harness = local_harness("local-replay");
        let first = harness.deliver("object-a", "a-r1");
        let first_bytes = harness.slot_bytes();
        harness.deliver("object-b", "b-r1");
        let ledger_before = harness.ledger().unwrap();

        let replay = harness.deliver("object-a", "a-r1");
        assert_eq!(
            replay.lineage_disposition,
            LocalDeliveryDisposition::CommittedReplay
        );
        assert_eq!(replay.produced_at_iso, first.produced_at_iso);
        assert_eq!(replay.delivery_sha256_hex, first.delivery_sha256_hex);
        assert_eq!(replay.previous_revision_id, None);
        assert_eq!(
            harness.slot_bytes(),
            first_bytes,
            "the slot must hold byte-identical bytes again"
        );
        assert_eq!(
            harness.ledger().unwrap(),
            ledger_before,
            "a replay must not change lineage"
        );
    }

    #[test]
    fn local_crash_after_pending_before_delivery_retries_without_forking() {
        let harness = local_harness("local-crash-pending");
        let request = harness.request("object-a", "a-r1");
        assert_eq!(
            harness
                .prepare_with_fault(&request, LocalFaultStage::AfterPendingBeforeDelivery)
                .unwrap_err(),
            LOCAL_DELIVERY_PREPARATION_FAILED
        );
        let pending = harness
            .ledger()
            .unwrap()
            .pending
            .expect("pending persisted");
        assert!(!harness.directory.join(DELIVERY_FILE).exists());

        let retry = harness.prepare(&request).expect("retry succeeds");
        assert_eq!(
            retry.lineage_disposition,
            LocalDeliveryDisposition::ResumedPending
        );
        assert_eq!(retry.produced_at_iso, pending.produced_at_iso);
        assert_eq!(retry.delivery_sha256_hex, pending.delivery_sha256_hex);
        assert_eq!(retry.previous_revision_id, pending.previous_revision_id);
        let ledger = harness.ledger().unwrap();
        assert!(ledger.pending.is_none());
        assert_eq!(
            resolve_tip(&ledger, &object_key_hex("object-a"))
                .unwrap()
                .revision_id,
            "a-r1"
        );
    }

    #[test]
    fn local_crash_after_delivery_before_promotion_self_heals() {
        let harness = local_harness("local-crash-promote");
        let request = harness.request("object-a", "a-r1");
        assert_eq!(
            harness
                .prepare_with_fault(&request, LocalFaultStage::AfterDeliveryBeforePromote)
                .unwrap_err(),
            LOCAL_DELIVERY_PREPARATION_FAILED
        );
        let pending = harness
            .ledger()
            .unwrap()
            .pending
            .expect("pending persisted");
        let visible = harness.slot_bytes();
        assert_eq!(sha256_hex(&visible), pending.delivery_sha256_hex);

        /* The next invocation observes the exact visible package and promotes
         * it before doing anything else. */
        let next = harness.deliver("object-a", "a-r2");
        assert_eq!(next.previous_revision_id.as_deref(), Some("a-r1"));
        let ledger = harness.ledger().unwrap();
        assert!(ledger.pending.is_none());
        assert_eq!(
            resolve_tip(&ledger, &object_key_hex("object-a"))
                .unwrap()
                .revision_id,
            "a-r2"
        );
    }

    #[test]
    fn local_failure_during_promotion_persistence_is_recoverable() {
        let harness = local_harness("local-crash-persist");
        let request = harness.request("object-a", "a-r1");
        assert_eq!(
            harness
                .prepare_with_fault(&request, LocalFaultStage::DuringPromotePersist)
                .unwrap_err(),
            LOCAL_DELIVERY_PREPARATION_FAILED
        );
        let pending = harness.ledger().unwrap().pending.expect("pending survives");
        assert_eq!(
            sha256_hex(&harness.slot_bytes()),
            pending.delivery_sha256_hex
        );

        let retry = harness.prepare(&request).expect("retry self-heals");
        assert_eq!(
            retry.lineage_disposition,
            LocalDeliveryDisposition::RecoveredPending
        );
        assert_eq!(retry.produced_at_iso, pending.produced_at_iso);
        let ledger = harness.ledger().unwrap();
        assert!(ledger.pending.is_none());
        assert_eq!(
            resolve_tip(&ledger, &object_key_hex("object-a"))
                .unwrap()
                .revision_id,
            "a-r1"
        );
    }

    #[test]
    fn local_slot_holding_another_object_does_not_affect_the_parent() {
        let harness = local_harness("local-slot-other");
        harness.deliver("object-a", "a-r1");
        harness.deliver("object-b", "b-r1");
        let observed = observe_delivery_slot(&harness.directory).unwrap().unwrap();
        assert_eq!(observed.object_key, object_key_hex("object-b"));
        let a2 = harness.deliver("object-a", "a-r2");
        assert_eq!(a2.previous_revision_id.as_deref(), Some("a-r1"));
        assert_eq!(a2.slot_posture, LocalDeliverySlotPosture::OtherObject);
    }

    #[test]
    fn local_same_object_slot_ahead_without_matching_pending_fails_closed() {
        let harness = local_harness("local-slot-ahead");
        harness.deliver("object-a", "a-r1");
        harness.deliver("object-a", "a-r2");
        let slot_before = harness.slot_bytes();

        /* Roll the ledger back to a-r1 with no pending intent: the slot now
         * holds a valid a-r2 package that this lineage cannot explain. */
        let mut rolled_back = harness.ledger().unwrap();
        let object_key = object_key_hex("object-a");
        let tip = rolled_back.tips.get_mut(&object_key).unwrap();
        tip.revision_id = "a-r1".into();
        tip.previous_revision_id = None;
        rolled_back.pending = None;
        rolled_back.updated_at = NOW.into();
        persist_lineage(
            &harness.authority,
            &rolled_back,
            &harness.binding,
            &harness.writer_fingerprint,
        )
        .unwrap();

        assert_eq!(
            harness
                .prepare(&harness.request("object-a", "a-r3"))
                .unwrap_err(),
            LOCAL_DELIVERY_SLOT_AHEAD
        );
        assert_eq!(harness.ledger().unwrap(), rolled_back, "ledger unchanged");
        assert_eq!(harness.slot_bytes(), slot_before, "destination unchanged");
    }

    #[test]
    fn local_corrupt_destination_package_fails_closed() {
        let harness = local_harness("local-corrupt-slot");
        harness.deliver("object-a", "a-r1");
        let ledger_before = harness.ledger().unwrap();
        let corrupt = b"{\"schema\":\"h2o.round2.item9.browser-delivery.v1\"".to_vec();
        fs::write(harness.directory.join(DELIVERY_FILE), &corrupt).unwrap();
        let request = harness.request("object-a", "a-r2");
        assert_eq!(
            harness.prepare(&request).unwrap_err(),
            LINEAGE_DESTINATION_PACKAGE_INVALID
        );
        assert_eq!(harness.ledger().unwrap(), ledger_before, "ledger unchanged");
        assert_eq!(harness.slot_bytes(), corrupt, "destination unchanged");
    }

    #[test]
    fn local_request_field_mismatches_fail_before_any_mutation() {
        let harness = local_harness("local-request-invalid");
        harness.deliver("object-a", "a-r1");
        let ledger_before = harness.ledger().unwrap();
        let slot_before = harness.slot_bytes();
        let base = harness.request("object-a", "a-r2");

        let mut wrong_key = base.clone();
        wrong_key.object_key_hex = "c".repeat(64);
        assert_eq!(
            harness.prepare(&wrong_key).unwrap_err(),
            LOCAL_DELIVERY_OBJECT_KEY_MISMATCH
        );

        let mut wrong_blob_hash = base.clone();
        wrong_blob_hash.revision_blob_sha256_hex = "d".repeat(64);
        assert_eq!(
            harness.prepare(&wrong_blob_hash).unwrap_err(),
            LOCAL_DELIVERY_REVISION_HASH_MISMATCH
        );

        let mut cross_field = base.clone();
        cross_field.revision_id = "a-r9".into();
        assert_eq!(
            harness.prepare(&cross_field).unwrap_err(),
            LOCAL_DELIVERY_REVISION_INVALID
        );

        let mut wrong_payload = base.clone();
        wrong_payload.payload_sha256_hex = "e".repeat(64);
        assert_eq!(
            harness.prepare(&wrong_payload).unwrap_err(),
            LOCAL_DELIVERY_REVISION_INVALID
        );

        let mut noncanonical = base.clone();
        noncanonical.revision_blob_text = format!("{} ", base.revision_blob_text);
        noncanonical.revision_blob_sha256_hex =
            sha256_hex(noncanonical.revision_blob_text.as_bytes());
        assert_eq!(
            harness.prepare(&noncanonical).unwrap_err(),
            LOCAL_DELIVERY_REVISION_NOT_CANONICAL
        );

        for writer in [
            "",
            "studio-chrome:mv3-chrome:idb-shared:6f1c2f0e-9a4b-4d3c-8e2f-1a2b3c4d5e6f",
            "studio-desktop:tauri-desktop:sqlite:not-a-uuid",
        ] {
            let mut bad_writer = base.clone();
            bad_writer.writer_sync_peer_id = writer.into();
            assert_eq!(
                harness.prepare(&bad_writer).unwrap_err(),
                LOCAL_DELIVERY_WRITER_IDENTITY_INVALID,
                "writer {writer:?} must be refused"
            );
        }

        let mut bad_stamp = base.clone();
        bad_stamp.source_updated_at_iso = "yesterday".into();
        assert_eq!(
            harness.prepare(&bad_stamp).unwrap_err(),
            LOCAL_DELIVERY_REVISION_INVALID
        );

        let mut foreign_destination = base.clone();
        foreign_destination.expected_destination_path_sha256_hex = "f".repeat(64);
        assert_eq!(
            harness.prepare(&foreign_destination).unwrap_err(),
            DELIVERY_FOLDER_CONFIG_MISMATCH
        );

        assert_eq!(harness.ledger().unwrap(), ledger_before, "ledger unchanged");
        assert_eq!(harness.slot_bytes(), slot_before, "destination unchanged");
    }

    #[test]
    fn local_stale_delivery_temporary_still_bites() {
        let harness = local_harness("local-stale-delivery-temp");
        harness.deliver("object-a", "a-r1");
        fs::write(harness.directory.join(TEMPORARY_FILE), b"stale").unwrap();
        let request = harness.request("object-a", "a-r2");
        assert_eq!(harness.prepare(&request).unwrap_err(), DELIVERY_TEMP_EXISTS);

        /* Pending intent is durable by then, so the operation is unfinished:
         * a different request now fails closed, and clearing the stale temp
         * lets the exact same revision resume without forking. */
        assert_eq!(
            harness
                .prepare(&harness.request("object-b", "b-r1"))
                .unwrap_err(),
            LINEAGE_UNRESOLVED
        );
        fs::remove_file(harness.directory.join(TEMPORARY_FILE)).unwrap();
        let resumed = harness.prepare(&request).expect("resume the same revision");
        assert_eq!(
            resumed.lineage_disposition,
            LocalDeliveryDisposition::ResumedPending
        );
        assert_eq!(resumed.previous_revision_id.as_deref(), Some("a-r1"));
    }

    #[test]
    fn local_stale_lineage_temporary_still_bites() {
        let harness = local_harness("local-stale-lineage-temp");
        fs::create_dir_all(&harness.authority).unwrap();
        let (_, lineage_temp) = lineage_paths(
            &fs::canonicalize(&harness.authority).unwrap(),
            &harness.binding.canonical_path_sha256_hex,
        );
        fs::write(&lineage_temp, b"stale").unwrap();
        assert_eq!(
            harness
                .prepare(&harness.request("object-a", "a-r1"))
                .unwrap_err(),
            LINEAGE_TEMP_EXISTS
        );
        assert!(
            !harness.directory.join(DELIVERY_FILE).exists(),
            "no delivery may become visible"
        );
    }

    #[test]
    fn local_capacity_refuses_a_new_object_before_the_delivery_write() {
        let harness = local_harness("local-capacity");
        let mut ledger = DeliveryLineage::empty(&harness.binding, &harness.writer_fingerprint, NOW);
        saturate_tips(&mut ledger);
        persist_lineage(
            &harness.authority,
            &ledger,
            &harness.binding,
            &harness.writer_fingerprint,
        )
        .unwrap();
        assert_eq!(
            harness
                .prepare(&harness.request("object-z", "z-r1"))
                .unwrap_err(),
            LINEAGE_TIP_LIMIT_EXCEEDED
        );
        assert!(harness.ledger().unwrap().pending.is_none());
        assert!(
            !harness.directory.join(DELIVERY_FILE).exists(),
            "no delivery was written"
        );
    }

    #[test]
    fn local_oversize_package_fails_before_visibility() {
        let harness = local_harness("local-oversize");
        harness.deliver("object-a", "a-r1");
        let slot_before = harness.slot_bytes();
        let ledger_before = harness.ledger().unwrap();
        let payload = serde_json::json!({
            "schema": "h2o.studio.fullBundle.v2",
            "bulk": "x".repeat(MAX_LOCAL_REVISION_BYTES + 16)
        });
        let payload_text = canonical_value(&payload).unwrap();
        let envelope = serde_json::json!({
            "schema": REVISION_SCHEMA,
            "objectId": "object-a",
            "objectKey": object_key_hex("object-a"),
            "revisionId": "a-r2",
            "payloadSha256": sha256_hex(payload_text.as_bytes()),
            "payload": payload
        });
        let blob = canonical_value(&envelope).unwrap();
        let mut request = harness.request("object-a", "a-r2");
        request.payload_sha256_hex = sha256_hex(payload_text.as_bytes());
        request.revision_blob_sha256_hex = sha256_hex(blob.as_bytes());
        request.revision_blob_text = blob;
        assert_eq!(
            harness.prepare(&request).unwrap_err(),
            LOCAL_DELIVERY_REVISION_INVALID
        );
        assert_eq!(harness.slot_bytes(), slot_before);
        assert_eq!(harness.ledger().unwrap(), ledger_before);
    }

    #[test]
    fn local_result_exposes_no_raw_destination_path_or_identity() {
        let harness = local_harness("local-redaction");
        let result = harness.deliver("object-a", "a-r1");
        let json = serde_json::to_string(&result).unwrap();
        let raw_path = harness.directory.to_str().unwrap();
        assert!(!json.contains(raw_path), "raw destination path leaked");
        assert!(!json.contains(WRITER_ID), "raw writer identity leaked");
        assert!(!json.contains(&harness.writer_fingerprint));
        assert!(json.contains("\"destinationFolderLeafName\":\"Shared Sync\""));
        assert!(json.contains("\"noNetwork\":true"));
        assert!(json.contains("\"lineageDisposition\":\"new\""));
        assert!(json.contains("\"slotPosture\":\"absent\""));
    }

    #[test]
    fn local_delivery_module_source_contains_no_transport_symbols() {
        /* Structural guard: the local path must stay unreachable from WebDAV.
         * Needles are assembled so this assertion cannot match itself. */
        let source = include_str!("item11_delivery_destination.rs");
        for needle in [
            concat!("WebDav", "Transport"),
            concat!("WebDav", "Request"),
            concat!("WebDav", "Response"),
            concat!("Reqwest", "WebDav", "Transport"),
            concat!("production_", "transport"),
            concat!("h2o_sync_object_", "pull_transport"),
            concat!("h2o_sync_object_", "publish_transport"),
            concat!("webdav_", "transport_core"),
            concat!("real_transport_", "capability_probe"),
            concat!("sync_object_", "transport"),
            concat!("req", "west"),
        ] {
            assert!(
                !source.contains(needle),
                "local delivery module must not reference {needle}"
            );
        }
    }

    /* ── durable volume identity, and the absence of legacy trust ─────────
     *
     * A folder that never moved read as "moved or replaced" because macOS
     * renumbered its volume across a reboot. v2 binds the volume itself, so the
     * ordinal stops mattering while everything that genuinely distinguishes one
     * directory from another keeps mattering.
     *
     * v1 records are the other half. Nothing enforces one writer per
     * Application Support identity, so a v1-capable build can advance
     * `lineage.v1.*` in another process at any moment; any v2 authority derived
     * from v1 state could therefore activate on top of a revision that landed a
     * moment earlier. The product does not attempt that transfer at all, and the
     * tests below hold it to that — a v1 record is routed to one deliberate
     * re-pick and is otherwise left exactly where it is. */

    fn destination_identity(directory: &Path) -> (PathBuf, u64, u64) {
        let canonical = fs::canonicalize(directory).expect("canonicalize destination");
        let metadata = fs::symlink_metadata(&canonical).expect("stat destination");
        let (device_id, inode, _) = metadata_identity(&metadata);
        (canonical, device_id, inode)
    }

    /// Writes the on-disk shape a pre-v2 install actually has. Built as JSON
    /// rather than from the production type, so the test pins the file format
    /// instead of merely agreeing with the struct that reads it.
    fn write_legacy_authorization(
        root: &Path,
        directory: &Path,
        device_id_override: Option<u64>,
    ) -> Vec<u8> {
        let (canonical, device_id, inode) = destination_identity(directory);
        let canonical_text = canonical.to_str().expect("path text");
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schema": AUTHORIZATION_SCHEMA_LEGACY,
            "canonicalPath": canonical_text,
            "canonicalPathSha256Hex": sha256_hex(canonical_text.as_bytes()),
            "destinationFolderLeafName": canonical
                .file_name()
                .and_then(|value| value.to_str())
                .expect("leaf name"),
            "configuredPathMode": "absolute",
            "deviceId": device_id_override.unwrap_or(device_id),
            "inode": inode,
            "ownerUid": current_uid(),
        }))
        .expect("serialize v1 authorization");
        fs::create_dir_all(root).expect("create authorization root");
        fs::write(legacy_authorization_path(root), &bytes).expect("write v1 authorization");
        bytes
    }

    /// A v1 ledger, written straight to the v1 filename. The production build
    /// has no type for this any more, which is the point: the bytes exist and
    /// nothing reads them.
    fn write_legacy_lineage(
        root: &Path,
        path_sha256_hex: &str,
        tip: &str,
        pending: bool,
    ) -> Vec<u8> {
        let mut record = serde_json::json!({
            "schema": "h2o.round2.item11.delivery-lineage.v1",
            "writerSyncPeerIdSha256Hex": WRITER_FP,
            "destinationPathSha256Hex": path_sha256_hex,
            "destinationDeviceId": 1_u64,
            "destinationInode": 2_u64,
            "destinationOwnerUid": current_uid(),
            "tips": { OBJECT_A: {
                "revisionId": tip,
                "previousRevisionId": serde_json::Value::Null,
                "revisionBlobSha256Hex": blob(tip),
                "deliverySha256Hex": delivery(tip),
                "producedAtIso": NOW,
            }},
            "pending": serde_json::Value::Null,
            "updatedAt": NOW,
        });
        if pending {
            record["pending"] = serde_json::json!({
                "objectKey": OBJECT_B,
                "revisionId": "b-r1",
                "previousRevisionId": serde_json::Value::Null,
                "revisionBlobSha256Hex": blob("b-r1"),
                "deliverySha256Hex": delivery("b-r1"),
                "producedAtIso": NOW,
            });
        }
        let bytes = serde_json::to_vec(&record).expect("serialize v1 ledger");
        let path = root.join(format!("lineage.v1.{path_sha256_hex}.json"));
        fs::write(&path, &bytes).expect("write v1 ledger");
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("v1 ledger mode");
        bytes
    }

    struct LegacyFixture {
        _root: TestRoot,
        authority: PathBuf,
        canonical_authority: PathBuf,
        directory: PathBuf,
        path_sha: String,
        authorization_bytes: Vec<u8>,
    }

    fn legacy_fixture(label: &str, device_id_override: Option<u64>) -> LegacyFixture {
        let root = TestRoot::new(label);
        let authority = root.0.join("authority");
        let directory = root.0.join("destination");
        fs::create_dir(&directory).unwrap();
        let authorization_bytes =
            write_legacy_authorization(&authority, &directory, device_id_override);
        let (canonical, _, _) = destination_identity(&directory);
        LegacyFixture {
            canonical_authority: fs::canonicalize(&authority).unwrap(),
            path_sha: sha256_hex(canonical.to_str().unwrap().as_bytes()),
            _root: root,
            authority,
            directory,
            authorization_bytes,
        }
    }

    impl LegacyFixture {
        fn authorization_v2(&self) -> PathBuf {
            authorization_paths(&self.canonical_authority).0
        }
        fn lineage_v2(&self) -> PathBuf {
            lineage_paths(&self.canonical_authority, &self.path_sha).0
        }
        fn legacy_lineage(&self) -> PathBuf {
            self.canonical_authority
                .join(format!("lineage.v1.{}.json", self.path_sha))
        }
        /// Everything a refusal must leave exactly as it found it.
        fn assert_untouched(&self, legacy_ledger: Option<&[u8]>) {
            assert!(
                !self.authorization_v2().exists(),
                "no v2 authorization may be minted from a v1 record"
            );
            assert!(
                !authorization_paths(&self.canonical_authority).1.exists(),
                "no partial authorization write may survive"
            );
            assert!(
                !self.lineage_v2().exists(),
                "no v2 ledger may be minted from a v1 record"
            );
            assert_eq!(
                fs::read(legacy_authorization_path(&self.canonical_authority)).unwrap(),
                self.authorization_bytes,
                "the v1 authorization is evidence and is never rewritten"
            );
            if let Some(expected) = legacy_ledger {
                assert_eq!(
                    fs::read(self.legacy_lineage()).unwrap(),
                    expected,
                    "the v1 ledger is evidence and is never rewritten"
                );
            }
        }
    }

    /// A. The case a5ab10bc migrated automatically: every original v1 check
    /// passes, ordinal included, and the answer is still "re-pick the folder".
    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_authorization_with_current_ordinal_still_requires_reauthorization() {
        let fixture = legacy_fixture("legacy-current-ordinal", None);
        assert_eq!(
            load_binding(&fixture.authority).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );
        fixture.assert_untouched(None);
    }

    /// B. The live incident: the ordinal has drifted. Same answer.
    #[test]
    fn legacy_authorization_with_foreign_ordinal_requires_reauthorization() {
        let root = TestRoot::new("legacy-foreign-ordinal");
        let authority = root.0.join("authority");
        let directory = root.0.join("destination");
        fs::create_dir(&directory).unwrap();
        let (_, device_id, _) = destination_identity(&directory);
        let bytes =
            write_legacy_authorization(&authority, &directory, Some(device_id.wrapping_add(1)));
        let canonical_authority = fs::canonicalize(&authority).unwrap();

        assert_eq!(
            load_binding(&authority).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );
        assert!(!authorization_paths(&canonical_authority).0.exists());
        assert_eq!(
            fs::read(legacy_authorization_path(&canonical_authority)).unwrap(),
            bytes
        );
    }

    /// C / D. A v1 ledger — committed tips, or an unresolved pending intent —
    /// changes nothing and is never converted, claimed or rewritten.
    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_lineage_is_never_converted_whatever_it_contains() {
        for (label, pending) in [("committed", false), ("pending", true)] {
            let fixture = legacy_fixture(&format!("legacy-ledger-{label}"), None);
            let ledger = write_legacy_lineage(
                &fixture.canonical_authority,
                &fixture.path_sha,
                "a-r1",
                pending,
            );

            assert_eq!(
                load_binding(&fixture.authority).unwrap_err(),
                DELIVERY_FOLDER_MOVED_OR_REPLACED,
                "{label}: a v1 ledger does not make a v1 record upgradable"
            );
            fixture.assert_untouched(Some(&ledger));
        }
    }

    /// The race Codex found is gone by construction, not by locking: a v1 ledger
    /// that advances between two attempts cannot be lost, because no attempt
    /// ever reads it into a v2 authority.
    #[cfg(target_os = "macos")]
    #[test]
    fn advancing_v1_lineage_between_attempts_changes_nothing() {
        let fixture = legacy_fixture("legacy-advance", None);
        write_legacy_lineage(
            &fixture.canonical_authority,
            &fixture.path_sha,
            "a-r1",
            false,
        );
        assert_eq!(
            load_binding(&fixture.authority).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );

        /* Exactly what a concurrent v1-capable build would do. */
        let advanced = write_legacy_lineage(
            &fixture.canonical_authority,
            &fixture.path_sha,
            "a-r2",
            false,
        );

        assert_eq!(
            load_binding(&fixture.authority).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );
        fixture.assert_untouched(Some(&advanced));
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.legacy_lineage()).unwrap()).unwrap();
        assert_eq!(stored["tips"][OBJECT_A]["revisionId"], "a-r2");
    }

    /// J. Structural half of the same property: no production code names a
    /// legacy type or filename on a write path, and the v1 ledger namespace is
    /// not referenced by production at all.
    #[test]
    fn no_production_path_derives_v2_authority_from_v1_state() {
        let source = include_str!("item11_delivery_destination.rs");
        let production = &source[..source.find("#[cfg(test)]").expect("test module boundary")];
        for forbidden in [
            "migrate_legacy",
            "expected_migrated",
            "reconcile_migrated",
            "LegacyDeliveryLineage",
            /* The quoted form: prose may describe the v1 ledger, but no
             * production string literal may name it, because naming it is the
             * only way to open or write it. */
            concat!("\"lineage.", "v1."),
        ] {
            assert!(
                !production.contains(forbidden),
                "production must not reference {forbidden}"
            );
        }
        /* The v1 authorization is still read — for classification only — so the
         * proof that it is not authority is that it never reaches a constructor. */
        assert_eq!(
            production.matches("LegacyAuthorizationBinding").count(),
            2,
            "the v1 record type appears only as its declaration and its one classify read"
        );
        assert!(production.contains("fn classify_legacy_authorization"));
    }

    /// I / 9. A legacy record is an invalid authorization, never an absent one —
    /// otherwise the delivery paths would create a default destination under a
    /// folder the owner already chose.
    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_presence_is_never_configuration_absent() {
        let fixture = legacy_fixture("legacy-not-absent", None);
        let verdict = load_binding(&fixture.authority).unwrap_err();
        assert_ne!(verdict, DELIVERY_FOLDER_NOT_CONFIGURED);
        assert_eq!(verdict, DELIVERY_FOLDER_MOVED_OR_REPLACED);
    }

    /// H. With nothing of either generation, the pre-existing not-configured
    /// semantics are unchanged.
    #[test]
    fn absent_authorization_of_either_generation_is_not_configured() {
        let root = TestRoot::new("absent-authorization");
        let authority = root.0.join("authority");
        fs::create_dir_all(&authority).unwrap();
        assert_eq!(
            load_binding(&authority).unwrap_err(),
            DELIVERY_FOLDER_NOT_CONFIGURED
        );
    }

    /// A malformed or unsafe legacy file is a security refusal, and must not be
    /// mistaken for an absent configuration either.
    #[test]
    fn malformed_or_unsafe_legacy_authorization_fails_closed() {
        for (label, bytes) in [
            ("not-json", b"{ not json".to_vec()),
            (
                "foreign-schema",
                serde_json::to_vec(&serde_json::json!({
                    "schema": "h2o.round2.item11.delivery-authorization.v3",
                    "canonicalPath": "/tmp/x", "canonicalPathSha256Hex": "a".repeat(64),
                    "destinationFolderLeafName": "x", "configuredPathMode": "absolute",
                    "deviceId": 1, "inode": 2, "ownerUid": 501,
                }))
                .unwrap(),
            ),
            (
                "unknown-field",
                serde_json::to_vec(&serde_json::json!({
                    "schema": AUTHORIZATION_SCHEMA_LEGACY,
                    "canonicalPath": "/tmp/x", "canonicalPathSha256Hex": "a".repeat(64),
                    "destinationFolderLeafName": "x", "configuredPathMode": "absolute",
                    "deviceId": 1, "inode": 2, "ownerUid": 501, "volumeIdentity": "x",
                }))
                .unwrap(),
            ),
        ] {
            let root = TestRoot::new(&format!("legacy-{label}"));
            let authority = root.0.join("authority");
            fs::create_dir_all(&authority).unwrap();
            fs::write(legacy_authorization_path(&authority), &bytes).unwrap();
            let verdict = load_binding(&authority).unwrap_err();
            assert_eq!(verdict, DELIVERY_FOLDER_INVALID, "{label}");
            assert_ne!(verdict, DELIVERY_FOLDER_NOT_CONFIGURED, "{label}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn legacy_authorization_that_is_a_symlink_is_refused() {
        use std::os::unix::fs::symlink;
        let root = TestRoot::new("legacy-symlink");
        let authority = root.0.join("authority");
        fs::create_dir_all(&authority).unwrap();
        let target = root.0.join("elsewhere.json");
        fs::write(&target, b"{}").unwrap();
        symlink(&target, legacy_authorization_path(&authority)).unwrap();
        assert_eq!(
            load_binding(&authority).unwrap_err(),
            DELIVERY_FOLDER_INVALID
        );
    }

    /// E. What the native picker mints is v2, built from live measurements, and
    /// it revalidates immediately with no migration step anywhere.
    #[cfg(target_os = "macos")]
    #[test]
    fn picker_created_binding_is_v2_and_revalidates() {
        let root = TestRoot::new("picker-v2");
        let authority = root.0.join("authority");
        let directory = root.0.join("destination");
        fs::create_dir(&directory).unwrap();
        let (canonical, _, inode) = destination_identity(&directory);
        let binding =
            binding_from_directory(&directory, ConfiguredPathMode::Absolute).expect("authorize");

        assert_eq!(binding.schema, AUTHORIZATION_SCHEMA);
        assert_eq!(binding.volume_identity_kind, VOLUME_IDENTITY_KIND);
        assert_eq!(
            binding.volume_identity,
            volume_identity(&canonical).unwrap()
        );
        assert_eq!(binding.inode, inode);
        assert_eq!(binding.owner_uid, current_uid());
        persist_binding(&authority, &binding).expect("persist v2");

        let canonical_authority = fs::canonicalize(&authority).unwrap();
        assert!(
            !legacy_authorization_path(&canonical_authority).exists(),
            "authorizing must never write a v1 record"
        );
        let loaded = load_binding(&authority).expect("read back");
        assert_eq!(loaded.volume_identity, binding.volume_identity);
        assert_eq!(revalidate_binding(&loaded).unwrap(), canonical);
    }

    /// A picker authorization taken while a legacy record sits beside it wins,
    /// and still leaves the legacy files alone.
    #[cfg(target_os = "macos")]
    #[test]
    fn picker_v2_supersedes_a_legacy_record_without_touching_it() {
        let fixture = legacy_fixture("picker-over-legacy", None);
        let ledger = write_legacy_lineage(
            &fixture.canonical_authority,
            &fixture.path_sha,
            "a-r1",
            false,
        );
        let binding =
            binding_from_directory(&fixture.directory, ConfiguredPathMode::Absolute).unwrap();
        persist_binding(&fixture.authority, &binding).unwrap();

        let loaded = load_binding(&fixture.authority).expect("v2 is now the authority");
        assert_eq!(loaded.volume_identity, binding.volume_identity);
        assert_eq!(
            fs::read(legacy_authorization_path(&fixture.canonical_authority)).unwrap(),
            fixture.authorization_bytes
        );
        assert_eq!(fs::read(fixture.legacy_lineage()).unwrap(), ledger);
        /* The v2 ledger namespace starts empty. It does not inherit a-r1. */
        assert_eq!(
            load_lineage(&fixture.canonical_authority, &loaded, WRITER_FP).unwrap(),
            None
        );
    }

    /// F. Reboot safety, both directions against one real directory: the ordinal
    /// the old guard trusted is gone, and the durable identity accepts.
    #[cfg(target_os = "macos")]
    #[test]
    fn durable_identity_ignores_the_device_ordinal() {
        let (_root, directory, binding) = authorized_fixture("durable-reboot");
        let (canonical, _, inode) = destination_identity(&directory);
        assert_eq!(revalidate_binding(&binding).unwrap(), canonical);
        assert!(validate_directory(
            &canonical,
            Some(ExpectedFolderIdentity {
                volume_identity: &binding.volume_identity,
                inode,
            }),
            current_uid(),
        )
        .is_ok());
        assert!(
            !serde_json::to_value(&binding)
                .unwrap()
                .as_object()
                .unwrap()
                .contains_key("deviceId"),
            "the ordinal is not persisted, so it cannot be compared"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn foreign_volume_identity_is_rejected() {
        let (_root, directory, binding) = authorized_fixture("foreign-volume");
        let (canonical, _, inode) = destination_identity(&directory);
        let mut foreign = binding.clone();
        foreign.volume_identity = FOREIGN_VOLUME.to_string();
        assert_ne!(foreign.volume_identity, binding.volume_identity);
        assert_eq!(
            revalidate_binding(&foreign).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );
        /* The same inode on a volume that is not the authorized one: inode
         * alone can never carry this, which is why the UUID term exists. */
        assert_eq!(
            validate_directory(
                &canonical,
                Some(ExpectedFolderIdentity {
                    volume_identity: FOREIGN_VOLUME,
                    inode,
                }),
                current_uid(),
            )
            .unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn foreign_inode_is_rejected_on_the_authorized_volume() {
        let (_root, _directory, binding) = authorized_fixture("foreign-inode");
        let mut foreign = binding.clone();
        foreign.inode = binding.inode.wrapping_add(1);
        assert_eq!(
            revalidate_binding(&foreign).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );
    }

    #[test]
    fn volume_identity_text_contract_is_fail_closed() {
        assert!(is_volume_identity("6b75311f-478b-4f0c-9d7d-b87b1b24c072"));
        for rejected in [
            "00000000-0000-0000-0000-000000000000",
            "6B75311F-478B-4F0C-9D7D-B87B1B24C072",
            "6b75311f478b4f0c9d7db87b1b24c072",
            "6b75311f-478b-4f0c-9d7d-b87b1b24c07",
            "6b75311f-478b-4f0c-9d7d-b87b1b24c0722",
            "6b75311f-478b-4f0c-9d7d-b87b1b24c07g",
            "6b75311f_478b_4f0c_9d7d_b87b1b24c072",
            "",
        ] {
            assert!(!is_volume_identity(rejected), "must reject {rejected:?}");
        }
        assert_eq!(
            format_uuid(&[
                0x6b, 0x75, 0x31, 0x1f, 0x47, 0x8b, 0x4f, 0x0c, 0x9d, 0x7d, 0xb8, 0x7b, 0x1b, 0x24,
                0xc0, 0x72
            ]),
            "6b75311f-478b-4f0c-9d7d-b87b1b24c072"
        );
    }

    /// A filesystem that does not carry the attribute is a refusal, never a
    /// fallback: `devfs` answers `getattrlist` with `EINVAL`.
    #[cfg(target_os = "macos")]
    #[test]
    fn filesystem_without_volume_identity_fails_closed() {
        assert_eq!(
            volume_identity(Path::new("/dev")).unwrap_err(),
            DELIVERY_FOLDER_INVALID
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn malformed_volume_identity_in_a_stored_binding_fails_closed() {
        let (_root, _directory, binding) = authorized_fixture("malformed-identity");
        for mutate in [0usize, 1, 2, 3] {
            let mut broken = binding.clone();
            match mutate {
                0 => broken.volume_identity = "00000000-0000-0000-0000-000000000000".into(),
                1 => broken.volume_identity = "not-a-uuid".into(),
                2 => broken.volume_identity_kind = "macos-volume-uuid".into(),
                _ => broken.schema = AUTHORIZATION_SCHEMA_LEGACY.into(),
            }
            assert_eq!(
                revalidate_binding(&broken).unwrap_err(),
                DELIVERY_FOLDER_INVALID
            );
        }
    }

    /// G. A present-but-corrupt v2 record is the current authority and is
    /// refused on its own terms. Reaching past it to a valid v1 record would let
    /// a damaged authority be silently downgraded.
    #[cfg(target_os = "macos")]
    #[test]
    fn corrupt_v2_never_falls_back_to_a_valid_v1() {
        let fixture = legacy_fixture("no-downgrade", None);
        let binding =
            binding_from_directory(&fixture.directory, ConfiguredPathMode::Absolute).unwrap();
        let sound = serde_json::to_value(&binding).unwrap();
        let v2_path = fixture.authorization_v2();

        let mut widened = sound.clone();
        widened["deviceId"] = serde_json::json!(1_u64);
        let mut foreign_schema = sound.clone();
        foreign_schema["schema"] = serde_json::json!("h2o.round2.item11.delivery-authorization.v3");
        for (label, corrupt) in [
            ("not-json", b"{ not json".to_vec()),
            (
                "truncated",
                serde_json::to_vec(&serde_json::json!({ "schema": AUTHORIZATION_SCHEMA })).unwrap(),
            ),
            ("device-ordinal", serde_json::to_vec(&widened).unwrap()),
            (
                "foreign-schema",
                serde_json::to_vec(&foreign_schema).unwrap(),
            ),
        ] {
            fs::write(&v2_path, &corrupt).unwrap();
            assert_eq!(
                load_binding(&fixture.authority).unwrap_err(),
                DELIVERY_FOLDER_INVALID,
                "{label}: a corrupt current authority must not fall back to v1"
            );
        }
    }

    #[cfg(all(unix, target_os = "macos"))]
    #[test]
    fn durable_binding_still_rejects_symlink_owner_and_mode_faults() {
        use std::os::unix::fs::symlink;
        let (_root, directory, binding) = authorized_fixture("durable-faults");
        let canonical = fs::canonicalize(&directory).unwrap();

        let link = canonical.parent().unwrap().join("link");
        symlink(&canonical, &link).unwrap();
        assert_eq!(
            validate_directory(&link, None, current_uid()).unwrap_err(),
            DELIVERY_FOLDER_SYMLINK_REJECTED
        );
        assert_eq!(
            validate_directory(&canonical, None, current_uid().wrapping_add(1)).unwrap_err(),
            DELIVERY_FOLDER_OWNER_MISMATCH
        );

        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o500)).unwrap();
        assert_eq!(
            revalidate_binding(&binding).unwrap_err(),
            DELIVERY_FOLDER_PERMISSION_DENIED
        );
        fs::set_permissions(&canonical, fs::Permissions::from_mode(0o700)).unwrap();

        let mut moved = binding.clone();
        moved.canonical_path_sha256_hex = "c".repeat(64);
        assert_eq!(
            revalidate_binding(&moved).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );
        let mut renamed = binding.clone();
        renamed.destination_folder_leaf_name = "different".into();
        assert_eq!(
            revalidate_binding(&renamed).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED
        );
    }

    /// The ordinal must be gone from the persisted surfaces entirely — a field
    /// nobody may trust should not be written for a future reader to find.
    #[cfg(target_os = "macos")]
    #[test]
    fn persisted_v2_surfaces_carry_no_device_ordinal() {
        let (_root, directory, binding) = authorized_fixture("no-ordinal");
        let authorization = serde_json::to_value(&binding).unwrap();
        let lineage =
            serde_json::to_value(DeliveryLineage::empty(&binding, WRITER_FP, NOW)).unwrap();
        for (label, value) in [("authorization", &authorization), ("lineage", &lineage)] {
            let object = value.as_object().expect("object");
            assert!(
                !object.contains_key("deviceId") && !object.contains_key("destinationDeviceId"),
                "{label} must not persist a device ordinal"
            );
        }
        assert_eq!(
            authorization["volumeIdentityKind"].as_str(),
            Some(VOLUME_IDENTITY_KIND)
        );
        assert_eq!(
            lineage["destinationVolumeIdentityKind"].as_str(),
            Some(VOLUME_IDENTITY_KIND)
        );
        assert_eq!(
            authorization["volumeIdentity"].as_str(),
            volume_identity(&fs::canonicalize(&directory).unwrap())
                .ok()
                .as_deref()
        );
    }

    /// K. A v2 ledger that starts without migrated tips must not let an ahead
    /// destination slot be overwritten — the pre-existing safety rule is what
    /// carries the loss the removed migration used to prevent.
    #[cfg(target_os = "macos")]
    #[test]
    fn empty_v2_lineage_still_refuses_an_ahead_slot() {
        let (_root, _directory, binding) = authorized_fixture("slot-ahead-empty");
        let empty = DeliveryLineage::empty(&binding, WRITER_FP, NOW);
        let observed = ObservedDelivery {
            object_key: OBJECT_A.into(),
            revision_id: "a-r1".into(),
            previous_revision_id: None,
            revision_blob_sha256_hex: blob("a-r1"),
            delivery_sha256_hex: delivery("a-r1"),
            produced_at_iso: NOW.into(),
        };
        /* No tip for this object, so a visible package is "behind" the ledger's
         * empty view — which is exactly the state the ahead check refuses. */
        assert_eq!(
            classify_slot_posture(Some(&observed), OBJECT_A, &empty),
            LocalDeliverySlotPosture::SameObjectBehind
        );
        assert!(resolve_tip(&empty, OBJECT_A).is_none());
        assert!(empty.pending.is_none());
    }

    /* ── persisted authorization outranks the caller's config flag ────────
     *
     * `configurationAbsent` reports what the Studio-side sync config says, not
     * what is on disk. Choosing the branch from it let a request walk straight
     * into `default_binding` while a recognizable v1 record sat in the
     * authorization directory — minting a v2 binding for a freshly created
     * default folder and delivering into it, with the refusal that should have
     * routed the owner to Change Folder never happening. These drive the real
     * preparation path, not the classifier. */

    fn legacy_authority_with(label: &str) -> (TestRoot, PathBuf, PathBuf, Vec<u8>) {
        let root = TestRoot::new(label);
        let home = root.0.join("home");
        let directory = home.join("Chosen Destination");
        fs::create_dir_all(&directory).unwrap();
        let authority = root.0.join("authority");
        let bytes = write_legacy_authorization(&authority, &directory, None);
        (root, home, authority, bytes)
    }

    fn absent_config_request(expected_hash: &str) -> Item11PrepareDeliveryRequest {
        Item11PrepareDeliveryRequest {
            delivery_json: envelope("object-a"),
            object_id: "object-a".into(),
            expected_destination_path_sha256_hex: expected_hash.into(),
            destination_configured_path_mode: ConfiguredPathMode::Relative,
            configuration_absent: true,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_authorization_outranks_configuration_absent() {
        let (root, home, authority, legacy_bytes) = legacy_authority_with("legacy-vs-absent");
        let default_destination = home.join(DEFAULT_FOLDER);
        let request = absent_config_request(&"a".repeat(64));

        assert_eq!(
            prepare_delivery_core(&authority, &home, &request, FaultStage::None).unwrap_err(),
            DELIVERY_FOLDER_MOVED_OR_REPLACED,
            "a recognizable v1 record must refuse, not default"
        );

        let canonical_authority = fs::canonicalize(&authority).unwrap();
        assert!(
            !authorization_paths(&canonical_authority).0.exists(),
            "no v2 authorization may be minted"
        );
        assert_eq!(
            fs::read(legacy_authorization_path(&canonical_authority)).unwrap(),
            legacy_bytes,
            "the v1 record is evidence and is never rewritten"
        );
        assert!(
            !default_destination.exists(),
            "no default destination may be created behind the owner's chosen folder"
        );
        assert!(!home.join(DEFAULT_FOLDER).join(DELIVERY_FILE).exists());
        assert!(!root
            .0
            .join("home/Chosen Destination")
            .join(DELIVERY_FILE)
            .exists());
    }

    #[test]
    fn malformed_legacy_authorization_outranks_configuration_absent() {
        let root = TestRoot::new("malformed-legacy-vs-absent");
        let home = root.0.join("home");
        fs::create_dir_all(&home).unwrap();
        let authority = root.0.join("authority");
        fs::create_dir_all(&authority).unwrap();
        fs::write(legacy_authorization_path(&authority), b"{ not json").unwrap();
        let request = absent_config_request(&"a".repeat(64));

        assert_eq!(
            prepare_delivery_core(&authority, &home, &request, FaultStage::None).unwrap_err(),
            DELIVERY_FOLDER_INVALID
        );
        assert!(
            !home.join(DEFAULT_FOLDER).exists(),
            "no default may be created"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn valid_v2_outranks_configuration_absent() {
        let root = TestRoot::new("v2-vs-absent");
        let home = root.0.join("home");
        let directory = home.join("Chosen Destination");
        fs::create_dir_all(&directory).unwrap();
        let authority = root.0.join("authority");
        let binding = binding_from_directory(&directory, ConfiguredPathMode::Absolute).unwrap();
        persist_binding(&authority, &binding).unwrap();

        /* The mode disagrees with the v2 record, which is how we can tell the
         * v2 record was consulted rather than the default path taken. */
        let request = absent_config_request(&binding.canonical_path_sha256_hex);
        assert_eq!(
            prepare_delivery_core(&authority, &home, &request, FaultStage::None).unwrap_err(),
            DELIVERY_FOLDER_CONFIG_MISMATCH
        );
        assert!(
            !home.join(DEFAULT_FOLDER).exists(),
            "no default redirection"
        );

        let mut honest = request.clone();
        honest.destination_configured_path_mode = ConfiguredPathMode::Absolute;
        let result =
            prepare_delivery_core(&authority, &home, &honest, FaultStage::None).expect("v2 wins");
        assert_eq!(
            result.destination_path_sha256_hex,
            binding.canonical_path_sha256_hex
        );
        assert!(fs::canonicalize(&directory)
            .unwrap()
            .join(DELIVERY_FILE)
            .exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn corrupt_v2_outranks_configuration_absent_and_never_downgrades() {
        let (_root, home, authority, legacy_bytes) = legacy_authority_with("corrupt-v2-vs-absent");
        let canonical_authority = fs::canonicalize(&authority).unwrap();
        fs::write(authorization_paths(&canonical_authority).0, b"{ not json").unwrap();
        let request = absent_config_request(&"a".repeat(64));

        assert_eq!(
            prepare_delivery_core(&authority, &home, &request, FaultStage::None).unwrap_err(),
            DELIVERY_FOLDER_INVALID
        );
        assert!(
            !home.join(DEFAULT_FOLDER).exists(),
            "no default redirection"
        );
        assert_eq!(
            fs::read(legacy_authorization_path(&canonical_authority)).unwrap(),
            legacy_bytes,
            "a corrupt v2 must not be repaired from v1 either"
        );
    }

    /// Defaulting stays reachable for the case it was built for: nothing of
    /// either generation on disk.
    #[test]
    fn true_absence_still_reaches_the_default_binding() {
        let root = TestRoot::new("true-absence");
        let home = root.0.join("home");
        fs::create_dir(&home).unwrap();
        let authority = root.0.join("authority");
        assert!(!authority.exists(), "no authorization directory at all");
        let expected = home.join(DEFAULT_FOLDER);
        fs::create_dir(&expected).unwrap();
        let hash = sha256_hex(
            fs::canonicalize(&expected)
                .unwrap()
                .to_str()
                .unwrap()
                .as_bytes(),
        );

        let result = prepare_delivery_core(
            &authority,
            &home,
            &absent_config_request(&hash),
            FaultStage::None,
        )
        .expect("true absence may still default");
        assert_eq!(result.destination_path_sha256_hex, hash);
    }

    /* ── an unexplained destination slot is never overwritten ─────────────
     *
     * After a reauthorization the v2 ledger starts empty while the destination
     * slot still holds whatever was last delivered. The refusal used to be
     * gated on the visible package having a parent, which exempted roots — so
     * one unrelated root could silently replace another. What makes a slot safe
     * to move past is trusted lineage explaining it, not its chain position. */

    #[cfg(target_os = "macos")]
    #[test]
    fn empty_ledger_refuses_an_existing_root_slot() {
        let harness = local_harness("unexplained-root-slot");
        harness.deliver("object-a", "a-r1");
        let slot_before = harness.slot_bytes();
        harness.forget_ledger();
        assert_eq!(harness.ledger(), None, "the ledger starts empty");

        let request = harness.request("object-a", "a-r2");
        assert_eq!(
            harness.prepare(&request).unwrap_err(),
            LOCAL_DELIVERY_SLOT_AHEAD,
            "an unrelated root must not replace a root the ledger cannot explain"
        );
        assert_eq!(harness.slot_bytes(), slot_before, "slot bytes unchanged");
        assert_eq!(harness.ledger(), None, "no tip and no pending were created");
        assert!(!harness.directory.join(TEMPORARY_FILE).exists());
    }

    /// The same invariant stated directly: two roots for one object are not
    /// interchangeable just because neither has a parent.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_root_slot_is_not_replaceable_merely_because_both_are_roots() {
        let harness = local_harness("root-vs-root");
        let first = harness.deliver("object-a", "a-r1");
        assert_eq!(first.previous_revision_id, None, "the slot holds a root");
        harness.forget_ledger();

        let request = harness.request("object-a", "a-r9");
        let refusal = harness.prepare(&request).unwrap_err();
        assert_eq!(refusal, LOCAL_DELIVERY_SLOT_AHEAD);
        let observed = observe_delivery_slot(&harness.directory).unwrap().unwrap();
        assert_eq!(observed.revision_id, "a-r1");
        assert_eq!(
            observed.previous_revision_id, None,
            "the surviving slot is still the original root"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn empty_ledger_still_refuses_an_existing_child_slot() {
        let harness = local_harness("unexplained-child-slot");
        harness.deliver("object-a", "a-r1");
        let child = harness.deliver("object-a", "a-r2");
        assert_eq!(child.previous_revision_id.as_deref(), Some("a-r1"));
        let slot_before = harness.slot_bytes();
        harness.forget_ledger();

        let request = harness.request("object-a", "a-r3");
        assert_eq!(
            harness.prepare(&request).unwrap_err(),
            LOCAL_DELIVERY_SLOT_AHEAD
        );
        assert_eq!(harness.slot_bytes(), slot_before);
        assert_eq!(harness.ledger(), None);
    }

    /// The load-bearing case: the visible package carries exactly the revision
    /// id being requested, and the ledger still cannot account for it. Two
    /// writers can choose the same id, and pending intent is durable before any
    /// bytes become visible, so a matching id proves nothing on its own.
    #[cfg(target_os = "macos")]
    #[test]
    fn empty_ledger_refuses_a_slot_holding_the_requested_root_revision() {
        let harness = local_harness("unexplained-same-root-revision");
        harness.deliver("object-a", "a-r1");
        let slot_before = harness.slot_bytes();
        harness.forget_ledger();
        assert_eq!(harness.ledger(), None, "the ledger starts empty");

        let request = harness.request("object-a", "a-r1");
        assert_eq!(
            harness.prepare(&request).unwrap_err(),
            LOCAL_DELIVERY_SLOT_AHEAD,
            "a matching revision id is not lineage"
        );
        assert_eq!(harness.slot_bytes(), slot_before, "slot bytes unchanged");
        assert_eq!(harness.ledger(), None, "no tip and no pending were created");
        assert!(
            !harness.ledger_path().exists(),
            "no ledger was written at all"
        );
        assert!(!harness.directory.join(TEMPORARY_FILE).exists());
        let observed = observe_delivery_slot(&harness.directory).unwrap().unwrap();
        assert_eq!(observed.revision_id, "a-r1");
        assert_eq!(observed.previous_revision_id, None);
    }

    /// The same rule, with a child in the slot: it is not ROOT-specific.
    #[cfg(target_os = "macos")]
    #[test]
    fn empty_ledger_refuses_a_slot_holding_the_requested_child_revision() {
        let harness = local_harness("unexplained-same-child-revision");
        harness.deliver("object-a", "a-r1");
        let child = harness.deliver("object-a", "a-r2");
        assert_eq!(child.previous_revision_id.as_deref(), Some("a-r1"));
        let slot_before = harness.slot_bytes();
        harness.forget_ledger();

        let request = harness.request("object-a", "a-r2");
        assert_eq!(
            harness.prepare(&request).unwrap_err(),
            LOCAL_DELIVERY_SLOT_AHEAD
        );
        assert_eq!(harness.slot_bytes(), slot_before);
        assert_eq!(harness.ledger(), None);
    }

    /// The distinction the rule turns on: the very same request succeeds when a
    /// trusted committed tip explains the slot.
    #[cfg(target_os = "macos")]
    #[test]
    fn trusted_committed_tip_still_replays_the_same_revision() {
        let harness = local_harness("trusted-replay-same-revision");
        harness.deliver("object-a", "a-r1");
        let slot_before = harness.slot_bytes();
        let tip_before = harness.ledger().unwrap().tips[&object_key_hex("object-a")].clone();

        let request = harness.request("object-a", "a-r1");
        let replay = harness
            .prepare(&request)
            .expect("committed replay is explained");
        assert_eq!(replay.revision_id, "a-r1");
        assert_eq!(
            harness.slot_bytes(),
            slot_before,
            "a replay reproduces the same bytes"
        );
        assert_eq!(
            harness.ledger().unwrap().tips[&object_key_hex("object-a")],
            tip_before,
            "and does not advance the tip"
        );
    }

    /// And when a trusted pending intent explains it: the interrupted write is
    /// still recoverable, which is the case the removed exemption was masking.
    #[cfg(target_os = "macos")]
    #[test]
    fn trusted_pending_still_recovers_the_same_revision() {
        let harness = local_harness("trusted-pending-same-revision");
        harness.deliver("object-a", "a-r1");
        let request = harness.request("object-a", "a-r2");
        harness
            .prepare_with_fault(&request, LocalFaultStage::AfterPendingBeforeDelivery)
            .expect_err("interrupt after the pending intent is durable");
        let pending = harness.ledger().unwrap().pending.expect("pending survives");
        assert_eq!(pending.revision_id, "a-r2");

        let retry = harness
            .prepare(&request)
            .expect("pending explains the retry");
        assert_eq!(retry.revision_id, "a-r2");
        assert_eq!(
            harness.ledger().unwrap().tips[&object_key_hex("object-a")].revision_id,
            "a-r2"
        );
        assert!(harness.ledger().unwrap().pending.is_none());
    }

    /// An empty ledger alone blocks nothing: with no slot to explain, the first
    /// v2 delivery proceeds under ordinary root semantics.
    #[cfg(target_os = "macos")]
    #[test]
    fn empty_ledger_with_no_slot_delivers_the_first_root() {
        let harness = local_harness("first-root-after-reauth");
        assert_eq!(harness.ledger(), None);
        assert!(!harness.directory.join(DELIVERY_FILE).exists());

        let result = harness.deliver("object-a", "a-r1");
        assert_eq!(result.previous_revision_id, None);
        assert_eq!(result.revision_id, "a-r1");
        assert_eq!(
            harness.ledger().unwrap().tips[&object_key_hex("object-a")].revision_id,
            "a-r1"
        );
    }

    /// The refusal must turn on trusted lineage alone. Neither the visible
    /// package's chain position nor its revision id may exempt it — both were
    /// live exemptions once, and both are pinned out here so neither can return
    /// quietly. The behavioural halves are the prepare-path tests above.
    #[test]
    fn unexplained_slot_refusal_consults_only_trusted_lineage() {
        let source = include_str!("item11_delivery_destination.rs");
        let production = &source[..source.find("#[cfg(test)]").expect("test module boundary")];
        let guard = production
            .split("let unexplained = ")
            .nth(1)
            .expect("the unexplained-slot guard")
            .split("}\n")
            .next()
            .expect("guard body");
        assert!(
            !guard.contains("previous_revision_id"),
            "the unexplained-slot refusal must not consult the visible package's parent"
        );
        assert!(
            !guard.contains("request.revision_id"),
            "the unexplained-slot refusal must not exempt a slot whose revision id \
             happens to match the request — an id is not lineage"
        );
        /* What it must consult: trusted committed and pending state. */
        assert!(guard.contains("resolve_tip"));
        assert!(guard.contains("lineage.pending.is_none()"));
        assert!(guard.contains("LOCAL_DELIVERY_SLOT_AHEAD"));
    }
}
