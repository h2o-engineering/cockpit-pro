//! M10 P3.6a — trusted portable package verification.
//!
//! One new TRUSTED ENTRY POINT, not a new authority. Portable (`.h2ochat` ZIP)
//! imports and exports have until now decided package validity in JavaScript;
//! this module lets them ask the SAME Rust semantic verifier the archive path
//! already trusts, without the bytes ever touching the archive.
//!
//! What this module owns:
//!   - session framing: begin / declare / write / finish / abort;
//!   - bounded accumulation, with every cap checked BEFORE an append;
//!   - member identity safety, decided natively and never taken on trust from
//!     the renderer;
//!   - assembling the existing `PackageMembers` input, including the actual
//!     asset SHA-256s the existing verifier adapter expects.
//!
//! What it deliberately does NOT own — all of it stays in
//! `saved_chat_package_verify::verify_package`:
//!   manifest and version rules, snapshot semantics, contentHash semantics,
//!   member hash semantics, V3 renderer rules, gzip validity, cross-binding.
//!
//! It writes nothing. No archive path, no DB, no CAS, no staging file, no
//! persistent verification record. A session is memory that disappears on
//! finish, on abort, or with the process.
//!
//! ZIP parsing stays in JavaScript: the renderer hands over already-extracted
//! member bytes, and the native side re-derives every identity fact it uses.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::archive_durable_write::sha256_hex;
use crate::archive_package_scan::{name_shape, NameShape};
use crate::saved_chat_package_verify::{
    verify_package, PackageMembers, VerificationAdmission, VerifiedAssetMember,
};

pub const VERIFICATION_SCHEMA: &str = "h2o.savedChatPortablePackageVerification";
pub const VERIFICATION_SCHEMA_VERSION: u32 = 1;

/// Reused transport ceiling — one raw IPC append.
const CHUNK_CAP_BYTES: u64 = crate::archive_generation_publish::CHUNK_CAP_BYTES;
/// Reused idle semantics. Lazy sweep only; deliberately no timer thread.
const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Reused governed per-asset ceiling.
const ASSET_CAP_BYTES: u64 = crate::archive_durable_write::GOVERNED_ASSET_BLOB_CAP_BYTES;
/// The stored snapshot member shares the governed logical snapshot ceiling; the
/// decode itself is the verifier's business, not this adapter's.
const SNAPSHOT_CAP_BYTES: u64 = 8 * 1024 * 1024;

pub const PORTABLE_MANIFEST_CAP_BYTES: u64 = 1_048_576;
pub const PORTABLE_MARKDOWN_CAP_BYTES: u64 = 8_388_608;
pub const PORTABLE_HTML_CAP_BYTES: u64 = 16_777_216;
pub const PORTABLE_ASSET_COUNT_CAP: usize = 1_020;
pub const PORTABLE_MEMBER_COUNT_CAP: usize = 1_024;
pub const PORTABLE_PACKAGE_TOTAL_CAP_BYTES: u64 = 134_217_728;
pub const PORTABLE_BASENAME_CAP_BYTES: usize = 255;
pub const PORTABLE_MEMBER_PATH_CAP_BYTES: usize = 255;
pub const MAX_ACTIVE_PORTABLE_SESSIONS: usize = 1;
/// Aggregate retained bytes across every live session. With one active session
/// this equals the per-session cap today; it is stated separately so raising
/// the session count later cannot silently multiply resident memory.
pub const PORTABLE_AGGREGATE_RETAINED_CAP_BYTES: u64 = 134_217_728;

// ── member identity ────────────────────────────────────────────────────────

/// The canonical semantic inventory, plus assets. A key outside this domain is
/// refused before any byte is accepted — there is no free-form member.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum MemberKey {
    Manifest,
    Snapshot,
    Markdown,
    Html,
    /// `assets/sha256-<64 lowercase hex>.<ext>` — the hash is the CLAIM in the
    /// name; the actual bytes are hashed at finish and the verifier compares.
    Asset {
        sha256: String,
        ext: String,
    },
}

impl MemberKey {
    fn cap_bytes(&self) -> u64 {
        match self {
            MemberKey::Manifest => PORTABLE_MANIFEST_CAP_BYTES,
            MemberKey::Snapshot => SNAPSHOT_CAP_BYTES,
            MemberKey::Markdown => PORTABLE_MARKDOWN_CAP_BYTES,
            MemberKey::Html => PORTABLE_HTML_CAP_BYTES,
            MemberKey::Asset { .. } => ASSET_CAP_BYTES,
        }
    }

