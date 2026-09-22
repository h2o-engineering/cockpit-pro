/*
 * O1-T19 — the Desktop writer-generation standdown EXECUTOR.
 *
 * `p02_steady_authority` has always refused to open a steady window until
 * `writers/<writerKey>/generation.json` declares p02, and the Desktop has only
 * ever been able to READ that record: `sync-writer-generation-desktop-v2` is a
 * read port with no write method, and the ceremony that produces the record was
 * left specified-but-not-executable. Chrome could write the repository record
 * through its own fixed-purpose transport; the Desktop could not, so a
 * Desktop-first installation had no governed way to complete the handover at
 * all. This module is that missing write side, and nothing else.
 *
 * IT IS NOT A GENERATION SETTER. There is no argument that names a repository,
 * no argument that names a file, and no argument that carries a record. The
 * repository comes from the profile's own Item-11 binding, the path is composed
 * here from one validated writer key, and every field of the document is either
 * a constant of this module or a value the caller has to prove it owns. A
 * caller can decide WHETHER the governed handover happens; it cannot decide
 * WHAT is written or WHERE.
 *
 * THE WRITER KEY MUST BE EARNED, NOT ASSERTED. The request carries the writer
 * sync-peer id as well as the key, and the key must be exactly
 * sha256("h2o.studio.sync-writer.v1" 0x00 <syncPeerId>) — the same derivation
 * `writerKeyHex` performs in `sync-contract-v2`. A caller that cannot name the
 * identity cannot reach the directory, so `writers/<key>` can be neither
 * traversed nor guessed.
 *
 * CREATE-ONLY, AND THE READBACK IS THE VERDICT. An existing record that already
 * declares this writer's p02 standdown is the idempotent replay and is accepted
 * without a write; anything else present — a different writer key, a non-p02
 * generation, bytes that will not parse — refuses rather than overwrites,
 * because the record is the one durable fact that decides which generation owns
 * the installation's data. After persistence the module re-reads through
 * `p02_steady_authority::require_p02_generation`, the very reader the steady
 * lease consults, and reports failure if that reader would not accept what was
 * written. A write this module cannot prove is not a successful standdown.
 *
 * REACHABLE IS NOT AUTONOMOUS. One `#[tauri::command]` exists; nothing in
 * startup, no timer, no listener and no other module calls the core. It
 * publishes nothing, receives nothing, applies nothing and opens no lease.
 */
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::p02_steady_authority::{
    read_p02_generation_record, require_p02_generation, STEADY_GENERATION_NOT_P02,
    STEADY_GENERATION_RECORD_ABSENT, STEADY_GENERATION_RECORD_UNREADABLE, WRITER_GENERATION_FILE,
    WRITER_GENERATION_P02, WRITER_GENERATION_SCHEMA,
};
use crate::sync_object_document::is_lower_hex_64;

/*
 * The governed gate. Same shape as the accepted V7 activation and V8-D
 * publication ceremonies: two tokens the operator supplies, checked before
 * anything is read, so an unauthorized call cannot even learn whether a
 * repository is bound.
 */
pub const T19_GOVERNED_CAMPAIGN_TOKEN: &str = "P02_O1_T19_DESKTOP_WRITER_GENERATION_STANDDOWN";
pub const T19_OPERATOR_AUTHORIZATION_TOKEN: &str =
    "P02_O1_T19_OPERATOR_AUTHORIZED_DESKTOP_WRITER_GENERATION_STANDDOWN";

/* The fixed reason this module writes. It is a constant precisely so no caller
 * can describe the decision as something it was not. */
pub const T19_STANDDOWN_REASON: &str =
    "human-authorized-desktop-o1-t19-writer-generation-standdown";

/* The identity domain of `writerKeyHex` in sync-contract-v2. Duplicating the
 * string is unavoidable across the language boundary; duplicating the RULE is
 * not, so the derivation is asserted against the caller's own key below. */
const WRITER_KEY_DOMAIN: &[u8] = b"h2o.studio.sync-writer.v1";

const TEMPORARY_SUFFIX: &str = ".pending-t19";
const MAX_SYNC_PEER_ID_BYTES: usize = 512;
const MAX_TIMESTAMP_BYTES: usize = 64;

