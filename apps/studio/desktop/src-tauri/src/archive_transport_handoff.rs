//! M07 storage-owned, read-only Saved-Chat transport-object handoff.
//!
//! A caller supplies only semantic package identity. BEGIN reuses the
//! generation publisher's authoritative verifier, opens the exact package and
//! CAS objects descriptor-relatively with `O_NOFOLLOW`, verifies their stored
//! bytes, and retains those open file handles in a bounded process-local
//! session. READ seeks only those handles; it never resolves a path. END drops
//! the handles. No remote, outbox, ledger, sequence, export-id, credential,
//! path, delete, rename, write, or retention authority exists here.

// T02: read-only and descriptor-relative throughout, so it compiles on every
// platform through the `confined` facade (contract I16: a platform that cannot
// publish still reads). No module-level platform gate.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::archive_durable_write::{confined, sha256_hex};
use crate::archive_generation_publish::{
    cas_relative_parts, generation_basename, validated_chat_id, verify_occupant_all_supported,
};
use crate::archive_package_scan::{legacy_basename, ConstructionFamily};
use crate::saved_chat_package_verify::{PackageFamily, SnapshotEncoding};

pub const HANDOFF_SCHEMA: &str = "h2o.savedChatTransportHandoff.v1";
pub const REPRESENTATION_SCHEMA: &str = "h2o.savedChatTransportRepresentation.v1";
pub const HANDOFF_VERSION: u32 = 1;

/// One cooperative IPC read window. This deliberately reuses the publisher's
/// governed streaming window; it is an allocation/transport limit, never an
/// object or package size limit.
pub const READ_CAP_BYTES: u64 = crate::archive_generation_publish::STREAM_WINDOW_BYTES as u64;

const PACKAGE_KIND: &str = "saved-chat-package";

pub mod codes {
    pub const SELECTOR_INVALID: &str = "transport-handoff-selector-invalid";
    pub const PACKAGE_ABSENT: &str = "transport-handoff-package-absent";
    pub const PACKAGE_UNVERIFIED: &str = "transport-handoff-package-unverified";
    pub const PACKAGE_IDENTITY_MISMATCH: &str = "transport-handoff-package-identity-mismatch";
    pub const PACKAGE_FAMILY_UNSUPPORTED: &str = "transport-handoff-package-family-unsupported";
    pub const MEMBER_UNAVAILABLE: &str = "transport-handoff-member-unavailable";
    pub const MEMBER_IDENTITY_MISMATCH: &str = "transport-handoff-member-identity-mismatch";
    pub const ASSET_UNAVAILABLE: &str = "transport-handoff-asset-unavailable";
    pub const ASSET_IDENTITY_MISMATCH: &str = "transport-handoff-asset-identity-mismatch";
    pub const OBJECT_SET_OVERFLOW: &str = "transport-handoff-object-set-overflow";
    pub const SESSIONS_EXHAUSTED: &str = "transport-handoff-sessions-exhausted";
    pub const SESSION_UNKNOWN: &str = "transport-handoff-session-unknown";
    pub const OBJECT_UNKNOWN: &str = "transport-handoff-object-unknown";
    pub const READ_BOUND_INVALID: &str = "transport-handoff-read-bound-invalid";
    pub const READ_OFFSET_OVERFLOW: &str = "transport-handoff-read-offset-overflow";
    pub const READ_OFFSET_OUT_OF_RANGE: &str = "transport-handoff-read-offset-out-of-range";
    pub const OBJECT_READ_FAILED: &str = "transport-handoff-object-read-failed";
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub code: String,
}

impl Blocker {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
        }
    }
}

/// Semantic identity only. There is deliberately no path-shaped variant and
/// unknown fields are refused rather than silently ignored.
#[derive(Clone, Debug, serde::Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HandoffSelector {
    Generation {
        chat_id: String,
        content_hash: String,
    },
    Legacy {
        chat_id: String,
    },
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ObjectRole {
    Manifest,
    Snapshot,
    Markdown,
    Html,
    Asset,
}

