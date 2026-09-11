//! Guarded local-only recovery for the one proven Round 2A Profile-A
//! peer-identity divergence.
//!
//! This module never accepts caller-selected peer IDs, object IDs, SQL, or
//! target records. The caller supplies only the complete identity bytes that
//! are already preserved in this profile's localStorage. A fixed evidence gate
//! validates both identities, both durable state rows, and the exact synthetic
//! Revision-1 fixture inside one SQLite transaction. The only possible write
//! is a compare-and-set of the existing peer-identity kv_store value.

use serde::Serialize;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, Transaction};
use tauri::{Manager, State};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::round2a_fixture_authoring;

const DB_URL: &str = "sqlite:studio-v1.db";
const IDENTITY_KEY: &str = "h2o:sync:peer-identity:v1";
const IDENTITY_SCHEMA: &str = "h2o.studio.peer-identity.v1";
const EXPECTED_SQLITE_FINGERPRINT: &str =
    "48ad2eb803f1cdeb276d96cf67ada4e45befc7150c712da83124c29f8235cc23";
const EXPECTED_PRESERVED_FINGERPRINT: &str =
    "8dbfc23940d2cb4bb4892e05183e8b4daa7db6e9f44500307941c2cb813a5b91";
const OBJECT_ID: &str = round2a_fixture_authoring::CHAT_ID;
const REVISION_1_ID: &str = round2a_fixture_authoring::REVISION_1_ID;

#[derive(Clone, Debug)]
struct ValidIdentity {
    raw: String,
    sync_peer_id: String,
    fingerprint: String,
}

#[derive(Clone, Copy)]
struct RecoveryExpectations<'a> {
    sqlite_fingerprint: &'a str,
    preserved_fingerprint: &'a str,
}

const PRODUCTION_EXPECTATIONS: RecoveryExpectations<'static> = RecoveryExpectations {
    sqlite_fingerprint: EXPECTED_SQLITE_FINGERPRINT,
    preserved_fingerprint: EXPECTED_PRESERVED_FINGERPRINT,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RecoveryFailure {
    DatabaseUnavailable,
    IdentityInvalid,
    EvidenceMismatch,
    CompareAndSetFailed,
    VerificationFailed,
    TransactionFailed,
    IdentityWriteLeaseHeld,
}

impl RecoveryFailure {
    fn code(self) -> &'static str {
        match self {
            Self::DatabaseUnavailable => "round2a-identity-recovery-database-unavailable",
            Self::IdentityInvalid => "round2a-identity-recovery-identity-invalid",
            Self::EvidenceMismatch => "round2a-identity-recovery-evidence-mismatch",
            Self::CompareAndSetFailed => "round2a-identity-recovery-cas-failed",
            Self::VerificationFailed => "round2a-identity-recovery-verification-failed",
            Self::TransactionFailed => "round2a-identity-recovery-transaction-failed",
            Self::IdentityWriteLeaseHeld => "round2a-identity-recovery-identity-write-lease-held",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityStateSummary {
    peer_fingerprint_sha256_hex: &'static str,
    pending_operation: Option<&'static str>,
    operation_phase: Option<&'static str>,
    intended_revision_present: bool,
    last_error_code: &'static str,
    last_conflict_class: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Round2aIdentityRecoveryResult {
    schema: &'static str,
    ok: bool,
    verdict: &'static str,
    backend_ready: bool,
    sqlite_fingerprint_sha256_hex: Option<String>,
    local_storage_fingerprint_sha256_hex: Option<String>,
    copies_match: bool,
    divergent: bool,
    recovery_eligible: bool,
    recovery_performed: bool,
    restart_required: bool,
    no_network: bool,
    fixture_status: Option<&'static str>,
    object_id: &'static str,
    preserved_state: Option<IdentityStateSummary>,
    historical_state: Option<IdentityStateSummary>,
    error_code: Option<&'static str>,
}

impl Round2aIdentityRecoveryResult {
    fn base(sqlite: Option<&ValidIdentity>, candidate: Option<&ValidIdentity>) -> Self {
        let copies_match = matches!((sqlite, candidate), (Some(a), Some(b)) if a.raw == b.raw);
        Self {
            schema: "h2o.round2a.desktop-peer-identity-recovery.v1",
            ok: true,
            verdict: "identity-provenance-inspected",
            backend_ready: true,
            sqlite_fingerprint_sha256_hex: sqlite.map(|value| value.fingerprint.clone()),
            local_storage_fingerprint_sha256_hex: candidate.map(|value| value.fingerprint.clone()),
            copies_match,
            divergent: sqlite.is_some() && candidate.is_some() && !copies_match,
            recovery_eligible: false,
            recovery_performed: false,
            restart_required: false,
            no_network: true,
            fixture_status: None,
            object_id: OBJECT_ID,
            preserved_state: None,
            historical_state: None,
            error_code: None,
        }
    }

    fn blocked(failure: RecoveryFailure) -> Self {
        Self {
            schema: "h2o.round2a.desktop-peer-identity-recovery.v1",
            ok: false,
            verdict: "blocked-divergent",
            backend_ready: failure != RecoveryFailure::DatabaseUnavailable,
            sqlite_fingerprint_sha256_hex: None,
            local_storage_fingerprint_sha256_hex: None,
            copies_match: false,
            divergent: false,
            recovery_eligible: false,
            recovery_performed: false,
            restart_required: false,
            no_network: true,
            fixture_status: None,
            object_id: OBJECT_ID,
            preserved_state: None,
            historical_state: None,
            error_code: Some(failure.code()),
        }
    }
}

fn sha256_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn valid_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || bytes[8] != b'-'
        || bytes[13] != b'-'
        || bytes[18] != b'-'
        || bytes[23] != b'-'
        || bytes[14] != b'4'
        || !matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
    {
        return false;
    }
    bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
}

fn validate_identity(raw: &str) -> Option<ValidIdentity> {
    if raw.is_empty() || raw.len() > 16_384 {
        return None;
    }
    let value: JsonValue = serde_json::from_str(raw).ok()?;
    let object = value.as_object()?;
    let expected_keys = [
        "schema",
        "installId",
        "physicalDeviceId",
        "syncPeerId",
        "surfaceKind",
        "appKind",
        "storeKind",
        "displayName",
        "createdAt",
        "updatedAt",
        "surfaceHistory",
    ];
    if object.len() != expected_keys.len()
        || !expected_keys.iter().all(|key| object.contains_key(*key))
    {
        return None;
    }
    let text = |key: &str| object.get(key).and_then(JsonValue::as_str);
    let install_id = text("installId")?;
    let physical_device_id = text("physicalDeviceId")?;
    let sync_peer_id = text("syncPeerId")?;
    let display_name = text("displayName")?;
    let created_at = text("createdAt")?;
    let updated_at = text("updatedAt")?;
    let history = object.get("surfaceHistory")?.as_array()?;
    if history.len() > 32
        || !history.iter().all(|entry| {
            let Some(entry) = entry.as_object() else {
                return false;
            };
            let value = |key: &str| entry.get(key).and_then(JsonValue::as_str);
            entry.len() == 4
                && matches!(
                    value("surfaceKind"),
                    Some("studio-desktop" | "studio-chrome" | "studio-mobile" | "studio-firefox")
                )
                && matches!(
                    value("appKind"),
                    Some("tauri-desktop" | "mv3-chrome" | "mv3-firefox" | "expo-mobile")
                )
                && matches!(
                    value("storeKind"),
                    Some("sqlite" | "idb-shared" | "idb-archive" | "expo-sqlite" | "expo-fs")
                )
                && matches!(
                    value("observedUntil"),
                    Some(timestamp) if !timestamp.is_empty() && timestamp.len() <= 64
                )
        })
    {
        return None;
    }
    if text("schema")? != IDENTITY_SCHEMA
        || !valid_uuid_v4(install_id)
        || !valid_uuid_v4(physical_device_id)
        || text("surfaceKind")? != "studio-desktop"
        || text("appKind")? != "tauri-desktop"
        || text("storeKind")? != "sqlite"
        || sync_peer_id != format!("studio-desktop:tauri-desktop:sqlite:{install_id}")
        || display_name.len() > 80
        || created_at.is_empty()
        || created_at.len() > 64
        || updated_at.is_empty()
        || updated_at.len() > 64
    {
        return None;
    }
    Some(ValidIdentity {
        raw: raw.to_owned(),
        sync_peer_id: sync_peer_id.to_owned(),
        fingerprint: sha256_hex(sync_peer_id),
    })
}

async fn identity_raw(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
) -> Result<Option<String>, RecoveryFailure> {
    sqlx::query_scalar::<_, String>("SELECT value FROM kv_store WHERE key = ? LIMIT 1")
        .bind(IDENTITY_KEY)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| RecoveryFailure::TransactionFailed)
}

async fn state_row_is_exact(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    peer_id: &str,
    preserved: bool,
) -> Result<bool, RecoveryFailure> {
    let row = sqlx::query(
        "SELECT pending_operation, operation_phase, intended_revision_id, \
         last_error_code, last_conflict_class FROM sync_object_state \
         WHERE sync_peer_id = ? AND object_id = ? LIMIT 2",
    )
    .bind(peer_id)
    .bind(OBJECT_ID)
    .fetch_all(&mut **tx)
    .await
    .map_err(|_| RecoveryFailure::TransactionFailed)?;
    if row.len() != 1 {
        return Ok(false);
    }
    let pending: Option<String> = row[0]
        .try_get("pending_operation")
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    let phase: Option<String> = row[0]
        .try_get("operation_phase")
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    let intended: Option<String> = row[0]
        .try_get("intended_revision_id")
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    let error: Option<String> = row[0]
        .try_get("last_error_code")
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    let conflict: Option<String> = row[0]
        .try_get("last_conflict_class")
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    if preserved {
        Ok(pending.as_deref() == Some("publish")
            && phase.as_deref() == Some("transport")
            && intended.as_deref() == Some(REVISION_1_ID)
            && error.as_deref() == Some("round2a-layout-propfind-failed")
            && matches!(
                conflict.as_deref(),
                None | Some("round2a-layout-propfind-failed")
            ))
    } else {
        Ok(pending.is_none()
            && phase.is_none()
            && intended.is_none()
            && error.as_deref() == Some("round2a-get-status-invalid")
            && conflict.is_none())
    }
}

async fn exact_recovery_evidence(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    sqlite: &ValidIdentity,
    candidate: &ValidIdentity,
    expectations: RecoveryExpectations<'_>,
) -> Result<bool, RecoveryFailure> {
    if sqlite.fingerprint != expectations.sqlite_fingerprint
        && sqlite.fingerprint != expectations.preserved_fingerprint
    {
        return Ok(false);
    }
    if candidate.fingerprint != expectations.preserved_fingerprint {
        return Ok(false);
    }
    let object_state_count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sync_object_state WHERE object_id = ?")
            .bind(OBJECT_ID)
            .fetch_one(&mut **tx)
            .await
            .map_err(|_| RecoveryFailure::TransactionFailed)?;
    let unrelated_candidate_pending = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM sync_object_state \
         WHERE sync_peer_id = ? AND pending_operation IS NOT NULL AND object_id <> ?",
    )
    .bind(&candidate.sync_peer_id)
    .bind(OBJECT_ID)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| RecoveryFailure::TransactionFailed)?;
    Ok(object_state_count == 2
        && unrelated_candidate_pending == 0
        && state_row_is_exact(tx, &candidate.sync_peer_id, true).await?
        && {
            let historical_peer = if sqlite.fingerprint == expectations.sqlite_fingerprint {
                sqlite.sync_peer_id.clone()
            } else {
                let row = sqlx::query_scalar::<_, String>(
                    "SELECT sync_peer_id FROM sync_object_state \
                     WHERE object_id = ? AND sync_peer_id <> ? LIMIT 2",
                )
                .bind(OBJECT_ID)
                .bind(&candidate.sync_peer_id)
                .fetch_all(&mut **tx)
                .await
                .map_err(|_| RecoveryFailure::TransactionFailed)?;
                if row.len() != 1 || sha256_hex(&row[0]) != expectations.sqlite_fingerprint {
                    return Ok(false);
                }
                row[0].clone()
            };
            state_row_is_exact(tx, &historical_peer, false).await?
        }
        && round2a_fixture_authoring::is_exact_revision_1(tx).await)
}

async fn inspect_transaction(
    conn: &mut SqliteConnection,
    candidate_raw: Option<&str>,
    expectations: RecoveryExpectations<'_>,
) -> Result<Round2aIdentityRecoveryResult, RecoveryFailure> {
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    let sqlite_raw = identity_raw(&mut tx)
        .await?
        .ok_or(RecoveryFailure::IdentityInvalid)?;
    let sqlite = validate_identity(&sqlite_raw).ok_or(RecoveryFailure::IdentityInvalid)?;
    let candidate = candidate_raw.and_then(validate_identity);
    if candidate_raw.is_some() && candidate.is_none() {
        return Err(RecoveryFailure::IdentityInvalid);
    }
    let mut result = Round2aIdentityRecoveryResult::base(Some(&sqlite), candidate.as_ref());
    if let Some(candidate) = candidate.as_ref() {
        if exact_recovery_evidence(&mut tx, &sqlite, candidate, expectations).await? {
            result.recovery_eligible = sqlite.fingerprint == expectations.sqlite_fingerprint
                && sqlite.raw != candidate.raw;
            result.fixture_status = Some("revision-1-current");
            result.preserved_state = Some(IdentityStateSummary {
                peer_fingerprint_sha256_hex: EXPECTED_PRESERVED_FINGERPRINT,
                pending_operation: Some("publish"),
                operation_phase: Some("transport"),
                intended_revision_present: true,
                last_error_code: "round2a-layout-propfind-failed",
                last_conflict_class: None,
            });
            result.historical_state = Some(IdentityStateSummary {
                peer_fingerprint_sha256_hex: EXPECTED_SQLITE_FINGERPRINT,
                pending_operation: None,
                operation_phase: None,
                intended_revision_present: false,
                last_error_code: "round2a-get-status-invalid",
                last_conflict_class: None,
            });
            if sqlite.raw == candidate.raw {
                result.verdict = "already-recovered";
                result.copies_match = true;
                result.divergent = false;
            }
        }
    }
    tx.commit()
        .await
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    Ok(result)
}