pub const STANDDOWN_NOT_AUTHORIZED: &str = "p02-t19-standdown-not-authorized";
pub const STANDDOWN_ATTESTATION_MISSING: &str = "p02-t19-standdown-attestation-missing";
pub const STANDDOWN_REQUEST_INVALID: &str = "p02-t19-standdown-request-invalid";
pub const STANDDOWN_WRITER_IDENTITY_MISMATCH: &str = "p02-t19-standdown-writer-identity-mismatch";
pub const STANDDOWN_TARGET_NOT_AUTHORIZED: &str = "p02-t19-standdown-target-not-authorized";
pub const STANDDOWN_CONTAINER_MISMATCH: &str = "p02-t19-standdown-container-mismatch";
pub const STANDDOWN_NOT_ACTIVATED: &str = "p02-t19-standdown-format-authority-not-activated";
pub const STANDDOWN_EXISTING_RECORD_CONFLICT: &str = "p02-t19-standdown-existing-record-conflict";
pub const STANDDOWN_EXISTING_RECORD_UNSAFE: &str = "p02-t19-standdown-existing-record-unsafe";
pub const STANDDOWN_PERSISTENCE_FAILED: &str = "p02-t19-standdown-persistence-failed";
pub const STANDDOWN_READBACK_REJECTED: &str = "p02-t19-standdown-readback-rejected";

pub const STANDDOWN_RECEIPT_SCHEMA: &str = "h2o.studio.syncWriterGenerationStanddownReceipt.p02.v1";

/*
 * The attestations the accepted T19 ceremony requires BEFORE step 6
 * (`write-generation-p02`): the foundation check (step 1), the drained and
 * verified P01 writer (steps 2-4) and the reconciled retained P02 intents
 * (step 5). They are carried as three separate positives rather than one
 * "confirm" flag so a caller cannot satisfy the ceremony by asserting less than
 * it actually performed.
 */
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P01StanddownRequest {
    pub governed_campaign: String,
    pub operator_authorization: String,
    pub writer_key: String,
    pub writer_sync_peer_id: String,
    pub expected_container_path_sha256_hex: String,
    pub standdown_at: String,
    pub p02_foundation_verified: bool,
    pub p01_mutation_drained: bool,
    pub retained_p02_intents_reconciled: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P01StanddownReceipt {
    pub schema: &'static str,
    pub writer_key: String,
    pub generation: &'static str,
    pub reason: &'static str,
    /* False on the idempotent replay: the record was already this writer's p02
     * standdown, so nothing was written and nothing needed to be. */
    pub created: bool,
    /* Always the verdict of `require_p02_generation`, never of this module. */
    pub readback_verified: bool,
}

#[derive(Serialize)]
struct GenerationDocument<'a> {
    schema: &'a str,
    generation: &'a str,
    #[serde(rename = "standdownAt")]
    standdown_at: &'a str,
    #[serde(rename = "decidedByWriterSyncPeerId")]
    decided_by_writer_sync_peer_id: &'a str,
    reason: &'a str,
    #[serde(rename = "writerKey")]
    writer_key: &'a str,
}

fn derive_writer_key(writer_sync_peer_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(WRITER_KEY_DOMAIN);
    hash.update([0]);
    hash.update(writer_sync_peer_id.as_bytes());
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn bounded_non_empty(value: &str, maximum: usize) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() == value.len()
        && value.len() <= maximum
        && !value.chars().any(char::is_control)
}

/*
 * The declared moment of the decision. It has to be a real instant, expressed
 * the way every other governed record in this repository expresses one, or the
 * record would advertise provenance that cannot be compared with anything.
 */
fn valid_standdown_at(value: &str) -> bool {
    bounded_non_empty(value, MAX_TIMESTAMP_BYTES) && OffsetDateTime::parse(value, &Rfc3339).is_ok()
}

fn validate_request(request: &P01StanddownRequest) -> Result<(), &'static str> {
    if request.governed_campaign != T19_GOVERNED_CAMPAIGN_TOKEN
        || request.operator_authorization != T19_OPERATOR_AUTHORIZATION_TOKEN
    {
        return Err(STANDDOWN_NOT_AUTHORIZED);
    }
    if !request.p02_foundation_verified
        || !request.p01_mutation_drained
        || !request.retained_p02_intents_reconciled
    {
        return Err(STANDDOWN_ATTESTATION_MISSING);
    }
    if !is_lower_hex_64(&request.writer_key)
        || !is_lower_hex_64(&request.expected_container_path_sha256_hex)
        || !bounded_non_empty(&request.writer_sync_peer_id, MAX_SYNC_PEER_ID_BYTES)
        || !valid_standdown_at(&request.standdown_at)
    {
        return Err(STANDDOWN_REQUEST_INVALID);
    }
    /* The key is not accepted as given: it must be the one this identity
     * derives, which is what makes `writers/<key>` unreachable by traversal,
     * substitution or guess. */
    if derive_writer_key(&request.writer_sync_peer_id) != request.writer_key {
        return Err(STANDDOWN_WRITER_IDENTITY_MISMATCH);
    }
    Ok(())
}