impl ObjectRole {
    fn rank(&self) -> u8 {
        match self {
            ObjectRole::Manifest => 0,
            ObjectRole::Snapshot => 1,
            ObjectRole::Markdown => 2,
            ObjectRole::Html => 3,
            ObjectRole::Asset => 4,
        }
    }
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransportObjectDescriptor {
    /// Opaque within the session; never a member name, path, or CAS key.
    pub object_id: String,
    pub role: ObjectRole,
    pub media_type: String,
    pub stored_sha256: String,
    pub byte_length: u64,
    /// Present only when the authoritative package descriptor exposes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_byte_length: Option<u64>,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogicalPackageIdentity {
    pub chat_id: String,
    /// Existing package authority, unchanged and never overloaded with the
    /// physical handoff representation.
    pub content_hash: String,
}

#[derive(Clone, Debug, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffDescriptor {
    pub schema: &'static str,
    pub version: u32,
    pub representation_hash: String,
    pub logical_identity: LogicalPackageIdentity,
    pub package_kind: &'static str,
    pub construction_family: ConstructionFamily,
    pub schema_version: u64,
    /// `null`/absent package payload versions remain distinct from explicit
    /// versions. V1 has no payloadVersion; V2 has payloadVersion 2.
    pub payload_version: Option<u64>,
    pub object_count: u64,
    pub total_physical_bytes: u64,
    pub objects: Vec<TransportObjectDescriptor>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginResult {
    pub schema: &'static str,
    pub ok: bool,
    /// Decimal text across IPC; callers must never perform token arithmetic.
    #[serde(serialize_with = "crate::archive_generation_publish::ipc_token::serialize")]
    pub token: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<HandoffDescriptor>,
    pub blockers: Vec<Blocker>,
}

impl BeginResult {
    fn refused(code: &str) -> Self {
        Self {
            schema: HANDOFF_SCHEMA,
            ok: false,
            token: 0,
            descriptor: None,
            blockers: vec![Blocker::new(code)],
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub schema: &'static str,
    pub ok: bool,
    pub object_id: String,
    pub offset: u64,
    pub next_offset: u64,
    pub eof: bool,
    /// At most `READ_CAP_BYTES`; never a whole-object implicit allocation.
    pub bytes: Vec<u8>,
    pub blockers: Vec<Blocker>,
}

impl ReadResult {
    fn refused(code: &str) -> Self {
        Self {
            schema: HANDOFF_SCHEMA,
            ok: false,
            object_id: String::new(),
            offset: 0,
            next_offset: 0,
            eof: false,
            bytes: Vec::new(),
            blockers: vec![Blocker::new(code)],
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndResult {
    pub schema: &'static str,
    pub ok: bool,
    pub ended: bool,
    pub blockers: Vec<Blocker>,
}

impl EndResult {
    fn refused(code: &str) -> Self {
        Self {
            schema: HANDOFF_SCHEMA,
            ok: false,
            ended: false,
            blockers: vec![Blocker::new(code)],
        }
    }
}

struct OpenObject {
    descriptor: TransportObjectDescriptor,
    file: std::fs::File,
}

struct SessionInner {
    objects: BTreeMap<String, OpenObject>,
    last_activity: Instant,
    ended: bool,
}

struct Session {
    inner: Mutex<SessionInner>,
}

struct RegistryInner {
    sessions: BTreeMap<u64, Arc<Session>>,
    /// BEGINs currently opening/verifying handles also consume admission.
    building: usize,
}

struct Registry {
    inner: Mutex<RegistryInner>,
    next_token: AtomicU64,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(RegistryInner {
                sessions: BTreeMap::new(),
                building: 0,
            }),
            next_token: AtomicU64::new(crate::archive_generation_publish::random_token_seed()),
        }
    }
}

/// Process-local handoff authority. Dropping it closes every retained handle;
/// no durable lease or session artifact exists.
pub struct Handoff {
    root: std::path::PathBuf,
    registry: Registry,
}

impl Handoff {
    /// `root` is the trusted app-owned `.../archive` root.
    pub fn new(root: impl Into<std::path::PathBuf>) -> Self {
        Self {
            root: root.into(),
            registry: Registry::default(),
        }
    }

    fn reserve_begin(&self) -> Result<(), &'static str> {
        let mut registry = self
            .registry
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reap_idle(&mut registry);
        if registry.sessions.len() + registry.building
            >= crate::archive_generation_publish::MAX_ADMITTED_SESSIONS
        {
            return Err(codes::SESSIONS_EXHAUSTED);
        }
        registry.building += 1;
        Ok(())
    }

    fn cancel_begin(&self) {
        let mut registry = self
            .registry
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        registry.building = registry.building.saturating_sub(1);
    }

    fn install(&self, prepared: PreparedSession) -> Result<u64, &'static str> {
        let mut registry = self
            .registry
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        registry.building = registry.building.saturating_sub(1);
        for _ in 0..8 {
            let token = self.registry.next_token.fetch_add(1, Ordering::SeqCst);
            if token == 0 || registry.sessions.contains_key(&token) {
                continue;
            }
            registry.sessions.insert(
                token,
                Arc::new(Session {
                    inner: Mutex::new(SessionInner {
                        objects: prepared.objects,
                        last_activity: Instant::now(),
                        ended: false,
                    }),
                }),
            );
            return Ok(token);
        }
        Err(codes::SESSIONS_EXHAUSTED)
    }
}

fn reap_idle(registry: &mut RegistryInner) {
    let now = Instant::now();
    registry.sessions.retain(|_, session| {
        let Ok(mut inner) = session.inner.try_lock() else {
            // An active READ/END is never evicted beneath its operation.
            return true;
        };
        if now.duration_since(inner.last_activity)
            < crate::archive_generation_publish::SESSION_IDLE_TIMEOUT
        {
            return true;
        }
        inner.ended = true;
        inner.objects.clear(); // closes every retained handle
        false
    });
}

struct PreparedSession {
    descriptor: HandoffDescriptor,
    objects: BTreeMap<String, OpenObject>,
}

fn sha_prefixed(bytes: &[u8]) -> String {
    format!("sha256-{}", sha256_hex(bytes))
}

fn hash_open_file(file: &mut std::fs::File) -> Result<(String, u64), &'static str> {
    use sha2::{Digest, Sha256};

