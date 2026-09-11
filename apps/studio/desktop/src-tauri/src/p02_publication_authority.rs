/*
 * P02 V8-C3a — ephemeral governed first-publication write authority.
 *
 * V8-B shipped four narrow storage commands that were safe only because nothing
 * called them. The moment a production composition can reach them, raw mutation
 * must stop being possible on its own: this module is the gate.
 *
 * A governed campaign opens a process-local lease bound to exactly one prepared
 * publication, and every mutating storage operation must present its capability.
 * The lease is deliberately narrow - it names the writer, the repository, the
 * layout epoch, the object and the exact revision blob - so a valid capability
 * cannot be redirected at a different object, a different writer subtree, a
 * different repository or an arbitrary path. Confinement in p02_writer_storage
 * is unchanged and still applies underneath; this only removes the ability to
 * write at all without governance.
 *
 * The capability is 32 bytes of kernel entropy, held in memory, never persisted
 * to SQLite, a file, localStorage or a URL, and never returned to disk. It
 * expires, it is single-publication, and closing or aborting ends it. A crashed
 * webview therefore cannot leave a standing write capability behind.
 *
 * Object-domain agnostic: the lease carries `objectDomain` as data and this
 * module never interprets it.
 */

use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::item11_delivery_destination::authorization_root;
use crate::p02_activation::{resolve_target_core, P02_AUTHORITY_FILE, P02_LIBRARY_INFO_SCHEMA};
use crate::sync_contract_v2::{
    FORMAT_VERSION_V2, LAYOUT_EPOCH_V2, PROTOCOL_VERSION_V2,
};

/*
 * Implementation governance, not frozen N1 text: N1 defines no literal V8
 * campaign or operator token, so these are the minimum authority consistent
 * with the accepted V7 pattern and are labelled as such.
 */
pub const V8_GOVERNED_CAMPAIGN_TOKEN: &str = "P02_V8_FIRST_WRITER_PUBLICATION";
pub const V8_OPERATOR_AUTHORIZATION_TOKEN: &str =
    "P02_V8_OPERATOR_AUTHORIZED_FIRST_WRITER_PUBLICATION";

/* Long enough for one publication, short enough that a crash cannot leave a
 * standing write capability for the life of the process. */
const LEASE_TTL: Duration = Duration::from_secs(300);

pub const PUBLICATION_NOT_AUTHORIZED: &str = "p02-v8c3-publication-not-authorized";
pub const PUBLICATION_P01_NOT_QUIESCED: &str = "p02-v8c3-p01-writer-not-quiesced";
pub const PUBLICATION_REQUEST_INVALID: &str = "p02-v8c3-publication-request-invalid";
pub const PUBLICATION_CONTAINER_MISMATCH: &str = "p02-v8c3-container-mismatch";
pub const PUBLICATION_NOT_ACTIVATED: &str = "p02-v8c3-format-authority-not-activated";
pub const PUBLICATION_LAYOUT_EPOCH_MISMATCH: &str = "p02-v8c3-layout-epoch-mismatch";
pub const PUBLICATION_WRITER_ALREADY_PRESENT: &str = "p02-v8c3-writer-pointer-already-present";
pub const PUBLICATION_LEASE_ACTIVE: &str = "p02-v8c3-publication-lease-active";
pub const PUBLICATION_LEASE_UNAVAILABLE: &str = "p02-v8c3-publication-lease-unavailable";
pub const PUBLICATION_CAPABILITY_INVALID: &str = "p02-v8c3-publication-capability-invalid";
pub const PUBLICATION_CAPABILITY_EXPIRED: &str = "p02-v8c3-publication-capability-expired";
pub const PUBLICATION_TARGET_NOT_AUTHORIZED: &str = "p02-v8c3-publication-target-not-authorized";
pub const PUBLICATION_ENTROPY_UNAVAILABLE: &str = "p02-v8c3-entropy-unavailable";
/* O1-T17: the ceremony `begin` now also proves the live profile-lock session. */
pub const PUBLICATION_BOOT_SESSION_MISMATCH: &str = "p02-v8c3-boot-session-mismatch";