    /// Package-relative path, rebuilt from the parsed identity rather than from
    /// caller text, so nothing a caller wrote reaches the verifier verbatim.
    fn package_path(&self) -> String {
        match self {
            MemberKey::Manifest => "manifest.json".to_string(),
            MemberKey::Snapshot => "snapshot.json".to_string(),
            MemberKey::Markdown => "chat.md".to_string(),
            MemberKey::Html => "chat.html".to_string(),
            MemberKey::Asset { sha256, ext } => format!("assets/sha256-{sha256}.{ext}"),
        }
    }
}

fn lower_hex_64(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn asset_ext(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 16
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Parse a declared member key. Every rejection happens here, BEFORE the
/// session accepts a single byte for it.
pub(crate) fn parse_member_key(raw: &str) -> Result<MemberKey, &'static str> {
    if raw.len() > PORTABLE_MEMBER_PATH_CAP_BYTES {
        return Err("portable-member-path-too-long");
    }
    // Traversal and separator ambiguity are refused outright rather than
    // normalized: normalization is where these bugs live.
    if raw.contains("..")
        || raw.contains('\\')
        || raw.starts_with('/')
        || raw.contains("//")
        || raw.contains('\0')
    {
        return Err("portable-member-path-unsafe");
    }
    match raw {
        "manifest" => return Ok(MemberKey::Manifest),
        "snapshot" => return Ok(MemberKey::Snapshot),
        "markdown" => return Ok(MemberKey::Markdown),
        "html" => return Ok(MemberKey::Html),
        _ => {}
    }
    // The single `:` belongs to the `asset:` scheme. Anything after it carrying
    // another colon is drive-letter/stream ambiguity and is refused.
    let Some(rest) = raw.strip_prefix("asset:sha256-") else {
        return Err("portable-member-key-invalid");
    };
    if rest.contains(':') {
        return Err("portable-member-path-unsafe");
    }
    let Some((hex, ext)) = rest.split_once('.') else {
        return Err("portable-member-key-invalid");
    };
    if !lower_hex_64(hex) {
        return Err("portable-member-asset-hash-invalid");
    }
    if !asset_ext(ext) {
        return Err("portable-member-asset-ext-invalid");
    }
    Ok(MemberKey::Asset {
        sha256: hex.to_string(),
        ext: ext.to_string(),
    })
}

/// The package basename must itself be a safe, non-reserved package name, and
/// its chat identity is what binds the verification. Manifest identity is never
/// trusted for this input.
fn begin_chat_id_for(basename: &str) -> Result<String, &'static str> {
    if basename.is_empty() || basename.len() > PORTABLE_BASENAME_CAP_BYTES {
        return Err("portable-basename-invalid");
    }
    if basename.contains('/')
        || basename.contains('\\')
        || basename.contains(':')
        || basename.contains("..")
        || basename.contains('\0')
    {
        return Err("portable-basename-unsafe");
    }
    match name_shape(basename) {
        NameShape::Generation { chat_id, .. } | NameShape::Legacy { chat_id } => {
            if chat_id.is_empty() {
                Err("portable-basename-invalid")
            } else {
                Ok(chat_id)
            }
        }
        NameShape::Reserved => Err("portable-basename-reserved"),
        NameShape::NotAPackage => Err("portable-basename-not-a-package"),
    }
}

// ── session state ──────────────────────────────────────────────────────────

struct Member {
    expected_length: u64,
    bytes: Vec<u8>,
}

struct SessionInner {
    members: BTreeMap<MemberKey, Member>,
    accumulated: u64,
    declared_assets: usize,
    touched_at: Instant,
}

pub struct Session {
    basename: String,
    begin_chat_id: String,
    /// Persistent members the caller found OUTSIDE the canonical semantic
    /// inventory. ZIP parsing is deliberately not done natively, so the entry
    /// inventory can only come from the caller; a non-empty list can make the
    /// verification STRICTER and never more permissive, because the verifier
    /// refuses outright on it. No bytes are ever uploaded for these.
    unexpected_members: Vec<String>,
    inner: Mutex<SessionInner>,
}

pub struct Registry {
    map: Mutex<BTreeMap<u64, Arc<Session>>>,
    next_token: AtomicU64,
}

/// Largest integer JavaScript represents exactly. The token crosses an IPC
/// boundary as a JSON number, so a full 64-bit seed would be silently rounded
/// in the renderer and every subsequent call would carry a token that no longer
/// names the session. Masking keeps it exact while staying non-replaying.
const TOKEN_MASK: u64 = (1u64 << 53) - 1;