    file.seek(SeekFrom::Start(0))
        .map_err(|_| codes::OBJECT_READ_FAILED)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; crate::archive_generation_publish::STREAM_WINDOW_BYTES];
    let mut length = 0u64;
    loop {
        let read = file.read(&mut buf).map_err(|_| codes::OBJECT_READ_FAILED)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        length = length
            .checked_add(read as u64)
            .ok_or(codes::OBJECT_SET_OVERFLOW)?;
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| codes::OBJECT_READ_FAILED)?;
    let mut hex = String::with_capacity(64);
    for byte in hasher.finalize() {
        hex.push_str(&format!("{byte:02x}"));
    }
    Ok((format!("sha256-{hex}"), length))
}

fn open_exact_object(
    dir: &confined::Dir,
    name: &[u8],
    object_id: String,
    role: ObjectRole,
    media_type: String,
    expected_sha: &str,
    expected_len: u64,
    encoding: Option<String>,
    logical_sha256: Option<String>,
    logical_byte_length: Option<u64>,
    unavailable_code: &'static str,
    mismatch_code: &'static str,
) -> Result<OpenObject, &'static str> {
    let mut file = dir
        .open_child_read_nofollow(name)
        .map_err(|_| unavailable_code)?;
    if !file.metadata().map_err(|_| unavailable_code)?.is_file() {
        return Err(unavailable_code);
    }
    let (stored_sha256, byte_length) = hash_open_file(&mut file).map_err(|_| unavailable_code)?;
    if stored_sha256 != expected_sha || byte_length != expected_len {
        return Err(mismatch_code);
    }
    Ok(OpenObject {
        descriptor: TransportObjectDescriptor {
            object_id,
            role,
            media_type,
            stored_sha256,
            byte_length,
            encoding,
            logical_sha256,
            logical_byte_length,
        },
        file,
    })
}

