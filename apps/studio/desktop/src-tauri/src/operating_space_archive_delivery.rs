//! B2B v1 — minimum private immutable Operating-Space Archive physical delivery.
//!
//! Mission `establish-operating-space-archive-physical-delivery-v1`, T02, under
//! the accepted T01 contract/reuse map. This module is the ONLY B2B-owned
//! Product surface: a purpose-bounded publisher, resolver, protection recorder
//! and delivery verifier for ONE governed Archive inventory evidence object at
//! a time.
//!
//! COMPOSE, DON'T REIMPLEMENT. Every durability, confinement and hashing
//! primitive here is the incumbent Saved-Chats authority in
//! `archive_durable_write`:
//!
//!   * `durable_write_within_root` — the accepted create-only CAS publication
//!     (descriptor-relative, `O_NOFOLLOW`, private staging, content fsync,
//!     exclusive promotion, parent-directory fence, governed object ceiling).
//!     Both the primary object and the recovery-only secondary copy go through
//!     it, so B2B adds NO second durable-write implementation.
//!   * `confined::Dir` + `sync_file_contents` — consumed directly for the one
//!     destination the CAS writer deliberately refuses (the protection record,
//!     which is not a content-addressed blob).
//!   * `sha256_hex` — the single hashing authority.
//!
//! B2B ESTABLISHES NO NEW GENERIC AUTHORITY. There is no second CAS stack, no
//! AssetRef, no reference counting, no generic put/get, no binary-assets
//! extraction, no delete/GC/reclamation surface, and no repair/replace path.
//! The incumbent corrupt-object replacement entry point is deliberately never
//! reached from here: an occupied content identity whose bytes do not verify
//! FAILS CLOSED instead.
//!
//! THE CALLER NAMES NO PHYSICAL LOCATION. The wire descriptor carries Archive
//! semantics only and is `deny_unknown_fields`, so a `path`, `root`,
//! `destination`, `shard`, `overwrite`, `repair` or `delete` key is a hard
//! deserialization refusal rather than a silently ignored field. Every physical
//! destination is derived inside this module from the digest this module
//! computes over the bytes it received. `logical_path` is Archive metadata and
//! is NEVER used to build a path. Results deliberately expose no physical path.
//!
//! EXACT BYTES ARE THE AUTHORITY. Nothing here rewrites, normalizes,
//! decompresses, reinterprets or decomposes evidence bytes. A package chosen by
//! a governed capture adapter as one inventory object stays one opaque object.
//!
//! SOURCE ACQUISITION IS SOMEONE ELSE'S PROBLEM. This module accepts supplied
//! governed evidence only. It holds no network, browser, credential, cookie,
//! session or signed-URL authority of any kind.
//!
//! PLATFORM: Unix, proven on macOS — the reused confinement primitives are
//! Unix-only, so every non-Unix target fails closed rather than degrading to a
//! raceable pathname model.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::archive_durable_write::{sha256_hex, GOVERNED_ASSET_BLOB_CAP_BYTES};

pub const DELIVERY_SCHEMA: &str = "h2o.storage.operating-space-archive-delivery.v1";
pub const PUBLISH_SCHEMA: &str = "h2o.storage.operating-space-archive-delivery.publish.v1";
pub const PROTECTION_SCHEMA: &str = "h2o.storage.operating-space-archive-delivery.protection.v1";
pub const VERIFY_SCHEMA: &str = "h2o.storage.operating-space-archive-delivery.verify.v1";

/// Fixed final component of the recovery-only secondary root (T01 §5).
/// Deliberately distinct from the incumbent `H2O Studio Backups` component so
/// the accepted Saved-Chat backup object grammar and listing are not polluted.
pub const BACKUP_ROOT_COMPONENT: &str = "H2O Operating-Space Archive Backups";

/// Protection mapping namespace beneath the archive root.
pub const PROTECTION_DIR: &str = "operating-space-protection";
/// Fixed prefix of a protection record's file name.
pub const PROTECTION_PREFIX: &str = "protection-";
/// Fixed suffix of a protection record's file name.
pub const PROTECTION_SUFFIX: &str = ".json";

/// Distinguishes this module's staging artifacts from the CAS writer's own.
/// The RESERVED prefix is reused verbatim so no second reservation is minted;
/// the infix guarantees a B2B staging name can never collide with one the
/// incumbent generator produces.
const STAGING_INFIX: &str = "b2b-";
const STAGING_ATTEMPTS: u32 = 8;

/// Bounded caps. Every caller-supplied string is length-checked before it can
/// reach an allocation, a hash or a comparison.
const IDENTIFIER_MAX_BYTES: usize = 256;
const LOGICAL_PATH_MAX_BYTES: usize = 1024;
const MEDIA_TYPE_MAX_BYTES: usize = 256;
/// One capture's inventory cannot protect an unbounded number of identities in
/// v1; a larger inventory fails closed rather than allocating without bound.
pub const MAX_PROTECTED_IDENTITIES: usize = 65_536;
/// Read ceiling for a protection record, comfortably above the maximum a
/// bounded inventory can produce.
const PROTECTION_READ_CAP_BYTES: usize = 8 * 1024 * 1024;

static STAGING_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

// ── Wire contract ──────────────────────────────────────────────────────────

/// One governed Archive inventory evidence object's SEMANTIC descriptor.
///
/// `deny_unknown_fields` is load-bearing, not tidiness: it is what makes a
/// caller-supplied physical destination, overwrite instruction or repair
/// instruction an outright refusal instead of an ignored key.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceDescriptor {
    /// GSC/Archive-minted logical Archive identity. Storage never mints or
    /// rewrites it, and it never becomes a path component.
    pub archive_record_id: String,
    /// Stable operating-space code. Metadata only.
    pub space_code: String,
    /// Provenance/container sequence (`^[0-9]+$`, positive in v1).
    pub continuation: u64,
    /// Immutable capture identity (`^v[0-9]{3,}$`).
    pub capture_version: String,
    /// Capture-logical namespace key. METADATA ONLY — never a physical path.
    pub logical_path: String,
    /// Caller-asserted content identity (`^[0-9a-f]{64}$`). It can only cause a
    /// refusal: the destination is derived from the digest computed here.
    pub sha256: String,
    /// Caller-asserted exact byte length. Can only cause a refusal.
    pub size_bytes: u64,
    /// Capture metadata, excluded from identity.
    #[serde(default)]
    pub media_type: Option<String>,
    /// v1 requires `null`. Accepted so a conformant governed inventory object
    /// deserializes, and immediately refused when non-null. It is never read
    /// into a destination and is never identity.
    #[serde(default)]
    pub external_payload_ref: Option<serde_json::Value>,
}

/// Create-only protection mapping request (T01 §7).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtectionRequest {
    pub archive_record_id: String,
    pub capture_version: String,
    /// The capture's inventory content identities. Sorted and deduplicated
    /// here; order and duplicates in the request are not significant.
    pub protected_identities: Vec<String>,
}

/// Content-identity lookup. There is no path, root or provider input.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityRequest {
    pub sha256: String,
    /// Optional Archive descriptor assertion. Can only cause a refusal.
    #[serde(default)]
    pub expected_size_bytes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryBlocker {
    pub code: String,
}

impl DeliveryBlocker {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
        }
    }
}

/// Per-copy truth. Committed-ness and durability-completeness describe THIS
/// operation only, so a verified pre-existing object never silently claims a
/// fence this operation did not perform.
///
/// Deliberately carries no `path`: a physical location is never returned into
/// Archive metadata (T01 §6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyOutcome {
    /// The canonical object is in place.
    pub present: bool,
    /// This operation created it.
    pub created: bool,
    /// An existing byte-identical object was proven by verified read and reused.
    pub reused: bool,
    /// This operation's exclusive promotion succeeded.
    pub committed: bool,
    /// This operation's parent-directory fence succeeded after promotion.
    pub durability_complete: bool,
    /// Contents were flushed with macOS `F_FULLFSYNC` rather than plain fsync.
    pub full_fsync: bool,
    /// A verified readback reproduced the exact content identity and size.
    pub verified: bool,
}

