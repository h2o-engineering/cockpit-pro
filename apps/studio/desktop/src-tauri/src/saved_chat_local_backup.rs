//! Native Saved-Chat local backup publisher — Backup v1 T02.
//!
//! Authority: the accepted T01 contract
//! (`missions/manual-local-saved-chat-backup-v1/t01-local-backup-v1-contract.md`,
//! Management) and its reflection in `docs/systems/archive/saved-chat-local-backup.md`.
//! This module implements the §9 session-bound staged publisher, the §13
//! durability order, the §14 own-cleanup rule, the §15 verification model and
//! the §17 error vocabulary — and NOTHING ELSE. It composes the landed
//! filesystem primitives (`archive_durable_write::confined::Dir`,
//! `sync_file_contents`), the trusted package verifier
//! (`archive_generation_publish::verify_occupant_all_supported`) and the
//! trusted package scanner (`archive_package_scan::scan_packages_within`)
//! exactly as they exist on Product main; it reimplements no mutating
//! syscall wrapper, no hashing primitive and no package semantics.
//!
//! WHAT THE RENDERER MAY NAME: a session token, a declared enumeration of
//! `(chatId, snapshotId)` pairs, a member KIND (plus the canonical asset
//! name), bytes, byte lengths, an `expectedContentHash`, failure records and
//! a governed final leaf chosen from the native list. It never names a root,
//! a path, a staging name, a package leaf, a `backupId`, a `complete` flag or
//! any timestamp that bears on identity or validity.
//!
//! THE PROTOCOL (§9):
//!
//! ```text
//! BEGIN {enumeration}                                   -> {token, backupId, stagingLeaf}
//! PACKAGE_BEGIN {token, chatId, snapshotId}             (stage opened BEFORE the projection)
//! WRITE_MEMBER {token, member, final?, byteLength?} + chunk  (repeatable; one open member at a time)
//! PACKAGE_FINISH {token, expectedContentHash}           (verify, bind, promote create-only)
//! PACKAGE_ABORT {token, reason}                         (own stage removed)
//! FINALIZE {token, failures}                            (manifest, set scan, run promotion)
//! ABORT {token}                                         (own staging tree removed)
//! LIST / VERIFY {leaf}                                  (read-only)
//! ```
//!
//! SOURCE NON-MUTATION (§19): this module opens nothing under the archive,
//! the CAS, the database or Sync state. Its only root is
//! `<base>/H2O Studio Backups` (`saved_chat_backup_root_policy`).
//!
//! OWN-CLEANUP ONLY (§14): a session removes only names it created in THIS
//! session, identity-checked where a handle or identity was retained. Residue
//! from other sessions is LISTED and CLASSIFIED, never removed. No retention,
//! rotation, GC or purge authority exists here.
//!
//! PLATFORM (§12): macOS is the v1 acceptance target. Every other target is
//! FAIL_CLOSED: BEGIN refuses `backup-unsupported-platform` before touching
//! the filesystem, and the non-Unix arm refuses every command.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

/// Backup manifest schema string (`backup-manifest.json`, contract §3/§8).
pub const BACKUP_OBJECT_SCHEMA: &str = "h2o.savedChatLocalBackup.v1";
pub const BACKUP_SCHEMA_VERSION: u64 = 1;

/// Backup-owned reserved staging prefixes (§3.3). Deliberately NOT added to
/// the archive's `RESERVED_COMPONENT_PREFIXES`: that list is accepted-T02
/// shared surface and the backup root is a different root.
pub(crate) const RUN_STAGING_PREFIX: &str = ".h2o-backupstage-";
pub(crate) const PACKAGE_STAGING_PREFIX: &str = ".h2o-bkpkg-";
pub(crate) const MANIFEST_STAGING_PREFIX: &str = ".h2o-bkmanifest-";
pub(crate) const MANIFEST_STAGING_SUFFIX: &str = ".tmp";
pub(crate) const BACKUP_RESERVED_PREFIXES: &[&str] = &[
    RUN_STAGING_PREFIX,
    PACKAGE_STAGING_PREFIX,
    MANIFEST_STAGING_PREFIX,
];

/// Final leaf grammar (§3.2): `<backupId>.h2obackup` for a complete set,
/// `<backupId>.partial.h2obackup` for an explicitly incomplete one (§10).
pub const FINAL_COMPLETE_SUFFIX: &str = ".h2obackup";
pub const FINAL_PARTIAL_SUFFIX: &str = ".partial.h2obackup";
pub const BACKUP_MANIFEST_NAME: &str = "backup-manifest.json";
const PACKAGES_DIR: &str = "packages";
const ASSETS_DIR: &str = "assets";
const SNAPSHOT_MEMBER: &str = "snapshot.json";
const MANIFEST_MEMBER: &str = "manifest.json";

/// Writer-side manifest bound (§8, NB-07) and the identical VERIFY read cap.
/// One allocation constant, not a product limit.
pub const BACKUP_MANIFEST_MAX_BYTES: u64 = 256 * 1024 * 1024;
pub const BACKUP_MANIFEST_READ_CAP_BYTES: u64 = BACKUP_MANIFEST_MAX_BYTES;

/// One active session per process (§9): a backup is whole-library.
pub const MAX_ACTIVE_BACKUP_SESSIONS: usize = 1;
/// Publisher precedent: idle sessions are evicted lazily after 15 minutes.
pub(crate) const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Transport/allocation bound for ONE `write_member` chunk (§18), NOT a
/// member ceiling.
pub const CHUNK_CAP_BYTES: u64 = 8 * 1024 * 1024;
const STAGING_NAME_ATTEMPTS: u32 = 8;
const FAILURE_DETAIL_MAX_BYTES: usize = 512;
const CONSISTENCY_MODEL: &str = "per-entry-guarded-enumeration-time-set";
const ASSET_SOURCE: &str = "projection";
const CONSTRUCTION_FAMILY_V3: &str = "v3";

/// Compile-time platform arm (§12). Only macOS composes the create-only
/// directory promotion this publisher needs; everything else fails closed.
#[cfg(target_os = "macos")]
pub(crate) const PLATFORM_FAMILY: Option<&str> = Some("macos");
#[cfg(not(target_os = "macos"))]
pub(crate) const PLATFORM_FAMILY: Option<&str> = None;

// ── Wire results (§9) ──────────────────────────────────────────────────────

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformFact {
    pub supported: bool,
    pub family: Option<&'static str>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginResult {
    pub ok: bool,
    pub status: String,
    /// Opaque decimal text (the publisher's `ipc_token` rule): JSON numbers
    /// lose u64 precision in the WebView.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub staging_leaf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<PlatformFact>,
}