fn canonical_objects(
    mut objects: Vec<TransportObjectDescriptor>,
) -> Vec<TransportObjectDescriptor> {
    objects.sort_by(|a, b| {
        a.role
            .rank()
            .cmp(&b.role.rank())
            .then_with(|| a.stored_sha256.cmp(&b.stored_sha256))
            .then_with(|| a.byte_length.cmp(&b.byte_length))
            .then_with(|| a.object_id.cmp(&b.object_id))
    });
    objects
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RepresentationPreimage<'a> {
    schema: &'static str,
    version: u32,
    package_kind: &'static str,
    logical_identity: &'a LogicalPackageIdentity,
    construction_family: ConstructionFamily,
    schema_version: u64,
    payload_version: Option<u64>,
    object_count: u64,
    total_physical_bytes: u64,
    objects: &'a [TransportObjectDescriptor],
}

/// SHA-256 over a compact, field-order-frozen preimage whose object list is
/// sorted internally. Filesystem enumeration or caller ordering can therefore
/// never alter the representation identity.
fn representation_hash(
    logical_identity: &LogicalPackageIdentity,
    construction_family: ConstructionFamily,
    schema_version: u64,
    payload_version: Option<u64>,
    objects: &[TransportObjectDescriptor],
) -> Result<(String, Vec<TransportObjectDescriptor>, u64), &'static str> {
    let objects = canonical_objects(objects.to_vec());
    let object_count = u64::try_from(objects.len()).map_err(|_| codes::OBJECT_SET_OVERFLOW)?;
    let total_physical_bytes = objects.iter().try_fold(0u64, |total, object| {
        total
            .checked_add(object.byte_length)
            .ok_or(codes::OBJECT_SET_OVERFLOW)
    })?;
    let bytes = serde_json::to_vec(&RepresentationPreimage {
        schema: REPRESENTATION_SCHEMA,
        version: HANDOFF_VERSION,
        package_kind: PACKAGE_KIND,
        logical_identity,
        construction_family,
        schema_version,
        payload_version,
        object_count,
        total_physical_bytes,
        objects: &objects,
    })
    .map_err(|_| codes::OBJECT_SET_OVERFLOW)?;
    Ok((sha_prefixed(&bytes), objects, total_physical_bytes))
}

fn required_file(
    files: &BTreeMap<String, (String, u64)>,
    key: &str,
) -> Result<(String, u64), &'static str> {
    files.get(key).cloned().ok_or(codes::MEMBER_UNAVAILABLE)
}