/*
 * Create-only persistence. The temporary carries the writer key so two
 * different writers can never collide on it, it is written and fsynced before
 * anything is linked, and the destination is created by `hard_link`, which
 * fails rather than replaces when a record already exists. A rename would have
 * been an overwrite waiting for a race.
 */
fn persist_create_only(directory: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    fs::create_dir_all(directory).map_err(|_| STANDDOWN_PERSISTENCE_FAILED)?;
    let destination = directory.join(WRITER_GENERATION_FILE);
    let temporary = directory.join(format!("{WRITER_GENERATION_FILE}{TEMPORARY_SUFFIX}"));
    if temporary.exists() {
        return Err(STANDDOWN_PERSISTENCE_FAILED);
    }
    let write = || -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        use std::io::Write;
        file.write_all(bytes)?;
        file.sync_all()
    };
    if write().is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(STANDDOWN_PERSISTENCE_FAILED);
    }
    match fs::read(&temporary) {
        Ok(written) if written == bytes => {}
        _ => {
            let _ = fs::remove_file(&temporary);
            return Err(STANDDOWN_PERSISTENCE_FAILED);
        }
    }
    if fs::hard_link(&temporary, &destination).is_err() {
        let _ = fs::remove_file(&temporary);
        /* Either the record appeared under us or the link failed; both are
         * refusals, and neither replaced anything. */
        return Err(STANDDOWN_PERSISTENCE_FAILED);
    }
    let _ = fs::remove_file(&temporary);
    if let Ok(directory_handle) = fs::File::open(directory) {
        let _ = directory_handle.sync_all();
    }
    match fs::read(&destination) {
        Ok(written) if written == bytes => Ok(()),
        _ => Err(STANDDOWN_PERSISTENCE_FAILED),
    }
}

pub(crate) fn execute_core(
    repository: &Path,
    container_path_sha256_hex: &str,
    authority_present: bool,
    request: &P01StanddownRequest,
) -> Result<P01StanddownReceipt, &'static str> {
    validate_request(request)?;
    if request.expected_container_path_sha256_hex != container_path_sha256_hex {
        return Err(STANDDOWN_CONTAINER_MISMATCH);
    }
    /* A repository that was never activated has no layout to own, so a
     * generation record there would declare ownership of nothing. */
    if !authority_present || !repository.is_dir() {
        return Err(STANDDOWN_NOT_ACTIVATED);
    }

    let writer_directory: PathBuf = repository.join("writers").join(&request.writer_key);

    match read_p02_generation_record(repository, &request.writer_key) {
        /* Already stood down. Accept only when the record describes THIS
         * writer; a p02 record naming someone else in this directory is a
         * divergence, not a replay. */
        Ok(record) => {
            if record.document_writer_key.as_deref() != Some(request.writer_key.as_str()) {
                return Err(STANDDOWN_EXISTING_RECORD_CONFLICT);
            }
            require_p02_generation(repository, &request.writer_key)
                .map_err(|_| STANDDOWN_READBACK_REJECTED)?;
            return Ok(P01StanddownReceipt {
                schema: STANDDOWN_RECEIPT_SCHEMA,
                writer_key: request.writer_key.clone(),
                generation: WRITER_GENERATION_P02,
                reason: T19_STANDDOWN_REASON,
                created: false,
                readback_verified: true,
            });
        }
        Err(code) if code == STEADY_GENERATION_RECORD_ABSENT => {}
        /* Bytes that will not parse, or a record that positively declares the
         * other generation. Overwriting either would destroy the only durable
         * statement of who owns this installation's data. */
        Err(code) if code == STEADY_GENERATION_RECORD_UNREADABLE => {
            return Err(STANDDOWN_EXISTING_RECORD_UNSAFE);
        }
        Err(code) if code == STEADY_GENERATION_NOT_P02 => {
            return Err(STANDDOWN_EXISTING_RECORD_CONFLICT);
        }
        Err(_) => return Err(STANDDOWN_EXISTING_RECORD_UNSAFE),
    }

    let document = GenerationDocument {
        schema: WRITER_GENERATION_SCHEMA,
        generation: WRITER_GENERATION_P02,
        standdown_at: &request.standdown_at,
        decided_by_writer_sync_peer_id: &request.writer_sync_peer_id,
        reason: T19_STANDDOWN_REASON,
        writer_key: &request.writer_key,
    };
    let bytes = serde_json::to_vec(&document).map_err(|_| STANDDOWN_PERSISTENCE_FAILED)?;
    persist_create_only(&writer_directory, &bytes)?;

    /* The verdict is the steady lease's own reader, not ours. */
    require_p02_generation(repository, &request.writer_key)
        .map_err(|_| STANDDOWN_READBACK_REJECTED)?;

    Ok(P01StanddownReceipt {
        schema: STANDDOWN_RECEIPT_SCHEMA,
        writer_key: request.writer_key.clone(),
        generation: WRITER_GENERATION_P02,
        reason: T19_STANDDOWN_REASON,
        created: true,
        readback_verified: true,
    })
}