impl CopyOutcome {
    /// A copy counts as delivered only when it is present AND verified, and —
    /// when this operation created it — fully fenced. A committed-but-unfenced
    /// create can never report delivered.
    fn is_durably_delivered(&self) -> bool {
        self.present
            && self.verified
            && (!self.created || (self.committed && self.durability_complete))
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub schema: &'static str,
    pub ok: bool,
    /// The identity this module COMPUTED over the bytes it received.
    pub sha256: String,
    /// The length this module OBSERVED.
    pub byte_length: u64,
    pub primary: CopyOutcome,
    /// Recovery-only secondary copy. Never a resolver or CAS authority.
    pub backup: CopyOutcome,
    pub blockers: Vec<DeliveryBlocker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl PublishResult {
    fn skeleton() -> Self {
        Self {
            schema: PUBLISH_SCHEMA,
            ok: false,
            sha256: String::new(),
            byte_length: 0,
            primary: CopyOutcome::default(),
            backup: CopyOutcome::default(),
            blockers: vec![],
            detail: None,
        }
    }

    pub fn blocked(code: &str) -> Self {
        let mut result = Self::skeleton();
        result.blockers.push(DeliveryBlocker::new(code));
        result
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtectionResult {
    pub schema: &'static str,
    pub ok: bool,
    /// Count only. The protection record holds no payload bytes and the result
    /// returns no physical location.
    pub protected_identity_count: u64,
    pub record: CopyOutcome,
    pub blockers: Vec<DeliveryBlocker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl ProtectionResult {
    fn skeleton() -> Self {
        Self {
            schema: PROTECTION_SCHEMA,
            ok: false,
            protected_identity_count: 0,
            record: CopyOutcome::default(),
            blockers: vec![],
            detail: None,
        }
    }

    pub fn blocked(code: &str) -> Self {
        let mut result = Self::skeleton();
        result.blockers.push(DeliveryBlocker::new(code));
        result
    }
}

/// Read-only delivery state for one content identity.
///
/// `present: false` with no blocker is UNRESOLVED (absence). A corrupt or
/// mismatching object reports a blocker and never reads as merely missing.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResult {
    pub schema: &'static str,
    pub ok: bool,
    pub sha256: String,
    pub primary_present: bool,
    pub primary_verified: bool,
    pub backup_present: bool,
    pub backup_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_length: Option<u64>,
    pub blockers: Vec<DeliveryBlocker>,
}

impl VerifyResult {
    fn skeleton(sha256: String) -> Self {
        Self {
            schema: VERIFY_SCHEMA,
            ok: false,
            sha256,
            primary_present: false,
            primary_verified: false,
            backup_present: false,
            backup_verified: false,
            byte_length: None,
            blockers: vec![],
        }
    }

    pub fn blocked(code: &str) -> Self {
        let mut result = Self::skeleton(String::new());
        result.blockers.push(DeliveryBlocker::new(code));
        result
    }
}

// ── Validation (platform independent) ──────────────────────────────────────

/// A bounded opaque Archive identifier. Storage validates shape and never
/// mints, rewrites or path-encodes these values.
fn validate_identifier(
    value: &str,
    empty: &'static str,
    invalid: &'static str,
) -> Result<(), &'static str> {
    if value.is_empty() {
        return Err(empty);
    }
    if value.len() > IDENTIFIER_MAX_BYTES {
        return Err(invalid);
    }
    // Refuse separators and control bytes outright. These values never become
    // path components, so this is belt-and-braces rather than the boundary —
    // but a value shaped like a traversal attempt is refused on sight.
    if value
        .chars()
        .any(|c| c == '/' || c == '\\' || c == '\0' || c.is_control())
    {
        return Err(invalid);
    }
    Ok(())
}

/// `^v[0-9]{3,}$` — the canonical capture-version sequence.
fn validate_capture_version(value: &str) -> Result<(), &'static str> {
    const INVALID: &str = "b2b-capture-version-invalid";
    let Some(digits) = value.strip_prefix('v') else {
        return Err(INVALID);
    };
    if digits.len() < 3 || digits.len() > 32 {
        return Err(INVALID);
    }
    if !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(INVALID);
    }
    Ok(())
}

/// Capture-logical namespace key validation (canonical schema
/// `normalized_relative_path`): UTF-8, slash-separated relative form, no
/// leading slash, no dot/dot-dot segment, no NUL.
///
/// This value is METADATA. It is validated so a malformed inventory fails
/// closed, NOT because it is ever used to build a path — nothing in this
/// module passes it to the filesystem.
pub fn validate_logical_path(value: &str) -> Result<(), &'static str> {
    if value.is_empty() {
        return Err("b2b-logical-path-empty");
    }
    if value.len() > LOGICAL_PATH_MAX_BYTES {
        return Err("b2b-logical-path-too-long");
    }
    if value.contains('\0') {
        return Err("b2b-logical-path-invalid");
    }
    if value.chars().any(|c| c.is_control()) {
        return Err("b2b-logical-path-invalid");
    }
    if value.contains('\\') {
        return Err("b2b-logical-path-invalid");
    }
    if value.starts_with('/') {
        return Err("b2b-logical-path-not-relative");
    }
    // A Windows-style drive or UNC prefix is an absolute path in the only
    // namespace that would honour it.
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err("b2b-logical-path-not-relative");
    }
    for segment in value.split('/') {
        if segment.is_empty() {
            return Err("b2b-logical-path-invalid");
        }
        if segment == "." || segment == ".." {
            return Err("b2b-logical-path-dot-segment");
        }
    }
    Ok(())
}

/// Strict canonical content identity: exactly 64 LOWERCASE hex digits.
///
/// Deliberately stricter than the incumbent `normalize_expected_sha`, which
/// tolerates an `sha256-` prefix and uppercase. The Archive schema pattern is
/// `^[0-9a-f]{64}$`, and a value outside it is malformed, not normalizable.
pub fn validate_identity(value: &str) -> Result<(), &'static str> {
    const INVALID: &str = "b2b-sha256-malformed";
    if value.len() != 64 {
        return Err(INVALID);
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(INVALID);
    }
    Ok(())
}

/// The canonical CAS relative destination for a validated identity.
///
/// The ONLY place a physical destination is produced, and it is a pure
/// function of a digest this module computed. No caller input reaches it.
fn cas_relative(identity: &str) -> String {
    format!(
        "{}/{}/sha256-{identity}",
        crate::archive_durable_write::CAS_DIR,
        &identity[0..2]
    )
}

/// Validates the semantic descriptor, then proves the caller's claims against
/// the bytes actually received.
///
/// Returns the identity this module COMPUTED. A caller assertion can only ever
/// cause a refusal.
fn admit_descriptor(descriptor: &EvidenceDescriptor, bytes: &[u8]) -> Result<String, &'static str> {
    validate_identifier(
        &descriptor.archive_record_id,
        "b2b-archive-record-id-empty",
        "b2b-archive-record-id-invalid",
    )?;
    validate_identifier(
        &descriptor.space_code,
        "b2b-space-code-empty",
        "b2b-space-code-invalid",
    )?;
    if descriptor.continuation == 0 {
        return Err("b2b-continuation-invalid");
    }
    validate_capture_version(&descriptor.capture_version)?;
    validate_logical_path(&descriptor.logical_path)?;
    validate_identity(&descriptor.sha256)?;
    if let Some(media_type) = &descriptor.media_type {
        if media_type.len() > MEDIA_TYPE_MAX_BYTES
            || media_type.chars().any(|c| c == '\0' || c.is_control())
        {
            return Err("b2b-media-type-invalid");
        }
    }
    // v1 pins the durable locator to null. A non-null value is refused rather
    // than stored, and is never consulted for identity or destination.
    match &descriptor.external_payload_ref {
        None | Some(serde_json::Value::Null) => {}
        Some(_) => return Err("b2b-external-payload-ref-unsupported"),
    }

    // The governed v1 object ceiling (T01 §2). Refused before any hashing,
    // staging or write.
    if bytes.len() as u64 > GOVERNED_ASSET_BLOB_CAP_BYTES {
        return Err("b2b-object-too-large");
    }
    // Exact size first: a size claim that does not match the bytes received is
    // a malformed delivery regardless of the digest.
    if bytes.len() as u64 != descriptor.size_bytes {
        return Err("b2b-size-mismatch");
    }
    let computed = sha256_hex(bytes);
    if computed != descriptor.sha256 {
        return Err("b2b-sha256-mismatch");
    }
    Ok(computed)
}

/// Canonical protection-record key material. Length-prefixed so
/// `("AR-a", "v001")` and `("AR-", "av001")` can never collide.
fn protection_key_digest(archive_record_id: &str, capture_version: &str) -> String {
    let mut material = Vec::new();
    material.extend_from_slice(archive_record_id.len().to_string().as_bytes());
    material.push(b':');
    material.extend_from_slice(archive_record_id.as_bytes());
    material.push(0);
    material.extend_from_slice(capture_version.len().to_string().as_bytes());
    material.push(b':');
    material.extend_from_slice(capture_version.as_bytes());
    sha256_hex(&material)
}

/// The protection record's exact bytes.
///
/// Deterministic by construction: struct field order is the serialization
/// order, and the identities are sorted and deduplicated, so the same governed
/// key and inventory always produce byte-identical content. That is what makes
/// re-recording an identical mapping a verified idempotent success and any
/// DIFFERENT mapping at the same key a fail-closed refusal.
///
/// Carries NO payload bytes and NO physical path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProtectionRecord<'a> {
    schema: &'static str,
    archive_record_id: &'a str,
    capture_version: &'a str,
    release: &'static str,
    protected_identities: &'a [String],
}

fn protection_record_bytes(
    archive_record_id: &str,
    capture_version: &str,
    identities: &[String],
) -> Result<Vec<u8>, String> {
    let record = ProtectionRecord {
        schema: PROTECTION_SCHEMA,
        archive_record_id,
        capture_version,
        release: "ONLY_BY_GOVERNED_DISPOSITION",
        protected_identities: identities,
    };
    serde_json::to_vec(&record).map_err(|err| format!("b2b-protection-encode-failed:{err}"))
}

/// Sorts and deduplicates the capture's inventory identities after validating
/// each one.
fn admit_protected_identities(raw: &[String]) -> Result<Vec<String>, &'static str> {
    if raw.is_empty() {
        return Err("b2b-protected-identities-empty");
    }
    if raw.len() > MAX_PROTECTED_IDENTITIES {
        return Err("b2b-protected-identities-too-many");
    }
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for identity in raw {
        validate_identity(identity)?;
        out.push(identity.clone());
    }
    out.sort();
    out.dedup();
    Ok(out)
}