fn safe_token_seed() -> u64 {
    (crate::archive_generation_publish::random_token_seed() & TOKEN_MASK) | 1
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            map: Mutex::new(BTreeMap::new()),
            next_token: AtomicU64::new(safe_token_seed()),
        }
    }
}

impl Registry {
    fn lock_map(&self) -> MutexGuard<'_, BTreeMap<u64, Arc<Session>>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Lazy idle reclamation — no background timer. Called only from `begin`,
    /// which is the one place admission pressure exists.
    fn sweep_idle(map: &mut BTreeMap<u64, Arc<Session>>) {
        map.retain(|_, session| {
            let inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.touched_at.elapsed() < SESSION_IDLE_TIMEOUT
        });
    }

    fn aggregate_retained(map: &BTreeMap<u64, Arc<Session>>) -> u64 {
        map.values()
            .map(|session| {
                session
                    .inner
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .accumulated
            })
            .sum()
    }

    fn get(&self, token: u64) -> Option<Arc<Session>> {
        self.lock_map().get(&token).cloned()
    }
}

#[derive(Default)]
pub struct PortableVerifyState(pub Mutex<Option<Arc<Registry>>>);

fn registry_for(state: &tauri::State<'_, PortableVerifyState>) -> Arc<Registry> {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    slot.get_or_insert_with(|| Arc::new(Registry::default()))
        .clone()
}

// ── wire ───────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BeginResult {
    pub schema: &'static str,
    pub schema_version: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AckResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

impl AckResult {
    fn ok() -> Self {
        Self {
            ok: true,
            code: None,
        }
    }
    fn refused(code: &'static str) -> Self {
        Self {
            ok: false,
            code: Some(code),
        }
    }
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    /// `adapter` = framing/input safety refused it before semantics ran.
    /// `verifier` = the existing semantic verifier refused it.
    pub stage: &'static str,
    pub code: String,
}

/// The verified portable package, in the SAME bare-lowercase-hex convention the
/// trusted archive wire already uses. The `sha256-` prefix is a presentation
/// concern, applied in JS only where an outward contract requires it.
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub schema: &'static str,
    pub schema_version: u32,
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal: Option<Refusal>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_dir_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub construction_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_classification: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_shas: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_snapshot_byte_length: Option<u64>,
}

impl VerificationResult {
    fn refused(stage: &'static str, code: impl Into<String>) -> Self {
        Self {
            schema: VERIFICATION_SCHEMA,
            schema_version: VERIFICATION_SCHEMA_VERSION,
            verified: false,
            refusal: Some(Refusal {
                stage,
                code: code.into(),
            }),
            package_dir_name: None,
            chat_id: None,
            snapshot_id: None,
            content_hash: None,
            construction_family: None,
            name_classification: None,
            saved_at: None,
            asset_shas: None,
            logical_snapshot_byte_length: None,
        }
    }
}

// ── operations ─────────────────────────────────────────────────────────────

pub(crate) fn begin(
    registry: &Registry,
    basename: &str,
    unexpected_members: &[String],
) -> BeginResult {
    let refuse = |code| BeginResult {
        schema: VERIFICATION_SCHEMA,
        schema_version: VERIFICATION_SCHEMA_VERSION,
        ok: false,
        token: None,
        code: Some(code),
    };
    let begin_chat_id = match begin_chat_id_for(basename) {
        Ok(id) => id,
        Err(code) => return refuse(code),
    };
    if unexpected_members.len() > PORTABLE_MEMBER_COUNT_CAP {
        return refuse("portable-member-count-exceeded");
    }
    for name in unexpected_members {
        if name.is_empty() || name.len() > PORTABLE_MEMBER_PATH_CAP_BYTES {
            return refuse("portable-member-path-too-long");
        }
        if name.contains("..") || name.contains('\0') || name.starts_with('/') {
            return refuse("portable-member-path-unsafe");
        }
    }

    let mut map = registry.lock_map();
    Registry::sweep_idle(&mut map);
    // A live session is never evicted to admit another one.
    if map.len() >= MAX_ACTIVE_PORTABLE_SESSIONS {
        return refuse("portable-session-busy");
    }
    if Registry::aggregate_retained(&map) >= PORTABLE_AGGREGATE_RETAINED_CAP_BYTES {
        return refuse("portable-aggregate-cap-exceeded");
    }

    // A collision must never overwrite a live session; probe forward instead.
    let mut token = registry.next_token.fetch_add(1, Ordering::Relaxed) & TOKEN_MASK;
    let mut attempts = 0u32;
    while map.contains_key(&token) || token == 0 {
        token = registry.next_token.fetch_add(1, Ordering::Relaxed) & TOKEN_MASK;
        attempts += 1;
        if attempts > 64 {
            return refuse("portable-session-token-unavailable");
        }
    }

    map.insert(
        token,
        Arc::new(Session {
            basename: basename.to_string(),
            begin_chat_id,
            unexpected_members: unexpected_members.to_vec(),
            inner: Mutex::new(SessionInner {
                members: BTreeMap::new(),
                accumulated: 0,
                declared_assets: 0,
                touched_at: Instant::now(),
            }),
        }),
    );
    BeginResult {
        schema: VERIFICATION_SCHEMA,
        schema_version: VERIFICATION_SCHEMA_VERSION,
        ok: true,
        token: Some(token),
        code: None,
    }
}