/*
 * The one command. The repository is the binding's, exactly as the steady and
 * publication windows resolve theirs; nothing in the request can point it
 * anywhere else.
 */
#[tauri::command]
pub fn h2o_p01_execute_writer_generation_standdown(
    app: tauri::AppHandle,
    request: P01StanddownRequest,
) -> Result<P01StanddownReceipt, String> {
    let authorization_root = app
        .path()
        .app_data_dir()
        .map_err(|_| STANDDOWN_TARGET_NOT_AUTHORIZED.to_string())?
        .join("item11-delivery");
    let target = crate::p02_activation::resolve_target_core(&authorization_root)
        .map_err(|_| STANDDOWN_TARGET_NOT_AUTHORIZED.to_string())?;
    execute_core(
        &PathBuf::from(&target.repository_root),
        &target.container_path_sha256_hex,
        target.authority_present,
        &request,
    )
    .map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    const PEER: &str = "studio-desktop:tauri-desktop:sqlite:7d38016a-55c1-48b8-81de-162bf4586b9e";
    const CONTAINER: &str = "cc6aa57f1bb07e0c168542db47af4956c3f9ab4acfd81af0e4edb826cb69f852";
    const OTHER_KEY: &str = "1111111111111111111111111111111111111111111111111111111111111111";

    fn temporary_repository() -> PathBuf {
        let index = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root =
            std::env::temp_dir().join(format!("h2o-t19-standdown-{}-{index}", std::process::id()));
        let repository = root.join("h2o-object-sync");
        fs::create_dir_all(&repository).expect("repository");
        fs::write(repository.join("library.info.json"), b"{}").expect("authority");
        repository
    }

    fn request() -> P01StanddownRequest {
        P01StanddownRequest {
            governed_campaign: T19_GOVERNED_CAMPAIGN_TOKEN.to_string(),
            operator_authorization: T19_OPERATOR_AUTHORIZATION_TOKEN.to_string(),
            writer_key: derive_writer_key(PEER),
            writer_sync_peer_id: PEER.to_string(),
            expected_container_path_sha256_hex: CONTAINER.to_string(),
            standdown_at: "2026-09-22T12:00:00Z".to_string(),
            p02_foundation_verified: true,
            p01_mutation_drained: true,
            retained_p02_intents_reconciled: true,
        }
    }

    fn record_path(repository: &Path, writer_key: &str) -> PathBuf {
        repository
            .join("writers")
            .join(writer_key)
            .join(WRITER_GENERATION_FILE)
    }

    fn execute(
        repository: &Path,
        request: &P01StanddownRequest,
    ) -> Result<P01StanddownReceipt, &'static str> {
        execute_core(repository, CONTAINER, true, request)
    }

    #[test]
    fn writes_exactly_the_accepted_record_and_reads_it_back() {
        let repository = temporary_repository();
        let request = request();
        let receipt = execute(&repository, &request).expect("standdown");
        assert!(receipt.created && receipt.readback_verified);
        assert_eq!(receipt.generation, WRITER_GENERATION_P02);
        assert_eq!(receipt.reason, T19_STANDDOWN_REASON);

        let bytes = fs::read(record_path(&repository, &request.writer_key)).expect("record");
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(value["schema"], WRITER_GENERATION_SCHEMA);
        assert_eq!(value["generation"], WRITER_GENERATION_P02);
        assert_eq!(value["writerKey"], request.writer_key);
        assert_eq!(value["decidedByWriterSyncPeerId"], PEER);
        assert_eq!(value["standdownAt"], request.standdown_at);
        assert_eq!(value["reason"], T19_STANDDOWN_REASON);
        /* Exactly the accepted field set: nothing extra is declared. */
        assert_eq!(value.as_object().expect("object").len(), 6);
        /* And the steady lease's own reader accepts it. */
        assert!(require_p02_generation(&repository, &request.writer_key).is_ok());
        /* One record, and no temporary left behind. */
        let directory = repository.join("writers").join(&request.writer_key);
        let entries: Vec<_> = fs::read_dir(&directory)
            .expect("dir")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn replay_is_idempotent_and_writes_nothing() {
        let repository = temporary_repository();
        let request = request();
        let first = execute(&repository, &request).expect("first");
        let bytes = fs::read(record_path(&repository, &request.writer_key)).expect("record");
        let second = execute(&repository, &request).expect("replay");
        assert!(first.created && !second.created);
        assert!(second.readback_verified);
        assert_eq!(
            bytes,
            fs::read(record_path(&repository, &request.writer_key)).expect("record")
        );
    }

    #[test]
    fn wrong_campaign_or_operator_token_refuses_before_anything_is_read() {
        let repository = temporary_repository();
        for mutate in [
            |request: &mut P01StanddownRequest| request.governed_campaign = "nope".to_string(),
            |request: &mut P01StanddownRequest| request.operator_authorization = String::new(),
        ] {
            let mut request = request();
            mutate(&mut request);
            assert_eq!(
                execute(&repository, &request),
                Err(STANDDOWN_NOT_AUTHORIZED)
            );
            assert!(!record_path(&repository, &request.writer_key).exists());
        }
    }

    #[test]
    fn every_missing_attestation_refuses() {
        let repository = temporary_repository();
        for mutate in [
            |request: &mut P01StanddownRequest| request.p02_foundation_verified = false,
            |request: &mut P01StanddownRequest| request.p01_mutation_drained = false,
            |request: &mut P01StanddownRequest| request.retained_p02_intents_reconciled = false,
        ] {
            let mut request = request();
            mutate(&mut request);
            assert_eq!(
                execute(&repository, &request),
                Err(STANDDOWN_ATTESTATION_MISSING)
            );
            assert!(!record_path(&repository, &request.writer_key).exists());
        }
    }

    #[test]
    fn malformed_writer_key_traversal_and_timestamp_refuse() {
        let repository = temporary_repository();
        for key in [
            "",
            "ABCDEF",
            OTHER_KEY.get(..63).expect("prefix"),
            "../../../../etc/passwd",
            "../writers/63e433d6efed83d551d332c075407ce833ae5214ef110957195273a5b4",
        ] {
            let mut request = request();
            request.writer_key = key.to_string();
            assert_eq!(
                execute(&repository, &request),
                Err(STANDDOWN_REQUEST_INVALID)
            );
        }
        for timestamp in ["", "yesterday", "2026-09-22", "2026-13-45T99:00:00Z"] {
            let mut request = request();
            request.standdown_at = timestamp.to_string();
            assert_eq!(
                execute(&repository, &request),
                Err(STANDDOWN_REQUEST_INVALID)
            );
        }
        let mut request = request();
        request.writer_sync_peer_id = "  ".to_string();
        assert_eq!(
            execute(&repository, &request),
            Err(STANDDOWN_REQUEST_INVALID)
        );
        assert!(!repository.join("writers").exists());
    }

    #[test]
    fn a_writer_key_that_is_not_derived_from_the_declared_identity_refuses() {
        let repository = temporary_repository();
        let mut request = request();
        request.writer_key = OTHER_KEY.to_string();
        assert_eq!(
            execute(&repository, &request),
            Err(STANDDOWN_WRITER_IDENTITY_MISMATCH)
        );
        assert!(!record_path(&repository, OTHER_KEY).exists());

        let mut impostor = request.clone();
        impostor.writer_key = derive_writer_key(PEER);
        impostor.writer_sync_peer_id =
            "studio-desktop:tauri-desktop:sqlite:someone-else".to_string();
        assert_eq!(
            execute(&repository, &impostor),
            Err(STANDDOWN_WRITER_IDENTITY_MISMATCH)
        );
    }

    #[test]
    fn container_mismatch_and_unactivated_repository_refuse() {
        let repository = temporary_repository();
        let request = request();
        assert_eq!(
            execute_core(&repository, OTHER_KEY, true, &request),
            Err(STANDDOWN_CONTAINER_MISMATCH)
        );
        assert_eq!(
            execute_core(&repository, CONTAINER, false, &request),
            Err(STANDDOWN_NOT_ACTIVATED)
        );
        assert_eq!(
            execute_core(&repository.join("absent"), CONTAINER, true, &request),
            Err(STANDDOWN_NOT_ACTIVATED)
        );
        assert!(!record_path(&repository, &request.writer_key).exists());
    }

    #[test]
    fn unsafe_and_divergent_existing_records_are_never_overwritten() {
        for (existing, expected) in [
            (r#"{"not":"json"#, STANDDOWN_EXISTING_RECORD_UNSAFE),
            (
                r#"{"schema":"something.else","generation":"p02"}"#,
                STANDDOWN_EXISTING_RECORD_UNSAFE,
            ),
            (
                r#"{"schema":"h2o.studio.syncWriterGeneration.p02.v1","generation":"p01"}"#,
                STANDDOWN_EXISTING_RECORD_CONFLICT,
            ),
            (
                r#"{"schema":"h2o.studio.syncWriterGeneration.p02.v1","generation":"p02","writerKey":"1111111111111111111111111111111111111111111111111111111111111111"}"#,
                STANDDOWN_EXISTING_RECORD_CONFLICT,
            ),
        ] {
            let repository = temporary_repository();
            let request = request();
            let path = record_path(&repository, &request.writer_key);
            fs::create_dir_all(path.parent().expect("parent")).expect("writers");
            fs::write(&path, existing).expect("existing");
            assert_eq!(execute(&repository, &request), Err(expected));
            assert_eq!(fs::read_to_string(&path).expect("unchanged"), existing);
        }
    }

    #[test]
    fn a_stale_temporary_refuses_rather_than_being_reused() {
        let repository = temporary_repository();
        let request = request();
        let directory = repository.join("writers").join(&request.writer_key);
        fs::create_dir_all(&directory).expect("writers");
        fs::write(
            directory.join(format!("{WRITER_GENERATION_FILE}{TEMPORARY_SUFFIX}")),
            b"stale",
        )
        .expect("temporary");
        assert_eq!(
            execute(&repository, &request),
            Err(STANDDOWN_PERSISTENCE_FAILED)
        );
        assert!(!record_path(&repository, &request.writer_key).exists());
    }

    #[test]
    fn the_module_exposes_no_generic_setter_and_no_repository_path_input() {
        let source = include_str!("p01_standdown_executor.rs");
        let production = &source[..source.find("#[cfg(test)]").expect("test module")];
        for forbidden in [
            "pub fn set_generation",
            "pub fn write_generation",
            "pub fn write_repository_file",
        ] {
            assert!(
                !production.contains(forbidden),
                "production half must not expose {forbidden}"
            );
        }
        /* The request's field list is closed, and every name in it is either a
         * token, an attestation or a value the caller must prove it owns. A
         * repository, a path, a filename or a document among them is what would
         * turn this into a generic setter. */
        let request_fields = {
            let start = production
                .find("pub struct P01StanddownRequest")
                .expect("request struct");
            let end = start + production[start..].find("\n}").expect("struct end");
            production[start..end]
                .lines()
                .skip(1)
                .filter_map(|line| line.trim().strip_prefix("pub "))
                .filter_map(|line| line.split(':').next())
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            request_fields,
            vec![
                "governed_campaign",
                "operator_authorization",
                "writer_key",
                "writer_sync_peer_id",
                "expected_container_path_sha256_hex",
                "standdown_at",
                "p02_foundation_verified",
                "p01_mutation_drained",
                "retained_p02_intents_reconciled",
            ]
        );
        /* Exactly one command, and no autonomous caller of the core: the core
         * is defined once and called once, by that command. Comments are
         * stripped first so prose about the attribute cannot be counted as
         * another one. */
        let code = {
            let mut text = production.to_string();
            while let (Some(start), Some(end)) = (text.find("/*"), text.find("*/")) {
                if end < start {
                    break;
                }
                text.replace_range(start..end + 2, "");
            }
            text
        };
        assert_eq!(code.matches("#[tauri::command]").count(), 1);
        assert_eq!(code.matches("execute_core(").count(), 2);
        for forbidden in [
            "std::thread",
            "tokio::spawn",
            "set_interval",
            "setup(",
            "on_page_load",
        ] {
            assert!(
                !production.contains(forbidden),
                "no autonomous route: {forbidden}"
            );
        }
    }
}