async fn recover_transaction(
    conn: &mut SqliteConnection,
    candidate_raw: &str,
    expectations: RecoveryExpectations<'_>,
) -> Result<Round2aIdentityRecoveryResult, RecoveryFailure> {
    let candidate = validate_identity(candidate_raw).ok_or(RecoveryFailure::IdentityInvalid)?;
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    let prior_raw = identity_raw(&mut tx)
        .await?
        .ok_or(RecoveryFailure::IdentityInvalid)?;
    let prior = validate_identity(&prior_raw).ok_or(RecoveryFailure::IdentityInvalid)?;
    if !exact_recovery_evidence(&mut tx, &prior, &candidate, expectations).await? {
        return Err(RecoveryFailure::EvidenceMismatch);
    }
    if prior.raw == candidate.raw {
        tx.commit()
            .await
            .map_err(|_| RecoveryFailure::TransactionFailed)?;
        let mut result = Round2aIdentityRecoveryResult::base(Some(&prior), Some(&candidate));
        result.verdict = "already-recovered";
        result.fixture_status = Some("revision-1-current");
        result.restart_required = true;
        return Ok(result);
    }
    if prior.fingerprint != expectations.sqlite_fingerprint
        || candidate.fingerprint != expectations.preserved_fingerprint
    {
        return Err(RecoveryFailure::EvidenceMismatch);
    }
    /* Item 11 serialization: while an orphan-removal lease is held, no
     * production path may write the identity row. A poisoned lock fails closed. */
    if orphan_lease_active().unwrap_or(true) {
        return Err(RecoveryFailure::IdentityWriteLeaseHeld);
    }
    let updated = sqlx::query("UPDATE kv_store SET value = ? WHERE key = ? AND value = ?")
        .bind(candidate_raw)
        .bind(IDENTITY_KEY)
        .bind(&prior_raw)
        .execute(&mut *tx)
        .await
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    if updated.rows_affected() != 1 {
        return Err(RecoveryFailure::CompareAndSetFailed);
    }
    let readback_raw = identity_raw(&mut tx)
        .await?
        .ok_or(RecoveryFailure::VerificationFailed)?;
    let readback = validate_identity(&readback_raw).ok_or(RecoveryFailure::VerificationFailed)?;
    if readback_raw != candidate_raw
        || readback.fingerprint != expectations.preserved_fingerprint
        || !exact_recovery_evidence(&mut tx, &readback, &candidate, expectations).await?
    {
        return Err(RecoveryFailure::VerificationFailed);
    }
    tx.commit()
        .await
        .map_err(|_| RecoveryFailure::TransactionFailed)?;
    let mut result = Round2aIdentityRecoveryResult::base(Some(&readback), Some(&candidate));
    result.verdict = "recovery-complete-restart-required";
    result.recovery_performed = true;
    result.restart_required = true;
    result.fixture_status = Some("revision-1-current");
    result.preserved_state = Some(IdentityStateSummary {
        peer_fingerprint_sha256_hex: EXPECTED_PRESERVED_FINGERPRINT,
        pending_operation: Some("publish"),
        operation_phase: Some("transport"),
        intended_revision_present: true,
        last_error_code: "round2a-layout-propfind-failed",
        last_conflict_class: None,
    });
    result.historical_state = Some(IdentityStateSummary {
        peer_fingerprint_sha256_hex: EXPECTED_SQLITE_FINGERPRINT,
        pending_operation: None,
        operation_phase: None,
        intended_revision_present: false,
        last_error_code: "round2a-get-status-invalid",
        last_conflict_class: None,
    });
    Ok(result)
}

async fn sqlite_pool(db_instances: &DbInstances) -> Option<sqlx::SqlitePool> {
    let instances = db_instances.0.read().await;
    match instances.get(DB_URL) {
        Some(DbPool::Sqlite(pool)) => Some(pool.clone()),
        #[allow(unreachable_patterns)]
        _ => None,
    }
}

#[tauri::command]
pub async fn h2o_round2a_identity_recovery_inspect(
    db_instances: State<'_, DbInstances>,
    candidate_identity_json: Option<String>,
) -> Result<Round2aIdentityRecoveryResult, String> {
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(Round2aIdentityRecoveryResult::blocked(
            RecoveryFailure::DatabaseUnavailable,
        ));
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => {
            return Ok(Round2aIdentityRecoveryResult::blocked(
                RecoveryFailure::DatabaseUnavailable,
            ))
        }
    };
    Ok(
        match inspect_transaction(
            &mut conn,
            candidate_identity_json.as_deref(),
            PRODUCTION_EXPECTATIONS,
        )
        .await
        {
            Ok(result) => result,
            Err(failure) => Round2aIdentityRecoveryResult::blocked(failure),
        },
    )
}

#[tauri::command]
pub async fn h2o_round2a_identity_recovery_apply(
    db_instances: State<'_, DbInstances>,
    candidate_identity_json: String,
) -> Result<Round2aIdentityRecoveryResult, String> {
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(Round2aIdentityRecoveryResult::blocked(
            RecoveryFailure::DatabaseUnavailable,
        ));
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => {
            return Ok(Round2aIdentityRecoveryResult::blocked(
                RecoveryFailure::DatabaseUnavailable,
            ))
        }
    };
    Ok(
        match recover_transaction(&mut conn, &candidate_identity_json, PRODUCTION_EXPECTATIONS)
            .await
        {
            Ok(result) => result,
            Err(failure) => Round2aIdentityRecoveryResult::blocked(failure),
        },
    )
}

/* ── Item 11 orphan-identity reconciliation ───────────────────────────────
 * A SEPARATE command from the fixed Profile-A recovery above. That recovery
 * stays byte-for-byte semantically unchanged: its pinned constants are never
 * read here, never widened, and never reused as generic authority.
 *
 * This path proves the opposite direction of evidence. SQLite is authoritative
 * because it owns every peer-scoped row; the Desktop localStorage copy is an
 * orphan that owns none. Rust cannot touch WKWebView localStorage, so it only
 * produces the evidence verdict and the protected rollback backup. JavaScript
 * performs the removal, and only when this command authorises it.
 *
 * This command never writes to SQLite. */

const ORPHAN_SCHEMA: &str = "h2o.round2.item11.identity-orphan-reconciliation.v1";
const ORPHAN_VERDICT: &str = "sqlite-authoritative-orphan-localstorage-confirmed";
const ORPHAN_BACKUP_SCHEMA: &str = "h2o.round2.item11.identity-orphan-backup.v1";
const ORPHAN_BACKUP_DIRECTORY: &str = "round2a-identity-orphan-reconciliation";
const ORPHAN_BACKUP_FILE: &str = "localstorage-identity-backup.v1.json";
const ORPHAN_BACKUP_TEMP_FILE: &str = ".localstorage-identity-backup.v1.json.tmp";
const ORPHAN_OPERATION: &str = "item11-identity-orphan-reconciliation";
const ORPHAN_EXPECTED_SQLITE_OWNERSHIP: i64 = 26;

/* Every peer-scoped column in the production schema, with the proven
 * per-column ownership of the authoritative SQLite identity. The orphan must
 * own zero in every one of them. Table and column names are fixed constants —
 * no caller input ever reaches SQL. */
const ORPHAN_PEER_SCOPED_COLUMNS: &[(&str, &str, i64)] = &[
    ("sync_object_state", "sync_peer_id", 0),
    ("sync_peer_watermarks", "observing_peer_id", 0),
    ("sync_peer_watermarks", "source_peer_id", 0),
    ("sync_conflicts", "local_peer_id", 0),
    ("sync_conflicts", "remote_peer_id", 0),
    ("sync_conflicts", "decided_by_sync_peer_id", 1),
    ("sync_maintenance_log", "requested_by_sync_peer_id", 0),
    ("sync_tombstones", "deleted_by_sync_peer_id", 4),
    ("sync_tombstones", "restored_by_sync_peer_id", 1),
    ("sync_tombstone_reviews", "remote_sync_peer_id", 0),
    ("sync_tombstone_reviews", "decided_by_sync_peer_id", 20),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OrphanFailure {
    DatabaseUnavailable,
    SqliteIdentityInvalid,
    SqliteFingerprintMismatch,
    SqliteRowDigestMismatch,
    CandidateInvalid,
    CandidateFingerprintMismatch,
    CandidateNotDivergent,
    CandidateOwnsRows,
    OwnershipMismatch,
    ObjectStatePresent,
    WatermarkPresent,
    RowChangedDuringInspection,
    BackupConflict,
    BackupWriteFailed,
    BackupMissing,
    BackupReadFailed,
    TransactionFailed,
    LeaseUnavailable,
    LeaseAlreadyActive,
    LeaseMissing,
    LeaseExpired,
    LeaseAlreadyConsumed,
    LeaseNonceMismatch,
    LeaseBindingMismatch,
    NonceUnavailable,
    LeaseOperationMismatch,
}

impl OrphanFailure {
    fn code(self) -> &'static str {
        match self {
            Self::DatabaseUnavailable => "round2-item11-identity-orphan-database-unavailable",
            Self::SqliteIdentityInvalid => "round2-item11-identity-orphan-sqlite-identity-invalid",
            Self::SqliteFingerprintMismatch => {
                "round2-item11-identity-orphan-sqlite-fingerprint-mismatch"
            }
            Self::SqliteRowDigestMismatch => {
                "round2-item11-identity-orphan-sqlite-row-digest-mismatch"
            }
            Self::CandidateInvalid => "round2-item11-identity-orphan-candidate-invalid",
            Self::CandidateFingerprintMismatch => {
                "round2-item11-identity-orphan-candidate-fingerprint-mismatch"
            }
            Self::CandidateNotDivergent => "round2-item11-identity-orphan-candidate-not-divergent",
            Self::CandidateOwnsRows => "round2-item11-identity-orphan-candidate-owns-rows",
            Self::OwnershipMismatch => "round2-item11-identity-orphan-ownership-mismatch",
            Self::ObjectStatePresent => "round2-item11-identity-orphan-object-state-present",
            Self::WatermarkPresent => "round2-item11-identity-orphan-watermark-present",
            Self::RowChangedDuringInspection => {
                "round2-item11-identity-orphan-row-changed-during-inspection"
            }
            Self::BackupConflict => "round2-item11-identity-orphan-backup-conflict",
            Self::BackupWriteFailed => "round2-item11-identity-orphan-backup-write-failed",
            Self::BackupMissing => "round2-item11-identity-orphan-backup-missing",
            Self::BackupReadFailed => "round2-item11-identity-orphan-backup-read-failed",
            Self::TransactionFailed => "round2-item11-identity-orphan-transaction-failed",
            Self::LeaseUnavailable => "round2-item11-identity-orphan-lease-unavailable",
            Self::LeaseAlreadyActive => "round2-item11-identity-orphan-lease-already-active",
            Self::LeaseMissing => "round2-item11-identity-orphan-lease-missing",
            Self::LeaseExpired => "round2-item11-identity-orphan-lease-expired",
            Self::LeaseAlreadyConsumed => "round2-item11-identity-orphan-lease-already-consumed",
            Self::LeaseNonceMismatch => "round2-item11-identity-orphan-lease-nonce-mismatch",
            Self::LeaseBindingMismatch => "round2-item11-identity-orphan-lease-binding-mismatch",
            Self::NonceUnavailable => "round2-item11-identity-orphan-nonce-unavailable",
            Self::LeaseOperationMismatch => {
                "round2-item11-identity-orphan-lease-operation-mismatch"
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanReconciliationResult {
    schema: &'static str,
    ok: bool,
    verdict: &'static str,
    sqlite_fingerprint_sha256_hex: Option<String>,
    local_storage_fingerprint_sha256_hex: Option<String>,
    sqlite_row_sha256_hex: Option<String>,
    local_storage_raw_sha256_hex: Option<String>,
    sqlite_ownership_count: i64,
    local_storage_ownership_count: i64,
    expected_ownership_breakdown_matched: bool,
    backup_created: bool,
    backup_leaf_name: Option<&'static str>,
    backup_sha256_hex: Option<String>,
    backup_mode: Option<&'static str>,
    removal_authorized: bool,
    restart_required: bool,
    no_network: bool,
    identity_mutation_performed: bool,
    error_code: Option<&'static str>,
}

impl OrphanReconciliationResult {
    fn blocked(failure: OrphanFailure) -> Self {
        Self {
            schema: ORPHAN_SCHEMA,
            ok: false,
            verdict: "blocked",
            sqlite_fingerprint_sha256_hex: None,
            local_storage_fingerprint_sha256_hex: None,
            sqlite_row_sha256_hex: None,
            local_storage_raw_sha256_hex: None,
            sqlite_ownership_count: -1,
            local_storage_ownership_count: -1,
            expected_ownership_breakdown_matched: false,
            backup_created: false,
            backup_leaf_name: None,
            backup_sha256_hex: None,
            backup_mode: None,
            removal_authorized: false,
            restart_required: false,
            no_network: true,
            identity_mutation_performed: false,
            error_code: Some(failure.code()),
        }
    }
}

/* Counts rows whose peer column equals `peer_id`, over the fixed column set.
 * Returns (total, per_column). A missing table fails closed. */
async fn orphan_ownership(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    peer_id: &str,
) -> Result<(i64, Vec<i64>), OrphanFailure> {
    let mut per_column = Vec::with_capacity(ORPHAN_PEER_SCOPED_COLUMNS.len());
    let mut total = 0_i64;
    for (table, column, _) in ORPHAN_PEER_SCOPED_COLUMNS {
        let sql = format!("SELECT COUNT(*) FROM \"{table}\" WHERE \"{column}\" = ?");
        let count = sqlx::query_scalar::<_, i64>(&sql)
            .bind(peer_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|_| OrphanFailure::TransactionFailed)?;
        total += count;
        per_column.push(count);
    }
    Ok((total, per_column))
}

async fn orphan_evidence(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    sqlite: &ValidIdentity,
    candidate: &ValidIdentity,
    expected_sqlite_row_sha256_hex: &str,
    expected_sqlite_fingerprint: &str,
    expected_local_fingerprint: &str,
) -> Result<(i64, i64, bool), OrphanFailure> {
    if sqlite.fingerprint != expected_sqlite_fingerprint {
        return Err(OrphanFailure::SqliteFingerprintMismatch);
    }
    if sha256_hex(&sqlite.raw) != expected_sqlite_row_sha256_hex {
        return Err(OrphanFailure::SqliteRowDigestMismatch);
    }
    if candidate.fingerprint != expected_local_fingerprint {
        return Err(OrphanFailure::CandidateFingerprintMismatch);
    }
    if candidate.fingerprint == sqlite.fingerprint || candidate.raw == sqlite.raw {
        return Err(OrphanFailure::CandidateNotDivergent);
    }

    let (sqlite_total, sqlite_per_column) = orphan_ownership(tx, &sqlite.sync_peer_id).await?;
    let (candidate_total, _) = orphan_ownership(tx, &candidate.sync_peer_id).await?;
    if candidate_total != 0 {
        return Err(OrphanFailure::CandidateOwnsRows);
    }
    let breakdown_matched = sqlite_per_column
        .iter()
        .zip(ORPHAN_PEER_SCOPED_COLUMNS.iter())
        .all(|(actual, (_, _, expected))| actual == expected);
    if !breakdown_matched || sqlite_total != ORPHAN_EXPECTED_SQLITE_OWNERSHIP {
        return Err(OrphanFailure::OwnershipMismatch);
    }

    /* Neither peer may hold object state or a watermark: the remediation must
     * not silently strand an in-flight or observed peer-scoped record. */
    for peer in [&sqlite.sync_peer_id, &candidate.sync_peer_id] {
        let object_rows = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sync_object_state WHERE sync_peer_id = ?",
        )
        .bind(peer)
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| OrphanFailure::TransactionFailed)?;
        if object_rows != 0 {
            return Err(OrphanFailure::ObjectStatePresent);
        }
        let watermark_rows = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sync_peer_watermarks \
             WHERE observing_peer_id = ? OR source_peer_id = ?",
        )
        .bind(peer)
        .bind(peer)
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| OrphanFailure::TransactionFailed)?;
        if watermark_rows != 0 {
            return Err(OrphanFailure::WatermarkPresent);
        }
    }

    /* Re-read and re-hash: the authoritative row must not have moved under us. */
    let reread = identity_raw(tx)
        .await
        .map_err(|_| OrphanFailure::TransactionFailed)?
        .ok_or(OrphanFailure::RowChangedDuringInspection)?;
    if reread != sqlite.raw || sha256_hex(&reread) != expected_sqlite_row_sha256_hex {
        return Err(OrphanFailure::RowChangedDuringInspection);
    }
    Ok((sqlite_total, candidate_total, breakdown_matched))
}