fn prepare(
    root: &std::path::Path,
    selector: &HandoffSelector,
) -> Result<PreparedSession, &'static str> {
    let (chat_id, package_name, expected_content_hex) = match selector {
        HandoffSelector::Generation {
            chat_id,
            content_hash,
        } => {
            let chat_id = validated_chat_id(chat_id)
                .map_err(|_| codes::SELECTOR_INVALID)?
                .to_string();
            let content_hex = crate::archive_durable_write::normalize_expected_sha(content_hash)
                .ok_or(codes::SELECTOR_INVALID)?;
            let name = generation_basename(&chat_id, &content_hex);
            (chat_id, name, Some(content_hex))
        }
        HandoffSelector::Legacy { chat_id } => {
            let chat_id = validated_chat_id(chat_id)
                .map_err(|_| codes::SELECTOR_INVALID)?
                .to_string();
            let name = legacy_basename(&chat_id);
            (chat_id, name, None)
        }
    };

    // Read-only openers only: BEGIN never creates archive structure.
    let archive =
        confined::Dir::open_existing_nofollow(root).map_err(|_| codes::PACKAGE_UNVERIFIED)?;
    let packages = archive
        .open_child_nofollow(b"packages")
        .map_err(|_| codes::PACKAGE_UNVERIFIED)?;
    match packages.stat_child_nofollow(package_name.as_bytes()) {
        Ok(None) => return Err(codes::PACKAGE_ABSENT),
        Ok(Some(_)) => {}
        Err(_) => return Err(codes::PACKAGE_UNVERIFIED),
    }
    // Durable READ admission is deliberately independent from the active
    // NEW-write family. Rollback may stop new v3 publication, but a verified
    // v3 generation must remain transportable.
    let verified = verify_occupant_all_supported(&packages, package_name.as_bytes())
        .map_err(|_| codes::PACKAGE_UNVERIFIED)?;

    let verified_hex = crate::archive_durable_write::normalize_expected_sha(&verified.content_hash)
        .ok_or(codes::PACKAGE_UNVERIFIED)?;
    if verified.manifest.chat_id != chat_id
        || expected_content_hex
            .as_ref()
            .is_some_and(|expected| expected != &verified_hex)
    {
        return Err(codes::PACKAGE_IDENTITY_MISMATCH);
    }

    let construction_family = match verified.family {
        PackageFamily::V1 => ConstructionFamily::V1,
        PackageFamily::V2 => ConstructionFamily::V2,
        PackageFamily::V3 => ConstructionFamily::V3,
    };

    let mut opened = Vec::new();
    let manifest_sha = sha_prefixed(&verified.manifest_bytes);
    opened.push(open_exact_object(
        &verified.dir,
        b"manifest.json",
        "manifest".to_string(),
        ObjectRole::Manifest,
        "application/json".to_string(),
        &manifest_sha,
        verified.manifest_bytes.len() as u64,
        None,
        None,
        None,
        codes::MEMBER_UNAVAILABLE,
        codes::MEMBER_IDENTITY_MISMATCH,
    )?);

    let snapshot_encoding = if construction_family == ConstructionFamily::V3 {
        Some(match verified.snapshot_encoding {
            SnapshotEncoding::Identity => "identity".to_string(),
            SnapshotEncoding::Gzip => "gzip".to_string(),
        })
    } else {
        None
    };
    opened.push(open_exact_object(
        &verified.dir,
        b"snapshot.json",
        "snapshot".to_string(),
        ObjectRole::Snapshot,
        "application/json".to_string(),
        &verified.snapshot_physical_sha256,
        verified.snapshot_physical_byte_length,
        snapshot_encoding,
        (construction_family == ConstructionFamily::V3)
            .then(|| verified.logical_snapshot_sha256.clone()),
        (construction_family == ConstructionFamily::V3)
            .then_some(verified.logical_snapshot_byte_length),
        codes::MEMBER_UNAVAILABLE,
        codes::MEMBER_IDENTITY_MISMATCH,
    )?);

    // V1/V2 persist presentation members. V3 does not: Markdown and HTML are
    // derived only by M08 export and never enter its durable object inventory.
    if construction_family != ConstructionFamily::V3 {
        for (key, name, object_id, role, media_type) in [
            (
                "markdown",
                b"chat.md".as_slice(),
                "markdown",
                ObjectRole::Markdown,
                "text/markdown",
            ),
            (
                "html",
                b"chat.html".as_slice(),
                "html",
                ObjectRole::Html,
                "text/html",
            ),
        ] {
            let (sha, len) = required_file(&verified.manifest.files, key)?;
            opened.push(open_exact_object(
                &verified.dir,
                name,
                object_id.to_string(),
                role,
                media_type.to_string(),
                &sha,
                len,
                None,
                None,
                None,
                codes::MEMBER_UNAVAILABLE,
                codes::MEMBER_IDENTITY_MISMATCH,
            )?);
        }
    }

    // Assets are opened from canonical CAS. Location comes only from the
    // verified manifest sha through the existing CAS derivation authority.
    // Package member paths and caller strings never participate.
    let mut assets: Vec<_> = verified.manifest.assets.iter().collect();
    assets.sort_by(|a, b| a.sha256.cmp(&b.sha256));
    if !assets.is_empty() {
        let cas = archive
            .open_child_nofollow(b"assets")
            .map_err(|_| codes::ASSET_UNAVAILABLE)?;
        for (index, asset) in assets.iter().enumerate() {
            let (shard, basename) = cas_relative_parts(&asset.sha256);
            let shard = cas
                .open_child_nofollow(shard.as_bytes())
                .map_err(|_| codes::ASSET_UNAVAILABLE)?;
            opened.push(open_exact_object(
                &shard,
                basename.as_bytes(),
                format!("asset-{index:06}"),
                ObjectRole::Asset,
                asset.mime_type.clone(),
                &asset.sha256,
                asset.byte_length,
                None,
                None,
                None,
                codes::ASSET_UNAVAILABLE,
                codes::ASSET_IDENTITY_MISMATCH,
            )?);
        }
    }

    let logical_identity = LogicalPackageIdentity {
        chat_id,
        content_hash: verified.content_hash,
    };
    let descriptors: Vec<_> = opened
        .iter()
        .map(|object| object.descriptor.clone())
        .collect();
    let (representation_hash, descriptors, total_physical_bytes) = representation_hash(
        &logical_identity,
        construction_family,
        verified.manifest.schema_version,
        verified.manifest.payload_version,
        &descriptors,
    )?;
    let object_count = u64::try_from(descriptors.len()).map_err(|_| codes::OBJECT_SET_OVERFLOW)?;

    let mut by_id = BTreeMap::new();
    for object in opened {
        by_id.insert(object.descriptor.object_id.clone(), object);
    }
    Ok(PreparedSession {
        descriptor: HandoffDescriptor {
            schema: HANDOFF_SCHEMA,
            version: HANDOFF_VERSION,
            representation_hash,
            logical_identity,
            package_kind: PACKAGE_KIND,
            construction_family,
            schema_version: verified.manifest.schema_version,
            payload_version: verified.manifest.payload_version,
            object_count,
            total_physical_bytes,
            objects: descriptors,
        },
        objects: by_id,
    })
}