// ── Unix core ──────────────────────────────────────────────────────────────

#[cfg(unix)]
mod core {
    use super::*;
    use crate::archive_durable_write::{confined, durable_write_within_root, sync_file_contents};
    use std::path::Path;
    use std::sync::atomic::Ordering;

    /// A staging name inside the ALREADY RESERVED durable-write prefix. The
    /// `b2b-` infix makes collision with the incumbent generator impossible
    /// without minting a second reserved namespace.
    fn staging_name() -> Vec<u8> {
        let counter = STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
        format!(
            "{}{STAGING_INFIX}{}-{counter}{}",
            crate::archive_durable_write::TEMP_PREFIX,
            std::process::id(),
            crate::archive_durable_write::TEMP_SUFFIX
        )
        .into_bytes()
    }

    /// Reads at most `limit + 1` bytes from a child without following a
    /// symlink, so a wrong or hostile occupant cannot force an unbounded
    /// allocation. `None` means the child is absent.
    fn read_child_bounded(
        dir: &confined::Dir,
        name: &[u8],
        limit: usize,
    ) -> Result<Option<Vec<u8>>, String> {
        use std::io::Read;

        let mut file = match dir.open_child_read_nofollow(name) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            // A symlink standing at the destination refuses O_NOFOLLOW (ELOOP).
            Err(err) => return Err(format!("b2b-existing-open-failed:{err}")),
        };
        let mut buf = Vec::with_capacity(limit.min(1 << 20) + 1);
        file.by_ref()
            .take(limit as u64 + 1)
            .read_to_end(&mut buf)
            .map_err(|err| format!("b2b-existing-read-failed:{err}"))?;
        Ok(Some(buf))
    }

    /// Opens the directory chain for a validated CAS destination without
    /// creating anything. `None` when the chain does not exist.
    fn open_cas_shard(root: &Path, identity: &str) -> Result<Option<confined::Dir>, String> {
        let root_dir = match confined::Dir::open_existing_nofollow(root) {
            Ok(dir) => dir,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("b2b-root-open-failed:{err}")),
        };
        let assets =
            match root_dir.open_child_nofollow(crate::archive_durable_write::CAS_DIR.as_bytes()) {
                Ok(dir) => dir,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(err) => return Err(format!("b2b-assets-open-failed:{err}")),
            };
        match assets.open_child_nofollow(identity[0..2].as_bytes()) {
            Ok(dir) => Ok(Some(dir)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(format!("b2b-shard-open-failed:{err}")),
        }
    }

    fn object_name(identity: &str) -> Vec<u8> {
        format!("sha256-{identity}").into_bytes()
    }

    /// The verified-read half of the contract: reads the canonical object
    /// through a fresh no-follow descriptor and recomputes BOTH the digest and
    /// the length.
    ///
    /// `Ok(None)` is absence. `Ok(Some(false))` is an occupant that is not the
    /// content its own name claims — never reported as missing.
    fn verify_object(root: &Path, identity: &str) -> Result<Option<(bool, u64)>, String> {
        let Some(shard) = open_cas_shard(root, identity)? else {
            return Ok(None);
        };
        let Some(found) = read_child_bounded(
            &shard,
            &object_name(identity),
            GOVERNED_ASSET_BLOB_CAP_BYTES as usize,
        )?
        else {
            return Ok(None);
        };
        if found.len() as u64 > GOVERNED_ASSET_BLOB_CAP_BYTES {
            return Ok(Some((false, found.len() as u64)));
        }
        let matches = sha256_hex(&found) == identity;
        Ok(Some((matches, found.len() as u64)))
    }

    /// Proves an existing occupant is byte-identical to the bytes in hand.
    fn occupant_matches(root: &Path, identity: &str, bytes: &[u8]) -> Result<Option<bool>, String> {
        let Some(shard) = open_cas_shard(root, identity)? else {
            return Ok(None);
        };
        let Some(found) = read_child_bounded(
            &shard,
            &object_name(identity),
            GOVERNED_ASSET_BLOB_CAP_BYTES as usize,
        )?
        else {
            return Ok(None);
        };
        Ok(Some(found.as_slice() == bytes))
    }

    /// Publishes one exact-byte copy beneath `root` at the derived content
    /// identity, create-only and fail-closed.
    ///
    /// Composes the accepted CAS publication authority. NO repair or replace
    /// path exists here: a mismatching occupant is refused, never superseded.
    pub(super) fn publish_copy(
        root: &Path,
        identity: &str,
        bytes: &[u8],
    ) -> Result<(CopyOutcome, Vec<DeliveryBlocker>, Option<String>), String> {
        let mut outcome = CopyOutcome::default();
        let mut blockers = vec![];

        // Probe first: an existing byte-identical object is a verified dedupe
        // success, and an existing MISMATCHING object fails closed.
        //
        // A containment refusal (a symlink or non-directory standing in the
        // derived chain) is a DOMAIN refusal, not an infrastructure fault, so
        // it is reported as a blocker on an ok:false result exactly as the
        // incumbent durable writer reports traversal and symlink refusals.
        let probed = match occupant_matches(root, identity, bytes) {
            Ok(probed) => probed,
            Err(code) => {
                blockers.push(DeliveryBlocker::new("b2b-containment-refused"));
                return Ok((outcome, blockers, Some(code)));
            }
        };
        match probed {
            Some(true) => {
                outcome.present = true;
                outcome.reused = true;
            }
            Some(false) => {
                blockers.push(DeliveryBlocker::new("b2b-occupied-identity-mismatch"));
                return Ok((outcome, blockers, None));
            }
            None => {
                let relative = cas_relative(identity);
                let written = durable_write_within_root(root, &relative, bytes)?;
                if !written.blockers.is_empty() {
                    // Lost a benign race with another writer of the SAME
                    // content: re-probe and verify rather than assuming.
                    let raced = written
                        .blockers
                        .iter()
                        .any(|b| b.code == "durable-write-destination-exists");
                    if raced {
                        let reprobed = match occupant_matches(root, identity, bytes) {
                            Ok(reprobed) => reprobed,
                            Err(code) => {
                                blockers.push(DeliveryBlocker::new("b2b-containment-refused"));
                                return Ok((outcome, blockers, Some(code)));
                            }
                        };
                        match reprobed {
                            Some(true) => {
                                outcome.present = true;
                                outcome.reused = true;
                            }
                            Some(false) => {
                                blockers
                                    .push(DeliveryBlocker::new("b2b-occupied-identity-mismatch"));
                                return Ok((outcome, blockers, None));
                            }
                            None => {
                                blockers.push(DeliveryBlocker::new("b2b-publish-vanished"));
                                return Ok((outcome, blockers, None));
                            }
                        }
                    } else {
                        for blocker in &written.blockers {
                            blockers.push(DeliveryBlocker::new(&blocker.code));
                        }
                        return Ok((outcome, blockers, written.detail));
                    }
                } else {
                    outcome.present = written.committed;
                    outcome.created = written.committed;
                    outcome.committed = written.committed;
                    outcome.durability_complete = written.durability_complete;
                    outcome.full_fsync = written.full_fsync;
                    if written.detail.is_some() {
                        // A post-promotion fence failure: committed but not
                        // fenced. Recorded, never reported as full success.
                        let detail = written.detail.clone();
                        outcome.verified = verified_readback(root, identity)?;
                        return Ok((outcome, blockers, detail));
                    }
                }
            }
        }

        outcome.verified = verified_readback(root, identity)?;
        if outcome.present && !outcome.verified {
            blockers.push(DeliveryBlocker::new("b2b-verified-readback-failed"));
        }
        Ok((outcome, blockers, None))
    }

    fn verified_readback(root: &Path, identity: &str) -> Result<bool, String> {
        // A containment refusal during readback is simply "not verified": the
        // caller already reports ok:false, and no destination was followed.
        Ok(matches!(verify_object(root, identity), Ok(Some((true, _)))))
    }

    /// Read-only delivery verification for one identity across both roots.
    pub(super) fn verify_delivery(
        archive_root: &Path,
        backup_root: &Path,
        identity: &str,
        expected_size: Option<u64>,
    ) -> Result<VerifyResult, String> {
        let mut result = VerifyResult::skeleton(identity.to_string());

        let primary = match verify_object(archive_root, identity) {
            Ok(primary) => primary,
            Err(_) => {
                result
                    .blockers
                    .push(DeliveryBlocker::new("b2b-containment-refused"));
                return Ok(result);
            }
        };
        if let Some((matches, len)) = primary {
            result.primary_present = true;
            result.primary_verified = matches;
            result.byte_length = Some(len);
            if !matches {
                result
                    .blockers
                    .push(DeliveryBlocker::new("b2b-primary-integrity-failure"));
            } else if let Some(expected) = expected_size {
                if expected != len {
                    result
                        .blockers
                        .push(DeliveryBlocker::new("b2b-size-mismatch"));
                }
            }
        }

        let backup = match verify_object(backup_root, identity) {
            Ok(backup) => backup,
            Err(_) => {
                result
                    .blockers
                    .push(DeliveryBlocker::new("b2b-containment-refused"));
                return Ok(result);
            }
        };
        if let Some((matches, len)) = backup {
            result.backup_present = true;
            result.backup_verified = matches;
            if !matches {
                result
                    .blockers
                    .push(DeliveryBlocker::new("b2b-backup-integrity-failure"));
            } else if result.byte_length.is_none() {
                result.byte_length = Some(len);
            }
        }

        result.ok = result.primary_verified && result.backup_verified && result.blockers.is_empty();
        Ok(result)
    }

    /// Verified exact-byte resolution from the PRIMARY provider only.
    ///
    /// The recovery-only secondary root is deliberately not consulted: it is
    /// not a resolver and not a CAS.
    pub(super) fn resolve_bytes(
        archive_root: &Path,
        identity: &str,
        expected_size: Option<u64>,
    ) -> Result<Vec<u8>, String> {
        let Some(shard) = open_cas_shard(archive_root, identity)? else {
            return Err("b2b-resolve-unresolved".to_string());
        };
        let Some(found) = read_child_bounded(
            &shard,
            &object_name(identity),
            GOVERNED_ASSET_BLOB_CAP_BYTES as usize,
        )?
        else {
            return Err("b2b-resolve-unresolved".to_string());
        };
        if found.len() as u64 > GOVERNED_ASSET_BLOB_CAP_BYTES {
            return Err("b2b-resolve-object-too-large".to_string());
        }
        // Corruption is an integrity failure, NEVER "missing".
        if sha256_hex(&found) != identity {
            return Err("b2b-resolve-integrity-failure".to_string());
        }
        if let Some(expected) = expected_size {
            if expected != found.len() as u64 {
                return Err("b2b-resolve-size-mismatch".to_string());
            }
        }
        Ok(found)
    }

    /// Create-only durable publication of the protection record.
    ///
    /// The CAS writer deliberately admits content-addressed blobs only, so this
    /// one non-blob destination composes the same primitives directly rather
    /// than widening that writer's reach: private staging inside the reserved
    /// prefix, content fsync, exclusive promotion, parent-directory fence.
    pub(super) fn publish_protection_record(
        archive_root: &Path,
        key_digest: &str,
        bytes: &[u8],
    ) -> Result<(CopyOutcome, Vec<DeliveryBlocker>, Option<String>), String> {
        let mut outcome = CopyOutcome::default();
        let mut blockers = vec![];
        let final_name = format!("{PROTECTION_PREFIX}{key_digest}{PROTECTION_SUFFIX}").into_bytes();

        let root_dir = confined::Dir::open_root(archive_root)
            .map_err(|err| format!("b2b-protection-root-open-failed:{err}"))?;
        root_dir
            .mkdir_child(PROTECTION_DIR.as_bytes())
            .map_err(|err| format!("b2b-protection-dir-create-failed:{err}"))?;
        let namespace = root_dir
            .open_child_nofollow(PROTECTION_DIR.as_bytes())
            .map_err(|err| format!("b2b-protection-dir-open-failed:{err}"))?;
        namespace
            .mkdir_child(key_digest[0..2].as_bytes())
            .map_err(|err| format!("b2b-protection-shard-create-failed:{err}"))?;
        let shard = namespace
            .open_child_nofollow(key_digest[0..2].as_bytes())
            .map_err(|err| format!("b2b-protection-shard-open-failed:{err}"))?;

        // An existing record at this governed key is idempotent success only
        // when it is byte-identical. A DIFFERENT mapping fails closed.
        if let Some(found) = read_child_bounded(&shard, &final_name, PROTECTION_READ_CAP_BYTES)? {
            if found.as_slice() == bytes {
                outcome.present = true;
                outcome.reused = true;
                outcome.verified = true;
                return Ok((outcome, blockers, None));
            }
            blockers.push(DeliveryBlocker::new("b2b-protection-record-conflict"));
            return Ok((outcome, blockers, None));
        }

        let (staging, mut file) = {
            let mut last: Option<std::io::Error> = None;
            let mut acquired = None;
            for _ in 0..STAGING_ATTEMPTS {
                let name = staging_name();
                match shard.create_new_child(&name) {
                    Ok(file) => {
                        acquired = Some((name, file));
                        break;
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => last = Some(err),
                    Err(err) => {
                        return Err(format!("b2b-protection-staging-create-failed:{err}"));
                    }
                }
            }
            match acquired {
                Some(pair) => pair,
                None => {
                    return Err(format!(
                        "b2b-protection-staging-name-exhausted:{}",
                        last.map(|e| e.to_string())
                            .unwrap_or_else(|| "collision".to_string())
                    ));
                }
            }
        };

        // From here on any failure removes ONLY this operation's own artifact.
        let cleanup = |shard: &confined::Dir, staging: &[u8]| {
            let _ = shard.unlink_child(staging);
        };

        if let Err(err) = std::io::Write::write_all(&mut file, bytes) {
            cleanup(&shard, &staging);
            return Err(format!("b2b-protection-write-failed:{err}"));
        }
        match sync_file_contents(&file) {
            Ok(full) => outcome.full_fsync = full,
            Err(err) => {
                cleanup(&shard, &staging);
                return Err(format!("b2b-protection-content-sync-failed:{err}"));
            }
        }
        drop(file);

        match shard.promote_exclusive(&staging, &final_name) {
            Ok(true) => {
                outcome.present = true;
                outcome.created = true;
                outcome.committed = true;
            }
            Ok(false) => {
                // Lost a race. The staging artifact is ours to remove; the
                // winner is then held to the same byte-identity rule.
                cleanup(&shard, &staging);
                if let Some(found) =
                    read_child_bounded(&shard, &final_name, PROTECTION_READ_CAP_BYTES)?
                {
                    if found.as_slice() == bytes {
                        outcome.present = true;
                        outcome.reused = true;
                        outcome.verified = true;
                        return Ok((outcome, blockers, None));
                    }
                }
                blockers.push(DeliveryBlocker::new("b2b-protection-record-conflict"));
                return Ok((outcome, blockers, None));
            }
            Err(err) => {
                cleanup(&shard, &staging);
                return Err(format!("b2b-protection-promote-failed:{err}"));
            }
        }

        // The promotion already changed the canonical destination, so a failing
        // fence is reported as committed-but-not-durable, never as an error
        // that would read as "nothing happened".
        let mut detail = None;
        match shard.sync() {
            Ok(()) => outcome.durability_complete = true,
            Err(err) => detail = Some(format!("b2b-protection-parent-sync-failed:{err}")),
        }

        outcome.verified = matches!(
            read_child_bounded(&shard, &final_name, PROTECTION_READ_CAP_BYTES)?,
            Some(ref found) if found.as_slice() == bytes
        );
        if !outcome.verified {
            blockers.push(DeliveryBlocker::new("b2b-verified-readback-failed"));
        }
        Ok((outcome, blockers, detail))
    }
}

