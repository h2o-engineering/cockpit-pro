//! Trusted staged publication of immutable Saved-Chat archive generations.
//!
//! Authority: `docs/systems/archive/saved-chat-generations.md` (M05 T1.1.1
//! freeze, as reconciled). This module implements §N/§N.2/§Q/§R/§S/§T/§V/§W/§X
//! and NOTHING ELSE. It does not widen the PRE-M05 CAS-scoped durable write; it
//! is a separate, purpose-bounded authority.
//!
//! WHAT THE RENDERER MAY NAME: a semantic `chatId`, a member ENUM, and bytes.
//! It never names a final destination, a member path, a package path, a CAS
//! source path, or an authoritative content hash. Every one of those is derived
//! on this side.
//!
//! THE PROTOCOL (§N):
//!
//! ```text
//! BEGIN {chatId}                        -> {token}
//! WRITE {token, member} + bounded chunk  (repeatable; members may interleave)
//! COMMIT {token, expectedManifestSha256?}
//! ABORT {token}
//! ```
//!
//! `manifest` is a staged member like every other member, so it is verified
//! through the same descriptor-relative `O_NOFOLLOW` path. COMMIT carries no
//! large body.
//!
//! STAGING INTEGRITY (§R.1): retained descriptors plus commit-time re-read and
//! re-hash close substitution, unexpected entries and path re-resolution. They
//! do NOT close post-hash in-place mutation through a separately held writable
//! handle — an inode can be verified, mutated, and carried into the published
//! generation by the rename with its identity unchanged. What closes that,
//! pre-cutover, is that staging lives under a literal dot-leading component
//! which the renderer's `archive/**` grant does not reach through
//! (`require_literal_leading_dot`). The token is a session identifier, never an
//! authorization boundary.
//!
//! PLATFORM SUPPORT: publication requires create-only promotion of a
//! DIRECTORY. `linkat` cannot hard-link a directory, so every arm without an
//! exclusive directory rename fails closed rather than degrading to a
//! replacing rename.

#![cfg(unix)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::archive_durable_write::{confined, sha256_hex, ARCHIVE_ROOT};
use crate::saved_chat_generation_policy::{
    production_live_generation_family, LiveGenerationFamily,
};
pub(crate) use crate::saved_chat_package_verify::ValidatedManifest;
use crate::saved_chat_package_verify::{
    self, PackageFamily, PackageMembers, SnapshotEncoding, VerificationAdmission,
    VerifiedAssetMember, VerifiedPackageSemantics,
};

pub const GENERATION_PUBLISH_SCHEMA: &str = "h2o.studio.archive.generation-publish.v1";

/// Package directory under the archive root.
const PACKAGES_DIR: &str = "packages";

/// Literal dot-leading reserved staging component (§R). Load-bearing: the
/// leading `.` is what the renderer's glob scope does not reach through.
///
/// Re-exported from the durable-write module's shared reserved-prefix
/// authority so exactly one literal exists and the reservation cannot drift
/// from the name this module actually creates.
pub(crate) use crate::archive_durable_write::GENERATION_STAGING_PREFIX as STAGING_PREFIX;

/// Transport/allocation bound for ONE chunk (§"Member bounds"). This is NOT a
/// member ceiling: a member of any size arrives as N chunks. It bounds a
/// cooperative writer's peak; the framework materializes an invoke body before
/// the command runs, so it is not admission control against a hostile caller.
pub const CHUNK_CAP_BYTES: u64 = 8 * 1024 * 1024;

/// Concurrently admitted sessions. Bounds concurrent OPERATIONS, never bytes —
/// a large valid package still publishes (§R.2-A).
pub(crate) const MAX_ADMITTED_SESSIONS: usize = 4;

/// Idle period after which an abandoned session may be evicted. Operational
/// constant, not a product value (§Q).
pub(crate) const SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// OPERATIONAL RESOURCE POLICY (§R.2), not package format authority and not a
/// package-size limit. Refusing to consume the last of the disk keeps the
/// machine recoverable; it never participates in package verification and is
/// never persisted.
const FREE_SPACE_RESERVE_BYTES: u64 = 64 * 1024 * 1024;

const STAGING_NAME_ATTEMPTS: u32 = 8;

/// Fixed streaming window. Bounds working memory for member and CAS reads so
/// nothing is proportional to member size (§W, "Member bounds"). Not a member
/// or package ceiling.
pub(crate) const STREAM_WINDOW_BYTES: usize = 256 * 1024;

/// Test-only seam forcing the post-promotion parent fence to report failure,
/// so the frozen "promotion is the commit point" rule is provable. Production
/// builds do not compile this: `parent_fence` is then exactly `dir.sync()`.
// THREAD-LOCAL, not process-global: cargo runs tests in parallel threads, so a
// global override would leak into unrelated tests.
#[cfg(test)]
thread_local! {
    pub(crate) static FORCE_FENCE_FAILURE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

/// The parent-directory durability fence.
fn parent_fence(dir: &confined::Dir) -> bool {
    #[cfg(test)]
    if FORCE_FENCE_FAILURE.with(|f| f.get()) {
        return false;
    }
    dir.sync().is_ok()
}

/// Seeds the per-process token counter from OS entropy.
///
/// §R freezes the token as "opaque, high-entropy". It is NOT an authorization
/// boundary — but a counter that restarts at 1 every launch would replay the
/// same staging names, and since M05 ships no reclamation an abandoned-then-
/// quit session leaves residue that would deterministically collide with the
/// first BEGIN of every subsequent launch and eventually wedge it. The sibling
/// durable-write module mitigates the same hazard by mixing in the pid.
pub(crate) fn random_token_seed() -> u64 {
    let mut buf = [0u8; 8];
    // getentropy(2) is available on macOS and Linux; on failure fall back to a
    // process/time mix, which is weaker but still non-replaying.
    let rc = unsafe { libc::getentropy(buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    if rc == 0 {
        return u64::from_ne_bytes(buf) | 1;
    }
    let pid = std::process::id() as u64;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    (pid.rotate_left(32) ^ nanos) | 1
}

// ── Members ────────────────────────────────────────────────────────────────

/// The closed set of renderer-nameable members. The renderer supplies this
/// ENUM; the filename is derived here and never crosses IPC.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Member {
    Snapshot,
    Markdown,
    Html,
    Manifest,
}

impl Member {
    pub fn file_name(self) -> &'static str {
        match self {
            Member::Snapshot => "snapshot.json",
            Member::Markdown => "chat.md",
            Member::Html => "chat.html",
            Member::Manifest => "manifest.json",
        }
    }

    /// The `manifest.files` descriptor key for this member, if it has one.
    /// `manifest.json` deliberately does not describe itself.
    fn descriptor_key(self) -> Option<&'static str> {
        match self {
            Member::Snapshot => Some("snapshot"),
            Member::Markdown => Some("markdown"),
            Member::Html => Some("html"),
            Member::Manifest => None,
        }
    }

    fn all() -> [Member; 4] {
        [
            Member::Snapshot,
            Member::Markdown,
            Member::Html,
            Member::Manifest,
        ]
    }
}

// ── Results ────────────────────────────────────────────────────────────────

/// The trusted verdict. `outcome` is the SOLE success discriminator (§N.2):
/// `Created` and `Deduped` are successes, everything else is a failure.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Created,
    Deduped,
    GenerationDestinationCorrupt,
    GenerationPartial,
    GenerationDestinationForeign,
    GenerationOccupantUnreadable,
    Refused,
}

