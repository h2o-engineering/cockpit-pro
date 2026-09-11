/*
 * P02 O1-T17 — dormant steady publication lease.
 *
 * V8-C3a opened a write window for the FIRST publication of a writer. Steady
 * publication is the other side: publication N+1, over a writer that already
 * owns a pointer. It needs its own authority because its preconditions are
 * inverted - C3a refuses when a pointer exists, steady requires one - and
 * because it must additionally prove that this repository has actually been
 * handed to the P02 generation.
 *
 * IT IS DORMANT. Every grant path below refuses today, because the
 * writer-generation record it requires does not exist in any repository and
 * this module never creates one. That is not an accident of ordering: the
 * record is written by the governed standdown ceremony (O1-T19), and until
 * that ceremony has run, steady publication has no authority to open a window.
 * Building the refusal first means the dormancy is proven rather than assumed.
 *
 * MODE-INDEPENDENT. The grant predicate deliberately does NOT consult the C5
 * automatic-mode decision. C5 is the authority over whether the SCHEDULER may
 * dispatch unattended, which is a question about when work runs; this is the
 * question of whether the process may mutate the repository at all. Folding C5
 * in here would make a future manual "Send now" - an explicit operator action -
 * depend on automatic mode being enabled, which is exactly backwards. The same
 * lease architecture serves both, and the mode check stays where it belongs.
 *
 * THE GENERATION RECORD MUST BE POSITIVELY OBSERVED. Absent is a refusal.
 * Unreadable is a refusal. Present-but-not-`p02` is a refusal. Only a machine
 * read that returns the p02 generation grants, because the alternative - "we
 * could not tell, so assume it is ours" - is how two generations end up writing
 * the same repository.
 *
 * The read contract is defined here; the WRITE side belongs to the T19
 * standdown ceremony, which is the only thing authorized to declare a
 * repository handed over. Nothing in this module writes anything, anywhere.
 *
 * Lease mechanics are C3a's, reused deliberately: 32 bytes of kernel entropy,
 * a TTL, one process slot, constant-time comparison, a closed mutation target
 * set, and a poisoned mutex that fails closed. The schema and error namespace
 * are distinct so a steady capability can never be mistaken for, or replayed
 * as, a first-publication one.
 */

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::Manager;
use serde::{Deserialize, Serialize};

use crate::p02_activation::{P02_AUTHORITY_FILE, P02_LIBRARY_INFO_SCHEMA};
use crate::sync_contract_v2::{FORMAT_VERSION_V2, LAYOUT_EPOCH_V2, PROTOCOL_VERSION_V2};

/* Distinct from the C3a lease so the two can never be confused. */
pub const STEADY_LEASE_SCHEMA: &str = "h2o.studio.syncSteadyPublicationLease.p02.v1";
pub const WRITER_GENERATION_FILE: &str = "generation.json";
pub const WRITER_GENERATION_SCHEMA: &str = "h2o.studio.syncWriterGeneration.p02.v1";
pub const WRITER_GENERATION_P02: &str = "p02";

const STEADY_LEASE_TTL: Duration = Duration::from_secs(300);

/* `p02-steady-*` throughout: a steady refusal is never mistaken for a C3a one. */
pub const STEADY_NOT_ACTIVATED: &str = "p02-steady-format-authority-not-activated";
pub const STEADY_LAYOUT_EPOCH_MISMATCH: &str = "p02-steady-layout-epoch-mismatch";
pub const STEADY_GENERATION_RECORD_ABSENT: &str = "p02-steady-writer-generation-absent";
pub const STEADY_GENERATION_RECORD_UNREADABLE: &str = "p02-steady-writer-generation-unreadable";
pub const STEADY_GENERATION_NOT_P02: &str = "p02-steady-writer-generation-not-p02";
pub const STEADY_CONTAINER_MISMATCH: &str = "p02-steady-container-mismatch";
pub const STEADY_POINTER_ABSENT: &str = "p02-steady-writer-pointer-absent";
pub const STEADY_POINTER_MISMATCH: &str = "p02-steady-writer-pointer-mismatch";
pub const STEADY_BOOT_SESSION_MISMATCH: &str = "p02-steady-boot-session-mismatch";
pub const STEADY_REQUEST_INVALID: &str = "p02-steady-request-invalid";
pub const STEADY_LEASE_ACTIVE: &str = "p02-steady-lease-active";
pub const STEADY_LEASE_UNAVAILABLE: &str = "p02-steady-lease-unavailable";
pub const STEADY_CAPABILITY_INVALID: &str = "p02-steady-capability-invalid";
pub const STEADY_CAPABILITY_EXPIRED: &str = "p02-steady-capability-expired";
pub const STEADY_TARGET_NOT_AUTHORIZED: &str = "p02-steady-target-not-authorized";
pub const STEADY_ENTROPY_UNAVAILABLE: &str = "p02-steady-entropy-unavailable";

#[derive(Clone, Debug)]
struct SteadyLease {
    capability: String,
    created: Instant,
    writer_key: String,
    container_path_sha256_hex: String,
    layout_epoch: u64,
    object_key: String,
    revision_blob_sha256: String,
    boot_id: String,
}

impl SteadyLease {
    fn expired(&self, now: Instant) -> bool {
        now.duration_since(self.created) >= STEADY_LEASE_TTL
    }
}

fn steady_lease_cell() -> &'static Mutex<Option<SteadyLease>> {
    static CELL: OnceLock<Mutex<Option<SteadyLease>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/* A poisoned mutex must never read as "no lease held" and open the gate. */