// ── Root-parameterized owner API ───────────────────────────────────────────

/// Publishes one governed Archive evidence object: primary content-identity
/// object plus the recovery-only secondary copy, both create-only, both
/// verified.
///
/// Root-parameterized so the whole contract is exercisable against disposable
/// fixture roots; the command layer below is what binds the governed roots.
#[cfg(unix)]
pub fn publish_evidence_object_within_roots(
    archive_root: &std::path::Path,
    backup_root: &std::path::Path,
    descriptor: &EvidenceDescriptor,
    bytes: &[u8],
) -> Result<PublishResult, String> {
    let identity = match admit_descriptor(descriptor, bytes) {
        Ok(identity) => identity,
        Err(code) => return Ok(PublishResult::blocked(code)),
    };

    let mut result = PublishResult::skeleton();
    result.sha256 = identity.clone();
    result.byte_length = bytes.len() as u64;

    let (primary, primary_blockers, primary_detail) =
        core::publish_copy(archive_root, &identity, bytes)?;
    result.primary = primary;
    result.blockers.extend(primary_blockers);
    if result.detail.is_none() {
        result.detail = primary_detail;
    }

    // The recovery copy is attempted only once the primary is durably
    // delivered: a secondary copy of an object that failed closed would be the
    // only surviving artifact of a refused publication.
    if result.primary.is_durably_delivered() && result.blockers.is_empty() {
        let (backup, backup_blockers, backup_detail) =
            core::publish_copy(backup_root, &identity, bytes)?;
        result.backup = backup;
        result.blockers.extend(backup_blockers);
        if result.detail.is_none() {
            result.detail = backup_detail;
        }
    }

    result.ok = result.blockers.is_empty()
        && result.primary.is_durably_delivered()
        && result.backup.is_durably_delivered();
    Ok(result)
}