pub(crate) fn declare(
    registry: &Registry,
    token: u64,
    member_key: &str,
    expected_length: u64,
) -> AckResult {
    let Some(session) = registry.get(token) else {
        return AckResult::refused("portable-session-unknown");
    };
    let key = match parse_member_key(member_key) {
        Ok(key) => key,
        Err(code) => return AckResult::refused(code),
    };
    let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.touched_at = Instant::now();

    // Exactly once. The duplicate is refused and accepts no bytes at all — it
    // does not replace, extend or reset the member already declared.
    if inner.members.contains_key(&key) {
        return AckResult::refused("portable-member-duplicate");
    }
    if inner.members.len() >= PORTABLE_MEMBER_COUNT_CAP {
        return AckResult::refused("portable-member-count-exceeded");
    }
    if matches!(key, MemberKey::Asset { .. }) && inner.declared_assets >= PORTABLE_ASSET_COUNT_CAP {
        return AckResult::refused("portable-asset-count-exceeded");
    }
    if expected_length > key.cap_bytes() {
        return AckResult::refused("portable-member-too-large");
    }
    // The declaration is charged against the package total, so a caller cannot
    // reserve 128 MiB across members and discover it only at finish.
    if inner.accumulated.saturating_add(expected_length) > PORTABLE_PACKAGE_TOTAL_CAP_BYTES {
        return AckResult::refused("portable-package-total-exceeded");
    }

    if matches!(key, MemberKey::Asset { .. }) {
        inner.declared_assets += 1;
    }
    inner.accumulated = inner.accumulated.saturating_add(expected_length);
    inner.members.insert(
        key,
        Member {
            expected_length,
            bytes: Vec::new(),
        },
    );
    AckResult::ok()
}

pub(crate) fn write(registry: &Registry, token: u64, member_key: &str, chunk: &[u8]) -> AckResult {
    let Some(session) = registry.get(token) else {
        return AckResult::refused("portable-session-unknown");
    };
    let key = match parse_member_key(member_key) {
        Ok(key) => key,
        Err(code) => return AckResult::refused(code),
    };
    if chunk.len() as u64 > CHUNK_CAP_BYTES {
        return AckResult::refused("portable-chunk-too-large");
    }
    let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.touched_at = Instant::now();

    let Some(member) = inner.members.get_mut(&key) else {
        return AckResult::refused("portable-member-undeclared");
    };
    // Sequential append only — there is no caller-supplied offset to disagree
    // with. Writing past the declared length, including any write after the
    // member is already complete, is the same overrun refusal.
    let next = member.bytes.len() as u64 + chunk.len() as u64;
    if next > member.expected_length {
        return AckResult::refused("portable-member-overrun");
    }
    member.bytes.extend_from_slice(chunk);
    AckResult::ok()
}

pub(crate) fn abort(registry: &Registry, token: u64) -> AckResult {
    // Idempotent: an already-absent token is a successful abort, so a client
    // `finally` can always call it without having to know what happened.
    registry.lock_map().remove(&token);
    AckResult::ok()
}