fn orphan_backup_paths(root: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    (
        root.join(ORPHAN_BACKUP_FILE),
        root.join(ORPHAN_BACKUP_TEMP_FILE),
    )
}

fn orphan_backup_document(
    candidate: &ValidIdentity,
    sqlite: &ValidIdentity,
    created_at: &str,
) -> String {
    /* Field order is fixed so the digest is reproducible. */
    serde_json::json!({
        "schema": ORPHAN_BACKUP_SCHEMA,
        "operation": ORPHAN_OPERATION,
        "createdAt": created_at,
        "localStorageIdentityRaw": candidate.raw,
        "localStorageRawSha256Hex": sha256_hex(&candidate.raw),
        "localStorageFingerprintSha256Hex": candidate.fingerprint,
        "sqliteFingerprintSha256Hex": sqlite.fingerprint,
        "sqliteRowSha256Hex": sha256_hex(&sqlite.raw),
    })
    .to_string()
}

/* The exact field set a protected backup may carry. A missing or unexpected
 * field fails closed — the document shape is itself an authority. */
const ORPHAN_BACKUP_FIELDS: &[&str] = &[
    "schema",
    "operation",
    "createdAt",
    "localStorageIdentityRaw",
    "localStorageRawSha256Hex",
    "localStorageFingerprintSha256Hex",
    "sqliteFingerprintSha256Hex",
    "sqliteRowSha256Hex",
];

/* `createdAt` is creation metadata, not identity or security authority. It is
 * validated against the same timestamp contract the prepare arguments use, but
 * it is never compared between an existing backup and a later prepare. */
fn orphan_created_at_valid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64
}

/* Structural reuse check for an already-present protected backup.
 *
 * The previous implementation compared the whole document byte-for-byte. Because
 * the document embeds `createdAt`, and JavaScript supplies a fresh
 * `new Date().toISOString()` on every prepare, a second inspection over the
 * IDENTICAL proven identity authority produced a different document and was
 * rejected as a conflict — which also made reconciliation unreachable after a
 * restart, since apply begins by running prepare again.
 *
 * Reuse is now decided by the immutable authority bindings only. Every one of
 * them must match exactly; anything else still fails closed. */
fn orphan_existing_backup_reusable(
    existing: &str,
    candidate: &ValidIdentity,
    sqlite: &ValidIdentity,
) -> Result<(), OrphanFailure> {
    let parsed: serde_json::Value =
        serde_json::from_str(existing).map_err(|_| OrphanFailure::BackupConflict)?;
    let object = parsed.as_object().ok_or(OrphanFailure::BackupConflict)?;
    /* Exact field set: no missing field, no unexpected field. */
    if object.len() != ORPHAN_BACKUP_FIELDS.len()
        || !ORPHAN_BACKUP_FIELDS
            .iter()
            .all(|field| object.contains_key(*field))
    {
        return Err(OrphanFailure::BackupConflict);
    }
    let field = |name: &str| -> Result<&str, OrphanFailure> {
        object
            .get(name)
            .and_then(|value| value.as_str())
            .ok_or(OrphanFailure::BackupConflict)
    };
    /* Creation metadata: shape-checked, never compared to the new value. */
    if !orphan_created_at_valid(field("createdAt")?) {
        return Err(OrphanFailure::BackupConflict);
    }
    /* Immutable authority bindings — all exact. */
    let expected: [(&str, String); 7] = [
        ("schema", ORPHAN_BACKUP_SCHEMA.to_string()),
        ("operation", ORPHAN_OPERATION.to_string()),
        ("localStorageIdentityRaw", candidate.raw.clone()),
        ("localStorageRawSha256Hex", sha256_hex(&candidate.raw)),
        (
            "localStorageFingerprintSha256Hex",
            candidate.fingerprint.clone(),
        ),
        ("sqliteFingerprintSha256Hex", sqlite.fingerprint.clone()),
        ("sqliteRowSha256Hex", sha256_hex(&sqlite.raw)),
    ];
    for (name, want) in expected.iter() {
        if field(name)? != want.as_str() {
            return Err(OrphanFailure::BackupConflict);
        }
    }
    /* Self-consistency: the recorded digests must describe the recorded raw. */
    if field("localStorageRawSha256Hex")? != sha256_hex(field("localStorageIdentityRaw")?) {
        return Err(OrphanFailure::BackupConflict);
    }
    Ok(())
}

/* Writes the protected rollback backup. Never overwrites: an existing backup is
 * reused only when every immutable authority binding matches exactly, and its
 * original bytes — including its original `createdAt` — are retained. */
fn orphan_write_backup(
    root: &std::path::Path,
    candidate: &ValidIdentity,
    sqlite: &ValidIdentity,
    created_at: &str,
) -> Result<String, OrphanFailure> {
    std::fs::create_dir_all(root).map_err(|_| OrphanFailure::BackupWriteFailed)?;
    let root_metadata =
        std::fs::symlink_metadata(root).map_err(|_| OrphanFailure::BackupWriteFailed)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(OrphanFailure::BackupWriteFailed);
    }
    let (final_path, temporary_path) = orphan_backup_paths(root);
    let document = orphan_backup_document(candidate, sqlite, created_at);
    let digest = sha256_hex(&document);

    match std::fs::symlink_metadata(&final_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(OrphanFailure::BackupConflict);
            }
            #[cfg(unix)]
            if metadata.permissions().mode() & 0o777 != 0o600 {
                return Err(OrphanFailure::BackupConflict);
            }
            let existing = std::fs::read_to_string(&final_path)
                .map_err(|_| OrphanFailure::BackupReadFailed)?;
            orphan_existing_backup_reusable(&existing, candidate, sqlite)?;
            /* Reuse: the file is never rewritten, so the caller must bind to the
             * digest of the bytes actually on disk, not the freshly built one. */
            return Ok(sha256_hex(&existing));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(OrphanFailure::BackupWriteFailed),
    }

    if std::fs::symlink_metadata(&temporary_path).is_ok() {
        return Err(OrphanFailure::BackupConflict);
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&temporary_path)
        .map_err(|_| OrphanFailure::BackupWriteFailed)?;
    if std::io::Write::write_all(&mut file, document.as_bytes()).is_err()
        || file.sync_all().is_err()
    {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(OrphanFailure::BackupWriteFailed);
    }
    drop(file);
    if std::fs::rename(&temporary_path, &final_path).is_err() {
        let _ = std::fs::remove_file(&temporary_path);
        return Err(OrphanFailure::BackupWriteFailed);
    }
    let _ = std::fs::File::open(root).and_then(|directory| directory.sync_all());
    Ok(digest)
}

fn orphan_read_backup_document(root: &std::path::Path) -> Result<String, OrphanFailure> {
    let (final_path, _) = orphan_backup_paths(root);
    let metadata =
        std::fs::symlink_metadata(&final_path).map_err(|_| OrphanFailure::BackupMissing)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(OrphanFailure::BackupReadFailed);
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o777 != 0o600 {
        return Err(OrphanFailure::BackupReadFailed);
    }
    std::fs::read_to_string(&final_path).map_err(|_| OrphanFailure::BackupReadFailed)
}

async fn orphan_prepare_transaction(
    conn: &mut SqliteConnection,
    root: &std::path::Path,
    candidate_raw: &str,
    expected_sqlite_row_sha256_hex: &str,
    expected_sqlite_fingerprint: &str,
    expected_local_fingerprint: &str,
    created_at: &str,
) -> Result<OrphanReconciliationResult, OrphanFailure> {
    let candidate = validate_identity(candidate_raw).ok_or(OrphanFailure::CandidateInvalid)?;
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| OrphanFailure::TransactionFailed)?;
    let sqlite_raw = identity_raw(&mut tx)
        .await
        .map_err(|_| OrphanFailure::TransactionFailed)?
        .ok_or(OrphanFailure::SqliteIdentityInvalid)?;
    let sqlite = validate_identity(&sqlite_raw).ok_or(OrphanFailure::SqliteIdentityInvalid)?;
    let (sqlite_total, candidate_total, breakdown_matched) = orphan_evidence(
        &mut tx,
        &sqlite,
        &candidate,
        expected_sqlite_row_sha256_hex,
        expected_sqlite_fingerprint,
        expected_local_fingerprint,
    )
    .await?;
    /* Read-only: the transaction is rolled back, never committed. */
    drop(tx);

    let backup_digest = orphan_write_backup(root, &candidate, &sqlite, created_at)?;

    Ok(OrphanReconciliationResult {
        schema: ORPHAN_SCHEMA,
        ok: true,
        verdict: ORPHAN_VERDICT,
        sqlite_fingerprint_sha256_hex: Some(sqlite.fingerprint.clone()),
        local_storage_fingerprint_sha256_hex: Some(candidate.fingerprint.clone()),
        sqlite_row_sha256_hex: Some(sha256_hex(&sqlite.raw)),
        local_storage_raw_sha256_hex: Some(sha256_hex(&candidate.raw)),
        sqlite_ownership_count: sqlite_total,
        local_storage_ownership_count: candidate_total,
        expected_ownership_breakdown_matched: breakdown_matched,
        backup_created: true,
        backup_leaf_name: Some(ORPHAN_BACKUP_FILE),
        backup_sha256_hex: Some(backup_digest),
        backup_mode: Some("0600"),
        removal_authorized: true,
        restart_required: false,
        no_network: true,
        identity_mutation_performed: false,
        error_code: None,
    })
}

fn orphan_backup_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, OrphanFailure> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(ORPHAN_BACKUP_DIRECTORY))
        .map_err(|_| OrphanFailure::BackupWriteFailed)
}

#[tauri::command]
pub async fn h2o_round2a_identity_orphan_reconciliation_prepare(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    candidate_identity_json: String,
    expected_sqlite_row_sha256_hex: String,
    expected_sqlite_fingerprint_sha256_hex: String,
    expected_local_storage_fingerprint_sha256_hex: String,
    created_at: String,
) -> Result<OrphanReconciliationResult, String> {
    let Ok(root) = orphan_backup_root(&app) else {
        return Ok(OrphanReconciliationResult::blocked(
            OrphanFailure::BackupWriteFailed,
        ));
    };
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(OrphanReconciliationResult::blocked(
            OrphanFailure::DatabaseUnavailable,
        ));
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => {
            return Ok(OrphanReconciliationResult::blocked(
                OrphanFailure::DatabaseUnavailable,
            ))
        }
    };
    Ok(
        match orphan_prepare_transaction(
            &mut conn,
            &root,
            &candidate_identity_json,
            &expected_sqlite_row_sha256_hex,
            &expected_sqlite_fingerprint_sha256_hex,
            &expected_local_storage_fingerprint_sha256_hex,
            &created_at,
        )
        .await
        {
            Ok(result) => result,
            Err(failure) => OrphanReconciliationResult::blocked(failure),
        },
    )
}

/* ── Item 11 orphan removal lease ─────────────────────────────────────────
 * The native prepare command re-reads SQLite, but between that read and the
 * JavaScript localStorage removal the pinned Profile-A recovery (or the shim's
 * identity-migration write) could still change the authoritative row. That
 * TOCTOU window is closed by a process-wide, short-lived, one-use lease:
 * authorize-remove installs it, every production identity writer fails closed
 * while it is held, and complete-remove consumes it after re-proving the row.
 *
 * The lease holds only digests and fingerprints — never raw identity material —
 * and the nonce never leaves the private orchestration result. */

const ORPHAN_LEASE_OPERATION: &str = "item11-identity-orphan-removal";
const ORPHAN_ROLLBACK_OPERATION: &str = "item11-identity-orphan-rollback";

/* One identity-mutation lease exists process-wide. Removal and rollback are
 * distinct operations on the same holder, so an active removal blocks a
 * rollback authorization and vice versa. */
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OrphanLeaseKind {
    Removal,
    Rollback,
}

impl OrphanLeaseKind {
    fn operation(self) -> &'static str {
        match self {
            Self::Removal => ORPHAN_LEASE_OPERATION,
            Self::Rollback => ORPHAN_ROLLBACK_OPERATION,
        }
    }
}
/* One immediate webview round-trip: prepare -> authorize -> re-read -> remove ->
 * complete. 30s is generous for that sequence while keeping the window in which
 * every identity writer is blocked short enough to be irrelevant to startup. */
const ORPHAN_LEASE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Clone, Debug)]
struct OrphanRemovalLease {
    kind: OrphanLeaseKind,
    operation: &'static str,
    nonce_hex: String,
    sqlite_fingerprint: String,
    sqlite_row_sha256_hex: String,
    local_storage_fingerprint: String,
    local_storage_raw_sha256_hex: String,
    backup_sha256_hex: String,
    created: std::time::Instant,
    consumed: bool,
}

impl OrphanRemovalLease {
    fn expired(&self, now: std::time::Instant) -> bool {
        now.duration_since(self.created) >= ORPHAN_LEASE_TTL
    }
}

fn orphan_lease_cell() -> &'static std::sync::Mutex<Option<OrphanRemovalLease>> {
    static CELL: std::sync::OnceLock<std::sync::Mutex<Option<OrphanRemovalLease>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(None))
}

/* A poisoned mutex must not silently disable the guard, so callers treat a
 * poisoned lock as "a lease may be held" and fail closed. */
fn orphan_lease_locked<T>(
    f: impl FnOnce(&mut Option<OrphanRemovalLease>) -> T,
) -> Result<T, OrphanFailure> {
    let mut guard = orphan_lease_cell()
        .lock()
        .map_err(|_| OrphanFailure::LeaseUnavailable)?;
    Ok(f(&mut guard))
}

/// True when an unexpired orphan-removal lease is held. Expired leases are
/// cleared as a side effect so a crashed webview cannot block writers forever.
fn orphan_lease_active() -> Result<bool, OrphanFailure> {
    orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
        }
        slot.is_some()
    })
}

/* Constant-time-ish comparison so a wrong nonce cannot be probed byte by byte. */
fn nonce_matches(expected: &str, supplied: &str) -> bool {
    let a = expected.as_bytes();
    let b = supplied.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for index in 0..a.len() {
        diff |= a[index] ^ b[index];
    }
    diff == 0
}

/* 32 bytes from the kernel CSPRNG. No timestamp, counter or hash fallback: a
 * failure here fails the authorization rather than degrading the nonce. */