/// Records the create-only `(archive_record_id, capture_version)` protection
/// mapping over the capture's sorted unique inventory identities.
///
/// Creates no reference counting, no AssetRef and no release authority: the
/// mapping is released ONLY by governed disposition, and this module exposes no
/// delete, GC or reclamation operation at all.
#[cfg(unix)]
pub fn record_protection_within_root(
    archive_root: &std::path::Path,
    request: &ProtectionRequest,
) -> Result<ProtectionResult, String> {
    if let Err(code) = validate_identifier(
        &request.archive_record_id,
        "b2b-archive-record-id-empty",
        "b2b-archive-record-id-invalid",
    ) {
        return Ok(ProtectionResult::blocked(code));
    }
    if let Err(code) = validate_capture_version(&request.capture_version) {
        return Ok(ProtectionResult::blocked(code));
    }
    let identities = match admit_protected_identities(&request.protected_identities) {
        Ok(identities) => identities,
        Err(code) => return Ok(ProtectionResult::blocked(code)),
    };

    let bytes = protection_record_bytes(
        &request.archive_record_id,
        &request.capture_version,
        &identities,
    )?;
    let key_digest = protection_key_digest(&request.archive_record_id, &request.capture_version);

    let mut result = ProtectionResult::skeleton();
    result.protected_identity_count = identities.len() as u64;
    let (record, blockers, detail) =
        core::publish_protection_record(archive_root, &key_digest, &bytes)?;
    result.record = record;
    result.blockers = blockers;
    result.detail = detail;
    result.ok = result.blockers.is_empty() && result.record.is_durably_delivered();
    Ok(result)
}

/// Read-only delivery verification across the primary and recovery roots.
#[cfg(unix)]
pub fn verify_delivery_within_roots(
    archive_root: &std::path::Path,
    backup_root: &std::path::Path,
    request: &IdentityRequest,
) -> Result<VerifyResult, String> {
    if let Err(code) = validate_identity(&request.sha256) {
        return Ok(VerifyResult::blocked(code));
    }
    core::verify_delivery(
        archive_root,
        backup_root,
        &request.sha256,
        request.expected_size_bytes,
    )
}

/// Verified exact-byte resolution by content identity from the primary
/// provider.
#[cfg(unix)]
pub fn resolve_evidence_object_within_root(
    archive_root: &std::path::Path,
    request: &IdentityRequest,
) -> Result<Vec<u8>, String> {
    validate_identity(&request.sha256).map_err(|code| code.to_string())?;
    core::resolve_bytes(archive_root, &request.sha256, request.expected_size_bytes)
}

// ── Non-Unix: fail closed ──────────────────────────────────────────────────

#[cfg(not(unix))]
pub fn publish_evidence_object_within_roots(
    _archive_root: &std::path::Path,
    _backup_root: &std::path::Path,
    _descriptor: &EvidenceDescriptor,
    _bytes: &[u8],
) -> Result<PublishResult, String> {
    Ok(PublishResult::blocked("b2b-unsupported-platform"))
}

#[cfg(not(unix))]
pub fn record_protection_within_root(
    _archive_root: &std::path::Path,
    _request: &ProtectionRequest,
) -> Result<ProtectionResult, String> {
    Ok(ProtectionResult::blocked("b2b-unsupported-platform"))
}

#[cfg(not(unix))]
pub fn verify_delivery_within_roots(
    _archive_root: &std::path::Path,
    _backup_root: &std::path::Path,
    _request: &IdentityRequest,
) -> Result<VerifyResult, String> {
    Ok(VerifyResult::blocked("b2b-unsupported-platform"))
}

#[cfg(not(unix))]
pub fn resolve_evidence_object_within_root(
    _archive_root: &std::path::Path,
    _request: &IdentityRequest,
) -> Result<Vec<u8>, String> {
    Err("b2b-unsupported-platform".to_string())
}

// ── Governed root resolution ───────────────────────────────────────────────

/// The recovery-only secondary root.
///
/// The BASE is the incumbent accepted immutable backup-root mode — reused, not
/// re-decided, so B2B mints no second root-selection authority. Only the final
/// component differs, keeping the B2B recovery copies out of the accepted
/// `H2O Studio Backups` grammar. No renderer input, environment variable,
/// feature flag or persisted preference selects it, and there is no setter.
pub fn b2b_backup_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use crate::saved_chat_backup_root_policy::{
        production_saved_chat_backup_root, SavedChatBackupRoot,
    };
    use tauri::Manager;

    let base = match production_saved_chat_backup_root() {
        SavedChatBackupRoot::Home => app.path().home_dir(),
        SavedChatBackupRoot::AppLocalDataAcceptance => app.path().app_local_data_dir(),
    }
    .map_err(|_| "b2b-backup-root-unavailable".to_string())?;
    Ok(base.join(BACKUP_ROOT_COMPONENT))
}

// ── Commands ───────────────────────────────────────────────────────────────

/// Publishes one governed Archive evidence object.
///
/// The exact bytes arrive as the raw invoke body; the SEMANTIC descriptor
/// arrives in the `options` header. No physical destination is accepted.
#[tauri::command]
pub async fn h2o_operating_space_archive_publish_object(
    app: tauri::AppHandle,
    gate: tauri::State<'_, crate::archive_instance_lock::ArchiveInstanceState>,
    request: tauri::ipc::Request<'_>,
) -> Result<PublishResult, String> {
    // Every trusted archive mutation participates in the M06 in-process gate
    // for the duration of THIS invoke only.
    let _mutation = crate::archive_instance_lock::enter_mutation_for(&app, &gate)?;
    let descriptor: EvidenceDescriptor = crate::archive_durable_write::required_options(&request)?;
    let bytes = crate::archive_durable_write::body_bytes(&request)?;
    let archive_root = crate::archive_durable_write::archive_root(&app)?;
    let backup_root = b2b_backup_root(&app)?;
    publish_evidence_object_within_roots(&archive_root, &backup_root, &descriptor, &bytes)
}

/// Records the create-only Archive protection mapping.
#[tauri::command]
pub async fn h2o_operating_space_archive_record_protection(
    app: tauri::AppHandle,
    gate: tauri::State<'_, crate::archive_instance_lock::ArchiveInstanceState>,
    request: tauri::ipc::Request<'_>,
) -> Result<ProtectionResult, String> {
    let _mutation = crate::archive_instance_lock::enter_mutation_for(&app, &gate)?;
    let protection: ProtectionRequest = crate::archive_durable_write::required_options(&request)?;
    let archive_root = crate::archive_durable_write::archive_root(&app)?;
    record_protection_within_root(&archive_root, &protection)
}