#[derive(Clone, Debug)]
struct PublicationLease {
    capability: String,
    created: Instant,
    writer_sync_peer_id: String,
    writer_key: String,
    container_path_sha256_hex: String,
    layout_epoch: u64,
    object_domain: String,
    object_id: String,
    object_key: String,
    revision_id: String,
    revision_blob_sha256: String,
}

impl PublicationLease {
    fn expired(&self, now: Instant) -> bool {
        now.duration_since(self.created) >= LEASE_TTL
    }
}

fn lease_cell() -> &'static Mutex<Option<PublicationLease>> {
    static CELL: OnceLock<Mutex<Option<PublicationLease>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/* A poisoned mutex must never read as "no lease held" and silently open the
 * gate; callers treat it as unavailable and fail closed. */
fn lease_locked<T>(
    action: impl FnOnce(&mut Option<PublicationLease>) -> T,
) -> Result<T, &'static str> {
    let mut guard = lease_cell()
        .lock()
        .map_err(|_| PUBLICATION_LEASE_UNAVAILABLE)?;
    Ok(action(&mut guard))
}

/* Constant-time-ish, so a wrong capability cannot be probed byte by byte. */
fn capability_matches(expected: &str, supplied: &str) -> bool {
    let left = expected.as_bytes();
    let right = supplied.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for index in 0..left.len() {
        difference |= left[index] ^ right[index];
    }
    difference == 0
}

/* 32 bytes from the kernel CSPRNG. No timestamp, counter or hash fallback: a
 * failure fails the authorization rather than degrading the capability. */