pub(crate) fn finish(registry: &Registry, token: u64) -> VerificationResult {
    // The session is destroyed unconditionally, verified or not.
    let Some(session) = registry.lock_map().remove(&token) else {
        return VerificationResult::refused("adapter", "portable-session-unknown");
    };
    let inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());

    for member in inner.members.values() {
        if member.bytes.len() as u64 != member.expected_length {
            return VerificationResult::refused("adapter", "portable-member-incomplete");
        }
    }
    let Some(manifest) = inner.members.get(&MemberKey::Manifest) else {
        return VerificationResult::refused("adapter", "portable-manifest-missing");
    };

    // Actual asset bytes are hashed HERE because the existing verifier adapter
    // input requires real member facts. The name's claimed hash is not reused:
    // if the two disagree, the verifier is what says so.
    let mut assets: Vec<VerifiedAssetMember> = Vec::new();
    for (key, member) in inner.members.iter() {
        if matches!(key, MemberKey::Asset { .. }) {
            assets.push(VerifiedAssetMember {
                path: key.package_path(),
                sha256: format!("sha256-{}", sha256_hex(&member.bytes)),
                byte_length: member.bytes.len() as u64,
            });
        }
    }
    assets.sort_by(|a, b| a.path.cmp(&b.path));

    let members = PackageMembers {
        manifest: &manifest.bytes,
        snapshot: inner
            .members
            .get(&MemberKey::Snapshot)
            .map(|m| m.bytes.as_slice()),
        markdown: inner
            .members
            .get(&MemberKey::Markdown)
            .map(|m| m.bytes.as_slice()),
        html: inner
            .members
            .get(&MemberKey::Html)
            .map(|m| m.bytes.as_slice()),
        assets: &assets,
        // Every DECLARED key is inside the canonical semantic inventory by
        // construction — an unknown key never got past `declare`. Members the
        // caller found outside that inventory are named at `begin` and reach
        // the verifier here, which refuses on a non-empty list.
        unexpected_members: &session.unexpected_members,
    };

    // Durable READ gate: a portable package may legitimately be any supported
    // family, independent of what this build is allowed to newly write.
    match verify_package(
        members,
        &session.begin_chat_id,
        VerificationAdmission::AllSupported,
    ) {
        Err(code) => VerificationResult::refused("verifier", code),
        Ok(semantics) => VerificationResult {
            schema: VERIFICATION_SCHEMA,
            schema_version: VERIFICATION_SCHEMA_VERSION,
            verified: true,
            refusal: None,
            package_dir_name: Some(session.basename.clone()),
            chat_id: Some(semantics.manifest.chat_id.clone()),
            snapshot_id: Some(semantics.manifest.snapshot_id.clone()),
            // Bare lowercase hex, matching the trusted archive wire.
            content_hash: Some(bare_hex(&semantics.content_hash)),
            construction_family: Some(format!("{:?}", semantics.family).to_lowercase()),
            name_classification: Some(match name_shape(&session.basename) {
                NameShape::Generation { .. } => "generation",
                _ => "legacy",
            }),
            saved_at: semantics.saved_at.clone(),
            asset_shas: Some(semantics.asset_shas.iter().map(|s| bare_hex(s)).collect()),
            logical_snapshot_byte_length: Some(semantics.logical_snapshot_byte_length),
        },
    }
}

fn bare_hex(value: &str) -> String {
    value.strip_prefix("sha256-").unwrap_or(value).to_string()
}

// ── commands ───────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginOptions {
    pub package_dir_name: String,
    #[serde(default)]
    pub unexpected_members: Vec<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclareOptions {
    pub token: u64,
    pub member: String,
    pub expected_length: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOptions {
    pub token: u64,
    pub member: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenOptions {
    pub token: u64,
}

#[tauri::command]
pub async fn h2o_saved_chat_portable_verify_begin(
    state: tauri::State<'_, PortableVerifyState>,
    options: BeginOptions,
) -> Result<BeginResult, String> {
    Ok(begin(
        &registry_for(&state),
        &options.package_dir_name,
        &options.unexpected_members,
    ))
}

#[tauri::command]
pub async fn h2o_saved_chat_portable_verify_declare(
    state: tauri::State<'_, PortableVerifyState>,
    options: DeclareOptions,
) -> Result<AckResult, String> {
    Ok(declare(
        &registry_for(&state),
        options.token,
        &options.member,
        options.expected_length,
    ))
}

#[tauri::command]
pub async fn h2o_saved_chat_portable_verify_write(
    state: tauri::State<'_, PortableVerifyState>,
    request: tauri::ipc::Request<'_>,
) -> Result<AckResult, String> {
    let options: WriteOptions = crate::archive_durable_write::required_options(&request)?;
    let chunk = crate::archive_durable_write::body_bytes(&request)?;
    Ok(write(
        &registry_for(&state),
        options.token,
        &options.member,
        &chunk,
    ))
}

#[tauri::command]
pub async fn h2o_saved_chat_portable_verify_finish(
    state: tauri::State<'_, PortableVerifyState>,
    options: TokenOptions,
) -> Result<VerificationResult, String> {
    Ok(finish(&registry_for(&state), options.token))
}

#[tauri::command]
pub async fn h2o_saved_chat_portable_verify_abort(
    state: tauri::State<'_, PortableVerifyState>,
    options: TokenOptions,
) -> Result<AckResult, String> {
    Ok(abort(&registry_for(&state), options.token))
}

#[cfg(test)]
mod tests;