fn steady_lease_locked<T>(
    action: impl FnOnce(&mut Option<SteadyLease>) -> T,
) -> Result<T, &'static str> {
    let mut guard = steady_lease_cell()
        .lock()
        .map_err(|_| STEADY_LEASE_UNAVAILABLE)?;
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

/* 32 bytes from the kernel CSPRNG. No fallback: entropy failure fails the
 * authorization rather than degrading the capability. */
fn random_capability_hex() -> Result<String, &'static str> {
    let mut buffer = [0_u8; 32];
    let code = unsafe {
        libc::getentropy(
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len() as libc::size_t,
        )
    };
    if code != 0 {
        return Err(STEADY_ENTROPY_UNAVAILABLE);
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
pub struct P02SteadyBeginRequest {
    pub writer_sync_peer_id: String,
    pub writer_key: String,
    pub expected_container_path_sha256_hex: String,
    pub expected_layout_epoch: u64,
    pub object_domain: String,
    pub object_id: String,
    pub object_key: String,
    pub revision_id: String,
    pub revision_blob_sha256: String,
    /* The pointer this publication planned against. Steady publication ALWAYS
     * has a base, so there is no "absent" case to accept here. */
    pub expected_current_heads_snapshot_sha256: String,
    /* The live profile-lock session identity, proving this request came from
     * the process that holds the lock rather than a stale or foreign one. */
    pub boot_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P02SteadyLeaseGrant {
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
pub struct P02SteadyLeaseClosed {
    pub schema: &'static str,
    pub closed: bool,
    pub outcome: String,
}

/*
 * Check 1. The V7 authority must be exactly the supported, activated one, and
 * its layout epoch must match what the caller prepared against.
 */
fn require_activated_epoch(repository: &Path, expected_epoch: u64) -> Result<(), &'static str> {
    let bytes =
        std::fs::read(repository.join(P02_AUTHORITY_FILE)).map_err(|_| STEADY_NOT_ACTIVATED)?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| STEADY_NOT_ACTIVATED)?;
    let supported = value.get("schema").and_then(|item| item.as_str())
        == Some(P02_LIBRARY_INFO_SCHEMA)
        && value.get("formatVersion").and_then(|item| item.as_u64()) == Some(FORMAT_VERSION_V2)
        && value
            .get("minimumCompatibleProtocolVersion")
            .and_then(|item| item.as_u64())
            .is_some_and(|version| (1..=PROTOCOL_VERSION_V2).contains(&version));
    if !supported {
        return Err(STEADY_NOT_ACTIVATED);
    }
    let epoch = value
        .get("layoutEpoch")
        .and_then(|item| item.as_u64())
        .ok_or(STEADY_NOT_ACTIVATED)?;
    if epoch != LAYOUT_EPOCH_V2 || epoch != expected_epoch {
        return Err(STEADY_LAYOUT_EPOCH_MISMATCH);
    }
    Ok(())
}

/*
 * Checks 2, 3 and 4. The writer-generation record is MACHINE-READ and must
 * positively state the p02 generation.
 *
 * The three refusal cases are kept distinct on purpose. "Absent" means the
 * standdown ceremony has not run and steady publication is simply not yet
 * authorized - the ordinary dormant state. "Unreadable" means something is
 * there that we could not parse, which is an operational problem someone needs
 * to look at. "Not p02" means the repository is positively declared to belong
 * to the other generation, and writing to it would be a cross-generation
 * violation. Collapsing them would tell an operator the wrong story in two of
 * the three cases.
 */
/* O1-B1: exposed to the crate so the standdown executor READS BACK its own
 * repository write through the very reader the steady lease consults. A
 * second copy of this logic would be a second contract. */
pub(crate) fn require_p02_generation(repository: &Path, writer_key: &str) -> Result<(), &'static str> {
    read_p02_generation_record(repository, writer_key).map(|_| ())
}

/*
 * The generation record itself, read exactly once.
 *
 * `require_p02_generation` is the sole interpretation of this record in the
 * product and its verdict is unchanged - this is the same code, lifted so the
 * authority observer can also report the writerKey the DOCUMENT declares
 * without reading the file a second time. Two reads could disagree, and a
 * verdict that does not describe the bytes the caller is told about would be
 * worse than no report at all.
 *
 * `document_writer_key` is what the record says about itself. It is NOT the
 * directory it was found in and NOT the key the caller asked for; consumers
 * that need those must compare against their own value.
 */
pub(crate) struct P02GenerationRecord {
    pub(crate) document_writer_key: Option<String>,
}

pub(crate) fn read_p02_generation_record(
    repository: &Path,
    writer_key: &str,
) -> Result<P02GenerationRecord, &'static str> {
    let record = repository
        .join("writers")
        .join(writer_key)
        .join(WRITER_GENERATION_FILE);
    let bytes = match std::fs::read(&record) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(STEADY_GENERATION_RECORD_ABSENT);
        }
        Err(_) => return Err(STEADY_GENERATION_RECORD_UNREADABLE),
    };
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| STEADY_GENERATION_RECORD_UNREADABLE)?;
    if value.get("schema").and_then(|item| item.as_str()) != Some(WRITER_GENERATION_SCHEMA) {
        return Err(STEADY_GENERATION_RECORD_UNREADABLE);
    }
    let document_writer_key = value
        .get("writerKey")
        .and_then(|item| item.as_str())
        .map(str::to_string);
    match value.get("generation").and_then(|item| item.as_str()) {
        Some(WRITER_GENERATION_P02) => Ok(P02GenerationRecord { document_writer_key }),
        /* A record with no readable generation field is not a p02 declaration;
         * it is a record we cannot interpret. */
        None => Err(STEADY_GENERATION_RECORD_UNREADABLE),
        Some(_) => Err(STEADY_GENERATION_NOT_P02),
    }
}