impl Outcome {
    fn is_success(self) -> bool {
        matches!(self, Outcome::Created | Outcome::Deduped)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub code: String,
}

impl Blocker {
    fn new(code: impl Into<String>) -> Self {
        Blocker { code: code.into() }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishResult {
    pub schema: &'static str,
    pub ok: bool,
    /// Whether THIS attempt promoted. False for `Deduped` — a success that
    /// deliberately wrote nothing.
    pub committed: bool,
    pub durability_complete: bool,
    pub outcome: Outcome,
    pub generation_path: String,
    pub content_hash: String,
    pub blockers: Vec<Blocker>,
    /// NON-BLOCKING observations (batch repair R4). Never affects `ok`, `committed` or
    /// `durability_complete`, and never enters `blockers`. Present so a
    /// degraded-but-valid occupant is observable to Archive Health / M06
    /// repair UX instead of being silently accepted.
    pub advisories: Vec<Blocker>,
}

impl PublishResult {
    fn refused(code: &str) -> Self {
        PublishResult {
            schema: GENERATION_PUBLISH_SCHEMA,
            ok: false,
            committed: false,
            durability_complete: false,
            outcome: Outcome::Refused,
            generation_path: String::new(),
            content_hash: String::new(),
            blockers: vec![Blocker::new(code)],
            advisories: Vec::new(),
        }
    }

    fn occupied(outcome: Outcome, code: &str, path: String, hash: String) -> Self {
        PublishResult {
            schema: GENERATION_PUBLISH_SCHEMA,
            ok: outcome.is_success(),
            committed: false,
            durability_complete: false,
            outcome,
            generation_path: path,
            content_hash: hash,
            blockers: if outcome.is_success() {
                Vec::new()
            } else {
                vec![Blocker::new(code)]
            },
            advisories: Vec::new(),
        }
    }
}

/// TRANSPORT ENCODING ONLY for the opaque generation-session token.
///
/// The session token is a full-range u64 and stays one everywhere inside this
/// module: the session map, the lease and the staging name are unchanged. But
/// JSON numbers are IEEE-754 doubles in the WebView, so any token above
/// 2^53-1 -- about 99.95% of the u64 space -- came back from JavaScript as a
/// DIFFERENT integer and matched no session, which is why write_member was
/// refused with `generation-session-unknown` even though begin had succeeded.
///
/// So the token crosses the IPC boundary as decimal text and is parsed back to
/// the exact u64 here. Callers must treat it as opaque: it is an identifier,
/// never a number to compute with.
pub(crate) mod ipc_token {
    use serde::de::{Error as DeError, Unexpected, Visitor};
    use serde::{Deserializer, Serializer};
    use std::fmt;

    pub fn serialize<S: Serializer>(token: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&token.to_string())
    }

    struct TokenVisitor;

    impl<'de> Visitor<'de> for TokenVisitor {
        type Value = u64;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("an opaque generation-session token as decimal text")
        }

        /// Deliberately the ONLY accepted form. There is no `visit_u64`, so a
        /// JSON number is refused rather than silently accepted from a caller
        /// that already lost precision producing it.
        fn visit_str<E: DeError>(self, value: &str) -> Result<u64, E> {
            if value.is_empty() {
                return Err(E::custom("generation-session-token-empty"));
            }
            if !value.bytes().all(|b| b.is_ascii_digit()) {
                return Err(E::invalid_value(
                    Unexpected::Str(value),
                    &"decimal digits only (no sign, space or radix prefix)",
                ));
            }
            value
                .parse::<u64>()
                .map_err(|_| E::custom("generation-session-token-out-of-range"))
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        deserializer.deserialize_str(TokenVisitor)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginResult {
    pub schema: &'static str,
    pub ok: bool,
    /// Opaque to callers; see `ipc_token` for why it is transported as text.
    #[serde(serialize_with = "ipc_token::serialize")]
    pub token: u64,
    pub blockers: Vec<Blocker>,
}

impl BeginResult {
    fn refused(code: &str) -> Self {
        BeginResult {
            schema: GENERATION_PUBLISH_SCHEMA,
            ok: false,
            token: 0,
            blockers: vec![Blocker::new(code)],
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AckResult {
    pub schema: &'static str,
    pub ok: bool,
    pub blockers: Vec<Blocker>,
}

impl AckResult {
    fn ok() -> Self {
        AckResult {
            schema: GENERATION_PUBLISH_SCHEMA,
            ok: true,
            blockers: Vec::new(),
        }
    }
    fn refused(code: &str) -> Self {
        AckResult {
            schema: GENERATION_PUBLISH_SCHEMA,
            ok: false,
            blockers: vec![Blocker::new(code)],
        }
    }
}

// ── chatId validation (§B, §O) ─────────────────────────────────────────────

/// The trusted side re-validates the renderer's `chatId` against the frozen
/// charset before ANY path construction. The renderer's string is an input to
/// validation, never a path fragment taken on trust.
pub(crate) fn validated_chat_id(chat_id: &str) -> Result<&str, &'static str> {
    if chat_id.is_empty() {
        return Err("generation-chat-id-empty");
    }
    if chat_id == "." || chat_id == ".." {
        return Err("generation-chat-id-reserved");
    }
    // A generation basename BEGINS with the chatId, so a dot-leading chatId
    // derives a dot-leading final name — which the frozen architecture has
    // already made unusable, in two independent ways:
    //
    //   1. §R.1's load-bearing matcher rule. The renderer's read scopes are
    //      `$APPLOCALDATA/archive/**`, and the pinned glob applies
    //      require_literal_leading_dot, so a wildcard does not match through a
    //      dot-leading component. That is exactly what protects staging — and
    //      it equally blocks READS. Every JS consumer (verifier, inspector,
    //      exporter, importer, restore, relink) reads through those scopes, so
    //      a dot-leading generation could never be verified, exported or
    //      restored by anything.
    //   2. §R's discovery reservation. A name under a reserved prefix is
    //      excluded from package inventory outright, so it would never be
    //      PRESERVED, COVERED or selectable.
    //
    // Publishing one would therefore create a write-only artifact that no
    // consumer can read and, for reserved prefixes, that nothing can even
    // enumerate — and create-only means the name could never be reclaimed.
    // Refusing is architecture-conformant, NOT a new chatId product boundary —
    // and the reason is stronger than grandfathering: the SAME scope rule also
    // governs `mkdir` and `write_file`, so a legacy `<chatId>.h2ochat` for a
    // dot-leading id was never writable or readable either. There is no
    // working predecessor capability to withdraw. Canonical product creation
    // does not mint dot-leading ids (they come from platform conversation
    // ids), and no committed fixture or evidence artifact contains one.
    if chat_id.starts_with('.') {
        return Err("generation-chat-id-reserved-namespace");
    }
    // Belt and braces, ASCII-case-insensitively: no chatId may carry a
    // reserved component prefix in any casing, even if a future prefix is
    // added without a leading dot.
    let lowered = chat_id.to_ascii_lowercase();
    if crate::archive_durable_write::RESERVED_COMPONENT_PREFIXES
        .iter()
        .any(|prefix| lowered.starts_with(&prefix.to_ascii_lowercase()))
        || crate::archive_durable_write::RESERVED_EXACT_COMPONENTS
            .iter()
            .any(|exact| lowered == exact.to_ascii_lowercase())
    {
        return Err("generation-chat-id-reserved-namespace");
    }
    if !chat_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
    {
        return Err("generation-chat-id-charset");
    }
    Ok(chat_id)
}

/// `<chatId>.g<64 lowercase hex>.h2ochat` — derived here, never supplied.
pub(crate) fn generation_basename(chat_id: &str, content_hash_hex: &str) -> String {
    format!("{chat_id}.g{content_hash_hex}.h2ochat")
}

/// Longest basename this chat could ever need, used at BEGIN to refuse early
/// rather than after a full staged upload.
fn max_generation_basename_len(chat_id: &str) -> usize {
    // 2 for ".g", 64 hex, 8 for ".h2ochat"
    chat_id.len() + 2 + 64 + 8
}

// ── Sessions (§Q) ──────────────────────────────────────────────────────────

struct MemberState {
    file: std::fs::File,
    len: u64,
}

struct SessionInner {
    /// `None` once the staging tree has been cleaned.
    dir: Option<confined::Dir>,
    staging_name: Vec<u8>,
    members: BTreeMap<Member, MemberState>,
    last_activity: Instant,
    /// Set when ABORT or eviction claimed termination while work was active.
    terminating: bool,
}

struct Session {
    chat_id: String,
    /// Per-session operation lease. Member I/O runs under THIS, never under the
    /// global map lock (§Q).
    inner: Mutex<SessionInner>,
}

/// Registry of admitted sessions.
///
/// `admitted` counts sessions in the map PLUS in-flight COMMITs. A committing
/// session is removed from the map before publication work (property 6), so
/// without this separate counter the cap would bound only idle sessions and
/// §R.2's required "bounded number of simultaneous sessions" would be vacuous.
pub struct Registry {
    map: Mutex<BTreeMap<u64, Arc<Session>>>,
    admitted: Mutex<usize>,
    next_token: AtomicU64,
}

impl Default for Registry {
    fn default() -> Self {
        Registry {
            map: Mutex::new(BTreeMap::new()),
            admitted: Mutex::new(0),
            next_token: AtomicU64::new(random_token_seed()),
        }
    }
}

impl Registry {
    /// Number of admitted sessions, INCLUDING in-flight commits. M06 T1.1
    /// exposes this so a future reclamation preflight can require an empty
    /// registry (contract §D). Read-only: it admits, evicts and mutates
    /// nothing.
    pub fn admitted_len(&self) -> usize {
        self.admitted.lock().map(|n| *n).unwrap_or(usize::MAX)
    }

    pub fn new() -> Self {
        Registry::default()
    }

    fn lock_map(&self) -> MutexGuard<'_, BTreeMap<u64, Arc<Session>>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(test)]
    fn admitted_count(&self) -> usize {
        *self.admitted.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn release_slot(&self) {
        let mut n = self.admitted.lock().unwrap_or_else(|e| e.into_inner());
        *n = n.saturating_sub(1);
    }

    #[cfg(test)]
    fn session_count(&self) -> usize {
        self.lock_map().len()
    }
}

/// Publisher context. Tests construct their own so the global registry is never
/// shared across cases.
pub struct Publisher {
    root: std::path::PathBuf,
    registry: Registry,
}

impl Publisher {
    /// `root` is the archive root (`…/archive`).
    pub fn new(root: impl Into<std::path::PathBuf>) -> Self {
        Publisher {
            root: root.into(),
            registry: Registry::new(),
        }
    }

    /// True when no session is admitted and no commit is in flight. Reserved
    /// for the future reclamation preflight; nothing in T1.1 reclaims.
    pub fn sessions_empty(&self) -> bool {
        self.registry.admitted_len() == 0
    }

    fn packages_dir(&self) -> Result<confined::Dir, String> {
        // The trusted publisher creates `archive/` and `archive/packages/`
        // itself, descriptor-relatively, pairing mkdir with an O_NOFOLLOW open
        // (§R). Post-cutover nothing renderer-side creates any archive dir.
        let archive = confined::Dir::open_root(&self.root)
            .map_err(|err| format!("generation-archive-root-open-failed:{err}"))?;
        let name = PACKAGES_DIR.as_bytes();
        archive
            .mkdir_child(name)
            .map_err(|err| format!("generation-packages-create-failed:{err}"))?;
        archive
            .open_child_nofollow(name)
            .map_err(|err| format!("generation-packages-open-failed:{err}"))
    }
}

// ── Free-space (§R.2 environmental, NOT package validity) ───────────────────

/// Test-only free-space override. `REAL` defers to the filesystem;
/// `UNANSWERABLE` simulates a failed `fstatfs`; any other value is reported as
/// the available byte count. Production builds do not compile this.
#[cfg(test)]
thread_local! {
    pub(crate) static FORCE_FREE_SPACE: std::cell::Cell<u64> =
        const { std::cell::Cell::new(FREE_SPACE_REAL) };
}
#[cfg(test)]
pub(crate) const FREE_SPACE_REAL: u64 = u64::MAX;
#[cfg(test)]
pub(crate) const FREE_SPACE_UNANSWERABLE: u64 = u64::MAX - 1;

/// Available bytes on the filesystem holding `dir`. `None` when unanswerable.
fn available_bytes(dir: &confined::Dir) -> Option<u64> {
    #[cfg(test)]
    {
        let forced = FORCE_FREE_SPACE.with(|f| f.get());
        if forced == FREE_SPACE_UNANSWERABLE {
            return None;
        }
        if forced != FREE_SPACE_REAL {
            return Some(forced);
        }
    }
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::fstatfs(dir.as_raw_fd(), &mut st) };
    if rc < 0 {
        return None;
    }
    (st.f_bavail as u64).checked_mul(st.f_bsize as u64)
}

/// Admits one append against the operational free-space reserve, on the ACTUAL
/// staging filesystem, immediately before extending a staged member.
///
/// Checking only at BEGIN cannot preserve a reserve across a long multi-chunk
/// member: a member arrives as N appends, and the disk can fill between the
/// first and the last. This runs per append.
///
/// FAIL CLOSED: if free-space authority is unanswerable we refuse rather than
/// proceed, because an unanswerable reserve is exactly the condition the
/// reserve exists to protect against. The refusal is environmental and
/// retryable — never a package-validity blocker — and imposes NO ceiling on
/// member or package size: an arbitrarily large member publishes fine on a
/// filesystem that actually has the room.
fn admit_append(dir: &confined::Dir, incoming: u64) -> Result<(), String> {
    let free = match available_bytes(dir) {
        Some(free) => free,
        None => return Err("generation-staging-resource-unavailable".to_string()),
    };
    let needed = incoming
        .checked_add(FREE_SPACE_RESERVE_BYTES)
        .ok_or_else(|| "generation-staging-resource-overflow".to_string())?;
    if free < needed {
        return Err("generation-staging-resource-reserve".to_string());
    }
    Ok(())
}

/// Environmental refusals are retryable and machine-local. They NEVER mark a
/// package structurally invalid (§R.2-B).
fn is_resource_errno(err: &std::io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(libc::ENOSPC) | Some(libc::EDQUOT) | Some(libc::EFBIG)
    )
}

fn resource_code(err: &std::io::Error) -> String {
    match err.raw_os_error() {
        Some(libc::ENOSPC) => "generation-staging-resource-no-space".to_string(),
        Some(libc::EDQUOT) => "generation-staging-resource-quota".to_string(),
        Some(libc::EFBIG) => "generation-staging-resource-file-too-large".to_string(),
        _ => "generation-staging-resource-unavailable".to_string(),
    }
}

// ── BEGIN (§D) ─────────────────────────────────────────────────────────────

fn staging_name(token: u64, attempt: u32) -> Vec<u8> {
    format!("{STAGING_PREFIX}{token:016x}{attempt:02x}").into_bytes()
}

pub fn begin(publisher: &Publisher, chat_id: &str) -> BeginResult {
    let chat_id = match validated_chat_id(chat_id) {
        Ok(value) => value.to_string(),
        Err(code) => return BeginResult::refused(code),
    };

    let packages = match publisher.packages_dir() {
        Ok(dir) => dir,
        Err(_) => return BeginResult::refused("generation-packages-unavailable"),
    };

    // NAME_MAX from the opened parent descriptor; fail closed when unanswerable
    // (§"Member bounds"). No hardcoded 240/255.
    let name_max = match packages.name_max() {
        Ok(value) => value,
        Err(_) => return BeginResult::refused("generation-name-max-indeterminate"),
    };
    if max_generation_basename_len(&chat_id) as u64 > name_max {
        return BeginResult::refused("generation-name-exceeds-filesystem-limit");
    }

    // Admission: reap idle sessions under the same claim, then refuse if full.
    // Lazy — no timer thread (§Q).
    let token = {
        let mut admitted = publisher
            .registry
            .admitted
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        reap_idle(publisher, &mut admitted);
        if *admitted >= MAX_ADMITTED_SESSIONS {
            return BeginResult::refused("generation-staging-sessions-exhausted");
        }
        *admitted += 1;
        publisher.registry.next_token.fetch_add(1, Ordering::SeqCst)
    };

    // Creator-owns-cleanup (§X): from here on, every refusal path removes what
    // it created before returning. A refused BEGIN is not a residue source.
    if let Err(code) = admit_append(&packages, 0) {
        publisher.registry.release_slot();
        return BeginResult::refused(&code);
    }

    let mut created: Option<(Vec<u8>, confined::Dir)> = None;
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..STAGING_NAME_ATTEMPTS {
        let name = staging_name(token, attempt);
        match packages.mkdir_child_exclusive(&name) {
            Ok(()) => match packages.open_child_nofollow(&name) {
                Ok(dir) => {
                    created = Some((name, dir));
                    break;
                }
                Err(err) => {
                    // Own it: remove what we just created before returning.
                    let _ = packages.unlink_child_dir(&name);
                    last_err = Some(err);
                    break;
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                last_err = Some(err);
                break;
            }
        }
    }

    let (name, dir) = match created {
        Some(value) => value,
        None => {
            publisher.registry.release_slot();
            let code = match last_err {
                Some(ref err) if is_resource_errno(err) => resource_code(err),
                _ => "generation-staging-create-failed".to_string(),
            };
            return BeginResult::refused(&code);
        }
    };

    let session = Arc::new(Session {
        chat_id,
        inner: Mutex::new(SessionInner {
            dir: Some(dir),
            staging_name: name,
            members: BTreeMap::new(),
            last_activity: Instant::now(),
            terminating: false,
        }),
    });
    publisher.registry.lock_map().insert(token, session);

    BeginResult {
        schema: GENERATION_PUBLISH_SCHEMA,
        ok: true,
        token,
        blockers: Vec::new(),
    }
}

/// Lazily evicts sessions idle past the timeout. Runs under the admission
/// claim at BEGIN. Only reaches sessions that are in the map (so never a
/// COMMITTING one) and that are not actively holding their lease (so never
/// beneath an in-flight WRITE) — properties 4, 7 and 8.
fn reap_idle(publisher: &Publisher, admitted: &mut usize) {
    let now = Instant::now();
    let candidates: Vec<(u64, Arc<Session>)> = {
        let map = publisher.registry.lock_map();
        map.iter()
            .filter_map(|(token, session)| {
                // try_lock: an active WRITE holds this, and an active session is
                // never idle. Failing to acquire simply means "busy, skip".
                let inner = session.inner.try_lock().ok()?;
                if now.duration_since(inner.last_activity) >= SESSION_IDLE_TIMEOUT {
                    Some((*token, Arc::clone(session)))
                } else {
                    None
                }
            })
            .collect()
    };
    for (token, session) in candidates {
        // Exactly one claimant: whoever removes it from the map owns cleanup.
        let claimed = publisher.registry.lock_map().remove(&token).is_some();
        if !claimed {
            continue;
        }
        let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
        cleanup_staging(publisher, &mut inner);
        *admitted = admitted.saturating_sub(1);
    }
}

// ── Cleanup (§X) ───────────────────────────────────────────────────────────

/// Removes ONLY what this attempt owns: the members it created and its own
/// staging directory. Never a readdir-driven sweep over arbitrary content.
/// Returns false when residue remains, which the caller reports honestly.
fn cleanup_staging(publisher: &Publisher, inner: &mut SessionInner) -> bool {
    let dir = match inner.dir.take() {
        Some(dir) => dir,
        None => return true, // already cleaned
    };
    // Drop file handles before unlinking.
    inner.members.clear();
    let mut clean = true;
    // Remove the CLOSED member set this attempt could have created. Deliberately
    // not driven by the tracked-handle map: COMMIT clears that map early to drop
    // handles before verification, so a refusal after that point would otherwise
    // leave every member behind and the staging rmdir would fail ENOTEMPTY.
    // This is still "only what this attempt owns" — the unexpected-entry gate
    // proves no other name can be present — and never a readdir-driven sweep.
    for member in Member::all() {
        if let Err(err) = dir.unlink_child(member.file_name().as_bytes()) {
            if err.kind() != std::io::ErrorKind::NotFound {
                clean = false;
            }
        }
    }
    // The assets/ child, when this attempt created it.
    if let Ok(assets) = dir.open_child_nofollow(b"assets") {
        if let Ok(names) = assets.read_entry_names() {
            for name in names {
                if assets.unlink_child(&name).is_err() {
                    clean = false;
                }
            }
        }
        drop(assets);
        if dir.unlink_child_dir(b"assets").is_err() {
            clean = false;
        }
    }
    drop(dir);
    if let Ok(packages) = publisher.packages_dir() {
        if let Err(err) = packages.unlink_child_dir(&inner.staging_name) {
            if err.kind() != std::io::ErrorKind::NotFound {
                clean = false;
            }
        }
    } else {
        clean = false;
    }
    clean
}

// ── WRITE MEMBER (§E) ──────────────────────────────────────────────────────

pub fn write_member(publisher: &Publisher, token: u64, member: Member, chunk: &[u8]) -> AckResult {
    if chunk.len() as u64 > CHUNK_CAP_BYTES {
        return AckResult::refused("generation-chunk-too-large");
    }
    let session = match publisher.registry.lock_map().get(&token) {
        Some(session) => Arc::clone(session),
        None => return AckResult::refused("generation-session-unknown"),
    };
    // Acquire the per-session lease BEFORE any staging I/O (property 3). The
    // global map lock is NOT held across this.
    let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
    // Operation ENTRY refreshes idle time (property 5), so a long write cannot
    // age into eviction while running.
    inner.last_activity = Instant::now();
    if inner.terminating {
        return AckResult::refused("generation-session-terminating");
    }
    let dir = match inner.dir.as_ref() {
        Some(dir) => dir,
        None => return AckResult::refused("generation-session-consumed"),
    };

    // §R.2: preserve the operational reserve for THIS append, on the actual
    // staging filesystem, before creating or extending the member.
    if let Err(code) = admit_append(dir, chunk.len() as u64) {
        return AckResult::refused(&code);
    }

    if !inner.members.contains_key(&member) {
        match dir.create_new_child(member.file_name().as_bytes()) {
            Ok(file) => {
                inner.members.insert(member, MemberState { file, len: 0 });
            }
            Err(err) if is_resource_errno(&err) => {
                return AckResult::refused(&resource_code(&err));
            }
            Err(_) => return AckResult::refused("generation-member-create-failed"),
        }
    }

    let state = inner
        .members
        .get_mut(&member)
        .expect("member state inserted above");
    // Overflow-safe accounting (§R.2).
    let next_len = match state.len.checked_add(chunk.len() as u64) {
        Some(value) => value,
        None => return AckResult::refused("generation-staging-resource-overflow"),
    };
    if let Err(err) = state.file.write_all(chunk) {
        if is_resource_errno(&err) {
            return AckResult::refused(&resource_code(&err));
        }
        return AckResult::refused("generation-member-write-failed");
    }
    state.len = next_len;
    AckResult::ok()
}

// ── ABORT ──────────────────────────────────────────────────────────────────

/// Benign no-op on an unknown or already-consumed token. If work is active, the
/// session is marked terminating and cleanup runs when the last lease is
/// released (property 10).
pub fn abort(publisher: &Publisher, token: u64) -> AckResult {
    let session = match publisher.registry.lock_map().remove(&token) {
        Some(session) => session,
        None => return AckResult::ok(),
    };
    publisher.registry.release_slot();
    let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.terminating = true;
    if cleanup_staging(publisher, &mut inner) {
        AckResult::ok()
    } else {
        AckResult::refused("generation-staging-cleanup-incomplete")
    }
}

// ── Identity (§L, §T) ──────────────────────────────────────────────────────

#[cfg(test)]
fn v2_content_pre_image(snapshot_sha: &str, sorted_asset_shas: &[String]) -> String {
    saved_chat_package_verify::v2_content_pre_image(snapshot_sha, sorted_asset_shas)
}

/// Test-only access to the identity derivation, so a T2.1 fixture can build a
/// coherent v2 manifest with the REAL algorithm instead of restating it.
#[cfg(test)]
pub(crate) fn derive_content_hash_for_test(
    payload_v2: bool,
    snapshot_bytes: &[u8],
    sorted_asset_shas: &[String],
) -> String {
    saved_chat_package_verify::derive_content_hash_v1_v2(
        payload_v2,
        snapshot_bytes,
        sorted_asset_shas,
    )
}

/// Derives the package content hash from the STAGED BYTES.
///
/// v1: SHA-256 of the exact staged `snapshot.json` bytes. The bytes are never
/// parsed and reserialized to compute identity.
/// v2: SHA-256 of the frozen two-key descriptor above.
fn derive_content_hash(
    payload_v2: bool,
    snapshot_bytes: &[u8],
    sorted_asset_shas: &[String],
) -> String {
    saved_chat_package_verify::derive_content_hash_v1_v2(
        payload_v2,
        snapshot_bytes,
        sorted_asset_shas,
    )
}

// ── Manifest validation (§S, §V) ───────────────────────────────────────────

/// Validates the staged manifest. Every refusal here corresponds to a governed
/// v1/v2 verifier blocker (§S), so nothing this gate admits can fail the reader
/// — except the RESIDUAL class, which is deliberately NOT enforced.
#[cfg(test)]
fn validate_manifest(bytes: &[u8]) -> Result<ValidatedManifest, &'static str> {
    saved_chat_package_verify::validate_manifest(bytes, VerificationAdmission::V1V2Only)
}

fn write_admission(family: LiveGenerationFamily) -> VerificationAdmission {
    match family {
        LiveGenerationFamily::V1V2 => VerificationAdmission::V1V2Only,
        LiveGenerationFamily::V3 => VerificationAdmission::V3Only,
    }
}

/// Cross-checks the staged snapshot against the manifest (§S).
fn validate_snapshot_cross_binding(
    snapshot_bytes: &[u8],
    manifest: &ValidatedManifest,
    begin_chat_id: &str,
) -> Result<(), &'static str> {
    saved_chat_package_verify::validate_snapshot_cross_binding(
        snapshot_bytes,
        manifest,
        begin_chat_id,
    )
    .map(|_| ())
}

// ── COMMIT (§G, §N) ────────────────────────────────────────────────────────

fn read_staged_member(dir: &confined::Dir, member: Member) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let name = member.file_name().as_bytes();
    let st = dir
        .stat_child_nofollow(name)
        .map_err(|err| format!("generation-member-stat-failed:{err}"))?
        .ok_or_else(|| "generation-member-missing".to_string())?;
    if !confined::is_regular(&st) {
        return Err("generation-member-not-regular".to_string());
    }
    let mut file = dir
        .open_child_read_nofollow(name)
        .map_err(|err| format!("generation-member-open-failed:{err}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|err| format!("generation-member-read-failed:{err}"))?;
    Ok(buf)
}

/// Bounded variant for v3 snapshot bytes. The descriptor-relative metadata
/// check prevents an oversized member from being allocated before the shared
/// verifier enforces its logical/physical descriptor contract; `take(cap + 1)`
/// closes growth after the metadata check.
fn read_staged_member_bounded(
    dir: &confined::Dir,
    member: Member,
    cap: u64,
) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let name = member.file_name().as_bytes();
    let st = dir
        .stat_child_nofollow(name)
        .map_err(|err| format!("generation-member-stat-failed:{err}"))?
        .ok_or_else(|| "generation-member-missing".to_string())?;
    if !confined::is_regular(&st) {
        return Err("generation-member-not-regular".to_string());
    }
    if st.st_size < 0 || st.st_size as u64 > cap {
        return Err("generation-member-read-bound-exceeded".to_string());
    }
    let file = dir
        .open_child_read_nofollow(name)
        .map_err(|err| format!("generation-member-open-failed:{err}"))?;
    let mut bounded = file.take(cap.saturating_add(1));
    let mut buf = Vec::with_capacity((st.st_size as u64).min(cap) as usize);
    bounded
        .read_to_end(&mut buf)
        .map_err(|err| format!("generation-member-read-failed:{err}"))?;
    if buf.len() as u64 > cap {
        return Err("generation-member-read-bound-exceeded".to_string());
    }
    Ok(buf)
}

/// Streams a child file, returning `(sha256_hex, byte_len)` without ever
/// holding the whole member in memory. §W freezes the copy as streaming with
/// incremental SHA-256, and "Member bounds" freezes chat.md/chat.html as
/// "streamed and hashed" — only `manifest.json` carries the buffered
/// exception.
fn hash_child(dir: &confined::Dir, name: &[u8]) -> Result<(String, u64), String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = dir
        .open_child_read_nofollow(name)
        .map_err(|err| format!("generation-member-open-failed:{err}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; STREAM_WINDOW_BYTES];
    let mut len: u64 = 0;
    loop {
        let read = file
            .read(&mut buf)
            .map_err(|err| format!("generation-member-read-failed:{err}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        len = len
            .checked_add(read as u64)
            .ok_or_else(|| "generation-staging-resource-overflow".to_string())?;
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest.iter() {
        hex.push_str(&format!("{byte:02x}"));
    }
    Ok((hex, len))
}

/// Streams a CAS object into a staged package member, hashing incrementally.
/// Returns the streamed `(sha256_hex, byte_len)` so the caller can compare
/// against the declared descriptor AFTER the bytes are written.
fn stream_cas_object_into(
    shard: &confined::Dir,
    source_name: &[u8],
    staged_assets: &confined::Dir,
    member_name: &[u8],
) -> Result<(String, u64), String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let st = shard
        .stat_child_nofollow(source_name)
        .map_err(|_| "generation-cas-stat-failed".to_string())?
        .ok_or_else(|| "generation-cas-object-missing".to_string())?;
    if !confined::is_regular(&st) {
        return Err("generation-cas-object-not-regular".to_string());
    }
    let mut src = shard
        .open_child_read_nofollow(source_name)
        .map_err(|_| "generation-cas-open-failed".to_string())?;
    let mut out = staged_assets.create_new_child(member_name).map_err(|err| {
        if is_resource_errno(&err) {
            resource_code(&err)
        } else {
            "generation-asset-stage-failed".to_string()
        }
    })?;

    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; STREAM_WINDOW_BYTES];
    let mut len: u64 = 0;
    loop {
        let read = src
            .read(&mut buf)
            .map_err(|_| "generation-cas-read-failed".to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
        // §R.2: an asset copy extends a staged member exactly like an append,
        // so it is admitted against the operational reserve per window rather
        // than being allowed to consume it wholesale. ENOSPC/EDQUOT below stay
        // as the backstop for a disk that fills underneath us.
        admit_append(staged_assets, read as u64)?;
        out.write_all(&buf[..read]).map_err(|err| {
            if is_resource_errno(&err) {
                resource_code(&err)
            } else {
                "generation-asset-write-failed".to_string()
            }
        })?;
        len = len
            .checked_add(read as u64)
            .ok_or_else(|| "generation-staging-resource-overflow".to_string())?;
    }
    crate::archive_durable_write::sync_file_contents(&out)
        .map_err(|_| "generation-asset-fsync-failed".to_string())?;
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest.iter() {
        hex.push_str(&format!("{byte:02x}"));
    }
    Ok((hex, len))
}

/// Copies the validated manifest's exact governed assets from canonical CAS
/// into this operation's private stage and returns facts established from the
/// bytes actually streamed. No caller path participates.
fn stage_manifest_assets(
    publisher: &Publisher,
    dir: &confined::Dir,
    manifest: &ValidatedManifest,
) -> Result<Vec<VerifiedAssetMember>, String> {
    if manifest.assets.is_empty() {
        return Ok(Vec::new());
    }
    let archive = confined::Dir::open_root(&publisher.root)
        .map_err(|_| "generation-archive-root-open-failed".to_string())?;
    let cas = archive
        .open_child_nofollow(b"assets")
        .map_err(|_| "generation-cas-unavailable".to_string())?;
    dir.mkdir_child_exclusive(b"assets")
        .map_err(|_| "generation-staging-assets-create-failed".to_string())?;
    let staged_assets = dir
        .open_child_nofollow(b"assets")
        .map_err(|_| "generation-staging-assets-open-failed".to_string())?;
    let mut facts = Vec::with_capacity(manifest.assets.len());
    for asset in &manifest.assets {
        let (shard, basename) = cas_relative_parts(&asset.sha256);
        let shard_dir = cas
            .open_child_nofollow(shard.as_bytes())
            .map_err(|_| "generation-cas-object-missing".to_string())?;
        let member_name = format!("{}.{}", asset.sha256, asset.ext);
        let (hex, len) = stream_cas_object_into(
            &shard_dir,
            basename.as_bytes(),
            &staged_assets,
            member_name.as_bytes(),
        )?;
        let sha256 = format!("sha256-{hex}");
        if len != asset.byte_length {
            return Err("generation-asset-byte-length-mismatch".to_string());
        }
        if sha256 != asset.sha256 {
            return Err("generation-asset-sha-mismatch".to_string());
        }
        facts.push(VerifiedAssetMember {
            path: asset.path.clone(),
            sha256,
            byte_length: len,
        });
    }
    staged_assets
        .sync()
        .map_err(|_| "generation-staging-assets-fsync-failed".to_string())?;
    Ok(facts)
}

/// CAS object location, derived HERE from the validated identity. The renderer
/// supplies no CAS source path (§W).
pub(crate) fn cas_relative_parts(sha: &str) -> (String, String) {
    let hex = sha.strip_prefix("sha256-").unwrap_or(sha);
    (hex[0..2].to_string(), format!("sha256-{hex}"))
}

pub fn commit(
    publisher: &Publisher,
    token: u64,
    expected_manifest_sha256: Option<&str>,
) -> PublishResult {
    commit_with_policy(
        publisher,
        token,
        expected_manifest_sha256,
        production_live_generation_family(),
    )
}

/// Private policy seam for native tests and later activation wiring. The Tauri
/// command never accepts a family from the renderer; it calls `commit` above,
/// which obtains the immutable production policy internally.
pub(crate) fn commit_with_policy(
    publisher: &Publisher,
    token: u64,
    expected_manifest_sha256: Option<&str>,
    family: LiveGenerationFamily,
) -> PublishResult {
    // Property 6: take exclusive ownership and CONSUME the session before any
    // publication work. A committing session is not in the map, so no eviction
    // or abort can reach it; its admission slot is released only when we return.
    let session = match publisher.registry.lock_map().remove(&token) {
        Some(session) => session,
        None => return PublishResult::refused("generation-session-unknown"),
    };
    let result = commit_consumed(publisher, &session, expected_manifest_sha256, family);
    publisher.registry.release_slot();
    result
}

fn commit_consumed(
    publisher: &Publisher,
    session: &Arc<Session>,
    expected_manifest_sha256: Option<&str>,
    family: LiveGenerationFamily,
) -> PublishResult {
    let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.last_activity = Instant::now();

    // Take ownership of the staging descriptor for the duration of commit, so
    // `inner` stays free for the cleanup path. `held` is put back before any
    // refusal so cleanup removes exactly what this attempt owns (§X).
    let mut held = match inner.dir.take() {
        Some(dir) => Some(dir),
        None => return PublishResult::refused("generation-session-consumed"),
    };

    // Every refusal cleans this attempt's staging before returning.
    macro_rules! refuse {
        ($code:expr) => {{
            inner.dir = held.take();
            let clean = cleanup_staging(publisher, &mut inner);
            let mut out = PublishResult::refused($code);
            if !clean {
                out.blockers
                    .push(Blocker::new("generation-staging-cleanup-incomplete"));
            }
            return out;
        }};
    }

    // Flush and drop member handles so the bytes verified are the bytes on disk.
    {
        let mut flush_failed = false;
        for state in inner.members.values_mut() {
            if state.file.flush().is_err() {
                flush_failed = true;
            }
        }
        inner.members.clear();
        if flush_failed {
            refuse!("generation-member-flush-failed");
        }
    }

    let dir = held.as_ref().expect("held above");

    // Enumerate now, then interpret the exact allowed set only after the
    // policy-gated manifest establishes the construction family.
    let entries = match dir.read_entry_names() {
        Ok(entries) => entries,
        Err(_) => refuse!("generation-staging-enumerate-failed"),
    };
    let manifest_bytes = match read_staged_member(dir, Member::Manifest) {
        Ok(bytes) => bytes,
        Err(_) => refuse!("generation-manifest-missing"),
    };

    // Assertion-only: can refuse, never steer (§U).
    if let Some(expected) = expected_manifest_sha256 {
        let lowered = expected.trim().to_ascii_lowercase();
        let normalized = lowered
            .strip_prefix("sha256-")
            .unwrap_or(&lowered)
            .to_string();
        if normalized != sha256_hex(&manifest_bytes) {
            refuse!("generation-expected-manifest-sha-mismatch");
        }
    }

    let admission = write_admission(family);
    let manifest = match saved_chat_package_verify::validate_manifest(&manifest_bytes, admission) {
        Ok(manifest) => manifest,
        Err(code) => refuse!(code),
    };
    let is_v3 = manifest.family == PackageFamily::V3;

    // WRITE accepts the closed superset of application member enums, but
    // COMMIT enforces the exact family inventory. Under V3, renderers are not
    // persistent members and their presence is a hard refusal.
    for entry in &entries {
        let known = if is_v3 {
            [Member::Snapshot, Member::Manifest]
                .iter()
                .any(|m| m.file_name().as_bytes() == entry.as_slice())
        } else {
            Member::all()
                .iter()
                .any(|m| m.file_name().as_bytes() == entry.as_slice())
        };
        if !known {
            if is_v3
                && (entry.as_slice() == Member::Markdown.file_name().as_bytes()
                    || entry.as_slice() == Member::Html.file_name().as_bytes())
            {
                refuse!("generation-v3-persistent-renderer-forbidden");
            }
            refuse!("generation-staging-unexpected-entry");
        }
    }

    let snapshot_bytes = match if is_v3 {
        read_staged_member_bounded(
            dir,
            Member::Snapshot,
            saved_chat_package_verify::LOGICAL_SNAPSHOT_CAP_BYTES,
        )
    } else {
        read_staged_member(dir, Member::Snapshot)
    } {
        Ok(bytes) => bytes,
        Err(_) => refuse!("generation-snapshot-missing"),
    };
    if !is_v3 {
        // Presence + regular-file check only; bytes remain streamed below.
        if hash_child(dir, Member::Markdown.file_name().as_bytes()).is_err() {
            refuse!("generation-markdown-missing");
        }
        if hash_child(dir, Member::Html.file_name().as_bytes()).is_err() {
            refuse!("generation-html-missing");
        }
    }
    if manifest.chat_id != session.chat_id {
        refuse!("generation-manifest-chat-id-mismatch");
    }

    let derived = if is_v3 {
        let actual_assets = match stage_manifest_assets(publisher, dir, &manifest) {
            Ok(facts) => facts,
            Err(code) => refuse!(&code),
        };
        let verified: VerifiedPackageSemantics = match saved_chat_package_verify::verify_package(
            PackageMembers {
                manifest: &manifest_bytes,
                snapshot: Some(&snapshot_bytes),
                markdown: None,
                html: None,
                assets: &actual_assets,
                unexpected_members: &[],
            },
            &session.chat_id,
            admission,
        ) {
            Ok(verified) => verified,
            Err(code) => refuse!(code),
        };
        verified.content_hash
    } else {
        if let Err(code) =
            validate_snapshot_cross_binding(&snapshot_bytes, &manifest, &session.chat_id)
        {
            refuse!(code);
        }

        // Preserve the unbounded v1/v2 renderer contract: stream/hash rather
        // than buffering presentation members.
        for member in [Member::Snapshot, Member::Markdown, Member::Html] {
            let key = member.descriptor_key().expect("non-manifest member");
            let (declared_sha, declared_len) = match manifest.files.get(key) {
                Some(entry) => (entry.0.clone(), entry.1),
                None => refuse!("generation-manifest-file-descriptor-missing"),
            };
            let (hex, len) = match hash_child(dir, member.file_name().as_bytes()) {
                Ok(value) => value,
                Err(_) => refuse!("generation-member-read-failed"),
            };
            if declared_len != len {
                refuse!("generation-member-byte-length-mismatch");
            }
            if declared_sha != format!("sha256-{hex}") {
                refuse!("generation-member-sha-mismatch");
            }
        }

        let mut sorted_shas: Vec<String> =
            manifest.assets.iter().map(|a| a.sha256.clone()).collect();
        sorted_shas.sort();
        let derived = derive_content_hash(manifest.payload_v2, &snapshot_bytes, &sorted_shas);
        if derived != manifest.content_hash {
            refuse!("generation-content-hash-mismatch");
        }
        if let Err(code) = stage_manifest_assets(publisher, dir, &manifest) {
            refuse!(&code);
        }
        derived
    };

    let hex = derived
        .strip_prefix("sha256-")
        .expect("derived hash is prefixed")
        .to_string();
    let final_name = generation_basename(&session.chat_id, &hex);
    let packages = match publisher.packages_dir() {
        Ok(dir) => dir,
        Err(_) => refuse!("generation-packages-unavailable"),
    };
    match packages.name_max() {
        Ok(limit) if final_name.len() as u64 <= limit => {}
        Ok(_) => refuse!("generation-name-exceeds-filesystem-limit"),
        Err(_) => refuse!("generation-name-max-indeterminate"),
    }

    // Durability fences: every member, then the staging directory, BEFORE
    // promotion.
    for member in Member::all() {
        if is_v3 && matches!(member, Member::Markdown | Member::Html) {
            continue;
        }
        let file = match dir.open_child_read_nofollow(member.file_name().as_bytes()) {
            Ok(file) => file,
            Err(_) => refuse!("generation-member-reopen-failed"),
        };
        if crate::archive_durable_write::sync_file_contents(&file).is_err() {
            refuse!("generation-member-fsync-failed");
        }
    }
    if dir.sync().is_err() {
        refuse!("generation-staging-fsync-failed");
    }

    let staging_name = inner.staging_name.clone();
    let generation_path = format!("{ARCHIVE_ROOT}/{PACKAGES_DIR}/{final_name}");

    // Create-only exclusive DIRECTORY promotion; fails closed where the
    // platform cannot express it.
    let promoted = match packages.promote_dir_exclusive(&staging_name, final_name.as_bytes()) {
        Ok(value) => value,
        Err(err) => {
            if err.kind() == std::io::ErrorKind::Unsupported {
                refuse!("generation-unsupported-platform");
            }
            if is_resource_errno(&err) {
                let code = resource_code(&err);
                refuse!(&code);
            }
            refuse!("generation-promote-failed")
        }
    };

    if !promoted {
        // Occupied: classify TRUSTED-SIDE → clean own staging → parent fence →
        // report (§N.2 frozen tail).
        let (outcome, code, advisories) = classify_occupant(
            &packages,
            final_name.as_bytes(),
            &derived,
            &session.chat_id,
            admission,
        );
        inner.dir = held.take();
        let clean = cleanup_staging(publisher, &mut inner);
        let fenced = parent_fence(&packages);
        let mut out = PublishResult::occupied(outcome, code, generation_path, derived.clone());
        // Non-blocking: advisories never gate success (batch repair R4).
        out.advisories = advisories;
        if !clean {
            out.blockers
                .push(Blocker::new("generation-staging-cleanup-incomplete"));
        }
        if !fenced {
            out.blockers
                .push(Blocker::new("generation-parent-fsync-failed"));
        }
        return out;
    }

    // Promotion IS the commit point. The staged tree is now the published
    // generation: it leaves cleanup scope, and a fence failure can never
    // retract the commit (§N).
    drop(held.take());
    inner.members.clear();
    let durability_complete = parent_fence(&packages);
    let mut blockers = Vec::new();
    if !durability_complete {
        blockers.push(Blocker::new("generation-parent-fsync-failed"));
    }
    PublishResult {
        schema: GENERATION_PUBLISH_SCHEMA,
        ok: true,
        committed: true,
        durability_complete,
        outcome: Outcome::Created,
        generation_path,
        content_hash: derived,
        blockers,
        advisories: Vec::new(),
    }
}

/// The trusted facts the all-supported occupant verifier establishes about a
/// package on disk.
///
/// M06 T2.1 consumes this so the read-only engine reuses the publisher's
/// verification authority verbatim instead of running an "almost equivalent"
/// second verifier. `content_hash` is RECOMPUTED from the stored bytes — never
/// the filename's or the manifest's claim.
pub(crate) struct VerifiedOccupant {
    pub(crate) dir: confined::Dir,
    pub(crate) manifest: ValidatedManifest,
    pub(crate) manifest_bytes: Vec<u8>,
    pub(crate) content_hash: String,
    pub(crate) family: PackageFamily,
    pub(crate) snapshot_encoding: SnapshotEncoding,
    pub(crate) snapshot_physical_sha256: String,
    pub(crate) snapshot_physical_byte_length: u64,
    pub(crate) logical_snapshot_sha256: String,
    pub(crate) logical_snapshot_byte_length: u64,
    pub(crate) saved_at: Option<String>,
    pub(crate) asset_shas: Vec<String>,
    pub(crate) persistent_members: Vec<String>,
}

/// It performs every structural check the publisher already performed: symlinks
/// are refused and never followed, required members must be present, the
/// manifest must validate, every DECLARED asset member is re-hashed and
/// length-checked, the snapshot cross-binding must hold, the `files.snapshot`
/// descriptor must match the stored bytes, and the derived contentHash must
/// agree with the manifest's.
///
/// TRUSTED-SIDE ONLY — the renderer never adjudicates this (§N.2). The occupant
/// is never overwritten, repaired or deleted.
/// Shared durable-read admission. The package scanner and M07 transport handoff
/// both use this entry point, so rollback changes new writes but never read
/// compatibility for an already-verified family.
/// How an occupant failed trusted admission.
///
/// `.0` and `.1` are the EXISTING coarse admission `Outcome` and code, with
/// unchanged semantics: every current consumer — publication, the M06 scanner's
/// broad classification and the M07 handoff — reads only these two, and they are
/// what decides admission.
///
/// `.2` is additive DIAGNOSTIC evidence: the granular
/// `saved_chat_package_verify` rule code, present only when that verifier is
/// what refused the package, and `None` for every filesystem or admission
/// failure that did not come from it. No decision may read it, and no granular
/// code is ever fabricated to fill it.
pub(crate) type AdmissionFailure = (Outcome, &'static str, Option<&'static str>);

pub(crate) fn verify_occupant_all_supported(
    packages: &confined::Dir,
    name: &[u8],
) -> Result<VerifiedOccupant, AdmissionFailure> {
    verify_occupant_with_admission(packages, name, VerificationAdmission::AllSupported)
}

fn verify_occupant_with_admission(
    packages: &confined::Dir,
    name: &[u8],
    admission: VerificationAdmission,
) -> Result<VerifiedOccupant, AdmissionFailure> {
    let st = match packages.stat_child_nofollow(name) {
        Ok(Some(st)) => st,
        _ => {
            return Err((
                Outcome::GenerationOccupantUnreadable,
                "generation-occupant-unreadable",
                None,
            ))
        }
    };
    if confined::is_symlink(&st) {
        // Neither valid nor an identity, so NOT "foreign" (§N.2 fixes that as
        // "occupant valid but a different identity"). Never followed.
        return Err((
            Outcome::GenerationOccupantUnreadable,
            "generation-occupant-unreadable",
            None,
        ));
    }
    let dir = match packages.open_child_nofollow(name) {
        Ok(dir) => dir,
        Err(_) => {
            return Err((
                Outcome::GenerationOccupantUnreadable,
                "generation-occupant-unreadable",
                None,
            ))
        }
    };
    let manifest_bytes = match read_staged_member(&dir, Member::Manifest) {
        Ok(bytes) => bytes,
        Err(_) => return Err((Outcome::GenerationPartial, "generation-partial", None)),
    };
    let manifest = match saved_chat_package_verify::validate_manifest(&manifest_bytes, admission) {
        Ok(manifest) => manifest,
        // A manifest rule failure IS a saved_chat_package_verify rule failure,
        // so its granular code is preserved on the same terms as the package
        // verifier's. The coarse admission pair is unchanged.
        Err(granular) => {
            return Err((
                Outcome::GenerationDestinationCorrupt,
                "generation-destination-corrupt",
                Some(granular),
            ))
        }
    };
    let is_v3 = manifest.family == PackageFamily::V3;
    let snapshot_bytes = match if is_v3 {
        read_staged_member_bounded(
            &dir,
            Member::Snapshot,
            saved_chat_package_verify::LOGICAL_SNAPSHOT_CAP_BYTES,
        )
    } else {
        read_staged_member(&dir, Member::Snapshot)
    } {
        Ok(bytes) => bytes,
        Err(_) => return Err((Outcome::GenerationPartial, "generation-partial", None)),
    };
    if !is_v3
        && (read_staged_member(&dir, Member::Markdown).is_err()
            || read_staged_member(&dir, Member::Html).is_err())
    {
        return Err((Outcome::GenerationPartial, "generation-partial", None));
    }

    if is_v3 {
        let entries = dir.read_entry_names().map_err(|_| {
            (
                Outcome::GenerationDestinationCorrupt,
                "generation-destination-corrupt",
                None,
            )
        })?;
        let mut expected = BTreeSet::from([
            Member::Manifest.file_name().as_bytes().to_vec(),
            Member::Snapshot.file_name().as_bytes().to_vec(),
        ]);
        if !manifest.assets.is_empty() {
            expected.insert(b"assets".to_vec());
        }
        if entries.len() != expected.len() || entries.iter().any(|name| !expected.contains(name)) {
            return Err((
                Outcome::GenerationDestinationCorrupt,
                "generation-destination-corrupt",
                None,
            ));
        }
    }
    // §N.2 step "verify the required members are present": the governed
    // `assets/` copies are required members of a live v2 package (§J), and the
    // reader enforces them as HARD blockers (package-asset-missing /
    // -unreadable / -sha-mismatch / -byte-length-mismatch). Without this, an
    // occupant whose asset copies were truncated or removed would re-derive an
    // identical contentHash — the hash consumes the manifest's declared sha
    // strings, not the files — and be laundered into DEDUPED while this
    // attempt's correct copy was deleted.
    //
    // Only the DECLARED descriptors are checked. An undeclared extra file under
    // `assets/` is `extra-package-asset`, a reader WARNING, so refusing on it
    // would be a new validity rule.
    let mut actual_assets = Vec::with_capacity(manifest.assets.len());
    if !manifest.assets.is_empty() {
        let assets = match dir.open_child_nofollow(b"assets") {
            Ok(dir) => dir,
            Err(_) => return Err((Outcome::GenerationPartial, "generation-partial", None)),
        };
        if is_v3 {
            let names = assets.read_entry_names().map_err(|_| {
                (
                    Outcome::GenerationDestinationCorrupt,
                    "generation-destination-corrupt",
                    None,
                )
            })?;
            let expected: BTreeSet<Vec<u8>> = manifest
                .assets
                .iter()
                .map(|asset| format!("{}.{}", asset.sha256, asset.ext).into_bytes())
                .collect();
            if names.len() != expected.len() || names.iter().any(|name| !expected.contains(name)) {
                return Err((
                    Outcome::GenerationDestinationCorrupt,
                    "generation-destination-corrupt",
                    None,
                ));
            }
        }
        for asset in &manifest.assets {
            let member_name = format!("{}.{}", asset.sha256, asset.ext);
            let st = match assets.stat_child_nofollow(member_name.as_bytes()) {
                Ok(Some(st)) => st,
                Ok(None) => return Err((Outcome::GenerationPartial, "generation-partial", None)),
                Err(_) => {
                    return Err((
                        Outcome::GenerationDestinationCorrupt,
                        "generation-destination-corrupt",
                        None,
                    ))
                }
            };
            if !confined::is_regular(&st) {
                return Err((
                    Outcome::GenerationDestinationCorrupt,
                    "generation-destination-corrupt",
                    None,
                ));
            }
            match hash_child(&assets, member_name.as_bytes()) {
                Ok((hex, len)) => {
                    let sha256 = format!("sha256-{hex}");
                    if len != asset.byte_length || sha256 != asset.sha256 {
                        return Err((
                            Outcome::GenerationDestinationCorrupt,
                            "generation-destination-corrupt",
                            None,
                        ));
                    }
                    actual_assets.push(VerifiedAssetMember {
                        path: asset.path.clone(),
                        sha256,
                        byte_length: len,
                    });
                }
                Err(_) => {
                    return Err((
                        Outcome::GenerationDestinationCorrupt,
                        "generation-destination-corrupt",
                        None,
                    ))
                }
            }
        }
    }

    let (
        content_hash,
        snapshot_encoding,
        snapshot_physical_sha256,
        snapshot_physical_byte_length,
        logical_snapshot_sha256,
        logical_snapshot_byte_length,
        saved_at,
    ) = if is_v3 {
        let verified = saved_chat_package_verify::verify_package(
            PackageMembers {
                manifest: &manifest_bytes,
                snapshot: Some(&snapshot_bytes),
                markdown: None,
                html: None,
                assets: &actual_assets,
                unexpected_members: &[],
            },
            &manifest.chat_id,
            admission,
        )
        // The coarse admission Outcome and code are UNCHANGED; the granular
        // saved_chat_package_verify rule code is additionally preserved as
        // evidence. Verification is not re-run to obtain it.
        .map_err(|granular| {
            (
                Outcome::GenerationDestinationCorrupt,
                "generation-destination-corrupt",
                Some(granular),
            )
        })?;
        (
            verified.content_hash,
            verified.snapshot_encoding,
            verified.snapshot_physical_sha256,
            verified.snapshot_physical_byte_length,
            verified.logical_snapshot_sha256,
            verified.logical_snapshot_byte_length,
            verified.saved_at,
        )
    } else {
        // Preserve the accepted v1/v2 occupant contract. Presentation bytes
        // must exist, but descriptor mismatch remains a non-blocking dedupe
        // advisory rather than package corruption.
        if let Err(granular) =
            validate_snapshot_cross_binding(&snapshot_bytes, &manifest, &manifest.chat_id)
        {
            return Err((
                Outcome::GenerationDestinationCorrupt,
                "generation-destination-corrupt",
                Some(granular),
            ));
        }

        // The governed reader hard-blocks `snapshot-sha-mismatch` for v1/v2 when
        // `manifest.files.snapshot.sha256` disagrees with the stored bytes, and it
        // is a §S class-A blocker that must be unreachable for a committed
        // generation. contentHash alone does NOT cover it: the descriptor is a
        // separate field, so an occupant can carry correct bytes and a correct
        // contentHash while its files.snapshot descriptor is wrong. Without this,
        // such an occupant would be laundered into DEDUPED while the reader
        // classifies it invalid.
        //
        // Scoped deliberately to `snapshot`: the reader does NOT hash chat.md or
        // chat.html, so re-hashing those as blockers would newly refuse packages
        // the reader accepts (they are handled as a non-blocking advisory below).
        {
            let key = Member::Snapshot
                .descriptor_key()
                .expect("non-manifest member");
            match manifest.files.get(key) {
                Some((declared_sha, declared_len)) => {
                    let actual = format!("sha256-{}", sha256_hex(&snapshot_bytes));
                    if *declared_len != snapshot_bytes.len() as u64 || *declared_sha != actual {
                        return Err((
                            Outcome::GenerationDestinationCorrupt,
                            "generation-destination-corrupt",
                            None,
                        ));
                    }
                }
                None => {
                    return Err((
                        Outcome::GenerationDestinationCorrupt,
                        "generation-destination-corrupt",
                        None,
                    ))
                }
            }
        }

        let mut sorted: Vec<String> = manifest.assets.iter().map(|a| a.sha256.clone()).collect();
        sorted.sort();
        let derived = derive_content_hash(manifest.payload_v2, &snapshot_bytes, &sorted);
        if derived != manifest.content_hash {
            return Err((
                Outcome::GenerationDestinationCorrupt,
                "generation-destination-corrupt",
                None,
            ));
        }
        let snapshot_sha = format!("sha256-{}", sha256_hex(&snapshot_bytes));
        (
            derived,
            SnapshotEncoding::Identity,
            snapshot_sha.clone(),
            snapshot_bytes.len() as u64,
            snapshot_sha,
            snapshot_bytes.len() as u64,
            crate::archive_generation_order::extract_saved_at(&snapshot_bytes),
        )
    };

    let mut asset_shas: Vec<String> = manifest.assets.iter().map(|a| a.sha256.clone()).collect();
    asset_shas.sort();
    let mut persistent_members = vec!["manifest.json".to_string(), "snapshot.json".to_string()];
    if !is_v3 {
        persistent_members.extend(["chat.md".to_string(), "chat.html".to_string()]);
    }
    persistent_members.extend(manifest.assets.iter().map(|asset| asset.path.clone()));
    persistent_members.sort();
    let package_family = manifest.family;

    Ok(VerifiedOccupant {
        dir,
        manifest,
        manifest_bytes,
        content_hash,
        family: package_family,
        snapshot_encoding,
        snapshot_physical_sha256,
        snapshot_physical_byte_length,
        logical_snapshot_sha256,
        logical_snapshot_byte_length,
        saved_at,
        asset_shas,
        persistent_members,
    })
}

/// Classifies an occupying generation against THIS session's expected identity.
/// The structural verification above is shared; only the session comparison and
/// the presentation advisory live here.
fn classify_occupant(
    packages: &confined::Dir,
    name: &[u8],
    expected_content_hash: &str,
    session_chat_id: &str,
    admission: VerificationAdmission,
) -> (Outcome, &'static str, Vec<Blocker>) {
    let VerifiedOccupant {
        dir,
        manifest,
        manifest_bytes: _,
        content_hash: derived,
        ..
    } = match verify_occupant_with_admission(packages, name, admission) {
        Ok(verified) => verified,
        // Admission reads ONLY the coarse pair; the granular evidence is not a
        // publication input.
        Err((outcome, code, _granular)) => return (outcome, code, Vec::new()),
    };
    // §D's join, reduced to its only free variable here. UNREACHABLE in
    // practice and deliberately kept as defence in depth: reaching it requires
    // an occupant whose snapshot bytes hash exactly as ours while naming a
    // different chat, i.e. a SHA-256 collision. Deleting it therefore fails no
    // test — the hash comparison below is what actually decides identity.
    if manifest.chat_id != session_chat_id {
        return (
            Outcome::GenerationDestinationForeign,
            "generation-destination-foreign",
            Vec::new(),
        );
    }
    if derived != expected_content_hash {
        return (
            Outcome::GenerationDestinationForeign,
            "generation-destination-foreign",
            Vec::new(),
        );
    }

    // Batch repair R4: the occupant is identity-identical and structurally
    // complete (files.snapshot re-hashed above), so this IS a dedupe —
    // the reader never hashes chat.md/chat.html and §K makes them non-identity,
    // so a byte mismatch there does not make the package invalid, and refusing
    // would not repair the occupant: it would only convert a legitimate
    // create-only dedupe into a permanently failing save.
    //
    // But a damaged presentation member is exporter-relevant, so surface it as
    // a NON-BLOCKING advisory rather than accepting it silently. This never
    // enters `blockers` and never changes ok/committed/durability.
    let mut advisories = Vec::new();
    for member in [Member::Markdown, Member::Html] {
        let key = member.descriptor_key().expect("non-manifest member");
        if let Some((declared_sha, declared_len)) = manifest.files.get(key) {
            match hash_child(&dir, member.file_name().as_bytes()) {
                Ok((hex, len)) => {
                    if len != *declared_len || &format!("sha256-{hex}") != declared_sha {
                        advisories.push(Blocker::new("generation-occupant-presentation-mismatch"));
                        break;
                    }
                }
                Err(_) => {
                    advisories.push(Blocker::new("generation-occupant-presentation-mismatch"));
                    break;
                }
            }
        }
    }
    (Outcome::Deduped, "", advisories)
}

/// Archive root for the running app.
#[allow(dead_code)]
pub fn archive_root_for(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("generation-app-local-data-unavailable:{err}"))?;
    Ok(base.join(ARCHIVE_ROOT))
}

/// Structurally-ready command wrappers.
///
/// DELIBERATELY NOT REGISTERED in `generate_handler!` at this Stage (§N
/// production-wiring boundary): registering them now would make generation
/// publication renderer-invokable while the renderer still holds broad archive
/// mutation authority, i.e. before the G1 cutover. Registration lands
/// atomically with capability narrowing and legacy-writer retirement.
#[allow(dead_code)]
/// G1 production command surface.
///
/// Exposes ONLY the four purpose-bounded semantic operations. The renderer
/// never names a final destination, a member path, a package path, a CAS
/// source, or an authoritative contentHash — §O.
///
/// The publisher lives in Tauri state so sessions survive across invokes; its
/// root is the app-owned archive directory, resolved on the trusted side.
pub struct PublisherState(pub std::sync::Mutex<Option<std::sync::Arc<Publisher>>>);

impl Default for PublisherState {
    fn default() -> Self {
        PublisherState(std::sync::Mutex::new(None))
    }
}

fn publisher_for(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, PublisherState>,
) -> Result<std::sync::Arc<Publisher>, String> {
    let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = slot.as_ref() {
        return Ok(std::sync::Arc::clone(existing));
    }
    let root = crate::archive_durable_write::archive_root(app)?;
    let publisher = std::sync::Arc::new(Publisher::new(root));
    *slot = Some(std::sync::Arc::clone(&publisher));
    Ok(publisher)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginOptions {
    pub chat_id: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberOptions {
    #[serde(deserialize_with = "ipc_token::deserialize")]
    pub token: u64,
    /// Enum only — never a path or filename.
    pub member: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOptions {
    #[serde(deserialize_with = "ipc_token::deserialize")]
    pub token: u64,
    /// Assertion-only: it can refuse a publication, never steer one (§U).
    pub expected_manifest_sha256: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbortOptions {
    #[serde(deserialize_with = "ipc_token::deserialize")]
    pub token: u64,
}

fn member_from_name(name: &str) -> Option<Member> {
    match name {
        "snapshot" => Some(Member::Snapshot),
        "markdown" => Some(Member::Markdown),
        "html" => Some(Member::Html),
        "manifest" => Some(Member::Manifest),
        _ => None,
    }
}

#[tauri::command]
pub async fn h2o_archive_generation_begin(
    app: tauri::AppHandle,
    state: tauri::State<'_, PublisherState>,
    gate: tauri::State<'_, crate::archive_instance_lock::ArchiveInstanceState>,
    options: BeginOptions,
) -> Result<BeginResult, String> {
    // M06 T1.1: entered for THIS invoke only. A generation session spans
    // BEGIN -> WRITE MEMBER -> COMMIT as separate invokes, so the guard must
    // never straddle them; session lifetime stays owned by the registry.
    let _mutation = crate::archive_instance_lock::enter_mutation_for(&app, &gate)?;
    let publisher = publisher_for(&app, &state)?;
    Ok(begin(&publisher, &options.chat_id))
}

#[tauri::command]
pub async fn h2o_archive_generation_write_member(
    app: tauri::AppHandle,
    state: tauri::State<'_, PublisherState>,
    gate: tauri::State<'_, crate::archive_instance_lock::ArchiveInstanceState>,
    request: tauri::ipc::Request<'_>,
) -> Result<AckResult, String> {
    let _mutation = crate::archive_instance_lock::enter_mutation_for(&app, &gate)?;
    let options: MemberOptions = crate::archive_durable_write::required_options(&request)?;
    let member = match member_from_name(&options.member) {
        Some(member) => member,
        // An unknown name is refused outright: the enum is the whole surface.
        None => return Ok(AckResult::refused("generation-member-unknown")),
    };
    let chunk = crate::archive_durable_write::body_bytes(&request)?;
    let publisher = publisher_for(&app, &state)?;
    Ok(write_member(&publisher, options.token, member, &chunk))
}

#[tauri::command]
pub async fn h2o_archive_generation_commit(
    app: tauri::AppHandle,
    state: tauri::State<'_, PublisherState>,
    gate: tauri::State<'_, crate::archive_instance_lock::ArchiveInstanceState>,
    options: CommitOptions,
) -> Result<PublishResult, String> {
    let _mutation = crate::archive_instance_lock::enter_mutation_for(&app, &gate)?;
    let publisher = publisher_for(&app, &state)?;
    Ok(commit(
        &publisher,
        options.token,
        options.expected_manifest_sha256.as_deref(),
    ))
}

#[tauri::command]
pub async fn h2o_archive_generation_abort(
    app: tauri::AppHandle,
    state: tauri::State<'_, PublisherState>,
    gate: tauri::State<'_, crate::archive_instance_lock::ArchiveInstanceState>,
    options: AbortOptions,
) -> Result<AckResult, String> {
    let _mutation = crate::archive_instance_lock::enter_mutation_for(&app, &gate)?;
    let publisher = publisher_for(&app, &state)?;
    Ok(abort(&publisher, options.token))
}

#[cfg(test)]
mod tests;