fn random_capability_hex() -> Result<String, &'static str> {
    let mut buffer = [0_u8; 32];
    let code = unsafe {
        libc::getentropy(
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len() as libc::size_t,
        )
    };
    if code != 0 {
        return Err(PUBLICATION_ENTROPY_UNAVAILABLE);
    }
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn non_empty_bounded(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && value.trim() == value
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P02PublicationBeginRequest {
    pub governed_campaign: String,
    pub operator_authorization: String,
    pub p01_writer_quiesced: bool,
    pub writer_sync_peer_id: String,
    pub writer_key: String,
    pub expected_container_path_sha256_hex: String,
    pub expected_layout_epoch: u64,
    pub object_domain: String,
    pub object_id: String,
    pub object_key: String,
    pub revision_id: String,
    pub revision_blob_sha256: String,
    /*
     * O1-T17. The live profile-lock session identity. A capability is bound to
     * the process that earned it, so a request carrying a stale or foreign boot
     * id cannot open a write window - which matters most after a profile
     * handover, where an older webview could otherwise still be holding a
     * prepared publication.
     */
    pub boot_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P02PublicationLeaseGrant {
    pub schema: &'static str,
    pub capability: String,
    pub writer_key: String,
    pub object_key: String,
    pub revision_blob_sha256: String,
    pub layout_epoch: u64,
    pub expires_in_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P02PublicationLeaseClosed {
    pub schema: &'static str,
    pub closed: bool,
    pub outcome: String,
}

pub const LEASE_SCHEMA: &str = "h2o.studio.syncPublicationLease.p02.v1";

/*
 * The V7 authority must still be exactly the supported, activated one, and its
 * layout epoch must match what the caller prepared against. V8-C3a activates
 * nothing; it refuses to open a write window over an unexpected repository.
 */
fn require_activated_epoch(repository: &Path, expected_epoch: u64) -> Result<(), &'static str> {
    let bytes =
        std::fs::read(repository.join(P02_AUTHORITY_FILE)).map_err(|_| PUBLICATION_NOT_ACTIVATED)?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| PUBLICATION_NOT_ACTIVATED)?;
    let supported = value.get("schema").and_then(|item| item.as_str())
        == Some(P02_LIBRARY_INFO_SCHEMA)
        && value.get("formatVersion").and_then(|item| item.as_u64()) == Some(FORMAT_VERSION_V2)
        /* A repository declaring a LOWER minimum compatible protocol is
         * readable by this writer: the field states the oldest protocol that
         * can safely read the layout, not the exact protocol that wrote it.
         * Exact equality refused every future repository written by an older
         * compatible writer. Schema, format version and layout epoch stay
         * exact - those really are identity, not a compatibility range. */
        && value
            .get("minimumCompatibleProtocolVersion")
            .and_then(|item| item.as_u64())
            .is_some_and(|version| (1..=PROTOCOL_VERSION_V2).contains(&version));
    if !supported {
        return Err(PUBLICATION_NOT_ACTIVATED);
    }
    let epoch = value
        .get("layoutEpoch")
        .and_then(|item| item.as_u64())
        .ok_or(PUBLICATION_NOT_ACTIVATED)?;
    if epoch != LAYOUT_EPOCH_V2 || epoch != expected_epoch {
        return Err(PUBLICATION_LAYOUT_EPOCH_MISMATCH);
    }
    Ok(())
}

pub(crate) fn begin_core(
    repository: &Path,
    container_path_sha256_hex: &str,
    live_boot_id: &str,
    request: &P02PublicationBeginRequest,
) -> Result<P02PublicationLeaseGrant, &'static str> {
    /* Governed gate first: nothing is inspected before it passes. */
    if request.governed_campaign != V8_GOVERNED_CAMPAIGN_TOKEN
        || request.operator_authorization != V8_OPERATOR_AUTHORIZATION_TOKEN
    {
        return Err(PUBLICATION_NOT_AUTHORIZED);
    }
    if !request.p01_writer_quiesced {
        return Err(PUBLICATION_P01_NOT_QUIESCED);
    }
    if !non_empty_bounded(&request.writer_sync_peer_id)
        || !non_empty_bounded(&request.object_domain)
        || !non_empty_bounded(&request.object_id)
        || !non_empty_bounded(&request.revision_id)
        || !is_lower_hex_64(&request.writer_key)
        || !is_lower_hex_64(&request.object_key)
        || !is_lower_hex_64(&request.revision_blob_sha256)
        || !is_lower_hex_64(&request.expected_container_path_sha256_hex)
        || !is_lower_hex_64(&request.boot_id)
    {
        return Err(PUBLICATION_REQUEST_INVALID);
    }
    /* O1-T17: the request must come from the process holding the profile lock. */
    if !capability_matches(live_boot_id, &request.boot_id) {
        return Err(PUBLICATION_BOOT_SESSION_MISMATCH);
    }
    if request.expected_container_path_sha256_hex != container_path_sha256_hex {
        return Err(PUBLICATION_CONTAINER_MISMATCH);
    }
    require_activated_epoch(repository, request.expected_layout_epoch)?;

    /* First-writer precondition: this writer must not already own a pointer. */
    let pointer = repository
        .join("writers")
        .join(&request.writer_key)
        .join("state.json");
    if pointer.exists() {
        return Err(PUBLICATION_WRITER_ALREADY_PRESENT);
    }

    let capability = random_capability_hex()?;
    let grant = P02PublicationLeaseGrant {
        schema: LEASE_SCHEMA,
        capability: capability.clone(),
        writer_key: request.writer_key.clone(),
        object_key: request.object_key.clone(),
        revision_blob_sha256: request.revision_blob_sha256.clone(),
        layout_epoch: request.expected_layout_epoch,
        expires_in_seconds: LEASE_TTL.as_secs(),
    };
    lease_locked(|slot| {
        let now = Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
        }
        if slot.is_some() {
            return Err(PUBLICATION_LEASE_ACTIVE);
        }
        *slot = Some(PublicationLease {
            capability,
            created: now,
            writer_sync_peer_id: request.writer_sync_peer_id.clone(),
            writer_key: request.writer_key.clone(),
            container_path_sha256_hex: container_path_sha256_hex.to_string(),
            layout_epoch: request.expected_layout_epoch,
            object_domain: request.object_domain.clone(),
            object_id: request.object_id.clone(),
            object_key: request.object_key.clone(),
            revision_id: request.revision_id.clone(),
            revision_blob_sha256: request.revision_blob_sha256.clone(),
        });
        Ok(())
    })??;
    Ok(grant)
}

/* What a mutating storage path is allowed to name under the active lease. */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MutationTarget<'a> {
    ObjectRevision { object_key: &'a str, revision_blob_sha256: &'a str },
    WriterSubtree { writer_key: &'a str },
}

/*
 * The single choke point. Every mutating storage operation calls this, so a raw
 * command invocation without a capability - or with one bound to a different
 * object, writer, revision or repository - cannot write.
 */