/*
 * Check 6. The writer pointer must exist AND name the snapshot this
 * publication planned against. A pointer that moved since planning means the
 * plan was built on a base that is no longer current, and the write window
 * must not open over it.
 */
fn require_expected_pointer(
    repository: &Path,
    writer_key: &str,
    expected_current: &str,
) -> Result<(), &'static str> {
    let pointer = repository
        .join("writers")
        .join(writer_key)
        .join("state.json");
    let bytes = match std::fs::read(&pointer) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            /* No pointer means this is a FIRST publication, which is the C3a
             * path's business, not steady's. Steady refuses rather than
             * quietly handling a case another authority owns. */
            return Err(STEADY_POINTER_ABSENT);
        }
        Err(_) => return Err(STEADY_POINTER_MISMATCH),
    };
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| STEADY_POINTER_MISMATCH)?;
    let current = value
        .get("currentHeadsSnapshotSha256")
        .and_then(|item| item.as_str())
        .ok_or(STEADY_POINTER_MISMATCH)?;
    if current != expected_current {
        return Err(STEADY_POINTER_MISMATCH);
    }
    Ok(())
}

/*
 * The full mode-independent grant predicate. Every check is a refusal, and the
 * order is deliberate: cheap identity checks before any filesystem read, and
 * the generation record before the pointer, so a repository that was never
 * handed over reports that rather than a pointer detail.
 */
pub(crate) fn steady_begin_core(
    repository: &Path,
    container_path_sha256_hex: &str,
    live_boot_id: &str,
    request: &P02SteadyBeginRequest,
) -> Result<P02SteadyLeaseGrant, &'static str> {
    if !non_empty_bounded(&request.writer_sync_peer_id)
        || !non_empty_bounded(&request.object_domain)
        || !non_empty_bounded(&request.object_id)
        || !non_empty_bounded(&request.revision_id)
        || !is_lower_hex_64(&request.writer_key)
        || !is_lower_hex_64(&request.object_key)
        || !is_lower_hex_64(&request.revision_blob_sha256)
        || !is_lower_hex_64(&request.expected_container_path_sha256_hex)
        || !is_lower_hex_64(&request.expected_current_heads_snapshot_sha256)
        || !is_lower_hex_64(&request.boot_id)
    {
        return Err(STEADY_REQUEST_INVALID);
    }
    /* Check 7. The request must come from the process holding the profile
     * lock. A capability granted to a stale session could otherwise outlive
     * the process that earned it. */
    if !capability_matches(live_boot_id, &request.boot_id) {
        return Err(STEADY_BOOT_SESSION_MISMATCH);
    }
    /* Check 5. */
    if request.expected_container_path_sha256_hex != container_path_sha256_hex {
        return Err(STEADY_CONTAINER_MISMATCH);
    }
    require_activated_epoch(repository, request.expected_layout_epoch)?;
    require_p02_generation(repository, &request.writer_key)?;
    require_expected_pointer(
        repository,
        &request.writer_key,
        &request.expected_current_heads_snapshot_sha256,
    )?;

    let capability = random_capability_hex()?;
    let grant = P02SteadyLeaseGrant {
        schema: STEADY_LEASE_SCHEMA,
        capability: capability.clone(),
        writer_key: request.writer_key.clone(),
        object_key: request.object_key.clone(),
        revision_blob_sha256: request.revision_blob_sha256.clone(),
        layout_epoch: request.expected_layout_epoch,
        expires_in_seconds: STEADY_LEASE_TTL.as_secs(),
    };
    steady_lease_locked(|slot| {
        let now = Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
        }
        if slot.is_some() {
            return Err(STEADY_LEASE_ACTIVE);
        }
        *slot = Some(SteadyLease {
            capability,
            created: now,
            writer_key: request.writer_key.clone(),
            container_path_sha256_hex: container_path_sha256_hex.to_string(),
            layout_epoch: request.expected_layout_epoch,
            object_key: request.object_key.clone(),
            revision_blob_sha256: request.revision_blob_sha256.clone(),
            boot_id: request.boot_id.clone(),
        });
        Ok(())
    })??;
    Ok(grant)
}

/* The closed set a steady capability may name. Identical in shape to C3a's,
 * so a storage path cannot be redirected at another object or writer. */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SteadyMutationTarget<'a> {
    ObjectRevision {
        object_key: &'a str,
        revision_blob_sha256: &'a str,
    },
    WriterSubtree {
        writer_key: &'a str,
    },
}

/*
 * The live boot id is re-checked on every authorization, not just at grant.
 * A capability is bound to the session that earned it, so one cannot survive
 * a profile-lock handover and be replayed by a later process.
 */