pub fn begin(handoff: &Handoff, selector: &HandoffSelector) -> BeginResult {
    if let Err(code) = handoff.reserve_begin() {
        return BeginResult::refused(code);
    }
    let prepared = match prepare(&handoff.root, selector) {
        Ok(prepared) => prepared,
        Err(code) => {
            handoff.cancel_begin();
            return BeginResult::refused(code);
        }
    };
    let descriptor = prepared.descriptor.clone();
    match handoff.install(prepared) {
        Ok(token) => BeginResult {
            schema: HANDOFF_SCHEMA,
            ok: true,
            token,
            descriptor: Some(descriptor),
            blockers: Vec::new(),
        },
        Err(code) => BeginResult::refused(code),
    }
}

pub fn read(
    handoff: &Handoff,
    token: u64,
    object_id: &str,
    offset: u64,
    max_bytes: u64,
) -> ReadResult {
    if offset.checked_add(max_bytes).is_none() {
        return ReadResult::refused(codes::READ_OFFSET_OVERFLOW);
    }
    if max_bytes == 0 || max_bytes > READ_CAP_BYTES {
        return ReadResult::refused(codes::READ_BOUND_INVALID);
    }
    let session = {
        let registry = handoff
            .registry
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match registry.sessions.get(&token) {
            Some(session) => Arc::clone(session),
            None => return ReadResult::refused(codes::SESSION_UNKNOWN),
        }
    };
    let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
    if inner.ended {
        return ReadResult::refused(codes::SESSION_UNKNOWN);
    }
    inner.last_activity = Instant::now();
    let object = match inner.objects.get_mut(object_id) {
        Some(object) => object,
        None => return ReadResult::refused(codes::OBJECT_UNKNOWN),
    };
    let length = object.descriptor.byte_length;
    if offset > length {
        return ReadResult::refused(codes::READ_OFFSET_OUT_OF_RANGE);
    }
    let amount = std::cmp::min(max_bytes, length - offset);
    if object.file.seek(SeekFrom::Start(offset)).is_err() {
        return ReadResult::refused(codes::OBJECT_READ_FAILED);
    }
    let mut bytes = Vec::with_capacity(amount as usize);
    if object
        .file
        .by_ref()
        .take(amount)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 != amount
    {
        return ReadResult::refused(codes::OBJECT_READ_FAILED);
    }
    let next_offset = match offset.checked_add(amount) {
        Some(value) => value,
        None => return ReadResult::refused(codes::READ_OFFSET_OVERFLOW),
    };
    ReadResult {
        schema: HANDOFF_SCHEMA,
        ok: true,
        object_id: object_id.to_string(),
        offset,
        next_offset,
        eof: next_offset == length,
        bytes,
        blockers: Vec::new(),
    }
}