pub(crate) fn authorize_mutation(
    capability: &str,
    container_path_sha256_hex: &str,
    target: MutationTarget<'_>,
) -> Result<(), &'static str> {
    if capability.len() != 64 || !is_lower_hex_64(capability) {
        return Err(PUBLICATION_CAPABILITY_INVALID);
    }
    lease_locked(|slot| {
        let now = Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
            return Err(PUBLICATION_CAPABILITY_EXPIRED);
        }
        let lease = slot.as_ref().ok_or(PUBLICATION_CAPABILITY_INVALID)?;
        if !capability_matches(&lease.capability, capability) {
            return Err(PUBLICATION_CAPABILITY_INVALID);
        }
        if lease.container_path_sha256_hex != container_path_sha256_hex {
            return Err(PUBLICATION_CONTAINER_MISMATCH);
        }
        match target {
            MutationTarget::ObjectRevision {
                object_key,
                revision_blob_sha256,
            } => {
                if lease.object_key != object_key
                    || lease.revision_blob_sha256 != revision_blob_sha256
                {
                    return Err(PUBLICATION_TARGET_NOT_AUTHORIZED);
                }
            }
            MutationTarget::WriterSubtree { writer_key } => {
                if lease.writer_key != writer_key {
                    return Err(PUBLICATION_TARGET_NOT_AUTHORIZED);
                }
            }
        }
        Ok(())
    })?
}

/*
 * The full bound identity, readable only with the capability.
 *
 * `authorize_mutation` can only check what a filesystem path reveals - the
 * object key, the revision blob and the writer key. The domain, object id,
 * revision id, writer peer and layout epoch are bound here too, and the
 * composition layer verifies them against its prepared plan before it starts,
 * so a lease can never be driven by a plan it was not opened for.
 */
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P02PublicationBinding {
    pub schema: &'static str,
    pub writer_sync_peer_id: String,
    pub writer_key: String,
    pub container_path_sha256_hex: String,
    pub layout_epoch: u64,
    pub object_domain: String,
    pub object_id: String,
    pub object_key: String,
    pub revision_id: String,
    pub revision_blob_sha256: String,
}

pub(crate) fn binding_core(capability: &str) -> Result<P02PublicationBinding, &'static str> {
    if !is_lower_hex_64(capability) {
        return Err(PUBLICATION_CAPABILITY_INVALID);
    }
    lease_locked(|slot| {
        let now = Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
            return Err(PUBLICATION_CAPABILITY_EXPIRED);
        }
        let lease = slot.as_ref().ok_or(PUBLICATION_CAPABILITY_INVALID)?;
        if !capability_matches(&lease.capability, capability) {
            return Err(PUBLICATION_CAPABILITY_INVALID);
        }
        Ok(P02PublicationBinding {
            schema: LEASE_SCHEMA,
            writer_sync_peer_id: lease.writer_sync_peer_id.clone(),
            writer_key: lease.writer_key.clone(),
            container_path_sha256_hex: lease.container_path_sha256_hex.clone(),
            layout_epoch: lease.layout_epoch,
            object_domain: lease.object_domain.clone(),
            object_id: lease.object_id.clone(),
            object_key: lease.object_key.clone(),
            revision_id: lease.revision_id.clone(),
            revision_blob_sha256: lease.revision_blob_sha256.clone(),
        })
    })?
}

#[tauri::command]
pub fn h2o_p02_publication_binding(
    capability: String,
) -> Result<P02PublicationBinding, String> {
    binding_core(&capability).map_err(str::to_string)
}

pub(crate) fn finish_core(capability: &str, outcome: &str) -> Result<bool, &'static str> {
    if !is_lower_hex_64(capability) {
        return Err(PUBLICATION_CAPABILITY_INVALID);
    }
    lease_locked(|slot| {
        let held = slot
            .as_ref()
            .is_some_and(|lease| capability_matches(&lease.capability, capability));
        if !held {
            return Err(PUBLICATION_CAPABILITY_INVALID);
        }
        /* Closing is unconditional once the capability matches: an aborted
         * publication must end the window exactly like a successful one. */
        *slot = None;
        let _ = outcome;
        Ok(true)
    })?
}