pub(crate) fn steady_authorize_core(
    capability: &str,
    container_path_sha256_hex: &str,
    live_boot_id: &str,
    target: SteadyMutationTarget<'_>,
) -> Result<(), &'static str> {
    if !is_lower_hex_64(capability) {
        return Err(STEADY_CAPABILITY_INVALID);
    }
    steady_lease_locked(|slot| {
        let now = Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
            return Err(STEADY_CAPABILITY_EXPIRED);
        }
        let lease = slot.as_ref().ok_or(STEADY_CAPABILITY_INVALID)?;
        if !capability_matches(&lease.capability, capability) {
            return Err(STEADY_CAPABILITY_INVALID);
        }
        if lease.container_path_sha256_hex != container_path_sha256_hex {
            return Err(STEADY_CONTAINER_MISMATCH);
        }
        if !capability_matches(&lease.boot_id, live_boot_id) {
            return Err(STEADY_BOOT_SESSION_MISMATCH);
        }
        match target {
            SteadyMutationTarget::ObjectRevision {
                object_key,
                revision_blob_sha256,
            } => {
                if lease.object_key != object_key
                    || lease.revision_blob_sha256 != revision_blob_sha256
                {
                    return Err(STEADY_TARGET_NOT_AUTHORIZED);
                }
            }
            SteadyMutationTarget::WriterSubtree { writer_key } => {
                if lease.writer_key != writer_key {
                    return Err(STEADY_TARGET_NOT_AUTHORIZED);
                }
            }
        }
        Ok(())
    })?
}

pub(crate) fn steady_finish_core(capability: &str, outcome: &str) -> Result<bool, String> {
    if !is_lower_hex_64(capability) {
        return Err(STEADY_CAPABILITY_INVALID.to_string());
    }
    if !non_empty_bounded(outcome) {
        return Err(STEADY_REQUEST_INVALID.to_string());
    }
    steady_lease_locked(|slot| {
        let matched = slot
            .as_ref()
            .is_some_and(|lease| capability_matches(&lease.capability, capability));
        if !matched {
            return Err(STEADY_CAPABILITY_INVALID.to_string());
        }
        *slot = None;
        Ok(true)
    })
    .map_err(str::to_string)?
}