fn orphan_random_nonce_hex() -> Result<String, OrphanFailure> {
    let mut buffer = [0u8; 32];
    let rc = unsafe {
        libc::getentropy(
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len() as libc::size_t,
        )
    };
    if rc != 0 {
        return Err(OrphanFailure::NonceUnavailable);
    }
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanLeaseStatusResult {
    schema: &'static str,
    active: bool,
    operation: Option<&'static str>,
    ttl_seconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAuthorizeRemoveResult {
    schema: &'static str,
    ok: bool,
    verdict: &'static str,
    /* Private orchestration field: JavaScript keeps this function-local and it
     * never reaches a public result, diagnostic, UI surface or evidence file. */
    removal_nonce: Option<String>,
    authorization_created: bool,
    expires_in_seconds: u64,
    sqlite_fingerprint_sha256_hex: Option<String>,
    sqlite_row_sha256_hex: Option<String>,
    local_storage_fingerprint_sha256_hex: Option<String>,
    backup_sha256_hex: Option<String>,
    identity_mutation_performed: bool,
    no_network: bool,
    error_code: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanLeaseOutcomeResult {
    schema: &'static str,
    ok: bool,
    verdict: &'static str,
    lease_consumed: bool,
    lease_cleared: bool,
    identity_mutation_performed: bool,
    no_network: bool,
    error_code: Option<&'static str>,
}

impl OrphanLeaseOutcomeResult {
    fn blocked(verdict: &'static str, failure: OrphanFailure) -> Self {
        Self {
            schema: ORPHAN_SCHEMA,
            ok: false,
            verdict,
            lease_consumed: false,
            lease_cleared: false,
            identity_mutation_performed: false,
            no_network: true,
            error_code: Some(failure.code()),
        }
    }
}

/* Shared re-proof used by both authorize and complete: the authoritative row and
 * the protected backup must still be exactly what prepare saw. */
async fn orphan_reprove(
    conn: &mut SqliteConnection,
    root: &std::path::Path,
    expected_sqlite_fingerprint: &str,
    expected_sqlite_row_sha256_hex: &str,
    expected_local_fingerprint: &str,
    expected_local_raw_sha256_hex: &str,
    expected_backup_sha256_hex: &str,
) -> Result<(), OrphanFailure> {
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| OrphanFailure::TransactionFailed)?;
    let sqlite_raw = identity_raw(&mut tx)
        .await
        .map_err(|_| OrphanFailure::TransactionFailed)?
        .ok_or(OrphanFailure::SqliteIdentityInvalid)?;
    drop(tx);
    let sqlite = validate_identity(&sqlite_raw).ok_or(OrphanFailure::SqliteIdentityInvalid)?;
    if sqlite.fingerprint != expected_sqlite_fingerprint {
        return Err(OrphanFailure::SqliteFingerprintMismatch);
    }
    if sha256_hex(&sqlite.raw) != expected_sqlite_row_sha256_hex {
        return Err(OrphanFailure::SqliteRowDigestMismatch);
    }
    let document = orphan_read_backup_document(root)?;
    if sha256_hex(&document) != expected_backup_sha256_hex {
        return Err(OrphanFailure::BackupConflict);
    }
    let parsed: JsonValue =
        serde_json::from_str(&document).map_err(|_| OrphanFailure::BackupReadFailed)?;
    let text = |key: &str| parsed.get(key).and_then(JsonValue::as_str).unwrap_or("");
    if text("schema") != ORPHAN_BACKUP_SCHEMA
        || text("operation") != ORPHAN_OPERATION
        || text("localStorageFingerprintSha256Hex") != expected_local_fingerprint
        || text("localStorageRawSha256Hex") != expected_local_raw_sha256_hex
        || text("sqliteFingerprintSha256Hex") != expected_sqlite_fingerprint
        || text("sqliteRowSha256Hex") != expected_sqlite_row_sha256_hex
        || expected_local_fingerprint == expected_sqlite_fingerprint
    {
        return Err(OrphanFailure::BackupReadFailed);
    }
    Ok(())
}

#[tauri::command]
pub async fn h2o_round2a_identity_orphan_reconciliation_lease_status(
) -> Result<OrphanLeaseStatusResult, String> {
    /* Fails closed: if the lock is poisoned the caller must behave as though a
     * lease is held rather than proceeding to write the identity. */
    let operation = orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
        }
        slot.as_ref().map(|lease| lease.operation)
    })
    .unwrap_or(Some(ORPHAN_LEASE_OPERATION));
    let active = operation.is_some();
    Ok(OrphanLeaseStatusResult {
        schema: ORPHAN_SCHEMA,
        active,
        operation,
        ttl_seconds: ORPHAN_LEASE_TTL.as_secs(),
    })
}

#[tauri::command]
pub async fn h2o_round2a_identity_orphan_reconciliation_authorize_remove(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    expected_sqlite_fingerprint_sha256_hex: String,
    expected_sqlite_row_sha256_hex: String,
    expected_local_storage_fingerprint_sha256_hex: String,
    expected_local_storage_raw_sha256_hex: String,
    expected_backup_sha256_hex: String,
) -> Result<OrphanAuthorizeRemoveResult, String> {
    let blocked = |failure: OrphanFailure| OrphanAuthorizeRemoveResult {
        schema: ORPHAN_SCHEMA,
        ok: false,
        verdict: "blocked",
        removal_nonce: None,
        authorization_created: false,
        expires_in_seconds: 0,
        sqlite_fingerprint_sha256_hex: None,
        sqlite_row_sha256_hex: None,
        local_storage_fingerprint_sha256_hex: None,
        backup_sha256_hex: None,
        identity_mutation_performed: false,
        no_network: true,
        error_code: Some(failure.code()),
    };
    let Ok(root) = orphan_backup_root(&app) else {
        return Ok(blocked(OrphanFailure::BackupReadFailed));
    };
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(blocked(OrphanFailure::DatabaseUnavailable));
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => return Ok(blocked(OrphanFailure::DatabaseUnavailable)),
    };
    if let Err(failure) = orphan_reprove(
        &mut conn,
        &root,
        &expected_sqlite_fingerprint_sha256_hex,
        &expected_sqlite_row_sha256_hex,
        &expected_local_storage_fingerprint_sha256_hex,
        &expected_local_storage_raw_sha256_hex,
        &expected_backup_sha256_hex,
    )
    .await
    {
        return Ok(blocked(failure));
    }
    let nonce = match orphan_random_nonce_hex() {
        Ok(value) => value,
        Err(failure) => return Ok(blocked(failure)),
    };
    let installed = orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
        }
        if slot.is_some() {
            return false;
        }
        *slot = Some(OrphanRemovalLease {
            kind: OrphanLeaseKind::Removal,
            operation: ORPHAN_LEASE_OPERATION,
            nonce_hex: nonce.clone(),
            sqlite_fingerprint: expected_sqlite_fingerprint_sha256_hex.clone(),
            sqlite_row_sha256_hex: expected_sqlite_row_sha256_hex.clone(),
            local_storage_fingerprint: expected_local_storage_fingerprint_sha256_hex.clone(),
            local_storage_raw_sha256_hex: expected_local_storage_raw_sha256_hex.clone(),
            backup_sha256_hex: expected_backup_sha256_hex.clone(),
            created: now,
            consumed: false,
        });
        true
    });
    match installed {
        Ok(true) => {}
        Ok(false) => return Ok(blocked(OrphanFailure::LeaseAlreadyActive)),
        Err(failure) => return Ok(blocked(failure)),
    }
    Ok(OrphanAuthorizeRemoveResult {
        schema: ORPHAN_SCHEMA,
        ok: true,
        verdict: "orphan-removal-authorized",
        removal_nonce: Some(nonce),
        authorization_created: true,
        expires_in_seconds: ORPHAN_LEASE_TTL.as_secs(),
        sqlite_fingerprint_sha256_hex: Some(expected_sqlite_fingerprint_sha256_hex),
        sqlite_row_sha256_hex: Some(expected_sqlite_row_sha256_hex),
        local_storage_fingerprint_sha256_hex: Some(expected_local_storage_fingerprint_sha256_hex),
        backup_sha256_hex: Some(expected_backup_sha256_hex),
        identity_mutation_performed: false,
        no_network: true,
        error_code: None,
    })
}

#[tauri::command]
pub async fn h2o_round2a_identity_orphan_reconciliation_complete_remove(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    removal_nonce: String,
    expected_sqlite_fingerprint_sha256_hex: String,
    expected_sqlite_row_sha256_hex: String,
    expected_local_storage_raw_sha256_hex: String,
    expected_backup_sha256_hex: String,
) -> Result<OrphanLeaseOutcomeResult, String> {
    const VERDICT: &str = "orphan-removal-completed";
    let Ok(root) = orphan_backup_root(&app) else {
        return Ok(OrphanLeaseOutcomeResult::blocked(
            VERDICT,
            OrphanFailure::BackupReadFailed,
        ));
    };
    /* Inspect the lease WITHOUT consuming it: a wrong-nonce or drifted-digest
     * completion must leave a still-valid lease intact so the orchestrator can
     * cancel deliberately. Only expiry or an unsafe lease clears it here. */
    let inspected = orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
            return Err(OrphanFailure::LeaseExpired);
        }
        let Some(lease) = slot.as_ref() else {
            return Err(OrphanFailure::LeaseMissing);
        };
        if lease.consumed {
            return Err(OrphanFailure::LeaseAlreadyConsumed);
        }
        if lease.kind != OrphanLeaseKind::Removal {
            return Err(OrphanFailure::LeaseOperationMismatch);
        }
        if !nonce_matches(&lease.nonce_hex, &removal_nonce) {
            return Err(OrphanFailure::LeaseNonceMismatch);
        }
        if lease.sqlite_fingerprint != expected_sqlite_fingerprint_sha256_hex
            || lease.sqlite_row_sha256_hex != expected_sqlite_row_sha256_hex
            || lease.local_storage_raw_sha256_hex != expected_local_storage_raw_sha256_hex
            || lease.backup_sha256_hex != expected_backup_sha256_hex
        {
            return Err(OrphanFailure::LeaseBindingMismatch);
        }
        Ok(lease.local_storage_fingerprint.clone())
    });
    let local_fingerprint = match inspected {
        Ok(Ok(value)) => value,
        Ok(Err(failure)) => return Ok(OrphanLeaseOutcomeResult::blocked(VERDICT, failure)),
        Err(failure) => return Ok(OrphanLeaseOutcomeResult::blocked(VERDICT, failure)),
    };
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(OrphanLeaseOutcomeResult::blocked(
            VERDICT,
            OrphanFailure::DatabaseUnavailable,
        ));
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => {
            return Ok(OrphanLeaseOutcomeResult::blocked(
                VERDICT,
                OrphanFailure::DatabaseUnavailable,
            ))
        }
    };
    if let Err(failure) = orphan_reprove(
        &mut conn,
        &root,
        &expected_sqlite_fingerprint_sha256_hex,
        &expected_sqlite_row_sha256_hex,
        &local_fingerprint,
        &expected_local_storage_raw_sha256_hex,
        &expected_backup_sha256_hex,
    )
    .await
    {
        return Ok(OrphanLeaseOutcomeResult::blocked(VERDICT, failure));
    }
    /* Consume exactly once, re-checking the nonce under the same lock. */
    let consumed = orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        match slot.as_mut() {
            Some(lease)
                if !lease.expired(now)
                    && !lease.consumed
                    && nonce_matches(&lease.nonce_hex, &removal_nonce) =>
            {
                lease.consumed = true;
                *slot = None;
                true
            }
            _ => false,
        }
    });
    match consumed {
        Ok(true) => Ok(OrphanLeaseOutcomeResult {
            schema: ORPHAN_SCHEMA,
            ok: true,
            verdict: VERDICT,
            lease_consumed: true,
            lease_cleared: true,
            identity_mutation_performed: false,
            no_network: true,
            error_code: None,
        }),
        Ok(false) => Ok(OrphanLeaseOutcomeResult::blocked(
            VERDICT,
            OrphanFailure::LeaseAlreadyConsumed,
        )),
        Err(failure) => Ok(OrphanLeaseOutcomeResult::blocked(VERDICT, failure)),
    }
}

#[tauri::command]
pub async fn h2o_round2a_identity_orphan_reconciliation_cancel_remove(
    removal_nonce: String,
) -> Result<OrphanLeaseOutcomeResult, String> {
    const VERDICT: &str = "orphan-removal-cancelled";
    let cleared = orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            /* An expired lease is cleared idempotently regardless of nonce. */
            *slot = None;
            return Ok(true);
        }
        let Some(lease) = slot.as_ref() else {
            return Ok(false);
        };
        if lease.kind != OrphanLeaseKind::Removal {
            return Err(OrphanFailure::LeaseOperationMismatch);
        }
        if !nonce_matches(&lease.nonce_hex, &removal_nonce) {
            return Err(OrphanFailure::LeaseNonceMismatch);
        }
        *slot = None;
        Ok(true)
    });
    match cleared {
        Ok(Ok(cleared)) => Ok(OrphanLeaseOutcomeResult {
            schema: ORPHAN_SCHEMA,
            ok: true,
            verdict: VERDICT,
            lease_consumed: false,
            lease_cleared: cleared,
            identity_mutation_performed: false,
            no_network: true,
            error_code: None,
        }),
        Ok(Err(failure)) => Ok(OrphanLeaseOutcomeResult::blocked(VERDICT, failure)),
        Err(failure) => Ok(OrphanLeaseOutcomeResult::blocked(VERDICT, failure)),
    }
}

/* ── Item 11 rollback authorization ───────────────────────────────────────
 * The raw backed-up identity is sensitive recovery material. It used to be
 * readable by any webview script that could name the command; it now crosses
 * into JavaScript exactly once, under a short-lived one-use nonce bound to the
 * same digests the reconciliation proved. Rollback shares the single
 * identity-mutation lease with removal, so the two can never overlap. */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAuthorizeRollbackResult {
    schema: &'static str,
    ok: bool,
    verdict: &'static str,
    /* Private orchestration field only. */
    rollback_nonce: Option<String>,
    rollback_authorized: bool,
    ttl_seconds: u64,
    backup_leaf_name: Option<&'static str>,
    backup_sha256_hex: Option<String>,
    sqlite_fingerprint_sha256_hex: Option<String>,
    sqlite_row_sha256_hex: Option<String>,
    local_storage_raw_sha256_hex: Option<String>,
    local_storage_fingerprint_sha256_hex: Option<String>,
    identity_mutation_performed: bool,
    no_network: bool,
    error_code: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanRawBackupResult {
    schema: &'static str,
    ok: bool,
    /* The ONLY field in the whole surface that carries raw identity material,
     * returned once and only against a consumed one-use rollback nonce. */
    local_storage_identity_raw: Option<String>,
    local_storage_raw_sha256_hex: Option<String>,
    local_storage_fingerprint_sha256_hex: Option<String>,
    sqlite_fingerprint_sha256_hex: Option<String>,
    lease_consumed: bool,
    no_network: bool,
    error_code: Option<&'static str>,
}

impl OrphanRawBackupResult {
    fn blocked(failure: OrphanFailure) -> Self {
        Self {
            schema: ORPHAN_BACKUP_SCHEMA,
            ok: false,
            local_storage_identity_raw: None,
            local_storage_raw_sha256_hex: None,
            local_storage_fingerprint_sha256_hex: None,
            sqlite_fingerprint_sha256_hex: None,
            lease_consumed: false,
            no_network: true,
            error_code: Some(failure.code()),
        }
    }
}

/* Shared proof for rollback authorization and the one-time read: the SQLite row
 * must still be the original, and the backup must still be the exact protected
 * file the reconciliation wrote. Returns the validated orphan identity. */
async fn orphan_rollback_reprove(
    conn: &mut SqliteConnection,
    root: &std::path::Path,
    expected_sqlite_fingerprint: &str,
    expected_sqlite_row_sha256_hex: &str,
    expected_backup_sha256_hex: &str,
    expected_local_raw_sha256_hex: &str,
    expected_local_fingerprint: &str,
) -> Result<ValidIdentity, OrphanFailure> {
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| OrphanFailure::TransactionFailed)?;
    let sqlite_raw = identity_raw(&mut tx)
        .await
        .map_err(|_| OrphanFailure::TransactionFailed)?
        .ok_or(OrphanFailure::SqliteIdentityInvalid)?;
    drop(tx);
    let sqlite = validate_identity(&sqlite_raw).ok_or(OrphanFailure::SqliteIdentityInvalid)?;
    if sqlite.fingerprint != expected_sqlite_fingerprint {
        return Err(OrphanFailure::SqliteFingerprintMismatch);
    }
    if sha256_hex(&sqlite.raw) != expected_sqlite_row_sha256_hex {
        return Err(OrphanFailure::SqliteRowDigestMismatch);
    }
    let document = orphan_read_backup_document(root)?;
    if sha256_hex(&document) != expected_backup_sha256_hex {
        return Err(OrphanFailure::BackupConflict);
    }
    let parsed: JsonValue =
        serde_json::from_str(&document).map_err(|_| OrphanFailure::BackupReadFailed)?;
    let text = |key: &str| parsed.get(key).and_then(JsonValue::as_str).unwrap_or("");
    if text("schema") != ORPHAN_BACKUP_SCHEMA || text("operation") != ORPHAN_OPERATION {
        return Err(OrphanFailure::BackupReadFailed);
    }
    let raw = text("localStorageIdentityRaw").to_owned();
    let restored = validate_identity(&raw).ok_or(OrphanFailure::BackupReadFailed)?;
    if sha256_hex(&raw) != text("localStorageRawSha256Hex")
        || sha256_hex(&raw) != expected_local_raw_sha256_hex
        || restored.fingerprint != text("localStorageFingerprintSha256Hex")
        || restored.fingerprint != expected_local_fingerprint
        || text("sqliteFingerprintSha256Hex") != expected_sqlite_fingerprint
        || text("sqliteRowSha256Hex") != expected_sqlite_row_sha256_hex
        || restored.fingerprint == sqlite.fingerprint
    {
        return Err(OrphanFailure::BackupReadFailed);
    }
    Ok(restored)
}