pub fn end(handoff: &Handoff, token: u64) -> EndResult {
    let session = {
        let mut registry = handoff
            .registry
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match registry.sessions.remove(&token) {
            Some(session) => session,
            None => return EndResult::refused(codes::SESSION_UNKNOWN),
        }
    };
    // If a READ is in flight, wait for that bounded operation. If END wins the
    // lease first, a previously cloned reader sees `ended` and refuses.
    let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.ended = true;
    inner.objects.clear();
    EndResult {
        schema: HANDOFF_SCHEMA,
        ok: true,
        ended: true,
        blockers: Vec::new(),
    }
}

// ── Tauri read-only surface ───────────────────────────────────────────────

pub struct HandoffState(pub Mutex<Option<Arc<Handoff>>>);

impl Default for HandoffState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn handoff_for(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, HandoffState>,
) -> Result<Arc<Handoff>, String> {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = slot.as_ref() {
        return Ok(Arc::clone(existing));
    }
    let root = crate::archive_durable_write::archive_root(app)?;
    let handoff = Arc::new(Handoff::new(root));
    *slot = Some(Arc::clone(&handoff));
    Ok(handoff)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginOptions {
    pub selector: HandoffSelector,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadOptions {
    #[serde(deserialize_with = "crate::archive_generation_publish::ipc_token::deserialize")]
    pub token: u64,
    pub object_id: String,
    pub offset: u64,
    pub max_bytes: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EndOptions {
    #[serde(deserialize_with = "crate::archive_generation_publish::ipc_token::deserialize")]
    pub token: u64,
}

#[tauri::command]
pub async fn h2o_archive_transport_handoff_begin(
    app: tauri::AppHandle,
    state: tauri::State<'_, HandoffState>,
    options: BeginOptions,
) -> Result<BeginResult, String> {
    let handoff = handoff_for(&app, &state)?;
    Ok(begin(&handoff, &options.selector))
}

#[tauri::command]
pub async fn h2o_archive_transport_handoff_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, HandoffState>,
    options: ReadOptions,
) -> Result<ReadResult, String> {
    let handoff = handoff_for(&app, &state)?;
    Ok(read(
        &handoff,
        options.token,
        &options.object_id,
        options.offset,
        options.max_bytes,
    ))
}

#[tauri::command]
pub async fn h2o_archive_transport_handoff_end(
    app: tauri::AppHandle,
    state: tauri::State<'_, HandoffState>,
    options: EndOptions,
) -> Result<EndResult, String> {
    let handoff = handoff_for(&app, &state)?;
    Ok(end(&handoff, options.token))
}

#[cfg(test)]
mod tests;