impl BeginResult {
    pub(crate) fn refused(code: &str) -> Self {
        BeginResult {
            ok: false,
            status: code.to_string(),
            token: None,
            backup_id: None,
            staging_leaf: None,
            platform: None,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AckResult {
    pub ok: bool,
    pub status: String,
}

impl AckResult {
    pub(crate) fn ok(status: &str) -> Self {
        AckResult {
            ok: true,
            status: status.to_string(),
        }
    }
    pub(crate) fn refused(code: &str) -> Self {
        AckResult {
            ok: false,
            status: code.to_string(),
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AbortResult {
    pub ok: bool,
    pub status: String,
    pub cleanup_incomplete: bool,
}

impl AbortResult {
    pub(crate) fn aborted(cleanup_incomplete: bool) -> Self {
        AbortResult {
            ok: true,
            status: "aborted".to_string(),
            cleanup_incomplete,
        }
    }
    pub(crate) fn refused(code: &str) -> Self {
        AbortResult {
            ok: false,
            status: code.to_string(),
            cleanup_incomplete: false,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub ok: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_sha256: Option<String>,
    /// Additive diagnostics (e.g. `backup-cleanup-incomplete`); never the
    /// primary status.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub codes: Vec<String>,
}

impl WriteResult {
    pub(crate) fn refused(code: &str) -> Self {
        WriteResult {
            ok: false,
            status: code.to_string(),
            member_bytes: None,
            member_sha256: None,
            codes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntrySnapshot {
    pub encoding: String,
    pub physical_sha256: String,
    pub physical_byte_length: u64,
    pub logical_sha256: String,
    pub logical_byte_length: u64,
}

/// One verified package of the set (§8 `entries[]`). Authored natively from
/// the trusted verifier's facts; never from renderer claims.
#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub chat_id: String,
    pub snapshot_id: String,
    /// Contract form `sha256-<64 lowercase hex>`.
    pub content_hash: String,
    pub package_leaf: String,
    pub construction_family: String,
    pub schema_version: u64,
    pub payload_version: u64,
    pub snapshot: EntrySnapshot,
    pub members: Vec<String>,
    pub assets: Vec<String>,
    pub asset_source: String,
    pub saved_at: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackageFinishResult {
    pub ok: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<ManifestEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub codes: Vec<String>,
}

impl PackageFinishResult {
    pub(crate) fn refused(code: &str) -> Self {
        PackageFinishResult {
            ok: false,
            status: code.to_string(),
            entry: None,
            codes: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, serde::Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkippedCounts {
    pub deleted: u64,
    pub tombstoned: u64,
    pub linked_only: u64,
    pub no_snapshot: u64,
}

#[derive(Clone, Copy, Debug, serde::Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub enumerated: u64,
    pub eligible: u64,
    pub success: u64,
    pub failed: u64,
    pub skipped: SkippedCounts,
}

impl Counts {
    /// The two §4 identities every manifest must satisfy.
    pub(crate) fn identities_hold(&self) -> bool {
        let skipped = self.skipped;
        let enumerated = self
            .eligible
            .checked_add(skipped.deleted)
            .and_then(|n| n.checked_add(skipped.tombstoned))
            .and_then(|n| n.checked_add(skipped.no_snapshot));
        let eligible = self.success.checked_add(self.failed);
        enumerated == Some(self.enumerated) && eligible == Some(self.eligible)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeResult {
    pub ok: bool,
    pub status: String,
    /// Whether the run directory was promoted. A fence failure AFTER the
    /// commit point is reported as `committed: true, durabilityComplete:
    /// false` (I09), never as "nothing happened".
    pub committed: bool,
    pub durability_complete: bool,
    pub full_fsync: bool,
    pub backup_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_leaf: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counts: Option<Counts>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub set_digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_sha256: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub codes: Vec<String>,
}

impl FinalizeResult {
    pub(crate) fn refused(backup_id: &str, code: &str) -> Self {
        FinalizeResult {
            ok: false,
            status: code.to_string(),
            committed: false,
            durability_complete: false,
            full_fsync: false,
            backup_id: backup_id.to_string(),
            backup_leaf: None,
            complete: None,
            counts: None,
            set_digest: None,
            manifest_sha256: None,
            codes: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub leaf: String,
    /// `backup` | `backup-partial` | `staging-residue` | `foreign`, by SHAPE
    /// only (§14).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_present: Option<bool>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub ok: bool,
    pub status: String,
    pub root_present: bool,
    pub root_display_path: String,
    pub entries: Vec<ListEntry>,
    pub residue_count: u64,
    pub codes: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    /// `valid-complete` | `valid-incomplete` | `malformed` | `unsupported` |
    /// `unreadable` (§15).
    pub status: String,
    pub codes: Vec<String>,
    pub backup_id: Option<String>,
    pub complete: Option<bool>,
    pub counts: Option<Counts>,
    pub set_digest: Option<String>,
    pub entries_verified: u64,
    pub occupants_seen: u64,
}

impl VerifyResult {
    pub(crate) fn failed(status: &str, code: &str) -> Self {
        VerifyResult {
            status: status.to_string(),
            codes: vec![code.to_string()],
            backup_id: None,
            complete: None,
            counts: None,
            set_digest: None,
            entries_verified: 0,
            occupants_seen: 0,
        }
    }
}

// ── Declarations (renderer input, §4/§9) ───────────────────────────────────

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EligiblePair {
    pub chat_id: String,
    pub snapshot_id: String,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDeclaration {
    #[serde(default)]
    pub app_build_stamp: Option<String>,
}

/// The enumeration the renderer performed through the store adapters (§4).
/// Diagnostics only except for `eligible`, which is the declared set the
/// native registry is later checked against.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumerationDeclaration {
    #[serde(default)]
    pub at: String,
    pub eligible: Vec<EligiblePair>,
    #[serde(default)]
    pub skipped: SkippedCounts,
    #[serde(default)]
    pub enumerated_count: u64,
    #[serde(default)]
    pub source: SourceDeclaration,
}

impl<'de> serde::Deserialize<'de> for SkippedCounts {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            #[serde(default)]
            deleted: u64,
            #[serde(default)]
            tombstoned: u64,
            #[serde(default)]
            linked_only: u64,
            #[serde(default)]
            no_snapshot: u64,
        }
        let raw = Raw::deserialize(deserializer)?;
        Ok(SkippedCounts {
            deleted: raw.deleted,
            tombstoned: raw.tombstoned,
            linked_only: raw.linked_only,
            no_snapshot: raw.no_snapshot,
        })
    }
}

/// One renderer-declared failure record (§8 `failures[]`).
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureDeclaration {
    pub chat_id: String,
    pub snapshot_id: String,
    pub code: String,
    #[serde(default)]
    pub stage: String,
    #[serde(default)]
    pub detail: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberSelector {
    /// `snapshot` | `manifest` | `asset` — an ENUM; the filename is derived
    /// here (only `asset` carries its canonical name).
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
}

// ── Grammars (§3) ──────────────────────────────────────────────────────────

const BACKUP_ID_TIMESTAMP_LEN: usize = 16; // YYYYMMDDTHHMMSSZ
const BACKUP_ID_ENTROPY_LEN: usize = 16;
const BACKUP_ID_LEN: usize = BACKUP_ID_TIMESTAMP_LEN + 1 + BACKUP_ID_ENTROPY_LEN;

/// `BACKUP_ID_GRAMMAR`: `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}$`.
pub(crate) fn is_backup_id(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != BACKUP_ID_LEN {
        return false;
    }
    b[0..8].iter().all(u8::is_ascii_digit)
        && b[8] == b'T'
        && b[9..15].iter().all(u8::is_ascii_digit)
        && b[15] == b'Z'
        && b[16] == b'-'
        && b[17..]
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

/// Parses a final leaf into `(backupId, partial)`; `None` when the leaf is
/// outside the final grammar.
pub(crate) fn parse_final_leaf(leaf: &str) -> Option<(String, bool)> {
    let (stem, partial) = if let Some(stem) = leaf.strip_suffix(FINAL_PARTIAL_SUFFIX) {
        (stem, true)
    } else if let Some(stem) = leaf.strip_suffix(FINAL_COMPLETE_SUFFIX) {
        (stem, false)
    } else {
        return None;
    };
    if is_backup_id(stem) {
        Some((stem.to_string(), partial))
    } else {
        None
    }
}

pub(crate) fn final_leaf(backup_id: &str, complete: bool) -> String {
    if complete {
        format!("{backup_id}{FINAL_COMPLETE_SUFFIX}")
    } else {
        format!("{backup_id}{FINAL_PARTIAL_SUFFIX}")
    }
}

pub(crate) fn is_backup_reserved_name(name: &str) -> bool {
    BACKUP_RESERVED_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// Windows reserved device stems (filesystem contract §12), refused
/// ASCII-case-insensitively as the whole stem and as the segment before the
/// first `.` (§3.4). Stated for every governed leaf even though v1 runs on
/// macOS only, so a backup written here never carries a name a later
/// certified platform could not read.
pub(crate) fn has_windows_reserved_stem(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("");
    let upper = stem.to_ascii_uppercase();
    match upper.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => {
            (upper.starts_with("COM") || upper.starts_with("LPT"))
                && upper.len() == 4
                && upper.as_bytes()[3].is_ascii_digit()
        }
    }
}

/// Canonical asset member name: `sha256-<64 lowercase hex>.<ext>` with
/// `ext` in `[a-z0-9]{1,16}` (§7). Returns the bare hex when admitted.
pub(crate) fn parse_asset_member_name(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("sha256-")?;
    let bytes = rest.as_bytes();
    if bytes.len() < 64 + 2
        || !bytes[..64]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    {
        return None;
    }
    // The first 64 bytes are ASCII hex, so 64 is a char boundary.
    let (hex, tail) = rest.split_at(64);
    let ext = tail.strip_prefix('.')?;
    if ext.is_empty()
        || ext.len() > 16
        || !ext
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return None;
    }
    Some(hex)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MemberKind {
    Snapshot,
    Manifest,
    Asset,
}

/// A renderer member selector resolved to the native member location. The
/// renderer never supplies a filename for application members.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct MemberTarget {
    pub(crate) kind: MemberKind,
    /// Basename inside its directory.
    pub(crate) basename: String,
    /// Package-relative path as the verifier reports `persistent_members`.
    pub(crate) relative: String,
    /// Bare hex the closing member hash must equal (assets only).
    pub(crate) bound_hex: Option<String>,
}

pub(crate) fn resolve_member(selector: &MemberSelector) -> Result<MemberTarget, &'static str> {
    match selector.kind.as_str() {
        "snapshot" | "manifest" => {
            if selector.name.is_some() {
                return Err("backup-invalid-member-name");
            }
            let (kind, basename) = if selector.kind == "snapshot" {
                (MemberKind::Snapshot, SNAPSHOT_MEMBER)
            } else {
                (MemberKind::Manifest, MANIFEST_MEMBER)
            };
            Ok(MemberTarget {
                kind,
                basename: basename.to_string(),
                relative: basename.to_string(),
                bound_hex: None,
            })
        }
        "asset" => {
            let name = selector
                .name
                .as_deref()
                .ok_or("backup-invalid-member-name")?;
            let hex = parse_asset_member_name(name).ok_or("backup-invalid-member-name")?;
            Ok(MemberTarget {
                kind: MemberKind::Asset,
                basename: name.to_string(),
                relative: format!("{ASSETS_DIR}/{name}"),
                bound_hex: Some(hex.to_string()),
            })
        }
        _ => Err("backup-invalid-member-name"),
    }
}

// ── Timestamps (native clock, diagnostics only) ───────────────────────────

/// Proleptic Gregorian civil date from days since 1970-01-01 (Howard
/// Hinnant's `civil_from_days`). No calendar crate feature is required.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// UTC calendar fields of a millisecond epoch value.
fn utc_fields(millis: u64) -> (i64, u32, u32, u32, u32, u32, u32) {
    let secs = (millis / 1000) as i64;
    let ms = (millis % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400) as u32;
    let (y, mo, d) = civil_from_days(days);
    (y, mo, d, sod / 3600, (sod % 3600) / 60, sod % 60, ms)
}

/// `YYYYMMDDTHHMMSSZ` — the diagnostic ordering prefix of a `backupId`.
pub(crate) fn utc_basic_timestamp(millis: u64) -> String {
    let (y, mo, d, h, mi, s, _) = utc_fields(millis);
    format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z")
}

/// ISO-8601 UTC with millisecond precision (`createdAt`).
pub(crate) fn iso8601_millis(millis: u64) -> String {
    let (y, mo, d, h, mi, s, ms) = utc_fields(millis);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{ms:03}Z")
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Ordered JSON (manifest authoring, §8) ──────────────────────────────────

/// A JSON tree whose object keys keep insertion order, so the manifest is
/// serialized with exactly the §8 key order (serde_json's map is sorted).
#[derive(Clone, Debug)]
pub(crate) enum Json {
    Null,
    Bool(bool),
    Num(u64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(&'static str, Json)>),
}

impl Json {
    fn opt_str(value: &Option<String>) -> Json {
        match value {
            Some(text) => Json::Str(text.clone()),
            None => Json::Null,
        }
    }
    fn strs(values: &[String]) -> Json {
        Json::Arr(values.iter().cloned().map(Json::Str).collect())
    }
}

/// `JSON.stringify`-equivalent output: 2-space indentation when `pretty`
/// (with a trailing newline), compact otherwise.
pub(crate) fn render_json(value: &Json, pretty: bool) -> String {
    let mut out = String::new();
    write_json(&mut out, value, pretty, 0);
    if pretty {
        out.push('\n');
    }
    out
}

fn write_json(out: &mut String, value: &Json, pretty: bool, depth: usize) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(n) => out.push_str(&n.to_string()),
        Json::Str(s) => out.push_str(&serde_json::to_string(s).expect("string serializes")),
        Json::Arr(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if pretty {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                }
                write_json(out, item, pretty, depth + 1);
            }
            if pretty {
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
            }
            out.push(']');
        }
        Json::Obj(fields) => {
            if fields.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (index, (key, item)) in fields.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                if pretty {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                }
                out.push_str(&serde_json::to_string(key).expect("key serializes"));
                out.push(':');
                if pretty {
                    out.push(' ');
                }
                write_json(out, item, pretty, depth + 1);
            }
            if pretty {
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
            }
            out.push('}');
        }
    }
}

/// `setDigest` (§8): `sha256-` + hex(SHA-256(canonicalJson({schema, entries:
/// [{chatId, snapshotId, contentHash}]}))) over entries sorted by `chatId`
/// then `snapshotId`, no whitespace.
pub(crate) fn set_digest(entries: &[(String, String, String)]) -> String {
    let mut sorted: Vec<&(String, String, String)> = entries.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    let tree = Json::Obj(vec![
        ("schema", Json::Str(BACKUP_OBJECT_SCHEMA.to_string())),
        (
            "entries",
            Json::Arr(
                sorted
                    .iter()
                    .map(|(chat_id, snapshot_id, content_hash)| {
                        Json::Obj(vec![
                            ("chatId", Json::Str(chat_id.clone())),
                            ("snapshotId", Json::Str(snapshot_id.clone())),
                            ("contentHash", Json::Str(content_hash.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    let canonical = render_json(&tree, false);
    format!(
        "sha256-{}",
        crate::archive_durable_write::sha256_hex(canonical.as_bytes())
    )
}

fn entry_digest_triple(entry: &ManifestEntry) -> (String, String, String) {
    (
        entry.chat_id.clone(),
        entry.snapshot_id.clone(),
        entry.content_hash.clone(),
    )
}

/// Entry ordering (§8): by `chatId` byte order, then `snapshotId`.
fn sort_entries(entries: &mut [ManifestEntry]) {
    entries.sort_by(|a, b| {
        a.chat_id
            .cmp(&b.chat_id)
            .then(a.snapshot_id.cmp(&b.snapshot_id))
    });
}

fn entry_json(entry: &ManifestEntry) -> Json {
    Json::Obj(vec![
        ("chatId", Json::Str(entry.chat_id.clone())),
        ("snapshotId", Json::Str(entry.snapshot_id.clone())),
        ("contentHash", Json::Str(entry.content_hash.clone())),
        ("packageLeaf", Json::Str(entry.package_leaf.clone())),
        (
            "constructionFamily",
            Json::Str(entry.construction_family.clone()),
        ),
        ("schemaVersion", Json::Num(entry.schema_version)),
        ("payloadVersion", Json::Num(entry.payload_version)),
        (
            "snapshot",
            Json::Obj(vec![
                ("encoding", Json::Str(entry.snapshot.encoding.clone())),
                (
                    "physicalSha256",
                    Json::Str(entry.snapshot.physical_sha256.clone()),
                ),
                (
                    "physicalByteLength",
                    Json::Num(entry.snapshot.physical_byte_length),
                ),
                (
                    "logicalSha256",
                    Json::Str(entry.snapshot.logical_sha256.clone()),
                ),
                (
                    "logicalByteLength",
                    Json::Num(entry.snapshot.logical_byte_length),
                ),
            ]),
        ),
        ("members", Json::strs(&entry.members)),
        ("assets", Json::strs(&entry.assets)),
        ("assetSource", Json::Str(entry.asset_source.clone())),
        ("savedAt", Json::opt_str(&entry.saved_at)),
    ])
}

/// A bounded, validated failure record ready for the manifest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FailureRecord {
    pub(crate) chat_id: String,
    pub(crate) snapshot_id: String,
    pub(crate) code: String,
    pub(crate) stage: String,
    pub(crate) detail: String,
}

/// Truncates renderer-declared text to `max` bytes on a UTF-8 boundary.
fn bounded_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut cut = max;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text[..cut].to_string()
}

/// The facts the manifest is authored from (§8). Everything here is either
/// the declared enumeration, the native registry of verified packages, or
/// the declared failures.
pub(crate) struct ManifestInputs<'a> {
    pub(crate) backup_id: &'a str,
    pub(crate) created_at: &'a str,
    pub(crate) app_build_stamp: &'a Option<String>,
    pub(crate) live_generation_family: &'a str,
    pub(crate) platform: &'a str,
    pub(crate) host_root_mode: &'a str,
    pub(crate) enumeration_at: &'a str,
    pub(crate) counts: Counts,
    pub(crate) entries: &'a [ManifestEntry],
    pub(crate) failures: &'a [FailureRecord],
    pub(crate) set_digest: &'a str,
    pub(crate) full_fsync: bool,
}

pub(crate) fn manifest_json(inputs: &ManifestInputs<'_>) -> Json {
    let counts = inputs.counts;
    let complete = inputs.failures.is_empty();
    Json::Obj(vec![
        ("schema", Json::Str(BACKUP_OBJECT_SCHEMA.to_string())),
        ("schemaVersion", Json::Num(BACKUP_SCHEMA_VERSION)),
        ("backupId", Json::Str(inputs.backup_id.to_string())),
        ("createdAt", Json::Str(inputs.created_at.to_string())),
        ("complete", Json::Bool(complete)),
        ("consistency", Json::Str(CONSISTENCY_MODEL.to_string())),
        (
            "source",
            Json::Obj(vec![
                ("appBuildStamp", Json::opt_str(inputs.app_build_stamp)),
                (
                    "liveGenerationFamily",
                    Json::Str(inputs.live_generation_family.to_string()),
                ),
                ("platform", Json::Str(inputs.platform.to_string())),
                ("hostRootMode", Json::Str(inputs.host_root_mode.to_string())),
            ]),
        ),
        (
            "enumeration",
            Json::Obj(vec![
                ("at", Json::Str(inputs.enumeration_at.to_string())),
                (
                    "counts",
                    Json::Obj(vec![
                        ("enumerated", Json::Num(counts.enumerated)),
                        ("eligible", Json::Num(counts.eligible)),
                        ("success", Json::Num(counts.success)),
                        ("failed", Json::Num(counts.failed)),
                        (
                            "skipped",
                            Json::Obj(vec![
                                ("deleted", Json::Num(counts.skipped.deleted)),
                                ("tombstoned", Json::Num(counts.skipped.tombstoned)),
                                ("linkedOnly", Json::Num(counts.skipped.linked_only)),
                                ("noSnapshot", Json::Num(counts.skipped.no_snapshot)),
                            ]),
                        ),
                    ]),
                ),
            ]),
        ),
        (
            "entries",
            Json::Arr(inputs.entries.iter().map(entry_json).collect()),
        ),
        (
            "failures",
            Json::Arr(
                inputs
                    .failures
                    .iter()
                    .map(|failure| {
                        Json::Obj(vec![
                            ("chatId", Json::Str(failure.chat_id.clone())),
                            ("snapshotId", Json::Str(failure.snapshot_id.clone())),
                            ("code", Json::Str(failure.code.clone())),
                            ("stage", Json::Str(failure.stage.clone())),
                            ("declaredBy", Json::Str("renderer".to_string())),
                            ("detail", Json::Str(failure.detail.clone())),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("setDigest", Json::Str(inputs.set_digest.to_string())),
        (
            "verification",
            Json::Obj(vec![
                ("packageScanComplete", Json::Bool(true)),
                ("occupantCount", Json::Num(inputs.entries.len() as u64)),
                ("verifiedCount", Json::Num(inputs.entries.len() as u64)),
                ("crossCheck", Json::Str("pass".to_string())),
                ("fullFsync", Json::Bool(inputs.full_fsync)),
            ]),
        ),
    ])
}

// ── Strict JSON reading (VERIFY, §8/§15) ───────────────────────────────────

/// A JSON value parsed with DUPLICATE-KEY DETECTION: a manifest carrying a
/// duplicate key is `malformed` (§8), which serde_json's default map would
/// silently collapse.
#[derive(Clone, Debug)]
pub(crate) enum StrictJson {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<StrictJson>),
    Object(Vec<(String, StrictJson)>),
}

impl StrictJson {
    pub(crate) fn get(&self, key: &str) -> Option<&StrictJson> {
        match self {
            StrictJson::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            StrictJson::String(s) => Some(s.as_str()),
            _ => None,
        }
    }
    pub(crate) fn as_u64(&self) -> Option<u64> {
        match self {
            StrictJson::Number(n) => n.as_u64(),
            _ => None,
        }
    }
    pub(crate) fn as_bool(&self) -> Option<bool> {
        match self {
            StrictJson::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub(crate) fn as_array(&self) -> Option<&[StrictJson]> {
        match self {
            StrictJson::Array(items) => Some(items.as_slice()),
            _ => None,
        }
    }
    pub(crate) fn is_object(&self) -> bool {
        matches!(self, StrictJson::Object(_))
    }
}

impl<'de> serde::Deserialize<'de> for StrictJson {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = StrictJson;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_bool<E>(self, v: bool) -> Result<StrictJson, E> {
                Ok(StrictJson::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<StrictJson, E> {
                Ok(StrictJson::Number(v.into()))
            }
            fn visit_u64<E>(self, v: u64) -> Result<StrictJson, E> {
                Ok(StrictJson::Number(v.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<StrictJson, E> {
                serde_json::Number::from_f64(v)
                    .map(StrictJson::Number)
                    .ok_or_else(|| E::custom("non-finite number"))
            }
            fn visit_str<E>(self, v: &str) -> Result<StrictJson, E> {
                Ok(StrictJson::String(v.to_string()))
            }
            fn visit_string<E>(self, v: String) -> Result<StrictJson, E> {
                Ok(StrictJson::String(v))
            }
            fn visit_unit<E>(self) -> Result<StrictJson, E> {
                Ok(StrictJson::Null)
            }
            fn visit_none<E>(self) -> Result<StrictJson, E> {
                Ok(StrictJson::Null)
            }
            fn visit_some<D: serde::Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> Result<StrictJson, D::Error> {
                <StrictJson as serde::Deserialize>::deserialize(deserializer)
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<StrictJson, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(StrictJson::Array(items))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<StrictJson, A::Error> {
                let mut fields: Vec<(String, StrictJson)> = Vec::new();
                let mut seen = BTreeSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key.clone()) {
                        return Err(serde::de::Error::custom("duplicate object key"));
                    }
                    let value = map.next_value()?;
                    fields.push((key, value));
                }
                Ok(StrictJson::Object(fields))
            }
        }
        deserializer.deserialize_any(V)
    }
}

/// The facts VERIFY reads back from a stored manifest (§15 checks 5–7 and
/// the set cross-check inputs).
#[derive(Clone, Debug)]
pub(crate) struct ParsedManifest {
    pub(crate) backup_id: String,
    pub(crate) complete: bool,
    pub(crate) counts: Counts,
    pub(crate) entries: Vec<ManifestEntry>,
    pub(crate) failure_count: u64,
    pub(crate) set_digest: String,
}

/// `Err((status, code))`: `unsupported` for a foreign schema or a newer
/// version, `malformed` for everything else.
pub(crate) fn parse_manifest(bytes: &[u8]) -> Result<ParsedManifest, (&'static str, &'static str)> {
    const MALFORMED: (&str, &str) = ("malformed", "backup-manifest-invalid");
    let value: StrictJson = serde_json::from_slice(bytes).map_err(|_| MALFORMED)?;
    if !value.is_object() {
        return Err(MALFORMED);
    }
    let schema = value.get("schema").and_then(StrictJson::as_str);
    if schema != Some(BACKUP_OBJECT_SCHEMA) {
        return Err(("unsupported", "backup-manifest-invalid"));
    }
    let schema_version = value.get("schemaVersion").and_then(StrictJson::as_u64);
    match schema_version {
        Some(v) if v > BACKUP_SCHEMA_VERSION => {
            return Err(("unsupported", "backup-manifest-invalid"))
        }
        Some(v) if v == BACKUP_SCHEMA_VERSION => {}
        _ => return Err(MALFORMED),
    }
    let backup_id = value
        .get("backupId")
        .and_then(StrictJson::as_str)
        .filter(|id| is_backup_id(id))
        .ok_or(MALFORMED)?
        .to_string();
    value
        .get("createdAt")
        .and_then(StrictJson::as_str)
        .ok_or(MALFORMED)?;
    let complete = value
        .get("complete")
        .and_then(StrictJson::as_bool)
        .ok_or(MALFORMED)?;
    value
        .get("consistency")
        .and_then(StrictJson::as_str)
        .ok_or(MALFORMED)?;
    let enumeration = value.get("enumeration").ok_or(MALFORMED)?;
    enumeration
        .get("at")
        .and_then(StrictJson::as_str)
        .ok_or(MALFORMED)?;
    let counts_value = enumeration.get("counts").ok_or(MALFORMED)?;
    let num = |node: &StrictJson, key: &str| node.get(key).and_then(StrictJson::as_u64);
    let skipped_value = counts_value.get("skipped").ok_or(MALFORMED)?;
    let counts = Counts {
        enumerated: num(counts_value, "enumerated").ok_or(MALFORMED)?,
        eligible: num(counts_value, "eligible").ok_or(MALFORMED)?,
        success: num(counts_value, "success").ok_or(MALFORMED)?,
        failed: num(counts_value, "failed").ok_or(MALFORMED)?,
        skipped: SkippedCounts {
            deleted: num(skipped_value, "deleted").ok_or(MALFORMED)?,
            tombstoned: num(skipped_value, "tombstoned").ok_or(MALFORMED)?,
            linked_only: num(skipped_value, "linkedOnly").ok_or(MALFORMED)?,
            no_snapshot: num(skipped_value, "noSnapshot").ok_or(MALFORMED)?,
        },
    };

    let mut entries = Vec::new();
    let mut pairs = BTreeSet::new();
    for item in value
        .get("entries")
        .and_then(StrictJson::as_array)
        .ok_or(MALFORMED)?
    {
        let text = |key: &str| {
            item.get(key)
                .and_then(StrictJson::as_str)
                .map(str::to_string)
        };
        let strings = |key: &str| -> Option<Vec<String>> {
            item.get(key)?
                .as_array()?
                .iter()
                .map(|v| v.as_str().map(str::to_string))
                .collect()
        };
        let snapshot = item.get("snapshot").ok_or(MALFORMED)?;
        let entry = ManifestEntry {
            chat_id: text("chatId").ok_or(MALFORMED)?,
            snapshot_id: text("snapshotId").ok_or(MALFORMED)?,
            content_hash: text("contentHash").ok_or(MALFORMED)?,
            package_leaf: text("packageLeaf").ok_or(MALFORMED)?,
            construction_family: text("constructionFamily").ok_or(MALFORMED)?,
            schema_version: num(item, "schemaVersion").ok_or(MALFORMED)?,
            payload_version: num(item, "payloadVersion").ok_or(MALFORMED)?,
            snapshot: EntrySnapshot {
                encoding: snapshot
                    .get("encoding")
                    .and_then(StrictJson::as_str)
                    .ok_or(MALFORMED)?
                    .to_string(),
                physical_sha256: snapshot
                    .get("physicalSha256")
                    .and_then(StrictJson::as_str)
                    .ok_or(MALFORMED)?
                    .to_string(),
                physical_byte_length: num(snapshot, "physicalByteLength").ok_or(MALFORMED)?,
                logical_sha256: snapshot
                    .get("logicalSha256")
                    .and_then(StrictJson::as_str)
                    .ok_or(MALFORMED)?
                    .to_string(),
                logical_byte_length: num(snapshot, "logicalByteLength").ok_or(MALFORMED)?,
            },
            members: strings("members").ok_or(MALFORMED)?,
            assets: strings("assets").ok_or(MALFORMED)?,
            asset_source: text("assetSource").ok_or(MALFORMED)?,
            saved_at: match item.get("savedAt") {
                None | Some(StrictJson::Null) => None,
                Some(StrictJson::String(s)) => Some(s.clone()),
                Some(_) => return Err(MALFORMED),
            },
        };
        if crate::archive_durable_write::normalize_expected_sha(&entry.content_hash).is_none() {
            return Err(MALFORMED);
        }
        if !pairs.insert((entry.chat_id.clone(), entry.snapshot_id.clone())) {
            return Err(MALFORMED);
        }
        entries.push(entry);
    }

    let mut failure_count = 0u64;
    let mut failure_pairs = BTreeSet::new();
    for item in value
        .get("failures")
        .and_then(StrictJson::as_array)
        .ok_or(MALFORMED)?
    {
        let chat_id = item
            .get("chatId")
            .and_then(StrictJson::as_str)
            .ok_or(MALFORMED)?;
        let snapshot_id = item
            .get("snapshotId")
            .and_then(StrictJson::as_str)
            .ok_or(MALFORMED)?;
        item.get("code")
            .and_then(StrictJson::as_str)
            .ok_or(MALFORMED)?;
        let pair = (chat_id.to_string(), snapshot_id.to_string());
        if pairs.contains(&pair) || !failure_pairs.insert(pair) {
            return Err(MALFORMED);
        }
        failure_count += 1;
    }

    let set_digest = value
        .get("setDigest")
        .and_then(StrictJson::as_str)
        .ok_or(MALFORMED)?
        .to_string();
    if crate::archive_durable_write::normalize_expected_sha(&set_digest).is_none() {
        return Err(MALFORMED);
    }

    Ok(ParsedManifest {
        backup_id,
        complete,
        counts,
        entries,
        failure_count,
        set_digest,
    })
}

/// §15 checks 5 and 7 on a parsed manifest: counts identities, `complete`
/// agreement, and the leaf/marker agreement of §10.
pub(crate) fn manifest_consistency(
    manifest: &ParsedManifest,
    leaf_partial: bool,
    leaf_backup_id: &str,
) -> Result<(), &'static str> {
    if !manifest.counts.identities_hold()
        || manifest.entries.len() as u64 != manifest.counts.success
        || manifest.failure_count != manifest.counts.failed
        || manifest.complete != (manifest.failure_count == 0)
        || manifest.counts.success == 0
    {
        return Err("backup-manifest-inconsistent");
    }
    if manifest.complete == leaf_partial || manifest.backup_id != leaf_backup_id {
        return Err("backup-manifest-inconsistent");
    }
    Ok(())
}

// ── Set cross-check (§15 checks 1–4 and 6) ─────────────────────────────────

/// Cross-checks the trusted scanner's result against the manifest entries.
/// Every semantic binding uses the occupant `name` and the verified identity
/// facts, never the scanner's cosmetic `path`. Returns the `setDigest`
/// recomputed from the VERIFIED occupants.
#[cfg(unix)]
pub(crate) fn cross_check_set(
    scan: &crate::archive_package_scan::PackageScan,
    entries: &[ManifestEntry],
) -> Result<String, &'static str> {
    use crate::archive_package_scan::{IndeterminateReason, OccupantClass, VerifiedPackage};

    if !scan.complete || !scan.blockers.is_empty() {
        return Err("backup-set-foreign-entry");
    }
    let mut by_name: BTreeMap<&str, &VerifiedPackage> = BTreeMap::new();
    for occupant in &scan.occupants {
        match &occupant.class {
            OccupantClass::VerifiedGeneration(package) => {
                by_name.insert(occupant.name.as_str(), package);
            }
            OccupantClass::Indeterminate {
                reason: IndeterminateReason::NotAPackageName,
                ..
            }
            | OccupantClass::ReservedInfrastructure
            | OccupantClass::LegacyPackage(_) => return Err("backup-set-foreign-entry"),
            OccupantClass::Indeterminate { .. } => return Err("backup-set-package-unverified"),
        }
    }
    if by_name.len() != entries.len() {
        return Err("backup-set-cross-check-failed");
    }
    let normalize = crate::archive_durable_write::normalize_expected_sha;
    let mut matched = BTreeSet::new();
    let mut triples = Vec::with_capacity(entries.len());
    for entry in entries {
        let package = by_name
            .get(entry.package_leaf.as_str())
            .ok_or("backup-set-cross-check-failed")?;
        if !matched.insert(entry.package_leaf.as_str()) {
            return Err("backup-set-cross-check-failed");
        }
        let expected_hash =
            normalize(&entry.content_hash).ok_or("backup-set-cross-check-failed")?;
        let entry_assets: Option<Vec<String>> =
            entry.assets.iter().map(|sha| normalize(sha)).collect();
        let mut entry_assets = entry_assets.ok_or("backup-set-cross-check-failed")?;
        entry_assets.sort();
        entry_assets.dedup();
        let physical = normalize(&entry.snapshot.physical_sha256);
        let logical = normalize(&entry.snapshot.logical_sha256);
        let saved_at = match &package.order {
            crate::archive_package_scan::OrderFact::Orderable { saved_at } => {
                Some(saved_at.clone())
            }
            crate::archive_package_scan::OrderFact::Unorderable { .. } => None,
        };
        let facts_agree = package.chat_id == entry.chat_id
            && package.snapshot_id == entry.snapshot_id
            && package.content_hash == expected_hash
            && package.construction_family == crate::archive_package_scan::ConstructionFamily::V3
            && entry.construction_family == CONSTRUCTION_FAMILY_V3
            && entry.schema_version == 3
            && entry.payload_version == 3
            && package.snapshot_encoding == entry.snapshot.encoding
            && normalize(&package.snapshot_physical_sha256) == physical
            && package.snapshot_physical_byte_length == entry.snapshot.physical_byte_length
            && normalize(&package.logical_snapshot_sha256) == logical
            && package.logical_snapshot_byte_length == entry.snapshot.logical_byte_length
            && package.asset_shas == entry_assets
            && package.persistent_members == entry.members
            && entry.asset_source == ASSET_SOURCE
            && saved_at == entry.saved_at;
        if !facts_agree {
            return Err("backup-set-cross-check-failed");
        }
        triples.push((
            package.chat_id.clone(),
            package.snapshot_id.clone(),
            format!("sha256-{}", package.content_hash),
        ));
    }
    Ok(set_digest(&triples))
}

// ── Native implementation (Unix; macOS is the only supported arm) ──────────

#[cfg(unix)]
mod native {
    use super::*;
    use crate::archive_durable_write::{confined, normalize_expected_sha, sync_file_contents};
    use crate::archive_generation_publish::{
        generation_basename, ipc_token, random_token_seed, validated_chat_id,
        verify_occupant_all_supported,
    };
    use std::io::Write;
    use std::os::fd::AsRawFd;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::Instant;

    // ── Fences and test seams ──────────────────────────────────────────

    /// Every namespace/content fence site of §13, so a test can force ONE
    /// of them to report failure and prove the commit-point rule.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum FenceSite {
        MemberContent,
        PackageAssets,
        PackageStage,
        PackagesDir,
        ManifestContent,
        RunAfterManifest,
        RunAfterScan,
        Root,
    }

    // THREAD-LOCAL, not process-global: cargo runs tests in parallel threads.
    #[cfg(test)]
    thread_local! {
        pub(crate) static FORCE_FENCE_FAILURE: std::cell::Cell<Option<FenceSite>> =
            const { std::cell::Cell::new(None) };
        pub(crate) static MANIFEST_MAX_OVERRIDE: std::cell::Cell<Option<u64>> =
            const { std::cell::Cell::new(None) };
        /// Makes the N-th FINALIZE checkpoint (1-based) observe a pending
        /// abort, as a concurrent `abort` raising the flag mid-run would.
        pub(crate) static FORCE_ABORT_AT_CHECKPOINT: std::cell::Cell<Option<u32>> =
            const { std::cell::Cell::new(None) };
    }

    #[cfg(test)]
    fn fence_forced(site: FenceSite) -> bool {
        FORCE_FENCE_FAILURE.with(|f| f.get() == Some(site))
    }
    #[cfg(not(test))]
    fn fence_forced(_site: FenceSite) -> bool {
        false
    }

    /// Class K namespace fence.
    fn fence(dir: &confined::Dir, site: FenceSite) -> bool {
        if fence_forced(site) {
            return false;
        }
        dir.sync().is_ok()
    }

    /// Class J content fence; returns the `F_FULLFSYNC` truth flag.
    fn content_fence(file: &std::fs::File, site: FenceSite) -> std::io::Result<bool> {
        if fence_forced(site) {
            return Err(std::io::Error::from(std::io::ErrorKind::Other));
        }
        sync_file_contents(file)
    }

    /// Whether a cancel is pending at a FINALIZE step boundary (NB-06).
    fn abort_pending(session: &Session, checkpoint: u32) -> bool {
        #[cfg(test)]
        if FORCE_ABORT_AT_CHECKPOINT.with(|f| f.get()) == Some(checkpoint) {
            return true;
        }
        let _ = checkpoint;
        session.abort_requested.load(Ordering::SeqCst)
    }

    fn manifest_max_bytes() -> u64 {
        #[cfg(test)]
        if let Some(forced) = MANIFEST_MAX_OVERRIDE.with(|f| f.get()) {
            return forced;
        }
        BACKUP_MANIFEST_MAX_BYTES
    }

    // ── Identity (class H′, composed from landed primitives + fstat) ───

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) struct ObjectIdentity {
        device: u64,
        inode: u64,
    }

    impl ObjectIdentity {
        fn of_stat(st: &libc::stat) -> Self {
            ObjectIdentity {
                device: st.st_dev as u64,
                inode: st.st_ino as u64,
            }
        }
    }

    /// The single direct syscall this module issues: a READ-ONLY `fstat`
    /// of a retained descriptor (§12). Main exposes no H′ helper.
    fn identity_of_fd(fd: i32) -> std::io::Result<ObjectIdentity> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::fstat(fd, &mut st) };
        if rc < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(ObjectIdentity::of_stat(&st))
    }

    fn is_directory(st: &libc::stat) -> bool {
        (st.st_mode & libc::S_IFMT) == libc::S_IFDIR
    }

    /// Post-publication identity check: the occupant now at `name` must be
    /// the retained object `expected`.
    fn child_is_object(
        parent: &confined::Dir,
        name: &[u8],
        expected: ObjectIdentity,
        directory: bool,
    ) -> bool {
        match parent.stat_child_nofollow(name) {
            Ok(Some(st)) => {
                let kind_ok = if directory {
                    is_directory(&st)
                } else {
                    confined::is_regular(&st)
                };
                kind_ok && ObjectIdentity::of_stat(&st) == expected
            }
            _ => false,
        }
    }

    /// Own-cleanup helpers (class L): a name is removed only while it still
    /// identifies the object this session created. Absent is already clean;
    /// a substituted object is foreign and left untouched.
    fn unlink_file_checked(parent: &confined::Dir, name: &[u8], expected: ObjectIdentity) -> bool {
        match parent.stat_child_nofollow(name) {
            Ok(None) => true,
            Ok(Some(st))
                if confined::is_regular(&st) && ObjectIdentity::of_stat(&st) == expected =>
            {
                parent.unlink_child(name).is_ok()
            }
            _ => false,
        }
    }

    fn remove_dir_checked(parent: &confined::Dir, name: &[u8], expected: ObjectIdentity) -> bool {
        match parent.stat_child_nofollow(name) {
            Ok(None) => true,
            Ok(Some(st)) if is_directory(&st) && ObjectIdentity::of_stat(&st) == expected => {
                parent.unlink_child_dir(name).is_ok()
            }
            _ => false,
        }
    }

    fn is_redirect_error(err: &std::io::Error) -> bool {
        matches!(err.raw_os_error(), Some(libc::ELOOP) | Some(libc::ENOTDIR))
    }

    // ── Sessions (§9) ─────────────────────────────────────────────────

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum State {
        Staging,
        PackageOpen,
        SetFinalizing,
        Published,
        Failed,
        Aborted,
    }

    impl State {
        fn is_live(self) -> bool {
            matches!(
                self,
                State::Staging | State::PackageOpen | State::SetFinalizing
            )
        }
    }

    struct OpenMember {
        target: MemberTarget,
        file: std::fs::File,
        hasher: sha2::Sha256,
        len: u64,
    }

    struct ClosedMember {
        target: MemberTarget,
        identity: ObjectIdentity,
    }

    struct OpenPackage {
        chat_id: String,
        snapshot_id: String,
        stage_name: Vec<u8>,
        stage: confined::Dir,
        assets: Option<confined::Dir>,
        open: Option<OpenMember>,
        closed: Vec<ClosedMember>,
    }

    struct PublishedPackage {
        entry: ManifestEntry,
        identity: ObjectIdentity,
        /// `(basename, in_assets, identity)` for identity-checked cleanup.
        members: Vec<(String, bool, ObjectIdentity)>,
        has_assets_dir: bool,
    }

    struct Declaration {
        at: String,
        skipped: SkippedCounts,
        enumerated_count: u64,
        app_build_stamp: Option<String>,
        eligible: BTreeSet<(String, String)>,
    }

    pub(crate) struct SessionInner {
        state: State,
        last_activity: Instant,
        backup_id: String,
        run_name: Vec<u8>,
        /// Retained run staging directory; `None` once cleaned or promoted.
        run: Option<confined::Dir>,
        packages: Option<confined::Dir>,
        declaration: Declaration,
        open_package: Option<OpenPackage>,
        published: BTreeMap<(String, String), PublishedPackage>,
        /// Manifest artifacts this session created under the run directory.
        manifest_artifacts: Vec<(Vec<u8>, ObjectIdentity)>,
        /// Whether every class J fence so far reported the macOS media fence.
        full_fsync: bool,
    }

    pub(crate) struct Session {
        /// Set by `abort`; observed by in-flight commands at step boundaries
        /// (cooperative cancellation, NB-06).
        abort_requested: AtomicBool,
        inner: Mutex<SessionInner>,
    }

    /// One slot: `MAX_ACTIVE_BACKUP_SESSIONS = 1`.
    #[derive(Default)]
    pub struct Registry {
        slot: Mutex<Option<(u64, Arc<Session>)>>,
    }

    impl Registry {
        fn lock_slot(&self) -> MutexGuard<'_, Option<(u64, Arc<Session>)>> {
            self.slot.lock().unwrap_or_else(|e| e.into_inner())
        }
    }

    /// Publisher context. Tests construct their own over a scratch root so
    /// the global registry is never shared across cases.
    pub struct BackupPublisher {
        root: std::path::PathBuf,
        registry: Registry,
    }

    impl BackupPublisher {
        /// `root` is the governed backup root (`…/H2O Studio Backups`).
        pub fn new(root: impl Into<std::path::PathBuf>) -> Self {
            BackupPublisher {
                root: root.into(),
                registry: Registry::default(),
            }
        }

        pub fn root(&self) -> &std::path::Path {
            &self.root
        }

        fn lookup(&self, token: u64) -> Option<Arc<Session>> {
            let slot = self.registry.lock_slot();
            match slot.as_ref() {
                Some((held, session)) if *held == token => Some(Arc::clone(session)),
                _ => None,
            }
        }

        fn remove_record(&self, token: u64) {
            let mut slot = self.registry.lock_slot();
            if matches!(slot.as_ref(), Some((held, _)) if *held == token) {
                *slot = None;
            }
        }

        /// Read-only: whether a session record (in any state) is held.
        pub fn session_present(&self) -> bool {
            self.registry.lock_slot().is_some()
        }

        #[cfg(test)]
        pub(crate) fn age_session_for_test(&self, token: u64, by: Duration) {
            if let Some(session) = self.lookup(token) {
                let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
                inner.last_activity = inner
                    .last_activity
                    .checked_sub(by)
                    .unwrap_or(inner.last_activity);
            }
        }

        #[cfg(test)]
        pub(crate) fn run_staging_path_for_test(&self, token: u64) -> Option<std::path::PathBuf> {
            use std::os::unix::ffi::OsStrExt;
            let session = self.lookup(token)?;
            let inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
            Some(self.root.join(std::ffi::OsStr::from_bytes(&inner.run_name)))
        }

        /// Raises the cooperative abort flag WITHOUT taking the lease, as a
        /// concurrent `abort` invoke does before it blocks on an in-flight
        /// command.
        #[cfg(test)]
        pub(crate) fn request_abort_for_test(&self, token: u64) {
            if let Some(session) = self.lookup(token) {
                session.abort_requested.store(true, Ordering::SeqCst);
            }
        }

        #[cfg(test)]
        pub(crate) fn state_for_test(&self, token: u64) -> Option<State> {
            let session = self.lookup(token)?;
            let inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
            Some(inner.state)
        }
    }

    fn hex32() -> String {
        format!("{:016x}{:016x}", random_token_seed(), random_token_seed())
    }

    /// Runs `f` under the session lease after the common admission of §9:
    /// unknown token, `ABORTED` record, pending abort, idle eviction.
    fn with_session<R>(
        publisher: &BackupPublisher,
        token: u64,
        f: impl FnOnce(&Session, &mut SessionInner) -> R,
    ) -> Result<R, &'static str> {
        let session = publisher.lookup(token).ok_or("backup-session-unknown")?;
        let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.state == State::Aborted {
            return Err("backup-cancelled");
        }
        if inner.state.is_live() && inner.last_activity.elapsed() >= SESSION_IDLE_TIMEOUT {
            // Lazy eviction: the observing command removes only this
            // session's own staging and reports it (§9).
            cleanup_own_tree(publisher, &mut inner);
            inner.state = State::Aborted;
            drop(inner);
            publisher.remove_record(token);
            return Err("backup-session-evicted");
        }
        inner.last_activity = Instant::now();
        if inner.state.is_live() && session.abort_requested.load(Ordering::SeqCst) {
            // A cancel is pending: the abort command owns the transition.
            return Err("backup-cancelled");
        }
        Ok(f(session.as_ref(), &mut inner))
    }

    // ── Declaration validation (§4, NB-05) ─────────────────────────────

    fn validate_declaration(
        declaration: &EnumerationDeclaration,
    ) -> Result<Declaration, &'static str> {
        if declaration.eligible.is_empty() {
            return Err("backup-nothing-to-back-up");
        }
        if declaration.at.is_empty() || declaration.at.len() > 64 {
            return Err("backup-enumeration-inconsistent");
        }
        if let Some(stamp) = declaration.source.app_build_stamp.as_deref() {
            if stamp.len() > 256 {
                return Err("backup-enumeration-inconsistent");
            }
        }
        let mut eligible = BTreeSet::new();
        let mut chat_ids = BTreeSet::new();
        for pair in &declaration.eligible {
            if validated_chat_id(&pair.chat_id).is_err() {
                return Err("backup-enumeration-inconsistent");
            }
            let snapshot_id = pair.snapshot_id.as_str();
            if snapshot_id.is_empty()
                || snapshot_id.trim() != snapshot_id
                || snapshot_id.len() > 512
            {
                return Err("backup-enumeration-inconsistent");
            }
            // Exactly ONE package per eligible chat (§4): a chatId declared
            // twice is inconsistent, as is a duplicated pair.
            if !chat_ids.insert(pair.chat_id.clone())
                || !eligible.insert((pair.chat_id.clone(), pair.snapshot_id.clone()))
            {
                return Err("backup-enumeration-inconsistent");
            }
        }
        let counts = Counts {
            enumerated: declaration.enumerated_count,
            eligible: eligible.len() as u64,
            success: 0,
            failed: eligible.len() as u64,
            skipped: declaration.skipped,
        };
        if !counts.identities_hold() {
            return Err("backup-enumeration-inconsistent");
        }
        Ok(Declaration {
            at: declaration.at.clone(),
            skipped: declaration.skipped,
            enumerated_count: declaration.enumerated_count,
            app_build_stamp: declaration.source.app_build_stamp.clone(),
            eligible,
        })
    }

    // ── BEGIN (§9, NB-05 order) ────────────────────────────────────────

    pub fn begin(publisher: &BackupPublisher, declaration: &EnumerationDeclaration) -> BeginResult {
        begin_with_platform(publisher, declaration, PLATFORM_FAMILY)
    }

    /// Platform seam: production passes the compile-time arm; a test may
    /// pass `None` to prove the fail-closed refusal creates nothing.
    pub(crate) fn begin_with_platform(
        publisher: &BackupPublisher,
        declaration: &EnumerationDeclaration,
        platform: Option<&'static str>,
    ) -> BeginResult {
        // (1) platform arm, before anything else.
        let Some(family) = platform else {
            return BeginResult::refused("backup-unsupported-platform");
        };

        // (2) session availability, under the single admission claim.
        let mut slot = publisher.registry.lock_slot();
        let held = match slot.as_ref() {
            None => false,
            Some((_, session)) => match session.inner.try_lock() {
                // A lease held by an in-flight command: active by definition.
                Err(_) => return BeginResult::refused("backup-session-busy"),
                Ok(mut inner) => {
                    if inner.state.is_live() {
                        if inner.last_activity.elapsed() < SESSION_IDLE_TIMEOUT {
                            return BeginResult::refused("backup-session-busy");
                        }
                        // Idle: evict, removing only that session's own staging.
                        cleanup_own_tree(publisher, &mut inner);
                        inner.state = State::Aborted;
                    }
                    true
                }
            },
        };
        if held {
            // Terminal (PUBLISHED / FAILED / ABORTED) or just evicted: gone.
            *slot = None;
        }

        // (3) declaration validation — BEFORE any root, staging or session.
        let declared = match validate_declaration(declaration) {
            Ok(declared) => declared,
            Err(code) => return BeginResult::refused(code),
        };

        // (4) creating root admission (class A) and exclusive staging (class E).
        let root = match confined::Dir::open_root(&publisher.root) {
            Ok(dir) => dir,
            Err(err) if is_redirect_error(&err) => {
                return BeginResult::refused("backup-path-redirect-refused")
            }
            Err(_) => return BeginResult::refused("backup-root-unavailable"),
        };
        let name_max = match root.name_max() {
            Ok(value) => value,
            Err(_) => return BeginResult::refused("backup-name-limit-indeterminate"),
        };
        let backup_id = format!("{}-{}", utc_basic_timestamp(now_millis()), &hex32()[..16]);
        let longest_final = final_leaf(&backup_id, false);
        let staging_len = RUN_STAGING_PREFIX.len() + 32;
        if longest_final.len() as u64 > name_max || staging_len as u64 > name_max {
            return BeginResult::refused("backup-name-exceeds-filesystem-limit");
        }

        let mut created: Option<(Vec<u8>, confined::Dir)> = None;
        let mut collision = false;
        for _ in 0..STAGING_NAME_ATTEMPTS {
            let name = format!("{RUN_STAGING_PREFIX}{}", hex32()).into_bytes();
            match root.mkdir_child_exclusive(&name) {
                Ok(()) => match root.open_child_nofollow(&name) {
                    Ok(dir) => {
                        created = Some((name, dir));
                        break;
                    }
                    Err(_) => {
                        // Own it: remove what was just created before refusing.
                        let _ = root.unlink_child_dir(&name);
                        return BeginResult::refused("backup-write-failed");
                    }
                },
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    collision = true;
                    continue;
                }
                Err(_) => return BeginResult::refused("backup-write-failed"),
            }
        }
        let Some((run_name, run)) = created else {
            return BeginResult::refused(if collision {
                "backup-staging-collision"
            } else {
                "backup-write-failed"
            });
        };
        let packages = match run
            .mkdir_child_exclusive(PACKAGES_DIR.as_bytes())
            .and_then(|_| run.open_child_nofollow(PACKAGES_DIR.as_bytes()))
        {
            Ok(dir) => dir,
            Err(_) => {
                let _ = run.unlink_child_dir(PACKAGES_DIR.as_bytes());
                drop(run);
                let _ = root.unlink_child_dir(&run_name);
                return BeginResult::refused("backup-write-failed");
            }
        };

        let token = random_token_seed();
        let staging_leaf = String::from_utf8_lossy(&run_name).into_owned();
        let session = Arc::new(Session {
            abort_requested: AtomicBool::new(false),
            inner: Mutex::new(SessionInner {
                state: State::Staging,
                last_activity: Instant::now(),
                backup_id: backup_id.clone(),
                run_name,
                run: Some(run),
                packages: Some(packages),
                declaration: declared,
                open_package: None,
                published: BTreeMap::new(),
                manifest_artifacts: Vec::new(),
                full_fsync: true,
            }),
        });
        *slot = Some((token, session));
        BeginResult {
            ok: true,
            status: "created".to_string(),
            token: Some(token.to_string()),
            backup_id: Some(backup_id),
            staging_leaf: Some(staging_leaf),
            platform: Some(PlatformFact {
                supported: true,
                family: Some(family),
            }),
        }
    }

    // ── Own cleanup (§14, class L) ─────────────────────────────────────

    /// Discards the open package stage: only the members this session
    /// created, then `assets/`, then the stage directory itself. Returns
    /// whether everything it owned is gone.
    fn discard_open_package(inner: &mut SessionInner) -> bool {
        let Some(mut package) = inner.open_package.take() else {
            return true;
        };
        if inner.state == State::PackageOpen {
            inner.state = State::Staging;
        }
        let mut clean = true;
        if let Some(open) = package.open.take() {
            let identity = identity_of_fd(open.file.as_raw_fd()).ok();
            drop(open.file);
            let parent = if open.target.kind == MemberKind::Asset {
                package.assets.as_ref()
            } else {
                Some(&package.stage)
            };
            match (parent, identity) {
                (Some(parent), Some(identity)) => {
                    clean &= unlink_file_checked(parent, open.target.basename.as_bytes(), identity)
                }
                _ => clean = false,
            }
        }
        for closed in package.closed.drain(..) {
            let parent = if closed.target.kind == MemberKind::Asset {
                package.assets.as_ref()
            } else {
                Some(&package.stage)
            };
            match parent {
                Some(parent) => {
                    clean &= unlink_file_checked(
                        parent,
                        closed.target.basename.as_bytes(),
                        closed.identity,
                    )
                }
                None => clean = false,
            }
        }
        if let Some(assets) = package.assets.take() {
            let identity = identity_of_fd(assets.as_raw_fd()).ok();
            drop(assets);
            match identity {
                Some(identity) => {
                    clean &= remove_dir_checked(&package.stage, ASSETS_DIR.as_bytes(), identity)
                }
                None => clean = false,
            }
        }
        let stage_identity = identity_of_fd(package.stage.as_raw_fd()).ok();
        drop(package.stage);
        match (inner.packages.as_ref(), stage_identity) {
            (Some(packages), Some(identity)) => {
                clean &= remove_dir_checked(packages, &package.stage_name, identity)
            }
            _ => clean = false,
        }
        clean
    }

    fn remove_published_leaf(packages: &confined::Dir, package: &PublishedPackage) -> bool {
        let leaf = package.entry.package_leaf.as_bytes();
        match packages.stat_child_nofollow(leaf) {
            Ok(None) => return true,
            Ok(Some(st))
                if is_directory(&st) && ObjectIdentity::of_stat(&st) == package.identity => {}
            _ => return false,
        }
        let Ok(dir) = packages.open_child_nofollow(leaf) else {
            return false;
        };
        let mut clean = true;
        let assets = if package.has_assets_dir {
            match dir.open_child_nofollow(ASSETS_DIR.as_bytes()) {
                Ok(assets) => Some(assets),
                Err(_) => {
                    clean = false;
                    None
                }
            }
        } else {
            None
        };
        for (basename, in_assets, identity) in &package.members {
            let parent = if *in_assets {
                assets.as_ref()
            } else {
                Some(&dir)
            };
            match parent {
                Some(parent) => {
                    clean &= unlink_file_checked(parent, basename.as_bytes(), *identity)
                }
                None => clean = false,
            }
        }
        if let Some(assets) = assets {
            let identity = identity_of_fd(assets.as_raw_fd()).ok();
            drop(assets);
            match identity {
                Some(identity) => {
                    clean &= remove_dir_checked(&dir, ASSETS_DIR.as_bytes(), identity)
                }
                None => clean = false,
            }
        }
        drop(dir);
        clean && remove_dir_checked(packages, leaf, package.identity)
    }

    /// Removes the run's own staging tree bottom-up through the retained
    /// directory objects. A foreign entry stops the removal of its subtree;
    /// the caller reports `cleanupIncomplete`. Never a sweep over arbitrary
    /// content, never a name this session did not create.
    fn cleanup_own_tree(publisher: &BackupPublisher, inner: &mut SessionInner) -> bool {
        let mut clean = discard_open_package(inner);
        let Some(run) = inner.run.take() else {
            return clean;
        };
        if let Some(packages) = inner.packages.take() {
            for package in inner.published.values() {
                clean &= remove_published_leaf(&packages, package);
            }
            let identity = identity_of_fd(packages.as_raw_fd()).ok();
            let empty = matches!(packages.read_entry_names(), Ok(names) if names.is_empty());
            drop(packages);
            match (empty, identity) {
                (true, Some(identity)) => {
                    clean &= remove_dir_checked(&run, PACKAGES_DIR.as_bytes(), identity)
                }
                _ => clean = false,
            }
        }
        for (name, identity) in inner.manifest_artifacts.drain(..) {
            clean &= unlink_file_checked(&run, &name, identity);
        }
        let root = match confined::Dir::open_existing_nofollow(&publisher.root) {
            Ok(root) => root,
            // The root itself is gone: nothing of ours can remain under it.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return clean,
            Err(_) => return false,
        };
        let identity = identity_of_fd(run.as_raw_fd()).ok();
        let empty = matches!(run.read_entry_names(), Ok(names) if names.is_empty());
        drop(run);
        match (empty, identity) {
            (true, Some(identity)) => clean &= remove_dir_checked(&root, &inner.run_name, identity),
            _ => clean = false,
        }
        clean
    }

    // ── PACKAGE BEGIN ─────────────────────────────────────────────────

    pub fn package_begin(
        publisher: &BackupPublisher,
        token: u64,
        chat_id: &str,
        snapshot_id: &str,
    ) -> AckResult {
        with_session(publisher, token, |_session, inner| {
            if inner.state != State::Staging {
                return AckResult::refused("backup-invalid-state");
            }
            let pair = (chat_id.to_string(), snapshot_id.to_string());
            if !inner.declaration.eligible.contains(&pair) {
                return AckResult::refused("backup-entry-unknown");
            }
            if inner.published.contains_key(&pair) {
                return AckResult::refused("backup-entry-duplicate");
            }
            // §3.4 name admission for the leaf this package will publish
            // under, refused early rather than after a full staged upload.
            if has_windows_reserved_stem(chat_id) {
                return AckResult::refused("backup-invalid-member-name");
            }
            let Some(packages) = inner.packages.as_ref() else {
                return AckResult::refused("backup-invalid-state");
            };
            let name_max = match packages.name_max() {
                Ok(value) => value,
                Err(_) => return AckResult::refused("backup-name-limit-indeterminate"),
            };
            let longest_leaf = chat_id.len() + 2 + 64 + 8;
            if longest_leaf as u64 > name_max
                || (PACKAGE_STAGING_PREFIX.len() + 32) as u64 > name_max
            {
                return AckResult::refused("backup-name-exceeds-filesystem-limit");
            }
            let mut created: Option<(Vec<u8>, confined::Dir)> = None;
            let mut collision = false;
            for _ in 0..STAGING_NAME_ATTEMPTS {
                let name = format!("{PACKAGE_STAGING_PREFIX}{}", hex32()).into_bytes();
                match packages.mkdir_child_exclusive(&name) {
                    Ok(()) => match packages.open_child_nofollow(&name) {
                        Ok(dir) => {
                            created = Some((name, dir));
                            break;
                        }
                        Err(_) => {
                            let _ = packages.unlink_child_dir(&name);
                            return AckResult::refused("backup-write-failed");
                        }
                    },
                    Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                        collision = true;
                        continue;
                    }
                    Err(_) => return AckResult::refused("backup-write-failed"),
                }
            }
            let Some((stage_name, stage)) = created else {
                return AckResult::refused(if collision {
                    "backup-staging-collision"
                } else {
                    "backup-write-failed"
                });
            };
            inner.open_package = Some(OpenPackage {
                chat_id: chat_id.to_string(),
                snapshot_id: snapshot_id.to_string(),
                stage_name,
                stage,
                assets: None,
                open: None,
                closed: Vec::new(),
            });
            inner.state = State::PackageOpen;
            AckResult::ok("created")
        })
        .unwrap_or_else(AckResult::refused)
    }

    // ── WRITE MEMBER (§9, §18) ─────────────────────────────────────────

    fn write_refusal(inner: &mut SessionInner, code: &str) -> WriteResult {
        let clean = discard_open_package(inner);
        let mut out = WriteResult::refused(code);
        if !clean {
            out.codes.push("backup-cleanup-incomplete".to_string());
        }
        out
    }

    /// Outcome of one chunk against the open package stage.
    enum WriteStep {
        /// `(bytes so far, closing sha hex, F_FULLFSYNC flag)`; the sha is
        /// `Some` only when the member was closed by this chunk.
        Accepted(u64, Option<(String, ObjectIdentity)>, bool),
        /// Protocol refusal with NO side effect (the stage stays open).
        Refuse(&'static str),
        /// Infrastructure or integrity failure: the stage is discarded.
        Discard(&'static str),
    }

    fn write_member_step(
        package: &mut OpenPackage,
        target: &MemberTarget,
        is_final: bool,
        byte_length: Option<u64>,
        chunk: &[u8],
    ) -> WriteStep {
        // Open (or continue) the member. Protocol refusals here have no side
        // effect; the stage stays open for the orchestrator's abort.
        match package.open.as_ref() {
            Some(open) if open.target == *target => {}
            // One open member at a time per stage (§18).
            Some(_) => return WriteStep::Refuse("backup-invalid-state"),
            None => {
                if package
                    .closed
                    .iter()
                    .any(|closed| closed.target.relative == target.relative)
                {
                    return WriteStep::Refuse("backup-member-duplicate");
                }
                if target.kind == MemberKind::Asset && package.assets.is_none() {
                    let created = package
                        .stage
                        .mkdir_child_exclusive(ASSETS_DIR.as_bytes())
                        .and_then(|_| package.stage.open_child_nofollow(ASSETS_DIR.as_bytes()));
                    match created {
                        Ok(dir) => package.assets = Some(dir),
                        Err(_) => return WriteStep::Discard("backup-write-failed"),
                    }
                }
                let parent = if target.kind == MemberKind::Asset {
                    package.assets.as_ref().expect("created above")
                } else {
                    &package.stage
                };
                match parent.create_new_child(target.basename.as_bytes()) {
                    Ok(file) => {
                        package.open = Some(OpenMember {
                            target: target.clone(),
                            file,
                            hasher: <sha2::Sha256 as sha2::Digest>::new(),
                            len: 0,
                        });
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                        return WriteStep::Refuse("backup-member-duplicate");
                    }
                    Err(_) => return WriteStep::Discard("backup-write-failed"),
                }
            }
        }
        // Append to the retained handle; hash incrementally (§18).
        let open = package.open.as_mut().expect("opened above");
        if !chunk.is_empty() {
            if open.file.write_all(chunk).is_err() {
                return WriteStep::Discard("backup-write-failed");
            }
            sha2::Digest::update(&mut open.hasher, chunk);
            open.len = match open.len.checked_add(chunk.len() as u64) {
                Some(len) => len,
                None => return WriteStep::Discard("backup-write-failed"),
            };
        }
        if !is_final {
            return WriteStep::Accepted(open.len, None, true);
        }
        if open.len == 0 {
            return WriteStep::Discard("backup-member-empty");
        }
        if let Some(expected) = byte_length {
            if expected != open.len {
                return WriteStep::Discard("backup-member-length-mismatch");
            }
        }
        let full = match content_fence(&open.file, FenceSite::MemberContent) {
            Ok(full) => full,
            Err(_) => return WriteStep::Discard("backup-fence-failed"),
        };
        let digest = sha2::Digest::finalize(open.hasher.clone());
        let mut hex = String::with_capacity(64);
        for byte in digest.iter() {
            hex.push_str(&format!("{byte:02x}"));
        }
        if target
            .bound_hex
            .as_deref()
            .is_some_and(|bound| bound != hex)
        {
            return WriteStep::Discard("backup-asset-hash-mismatch");
        }
        let identity = match identity_of_fd(open.file.as_raw_fd()) {
            Ok(identity) => identity,
            Err(_) => return WriteStep::Discard("backup-write-failed"),
        };
        let len = open.len;
        let closed = package.open.take().expect("opened above");
        drop(closed.file);
        package.closed.push(ClosedMember {
            target: target.clone(),
            identity,
        });
        WriteStep::Accepted(len, Some((hex, identity)), full)
    }

    pub fn write_member(
        publisher: &BackupPublisher,
        token: u64,
        selector: &MemberSelector,
        is_final: bool,
        byte_length: Option<u64>,
        chunk: &[u8],
    ) -> WriteResult {
        if chunk.len() as u64 > CHUNK_CAP_BYTES {
            return WriteResult::refused("backup-chunk-too-large");
        }
        let target = match resolve_member(selector) {
            Ok(target) => target,
            Err(code) => return WriteResult::refused(code),
        };
        with_session(publisher, token, |_session, inner| {
            if inner.state != State::PackageOpen || inner.open_package.is_none() {
                return WriteResult::refused("backup-invalid-state");
            }
            let step = {
                let package = inner.open_package.as_mut().expect("checked above");
                write_member_step(package, &target, is_final, byte_length, chunk)
            };
            match step {
                WriteStep::Accepted(len, closed, full) => {
                    if closed.is_some() {
                        inner.full_fsync &= full;
                    }
                    WriteResult {
                        ok: true,
                        status: "accepted".to_string(),
                        member_bytes: Some(len),
                        member_sha256: closed.map(|(hex, _)| format!("sha256-{hex}")),
                        codes: Vec::new(),
                    }
                }
                WriteStep::Refuse(code) => WriteResult::refused(code),
                WriteStep::Discard(code) => write_refusal(inner, code),
            }
        })
        .unwrap_or_else(WriteResult::refused)
    }

    // ── PACKAGE FINISH (§9 binding sequence, §13 steps 3–6) ───────────

    fn finish_refusal(inner: &mut SessionInner, code: &str) -> PackageFinishResult {
        let clean = discard_open_package(inner);
        let mut out = PackageFinishResult::refused(code);
        if !clean {
            out.codes.push("backup-cleanup-incomplete".to_string());
        }
        out
    }

    pub fn package_finish(
        publisher: &BackupPublisher,
        token: u64,
        expected_content_hash: &str,
    ) -> PackageFinishResult {
        with_session(publisher, token, |_session, inner| {
            if inner.state != State::PackageOpen || inner.open_package.is_none() {
                return PackageFinishResult::refused("backup-invalid-state");
            }
            // (1) both application members closed, no member open.
            let (chat_id, snapshot_id, stage_name) = {
                let package = inner.open_package.as_ref().expect("checked above");
                let closed = |kind| package.closed.iter().any(|c| c.target.kind == kind);
                if package.open.is_some()
                    || !closed(MemberKind::Snapshot)
                    || !closed(MemberKind::Manifest)
                {
                    return PackageFinishResult::refused("backup-invalid-state");
                }
                (
                    package.chat_id.clone(),
                    package.snapshot_id.clone(),
                    package.stage_name.clone(),
                )
            };
            // The renderer's claim, normalized (NB-13). A malformed value is a
            // protocol error with no side effect.
            let Some(expected_hex) = normalize_expected_sha(expected_content_hash) else {
                return PackageFinishResult::refused("backup-invalid-member-name");
            };

            // (2) fences: assets/ then the stage directory (class K).
            let fenced = {
                let package = inner.open_package.as_ref().expect("checked above");
                package
                    .assets
                    .as_ref()
                    .map_or(true, |assets| fence(assets, FenceSite::PackageAssets))
                    && fence(&package.stage, FenceSite::PackageStage)
            };
            if !fenced {
                return finish_refusal(inner, "backup-fence-failed");
            }

            // (3) the trusted verifier, on the retained packages object and
            // the dot-prefixed stage name (NB-11).
            let verification = match inner.packages.as_ref() {
                Some(packages) => verify_occupant_all_supported(packages, &stage_name),
                None => return finish_refusal(inner, "backup-invalid-state"),
            };
            let verified = match verification {
                Ok(verified) => verified,
                Err((_outcome, code, granular)) => {
                    let mut out = finish_refusal(inner, "backup-package-verification-failed");
                    out.codes.push(code.to_string());
                    if let Some(granular) = granular {
                        out.codes.push(granular.to_string());
                    }
                    return out;
                }
            };
            if verified.family != crate::saved_chat_package_verify::PackageFamily::V3 {
                drop(verified);
                let mut out = finish_refusal(inner, "backup-package-verification-failed");
                out.codes.push("construction-family-not-v3".to_string());
                return out;
            }
            // (4) recomputed identity MUST equal the claim; (5) the verified
            // pair MUST equal the pair declared at package_begin.
            let Some(recomputed_hex) = normalize_expected_sha(&verified.content_hash) else {
                drop(verified);
                return finish_refusal(inner, "backup-package-verification-failed");
            };
            if recomputed_hex != expected_hex
                || verified.manifest.chat_id != chat_id
                || verified.manifest.snapshot_id != snapshot_id
            {
                // (6) no promotion; the stage is removed.
                drop(verified);
                return finish_refusal(inner, "backup-package-identity-mismatch");
            }

            // (7) derive and admit the leaf, promote create-only, H′, fence.
            let leaf = generation_basename(&chat_id, &recomputed_hex);
            let name_limit = inner.packages.as_ref().map(|packages| packages.name_max());
            match name_limit {
                Some(Ok(limit)) if leaf.len() as u64 <= limit => {}
                Some(Ok(_)) => {
                    drop(verified);
                    return finish_refusal(inner, "backup-name-exceeds-filesystem-limit");
                }
                _ => {
                    drop(verified);
                    return finish_refusal(inner, "backup-name-limit-indeterminate");
                }
            }
            let saved_at = match crate::archive_generation_order::classify(
                &crate::archive_generation_order::VerifiedGenerationFacts {
                    saved_at: verified.saved_at.clone(),
                    content_hash: recomputed_hex.clone(),
                },
            ) {
                Ok(ordered) => Some(ordered.saved_at),
                Err(_) => None,
            };
            let entry = ManifestEntry {
                chat_id: chat_id.clone(),
                snapshot_id: snapshot_id.clone(),
                content_hash: format!("sha256-{recomputed_hex}"),
                package_leaf: leaf.clone(),
                construction_family: CONSTRUCTION_FAMILY_V3.to_string(),
                schema_version: verified.manifest.schema_version,
                payload_version: verified.manifest.payload_version.unwrap_or(3),
                snapshot: EntrySnapshot {
                    encoding: match verified.snapshot_encoding {
                        crate::saved_chat_package_verify::SnapshotEncoding::Identity => "identity",
                        crate::saved_chat_package_verify::SnapshotEncoding::Gzip => "gzip",
                    }
                    .to_string(),
                    physical_sha256: verified.snapshot_physical_sha256.clone(),
                    physical_byte_length: verified.snapshot_physical_byte_length,
                    logical_sha256: verified.logical_snapshot_sha256.clone(),
                    logical_byte_length: verified.logical_snapshot_byte_length,
                },
                members: verified.persistent_members.clone(),
                assets: verified.asset_shas.clone(),
                asset_source: ASSET_SOURCE.to_string(),
                saved_at,
            };
            // Release the verifier's handle on the stage before promotion.
            drop(verified);

            // H′ pre-image: the retained stage object's identity, captured
            // immediately before the exclusive rename.
            let (pre_identity, members, has_assets_dir) = {
                let package = inner.open_package.as_ref().expect("checked above");
                let pre = identity_of_fd(package.stage.as_raw_fd());
                let members: Vec<(String, bool, ObjectIdentity)> = package
                    .closed
                    .iter()
                    .map(|closed| {
                        (
                            closed.target.basename.clone(),
                            closed.target.kind == MemberKind::Asset,
                            closed.identity,
                        )
                    })
                    .collect();
                (pre, members, package.assets.is_some())
            };
            let Ok(pre_identity) = pre_identity else {
                return finish_refusal(inner, "backup-publication-identity-mismatch");
            };
            let promoted = inner
                .packages
                .as_ref()
                .map(|packages| packages.promote_dir_exclusive(&stage_name, leaf.as_bytes()));
            match promoted {
                Some(Ok(true)) => {}
                Some(Ok(false)) => return finish_refusal(inner, "backup-package-leaf-occupied"),
                Some(Err(err)) if err.kind() == std::io::ErrorKind::Unsupported => {
                    return finish_refusal(inner, "backup-unsupported-platform")
                }
                _ => return finish_refusal(inner, "backup-promote-failed"),
            }
            // The stage is now the leaf: it leaves the open-package cleanup
            // scope and becomes a registered (identity-tracked) package.
            drop(inner.open_package.take());
            inner.state = State::Staging;
            let published = PublishedPackage {
                entry: entry.clone(),
                identity: pre_identity,
                members,
                has_assets_dir,
            };
            let identity_ok = inner.packages.as_ref().is_some_and(|packages| {
                child_is_object(packages, leaf.as_bytes(), pre_identity, true)
            });
            if !identity_ok {
                // The rename returned but the object at the leaf is not the
                // verified one: never registered, never removed (not ours).
                return PackageFinishResult::refused("backup-publication-identity-mismatch");
            }
            let fenced = inner
                .packages
                .as_ref()
                .is_some_and(|packages| fence(packages, FenceSite::PackagesDir));
            if !fenced {
                // The package was inserted but its entry is not yet durable
                // and the run has not committed: the package FAILS and its
                // own leaf is removed (identity-checked), so the manifest
                // stays consistent with what is registered.
                let clean = inner
                    .packages
                    .as_ref()
                    .is_some_and(|packages| remove_published_leaf(packages, &published));
                let mut out = PackageFinishResult::refused("backup-fence-failed");
                if !clean {
                    out.codes.push("backup-cleanup-incomplete".to_string());
                }
                return out;
            }
            inner.published.insert((chat_id, snapshot_id), published);
            PackageFinishResult {
                ok: true,
                status: "verified".to_string(),
                entry: Some(entry),
                codes: Vec::new(),
            }
        })
        .unwrap_or_else(PackageFinishResult::refused)
    }

    // ── PACKAGE ABORT ─────────────────────────────────────────────────

    /// Removes the open package stage only. Benign when no package is open
    /// (a stage already discarded by a failed write or finish).
    pub fn package_abort(publisher: &BackupPublisher, token: u64) -> AbortResult {
        with_session(publisher, token, |_session, inner| match inner.state {
            State::PackageOpen | State::Staging => {
                let clean = discard_open_package(inner);
                AbortResult::aborted(!clean)
            }
            _ => AbortResult::refused("backup-invalid-state"),
        })
        .unwrap_or_else(AbortResult::refused)
    }

    // ── ABORT (run) ───────────────────────────────────────────────────

    /// Cooperative cancellation (NB-06): the flag is raised first so an
    /// in-flight command completes only its current step, then the lease
    /// is taken and the run's own staging tree is removed.
    pub fn abort(publisher: &BackupPublisher, token: u64) -> AbortResult {
        let Some(session) = publisher.lookup(token) else {
            return AbortResult::refused("backup-session-unknown");
        };
        session.abort_requested.store(true, Ordering::SeqCst);
        let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.last_activity = Instant::now();
        match inner.state {
            State::Aborted => AbortResult::refused("backup-cancelled"),
            // After the commit point (or after a failed run cleaned itself)
            // the abort is a no-op; nothing is retracted or touched.
            State::Published | State::Failed => AbortResult::aborted(false),
            State::Staging | State::PackageOpen | State::SetFinalizing => {
                let clean = cleanup_own_tree(publisher, &mut inner);
                inner.state = State::Aborted;
                AbortResult::aborted(!clean)
            }
        }
    }

    // ── FINALIZE (§9, §13 steps 7–12, §15) ────────────────────────────

    fn fail_run(
        publisher: &BackupPublisher,
        inner: &mut SessionInner,
        code: &str,
    ) -> FinalizeResult {
        let clean = cleanup_own_tree(publisher, inner);
        inner.state = State::Failed;
        let mut out = FinalizeResult::refused(&inner.backup_id, code);
        if !clean {
            out.codes.push("backup-cleanup-incomplete".to_string());
        }
        out
    }

    fn validate_failures(
        inner: &SessionInner,
        failures: &[FailureDeclaration],
    ) -> Result<Vec<FailureRecord>, &'static str> {
        let mut records = Vec::with_capacity(failures.len());
        let mut seen = BTreeSet::new();
        for failure in failures {
            let pair = (failure.chat_id.clone(), failure.snapshot_id.clone());
            if !inner.declaration.eligible.contains(&pair) {
                return Err("backup-entry-unknown");
            }
            if inner.published.contains_key(&pair) || !seen.insert(pair.clone()) {
                return Err("backup-manifest-inconsistent");
            }
            if failure.code.is_empty() || failure.code.len() > 128 || failure.stage.len() > 64 {
                return Err("backup-manifest-inconsistent");
            }
            records.push(FailureRecord {
                chat_id: pair.0,
                snapshot_id: pair.1,
                code: failure.code.clone(),
                stage: failure.stage.clone(),
                detail: bounded_text(&failure.detail, FAILURE_DETAIL_MAX_BYTES),
            });
        }
        // Every declared pair is exactly one of: published, failed.
        if inner.published.len() + records.len() != inner.declaration.eligible.len() {
            return Err("backup-manifest-inconsistent");
        }
        records.sort_by(|a, b| {
            a.chat_id
                .cmp(&b.chat_id)
                .then(a.snapshot_id.cmp(&b.snapshot_id))
        });
        Ok(records)
    }

    pub fn finalize(
        publisher: &BackupPublisher,
        token: u64,
        failures: &[FailureDeclaration],
    ) -> FinalizeResult {
        with_session(publisher, token, |session, inner| {
            let backup_id = inner.backup_id.clone();
            // Pre-transition refusals: no side effect, the session stays STAGING.
            if inner.state != State::Staging || inner.open_package.is_some() {
                return FinalizeResult::refused(&backup_id, "backup-invalid-state");
            }
            if inner.published.is_empty() {
                return FinalizeResult::refused(&backup_id, "backup-no-package-succeeded");
            }
            let records = match validate_failures(inner, failures) {
                Ok(records) => records,
                Err(code) => return FinalizeResult::refused(&backup_id, code),
            };
            let counts = Counts {
                enumerated: inner.declaration.enumerated_count,
                eligible: inner.declaration.eligible.len() as u64,
                success: inner.published.len() as u64,
                failed: records.len() as u64,
                skipped: inner.declaration.skipped,
            };
            if !counts.identities_hold() {
                return FinalizeResult::refused(&backup_id, "backup-manifest-inconsistent");
            }
            let complete = records.is_empty();
            let mut entries: Vec<ManifestEntry> =
                inner.published.values().map(|p| p.entry.clone()).collect();
            sort_entries(&mut entries);
            let digest_triples: Vec<(String, String, String)> =
                entries.iter().map(entry_digest_triple).collect();
            let digest = set_digest(&digest_triples);
            let created_at = iso8601_millis(now_millis());
            let manifest_bytes = render_json(
                &manifest_json(&ManifestInputs {
                    backup_id: &backup_id,
                    created_at: &created_at,
                    app_build_stamp: &inner.declaration.app_build_stamp,
                    live_generation_family:
                        crate::saved_chat_generation_policy::production_live_generation_family()
                            .as_str(),
                    platform: PLATFORM_FAMILY.unwrap_or("unsupported"),
                    host_root_mode:
                        crate::saved_chat_backup_root_policy::production_saved_chat_backup_root()
                            .base_directory(),
                    enumeration_at: &inner.declaration.at,
                    counts,
                    entries: &entries,
                    failures: &records,
                    set_digest: &digest,
                    full_fsync: inner.full_fsync,
                }),
                true,
            )
            .into_bytes();
            // Writer-side bound (NB-07): refused BEFORE any temp file exists.
            if manifest_bytes.len() as u64 > manifest_max_bytes() {
                return FinalizeResult::refused(&backup_id, "backup-manifest-too-large");
            }
            let manifest_sha256 = format!(
                "sha256-{}",
                crate::archive_durable_write::sha256_hex(&manifest_bytes)
            );

            // From here on every failure is FAILED with own cleanup.
            inner.state = State::SetFinalizing;
            let mut checkpoints_passed: u32 = 0;
            macro_rules! checkpoint {
                () => {
                    checkpoints_passed += 1;
                    if abort_pending(session, checkpoints_passed) {
                        return fail_run(publisher, inner, "backup-cancelled");
                    }
                };
            }

            // Step 8: manifest — exclusive temp (D), write, content fence (J),
            // create-only promotion (F), H′, run fence (K).
            checkpoint!();
            let temp_name = format!(
                "{MANIFEST_STAGING_PREFIX}{}{MANIFEST_STAGING_SUFFIX}",
                hex32()
            )
            .into_bytes();
            let created = inner
                .run
                .as_ref()
                .map(|run| run.create_new_child(&temp_name));
            let mut file = match created {
                Some(Ok(file)) => file,
                _ => return fail_run(publisher, inner, "backup-write-failed"),
            };
            let manifest_identity = match identity_of_fd(file.as_raw_fd()) {
                Ok(identity) => identity,
                Err(_) => {
                    drop(file);
                    if let Some(run) = inner.run.as_ref() {
                        let _ = run.unlink_child(&temp_name);
                    }
                    return fail_run(publisher, inner, "backup-write-failed");
                }
            };
            inner
                .manifest_artifacts
                .push((temp_name.clone(), manifest_identity));
            if file.write_all(&manifest_bytes).is_err() {
                drop(file);
                return fail_run(publisher, inner, "backup-write-failed");
            }
            let full = match content_fence(&file, FenceSite::ManifestContent) {
                Ok(full) => full,
                Err(_) => {
                    drop(file);
                    return fail_run(publisher, inner, "backup-fence-failed");
                }
            };
            drop(file);
            inner.full_fsync &= full;
            let promoted = inner
                .run
                .as_ref()
                .map(|run| run.promote_exclusive(&temp_name, BACKUP_MANIFEST_NAME.as_bytes()));
            if !matches!(promoted, Some(Ok(true))) {
                return fail_run(publisher, inner, "backup-promote-failed");
            }
            // The temp name is consumed; the published name is now ours.
            inner.manifest_artifacts.clear();
            inner
                .manifest_artifacts
                .push((BACKUP_MANIFEST_NAME.as_bytes().to_vec(), manifest_identity));
            let identity_ok = inner.run.as_ref().is_some_and(|run| {
                child_is_object(
                    run,
                    BACKUP_MANIFEST_NAME.as_bytes(),
                    manifest_identity,
                    false,
                )
            });
            if !identity_ok {
                return fail_run(publisher, inner, "backup-publication-identity-mismatch");
            }
            let fenced = inner
                .run
                .as_ref()
                .is_some_and(|run| fence(run, FenceSite::RunAfterManifest));
            if !fenced {
                return fail_run(publisher, inner, "backup-fence-failed");
            }

            // Step 9: set verification on the native-derived staging run path
            // (RC-T01-BACKUP-02); the scanner opens `<run>/packages` itself.
            checkpoint!();
            let run_path = {
                use std::os::unix::ffi::OsStrExt;
                publisher
                    .root
                    .join(std::ffi::OsStr::from_bytes(&inner.run_name))
            };
            let scan = crate::archive_package_scan::scan_packages_within(&run_path);
            let recomputed = match cross_check_set(&scan, &entries) {
                Ok(recomputed) => recomputed,
                Err(code) => return fail_run(publisher, inner, code),
            };
            if recomputed != digest {
                return fail_run(publisher, inner, "backup-set-digest-mismatch");
            }

            // Step 10: run fence after the verification reads.
            checkpoint!();
            let fenced = inner
                .run
                .as_ref()
                .is_some_and(|run| fence(run, FenceSite::RunAfterScan));
            if !fenced {
                return fail_run(publisher, inner, "backup-fence-failed");
            }

            // Step 11: the SINGLE commit point — create-only promotion of the
            // run directory to the final leaf chosen by `complete`.
            checkpoint!();
            let leaf = final_leaf(&backup_id, complete);
            let root = match confined::Dir::open_existing_nofollow(&publisher.root) {
                Ok(root) => root,
                Err(err) if is_redirect_error(&err) => {
                    return fail_run(publisher, inner, "backup-path-redirect-refused")
                }
                Err(_) => return fail_run(publisher, inner, "backup-root-unavailable"),
            };
            match root.name_max() {
                Ok(limit) if leaf.len() as u64 <= limit => {}
                Ok(_) => return fail_run(publisher, inner, "backup-name-exceeds-filesystem-limit"),
                Err(_) => return fail_run(publisher, inner, "backup-name-limit-indeterminate"),
            }
            let run_identity = match inner
                .run
                .as_ref()
                .map(|run| identity_of_fd(run.as_raw_fd()))
            {
                Some(Ok(identity)) => identity,
                _ => return fail_run(publisher, inner, "backup-publication-identity-mismatch"),
            };
            let run_name = inner.run_name.clone();
            let promoted = match root.promote_dir_exclusive(&run_name, leaf.as_bytes()) {
                Ok(value) => value,
                Err(err) if err.kind() == std::io::ErrorKind::Unsupported => {
                    return fail_run(publisher, inner, "backup-unsupported-platform")
                }
                Err(_) => return fail_run(publisher, inner, "backup-promote-failed"),
            };
            if !promoted {
                return fail_run(publisher, inner, "backup-destination-exists");
            }

            // Promotion IS the commit point: the staged tree is now the
            // published backup, it leaves cleanup scope, and no failure below
            // can retract it.
            inner.run = None;
            inner.packages = None;
            inner.manifest_artifacts.clear();

            // Step 12: H′ then the root fence (K).
            let mut codes = Vec::new();
            if !child_is_object(&root, leaf.as_bytes(), run_identity, true) {
                inner.state = State::Failed;
                let mut out =
                    FinalizeResult::refused(&backup_id, "backup-publication-identity-mismatch");
                out.committed = true;
                return out;
            }
            let durability_complete = fence(&root, FenceSite::Root);
            if !durability_complete {
                codes.push("backup-fence-failed".to_string());
            }
            inner.state = State::Published;
            FinalizeResult {
                ok: true,
                status: if complete {
                    "published".to_string()
                } else {
                    "published-partial".to_string()
                },
                committed: true,
                durability_complete,
                full_fsync: inner.full_fsync,
                backup_id,
                backup_leaf: Some(leaf),
                complete: Some(complete),
                counts: Some(counts),
                set_digest: Some(digest),
                manifest_sha256: Some(manifest_sha256),
                codes,
            }
        })
        .unwrap_or_else(|code| FinalizeResult::refused("", code))
    }

    // ── LIST (read-only, §9/§14) ──────────────────────────────────────

    fn classify_root_entry(root: &confined::Dir, raw: &[u8]) -> ListEntry {
        let Ok(name) = std::str::from_utf8(raw) else {
            return ListEntry {
                leaf: String::from_utf8_lossy(raw).into_owned(),
                kind: "foreign".to_string(),
                backup_id: None,
                manifest_present: None,
            };
        };
        if is_backup_reserved_name(name) {
            return ListEntry {
                leaf: name.to_string(),
                kind: "staging-residue".to_string(),
                backup_id: None,
                manifest_present: None,
            };
        }
        if let Some((backup_id, partial)) = parse_final_leaf(name) {
            let is_dir = matches!(root.stat_child_nofollow(raw), Ok(Some(st)) if is_directory(&st));
            if is_dir {
                let manifest_present = root
                    .open_child_nofollow(raw)
                    .ok()
                    .and_then(|dir| {
                        dir.stat_child_nofollow(BACKUP_MANIFEST_NAME.as_bytes())
                            .ok()
                    })
                    .flatten()
                    .is_some_and(|st| confined::is_regular(&st));
                return ListEntry {
                    leaf: name.to_string(),
                    kind: if partial {
                        "backup-partial".to_string()
                    } else {
                        "backup".to_string()
                    },
                    backup_id: Some(backup_id),
                    manifest_present: Some(manifest_present),
                };
            }
        }
        ListEntry {
            leaf: name.to_string(),
            kind: "foreign".to_string(),
            backup_id: None,
            manifest_present: None,
        }
    }

    pub fn list(publisher: &BackupPublisher) -> ListResult {
        let display = publisher.root.to_string_lossy().into_owned();
        let refused = |code: &str, present: bool| ListResult {
            ok: false,
            status: code.to_string(),
            root_present: present,
            root_display_path: display.clone(),
            entries: Vec::new(),
            residue_count: 0,
            codes: Vec::new(),
        };
        let root = match confined::Dir::open_existing_nofollow(&publisher.root) {
            Ok(root) => root,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return refused("backup-root-absent", false)
            }
            Err(err) if is_redirect_error(&err) => {
                return refused("backup-path-redirect-refused", true)
            }
            Err(_) => return refused("backup-root-unavailable", true),
        };
        let names = match root.read_entry_names() {
            Ok(names) => names,
            Err(_) => return refused("backup-root-unavailable", true),
        };
        let mut entries: Vec<ListEntry> = names
            .iter()
            .map(|raw| classify_root_entry(&root, raw))
            .collect();
        entries.sort_by(|a, b| a.leaf.cmp(&b.leaf));
        let residue_count = entries
            .iter()
            .filter(|entry| entry.kind == "staging-residue")
            .count() as u64;
        let mut codes = Vec::new();
        if residue_count > 0 {
            codes.push("backup-staging-residue-detected".to_string());
        }
        ListResult {
            ok: true,
            status: "listed".to_string(),
            root_present: true,
            root_display_path: display,
            entries,
            residue_count,
            codes,
        }
    }

    // ── VERIFY (read-only, §15) ───────────────────────────────────────

    /// Reads at most `cap + 1` bytes of the manifest through the admitted
    /// leaf object; never follows a link.
    fn read_manifest_bounded(
        leaf: &confined::Dir,
        cap: u64,
    ) -> Result<Vec<u8>, (&'static str, &'static str)> {
        use std::io::Read;
        let st = match leaf.stat_child_nofollow(BACKUP_MANIFEST_NAME.as_bytes()) {
            Ok(Some(st)) => st,
            Ok(None) => return Err(("malformed", "backup-manifest-invalid")),
            Err(_) => return Err(("unreadable", "backup-root-unavailable")),
        };
        if !confined::is_regular(&st) {
            return Err(("malformed", "backup-manifest-invalid"));
        }
        if st.st_size < 0 || st.st_size as u64 > cap {
            return Err(("malformed", "backup-manifest-too-large"));
        }
        let file = leaf
            .open_child_read_nofollow(BACKUP_MANIFEST_NAME.as_bytes())
            .map_err(|_| ("unreadable", "backup-root-unavailable"))?;
        let mut bytes = Vec::with_capacity((st.st_size as u64).min(cap) as usize);
        file.take(cap.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| ("unreadable", "backup-root-unavailable"))?;
        if bytes.len() as u64 > cap {
            return Err(("malformed", "backup-manifest-too-large"));
        }
        Ok(bytes)
    }

    pub fn verify(publisher: &BackupPublisher, leaf: &str) -> VerifyResult {
        if PLATFORM_FAMILY.is_none() {
            return VerifyResult::failed("unsupported", "backup-unsupported-platform");
        }
        let Some((leaf_backup_id, partial)) = parse_final_leaf(leaf) else {
            return VerifyResult::failed("unsupported", "backup-not-a-backup-leaf");
        };
        let root = match confined::Dir::open_existing_nofollow(&publisher.root) {
            Ok(root) => root,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return VerifyResult::failed("unreadable", "backup-root-absent")
            }
            Err(err) if is_redirect_error(&err) => {
                return VerifyResult::failed("unreadable", "backup-path-redirect-refused")
            }
            Err(_) => return VerifyResult::failed("unreadable", "backup-root-unavailable"),
        };
        match root.stat_child_nofollow(leaf.as_bytes()) {
            Ok(Some(st)) if is_directory(&st) => {}
            Ok(Some(_)) => {
                return VerifyResult::failed("unreadable", "backup-path-redirect-refused")
            }
            Ok(None) => return VerifyResult::failed("unreadable", "backup-not-a-backup-leaf"),
            Err(_) => return VerifyResult::failed("unreadable", "backup-root-unavailable"),
        }
        let leaf_dir = match root.open_child_nofollow(leaf.as_bytes()) {
            Ok(dir) => dir,
            Err(err) if is_redirect_error(&err) => {
                return VerifyResult::failed("unreadable", "backup-path-redirect-refused")
            }
            Err(_) => return VerifyResult::failed("unreadable", "backup-root-unavailable"),
        };
        let bytes = match read_manifest_bounded(&leaf_dir, BACKUP_MANIFEST_READ_CAP_BYTES) {
            Ok(bytes) => bytes,
            Err((status, code)) => return VerifyResult::failed(status, code),
        };
        drop(leaf_dir);
        let manifest = match parse_manifest(&bytes) {
            Ok(manifest) => manifest,
            Err((status, code)) => return VerifyResult::failed(status, code),
        };
        let mut out = VerifyResult {
            status: "malformed".to_string(),
            codes: Vec::new(),
            backup_id: Some(manifest.backup_id.clone()),
            complete: Some(manifest.complete),
            counts: Some(manifest.counts),
            set_digest: Some(manifest.set_digest.clone()),
            entries_verified: 0,
            occupants_seen: 0,
        };
        if let Err(code) = manifest_consistency(&manifest, partial, &leaf_backup_id) {
            out.codes.push(code.to_string());
            return out;
        }
        // Set verification on the native-derived final backup path; the
        // scanner opens `<backup>/packages` itself and writes nothing.
        let scan = crate::archive_package_scan::scan_packages_within(&publisher.root.join(leaf));
        out.occupants_seen = scan.occupants.len() as u64;
        match cross_check_set(&scan, &manifest.entries) {
            Ok(recomputed) => {
                out.entries_verified = manifest.entries.len() as u64;
                if recomputed != manifest.set_digest {
                    out.codes.push("backup-set-digest-mismatch".to_string());
                    return out;
                }
            }
            Err(code) => {
                out.codes.push(code.to_string());
                return out;
            }
        }
        out.status = if manifest.complete {
            "valid-complete".to_string()
        } else {
            "valid-incomplete".to_string()
        };
        out
    }

    // ── Tauri command surface (§9) ─────────────────────────────────────

    /// The publisher lives in Tauri state so the session survives across
    /// invokes; its root is the immutable backup root policy, resolved on
    /// the trusted side (never from the renderer).
    pub struct BackupState(pub Mutex<Option<Arc<BackupPublisher>>>);

    impl Default for BackupState {
        fn default() -> Self {
            BackupState(Mutex::new(None))
        }
    }

    fn publisher_for(
        app: &tauri::AppHandle,
        state: &tauri::State<'_, BackupState>,
    ) -> Result<Arc<BackupPublisher>, &'static str> {
        let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = slot.as_ref() {
            return Ok(Arc::clone(existing));
        }
        let root = crate::saved_chat_backup_root_policy::production_backup_root(app)?;
        let publisher = Arc::new(BackupPublisher::new(root));
        *slot = Some(Arc::clone(&publisher));
        Ok(publisher)
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BeginOptions {
        pub enumeration: EnumerationDeclaration,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PackageBeginOptions {
        #[serde(deserialize_with = "ipc_token::deserialize")]
        pub token: u64,
        pub chat_id: String,
        pub snapshot_id: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WriteMemberOptions {
        #[serde(deserialize_with = "ipc_token::deserialize")]
        pub token: u64,
        pub member: MemberSelector,
        #[serde(rename = "final", default)]
        pub is_final: bool,
        #[serde(default)]
        pub byte_length: Option<u64>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PackageFinishOptions {
        #[serde(deserialize_with = "ipc_token::deserialize")]
        pub token: u64,
        pub expected_content_hash: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PackageAbortOptions {
        #[serde(deserialize_with = "ipc_token::deserialize")]
        pub token: u64,
        #[serde(default)]
        pub reason: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FinalizeOptions {
        #[serde(deserialize_with = "ipc_token::deserialize")]
        pub token: u64,
        #[serde(default)]
        pub failures: Vec<FailureDeclaration>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AbortOptions {
        #[serde(deserialize_with = "ipc_token::deserialize")]
        pub token: u64,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VerifyOptions {
        pub leaf: String,
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_begin(
        app: tauri::AppHandle,
        state: tauri::State<'_, BackupState>,
        options: BeginOptions,
    ) -> Result<BeginResult, String> {
        let publisher = match publisher_for(&app, &state) {
            Ok(publisher) => publisher,
            Err(code) => return Ok(BeginResult::refused(code)),
        };
        Ok(begin(&publisher, &options.enumeration))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_package_begin(
        app: tauri::AppHandle,
        state: tauri::State<'_, BackupState>,
        options: PackageBeginOptions,
    ) -> Result<AckResult, String> {
        let publisher = match publisher_for(&app, &state) {
            Ok(publisher) => publisher,
            Err(code) => return Ok(AckResult::refused(code)),
        };
        Ok(package_begin(
            &publisher,
            options.token,
            &options.chat_id,
            &options.snapshot_id,
        ))
    }

    /// Raw-body command: the body is one member chunk; the governed member
    /// selector travels in the established encoded `options` header.
    #[tauri::command]
    pub async fn h2o_saved_chat_backup_write_member(
        app: tauri::AppHandle,
        state: tauri::State<'_, BackupState>,
        request: tauri::ipc::Request<'_>,
    ) -> Result<WriteResult, String> {
        let options: WriteMemberOptions = crate::archive_durable_write::required_options(&request)?;
        let chunk = crate::archive_durable_write::body_bytes(&request)?;
        let publisher = match publisher_for(&app, &state) {
            Ok(publisher) => publisher,
            Err(code) => return Ok(WriteResult::refused(code)),
        };
        Ok(write_member(
            &publisher,
            options.token,
            &options.member,
            options.is_final,
            options.byte_length,
            &chunk,
        ))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_package_finish(
        app: tauri::AppHandle,
        state: tauri::State<'_, BackupState>,
        options: PackageFinishOptions,
    ) -> Result<PackageFinishResult, String> {
        let publisher = match publisher_for(&app, &state) {
            Ok(publisher) => publisher,
            Err(code) => return Ok(PackageFinishResult::refused(code)),
        };
        Ok(package_finish(
            &publisher,
            options.token,
            &options.expected_content_hash,
        ))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_package_abort(
        app: tauri::AppHandle,
        state: tauri::State<'_, BackupState>,
        options: PackageAbortOptions,
    ) -> Result<AbortResult, String> {
        let publisher = match publisher_for(&app, &state) {
            Ok(publisher) => publisher,
            Err(code) => return Ok(AbortResult::refused(code)),
        };
        let _ = options.reason;
        Ok(package_abort(&publisher, options.token))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_finalize(
        app: tauri::AppHandle,
        state: tauri::State<'_, BackupState>,
        options: FinalizeOptions,
    ) -> Result<FinalizeResult, String> {
        let publisher = match publisher_for(&app, &state) {
            Ok(publisher) => publisher,
            Err(code) => return Ok(FinalizeResult::refused("", code)),
        };
        Ok(finalize(&publisher, options.token, &options.failures))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_abort(
        app: tauri::AppHandle,
        state: tauri::State<'_, BackupState>,
        options: AbortOptions,
    ) -> Result<AbortResult, String> {
        let publisher = match publisher_for(&app, &state) {
            Ok(publisher) => publisher,
            Err(code) => return Ok(AbortResult::refused(code)),
        };
        Ok(abort(&publisher, options.token))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_list(
        app: tauri::AppHandle,
        state: tauri::State<'_, BackupState>,
    ) -> Result<ListResult, String> {
        let publisher = match publisher_for(&app, &state) {
            Ok(publisher) => publisher,
            Err(code) => {
                return Ok(ListResult {
                    ok: false,
                    status: code.to_string(),
                    root_present: false,
                    root_display_path: String::new(),
                    entries: Vec::new(),
                    residue_count: 0,
                    codes: Vec::new(),
                })
            }
        };
        Ok(list(&publisher))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_verify(
        app: tauri::AppHandle,
        state: tauri::State<'_, BackupState>,
        options: VerifyOptions,
    ) -> Result<VerifyResult, String> {
        let publisher = match publisher_for(&app, &state) {
            Ok(publisher) => publisher,
            Err(code) => return Ok(VerifyResult::failed("unreadable", code)),
        };
        Ok(verify(&publisher, &options.leaf))
    }
}

#[cfg(unix)]
pub use native::*;

// ── Non-Unix arm: FAIL_CLOSED for every command (§12) ──────────────────────

#[cfg(not(unix))]
mod native {
    use super::*;

    const UNSUPPORTED: &str = "backup-unsupported-platform";

    #[derive(Default)]
    pub struct BackupState(pub std::sync::Mutex<()>);

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_begin(
        _options: serde_json::Value,
    ) -> Result<BeginResult, String> {
        Ok(BeginResult::refused(UNSUPPORTED))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_package_begin(
        _options: serde_json::Value,
    ) -> Result<AckResult, String> {
        Ok(AckResult::refused(UNSUPPORTED))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_write_member(
        _request: tauri::ipc::Request<'_>,
    ) -> Result<WriteResult, String> {
        Ok(WriteResult::refused(UNSUPPORTED))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_package_finish(
        _options: serde_json::Value,
    ) -> Result<PackageFinishResult, String> {
        Ok(PackageFinishResult::refused(UNSUPPORTED))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_package_abort(
        _options: serde_json::Value,
    ) -> Result<AbortResult, String> {
        Ok(AbortResult::refused(UNSUPPORTED))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_finalize(
        _options: serde_json::Value,
    ) -> Result<FinalizeResult, String> {
        Ok(FinalizeResult::refused("", UNSUPPORTED))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_abort(
        _options: serde_json::Value,
    ) -> Result<AbortResult, String> {
        Ok(AbortResult::refused(UNSUPPORTED))
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_list() -> Result<ListResult, String> {
        Ok(ListResult {
            ok: false,
            status: UNSUPPORTED.to_string(),
            root_present: false,
            root_display_path: String::new(),
            entries: Vec::new(),
            residue_count: 0,
            codes: Vec::new(),
        })
    }

    #[tauri::command]
    pub async fn h2o_saved_chat_backup_verify(
        _options: serde_json::Value,
    ) -> Result<VerifyResult, String> {
        Ok(VerifyResult::failed("unsupported", UNSUPPORTED))
    }
}

#[cfg(not(unix))]
pub use native::*;

#[cfg(test)]
mod tests;