#[tauri::command]
pub async fn h2o_round2a_identity_orphan_reconciliation_authorize_rollback(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    expected_sqlite_fingerprint_sha256_hex: String,
    expected_sqlite_row_sha256_hex: String,
    expected_backup_sha256_hex: String,
    expected_local_storage_raw_sha256_hex: String,
    expected_local_storage_fingerprint_sha256_hex: String,
) -> Result<OrphanAuthorizeRollbackResult, String> {
    let blocked = |failure: OrphanFailure| OrphanAuthorizeRollbackResult {
        schema: ORPHAN_SCHEMA,
        ok: false,
        verdict: "blocked",
        rollback_nonce: None,
        rollback_authorized: false,
        ttl_seconds: 0,
        backup_leaf_name: None,
        backup_sha256_hex: None,
        sqlite_fingerprint_sha256_hex: None,
        sqlite_row_sha256_hex: None,
        local_storage_raw_sha256_hex: None,
        local_storage_fingerprint_sha256_hex: None,
        identity_mutation_performed: false,
        no_network: true,
        error_code: Some(failure.code()),
    };
    let Ok(root) = orphan_backup_root(&app) else {
        return Ok(blocked(OrphanFailure::BackupReadFailed));
    };
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(blocked(OrphanFailure::DatabaseUnavailable));
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => return Ok(blocked(OrphanFailure::DatabaseUnavailable)),
    };
    if let Err(failure) = orphan_rollback_reprove(
        &mut conn,
        &root,
        &expected_sqlite_fingerprint_sha256_hex,
        &expected_sqlite_row_sha256_hex,
        &expected_backup_sha256_hex,
        &expected_local_storage_raw_sha256_hex,
        &expected_local_storage_fingerprint_sha256_hex,
    )
    .await
    {
        return Ok(blocked(failure));
    }
    let nonce = match orphan_random_nonce_hex() {
        Ok(value) => value,
        Err(failure) => return Ok(blocked(failure)),
    };
    let installed = orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
        }
        /* One identity-mutation lease process-wide: an active removal blocks a
         * rollback authorization exactly as a rollback blocks a removal. */
        if slot.is_some() {
            return false;
        }
        *slot = Some(OrphanRemovalLease {
            kind: OrphanLeaseKind::Rollback,
            operation: OrphanLeaseKind::Rollback.operation(),
            nonce_hex: nonce.clone(),
            sqlite_fingerprint: expected_sqlite_fingerprint_sha256_hex.clone(),
            sqlite_row_sha256_hex: expected_sqlite_row_sha256_hex.clone(),
            local_storage_fingerprint: expected_local_storage_fingerprint_sha256_hex.clone(),
            local_storage_raw_sha256_hex: expected_local_storage_raw_sha256_hex.clone(),
            backup_sha256_hex: expected_backup_sha256_hex.clone(),
            created: now,
            consumed: false,
        });
        true
    });
    match installed {
        Ok(true) => {}
        Ok(false) => return Ok(blocked(OrphanFailure::LeaseAlreadyActive)),
        Err(failure) => return Ok(blocked(failure)),
    }
    Ok(OrphanAuthorizeRollbackResult {
        schema: ORPHAN_SCHEMA,
        ok: true,
        verdict: "orphan-rollback-authorized",
        rollback_nonce: Some(nonce),
        rollback_authorized: true,
        ttl_seconds: ORPHAN_LEASE_TTL.as_secs(),
        backup_leaf_name: Some(ORPHAN_BACKUP_FILE),
        backup_sha256_hex: Some(expected_backup_sha256_hex),
        sqlite_fingerprint_sha256_hex: Some(expected_sqlite_fingerprint_sha256_hex),
        sqlite_row_sha256_hex: Some(expected_sqlite_row_sha256_hex),
        local_storage_raw_sha256_hex: Some(expected_local_storage_raw_sha256_hex),
        local_storage_fingerprint_sha256_hex: Some(expected_local_storage_fingerprint_sha256_hex),
        identity_mutation_performed: false,
        no_network: true,
        error_code: None,
    })
}

#[tauri::command]
pub async fn h2o_round2a_identity_orphan_reconciliation_read_backup_with_nonce(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    rollback_nonce: String,
    expected_sqlite_fingerprint_sha256_hex: String,
    expected_sqlite_row_sha256_hex: String,
    expected_backup_sha256_hex: String,
    expected_local_storage_raw_sha256_hex: String,
) -> Result<OrphanRawBackupResult, String> {
    let Ok(root) = orphan_backup_root(&app) else {
        return Ok(OrphanRawBackupResult::blocked(
            OrphanFailure::BackupReadFailed,
        ));
    };
    /* Inspect without consuming: a wrong nonce must never burn a valid lease. */
    let inspected = orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
            return Err(OrphanFailure::LeaseExpired);
        }
        let Some(lease) = slot.as_ref() else {
            return Err(OrphanFailure::LeaseMissing);
        };
        if lease.kind != OrphanLeaseKind::Rollback {
            return Err(OrphanFailure::LeaseOperationMismatch);
        }
        if lease.consumed {
            return Err(OrphanFailure::LeaseAlreadyConsumed);
        }
        if !nonce_matches(&lease.nonce_hex, &rollback_nonce) {
            return Err(OrphanFailure::LeaseNonceMismatch);
        }
        if lease.sqlite_fingerprint != expected_sqlite_fingerprint_sha256_hex
            || lease.sqlite_row_sha256_hex != expected_sqlite_row_sha256_hex
            || lease.backup_sha256_hex != expected_backup_sha256_hex
            || lease.local_storage_raw_sha256_hex != expected_local_storage_raw_sha256_hex
        {
            return Err(OrphanFailure::LeaseBindingMismatch);
        }
        Ok(lease.local_storage_fingerprint.clone())
    });
    let local_fingerprint = match inspected {
        Ok(Ok(value)) => value,
        Ok(Err(failure)) => return Ok(OrphanRawBackupResult::blocked(failure)),
        Err(failure) => return Ok(OrphanRawBackupResult::blocked(failure)),
    };
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(OrphanRawBackupResult::blocked(
            OrphanFailure::DatabaseUnavailable,
        ));
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => {
            return Ok(OrphanRawBackupResult::blocked(
                OrphanFailure::DatabaseUnavailable,
            ))
        }
    };
    let restored = match orphan_rollback_reprove(
        &mut conn,
        &root,
        &expected_sqlite_fingerprint_sha256_hex,
        &expected_sqlite_row_sha256_hex,
        &expected_backup_sha256_hex,
        &expected_local_storage_raw_sha256_hex,
        &local_fingerprint,
    )
    .await
    {
        Ok(value) => value,
        Err(failure) => return Ok(OrphanRawBackupResult::blocked(failure)),
    };
    /* Consume exactly once under the same lock, re-checking kind and nonce. */
    let consumed = orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        match slot.as_mut() {
            Some(lease)
                if !lease.expired(now)
                    && !lease.consumed
                    && lease.kind == OrphanLeaseKind::Rollback
                    && nonce_matches(&lease.nonce_hex, &rollback_nonce) =>
            {
                lease.consumed = true;
                *slot = None;
                true
            }
            _ => false,
        }
    });
    match consumed {
        Ok(true) => Ok(OrphanRawBackupResult {
            schema: ORPHAN_BACKUP_SCHEMA,
            ok: true,
            local_storage_raw_sha256_hex: Some(sha256_hex(&restored.raw)),
            local_storage_fingerprint_sha256_hex: Some(restored.fingerprint.clone()),
            sqlite_fingerprint_sha256_hex: Some(expected_sqlite_fingerprint_sha256_hex),
            local_storage_identity_raw: Some(restored.raw),
            lease_consumed: true,
            no_network: true,
            error_code: None,
        }),
        Ok(false) => Ok(OrphanRawBackupResult::blocked(
            OrphanFailure::LeaseAlreadyConsumed,
        )),
        Err(failure) => Ok(OrphanRawBackupResult::blocked(failure)),
    }
}