/// Verified exact-byte resolution by content identity. Returns the raw bytes.
///
/// Absence and corruption are distinguishable and both fail closed:
/// `b2b-resolve-unresolved` vs `b2b-resolve-integrity-failure`.
#[tauri::command]
pub async fn h2o_operating_space_archive_resolve_object(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let identity: IdentityRequest = crate::archive_durable_write::required_options(&request)?;
    let archive_root = crate::archive_durable_write::archive_root(&app)?;
    let bytes = resolve_evidence_object_within_root(&archive_root, &identity)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Read-only delivery verification for one content identity.
#[tauri::command]
pub async fn h2o_operating_space_archive_verify_delivery(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<VerifyResult, String> {
    let identity: IdentityRequest = crate::archive_durable_write::required_options(&request)?;
    let archive_root = crate::archive_durable_write::archive_root(&app)?;
    let backup_root = b2b_backup_root(&app)?;
    verify_delivery_within_roots(&archive_root, &backup_root, &identity)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::Ordering;

    /// Hand-rolled disposable scratch root, matching the crate's existing
    /// convention. ONLY synthetic fixture bytes are ever written here — no real
    /// private Archive payload participates in this suite.
    fn scratch(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let counter = STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "h2o-b2b-delivery-{name}-{}-{counter}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).expect("scratch base");
        (base.clone(), base.join("archive"), base.join("backup-root"))
    }

    fn descriptor_for(bytes: &[u8]) -> EvidenceDescriptor {
        EvidenceDescriptor {
            archive_record_id: "AR-OPS-EXAMPLE-0001".to_string(),
            space_code: "S-EXAMPLE".to_string(),
            continuation: 1,
            capture_version: "v001".to_string(),
            logical_path: "captures/v001/payload/example.bin".to_string(),
            sha256: sha256_hex(bytes),
            size_bytes: bytes.len() as u64,
            media_type: Some("application/octet-stream".to_string()),
            external_payload_ref: None,
        }
    }

    fn codes(blockers: &[DeliveryBlocker]) -> Vec<String> {
        blockers.iter().map(|b| b.code.clone()).collect()
    }

    fn object_path(root: &Path, identity: &str) -> PathBuf {
        root.join("assets")
            .join(&identity[0..2])
            .join(format!("sha256-{identity}"))
    }

    /// Any residue carrying the reserved staging prefix.
    fn staging_residue(dir: &Path) -> Vec<PathBuf> {
        let mut found = vec![];
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            let Ok(entries) = fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(crate::archive_durable_write::TEMP_PREFIX)
                {
                    found.push(path);
                }
            }
        }
        found
    }

    // ── Happy path ─────────────────────────────────────────────────────────

    #[test]
    fn publishes_exact_bytes_to_both_roots_and_verifies_them() {
        let (base, archive, backup) = scratch("happy");
        let bytes = b"governed evidence object bytes".to_vec();
        let descriptor = descriptor_for(&bytes);

        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();

        assert!(result.ok, "{:?}", codes(&result.blockers));
        assert_eq!(result.sha256, sha256_hex(&bytes));
        assert_eq!(result.byte_length, bytes.len() as u64);

        assert!(result.primary.created && result.primary.committed);
        assert!(result.primary.durability_complete && result.primary.verified);
        assert!(result.backup.created && result.backup.durability_complete);
        assert!(result.backup.verified);

        // EXACT bytes, both copies.
        let identity = sha256_hex(&bytes);
        assert_eq!(fs::read(object_path(&archive, &identity)).unwrap(), bytes);
        assert_eq!(fs::read(object_path(&backup, &identity)).unwrap(), bytes);

        // No incomplete staged artifact can be mistaken for a published object.
        assert!(staging_residue(&base).is_empty());
    }

    #[test]
    fn a_zero_byte_evidence_object_is_representable_and_durable() {
        let (_base, archive, backup) = scratch("zero");
        let bytes: Vec<u8> = vec![];
        let descriptor = descriptor_for(&bytes);
        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert!(result.ok, "{:?}", codes(&result.blockers));
        assert_eq!(result.byte_length, 0);
    }

    #[test]
    fn an_identical_republication_is_a_verified_reuse_not_a_second_write() {
        let (_base, archive, backup) = scratch("dedupe");
        let bytes = b"same exact bytes".to_vec();
        let descriptor = descriptor_for(&bytes);

        let first =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert!(first.primary.created);

        let second =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert!(second.ok, "{:?}", codes(&second.blockers));
        assert!(second.primary.reused && !second.primary.created);
        assert!(second.backup.reused && !second.backup.created);
        // Reuse is admitted only WITH a verified read.
        assert!(second.primary.verified && second.backup.verified);
    }

    // ── Identity / size fail-closed ────────────────────────────────────────

    #[test]
    fn an_expected_sha_that_does_not_match_the_bytes_is_refused() {
        let (_base, archive, backup) = scratch("shamismatch");
        let bytes = b"real bytes".to_vec();
        let mut descriptor = descriptor_for(&bytes);
        descriptor.sha256 = sha256_hex(b"different bytes");

        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert!(!result.ok);
        assert_eq!(codes(&result.blockers), vec!["b2b-sha256-mismatch"]);
        // Nothing was written anywhere.
        assert!(!archive.exists() && !backup.exists());
    }

    #[test]
    fn an_exact_size_that_does_not_match_the_bytes_is_refused() {
        let (_base, archive, backup) = scratch("sizemismatch");
        let bytes = b"real bytes".to_vec();
        let mut descriptor = descriptor_for(&bytes);
        descriptor.size_bytes = bytes.len() as u64 + 1;

        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert_eq!(codes(&result.blockers), vec!["b2b-size-mismatch"]);
        assert!(!archive.exists());
    }

    #[test]
    fn a_malformed_sha_is_refused_in_every_shape() {
        for malformed in [
            "",
            "abc",
            &"A".repeat(64),
            &format!("{}{}", "a".repeat(63), "g"),
            &format!("sha256-{}", "a".repeat(64)),
            &"a".repeat(65),
        ] {
            assert_eq!(
                validate_identity(malformed),
                Err("b2b-sha256-malformed"),
                "expected refusal for {malformed:?}"
            );
        }
        // Uppercase is MALFORMED, not normalizable: the canonical Archive
        // pattern is lowercase-only.
        assert_eq!(validate_identity(&"a".repeat(64)), Ok(()));
    }

    #[test]
    fn an_object_over_the_governed_v1_ceiling_is_refused_before_any_write() {
        let (_base, archive, backup) = scratch("toolarge");
        let bytes = vec![7u8; GOVERNED_ASSET_BLOB_CAP_BYTES as usize + 1];
        let descriptor = descriptor_for(&bytes);
        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert_eq!(codes(&result.blockers), vec!["b2b-object-too-large"]);
        assert!(!archive.exists());
    }

    // ── Occupied identity: FAIL CLOSED, never repair ───────────────────────

    #[test]
    fn a_mismatching_occupant_at_the_derived_identity_is_refused_and_never_replaced() {
        let (_base, archive, backup) = scratch("occupied");
        let bytes = b"the real evidence".to_vec();
        let identity = sha256_hex(&bytes);

        // Stand a corrupt object at the derived content identity.
        let corrupt = b"NOT the content this name claims".to_vec();
        let path = object_path(&archive, &identity);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &corrupt).unwrap();

        let descriptor = descriptor_for(&bytes);
        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();

        assert!(!result.ok);
        assert_eq!(
            codes(&result.blockers),
            vec!["b2b-occupied-identity-mismatch"]
        );
        // The occupant is UNTOUCHED: B2B has no repair/replace authority.
        assert_eq!(fs::read(&path).unwrap(), corrupt);
        // And the refused publication produced no recovery copy.
        assert!(!backup.exists());
    }

    #[test]
    fn a_refused_publication_never_leaves_a_recovery_copy_as_its_only_artifact() {
        let (_base, archive, backup) = scratch("nobackuponfail");
        let bytes = b"evidence".to_vec();
        let identity = sha256_hex(&bytes);
        let path = object_path(&archive, &identity);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"mismatching occupant").unwrap();

        let result = publish_evidence_object_within_roots(
            &archive,
            &backup,
            &descriptor_for(&bytes),
            &bytes,
        )
        .unwrap();
        assert!(!result.ok);
        assert_eq!(result.backup, CopyOutcome::default());
        assert!(!backup.exists());
    }

    // ── Containment: traversal, absolute, symlink ──────────────────────────

    #[test]
    fn a_traversing_or_absolute_logical_path_is_refused() {
        for bad in [
            "../escape/payload.bin",
            "captures/../../escape.bin",
            "/absolute/payload.bin",
            "./payload.bin",
            "captures//payload.bin",
            "C:/windows/payload.bin",
            "captures\\windows\\payload.bin",
        ] {
            assert!(
                validate_logical_path(bad).is_err(),
                "expected refusal for {bad:?}"
            );
        }
        assert!(validate_logical_path("captures/v001/payload/a.bin").is_ok());
    }

    #[test]
    fn a_traversing_logical_path_refuses_the_whole_publication() {
        let (_base, archive, backup) = scratch("traversal");
        let bytes = b"evidence".to_vec();
        let mut descriptor = descriptor_for(&bytes);
        descriptor.logical_path = "../../escape.bin".to_string();

        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert_eq!(
            codes(&result.blockers),
            vec!["b2b-logical-path-dot-segment"]
        );
        assert!(!archive.exists());
    }

    #[test]
    fn the_logical_path_never_becomes_a_physical_destination() {
        let (_base, archive, backup) = scratch("logicalonly");
        let bytes = b"evidence bytes".to_vec();
        let mut descriptor = descriptor_for(&bytes);
        descriptor.logical_path = "some/deep/capture/namespace/key.bin".to_string();

        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert!(result.ok, "{:?}", codes(&result.blockers));

        // The object landed at its CONTENT IDENTITY, not under the logical key.
        let identity = sha256_hex(&bytes);
        assert!(object_path(&archive, &identity).is_file());
        assert!(!archive.join("some").exists());
        assert!(!backup.join("some").exists());
    }

    #[test]
    fn a_symlinked_shard_is_refused_rather_than_followed() {
        let (base, archive, backup) = scratch("symlinkshard");
        let bytes = b"evidence".to_vec();
        let identity = sha256_hex(&bytes);

        let elsewhere = base.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::create_dir_all(archive.join("assets")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, archive.join("assets").join(&identity[0..2]))
            .unwrap();

        let result = publish_evidence_object_within_roots(
            &archive,
            &backup,
            &descriptor_for(&bytes),
            &bytes,
        )
        .unwrap();
        assert!(!result.ok);
        // A containment refusal is a DOMAIN refusal with a blocker, not an
        // infrastructure error, and nothing is written through the symlink.
        assert_eq!(codes(&result.blockers), vec!["b2b-containment-refused"]);
        assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
        assert!(!backup.exists());
    }

    #[test]
    fn a_symlink_standing_where_the_archive_root_belongs_is_refused() {
        let (base, archive, backup) = scratch("symlinkroot");
        let elsewhere = base.join("outside");
        fs::create_dir_all(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &archive).unwrap();

        let bytes = b"evidence".to_vec();
        let result = publish_evidence_object_within_roots(
            &archive,
            &backup,
            &descriptor_for(&bytes),
            &bytes,
        );
        // Either a hard refusal or a blocked result — never a write through the
        // symlink.
        if let Ok(ok) = &result {
            assert!(!ok.ok, "{:?}", codes(&ok.blockers));
        }
        assert!(fs::read_dir(&elsewhere).unwrap().next().is_none());
    }

    // ── Descriptor closure: no caller-controlled destination ───────────────

    #[test]
    fn the_descriptor_refuses_every_caller_supplied_physical_destination() {
        let identity = sha256_hex(b"x");
        for injected in [
            r#""path":"assets/aa/evil""#,
            r#""root":"/tmp/evil""#,
            r#""destination":"/tmp/evil""#,
            r#""backupPath":"/tmp/evil""#,
            r#""shard":"aa""#,
            r#""casPath":"assets/aa/x""#,
            r#""overwrite":true"#,
            r#""replace":true"#,
            r#""repair":true"#,
            r#""delete":true"#,
            r#""provider":"s3""#,
            r#""credential":"secret""#,
        ] {
            let json = format!(
                r#"{{"archiveRecordId":"AR-1","spaceCode":"S","continuation":1,
                     "captureVersion":"v001","logicalPath":"a/b.bin",
                     "sha256":"{identity}","sizeBytes":1,{injected}}}"#
            );
            let parsed: Result<EvidenceDescriptor, _> = serde_json::from_str(&json);
            assert!(
                parsed.is_err(),
                "a caller-supplied {injected} must be REFUSED, not ignored"
            );
        }
    }

    #[test]
    fn the_wire_contract_declares_no_path_or_destination_field() {
        // The descriptor's own accepted key set, proven by construction.
        let identity = sha256_hex(b"x");
        let json = format!(
            r#"{{"archiveRecordId":"AR-1","spaceCode":"S","continuation":1,
                 "captureVersion":"v001","logicalPath":"a/b.bin",
                 "sha256":"{identity}","sizeBytes":1,"mediaType":null,
                 "externalPayloadRef":null}}"#
        );
        let parsed: EvidenceDescriptor = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.sha256, identity);
    }

    #[test]
    fn results_never_return_a_physical_path() {
        let (_base, archive, backup) = scratch("nopath");
        let bytes = b"evidence".to_vec();
        let published = publish_evidence_object_within_roots(
            &archive,
            &backup,
            &descriptor_for(&bytes),
            &bytes,
        )
        .unwrap();
        let rendered = serde_json::to_string(&published).unwrap();
        assert!(!rendered.contains(archive.to_str().unwrap()));
        assert!(!rendered.contains(backup.to_str().unwrap()));
        for banned in ["\"path\"", "\"root\"", "\"destination\"", "\"backupPath\""] {
            assert!(!rendered.contains(banned), "result leaked {banned}");
        }
    }

    #[test]
    fn a_non_null_external_payload_ref_is_refused_and_is_never_identity() {
        let (_base, archive, backup) = scratch("extref");
        let bytes = b"evidence".to_vec();
        let mut descriptor = descriptor_for(&bytes);
        descriptor.external_payload_ref = Some(serde_json::json!("https://example.invalid/blob"));

        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert_eq!(
            codes(&result.blockers),
            vec!["b2b-external-payload-ref-unsupported"]
        );
        assert!(!archive.exists());

        // An explicit null is the conformant v1 value and is accepted.
        descriptor.external_payload_ref = Some(serde_json::Value::Null);
        let ok =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert!(ok.ok, "{:?}", codes(&ok.blockers));
    }

    // ── Archive semantic validation ────────────────────────────────────────

    #[test]
    fn the_capture_version_sequence_is_enforced() {
        for bad in ["", "v", "v1", "v12", "001", "V001", "v00a", "v-001"] {
            assert!(
                validate_capture_version(bad).is_err(),
                "expected refusal for {bad:?}"
            );
        }
        for good in ["v001", "v002", "v1000"] {
            assert!(validate_capture_version(good).is_ok(), "{good}");
        }
    }

    #[test]
    fn a_non_positive_continuation_is_refused() {
        let (_base, archive, backup) = scratch("continuation");
        let bytes = b"evidence".to_vec();
        let mut descriptor = descriptor_for(&bytes);
        descriptor.continuation = 0;
        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert_eq!(codes(&result.blockers), vec!["b2b-continuation-invalid"]);
    }

    #[test]
    fn a_separator_bearing_archive_identifier_is_refused_on_sight() {
        let (_base, archive, backup) = scratch("identifier");
        let bytes = b"evidence".to_vec();
        let mut descriptor = descriptor_for(&bytes);
        descriptor.archive_record_id = "../../escape".to_string();
        let result =
            publish_evidence_object_within_roots(&archive, &backup, &descriptor, &bytes).unwrap();
        assert_eq!(
            codes(&result.blockers),
            vec!["b2b-archive-record-id-invalid"]
        );
    }

    // ── Verified resolution ────────────────────────────────────────────────

    #[test]
    fn resolution_returns_the_exact_published_bytes() {
        let (_base, archive, backup) = scratch("resolve");
        let bytes = b"exact evidence payload".to_vec();
        publish_evidence_object_within_roots(&archive, &backup, &descriptor_for(&bytes), &bytes)
            .unwrap();

        let request = IdentityRequest {
            sha256: sha256_hex(&bytes),
            expected_size_bytes: Some(bytes.len() as u64),
        };
        let resolved = resolve_evidence_object_within_root(&archive, &request).unwrap();
        assert_eq!(resolved, bytes);
    }

    #[test]
    fn absence_and_corruption_are_distinguishable_and_corruption_never_reads_as_missing() {
        let (_base, archive, _backup) = scratch("absence");
        let identity = sha256_hex(b"never published");
        let request = IdentityRequest {
            sha256: identity.clone(),
            expected_size_bytes: None,
        };
        assert_eq!(
            resolve_evidence_object_within_root(&archive, &request).unwrap_err(),
            "b2b-resolve-unresolved"
        );

        // Now stand a corrupt object at that identity.
        let path = object_path(&archive, &identity);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"corrupt").unwrap();
        assert_eq!(
            resolve_evidence_object_within_root(&archive, &request).unwrap_err(),
            "b2b-resolve-integrity-failure"
        );
    }

    #[test]
    fn resolution_refuses_a_malformed_identity_and_a_size_assertion_mismatch() {
        let (_base, archive, backup) = scratch("resolverefuse");
        let bytes = b"payload".to_vec();
        publish_evidence_object_within_roots(&archive, &backup, &descriptor_for(&bytes), &bytes)
            .unwrap();

        let malformed = IdentityRequest {
            sha256: "not-a-hash".to_string(),
            expected_size_bytes: None,
        };
        assert_eq!(
            resolve_evidence_object_within_root(&archive, &malformed).unwrap_err(),
            "b2b-sha256-malformed"
        );

        let wrong_size = IdentityRequest {
            sha256: sha256_hex(&bytes),
            expected_size_bytes: Some(bytes.len() as u64 + 1),
        };
        assert_eq!(
            resolve_evidence_object_within_root(&archive, &wrong_size).unwrap_err(),
            "b2b-resolve-size-mismatch"
        );
    }

    #[test]
    fn the_recovery_root_is_never_a_resolution_authority() {
        let (_base, archive, backup) = scratch("backupnotresolver");
        let bytes = b"only in the recovery root".to_vec();
        let identity = sha256_hex(&bytes);

        // Place the object ONLY in the recovery root.
        let path = object_path(&backup, &identity);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &bytes).unwrap();

        let request = IdentityRequest {
            sha256: identity,
            expected_size_bytes: None,
        };
        // Normal resolution consults the PRIMARY provider only.
        assert_eq!(
            resolve_evidence_object_within_root(&archive, &request).unwrap_err(),
            "b2b-resolve-unresolved"
        );
    }

    #[test]
    fn delivery_verification_reports_both_roots_without_mutating_anything() {
        let (_base, archive, backup) = scratch("verify");
        let bytes = b"verified payload".to_vec();
        publish_evidence_object_within_roots(&archive, &backup, &descriptor_for(&bytes), &bytes)
            .unwrap();

        let request = IdentityRequest {
            sha256: sha256_hex(&bytes),
            expected_size_bytes: Some(bytes.len() as u64),
        };
        let verified = verify_delivery_within_roots(&archive, &backup, &request).unwrap();
        assert!(verified.ok);
        assert!(verified.primary_verified && verified.backup_verified);
        assert_eq!(verified.byte_length, Some(bytes.len() as u64));

        // A corrupt recovery copy is an integrity failure, not an absence.
        fs::write(object_path(&backup, &request.sha256), b"corrupt").unwrap();
        let degraded = verify_delivery_within_roots(&archive, &backup, &request).unwrap();
        assert!(!degraded.ok);
        assert!(degraded.backup_present && !degraded.backup_verified);
        assert_eq!(
            codes(&degraded.blockers),
            vec!["b2b-backup-integrity-failure"]
        );
    }

    // ── Protection mapping ─────────────────────────────────────────────────

    #[test]
    fn the_protection_mapping_is_create_only_sorted_and_deduplicated() {
        let (_base, archive, _backup) = scratch("protection");
        let a = sha256_hex(b"a");
        let b = sha256_hex(b"b");
        let request = ProtectionRequest {
            archive_record_id: "AR-OPS-0001".to_string(),
            capture_version: "v001".to_string(),
            protected_identities: vec![b.clone(), a.clone(), b.clone()],
        };

        let result = record_protection_within_root(&archive, &request).unwrap();
        assert!(result.ok, "{:?}", codes(&result.blockers));
        assert_eq!(result.protected_identity_count, 2);
        assert!(result.record.created && result.record.durability_complete);

        // Recording the identical governed mapping again is verified idempotence.
        let again = record_protection_within_root(&archive, &request).unwrap();
        assert!(again.ok);
        assert!(again.record.reused && !again.record.created);

        // The stored record binds the exact sorted identity set and no payload.
        let digest = protection_key_digest("AR-OPS-0001", "v001");
        let stored = fs::read(
            archive
                .join(PROTECTION_DIR)
                .join(&digest[0..2])
                .join(format!("{PROTECTION_PREFIX}{digest}{PROTECTION_SUFFIX}")),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&stored).unwrap();
        let mut expected = vec![a, b];
        expected.sort();
        assert_eq!(
            parsed["protectedIdentities"],
            serde_json::to_value(&expected).unwrap()
        );
        assert_eq!(parsed["release"], "ONLY_BY_GOVERNED_DISPOSITION");
    }

    #[test]
    fn a_different_mapping_at_the_same_governed_key_fails_closed() {
        let (_base, archive, _backup) = scratch("protectionconflict");
        let base_request = ProtectionRequest {
            archive_record_id: "AR-OPS-0002".to_string(),
            capture_version: "v001".to_string(),
            protected_identities: vec![sha256_hex(b"a")],
        };
        assert!(
            record_protection_within_root(&archive, &base_request)
                .unwrap()
                .ok
        );

        let conflicting = ProtectionRequest {
            protected_identities: vec![sha256_hex(b"a"), sha256_hex(b"z")],
            ..base_request.clone()
        };
        let result = record_protection_within_root(&archive, &conflicting).unwrap();
        assert!(!result.ok);
        assert_eq!(
            codes(&result.blockers),
            vec!["b2b-protection-record-conflict"]
        );

        // The original mapping is intact — no overwrite, no release.
        let digest = protection_key_digest("AR-OPS-0002", "v001");
        let stored = fs::read(
            archive
                .join(PROTECTION_DIR)
                .join(&digest[0..2])
                .join(format!("{PROTECTION_PREFIX}{digest}{PROTECTION_SUFFIX}")),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&stored).unwrap();
        assert_eq!(parsed["protectedIdentities"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_protection_key_cannot_be_collided_by_boundary_shifting() {
        // Length-prefixed key material: ("AR-a","v001") and ("AR-","av001")
        // must never derive the same record.
        assert_ne!(
            protection_key_digest("AR-a", "v001"),
            protection_key_digest("AR-", "av001")
        );
        assert_eq!(
            protection_key_digest("AR-1", "v001"),
            protection_key_digest("AR-1", "v001")
        );
    }

    #[test]
    fn the_protection_mapping_refuses_malformed_and_unbounded_identity_sets() {
        let (_base, archive, _backup) = scratch("protectionrefuse");
        let valid = ProtectionRequest {
            archive_record_id: "AR-OPS-0003".to_string(),
            capture_version: "v001".to_string(),
            protected_identities: vec![],
        };
        assert_eq!(
            codes(
                &record_protection_within_root(&archive, &valid)
                    .unwrap()
                    .blockers
            ),
            vec!["b2b-protected-identities-empty"]
        );

        let malformed = ProtectionRequest {
            protected_identities: vec!["not-a-hash".to_string()],
            ..valid.clone()
        };
        assert_eq!(
            codes(
                &record_protection_within_root(&archive, &malformed)
                    .unwrap()
                    .blockers
            ),
            vec!["b2b-sha256-malformed"]
        );

        let too_many = ProtectionRequest {
            protected_identities: (0..MAX_PROTECTED_IDENTITIES + 1)
                .map(|i| sha256_hex(i.to_string().as_bytes()))
                .collect(),
            ..valid.clone()
        };
        assert_eq!(
            codes(
                &record_protection_within_root(&archive, &too_many)
                    .unwrap()
                    .blockers
            ),
            vec!["b2b-protected-identities-too-many"]
        );

        let bad_version = ProtectionRequest {
            capture_version: "v1".to_string(),
            protected_identities: vec![sha256_hex(b"a")],
            ..valid.clone()
        };
        assert_eq!(
            codes(
                &record_protection_within_root(&archive, &bad_version)
                    .unwrap()
                    .blockers
            ),
            vec!["b2b-capture-version-invalid"]
        );
    }

    #[test]
    fn the_protection_request_refuses_a_caller_supplied_release_or_delete_instruction() {
        for injected in [
            r#""release":"NOW""#,
            r#""delete":true"#,
            r#""gc":true"#,
            r#""path":"/tmp/evil""#,
        ] {
            let json = format!(
                r#"{{"archiveRecordId":"AR-1","captureVersion":"v001",
                     "protectedIdentities":[],{injected}}}"#
            );
            let parsed: Result<ProtectionRequest, _> = serde_json::from_str(&json);
            assert!(parsed.is_err(), "{injected} must be refused");
        }
    }

    // ── Absence of prohibited authority (source-level) ─────────────────────

    /// A code-only view of this module: prose that DESCRIBES a prohibited
    /// authority must never be able to satisfy — or to fail — a check about
    /// whether the code USES it.
    fn code_only(source: &str) -> String {
        // The stripper is line-based, so assert the file carries no block
        // comments rather than silently under-stripping.
        assert!(
            !source.contains("/*"),
            "code_only assumes line comments only"
        );
        source
            .lines()
            .map(|line| match line.find("//") {
                Some(index) => &line[..index],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn this_module_holds_no_delete_gc_repair_or_source_acquisition_authority() {
        let source = include_str!("operating_space_archive_delivery.rs");
        let production = code_only(source.split("#[cfg(all(test, unix))]").next().unwrap());

        // Split so the assertions themselves cannot satisfy the search.
        let repair = ["cas", "repair", "write", "within", "root"].join("_");
        let reclaim = ["archive", "reclaim"].join("_");
        let retention = ["archive", "retention", "plan"].join("_");
        let quarantine = ["archive", "occupant", "quarantine"].join("_");

        // No repair/replace authority is reachable from B2B.
        assert!(!production.contains(&repair));
        // No reclamation / GC / quarantine authority.
        assert!(!production.contains(&reclaim));
        assert!(!production.contains(&retention));
        assert!(!production.contains(&quarantine));
        // No ambient filesystem authority outside the confined primitives.
        assert!(!production.contains(&["std", "fs"].join("::")));
        assert!(!production.contains("remove_dir_all"));
        assert!(!production.contains("remove_file"));
        // No environment-variable or renderer-selected root.
        assert!(!production.contains(&["std", "env"].join("::")));
        // No source-acquisition / credential / session authority.
        for banned in [
            "reqwest",
            "cookie",
            "credential",
            "authorization",
            "bearer",
            "session_token",
            "chatgpt",
            "signed_url",
        ] {
            assert!(
                !production.to_ascii_lowercase().contains(banned),
                "production surface must not reference {banned}"
            );
        }
    }

    #[test]
    fn the_code_only_view_actually_strips_prose() {
        // Negative control for the stripper itself: without it, a comment
        // naming a prohibited symbol would be indistinguishable from using it.
        let sample = "let x = 1; // cas_repair_write_within_root\n// std::fs\nlet y = 2;";
        let stripped = code_only(sample);
        assert!(!stripped.contains("cas_repair_write_within_root"));
        assert!(!stripped.contains("std::fs"));
        assert!(stripped.contains("let x = 1;") && stripped.contains("let y = 2;"));
    }

    #[test]
    fn the_command_surface_is_the_minimum_sufficient_four() {
        let source = include_str!("operating_space_archive_delivery.rs");
        let marker = ["#[tauri", "::command]"].concat();
        assert_eq!(
            source.matches(&marker).count(),
            4,
            "B2B v1 exposes exactly publish / resolve / record-protection / verify"
        );
    }

    #[test]
    fn both_host_handler_variants_register_every_b2b_command_and_no_state() {
        let lib = include_str!("lib.rs");
        for command in [
            "h2o_operating_space_archive_publish_object",
            "h2o_operating_space_archive_resolve_object",
            "h2o_operating_space_archive_record_protection",
            "h2o_operating_space_archive_verify_delivery",
        ] {
            assert_eq!(
                lib.matches(&format!("operating_space_archive_delivery::{command}"))
                    .count(),
                2,
                "{command} needs one registration in each debug/release handler"
            );
        }
        // The bounded module requires no process-local state, so the Host lease
        // registers none.
        assert!(
            !lib.contains("operating_space_archive_delivery::") || {
                let managed = format!(".manage(operating_space_archive_delivery::");
                !lib.contains(&managed)
            }
        );
        // The incumbent P02 registrations the Host lease must leave intact are
        // proven by the permanent B2B validator rather than here. Naming those
        // commands in this crate would itself register as a "reach" under the
        // P02 T19 B10 gate, which requires zero occurrences outside lib.rs and
        // the executor -- and a test must never weaken an accepted gate to
        // assert something another gate already proves.
    }

    #[test]
    fn the_recovery_root_component_is_distinct_from_the_incumbent_backup_grammar() {
        assert_eq!(BACKUP_ROOT_COMPONENT, "H2O Operating-Space Archive Backups");
        assert_ne!(
            BACKUP_ROOT_COMPONENT,
            crate::saved_chat_backup_root_policy::BACKUP_ROOT_COMPONENT
        );
    }

    #[test]
    fn staging_names_live_inside_the_already_reserved_prefix() {
        // The protection writer's staging artifacts must be covered by the
        // incumbent reservation, so no second reserved namespace is minted.
        let name = String::from_utf8(core_staging_name_for_test()).unwrap();
        assert!(name.starts_with(crate::archive_durable_write::TEMP_PREFIX));
        assert!(crate::archive_durable_write::is_reserved_component(&name));
        // And it can never collide with the incumbent generator's own names.
        assert!(name.contains(STAGING_INFIX));
    }

    fn core_staging_name_for_test() -> Vec<u8> {
        let counter = STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
        format!(
            "{}{STAGING_INFIX}{}-{counter}{}",
            crate::archive_durable_write::TEMP_PREFIX,
            std::process::id(),
            crate::archive_durable_write::TEMP_SUFFIX
        )
        .into_bytes()
    }
}