/* Test-only reset so the process-global slot cannot leak between cases. */
/*
 * O1-R3 — the narrow, read-only lease-authority question the operator preflight
 * asks before a bounded steady pass.
 *
 * The generic P02 storage command deliberately allowlists only three path
 * shapes, and `writers/<key>/generation.json` is not among them. Widening that
 * allowlist to answer this one question would turn a narrow protocol surface
 * into a general file reader, so instead this answers the SEMANTIC question -
 * "what does this writer's lease authority currently say?" - and never takes a
 * path at all.
 *
 * It delegates to `require_p02_generation`, the same reader the steady lease
 * itself consults, so there is exactly one interpretation of this record in the
 * product. The four answers stay distinguishable: absence is a fact observed,
 * and everything else is ignorance that must refuse.
 *
 * READ ONLY. No write path exists here.
 */
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P02WriterGenerationAuthority {
    pub schema: &'static str,
    /* 'p02' | 'not-p02' | 'absent' | 'unreadable' */
    pub state: &'static str,
    pub repository_root: String,
    /* The key the CALLER asked about - the echoed request argument. */
    pub writer_key: String,
    /*
     * The key the DOCUMENT declares. Present only when the record parsed and
     * carries a string writerKey. Never conflate it with `writer_key` above:
     * only this field is evidence about the record, and a consumer that must
     * bind a record to a writer has to compare THIS against its own expectation.
     * Additive and optional, so existing callers that read only `state` are
     * unaffected.
     */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_writer_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

pub const WRITER_GENERATION_AUTHORITY_SCHEMA: &str =
    "h2o.studio.syncWriterGenerationAuthority.p02.v1";
pub const AUTHORITY_WRITER_KEY_INVALID: &str = "p02-steady-authority-writer-key-invalid";

pub(crate) fn read_generation_authority_core(
    repository_root: &Path,
    writer_key: &str,
) -> P02WriterGenerationAuthority {
    let (state, reason, document_writer_key) =
        match read_p02_generation_record(repository_root, writer_key) {
            Ok(record) => ("p02", None, record.document_writer_key),
            Err(code) if code == STEADY_GENERATION_RECORD_ABSENT => ("absent", Some(code), None),
            Err(code) if code == STEADY_GENERATION_RECORD_UNREADABLE => {
                ("unreadable", Some(code), None)
            }
            Err(code) => ("not-p02", Some(code), None),
        };
    P02WriterGenerationAuthority {
        schema: WRITER_GENERATION_AUTHORITY_SCHEMA,
        state,
        repository_root: repository_root.to_string_lossy().to_string(),
        writer_key: writer_key.to_string(),
        document_writer_key,
        reason,
    }
}

/*
 * The command. The repository is resolved from the profile's own binding, never
 * supplied; the writer key is a 64-hex directory name, validated exactly as the
 * publication authority validates its own, so it cannot escape `writers/`.
 */
#[tauri::command]
pub fn h2o_p02_read_writer_generation_authority(
    app: tauri::AppHandle,
    writer_key: String,
) -> Result<P02WriterGenerationAuthority, String> {
    if !crate::sync_object_document::is_lower_hex_64(&writer_key) {
        return Err(AUTHORITY_WRITER_KEY_INVALID.to_string());
    }
    let authorization_root = app
        .path()
        .app_data_dir()
        .map_err(|_| STEADY_TARGET_NOT_AUTHORIZED.to_string())?
        .join("item11-delivery");
    let target =
        crate::p02_activation::resolve_target_core(&authorization_root).map_err(str::to_string)?;
    Ok(read_generation_authority_core(
        &PathBuf::from(&target.repository_root),
        &writer_key,
    ))
}

#[cfg(test)]
pub(crate) fn steady_reset_for_tests() {
    if let Ok(mut guard) = steady_lease_cell().lock() {
        *guard = None;
    }
}

/*
 * O1-R3 B2 — the steady write window, made reachable.
 *
 * These two commands add NO authority. Every check that decides whether a
 * steady publication may proceed - boot session, container hash, activated
 * layout epoch, the p02 writer-generation record and the expected CAS pointer -
 * already lives in `steady_begin_core`, and that is the only thing either
 * command calls. They exist because the accepted steady driver runs in the JS
 * realm, and until now the window it needs had no IPC surface at all.
 *
 * REACHABLE IS NOT AUTONOMOUS. Nothing in ordinary startup calls these; there
 * is no timer, listener or background caller anywhere. The one production path
 * that composes them is the governed B2 operator ceremony, which runs only for
 * an explicitly authorized request. That distinction is what the narrowed
 * dormancy pins now assert, and it is the property that must survive.
 *
 * THIS IS NOT THE FIRST-PUBLICATION LEASE. `h2o_p02_publication_begin` remains
 * the V8-D first-writer window and refuses once a writer pointer exists; steady
 * publishes descendants of a lineage that ceremony established. Neither may
 * stand in for the other, and `steady_begin_core` requires a real CAS base
 * precisely so a virgin writer cannot be onboarded here by accident.
 */
#[tauri::command]
pub fn h2o_p02_steady_begin(
    app: tauri::AppHandle,
    request: P02SteadyBeginRequest,
) -> Result<P02SteadyLeaseGrant, String> {
    /* The repository is the binding's, never the request's. */
    let authorization_root = app
        .path()
        .app_data_dir()
        .map_err(|_| STEADY_TARGET_NOT_AUTHORIZED.to_string())?
        .join("item11-delivery");
    let target =
        crate::p02_activation::resolve_target_core(&authorization_root).map_err(str::to_string)?;
    /* The live profile-lock session, read here rather than taken from the
     * caller, so a capability cannot be opened from a stale webview. */
    let boot_id = crate::sync_object_transport::live_session_boot_id(&app)?;
    steady_begin_core(
        &PathBuf::from(&target.repository_root),
        &target.container_path_sha256_hex,
        &boot_id,
        &request,
    )
    .map_err(str::to_string)
}

#[tauri::command]
pub fn h2o_p02_steady_finish(capability: String, outcome: String) -> Result<bool, String> {
    steady_finish_core(&capability, &outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    /* The lease is process-global, so authority cases must not interleave. */
    static SERIAL: Mutex<()> = Mutex::new(());

    const WRITER_KEY: &str =
        "1111111111111111111111111111111111111111111111111111111111111111";
    const OBJECT_KEY: &str =
        "2222222222222222222222222222222222222222222222222222222222222222";
    const REVISION_BLOB: &str =
        "3333333333333333333333333333333333333333333333333333333333333333";
    const CONTAINER: &str =
        "4444444444444444444444444444444444444444444444444444444444444444";
    const SNAPSHOT: &str =
        "5555555555555555555555555555555555555555555555555555555555555555";
    const BOOT_ID: &str =
        "6666666666666666666666666666666666666666666666666666666666666666";

    fn scratch() -> PathBuf {
        let index = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "p02-steady-{}-{index}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    fn write_authority(repository: &Path) {
        fs::write(
            repository.join(P02_AUTHORITY_FILE),
            serde_json::json!({
                "schema": P02_LIBRARY_INFO_SCHEMA,
                "formatVersion": FORMAT_VERSION_V2,
                "minimumCompatibleProtocolVersion": PROTOCOL_VERSION_V2,
                "layoutEpoch": LAYOUT_EPOCH_V2
            })
            .to_string(),
        )
        .expect("authority");
    }

    fn write_pointer(repository: &Path, snapshot: &str) {
        let dir = repository.join("writers").join(WRITER_KEY);
        fs::create_dir_all(&dir).expect("writer dir");
        fs::write(
            dir.join("state.json"),
            serde_json::json!({
                "schema": "h2o.studio.syncWriterState.v1",
                "writerSyncPeerId": "studio-desktop:tauri-desktop:sqlite:steady",
                "currentHeadsSnapshotSha256": snapshot
            })
            .to_string(),
        )
        .expect("pointer");
    }

    /*
     * DISPOSABLE ONLY. This writes a generation record into a scratch
     * directory so the refusal path can be distinguished from the grant path.
     * No production code creates one, and no real repository is touched.
     */
    fn write_generation_for_test(repository: &Path, generation: &str) {
        let dir = repository.join("writers").join(WRITER_KEY);
        fs::create_dir_all(&dir).expect("writer dir");
        fs::write(
            dir.join(WRITER_GENERATION_FILE),
            serde_json::json!({
                "schema": WRITER_GENERATION_SCHEMA,
                "generation": generation
            })
            .to_string(),
        )
        .expect("generation");
    }

    fn request() -> P02SteadyBeginRequest {
        P02SteadyBeginRequest {
            writer_sync_peer_id: "studio-desktop:tauri-desktop:sqlite:steady".into(),
            writer_key: WRITER_KEY.into(),
            expected_container_path_sha256_hex: CONTAINER.into(),
            expected_layout_epoch: LAYOUT_EPOCH_V2,
            object_domain: "studio.chat.saved-state.v1".into(),
            object_id: "chat-steady".into(),
            object_key: OBJECT_KEY.into(),
            revision_id: "p02-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            revision_blob_sha256: REVISION_BLOB.into(),
            expected_current_heads_snapshot_sha256: SNAPSHOT.into(),
            boot_id: BOOT_ID.into(),
        }
    }

    /// DORMANCY. With no writer-generation record, steady begin refuses - which
    /// is the state of every repository today, since nothing creates one.
    #[test]
    fn steady_begin_refuses_when_generation_record_is_absent() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        steady_reset_for_tests();
        let repository = scratch();
        write_authority(&repository);
        write_pointer(&repository, SNAPSHOT);

        assert_eq!(
            steady_begin_core(&repository, CONTAINER, BOOT_ID, &request()).unwrap_err(),
            STEADY_GENERATION_RECORD_ABSENT
        );
        let _ = fs::remove_dir_all(&repository);
    }

    /// DORMANCY. An unreadable record is refused too, and distinctly - it is an
    /// operational problem, not the ordinary not-yet-handed-over state.
    #[test]
    fn steady_begin_refuses_when_generation_record_is_unreadable() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        steady_reset_for_tests();
        let repository = scratch();
        write_authority(&repository);
        write_pointer(&repository, SNAPSHOT);
        let dir = repository.join("writers").join(WRITER_KEY);
        fs::write(dir.join(WRITER_GENERATION_FILE), "not json").expect("garbage");

        assert_eq!(
            steady_begin_core(&repository, CONTAINER, BOOT_ID, &request()).unwrap_err(),
            STEADY_GENERATION_RECORD_UNREADABLE
        );

        /* A record of the right shape but a foreign schema is equally
         * uninterpretable, not a p02 declaration. */
        fs::write(
            dir.join(WRITER_GENERATION_FILE),
            serde_json::json!({ "schema": "someone.else.v1", "generation": "p02" }).to_string(),
        )
        .expect("foreign");
        assert_eq!(
            steady_begin_core(&repository, CONTAINER, BOOT_ID, &request()).unwrap_err(),
            STEADY_GENERATION_RECORD_UNREADABLE
        );
        let _ = fs::remove_dir_all(&repository);
    }

    /// A record positively declaring the OTHER generation is a cross-generation
    /// refusal, reported distinctly from absence.
    #[test]
    fn steady_begin_refuses_a_non_p02_generation() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        steady_reset_for_tests();
        let repository = scratch();
        write_authority(&repository);
        write_pointer(&repository, SNAPSHOT);
        write_generation_for_test(&repository, "p01");

        assert_eq!(
            steady_begin_core(&repository, CONTAINER, BOOT_ID, &request()).unwrap_err(),
            STEADY_GENERATION_NOT_P02
        );
        let _ = fs::remove_dir_all(&repository);
    }

    /// With no pointer, steady refuses and leaves the first-publication path
    /// authoritative rather than quietly handling a case it does not own.
    #[test]
    fn steady_begin_refuses_when_the_pointer_is_absent() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        steady_reset_for_tests();
        let repository = scratch();
        write_authority(&repository);
        write_generation_for_test(&repository, WRITER_GENERATION_P02);

        assert_eq!(
            steady_begin_core(&repository, CONTAINER, BOOT_ID, &request()).unwrap_err(),
            STEADY_POINTER_ABSENT
        );
        let _ = fs::remove_dir_all(&repository);
    }

    /// A pointer that moved since planning refuses: the plan's base is stale.
    #[test]
    fn steady_begin_refuses_a_pointer_that_moved() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        steady_reset_for_tests();
        let repository = scratch();
        write_authority(&repository);
        write_generation_for_test(&repository, WRITER_GENERATION_P02);
        write_pointer(&repository, &"7".repeat(64));

        assert_eq!(
            steady_begin_core(&repository, CONTAINER, BOOT_ID, &request()).unwrap_err(),
            STEADY_POINTER_MISMATCH
        );
        let _ = fs::remove_dir_all(&repository);
    }

    /// A request from a session other than the one holding the profile lock is
    /// refused before any filesystem read.
    #[test]
    fn steady_begin_refuses_a_foreign_boot_session() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        steady_reset_for_tests();
        let repository = scratch();
        write_authority(&repository);
        write_generation_for_test(&repository, WRITER_GENERATION_P02);
        write_pointer(&repository, SNAPSHOT);

        assert_eq!(
            steady_begin_core(&repository, CONTAINER, &"8".repeat(64), &request()).unwrap_err(),
            STEADY_BOOT_SESSION_MISMATCH
        );
        let _ = fs::remove_dir_all(&repository);
    }

    /// An unactivated or wrong-epoch repository refuses.
    #[test]
    fn steady_begin_refuses_an_unactivated_repository() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        steady_reset_for_tests();
        let repository = scratch();
        write_generation_for_test(&repository, WRITER_GENERATION_P02);
        write_pointer(&repository, SNAPSHOT);

        assert_eq!(
            steady_begin_core(&repository, CONTAINER, BOOT_ID, &request()).unwrap_err(),
            STEADY_NOT_ACTIVATED
        );

        write_authority(&repository);
        let mut mismatched = request();
        mismatched.expected_layout_epoch = LAYOUT_EPOCH_V2 + 1;
        assert_eq!(
            steady_begin_core(&repository, CONTAINER, BOOT_ID, &mismatched).unwrap_err(),
            STEADY_LAYOUT_EPOCH_MISMATCH
        );
        let _ = fs::remove_dir_all(&repository);
    }

    /// A different container refuses even when everything else lines up.
    #[test]
    fn steady_begin_refuses_a_foreign_container() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        steady_reset_for_tests();
        let repository = scratch();
        write_authority(&repository);
        write_generation_for_test(&repository, WRITER_GENERATION_P02);
        write_pointer(&repository, SNAPSHOT);

        assert_eq!(
            steady_begin_core(&repository, &"9".repeat(64), BOOT_ID, &request()).unwrap_err(),
            STEADY_CONTAINER_MISMATCH
        );
        let _ = fs::remove_dir_all(&repository);
    }

    /// The lease mechanics: one slot, a narrow target set, and release.
    #[test]
    fn steady_lease_is_single_slot_narrow_and_releasable() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        steady_reset_for_tests();
        let repository = scratch();
        write_authority(&repository);
        write_generation_for_test(&repository, WRITER_GENERATION_P02);
        write_pointer(&repository, SNAPSHOT);

        let grant = steady_begin_core(&repository, CONTAINER, BOOT_ID, &request())
            .expect("a fully satisfied steady request grants");
        assert_eq!(grant.schema, STEADY_LEASE_SCHEMA);
        assert_eq!(grant.capability.len(), 64);
        assert_ne!(grant.capability, "0".repeat(64));

        /* One process slot. */
        assert_eq!(
            steady_begin_core(&repository, CONTAINER, BOOT_ID, &request()).unwrap_err(),
            STEADY_LEASE_ACTIVE
        );

        /* The capability names exactly one object and one writer subtree. */
        assert!(steady_authorize_core(
            &grant.capability,
            CONTAINER,
            BOOT_ID,
            SteadyMutationTarget::ObjectRevision {
                object_key: OBJECT_KEY,
                revision_blob_sha256: REVISION_BLOB,
            }
        )
        .is_ok());

        /* A capability cannot outlive the session that earned it. */
        assert_eq!(
            steady_authorize_core(
                &grant.capability,
                CONTAINER,
                &"d".repeat(64),
                SteadyMutationTarget::ObjectRevision {
                    object_key: OBJECT_KEY,
                    revision_blob_sha256: REVISION_BLOB,
                }
            )
            .unwrap_err(),
            STEADY_BOOT_SESSION_MISMATCH
        );
        assert_eq!(
            steady_authorize_core(
                &grant.capability,
                CONTAINER,
                BOOT_ID,
                SteadyMutationTarget::ObjectRevision {
                    object_key: &"a".repeat(64),
                    revision_blob_sha256: REVISION_BLOB,
                }
            )
            .unwrap_err(),
            STEADY_TARGET_NOT_AUTHORIZED
        );
        assert_eq!(
            steady_authorize_core(
                &grant.capability,
                CONTAINER,
                BOOT_ID,
                SteadyMutationTarget::WriterSubtree {
                    writer_key: &"b".repeat(64)
                }
            )
            .unwrap_err(),
            STEADY_TARGET_NOT_AUTHORIZED
        );
        /* A wrong capability never authorizes. */
        assert_eq!(
            steady_authorize_core(
                &"c".repeat(64),
                CONTAINER,
                BOOT_ID,
                SteadyMutationTarget::WriterSubtree {
                    writer_key: WRITER_KEY
                }
            )
            .unwrap_err(),
            STEADY_CAPABILITY_INVALID
        );

        assert!(steady_finish_core(&grant.capability, "committed").expect("release"));
        assert_eq!(
            steady_authorize_core(
                &grant.capability,
                CONTAINER,
                BOOT_ID,
                SteadyMutationTarget::WriterSubtree {
                    writer_key: WRITER_KEY
                }
            )
            .unwrap_err(),
            STEADY_CAPABILITY_INVALID
        );
        let _ = fs::remove_dir_all(&repository);
    }

    /// A steady capability is not a C3a capability: the namespaces are
    /// disjoint, so one can never be replayed as the other.
    #[test]
    fn steady_namespace_is_disjoint_from_first_publication() {
        assert_ne!(
            STEADY_LEASE_SCHEMA,
            crate::p02_publication_authority::LEASE_SCHEMA
        );
        for code in [
            STEADY_NOT_ACTIVATED,
            STEADY_GENERATION_RECORD_ABSENT,
            STEADY_GENERATION_RECORD_UNREADABLE,
            STEADY_GENERATION_NOT_P02,
            STEADY_POINTER_ABSENT,
            STEADY_BOOT_SESSION_MISMATCH,
            STEADY_CAPABILITY_INVALID,
        ] {
            assert!(code.starts_with("p02-steady-"), "{code} is namespaced");
        }
    }

    /// MODE INDEPENDENCE. The grant predicate consults no automatic-mode input:
    /// the request carries none, so a future manual Send-now cannot be made to
    /// depend on automatic mode being enabled.
    #[test]
    fn steady_grant_predicate_is_mode_independent() {
        let source = include_str!("p02_steady_authority.rs");
        /* The predicate must not reference the C5 automatic-mode authority. */
        let predicate_start = source
            .find("pub(crate) fn steady_begin_core")
            .expect("predicate present");
        let predicate_end = source[predicate_start..]
            .find("\n}\n")
            .map(|offset| predicate_start + offset)
            .expect("predicate end");
        let predicate = &source[predicate_start..predicate_end];
        for forbidden in ["auto_mode", "automatic_mode", "c5_", "scheduler"] {
            assert!(
                !predicate.contains(forbidden),
                "steady grant predicate must not consult {forbidden}"
            );
        }
    }

    /// O1-R3: the narrow authority reader answers the four states through the
    /// SAME reader the lease uses, and never takes a path.
    #[test]
    fn generation_authority_reports_four_distinguishable_states() {
        let base = std::env::temp_dir().join(format!(
            "p02-authority-{}-{}",
            std::process::id(),
            line!()
        ));
        let repository = base.join("h2o-object-sync");
        let writer_key = "b".repeat(64);
        let directory = repository.join("writers").join(&writer_key);
        std::fs::create_dir_all(&directory).unwrap();

        /* absent */
        assert_eq!(read_generation_authority_core(&repository, &writer_key).state, "absent");

        /* unreadable */
        let record = directory.join(WRITER_GENERATION_FILE);
        std::fs::write(&record, b"{ not json").unwrap();
        assert_eq!(read_generation_authority_core(&repository, &writer_key).state, "unreadable");

        /* not-p02 */
        std::fs::write(&record, format!(
            "{{\"schema\":\"{WRITER_GENERATION_SCHEMA}\",\"generation\":\"p01\"}}"
        )).unwrap();
        assert_eq!(read_generation_authority_core(&repository, &writer_key).state, "not-p02");

        /* p02 */
        std::fs::write(&record, format!(
            "{{\"schema\":\"{WRITER_GENERATION_SCHEMA}\",\"generation\":\"p02\"}}"
        )).unwrap();
        let authority = read_generation_authority_core(&repository, &writer_key);
        assert_eq!(authority.state, "p02");
        assert_eq!(authority.writer_key, writer_key);
        assert!(authority.repository_root.ends_with("h2o-object-sync"));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The authority reader reports the writerKey the DOCUMENT declares, which
    /// is the evidence the echoed request argument can never supply.
    ///
    /// Reverse Receive used to read this record through the generic J.1 storage
    /// reader purely so it could assert the document's own writerKey. That read
    /// was rejected by the frozen path whitelist; routing it here preserves the
    /// assertion instead of dropping it.
    #[test]
    fn generation_authority_reports_the_documents_own_writer_key() {
        let base = std::env::temp_dir().join(format!(
            "p02-authority-docwriter-{}-{}",
            std::process::id(),
            line!()
        ));
        let repository = base.join("h2o-object-sync");
        let writer_key = "c".repeat(64);
        let other_key = "d".repeat(64);
        let directory = repository.join("writers").join(&writer_key);
        std::fs::create_dir_all(&directory).unwrap();
        let record = directory.join(WRITER_GENERATION_FILE);
        let write = |schema: &str, generation: &str, declared: Option<&str>| {
            let mut value = serde_json::json!({ "schema": schema, "generation": generation });
            if let Some(declared) = declared {
                value["writerKey"] = serde_json::Value::String(declared.to_string());
            }
            std::fs::write(&record, value.to_string()).unwrap();
        };

        /* A: schema + generation + declared key all correct. */
        write(WRITER_GENERATION_SCHEMA, WRITER_GENERATION_P02, Some(&writer_key));
        let authority = read_generation_authority_core(&repository, &writer_key);
        assert_eq!(authority.state, "p02");
        assert_eq!(authority.document_writer_key.as_deref(), Some(writer_key.as_str()));

        /* D: the record sits in the right directory but declares a DIFFERENT
         * writer. The state is still p02 - the record is a valid p02
         * declaration - so only the document key distinguishes it, and the
         * echoed request argument agrees with the caller either way. That is
         * exactly why `writer_key` cannot stand in for the check. */
        write(WRITER_GENERATION_SCHEMA, WRITER_GENERATION_P02, Some(&other_key));
        let authority = read_generation_authority_core(&repository, &writer_key);
        assert_eq!(authority.state, "p02");
        assert_eq!(authority.document_writer_key.as_deref(), Some(other_key.as_str()));
        assert_ne!(authority.document_writer_key.as_deref(), Some(writer_key.as_str()));
        assert_eq!(
            authority.writer_key, writer_key,
            "the echoed request argument still matches the caller and proves nothing"
        );

        /* A record that declares no writer at all yields no evidence. */
        write(WRITER_GENERATION_SCHEMA, WRITER_GENERATION_P02, None);
        let authority = read_generation_authority_core(&repository, &writer_key);
        assert_eq!(authority.state, "p02");
        assert!(authority.document_writer_key.is_none());

        /* B: wrong schema -> refused, and no document evidence is offered. */
        write("h2o.studio.syncWriterGeneration.v1", WRITER_GENERATION_P02, Some(&writer_key));
        let authority = read_generation_authority_core(&repository, &writer_key);
        assert_eq!(authority.state, "unreadable");
        assert!(authority.document_writer_key.is_none());

        /* C: wrong generation -> refused, and no document evidence is offered. */
        write(WRITER_GENERATION_SCHEMA, "p01", Some(&writer_key));
        let authority = read_generation_authority_core(&repository, &writer_key);
        assert_eq!(authority.state, "not-p02");
        assert!(authority.document_writer_key.is_none());

        /* The lease's own verdict is unchanged by the lift. */
        write(WRITER_GENERATION_SCHEMA, WRITER_GENERATION_P02, Some(&writer_key));
        assert!(require_p02_generation(&repository, &writer_key).is_ok());
        write(WRITER_GENERATION_SCHEMA, "p01", Some(&writer_key));
        assert_eq!(
            require_p02_generation(&repository, &writer_key).err(),
            Some(STEADY_GENERATION_NOT_P02)
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The reader is read-only and exposes no path parameter.
    #[test]
    fn the_authority_reader_takes_no_path_and_writes_nothing() {
        let source = include_str!("p02_steady_authority.rs");
        let production = &source[..source.find("#[cfg(test)]").expect("test module")];
        let start = production
            .find("pub fn h2o_p02_read_writer_generation_authority")
            .expect("command");
        let body = &production[start..];
        let body = &body[..body.find("\n}\n").map(|at| at + 2).unwrap_or(body.len())];
        assert!(!body.contains("relative_path"), "no path parameter");
        assert!(!body.contains("fs::write"), "read only");
        assert!(body.contains("resolve_target_core"), "repository comes from the binding");
        assert!(body.contains("is_lower_hex_64"), "writer key is shape-validated");
    }
}