#[tauri::command]
pub async fn h2o_round2a_identity_orphan_reconciliation_cancel_rollback(
    rollback_nonce: String,
) -> Result<OrphanLeaseOutcomeResult, String> {
    const VERDICT: &str = "orphan-rollback-cancelled";
    let cleared = orphan_lease_locked(|slot| {
        let now = std::time::Instant::now();
        if slot.as_ref().is_some_and(|lease| lease.expired(now)) {
            *slot = None;
            return Ok(true);
        }
        let Some(lease) = slot.as_ref() else {
            return Ok(false);
        };
        if lease.kind != OrphanLeaseKind::Rollback {
            return Err(OrphanFailure::LeaseOperationMismatch);
        }
        if !nonce_matches(&lease.nonce_hex, &rollback_nonce) {
            return Err(OrphanFailure::LeaseNonceMismatch);
        }
        *slot = None;
        Ok(true)
    });
    match cleared {
        Ok(Ok(value)) => Ok(OrphanLeaseOutcomeResult {
            schema: ORPHAN_SCHEMA,
            ok: true,
            verdict: VERDICT,
            lease_consumed: false,
            lease_cleared: value,
            identity_mutation_performed: false,
            no_network: true,
            error_code: None,
        }),
        Ok(Err(failure)) => Ok(OrphanLeaseOutcomeResult::blocked(VERDICT, failure)),
        Err(failure) => Ok(OrphanLeaseOutcomeResult::blocked(VERDICT, failure)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn identity(install_id: &str) -> String {
        serde_json::json!({
            "schema": IDENTITY_SCHEMA,
            "installId": install_id,
            "physicalDeviceId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "syncPeerId": format!("studio-desktop:tauri-desktop:sqlite:{install_id}"),
            "surfaceKind": "studio-desktop",
            "appKind": "tauri-desktop",
            "storeKind": "sqlite",
            "displayName": "studio-desktop (sqlite)",
            "createdAt": "2026-07-27T10:00:00.000Z",
            "updatedAt": "2026-07-27T10:00:00.000Z",
            "surfaceHistory": []
        })
        .to_string()
    }

    async fn database(sqlite_raw: &str, candidate_raw: &str) -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("identity recovery database");
        for sql in [
            "CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE sync_object_state (
              sync_peer_id TEXT NOT NULL, object_id TEXT NOT NULL,
              pending_operation TEXT, operation_phase TEXT, intended_revision_id TEXT,
              last_error_code TEXT, last_conflict_class TEXT,
              PRIMARY KEY (sync_peer_id, object_id)
            )",
            "CREATE TABLE chats (
              id TEXT PRIMARY KEY, source_id TEXT UNIQUE, title TEXT NOT NULL DEFAULT '',
              created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
              last_message_at INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
              user_turn_count INTEGER NOT NULL DEFAULT 0, assistant_turn_count INTEGER NOT NULL DEFAULT 0,
              is_pinned INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0,
              is_starred INTEGER NOT NULL DEFAULT 0, is_deleted INTEGER NOT NULL DEFAULT 0,
              folder_id TEXT, category_id TEXT, project_id TEXT NOT NULL DEFAULT '',
              current_leaf_id TEXT, import_batch_id TEXT, meta_json TEXT NOT NULL DEFAULT '{}',
              is_saved INTEGER NOT NULL DEFAULT 0, is_linked INTEGER NOT NULL DEFAULT 0,
              linked_at INTEGER NOT NULL DEFAULT 0, linked_from TEXT NOT NULL DEFAULT '',
              link_source_href TEXT NOT NULL DEFAULT '', href TEXT, normalized_href TEXT,
              snapshot_count INTEGER NOT NULL DEFAULT 0, last_snapshot_id TEXT,
              last_captured_at INTEGER NOT NULL DEFAULT 0
            )",
            "CREATE TABLE snapshots (
              id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
              digest TEXT, message_count INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
              legacy INTEGER NOT NULL DEFAULT 0, captured_at INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}'
            )",
            "CREATE TABLE snapshot_turns (
              snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, role TEXT NOT NULL,
              outer_html TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
              meta_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (snapshot_id, turn_idx)
            )",
            "CREATE TABLE folder_bindings (chat_id TEXT PRIMARY KEY, folder_id TEXT NOT NULL)",
            "CREATE TABLE label_bindings (chat_id TEXT NOT NULL, label_id TEXT NOT NULL)",
            "CREATE TABLE tag_bindings (chat_id TEXT NOT NULL, tag_id TEXT NOT NULL)",
            "CREATE TABLE snapshot_turn_assets (snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, sha256 TEXT NOT NULL)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.expect("schema");
        }
        let sqlite = validate_identity(sqlite_raw).expect("sqlite identity");
        let candidate = validate_identity(candidate_raw).expect("candidate identity");
        sqlx::query("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, 1)")
            .bind(IDENTITY_KEY)
            .bind(sqlite_raw)
            .execute(&mut conn)
            .await
            .expect("identity seed");
        sqlx::query(
            "INSERT INTO sync_object_state VALUES (?, ?, NULL, NULL, NULL, 'round2a-get-status-invalid', NULL)",
        )
        .bind(&sqlite.sync_peer_id)
        .bind(OBJECT_ID)
        .execute(&mut conn)
        .await
        .expect("historical row");
        sqlx::query(
            "INSERT INTO sync_object_state VALUES (?, ?, 'publish', 'transport', ?, 'round2a-layout-propfind-failed', 'round2a-layout-propfind-failed')",
        )
        .bind(&candidate.sync_peer_id)
        .bind(OBJECT_ID)
        .bind(REVISION_1_ID)
        .execute(&mut conn)
        .await
        .expect("preserved row");
        sqlx::query(
            "INSERT INTO chats (
              id, title, created_at, updated_at, last_message_at, message_count,
              user_turn_count, assistant_turn_count, project_id, meta_json, is_saved,
              is_linked, linked_from, link_source_href, snapshot_count, last_snapshot_id,
              last_captured_at
            ) VALUES (?, ?, 1785153600000, 1785153600000, 1785153600000, 2, 1, 1, '', '{}', 1, 1, '', '', 1, ?, 1785153600000)",
        )
        .bind(OBJECT_ID)
        .bind(round2a_fixture_authoring::CHAT_TITLE)
        .bind(REVISION_1_ID)
        .execute(&mut conn)
        .await
        .expect("chat");
        sqlx::query(
            "INSERT INTO snapshots (id, chat_id, title, message_count, captured_at, updated_at, meta_json)
             VALUES (?, ?, ?, 2, 1785153600000, 1785153600000, '{}')",
        )
        .bind(REVISION_1_ID)
        .bind(OBJECT_ID)
        .bind(round2a_fixture_authoring::CHAT_TITLE)
        .execute(&mut conn)
        .await
        .expect("snapshot");
        for (index, role, text) in [
            (0_i64, "user", "ROUND2A SYNTHETIC REVISION 1 — INPUT"),
            (
                1_i64,
                "assistant",
                "ROUND2A SYNTHETIC REVISION 1 — RESPONSE",
            ),
        ] {
            sqlx::query("INSERT INTO snapshot_turns VALUES (?, ?, ?, ?, ?, '{}')")
                .bind(REVISION_1_ID)
                .bind(index)
                .bind(role)
                .bind(format!("<p>{text}</p>"))
                .bind(text)
                .execute(&mut conn)
                .await
                .expect("turn");
        }
        conn
    }

    #[test]
    fn guarded_recovery_is_exact_cas_and_repeat_noop() {
        let _serialized = lease_test_guard();
        clear_lease();
        block_on(async {
            let sqlite_raw = identity("11111111-2222-4333-8444-555555555555");
            let candidate_raw = identity("66666666-7777-4888-8999-aaaaaaaaaaaa");
            let expectations = RecoveryExpectations {
                sqlite_fingerprint: &validate_identity(&sqlite_raw).unwrap().fingerprint,
                preserved_fingerprint: &validate_identity(&candidate_raw).unwrap().fingerprint,
            };
            let mut conn = database(&sqlite_raw, &candidate_raw).await;
            let states_before: Vec<(String, Option<String>, Option<String>)> = sqlx::query(
                "SELECT sync_peer_id, pending_operation, last_error_code FROM sync_object_state ORDER BY sync_peer_id",
            )
            .fetch_all(&mut conn)
            .await
            .unwrap()
            .into_iter()
            .map(|row| (row.get(0), row.get(1), row.get(2)))
            .collect();
            let result = recover_transaction(&mut conn, &candidate_raw, expectations)
                .await
                .expect("guarded recovery");
            assert_eq!(result.verdict, "recovery-complete-restart-required");
            assert!(result.recovery_performed && result.restart_required);
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT value FROM kv_store WHERE key = ?")
                    .bind(IDENTITY_KEY)
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
                candidate_raw
            );
            let repeated = recover_transaction(&mut conn, &candidate_raw, expectations)
                .await
                .expect("repeat recovery");
            assert_eq!(repeated.verdict, "already-recovered");
            assert!(!repeated.recovery_performed);
            let states_after: Vec<(String, Option<String>, Option<String>)> = sqlx::query(
                "SELECT sync_peer_id, pending_operation, last_error_code FROM sync_object_state ORDER BY sync_peer_id",
            )
            .fetch_all(&mut conn)
            .await
            .unwrap()
            .into_iter()
            .map(|row| (row.get(0), row.get(1), row.get(2)))
            .collect();
            assert_eq!(states_before, states_after);
            assert!(
                round2a_fixture_authoring::is_exact_revision_1(&mut conn.begin().await.unwrap())
                    .await
            );
        });
    }

    #[test]
    fn every_guard_mismatch_writes_nothing() {
        block_on(async {
            let sqlite_raw = identity("11111111-2222-4333-8444-555555555555");
            let candidate_raw = identity("66666666-7777-4888-8999-aaaaaaaaaaaa");
            let expectations = RecoveryExpectations {
                sqlite_fingerprint: &validate_identity(&sqlite_raw).unwrap().fingerprint,
                preserved_fingerprint: &validate_identity(&candidate_raw).unwrap().fingerprint,
            };
            let mut conn = database(&sqlite_raw, &candidate_raw).await;
            sqlx::query(
                "UPDATE sync_object_state SET intended_revision_id = 'wrong' WHERE pending_operation = 'publish'",
            )
            .execute(&mut conn)
            .await
            .unwrap();
            assert_eq!(
                recover_transaction(&mut conn, &candidate_raw, expectations)
                    .await
                    .expect_err("mismatch blocks"),
                RecoveryFailure::EvidenceMismatch
            );
            assert_eq!(
                sqlx::query_scalar::<_, String>("SELECT value FROM kv_store WHERE key = ?")
                    .bind(IDENTITY_KEY)
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
                sqlite_raw
            );
        });
    }

    #[test]
    fn invalid_and_profile_b_candidates_cannot_recover() {
        let _serialized = lease_test_guard();
        clear_lease();
        block_on(async {
            let sqlite_raw = identity("11111111-2222-4333-8444-555555555555");
            let candidate_raw = identity("66666666-7777-4888-8999-aaaaaaaaaaaa");
            let expectations = RecoveryExpectations {
                sqlite_fingerprint: &validate_identity(&sqlite_raw).unwrap().fingerprint,
                preserved_fingerprint: &validate_identity(&candidate_raw).unwrap().fingerprint,
            };
            let mut conn = database(&sqlite_raw, &candidate_raw).await;
            assert_eq!(
                recover_transaction(&mut conn, "{}", expectations)
                    .await
                    .expect_err("invalid candidate"),
                RecoveryFailure::IdentityInvalid
            );
            assert_eq!(
                recover_transaction(&mut conn, &sqlite_raw, expectations)
                    .await
                    .expect_err("wrong profile candidate"),
                RecoveryFailure::EvidenceMismatch
            );
        });
    }
    /* ── Item 11 orphan-identity reconciliation ─────────────────────────── */

    /// Builds a database whose peer-scoped ownership matches the proven live
    /// breakdown: the SQLite identity owns 26 rows, the orphan owns none.
    async fn orphan_database(sqlite_raw: &str, sqlite_owned: &[(&str, i64)]) -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("orphan reconciliation database");
        for sql in [
            "CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE sync_object_state (sync_peer_id TEXT NOT NULL, object_id TEXT NOT NULL, \
             pending_operation TEXT, operation_phase TEXT, intended_revision_id TEXT, \
             last_error_code TEXT, last_conflict_class TEXT, PRIMARY KEY (sync_peer_id, object_id))",
            "CREATE TABLE sync_peer_watermarks (observing_peer_id TEXT, source_peer_id TEXT)",
            "CREATE TABLE sync_conflicts (local_peer_id TEXT, remote_peer_id TEXT, decided_by_sync_peer_id TEXT)",
            "CREATE TABLE sync_maintenance_log (requested_by_sync_peer_id TEXT)",
            "CREATE TABLE sync_tombstones (deleted_by_sync_peer_id TEXT, restored_by_sync_peer_id TEXT)",
            "CREATE TABLE sync_tombstone_reviews (remote_sync_peer_id TEXT, decided_by_sync_peer_id TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.expect("schema");
        }
        sqlx::query("INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, 0)")
            .bind(IDENTITY_KEY)
            .bind(sqlite_raw)
            .execute(&mut conn)
            .await
            .expect("identity row");
        let peer = validate_identity(sqlite_raw)
            .expect("sqlite identity")
            .sync_peer_id;
        for (column, count) in sqlite_owned {
            let (table, column) = match *column {
                "conflicts.decided" => ("sync_conflicts", "decided_by_sync_peer_id"),
                "tombstones.deleted" => ("sync_tombstones", "deleted_by_sync_peer_id"),
                "tombstones.restored" => ("sync_tombstones", "restored_by_sync_peer_id"),
                "reviews.decided" => ("sync_tombstone_reviews", "decided_by_sync_peer_id"),
                "reviews.remote" => ("sync_tombstone_reviews", "remote_sync_peer_id"),
                "objectstate" => ("sync_object_state", "sync_peer_id"),
                other => panic!("unknown ownership column {other}"),
            };
            for index in 0..*count {
                if table == "sync_object_state" {
                    sqlx::query(
                        "INSERT INTO sync_object_state (sync_peer_id, object_id) VALUES (?, ?)",
                    )
                    .bind(&peer)
                    .bind(format!("object-{index}"))
                    .execute(&mut conn)
                    .await
                    .expect("object state row");
                } else {
                    let sql = format!("INSERT INTO \"{table}\" (\"{column}\") VALUES (?)");
                    sqlx::query(&sql)
                        .bind(&peer)
                        .execute(&mut conn)
                        .await
                        .expect("ownership row");
                }
            }
        }
        conn
    }

    const PROVEN_OWNERSHIP: &[(&str, i64)] = &[
        ("reviews.decided", 20),
        ("tombstones.deleted", 4),
        ("tombstones.restored", 1),
        ("conflicts.decided", 1),
    ];

    fn temp_backup_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("h2o-orphan-test-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    async fn prepare(
        conn: &mut SqliteConnection,
        root: &std::path::Path,
        candidate_raw: &str,
        sqlite_raw: &str,
        candidate_fingerprint: &str,
    ) -> Result<OrphanReconciliationResult, OrphanFailure> {
        let sqlite = validate_identity(sqlite_raw).expect("sqlite identity");
        orphan_prepare_transaction(
            conn,
            root,
            candidate_raw,
            &sha256_hex(&sqlite.raw),
            &sqlite.fingerprint,
            candidate_fingerprint,
            "2026-08-05T00:00:00.000Z",
        )
        .await
    }

    #[test]
    fn orphan_reconciliation_authorizes_only_the_proven_pair() {
        block_on(async {
            let sqlite_raw = identity("11111111-2222-4333-8444-555555555555");
            let candidate_raw = identity("66666666-7777-4888-8999-aaaaaaaaaaaa");
            let candidate = validate_identity(&candidate_raw).unwrap();
            let root = temp_backup_root("proven");
            let mut conn = orphan_database(&sqlite_raw, PROVEN_OWNERSHIP).await;

            let result = prepare(
                &mut conn,
                &root,
                &candidate_raw,
                &sqlite_raw,
                &candidate.fingerprint,
            )
            .await
            .expect("proven pair authorizes");
            assert!(result.ok);
            assert_eq!(result.verdict, ORPHAN_VERDICT);
            assert_eq!(
                result.sqlite_ownership_count,
                ORPHAN_EXPECTED_SQLITE_OWNERSHIP
            );
            assert_eq!(result.local_storage_ownership_count, 0);
            assert!(result.expected_ownership_breakdown_matched);
            assert!(result.backup_created);
            assert!(result.removal_authorized);
            assert!(!result.identity_mutation_performed);
            assert!(result.no_network);
            assert_eq!(result.backup_mode, Some("0600"));

            /* The SQLite identity row is never written. */
            let after = sqlx::query_scalar::<_, String>("SELECT value FROM kv_store WHERE key = ?")
                .bind(IDENTITY_KEY)
                .fetch_one(&mut conn)
                .await
                .expect("identity row after prepare");
            assert_eq!(after, sqlite_raw);

            /* Backup is mode 0600, holds the exact orphan bytes, and is idempotent. */
            let backup = root.join(ORPHAN_BACKUP_FILE);
            let metadata = std::fs::symlink_metadata(&backup).expect("backup exists");
            #[cfg(unix)]
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
            assert!(!metadata.file_type().is_symlink());
            let document = std::fs::read_to_string(&backup).expect("backup readable");
            assert!(document.contains(&candidate.fingerprint));
            let repeat = prepare(
                &mut conn,
                &root,
                &candidate_raw,
                &sqlite_raw,
                &candidate.fingerprint,
            )
            .await
            .expect("identical backup is idempotent");
            assert_eq!(repeat.backup_sha256_hex, result.backup_sha256_hex);
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn orphan_reconciliation_blocks_every_wrong_authority() {
        block_on(async {
            let sqlite_raw = identity("11111111-2222-4333-8444-555555555555");
            let candidate_raw = identity("66666666-7777-4888-8999-aaaaaaaaaaaa");
            let candidate = validate_identity(&candidate_raw).unwrap();
            let sqlite = validate_identity(&sqlite_raw).unwrap();
            let root = temp_backup_root("blocked");
            let mut conn = orphan_database(&sqlite_raw, PROVEN_OWNERSHIP).await;
            let wrong = "0".repeat(64);

            /* Wrong expected SQLite raw digest. */
            assert_eq!(
                orphan_prepare_transaction(
                    &mut conn,
                    &root,
                    &candidate_raw,
                    &wrong,
                    &sqlite.fingerprint,
                    &candidate.fingerprint,
                    "2026-08-05T00:00:00.000Z"
                )
                .await
                .expect_err("digest guard"),
                OrphanFailure::SqliteRowDigestMismatch
            );
            /* Wrong SQLite fingerprint. */
            assert_eq!(
                orphan_prepare_transaction(
                    &mut conn,
                    &root,
                    &candidate_raw,
                    &sha256_hex(&sqlite.raw),
                    &wrong,
                    &candidate.fingerprint,
                    "2026-08-05T00:00:00.000Z"
                )
                .await
                .expect_err("sqlite fingerprint guard"),
                OrphanFailure::SqliteFingerprintMismatch
            );
            /* Wrong localStorage fingerprint. */
            assert_eq!(
                orphan_prepare_transaction(
                    &mut conn,
                    &root,
                    &candidate_raw,
                    &sha256_hex(&sqlite.raw),
                    &sqlite.fingerprint,
                    &wrong,
                    "2026-08-05T00:00:00.000Z"
                )
                .await
                .expect_err("candidate fingerprint guard"),
                OrphanFailure::CandidateFingerprintMismatch
            );
            /* Malformed candidate. */
            assert_eq!(
                prepare(&mut conn, &root, "{}", &sqlite_raw, &candidate.fingerprint)
                    .await
                    .expect_err("malformed candidate"),
                OrphanFailure::CandidateInvalid
            );
            /* Candidate equals the authoritative identity. */
            assert_eq!(
                prepare(
                    &mut conn,
                    &root,
                    &sqlite_raw,
                    &sqlite_raw,
                    &sqlite.fingerprint
                )
                .await
                .expect_err("not divergent"),
                OrphanFailure::CandidateNotDivergent
            );
            /* No backup was written by any blocked attempt. */
            assert!(!root.join(ORPHAN_BACKUP_FILE).exists());
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn orphan_reconciliation_blocks_wrong_ownership_shapes() {
        block_on(async {
            let sqlite_raw = identity("11111111-2222-4333-8444-555555555555");
            let candidate_raw = identity("66666666-7777-4888-8999-aaaaaaaaaaaa");
            let candidate = validate_identity(&candidate_raw).unwrap();
            let root = temp_backup_root("ownership");

            /* SQLite owns zero rows. */
            let mut empty = orphan_database(&sqlite_raw, &[]).await;
            assert_eq!(
                prepare(
                    &mut empty,
                    &root,
                    &candidate_raw,
                    &sqlite_raw,
                    &candidate.fingerprint
                )
                .await
                .expect_err("zero ownership"),
                OrphanFailure::OwnershipMismatch
            );

            /* Unexpected per-column distribution with the same total. */
            let mut skewed = orphan_database(
                &sqlite_raw,
                &[
                    ("reviews.decided", 21),
                    ("tombstones.deleted", 3),
                    ("tombstones.restored", 1),
                    ("conflicts.decided", 1),
                ],
            )
            .await;
            assert_eq!(
                prepare(
                    &mut skewed,
                    &root,
                    &candidate_raw,
                    &sqlite_raw,
                    &candidate.fingerprint
                )
                .await
                .expect_err("skewed breakdown"),
                OrphanFailure::OwnershipMismatch
            );

            /* The orphan owns a row. */
            let mut owning = orphan_database(&sqlite_raw, PROVEN_OWNERSHIP).await;
            sqlx::query("INSERT INTO sync_tombstones (deleted_by_sync_peer_id) VALUES (?)")
                .bind(&candidate.sync_peer_id)
                .execute(&mut owning)
                .await
                .expect("orphan row");
            assert_eq!(
                prepare(
                    &mut owning,
                    &root,
                    &candidate_raw,
                    &sqlite_raw,
                    &candidate.fingerprint
                )
                .await
                .expect_err("orphan owns rows"),
                OrphanFailure::CandidateOwnsRows
            );

            /* Object state present for the authoritative peer. */
            let mut stateful = orphan_database(
                &sqlite_raw,
                &[
                    ("reviews.decided", 20),
                    ("tombstones.deleted", 4),
                    ("tombstones.restored", 1),
                    ("conflicts.decided", 1),
                    ("objectstate", 1),
                ],
            )
            .await;
            assert_eq!(
                prepare(
                    &mut stateful,
                    &root,
                    &candidate_raw,
                    &sqlite_raw,
                    &candidate.fingerprint
                )
                .await
                .expect_err("object state present"),
                OrphanFailure::OwnershipMismatch
            );

            /* A watermark for either peer blocks. The per-column breakdown guard
             * expects zero watermark rows and therefore fires first; the explicit
             * WatermarkPresent / ObjectStatePresent guards stay as defence in depth
             * should that expectation ever change. Either way this fails closed
             * and writes no backup. */
            let mut watermarked = orphan_database(&sqlite_raw, PROVEN_OWNERSHIP).await;
            let peer = validate_identity(&sqlite_raw).unwrap().sync_peer_id;
            sqlx::query("INSERT INTO sync_peer_watermarks (observing_peer_id, source_peer_id) VALUES (?, ?)")
                .bind(&peer).bind(&peer)
                .execute(&mut watermarked).await.expect("watermark row");
            assert_eq!(
                prepare(
                    &mut watermarked,
                    &root,
                    &candidate_raw,
                    &sqlite_raw,
                    &candidate.fingerprint
                )
                .await
                .expect_err("watermark present"),
                OrphanFailure::OwnershipMismatch
            );
            assert!(!root.join(ORPHAN_BACKUP_FILE).exists());
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn orphan_backup_never_overwrites_mismatched_content() {
        block_on(async {
            let sqlite_raw = identity("11111111-2222-4333-8444-555555555555");
            let candidate_raw = identity("66666666-7777-4888-8999-aaaaaaaaaaaa");
            let candidate = validate_identity(&candidate_raw).unwrap();
            let root = temp_backup_root("conflict");
            std::fs::create_dir_all(&root).expect("root");
            std::fs::write(root.join(ORPHAN_BACKUP_FILE), "{\"schema\":\"other\"}").expect("stale");
            #[cfg(unix)]
            std::fs::set_permissions(
                root.join(ORPHAN_BACKUP_FILE),
                std::fs::Permissions::from_mode(0o600),
            )
            .expect("mode");
            let mut conn = orphan_database(&sqlite_raw, PROVEN_OWNERSHIP).await;
            assert_eq!(
                prepare(
                    &mut conn,
                    &root,
                    &candidate_raw,
                    &sqlite_raw,
                    &candidate.fingerprint
                )
                .await
                .expect_err("mismatched existing backup"),
                OrphanFailure::BackupConflict
            );
            /* Wrong mode is also rejected. */
            #[cfg(unix)]
            {
                std::fs::set_permissions(
                    root.join(ORPHAN_BACKUP_FILE),
                    std::fs::Permissions::from_mode(0o644),
                )
                .expect("mode");
                assert_eq!(
                    prepare(
                        &mut conn,
                        &root,
                        &candidate_raw,
                        &sqlite_raw,
                        &candidate.fingerprint
                    )
                    .await
                    .expect_err("wrong backup mode"),
                    OrphanFailure::BackupConflict
                );
            }
            let _ = std::fs::remove_dir_all(&root);
        });
    }

    #[test]
    fn pinned_profile_a_recovery_constants_are_unchanged() {
        assert_eq!(
            EXPECTED_SQLITE_FINGERPRINT,
            "48ad2eb803f1cdeb276d96cf67ada4e45befc7150c712da83124c29f8235cc23"
        );
        assert_eq!(
            EXPECTED_PRESERVED_FINGERPRINT,
            "8dbfc23940d2cb4bb4892e05183e8b4daa7db6e9f44500307941c2cb813a5b91"
        );
        /* The orphan path must never consult the pinned constants. */
        assert_ne!(
            ORPHAN_SCHEMA,
            "h2o.round2a.desktop-peer-identity-recovery.v1"
        );
        assert_eq!(ORPHAN_EXPECTED_SQLITE_OWNERSHIP, 26);
        assert_eq!(
            ORPHAN_PEER_SCOPED_COLUMNS
                .iter()
                .map(|(_, _, count)| *count)
                .sum::<i64>(),
            ORPHAN_EXPECTED_SQLITE_OWNERSHIP
        );
    }
    /* ── Item 11 removal lease ──────────────────────────────────────────── */

    /* The lease is process-wide by design, so every test that touches it must
     * run under one shared guard — otherwise parallel tests clear each other's
     * lease and the serialization assertions become meaningless. */
    fn lease_test_guard() -> std::sync::MutexGuard<'static, ()> {
        static GUARD: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        GUARD
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn clear_lease() {
        if let Ok(mut slot) = orphan_lease_cell().lock() {
            *slot = None;
        }
    }

    fn install_lease(nonce: &str, age: std::time::Duration) -> OrphanRemovalLease {
        let lease = OrphanRemovalLease {
            kind: OrphanLeaseKind::Removal,
            operation: ORPHAN_LEASE_OPERATION,
            nonce_hex: nonce.to_owned(),
            sqlite_fingerprint: "sq".into(),
            sqlite_row_sha256_hex: "sqrow".into(),
            local_storage_fingerprint: "ls".into(),
            local_storage_raw_sha256_hex: "lsraw".into(),
            backup_sha256_hex: "bk".into(),
            created: std::time::Instant::now() - age,
            consumed: false,
        };
        *orphan_lease_cell().lock().unwrap() = Some(lease.clone());
        lease
    }

    #[test]
    fn removal_lease_nonce_is_random_and_hex() {
        let a = orphan_random_nonce_hex().expect("nonce a");
        let b = orphan_random_nonce_hex().expect("nonce b");
        assert_eq!(a.len(), 64, "32 bytes as lowercase hex");
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(a, b, "two draws must differ");
        /* Not derived from a counter, timestamp or constant. */
        assert_ne!(a, "0".repeat(64));
    }

    #[test]
    fn removal_lease_nonce_comparison_is_length_and_content_exact() {
        assert!(nonce_matches("abcd", "abcd"));
        assert!(!nonce_matches("abcd", "abce"));
        assert!(!nonce_matches("abcd", "abc"));
        assert!(!nonce_matches("abcd", "abcde"));
        assert!(!nonce_matches("", "a"));
    }

    #[test]
    fn removal_lease_is_single_active_and_expires() {
        let _serialized = lease_test_guard();
        clear_lease();
        assert!(!orphan_lease_active().expect("no lease"), "starts inactive");
        install_lease("aa", std::time::Duration::from_secs(0));
        assert!(
            orphan_lease_active().expect("active"),
            "fresh lease is active"
        );
        /* An expired lease is cleared as a side effect so a crashed webview
         * cannot block identity writers forever. */
        install_lease("bb", ORPHAN_LEASE_TTL + std::time::Duration::from_secs(1));
        assert!(
            !orphan_lease_active().expect("expired"),
            "expired lease is inactive"
        );
        assert!(
            orphan_lease_cell().lock().unwrap().is_none(),
            "expired lease is cleared"
        );
        clear_lease();
    }

    #[test]
    fn removal_lease_ttl_is_thirty_seconds() {
        assert_eq!(ORPHAN_LEASE_TTL, std::time::Duration::from_secs(30));
    }

    #[test]
    fn pinned_profile_a_recovery_is_blocked_while_a_lease_is_held() {
        let _serialized = lease_test_guard();
        block_on(async {
            let sqlite_raw = identity("11111111-2222-4333-8444-555555555555");
            let candidate_raw = identity("66666666-7777-4888-8999-aaaaaaaaaaaa");
            let expectations = RecoveryExpectations {
                sqlite_fingerprint: &validate_identity(&sqlite_raw).unwrap().fingerprint,
                preserved_fingerprint: &validate_identity(&candidate_raw).unwrap().fingerprint,
            };
            clear_lease();
            install_lease("cc", std::time::Duration::from_secs(0));
            let mut conn = database(&sqlite_raw, &candidate_raw).await;
            let blocked = recover_transaction(&mut conn, &candidate_raw, expectations)
                .await
                .expect_err("lease blocks the pinned recovery write");
            assert_eq!(blocked, RecoveryFailure::IdentityWriteLeaseHeld);
            /* The identity row is untouched. */
            let after = sqlx::query_scalar::<_, String>("SELECT value FROM kv_store WHERE key = ?")
                .bind(IDENTITY_KEY)
                .fetch_one(&mut conn)
                .await
                .expect("identity row");
            assert_eq!(after, sqlite_raw);

            /* With no lease the pinned recovery behaves exactly as before. */
            clear_lease();
            let recovered = recover_transaction(&mut conn, &candidate_raw, expectations)
                .await
                .expect("recovery succeeds with no lease");
            assert!(recovered.recovery_performed);
            assert!(recovered.restart_required);
            assert_eq!(recovered.verdict, "recovery-complete-restart-required");
            clear_lease();
        });
    }

    #[test]
    fn removal_lease_error_codes_are_allowlisted_and_distinct() {
        let codes = [
            OrphanFailure::LeaseUnavailable.code(),
            OrphanFailure::LeaseAlreadyActive.code(),
            OrphanFailure::LeaseMissing.code(),
            OrphanFailure::LeaseExpired.code(),
            OrphanFailure::LeaseAlreadyConsumed.code(),
            OrphanFailure::LeaseNonceMismatch.code(),
            OrphanFailure::LeaseBindingMismatch.code(),
            OrphanFailure::NonceUnavailable.code(),
        ];
        for code in codes {
            assert!(code.starts_with("round2-item11-identity-orphan-"));
            assert!(!code.contains(' '));
        }
        let unique: std::collections::BTreeSet<&str> = codes.iter().copied().collect();
        assert_eq!(unique.len(), codes.len(), "codes are distinct");
        assert_eq!(
            RecoveryFailure::IdentityWriteLeaseHeld.code(),
            "round2a-identity-recovery-identity-write-lease-held"
        );
    }

    #[test]
    fn removal_lease_result_shapes_never_carry_raw_identity() {
        let blocked = OrphanLeaseOutcomeResult::blocked(
            "orphan-removal-completed",
            OrphanFailure::LeaseNonceMismatch,
        );
        let json = serde_json::to_string(&blocked).expect("serialize");
        assert!(!json.contains("installId"));
        assert!(!json.contains("syncPeerId"));
        assert!(!json.contains("removalNonce"));
        assert!(json.contains("\"noNetwork\":true"));
        assert!(json.contains("\"identityMutationPerformed\":false"));
    }
    /* ── Item 11 rollback authorization (Correction 5) ───────────────────── */

    fn install_rollback_lease(nonce: &str, age: std::time::Duration) {
        *orphan_lease_cell().lock().unwrap() = Some(OrphanRemovalLease {
            kind: OrphanLeaseKind::Rollback,
            operation: OrphanLeaseKind::Rollback.operation(),
            nonce_hex: nonce.to_owned(),
            sqlite_fingerprint: "sq".into(),
            sqlite_row_sha256_hex: "sqrow".into(),
            local_storage_fingerprint: "ls".into(),
            local_storage_raw_sha256_hex: "lsraw".into(),
            backup_sha256_hex: "bk".into(),
            created: std::time::Instant::now() - age,
            consumed: false,
        });
    }

    #[test]
    fn rollback_and_removal_leases_are_mutually_exclusive() {
        let _serialized = lease_test_guard();
        clear_lease();
        /* One holder, two operation kinds: whichever is installed first wins. */
        install_lease("removal", std::time::Duration::from_secs(0));
        assert!(
            orphan_lease_active().expect("active"),
            "removal lease is active"
        );
        {
            let slot = orphan_lease_cell().lock().unwrap();
            assert_eq!(slot.as_ref().unwrap().kind, OrphanLeaseKind::Removal);
        }
        clear_lease();
        install_rollback_lease("rollback", std::time::Duration::from_secs(0));
        assert!(
            orphan_lease_active().expect("active"),
            "rollback lease is active"
        );
        {
            let slot = orphan_lease_cell().lock().unwrap();
            assert_eq!(slot.as_ref().unwrap().kind, OrphanLeaseKind::Rollback);
        }
        clear_lease();
    }

    #[test]
    fn rollback_cancel_requires_the_exact_nonce_and_kind() {
        let _serialized = lease_test_guard();
        block_on(async {
            clear_lease();
            install_rollback_lease("rb-nonce", std::time::Duration::from_secs(0));
            let wrong =
                h2o_round2a_identity_orphan_reconciliation_cancel_rollback("wrong".to_string())
                    .await
                    .expect("command");
            assert!(!wrong.ok, "a wrong nonce cannot cancel a rollback lease");
            assert!(
                orphan_lease_cell().lock().unwrap().is_some(),
                "the lease survives a wrong cancel"
            );
            let right =
                h2o_round2a_identity_orphan_reconciliation_cancel_rollback("rb-nonce".to_string())
                    .await
                    .expect("command");
            assert!(right.ok && right.lease_cleared, "the exact nonce cancels");
            assert!(
                orphan_lease_cell().lock().unwrap().is_none(),
                "lease cleared"
            );

            /* A removal-kind lease must not be cancellable through the rollback
             * command, so the two operations cannot be confused. */
            install_lease("removal", std::time::Duration::from_secs(0));
            let mismatched =
                h2o_round2a_identity_orphan_reconciliation_cancel_rollback("removal".to_string())
                    .await
                    .expect("command");
            assert!(!mismatched.ok, "rollback cancel refuses a removal lease");
            assert_eq!(
                mismatched.error_code,
                Some("round2-item11-identity-orphan-lease-operation-mismatch")
            );
            clear_lease();
        });
    }

    #[test]
    fn rollback_lease_expiry_clears_and_blocks() {
        let _serialized = lease_test_guard();
        clear_lease();
        install_rollback_lease(
            "expired",
            ORPHAN_LEASE_TTL + std::time::Duration::from_secs(1),
        );
        assert!(
            !orphan_lease_active().expect("expired"),
            "expired rollback lease is inactive"
        );
        assert!(
            orphan_lease_cell().lock().unwrap().is_none(),
            "expired lease cleared"
        );
        clear_lease();
    }

    #[test]
    fn removal_completion_refuses_a_rollback_lease() {
        let _serialized = lease_test_guard();
        clear_lease();
        install_rollback_lease("rb", std::time::Duration::from_secs(0));
        /* The removal path inspects kind before nonce, so a rollback lease can
         * never be consumed by a removal completion even with a matching nonce. */
        let slot = orphan_lease_cell().lock().unwrap();
        assert_eq!(slot.as_ref().unwrap().kind, OrphanLeaseKind::Rollback);
        drop(slot);
        clear_lease();
    }

    #[test]
    fn raw_backup_result_is_the_only_carrier_of_identity_material() {
        let blocked = OrphanRawBackupResult::blocked(OrphanFailure::LeaseNonceMismatch);
        let json = serde_json::to_string(&blocked).expect("serialize");
        assert!(!json.contains("installId"));
        assert!(!json.contains("syncPeerId"));
        assert!(!json.contains("rollbackNonce"));
        assert!(json.contains("\"localStorageIdentityRaw\":null"));
        assert!(json.contains("\"noNetwork\":true"));

        /* The authorization result never carries raw material at all. */
        let auth = OrphanAuthorizeRollbackResult {
            schema: ORPHAN_SCHEMA,
            ok: false,
            verdict: "blocked",
            rollback_nonce: None,
            rollback_authorized: false,
            ttl_seconds: 0,
            backup_leaf_name: None,
            backup_sha256_hex: None,
            sqlite_fingerprint_sha256_hex: None,
            sqlite_row_sha256_hex: None,
            local_storage_raw_sha256_hex: None,
            local_storage_fingerprint_sha256_hex: None,
            identity_mutation_performed: false,
            no_network: true,
            error_code: Some(OrphanFailure::LeaseAlreadyActive.code()),
        };
        let text = serde_json::to_string(&auth).expect("serialize");
        assert!(!text.contains("localStorageIdentityRaw"));
        assert!(text.contains("\"rollbackNonce\":null"));
    }

    #[test]
    fn rollback_error_codes_are_allowlisted_and_distinct() {
        let codes = [
            OrphanFailure::LeaseOperationMismatch.code(),
            OrphanFailure::LeaseNonceMismatch.code(),
            OrphanFailure::LeaseAlreadyConsumed.code(),
            OrphanFailure::LeaseExpired.code(),
            OrphanFailure::LeaseMissing.code(),
            OrphanFailure::LeaseBindingMismatch.code(),
        ];
        for code in codes {
            assert!(code.starts_with("round2-item11-identity-orphan-"));
        }
        let unique: std::collections::BTreeSet<&str> = codes.iter().copied().collect();
        assert_eq!(unique.len(), codes.len());
    }

    /* ── Repeat-inspection backup reuse (createdAt is not authority) ────────
     * A second prepare over the SAME proven identity authority must reuse the
     * existing protected backup byte-for-byte, even though JavaScript supplies
     * a fresh `createdAt` on every call. Genuine authority drift must still
     * fail closed. */

    fn reuse_identities() -> (ValidIdentity, ValidIdentity, String, String) {
        let sqlite_raw = identity("11111111-2222-4333-8444-555555555555");
        let candidate_raw = identity("66666666-7777-4888-8999-aaaaaaaaaaaa");
        let sqlite = validate_identity(&sqlite_raw).unwrap();
        let candidate = validate_identity(&candidate_raw).unwrap();
        (candidate, sqlite, candidate_raw, sqlite_raw)
    }

    fn seed_backup(root: &std::path::Path, document: &str) {
        std::fs::create_dir_all(root).expect("root");
        std::fs::write(root.join(ORPHAN_BACKUP_FILE), document).expect("seed");
        #[cfg(unix)]
        std::fs::set_permissions(
            root.join(ORPHAN_BACKUP_FILE),
            std::fs::Permissions::from_mode(0o600),
        )
        .expect("mode");
    }

    /* Mutates exactly one field of an otherwise valid backup document. */
    fn backup_with(
        candidate: &ValidIdentity,
        sqlite: &ValidIdentity,
        edit: &dyn Fn(&mut serde_json::Map<String, serde_json::Value>),
    ) -> String {
        let base = orphan_backup_document(candidate, sqlite, "2026-08-06T15:53:00.000Z");
        let mut object: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&base).expect("object");
        edit(&mut object);
        serde_json::Value::Object(object).to_string()
    }

    #[test]
    fn orphan_backup_first_write_then_reuse_with_a_later_timestamp() {
        let (candidate, sqlite, _, _) = reuse_identities();
        let root = temp_backup_root("reuse-later-timestamp");
        /* 1. First prepare creates the backup. */
        let first = orphan_write_backup(&root, &candidate, &sqlite, "2026-08-06T15:53:00.000Z")
            .expect("first write");
        let path = root.join(ORPHAN_BACKUP_FILE);
        let first_bytes = std::fs::read(&path).expect("first bytes");
        assert_eq!(
            first,
            sha256_hex(&String::from_utf8(first_bytes.clone()).unwrap())
        );
        /* 2/3/4/5. A later createdAt reuses the same file, same bytes, same
         * digest, and the ORIGINAL createdAt is retained. */
        let second = orphan_write_backup(&root, &candidate, &sqlite, "2026-08-07T09:24:41.000Z")
            .expect("repeat prepare must succeed");
        let second_bytes = std::fs::read(&path).expect("second bytes");
        assert_eq!(second_bytes, first_bytes, "existing backup was rewritten");
        assert_eq!(
            second, first,
            "repeat prepare must return the on-disk digest"
        );
        let stored: serde_json::Value = serde_json::from_slice(&second_bytes).unwrap();
        assert_eq!(stored["createdAt"], "2026-08-06T15:53:00.000Z");
        /* 18/19. Never overwritten, and no temp file survives. */
        assert!(!root.join(ORPHAN_BACKUP_TEMP_FILE).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn set_backup_mode(path: &std::path::Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /* Insignificant JSON whitespace is not authority drift, so such a file is
     * reusable. What must hold is that the returned digest always describes the
     * bytes actually on disk: the removal lease binds to that digest, so a
     * digest for any other document would break the lease's guarantee. A file
     * that is not valid JSON at all still fails closed. */
    #[test]
    fn orphan_backup_reuse_digest_always_describes_the_bytes_on_disk() {
        let (candidate, sqlite, _, _) = reuse_identities();
        let root = temp_backup_root("reuse-digest-on-disk");
        let path = root.join(ORPHAN_BACKUP_FILE);
        let canonical = orphan_write_backup(&root, &candidate, &sqlite, "2026-08-06T15:53:00.000Z")
            .expect("first write");
        /* Rewrite the file out-of-band with a trailing newline. */
        let padded = format!("{}\n", std::fs::read_to_string(&path).unwrap());
        std::fs::write(&path, padded.as_bytes()).unwrap();
        set_backup_mode(&path, 0o600);
        let reused = orphan_write_backup(&root, &candidate, &sqlite, "2026-08-07T09:24:41.000Z")
            .expect("whitespace-only difference must remain reusable");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            padded,
            "the existing bytes must be preserved exactly"
        );
        assert_eq!(
            reused,
            sha256_hex(&padded),
            "digest must be of the real bytes"
        );
        assert_ne!(reused, canonical, "and not of a rebuilt document");
        /* Genuinely unparseable content still fails closed. */
        std::fs::write(&path, b"{\"schema\":").unwrap();
        set_backup_mode(&path, 0o600);
        assert!(matches!(
            orphan_write_backup(&root, &candidate, &sqlite, "2026-08-07T09:25:00.000Z"),
            Err(OrphanFailure::BackupConflict)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), b"{\"schema\":".to_vec());
        assert!(!root.join(ORPHAN_BACKUP_TEMP_FILE).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn orphan_backup_reuse_rejects_every_authority_drift() {
        let (candidate, sqlite, _, _) = reuse_identities();
        let other = validate_identity(&identity("99999999-9999-4999-8999-999999999999")).unwrap();
        let cases: Vec<(&str, String)> = vec![
            /* 6. different localStorage raw value */
            (
                "raw-value",
                backup_with(&candidate, &sqlite, &|o| {
                    o.insert(
                        "localStorageIdentityRaw".into(),
                        serde_json::Value::String(other.raw.clone()),
                    );
                }),
            ),
            /* 7. different localStorage raw SHA */
            (
                "raw-sha",
                backup_with(&candidate, &sqlite, &|o| {
                    o.insert(
                        "localStorageRawSha256Hex".into(),
                        serde_json::Value::String(sha256_hex("different")),
                    );
                }),
            ),
            /* 8. different orphan fingerprint */
            (
                "orphan-fingerprint",
                backup_with(&candidate, &sqlite, &|o| {
                    o.insert(
                        "localStorageFingerprintSha256Hex".into(),
                        serde_json::Value::String(other.fingerprint.clone()),
                    );
                }),
            ),
            /* 9. different SQLite fingerprint */
            (
                "sqlite-fingerprint",
                backup_with(&candidate, &sqlite, &|o| {
                    o.insert(
                        "sqliteFingerprintSha256Hex".into(),
                        serde_json::Value::String(other.fingerprint.clone()),
                    );
                }),
            ),
            /* 10. different SQLite row SHA */
            (
                "sqlite-row-sha",
                backup_with(&candidate, &sqlite, &|o| {
                    o.insert(
                        "sqliteRowSha256Hex".into(),
                        serde_json::Value::String(sha256_hex("different")),
                    );
                }),
            ),
            /* 11. wrong operation */
            (
                "operation",
                backup_with(&candidate, &sqlite, &|o| {
                    o.insert(
                        "operation".into(),
                        serde_json::Value::String("something-else".into()),
                    );
                }),
            ),
            /* 12. wrong schema */
            (
                "schema",
                backup_with(&candidate, &sqlite, &|o| {
                    o.insert(
                        "schema".into(),
                        serde_json::Value::String("h2o.other.v1".into()),
                    );
                }),
            ),
            /* 13. unexpected extra field */
            (
                "extra-field",
                backup_with(&candidate, &sqlite, &|o| {
                    o.insert("extra".into(), serde_json::Value::String("x".into()));
                }),
            ),
            /* 14. missing required field */
            (
                "missing-field",
                backup_with(&candidate, &sqlite, &|o| {
                    o.remove("sqliteRowSha256Hex");
                }),
            ),
            /* createdAt violating the accepted timestamp contract */
            (
                "created-at-empty",
                backup_with(&candidate, &sqlite, &|o| {
                    o.insert("createdAt".into(), serde_json::Value::String(String::new()));
                }),
            ),
            /* 16. malformed document */
            ("malformed", "{not json".to_string()),
        ];
        for (name, document) in cases {
            let root = temp_backup_root(&format!("reuse-drift-{name}"));
            seed_backup(&root, &document);
            let before = std::fs::read(root.join(ORPHAN_BACKUP_FILE)).expect("before");
            assert_eq!(
                orphan_write_backup(&root, &candidate, &sqlite, "2026-08-07T09:24:41.000Z")
                    .expect_err(name),
                OrphanFailure::BackupConflict,
                "case {name} must fail closed"
            );
            /* 18. a rejected existing backup is never rewritten. */
            assert_eq!(
                std::fs::read(root.join(ORPHAN_BACKUP_FILE)).expect("after"),
                before
            );
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn orphan_backup_reuse_still_requires_mode_and_file_type() {
        let (candidate, sqlite, _, _) = reuse_identities();
        let document = orphan_backup_document(&candidate, &sqlite, "2026-08-06T15:53:00.000Z");
        /* 15. wrong mode blocks even with perfect content. */
        #[cfg(unix)]
        {
            let root = temp_backup_root("reuse-mode");
            seed_backup(&root, &document);
            std::fs::set_permissions(
                root.join(ORPHAN_BACKUP_FILE),
                std::fs::Permissions::from_mode(0o644),
            )
            .expect("mode");
            assert_eq!(
                orphan_write_backup(&root, &candidate, &sqlite, "2026-08-07T09:24:41.000Z")
                    .expect_err("wrong mode"),
                OrphanFailure::BackupConflict
            );
            let _ = std::fs::remove_dir_all(&root);
        }
        /* 17. a symlink in place of the backup blocks. */
        #[cfg(unix)]
        {
            let root = temp_backup_root("reuse-symlink");
            std::fs::create_dir_all(&root).expect("root");
            let target = root.join("elsewhere.json");
            std::fs::write(&target, &document).expect("target");
            std::os::unix::fs::symlink(&target, root.join(ORPHAN_BACKUP_FILE)).expect("symlink");
            assert_eq!(
                orphan_write_backup(&root, &candidate, &sqlite, "2026-08-07T09:24:41.000Z")
                    .expect_err("symlink"),
                OrphanFailure::BackupConflict
            );
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn orphan_backup_first_creation_blocks_when_a_stale_temp_file_exists() {
        /* 19. FIRST-CREATION temp-file safety, with no final backup present.
         * The reuse path returns before this guard, and writes nothing, so a
         * stale temporary file is not consulted when an existing backup is
         * reused, where it would be inert in any case. */
        let (candidate, sqlite, _, _) = reuse_identities();
        let root = temp_backup_root("reuse-temp");
        std::fs::create_dir_all(&root).expect("root");
        std::fs::write(root.join(ORPHAN_BACKUP_TEMP_FILE), "stale").expect("temp");
        assert_eq!(
            orphan_write_backup(&root, &candidate, &sqlite, "2026-08-07T09:24:41.000Z")
                .expect_err("stale temp"),
            OrphanFailure::BackupConflict
        );
        assert!(!root.join(ORPHAN_BACKUP_FILE).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn orphan_backup_created_at_is_not_an_authority_field() {
        /* The reuse predicate must accept any contract-valid createdAt and must
         * reject a contract-invalid one, but must never compare two values. */
        let (candidate, sqlite, _, _) = reuse_identities();
        let earlier = orphan_backup_document(&candidate, &sqlite, "2026-01-01T00:00:00.000Z");
        let later = orphan_backup_document(&candidate, &sqlite, "2026-12-31T23:59:59.000Z");
        assert_ne!(earlier, later, "documents differ only by createdAt");
        assert!(orphan_existing_backup_reusable(&earlier, &candidate, &sqlite).is_ok());
        assert!(orphan_existing_backup_reusable(&later, &candidate, &sqlite).is_ok());
        assert!(orphan_created_at_valid("2026-08-06T15:53:00.000Z"));
        assert!(!orphan_created_at_valid(""));
        assert!(!orphan_created_at_valid(&"x".repeat(65)));
    }
}