/* Test-only reset so a disposable suite never leaks a lease between cases. */
#[cfg(test)]
pub(crate) fn reset_for_tests() {
    let _ = lease_locked(|slot| {
        *slot = None;
    });
}

fn repository_and_container(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, String), &'static str> {
    let root = authorization_root(app).map_err(|_| PUBLICATION_REQUEST_INVALID)?;
    let target = resolve_target_core(&root)?;
    Ok((
        std::path::PathBuf::from(&target.repository_root),
        target.container_path_sha256_hex,
    ))
}

/* Read by the storage commands so they bind to the same resolved repository. */
pub(crate) fn resolved_container_hash(app: &tauri::AppHandle) -> Result<String, &'static str> {
    Ok(repository_and_container(app)?.1)
}

#[tauri::command]
pub fn h2o_p02_publication_begin(
    app: tauri::AppHandle,
    request: P02PublicationBeginRequest,
) -> Result<P02PublicationLeaseGrant, String> {
    let (repository, container_hash) = repository_and_container(&app).map_err(str::to_string)?;
    let boot_id = crate::sync_object_transport::live_session_boot_id(&app)?;
    begin_core(&repository, &container_hash, &boot_id, &request).map_err(str::to_string)
}

#[tauri::command]
pub fn h2o_p02_publication_finish(
    capability: String,
    outcome: String,
) -> Result<P02PublicationLeaseClosed, String> {
    finish_core(&capability, &outcome)
        .map(|closed| P02PublicationLeaseClosed {
            schema: LEASE_SCHEMA,
            closed,
            outcome,
        })
        .map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::p02_writer_storage::{parse_storage_path, promote_temporary_core, write_temporary_core};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    /* The lease is process-global, so authority cases must not interleave. */
    static SERIAL: Mutex<()> = Mutex::new(());

    const TEST_BOOT_ID: &str =
        "abababababababababababababababababababababababababababababababab";
    const WRITER_KEY: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const OTHER_WRITER: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const OBJECT_KEY: &str = "3333333333333333333333333333333333333333333333333333333333333333";
    const OTHER_OBJECT: &str = "4444444444444444444444444444444444444444444444444444444444444444";
    const BLOB: &str = "5555555555555555555555555555555555555555555555555555555555555555";
    const OTHER_BLOB: &str = "6666666666666666666666666666666666666666666666666666666666666666";
    const CONTAINER: &str = "7777777777777777777777777777777777777777777777777777777777777777";

    struct Fixture {
        container: PathBuf,
        root: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.container);
            reset_for_tests();
        }
    }

    fn fixture(label: &str) -> Fixture {
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let container = std::env::temp_dir()
            .join(format!("p02-v8c3-{label}-{}-{unique}", std::process::id()));
        let _ = fs::remove_dir_all(&container);
        let root = container.join("h2o-object-sync");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(P02_AUTHORITY_FILE),
            format!(
                /* Full ceremony shape, matching what the V7 activation writer
                 * actually produces: seven top-level keys with the receipt
                 * embedded. A four-key stub would let a gate regression that
                 * only trips on real documents slip through unnoticed. */
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
        reset_for_tests();
        Fixture { container, root }
    }

    fn request() -> P02PublicationBeginRequest {
        P02PublicationBeginRequest {
            governed_campaign: V8_GOVERNED_CAMPAIGN_TOKEN.to_string(),
            operator_authorization: V8_OPERATOR_AUTHORIZATION_TOKEN.to_string(),
            p01_writer_quiesced: true,
            writer_sync_peer_id: "studio-desktop:tauri-desktop:sqlite:peer".to_string(),
            writer_key: WRITER_KEY.to_string(),
            expected_container_path_sha256_hex: CONTAINER.to_string(),
            expected_layout_epoch: LAYOUT_EPOCH_V2,
            boot_id: TEST_BOOT_ID.to_string(),
            object_domain: "studio.generic.v8c3.v1".to_string(),
            object_id: "object-one".to_string(),
            object_key: OBJECT_KEY.to_string(),
            revision_id: "object-one-r1".to_string(),
            revision_blob_sha256: BLOB.to_string(),
        }
    }

    /* 1-4: the governed gate itself. */
    #[test]
    fn only_the_exact_governed_campaign_and_operator_open_a_lease() {
        let _serial = SERIAL.lock();
        let fx = fixture("gate");
        assert!(begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).is_ok());
        reset_for_tests();
        for (campaign, operator) in [
            ("", V8_OPERATOR_AUTHORIZATION_TOKEN),
            (V8_GOVERNED_CAMPAIGN_TOKEN, ""),
            ("P02_V7_FORMAT_GATE_ACTIVATION", V8_OPERATOR_AUTHORIZATION_TOKEN),
            ("auto", "wake"),
        ] {
            let mut bad = request();
            bad.governed_campaign = campaign.to_string();
            bad.operator_authorization = operator.to_string();
            assert_eq!(
                begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &bad).unwrap_err(),
                PUBLICATION_NOT_AUTHORIZED
            );
        }
        let mut unquiesced = request();
        unquiesced.p01_writer_quiesced = false;
        assert_eq!(
            begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &unquiesced).unwrap_err(),
            PUBLICATION_P01_NOT_QUIESCED
        );
    }

    /// O1-T17. The ceremony `begin` now proves the live profile-lock session,
    /// so a request carrying a stale or foreign boot id cannot open a write
    /// window - which matters after a profile handover, where an older webview
    /// could still be holding a prepared publication.
    #[test]
    fn ceremony_begin_refuses_a_foreign_boot_session() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let fx = fixture("boot-session");
        let foreign = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
        assert_eq!(
            begin_core(&fx.root, CONTAINER, foreign, &request()).unwrap_err(),
            PUBLICATION_BOOT_SESSION_MISMATCH
        );
        /* And a malformed boot id is refused as an invalid request, not
         * silently treated as "no session to check". */
        let mut malformed = request();
        malformed.boot_id = "not-a-boot-id".to_string();
        assert_eq!(
            begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &malformed).unwrap_err(),
            PUBLICATION_REQUEST_INVALID
        );
        /* The matching session still grants, so the check is a gate and not a
         * blanket refusal. */
        assert!(begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).is_ok());
    }

    #[test]
    fn malformed_requests_and_wrong_repository_are_refused() {
        let _serial = SERIAL.lock();
        let fx = fixture("shape");
        for mutate in [
            (|r: &mut P02PublicationBeginRequest| r.writer_key = "short".into()) as fn(&mut _),
            |r: &mut P02PublicationBeginRequest| r.object_key = "".into(),
            |r: &mut P02PublicationBeginRequest| r.revision_blob_sha256 = "ZZZ".into(),
            |r: &mut P02PublicationBeginRequest| r.object_id = "".into(),
            |r: &mut P02PublicationBeginRequest| r.revision_id = " padded ".into(),
        ] {
            let mut bad = request();
            mutate(&mut bad);
            assert_eq!(
                begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &bad).unwrap_err(),
                PUBLICATION_REQUEST_INVALID
            );
        }
        assert_eq!(
            begin_core(&fx.root, OTHER_OBJECT, TEST_BOOT_ID, &request()).unwrap_err(),
            PUBLICATION_CONTAINER_MISMATCH
        );
    }

    #[test]
    fn unsupported_authority_or_wrong_epoch_is_refused() {
        let _serial = SERIAL.lock();
        let fx = fixture("epoch");
        let mut wrong_epoch = request();
        wrong_epoch.expected_layout_epoch = 9;
        assert_eq!(
            begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &wrong_epoch).unwrap_err(),
            PUBLICATION_LAYOUT_EPOCH_MISMATCH
        );
        fs::write(fx.root.join(P02_AUTHORITY_FILE), b"{\"schema\":\"other\"}").unwrap();
        assert_eq!(
            begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap_err(),
            PUBLICATION_NOT_ACTIVATED
        );
        fs::remove_file(fx.root.join(P02_AUTHORITY_FILE)).unwrap();
        assert_eq!(
            begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap_err(),
            PUBLICATION_NOT_ACTIVATED
        );
    }

    /*
     * The declared minimum compatible protocol is a RANGE, not an identity.
     * It states the oldest protocol that can safely read the layout, so a
     * repository written by an older compatible writer must stay readable.
     * Exact equality here refused exactly those repositories.
     */
    #[test]
    fn minimum_compatible_protocol_is_a_range_at_the_publication_gate() {
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
                require_activated_epoch(&fx.root, LAYOUT_EPOCH_V2).is_ok(),
                "minimum {accepted} is within the supported range"
            );
        }
        /* Above this writer's protocol the repository genuinely is unreadable. */
        fs::write(
            fx.root.join(P02_AUTHORITY_FILE),
            authority_with_min(PROTOCOL_VERSION_V2 + 1),
        )
        .unwrap();
        assert_eq!(
            require_activated_epoch(&fx.root, LAYOUT_EPOCH_V2),
            Err(PUBLICATION_NOT_ACTIVATED)
        );
    }

    /* First-writer precondition and single-publication lifetime. */
    #[test]
    fn an_existing_writer_pointer_refuses_a_first_publication_lease() {
        let _serial = SERIAL.lock();
        let fx = fixture("firstwriter");
        let writers = fx.root.join("writers").join(WRITER_KEY);
        fs::create_dir_all(&writers).unwrap();
        fs::write(writers.join("state.json"), b"{}").unwrap();
        assert_eq!(
            begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap_err(),
            PUBLICATION_WRITER_ALREADY_PRESENT
        );
    }

    #[test]
    fn only_one_lease_is_open_at_a_time_and_finish_closes_it() {
        let _serial = SERIAL.lock();
        let fx = fixture("single");
        let grant = begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap();
        assert_eq!(
            begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap_err(),
            PUBLICATION_LEASE_ACTIVE
        );
        assert!(finish_core(&grant.capability, "committed").unwrap());
        /* A consumed capability cannot drive another publication. */
        assert_eq!(
            authorize_mutation(
                &grant.capability,
                CONTAINER,
                MutationTarget::WriterSubtree { writer_key: WRITER_KEY }
            )
            .unwrap_err(),
            PUBLICATION_CAPABILITY_INVALID
        );
        assert_eq!(
            finish_core(&grant.capability, "committed").unwrap_err(),
            PUBLICATION_CAPABILITY_INVALID
        );
        /* And the window can be opened again for a genuinely new publication. */
        assert!(begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).is_ok());
    }

    /* The capability is narrow: it names one object, one blob, one writer. */
    #[test]
    fn a_capability_authorizes_only_its_bound_target() {
        let _serial = SERIAL.lock();
        let fx = fixture("bound");
        let grant = begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap();
        let capability = grant.capability.as_str();
        assert!(authorize_mutation(capability, CONTAINER,
            MutationTarget::ObjectRevision { object_key: OBJECT_KEY, revision_blob_sha256: BLOB }).is_ok());
        assert!(authorize_mutation(capability, CONTAINER,
            MutationTarget::WriterSubtree { writer_key: WRITER_KEY }).is_ok());
        for refused in [
            MutationTarget::ObjectRevision { object_key: OTHER_OBJECT, revision_blob_sha256: BLOB },
            MutationTarget::ObjectRevision { object_key: OBJECT_KEY, revision_blob_sha256: OTHER_BLOB },
            MutationTarget::WriterSubtree { writer_key: OTHER_WRITER },
        ] {
            assert_eq!(
                authorize_mutation(capability, CONTAINER, refused).unwrap_err(),
                PUBLICATION_TARGET_NOT_AUTHORIZED
            );
        }
        /* A different repository cannot be reached with this lease. */
        assert_eq!(
            authorize_mutation(capability, OTHER_OBJECT,
                MutationTarget::WriterSubtree { writer_key: WRITER_KEY }).unwrap_err(),
            PUBLICATION_CONTAINER_MISMATCH
        );
    }

    #[test]
    fn forged_or_absent_capabilities_are_refused() {
        let _serial = SERIAL.lock();
        let fx = fixture("forged");
        let target = MutationTarget::WriterSubtree { writer_key: WRITER_KEY };
        /* No lease at all. */
        assert_eq!(
            authorize_mutation(&"a".repeat(64), CONTAINER, target).unwrap_err(),
            PUBLICATION_CAPABILITY_INVALID
        );
        begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap();
        for forged in ["", "short", &"z".repeat(64), &"a".repeat(63), &"A".repeat(64)] {
            assert_eq!(
                authorize_mutation(forged, CONTAINER, target).unwrap_err(),
                PUBLICATION_CAPABILITY_INVALID
            );
        }
    }

    #[test]
    fn the_binding_is_readable_only_with_the_capability() {
        let _serial = SERIAL.lock();
        let fx = fixture("binding");
        let grant = begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap();
        let bound = binding_core(&grant.capability).unwrap();
        assert_eq!(bound.object_domain, "studio.generic.v8c3.v1");
        assert_eq!(bound.object_id, "object-one");
        assert_eq!(bound.revision_id, "object-one-r1");
        assert_eq!(bound.revision_blob_sha256, BLOB);
        assert_eq!(bound.writer_key, WRITER_KEY);
        assert_eq!(bound.layout_epoch, LAYOUT_EPOCH_V2);
        assert_eq!(bound.container_path_sha256_hex, CONTAINER);
        assert_eq!(
            binding_core(&"a".repeat(64)).unwrap_err(),
            PUBLICATION_CAPABILITY_INVALID
        );
    }

    /*
     * The un-bypassability proof: the raw storage substrate refuses to mutate
     * anything when the governed authority says no, and accepts exactly the
     * bound target when it says yes.
     */
    #[test]
    fn raw_storage_mutation_cannot_bypass_the_governed_authority() {
        let _serial = SERIAL.lock();
        let fx = fixture("bypass");
        let final_rel = format!("objects/{OBJECT_KEY}/revisions/{BLOB}.json");
        let pending_rel = format!("{final_rel}.pending-{OTHER_BLOB}");
        let bytes = crate::p02_writer_storage::base64_encode_for_tests(b"governed");

        /* No lease open: every mutating entry point fails closed. */
        let deny = |target: MutationTarget<'_>| {
            authorize_mutation(&"a".repeat(64), CONTAINER, target)
        };
        assert_eq!(
            write_temporary_core(&fx.root, &pending_rel, &bytes, deny).unwrap_err(),
            PUBLICATION_CAPABILITY_INVALID
        );
        assert!(!fx.root.join("objects").exists(), "nothing was written");

        /* With the governed lease, the bound target is permitted. */
        let grant = begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap();
        let capability = grant.capability.clone();
        let allow = |target: MutationTarget<'_>| {
            authorize_mutation(&capability, CONTAINER, target)
        };
        write_temporary_core(&fx.root, &pending_rel, &bytes, allow).unwrap();
        let allow2 = |target: MutationTarget<'_>| {
            authorize_mutation(&capability, CONTAINER, target)
        };
        promote_temporary_core(&fx.root, &pending_rel, &final_rel, false, allow2).unwrap();
        assert!(fx.root.join(&final_rel).is_file());

        /* A different object under the same open lease is still refused. */
        let foreign_final = format!("objects/{OTHER_OBJECT}/revisions/{BLOB}.json");
        let foreign_pending = format!("{foreign_final}.pending-{OTHER_BLOB}");
        let allow3 = |target: MutationTarget<'_>| {
            authorize_mutation(&capability, CONTAINER, target)
        };
        assert_eq!(
            write_temporary_core(&fx.root, &foreign_pending, &bytes, allow3).unwrap_err(),
            PUBLICATION_TARGET_NOT_AUTHORIZED
        );
        assert!(!fx.root.join("objects").join(OTHER_OBJECT).exists());
    }

    /* Path confinement from V8-B still applies underneath the new gate. */
    #[test]
    fn confinement_still_precedes_authorization() {
        let _serial = SERIAL.lock();
        let fx = fixture("confine");
        let grant = begin_core(&fx.root, CONTAINER, TEST_BOOT_ID, &request()).unwrap();
        let capability = grant.capability.clone();
        for attempt in ["library.info.json", "../h2o-local-publication.v1.json", "/etc/passwd"] {
            let allow = |target: MutationTarget<'_>| {
                authorize_mutation(&capability, CONTAINER, target)
            };
            let error = write_temporary_core(&fx.root, attempt, "eA==", allow).unwrap_err();
            assert_ne!(error, PUBLICATION_TARGET_NOT_AUTHORIZED, "rejected as a path, not as authority");
            assert!(parse_storage_path(attempt).is_err());
        }
        assert!(fx.root.join(P02_AUTHORITY_FILE).is_file());
    }
}
