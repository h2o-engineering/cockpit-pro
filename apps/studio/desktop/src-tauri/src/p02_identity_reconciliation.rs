/*
 * P02 Desktop identity-orphan reconciliation, v2.
 *
 * The Round2A v1 mechanism is historically correct and stays frozen: it asserts
 * a total canonical ownership of exactly 26 rows and requires sync_object_state
 * to be empty. Advanced P02 state legitimately violates both, so v1 refuses it -
 * correctly. This is the versioned successor for that state, and it shares no
 * constant, lease or backup leaf with v1.
 *
 * The model is TARGET-SCOPED and fail-closed. It does not attempt to decide
 * which peers in the database are legitimate. It proves three things instead:
 *
 *   1. the exact candidate orphan owns NOTHING - across every peer-scoped
 *      surface this build understands, plaintext and hashed, and it holds no
 *      repository writer;
 *   2. the canonical Desktop identity is independently valid and authoritative;
 *   3. the COMPLETE global ownership state - canonical, governed remote,
 *      historical Desktop-class and opaque test residue alike - is byte- and
 *      hash-identical before and after.
 *
 * Rows owned by peers that are none of the above are PRE_EXISTING_OPAQUE_
 * OWNERSHIP_RESIDUE. They are never trusted, never cleaned, never rewritten and
 * never used to choose the canonical identity - but they ARE inside the global
 * preservation proof, and an owner that was not in the frozen PRE baseline is a
 * POST failure rather than newly-tolerated residue.
 *
 * The only mutation this ceremony performs is the removal of one exactly
 * CAS-bound WebKit localStorage record. SQLite receives zero writes.
 */

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection, Transaction};
use tauri::{Manager, State};

use crate::DbInstances;

const IDENTITY_KEY: &str = "h2o:sync:peer-identity:v1";
const IDENTITY_SCHEMA: &str = "h2o.studio.peer-identity.v1";
const SYNC_CONFIG_KEY: &str = "h2o:studio:sync:config:v1";

pub const V2_SCHEMA: &str = "h2o.p02.identity-orphan-reconciliation.v2";
pub const V2_BACKUP_SCHEMA: &str = "h2o.p02.identity-orphan-backup.v2";
pub const V2_OPERATION: &str = "p02-identity-orphan-reconciliation-v2";
pub const V2_ROLLBACK_OPERATION: &str = "p02-identity-orphan-reconciliation-v2-rollback";
/* The SAME governed evidence root v1 uses, so history stays in one place. The
 * v1 singleton leaf is never touched: v2 leaves are content-addressed. */
const V2_BACKUP_DIRECTORY: &str = "round2a-identity-orphan-reconciliation";
const V2_BACKUP_PREFIX: &str = "localstorage-identity-backup.";
const V2_BACKUP_SUFFIX: &str = ".v2.json";

const V2_LEASE_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/*
 * SOURCE-FROZEN allowlist of peer-scoped authoritative columns.
 *
 * (table, column, hashed). `hashed` means the column stores SHA-256 hex of the
 * syncPeerId bytes rather than the id itself, which is the canonical product
 * derivation. Live schema is discovered and compared against this list; a
 * peer-scoped column this build does not understand blocks before any lease.
 */
const V2_PEER_SCOPED_COLUMNS: &[(&str, &str, bool)] = &[
    ("sync_conflicts", "decided_by_sync_peer_id", false),
    ("sync_conflicts", "local_peer_id", false),
    ("sync_conflicts", "remote_peer_id", false),
    (
        "sync_inbound_revision_observations",
        "writer_sync_peer_id_sha256_hex",
        true,
    ),
    ("sync_maintenance_log", "requested_by_sync_peer_id", false),
    ("sync_object_state", "sync_peer_id", false),
    ("sync_peer_watermarks", "observing_peer_id", false),
    ("sync_peer_watermarks", "source_peer_id", false),
    ("sync_tombstone_reviews", "decided_by_sync_peer_id", false),
    ("sync_tombstone_reviews", "remote_sync_peer_id", false),
    ("sync_tombstones", "deleted_by_sync_peer_id", false),
    ("sync_tombstones", "restored_by_sync_peer_id", false),
];

/* The governed naming taxonomy. Any live column matching it must appear in the
 * allowlist above, or this build does not understand the schema. */
fn is_peer_scoped_name(column: &str) -> bool {
    column.ends_with("_peer_id")
        || column.ends_with("_sync_peer_id")
        || column.ends_with("peer_id_sha256_hex")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum V2Failure {
    DatabaseUnavailable,
    TransactionFailed,
    SchemaUnknownPeerColumn,
    SchemaColumnMissing,
    SqliteIdentityInvalid,
    SqliteIdentityAmbiguous,
    CandidateInvalid,
    CandidateNotDivergent,
    CandidateOwnsRows,
    CandidateWriterPresent,
    CanonicalWriterMissing,
    CanonicalFingerprintMismatch,
    CanonicalRowMismatch,
    OwnershipBaselineUnhashable,
    OwnershipBaselineChanged,
    OwnershipNewOwner,
    BackupConflict,
    BackupWriteFailed,
    BackupMissing,
    BackupReadFailed,
    TargetDrift,
    LeaseUnavailable,
    LeaseAlreadyActive,
    LeaseMissing,
    LeaseExpired,
    LeaseAlreadyConsumed,
    LeaseNonceMismatch,
    LeaseBindingMismatch,
    LeaseOperationMismatch,
    NonceUnavailable,
    RemintForbidden,
}

impl V2Failure {
    pub fn code(self) -> &'static str {
        match self {
            Self::DatabaseUnavailable => "p02-identity-orphan-v2-database-unavailable",
            Self::TransactionFailed => "p02-identity-orphan-v2-transaction-failed",
            Self::SchemaUnknownPeerColumn => "p02-identity-orphan-v2-schema-unknown-peer-column",
            Self::SchemaColumnMissing => "p02-identity-orphan-v2-schema-column-missing",
            Self::SqliteIdentityInvalid => "p02-identity-orphan-v2-sqlite-identity-invalid",
            Self::SqliteIdentityAmbiguous => "p02-identity-orphan-v2-canonical-direction-ambiguous",
            Self::CandidateInvalid => "p02-identity-orphan-v2-candidate-invalid",
            Self::CandidateNotDivergent => "p02-identity-orphan-v2-candidate-not-divergent",
            Self::CandidateOwnsRows => "p02-identity-orphan-v2-candidate-owns-rows",
            Self::CandidateWriterPresent => "p02-identity-orphan-v2-candidate-writer-present",
            Self::CanonicalWriterMissing => "p02-identity-orphan-v2-canonical-writer-missing",
            Self::CanonicalFingerprintMismatch => {
                "p02-identity-orphan-v2-canonical-fingerprint-mismatch"
            }
            Self::CanonicalRowMismatch => "p02-identity-orphan-v2-canonical-row-mismatch",
            Self::OwnershipBaselineUnhashable => {
                "p02-identity-orphan-v2-ownership-baseline-unhashable"
            }
            Self::OwnershipBaselineChanged => "p02-identity-orphan-v2-ownership-baseline-changed",
            Self::OwnershipNewOwner => "p02-identity-orphan-v2-ownership-new-owner",
            Self::BackupConflict => "p02-identity-orphan-v2-backup-conflict",
            Self::BackupWriteFailed => "p02-identity-orphan-v2-backup-write-failed",
            Self::BackupMissing => "p02-identity-orphan-v2-backup-missing",
            Self::BackupReadFailed => "p02-identity-orphan-v2-backup-read-failed",
            Self::TargetDrift => "p02-identity-orphan-v2-target-drift",
            Self::LeaseUnavailable => "p02-identity-orphan-v2-lease-unavailable",
            Self::LeaseAlreadyActive => "p02-identity-orphan-v2-lease-already-active",
            Self::LeaseMissing => "p02-identity-orphan-v2-lease-missing",
            Self::LeaseExpired => "p02-identity-orphan-v2-lease-expired",
            Self::LeaseAlreadyConsumed => "p02-identity-orphan-v2-lease-already-consumed",
            Self::LeaseNonceMismatch => "p02-identity-orphan-v2-lease-nonce-mismatch",
            Self::LeaseBindingMismatch => "p02-identity-orphan-v2-lease-binding-mismatch",
            Self::LeaseOperationMismatch => "p02-identity-orphan-v2-lease-operation-mismatch",
            Self::NonceUnavailable => "p02-identity-orphan-v2-nonce-unavailable",
            Self::RemintForbidden => "p02-identity-orphan-v2-remint-forbidden",
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

#[derive(Clone, Debug)]
pub struct ValidIdentityV2 {
    pub raw: String,
    pub raw_sha256_hex: String,
    pub sync_peer_id: String,
    pub install_id: String,
    pub fingerprint: String,
}

/* Identical acceptance rules to v1's validator: exact key set, uuid-v4 install
 * and device ids, and a syncPeerId derived from the surface triple. */
pub fn validate_identity_v2(raw: &str) -> Option<ValidIdentityV2> {
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
    if object.get("schema")?.as_str()? != IDENTITY_SCHEMA {
        return None;
    }
    let install_id = object.get("installId")?.as_str()?;
    let physical_device_id = object.get("physicalDeviceId")?.as_str()?;
    if !valid_uuid_v4(install_id) || !valid_uuid_v4(physical_device_id) {
        return None;
    }
    let surface_kind = object.get("surfaceKind")?.as_str()?;
    let app_kind = object.get("appKind")?.as_str()?;
    let store_kind = object.get("storeKind")?.as_str()?;
    let sync_peer_id = object.get("syncPeerId")?.as_str()?;
    if sync_peer_id != format!("{surface_kind}:{app_kind}:{store_kind}:{install_id}") {
        return None;
    }
    if object.get("createdAt")?.as_str()?.is_empty()
        || object.get("updatedAt")?.as_str()?.is_empty()
        || !object.get("displayName")?.is_string()
        || !object.get("surfaceHistory")?.is_array()
    {
        return None;
    }
    Some(ValidIdentityV2 {
        raw: raw.to_string(),
        raw_sha256_hex: sha256_hex(raw),
        sync_peer_id: sync_peer_id.to_string(),
        install_id: install_id.to_string(),
        fingerprint: sha256_hex(sync_peer_id),
    })
}

/* ─── schema discovery, fail closed ─────────────────────────────────────── */

async fn discover_peer_scoped_columns(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<(String, String)>, V2Failure> {
    let tables = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    )
    .fetch_all(&mut **tx)
    .await
    .map_err(|_| V2Failure::TransactionFailed)?;
    let mut discovered = Vec::new();
    for table_row in tables {
        let table: String = table_row
            .try_get("name")
            .map_err(|_| V2Failure::TransactionFailed)?;
        /* PRAGMA cannot be parameterised; the name comes from sqlite_master and
         * is re-checked against a strict identifier shape before interpolation,
         * so no uncontrolled value ever reaches SQL. */
        if !table
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(V2Failure::SchemaUnknownPeerColumn);
        }
        let columns = sqlx::query(&format!("PRAGMA table_info('{table}')"))
            .fetch_all(&mut **tx)
            .await
            .map_err(|_| V2Failure::TransactionFailed)?;
        for column_row in columns {
            let column: String = column_row
                .try_get("name")
                .map_err(|_| V2Failure::TransactionFailed)?;
            if is_peer_scoped_name(&column) {
                discovered.push((table.clone(), column));
            }
        }
    }
    discovered.sort();
    Ok(discovered)
}

/* Every discovered peer-scoped column must be understood, and every understood
 * column must exist. Either direction failing blocks before any lease. */
async fn assert_schema_coverage(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
) -> Result<Vec<(String, String)>, V2Failure> {
    let discovered = discover_peer_scoped_columns(tx).await?;
    for (table, column) in &discovered {
        if !V2_PEER_SCOPED_COLUMNS
            .iter()
            .any(|(known_table, known_column, _)| known_table == table && known_column == column)
        {
            return Err(V2Failure::SchemaUnknownPeerColumn);
        }
    }
    for (table, column, _) in V2_PEER_SCOPED_COLUMNS {
        if !discovered
            .iter()
            .any(|(found_table, found_column)| found_table == table && found_column == column)
        {
            return Err(V2Failure::SchemaColumnMissing);
        }
    }
    Ok(discovered)
}

/* ─── global ownership baseline ─────────────────────────────────────────── */

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipSurface {
    pub table: String,
    pub column: String,
    pub hashed: bool,
    pub owning_row_count: i64,
    /* Deterministic: peer values ordered lexicographically, each with its exact
     * row count. This is the complete distribution, residue included. */
    pub distribution_sha256_hex: String,
    pub distinct_owner_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OwnershipBaseline {
    pub schema: &'static str,
    pub surfaces: Vec<OwnershipSurface>,
    pub total_owning_rows: i64,
    pub baseline_sha256_hex: String,
    /* Every owner value present anywhere, ordered. POST may contain no value
     * absent from this set, and must contain every value in it. */
    pub owners_sha256_hex: String,
    pub distinct_owner_count: usize,
}

const OWNERSHIP_BASELINE_SCHEMA: &str = "h2o.p02.identity-ownership-baseline.v2";

async fn capture_ownership_baseline(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
) -> Result<OwnershipBaseline, V2Failure> {
    assert_schema_coverage(tx).await?;
    let mut surfaces = Vec::new();
    let mut total: i64 = 0;
    let mut all_owners: BTreeMap<String, i64> = BTreeMap::new();
    for (table, column, hashed) in V2_PEER_SCOPED_COLUMNS {
        /* Identifiers come only from the source-frozen allowlist above. */
        let rows = sqlx::query(&format!(
            "SELECT \"{column}\" AS owner, COUNT(*) AS owned FROM \"{table}\" \
             WHERE \"{column}\" IS NOT NULL GROUP BY \"{column}\" ORDER BY \"{column}\""
        ))
        .fetch_all(&mut **tx)
        .await
        .map_err(|_| V2Failure::TransactionFailed)?;
        let mut distribution = String::new();
        let mut owning: i64 = 0;
        let mut distinct = 0usize;
        for row in rows {
            /* A non-text owner column shape cannot be hashed deterministically;
             * block rather than approximate. */
            let owner: String = row
                .try_get("owner")
                .map_err(|_| V2Failure::OwnershipBaselineUnhashable)?;
            let owned: i64 = row
                .try_get("owned")
                .map_err(|_| V2Failure::OwnershipBaselineUnhashable)?;
            distribution.push_str(&format!("{owner}\u{1f}{owned}\u{1e}"));
            owning += owned;
            distinct += 1;
            *all_owners.entry(owner).or_insert(0) += owned;
        }
        total += owning;
        surfaces.push(OwnershipSurface {
            table: (*table).to_string(),
            column: (*column).to_string(),
            hashed: *hashed,
            owning_row_count: owning,
            distribution_sha256_hex: sha256_hex(&distribution),
            distinct_owner_count: distinct,
        });
    }
    let baseline_material = surfaces
        .iter()
        .map(|surface| {
            format!(
                "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1e}",
                surface.table,
                surface.column,
                surface.owning_row_count,
                surface.distribution_sha256_hex
            )
        })
        .collect::<String>();
    let owners_material = all_owners
        .iter()
        .map(|(owner, count)| format!("{owner}\u{1f}{count}\u{1e}"))
        .collect::<String>();
    Ok(OwnershipBaseline {
        schema: OWNERSHIP_BASELINE_SCHEMA,
        surfaces,
        total_owning_rows: total,
        baseline_sha256_hex: sha256_hex(&baseline_material),
        owners_sha256_hex: sha256_hex(&owners_material),
        distinct_owner_count: all_owners.len(),
    })
}

/* ─── orphan-zero and canonical ownership ───────────────────────────────── */

async fn peer_owned_rows(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    sync_peer_id: &str,
) -> Result<i64, V2Failure> {
    let hashed_value = sha256_hex(sync_peer_id);
    let mut total: i64 = 0;
    for (table, column, hashed) in V2_PEER_SCOPED_COLUMNS {
        let needle = if *hashed { &hashed_value } else { sync_peer_id };
        let owned: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*) FROM \"{table}\" WHERE \"{column}\" = ?"
        ))
        .bind(needle)
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| V2Failure::TransactionFailed)?;
        total += owned;
    }
    Ok(total)
}

/*
 * Repository writer ownership.
 *
 * An orphan that ever became an authoritative repository writer is not an
 * orphan at all - it owns durable P02 authority outside SQLite, and removing
 * its identity would strand that authority. The canonical peer, conversely,
 * MUST hold its writer directory: a canonical identity with no writer cannot be
 * distinguished from a second orphan.
 *
 * This is a read-only directory-presence check. Identity reconciliation never
 * mutates the repository.
 */
fn writer_directory_present(
    repository_root: &std::path::Path,
    sync_peer_id: &str,
) -> bool {
    let writer_key = crate::sync_contract_v2::writer_key_hex_v2(sync_peer_id);
    /* writer_key_hex_v2 yields lowercase hex, so it can never traverse. */
    if writer_key.len() != 64 || !writer_key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    repository_root.join("writers").join(writer_key).is_dir()
}

/* Absent repository root means no repository writers exist at all, which
 * satisfies "orphan writer absent" but cannot satisfy "canonical writer
 * present". Both are reported so the caller decides, rather than guessing. */
pub fn writer_ownership(
    repository_root: Option<&std::path::Path>,
    canonical_sync_peer_id: &str,
    orphan_sync_peer_id: &str,
) -> (bool, bool) {
    match repository_root {
        Some(root) if root.is_dir() => (
            writer_directory_present(root, canonical_sync_peer_id),
            writer_directory_present(root, orphan_sync_peer_id),
        ),
        _ => (false, false),
    }
}

async fn identity_raw(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    key: &str,
) -> Result<Option<String>, V2Failure> {
    sqlx::query_scalar::<_, String>("SELECT value FROM kv_store WHERE key = ? LIMIT 1")
        .bind(key)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| V2Failure::TransactionFailed)
}

/* ─── content-addressed append-only backup ──────────────────────────────── */

fn backup_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, V2Failure> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(V2_BACKUP_DIRECTORY))
        .map_err(|_| V2Failure::BackupWriteFailed)
}

/* The leaf name IS the proof of what it holds: a different orphan generation
 * can never collide with an earlier one, and the v1 singleton name is not in
 * this namespace at all. */
pub fn backup_leaf_name(local_storage_raw_sha256_hex: &str) -> String {
    format!("{V2_BACKUP_PREFIX}{local_storage_raw_sha256_hex}{V2_BACKUP_SUFFIX}")
}

const V2_BACKUP_FIELDS: &[&str] = &[
    "schema",
    "operation",
    "createdAt",
    "reconciliationRequestId",
    "localStorageRaw",
    "localStorageRawSha256Hex",
    "localStorageFingerprintSha256Hex",
    "orphanInstallId",
    "orphanSyncPeerId",
    "canonicalSqliteRawSha256Hex",
    "canonicalSqliteFingerprintSha256Hex",
];

fn backup_document(
    created_at: &str,
    request_id: &str,
    orphan: &ValidIdentityV2,
    canonical: &ValidIdentityV2,
) -> String {
    /* Sorted keys, so a byte-identical orphan always yields byte-identical
     * bytes and idempotent reuse is decidable by comparison alone. */
    let document = json!({
        "canonicalSqliteFingerprintSha256Hex": canonical.fingerprint,
        "canonicalSqliteRawSha256Hex": canonical.raw_sha256_hex,
        "createdAt": created_at,
        "localStorageFingerprintSha256Hex": orphan.fingerprint,
        "localStorageRaw": orphan.raw,
        "localStorageRawSha256Hex": orphan.raw_sha256_hex,
        "operation": V2_OPERATION,
        "orphanInstallId": orphan.install_id,
        "orphanSyncPeerId": orphan.sync_peer_id,
        "reconciliationRequestId": request_id,
        "schema": V2_BACKUP_SCHEMA,
    });
    serde_json::to_string(&document).unwrap_or_default()
}

fn backup_is_valid_for(existing: &str, orphan: &ValidIdentityV2) -> bool {
    let Ok(value) = serde_json::from_str::<JsonValue>(existing) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != V2_BACKUP_FIELDS.len()
        || !V2_BACKUP_FIELDS.iter().all(|key| object.contains_key(*key))
    {
        return false;
    }
    object.get("schema").and_then(JsonValue::as_str) == Some(V2_BACKUP_SCHEMA)
        && object.get("operation").and_then(JsonValue::as_str) == Some(V2_OPERATION)
        && object.get("localStorageRaw").and_then(JsonValue::as_str) == Some(orphan.raw.as_str())
        && object
            .get("localStorageRawSha256Hex")
            .and_then(JsonValue::as_str)
            == Some(orphan.raw_sha256_hex.as_str())
        && object.get("orphanSyncPeerId").and_then(JsonValue::as_str)
            == Some(orphan.sync_peer_id.as_str())
}

/* Append-only: an existing leaf is reused ONLY when it is already a fully valid
 * backup of these exact bytes. Anything else is a conflict, never an
 * overwrite. */
fn write_backup(
    root: &std::path::Path,
    orphan: &ValidIdentityV2,
    canonical: &ValidIdentityV2,
    created_at: &str,
    request_id: &str,
) -> Result<(String, String), V2Failure> {
    std::fs::create_dir_all(root).map_err(|_| V2Failure::BackupWriteFailed)?;
    let leaf = backup_leaf_name(&orphan.raw_sha256_hex);
    let path = root.join(&leaf);
    if path.exists() {
        let existing = std::fs::read_to_string(&path).map_err(|_| V2Failure::BackupReadFailed)?;
        if !backup_is_valid_for(&existing, orphan) {
            return Err(V2Failure::BackupConflict);
        }
        return Ok((leaf, sha256_hex(&existing)));
    }
    let document = backup_document(created_at, request_id, orphan, canonical);
    let temporary = root.join(format!(".{leaf}.tmp"));
    if temporary.exists() {
        return Err(V2Failure::BackupConflict);
    }
    std::fs::write(&temporary, document.as_bytes()).map_err(|_| V2Failure::BackupWriteFailed)?;
    std::fs::rename(&temporary, &path).map_err(|_| {
        let _ = std::fs::remove_file(&temporary);
        V2Failure::BackupWriteFailed
    })?;
    let readback = std::fs::read_to_string(&path).map_err(|_| V2Failure::BackupReadFailed)?;
    if readback != document {
        return Err(V2Failure::BackupWriteFailed);
    }
    Ok((leaf, sha256_hex(&document)))
}

/* ─── exact-target lease ────────────────────────────────────────────────── */

#[derive(Clone, Debug)]
struct V2Lease {
    operation: &'static str,
    request_id: String,
    nonce: String,
    local_storage_raw_sha256_hex: String,
    local_storage_fingerprint_sha256_hex: String,
    orphan_sync_peer_id: String,
    orphan_install_id: String,
    canonical_raw_sha256_hex: String,
    canonical_fingerprint_sha256_hex: String,
    backup_leaf_name: String,
    backup_sha256_hex: String,
    ownership_baseline_sha256_hex: String,
    ownership_owners_sha256_hex: String,
    created: std::time::Instant,
    consumed: bool,
}

impl V2Lease {
    fn expired(&self) -> bool {
        self.created.elapsed() >= V2_LEASE_TTL
    }
}

fn lease_cell() -> &'static std::sync::Mutex<Option<V2Lease>> {
    static CELL: std::sync::OnceLock<std::sync::Mutex<Option<V2Lease>>> =
        std::sync::OnceLock::new();
    CELL.get_or_init(|| std::sync::Mutex::new(None))
}

fn with_lease<T>(
    body: impl FnOnce(&mut Option<V2Lease>) -> Result<T, V2Failure>,
) -> Result<T, V2Failure> {
    let mut guard = lease_cell().lock().map_err(|_| V2Failure::LeaseUnavailable)?;
    body(&mut guard)
}

/* The same audited entropy source the v1 lease uses. */
fn random_hex(bytes: usize) -> Result<String, V2Failure> {
    let mut buffer = vec![0u8; bytes];
    let rc = unsafe {
        libc::getentropy(
            buffer.as_mut_ptr() as *mut libc::c_void,
            buffer.len() as libc::size_t,
        )
    };
    if rc != 0 {
        return Err(V2Failure::NonceUnavailable);
    }
    Ok(buffer.iter().map(|byte| format!("{byte:02x}")).collect())
}

/* Constant-time-ish comparison: length first, then full-content equality with
 * no early exit on the first differing byte. */
fn nonce_matches(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }
    expected
        .bytes()
        .zip(provided.bytes())
        .fold(0u8, |acc, (left, right)| acc | (left ^ right))
        == 0
}

/* ─── results ───────────────────────────────────────────────────────────── */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2PrepareResult {
    pub schema: &'static str,
    pub ok: bool,
    pub verdict: &'static str,
    pub error_code: Option<&'static str>,
    pub reconciliation_request_id: Option<String>,
    pub canonical_sync_peer_id: Option<String>,
    pub canonical_fingerprint_sha256_hex: Option<String>,
    pub canonical_raw_sha256_hex: Option<String>,
    pub canonical_owned_row_count: Option<i64>,
    pub orphan_sync_peer_id: Option<String>,
    pub orphan_fingerprint_sha256_hex: Option<String>,
    pub orphan_raw_sha256_hex: Option<String>,
    pub orphan_owned_row_count: Option<i64>,
    pub backup_leaf_name: Option<String>,
    pub backup_sha256_hex: Option<String>,
    pub ownership_baseline: Option<OwnershipBaseline>,
    pub pre_existing_opaque_ownership_rows: Option<i64>,
    pub sqlite_writes: i64,
    pub remint: bool,
}

impl V2PrepareResult {
    fn blocked(failure: V2Failure) -> Self {
        Self {
            schema: V2_SCHEMA,
            ok: false,
            verdict: "blocked",
            error_code: Some(failure.code()),
            reconciliation_request_id: None,
            canonical_sync_peer_id: None,
            canonical_fingerprint_sha256_hex: None,
            canonical_raw_sha256_hex: None,
            canonical_owned_row_count: None,
            orphan_sync_peer_id: None,
            orphan_fingerprint_sha256_hex: None,
            orphan_raw_sha256_hex: None,
            orphan_owned_row_count: None,
            backup_leaf_name: None,
            backup_sha256_hex: None,
            ownership_baseline: None,
            pre_existing_opaque_ownership_rows: None,
            sqlite_writes: 0,
            remint: false,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2LeaseResult {
    pub schema: &'static str,
    pub ok: bool,
    pub verdict: &'static str,
    pub error_code: Option<&'static str>,
    pub active: bool,
    pub operation: Option<&'static str>,
    pub reconciliation_request_id: Option<String>,
    pub nonce: Option<String>,
    pub ttl_seconds: u64,
    pub sqlite_writes: i64,
}

impl V2LeaseResult {
    fn blocked(failure: V2Failure) -> Self {
        Self {
            schema: V2_SCHEMA,
            ok: false,
            verdict: "blocked",
            error_code: Some(failure.code()),
            active: false,
            operation: None,
            reconciliation_request_id: None,
            nonce: None,
            ttl_seconds: V2_LEASE_TTL.as_secs(),
            sqlite_writes: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2CompleteResult {
    pub schema: &'static str,
    pub ok: bool,
    pub verdict: &'static str,
    pub error_code: Option<&'static str>,
    pub removed_sync_peer_id: Option<String>,
    pub ownership_baseline_preserved: bool,
    pub ownership_baseline_sha256_hex: Option<String>,
    pub canonical_sync_peer_id: Option<String>,
    pub sqlite_writes: i64,
    pub remint: bool,
}

impl V2CompleteResult {
    fn blocked(failure: V2Failure) -> Self {
        Self {
            schema: V2_SCHEMA,
            ok: false,
            verdict: "blocked",
            error_code: Some(failure.code()),
            removed_sync_peer_id: None,
            ownership_baseline_preserved: false,
            ownership_baseline_sha256_hex: None,
            canonical_sync_peer_id: None,
            sqlite_writes: 0,
            remint: false,
        }
    }
}

/* ─── evidence transaction (read-only: always rolled back) ──────────────── */

struct PrepareEvidence {
    canonical: ValidIdentityV2,
    canonical_owned: i64,
    orphan_owned: i64,
    baseline: OwnershipBaseline,
    residue_rows: i64,
    canonical_writer_present: bool,
    orphan_writer_present: bool,
}

async fn gather_evidence(
    conn: &mut SqliteConnection,
    orphan: &ValidIdentityV2,
    repository_root: Option<&std::path::Path>,
) -> Result<PrepareEvidence, V2Failure> {
    let mut tx = conn.begin().await.map_err(|_| V2Failure::DatabaseUnavailable)?;
    let outcome = async {
        let Some(canonical_raw) = identity_raw(&mut tx, IDENTITY_KEY).await? else {
            return Err(V2Failure::SqliteIdentityInvalid);
        };
        let Some(canonical) = validate_identity_v2(&canonical_raw) else {
            return Err(V2Failure::SqliteIdentityInvalid);
        };
        /* Divergence is the precondition: an orphan identical to canonical is
         * not an orphan, and reconciling it would be a no-op removal of the
         * live identity. */
        if canonical.sync_peer_id == orphan.sync_peer_id {
            return Err(V2Failure::CandidateNotDivergent);
        }
        let baseline = capture_ownership_baseline(&mut tx).await?;
        let orphan_owned = peer_owned_rows(&mut tx, &orphan.sync_peer_id).await?;
        if orphan_owned != 0 {
            return Err(V2Failure::CandidateOwnsRows);
        }
        let canonical_owned = peer_owned_rows(&mut tx, &canonical.sync_peer_id).await?;
        /* Canonical must actually be authoritative. A canonical identity that
         * owns nothing cannot be distinguished from another orphan, and this
         * path must never mint a replacement. */
        if canonical_owned == 0 {
            return Err(V2Failure::SqliteIdentityAmbiguous);
        }
        /* Repository authority, checked before any lease can be issued. */
        let (canonical_writer_present, orphan_writer_present) =
            writer_ownership(repository_root, &canonical.sync_peer_id, &orphan.sync_peer_id);
        if orphan_writer_present {
            return Err(V2Failure::CandidateWriterPresent);
        }
        if repository_root.is_some_and(|root| root.is_dir()) && !canonical_writer_present {
            return Err(V2Failure::CanonicalWriterMissing);
        }
        let residue_rows = baseline.total_owning_rows - canonical_owned;
        Ok(PrepareEvidence {
            canonical,
            canonical_owned,
            orphan_owned,
            baseline,
            residue_rows,
            canonical_writer_present,
            orphan_writer_present,
        })
    }
    .await;
    /* Evidence only: the transaction is ALWAYS rolled back, so this command
     * cannot write to SQLite even if a future edit added a statement. */
    let _ = tx.rollback().await;
    outcome
}

async fn sqlite_pool(db_instances: &DbInstances) -> Option<sqlx::SqlitePool> {
    let instances = db_instances.0.read().await;
    instances
        .iter()
        .find(|(key, _)| key.contains("studio-v1.db"))
        .and_then(|(_, db)| match db {
            tauri_plugin_sql::DbPool::Sqlite(pool) => Some(pool.clone()),
            #[allow(unreachable_patterns)]
            _ => None,
        })
}

/* ─── commands ──────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn h2o_p02_identity_orphan_reconciliation_v2_prepare(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    candidate_identity_json: String,
    created_at: String,
) -> Result<V2PrepareResult, String> {
    let Some(orphan) = validate_identity_v2(&candidate_identity_json) else {
        return Ok(V2PrepareResult::blocked(V2Failure::CandidateInvalid));
    };
    let Ok(root) = backup_root(&app) else {
        return Ok(V2PrepareResult::blocked(V2Failure::BackupWriteFailed));
    };
    /* The governed container, resolved through the existing authorized
     * delivery-directory owner - never a caller-supplied path. */
    let repository_root = crate::item11_delivery_destination::resolve_authorized_delivery_directory(&app)
        .ok()
        .map(|container| container.join("h2o-object-sync"));
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(V2PrepareResult::blocked(V2Failure::DatabaseUnavailable));
    };
    let Ok(mut conn) = pool.acquire().await else {
        return Ok(V2PrepareResult::blocked(V2Failure::DatabaseUnavailable));
    };
    let evidence = match gather_evidence(&mut conn, &orphan, repository_root.as_deref()).await {
        Ok(evidence) => evidence,
        Err(failure) => return Ok(V2PrepareResult::blocked(failure)),
    };
    let request_id = match random_hex(16) {
        Ok(value) => value,
        Err(failure) => return Ok(V2PrepareResult::blocked(failure)),
    };
    let (leaf, backup_sha) = match write_backup(
        &root,
        &orphan,
        &evidence.canonical,
        &created_at,
        &request_id,
    ) {
        Ok(value) => value,
        Err(failure) => return Ok(V2PrepareResult::blocked(failure)),
    };
    Ok(V2PrepareResult {
        schema: V2_SCHEMA,
        ok: true,
        verdict: "prepared",
        error_code: None,
        reconciliation_request_id: Some(request_id),
        canonical_sync_peer_id: Some(evidence.canonical.sync_peer_id.clone()),
        canonical_fingerprint_sha256_hex: Some(evidence.canonical.fingerprint.clone()),
        canonical_raw_sha256_hex: Some(evidence.canonical.raw_sha256_hex.clone()),
        canonical_owned_row_count: Some(evidence.canonical_owned),
        orphan_sync_peer_id: Some(orphan.sync_peer_id.clone()),
        orphan_fingerprint_sha256_hex: Some(orphan.fingerprint.clone()),
        orphan_raw_sha256_hex: Some(orphan.raw_sha256_hex.clone()),
        orphan_owned_row_count: Some(evidence.orphan_owned),
        backup_leaf_name: Some(leaf),
        backup_sha256_hex: Some(backup_sha),
        ownership_baseline: Some(evidence.baseline),
        pre_existing_opaque_ownership_rows: Some(evidence.residue_rows),
        sqlite_writes: 0,
        remint: false,
    })
}

#[tauri::command]
pub async fn h2o_p02_identity_orphan_reconciliation_v2_lease_status(
) -> Result<V2LeaseResult, String> {
    Ok(with_lease(|slot| {
        if let Some(lease) = slot.as_ref() {
            if lease.expired() || lease.consumed {
                *slot = None;
            }
        }
        Ok(match slot.as_ref() {
            Some(lease) => V2LeaseResult {
                schema: V2_SCHEMA,
                ok: true,
                verdict: "lease-active",
                error_code: None,
                active: true,
                operation: Some(lease.operation),
                reconciliation_request_id: Some(lease.request_id.clone()),
                nonce: None,
                ttl_seconds: V2_LEASE_TTL.as_secs(),
                sqlite_writes: 0,
            },
            None => V2LeaseResult {
                schema: V2_SCHEMA,
                ok: true,
                verdict: "lease-idle",
                error_code: None,
                active: false,
                operation: None,
                reconciliation_request_id: None,
                nonce: None,
                ttl_seconds: V2_LEASE_TTL.as_secs(),
                sqlite_writes: 0,
            },
        })
    })
    .unwrap_or_else(V2LeaseResult::blocked))
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn h2o_p02_identity_orphan_reconciliation_v2_authorize_remove(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    candidate_identity_json: String,
    reconciliation_request_id: String,
    expected_backup_leaf_name: String,
    expected_backup_sha256_hex: String,
    expected_ownership_baseline_sha256_hex: String,
) -> Result<V2LeaseResult, String> {
    let Some(orphan) = validate_identity_v2(&candidate_identity_json) else {
        return Ok(V2LeaseResult::blocked(V2Failure::CandidateInvalid));
    };
    let Ok(root) = backup_root(&app) else {
        return Ok(V2LeaseResult::blocked(V2Failure::BackupWriteFailed));
    };
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(V2LeaseResult::blocked(V2Failure::DatabaseUnavailable));
    };
    let Ok(mut conn) = pool.acquire().await else {
        return Ok(V2LeaseResult::blocked(V2Failure::DatabaseUnavailable));
    };
    /* Re-prove EVERYTHING at authorization time. The prepare evidence is a
     * claim; this is the check. */
    let repository_root = crate::item11_delivery_destination::resolve_authorized_delivery_directory(&app)
        .ok()
        .map(|container| container.join("h2o-object-sync"));
    let evidence = match gather_evidence(&mut conn, &orphan, repository_root.as_deref()).await {
        Ok(evidence) => evidence,
        Err(failure) => return Ok(V2LeaseResult::blocked(failure)),
    };
    if evidence.baseline.baseline_sha256_hex != expected_ownership_baseline_sha256_hex {
        return Ok(V2LeaseResult::blocked(V2Failure::OwnershipBaselineChanged));
    }
    if backup_leaf_name(&orphan.raw_sha256_hex) != expected_backup_leaf_name {
        return Ok(V2LeaseResult::blocked(V2Failure::TargetDrift));
    }
    let path = root.join(&expected_backup_leaf_name);
    let Ok(existing) = std::fs::read_to_string(&path) else {
        return Ok(V2LeaseResult::blocked(V2Failure::BackupMissing));
    };
    if sha256_hex(&existing) != expected_backup_sha256_hex
        || !backup_is_valid_for(&existing, &orphan)
    {
        return Ok(V2LeaseResult::blocked(V2Failure::BackupConflict));
    }
    let nonce = match random_hex(32) {
        Ok(value) => value,
        Err(failure) => return Ok(V2LeaseResult::blocked(failure)),
    };
    Ok(with_lease(|slot| {
        if let Some(lease) = slot.as_ref() {
            if !lease.expired() && !lease.consumed {
                return Err(V2Failure::LeaseAlreadyActive);
            }
        }
        *slot = Some(V2Lease {
            operation: V2_OPERATION,
            request_id: reconciliation_request_id.clone(),
            nonce: nonce.clone(),
            local_storage_raw_sha256_hex: orphan.raw_sha256_hex.clone(),
            local_storage_fingerprint_sha256_hex: orphan.fingerprint.clone(),
            orphan_sync_peer_id: orphan.sync_peer_id.clone(),
            orphan_install_id: orphan.install_id.clone(),
            canonical_raw_sha256_hex: evidence.canonical.raw_sha256_hex.clone(),
            canonical_fingerprint_sha256_hex: evidence.canonical.fingerprint.clone(),
            backup_leaf_name: expected_backup_leaf_name.clone(),
            backup_sha256_hex: expected_backup_sha256_hex.clone(),
            ownership_baseline_sha256_hex: evidence.baseline.baseline_sha256_hex.clone(),
            ownership_owners_sha256_hex: evidence.baseline.owners_sha256_hex.clone(),
            created: std::time::Instant::now(),
            consumed: false,
        });
        Ok(V2LeaseResult {
            schema: V2_SCHEMA,
            ok: true,
            verdict: "authorized",
            error_code: None,
            active: true,
            operation: Some(V2_OPERATION),
            reconciliation_request_id: Some(reconciliation_request_id.clone()),
            nonce: Some(nonce.clone()),
            ttl_seconds: V2_LEASE_TTL.as_secs(),
            sqlite_writes: 0,
        })
    })
    .unwrap_or_else(V2LeaseResult::blocked))
}

/*
 * Completion is the LAST gate before the platform layer removes the record. It
 * re-reads the live orphan bytes and re-proves every CAS-bound value, so a
 * record that changed between authorization and here is refused rather than
 * removed. The nonce is one-use: it is consumed here whether or not the rest
 * succeeds, so a captured nonce cannot be replayed.
 */
#[allow(clippy::too_many_arguments)]
/* One-use claim of a REMOVAL authorization, symmetric with the rollback claim
 * so both one-use paths refuse identically. */
fn claim_removal_lease(
    reconciliation_request_id: &str,
    lease_nonce: &str,
) -> Result<V2Lease, V2Failure> {
    with_lease(|slot| {
        let Some(lease) = slot.as_mut() else {
            return Err(V2Failure::LeaseMissing);
        };
        if lease.expired() {
            *slot = None;
            return Err(V2Failure::LeaseExpired);
        }
        if lease.consumed {
            return Err(V2Failure::LeaseAlreadyConsumed);
        }
        if lease.operation != V2_OPERATION {
            return Err(V2Failure::LeaseOperationMismatch);
        }
        if lease.request_id != reconciliation_request_id {
            return Err(V2Failure::LeaseBindingMismatch);
        }
        if !nonce_matches(&lease.nonce, lease_nonce) {
            return Err(V2Failure::LeaseNonceMismatch);
        }
        lease.consumed = true;
        Ok(lease.clone())
    })
}

/* The exact-target CAS: every identifying field of the live record must equal
 * the one the authorization froze. */
fn target_matches(lease: &V2Lease, observed: &ValidIdentityV2) -> bool {
    observed.raw_sha256_hex == lease.local_storage_raw_sha256_hex
        && observed.fingerprint == lease.local_storage_fingerprint_sha256_hex
        && observed.sync_peer_id == lease.orphan_sync_peer_id
        && observed.install_id == lease.orphan_install_id
}

#[tauri::command]
pub async fn h2o_p02_identity_orphan_reconciliation_v2_complete_remove(
    db_instances: State<'_, DbInstances>,
    reconciliation_request_id: String,
    lease_nonce: String,
    observed_local_storage_raw: String,
) -> Result<V2CompleteResult, String> {
    let lease = match claim_removal_lease(&reconciliation_request_id, &lease_nonce) {
        Ok(lease) => lease,
        Err(failure) => return Ok(V2CompleteResult::blocked(failure)),
    };
    /* Exact-target CAS on the live record the caller just read. */
    let Some(observed) = validate_identity_v2(&observed_local_storage_raw) else {
        return Ok(V2CompleteResult::blocked(V2Failure::TargetDrift));
    };
    if !target_matches(&lease, &observed) {
        return Ok(V2CompleteResult::blocked(V2Failure::TargetDrift));
    }
    let Some(pool) = sqlite_pool(&db_instances).await else {
        return Ok(V2CompleteResult::blocked(V2Failure::DatabaseUnavailable));
    };
    let Ok(mut conn) = pool.acquire().await else {
        return Ok(V2CompleteResult::blocked(V2Failure::DatabaseUnavailable));
    };
    let evidence = match gather_evidence(&mut conn, &observed, None).await {
        Ok(evidence) => evidence,
        Err(failure) => return Ok(V2CompleteResult::blocked(failure)),
    };
    if evidence.canonical.raw_sha256_hex != lease.canonical_raw_sha256_hex
        || evidence.canonical.fingerprint != lease.canonical_fingerprint_sha256_hex
    {
        return Ok(V2CompleteResult::blocked(V2Failure::CanonicalRowMismatch));
    }
    /* No new owner, no changed owner, no lost owner. */
    if evidence.baseline.baseline_sha256_hex != lease.ownership_baseline_sha256_hex {
        return Ok(V2CompleteResult::blocked(V2Failure::OwnershipBaselineChanged));
    }
    if evidence.baseline.owners_sha256_hex != lease.ownership_owners_sha256_hex {
        return Ok(V2CompleteResult::blocked(V2Failure::OwnershipNewOwner));
    }
    Ok(V2CompleteResult {
        schema: V2_SCHEMA,
        ok: true,
        verdict: "removal-authorized",
        error_code: None,
        removed_sync_peer_id: Some(lease.orphan_sync_peer_id.clone()),
        ownership_baseline_preserved: true,
        ownership_baseline_sha256_hex: Some(evidence.baseline.baseline_sha256_hex.clone()),
        canonical_sync_peer_id: Some(evidence.canonical.sync_peer_id.clone()),
        sqlite_writes: 0,
        remint: false,
    })
}

#[tauri::command]
pub async fn h2o_p02_identity_orphan_reconciliation_v2_cancel_remove(
) -> Result<V2LeaseResult, String> {
    Ok(with_lease(|slot| {
        *slot = None;
        Ok(V2LeaseResult {
            schema: V2_SCHEMA,
            ok: true,
            verdict: "lease-cancelled",
            error_code: None,
            active: false,
            operation: None,
            reconciliation_request_id: None,
            nonce: None,
            ttl_seconds: V2_LEASE_TTL.as_secs(),
            sqlite_writes: 0,
        })
    })
    .unwrap_or_else(V2LeaseResult::blocked))
}

/* ─── rollback: restore the protected backup ────────────────────────────── */

/*
 * Rollback binds exactly what removal bound - the protected backup, the
 * restoration target, the canonical row and the complete ownership baseline -
 * and re-proves all of it against the live database at the moment the lease is
 * consumed. Authorization alone is never sufficient: the world can move between
 * authorize and read, and a rollback that restored into a moved world would
 * reintroduce a divergent identity the operator never inspected.
 */
struct RollbackMaterial {
    orphan: ValidIdentityV2,
    canonical_raw_sha256_hex: String,
    canonical_fingerprint_sha256_hex: String,
    ownership_baseline_sha256_hex: String,
    ownership_owners_sha256_hex: String,
}

#[allow(clippy::too_many_arguments)]
async fn rollback_material(
    app: &tauri::AppHandle,
    db_instances: &DbInstances,
    backup_leaf: &str,
    backup_sha256_hex: &str,
    local_storage_raw_sha256_hex: &str,
    local_storage_fingerprint_sha256_hex: &str,
    canonical_raw_sha256_hex: &str,
    canonical_fingerprint_sha256_hex: &str,
    ownership_baseline_sha256_hex: &str,
) -> Result<RollbackMaterial, V2Failure> {
    let root = backup_root(app).map_err(|_| V2Failure::BackupWriteFailed)?;
    /* The leaf is content-addressed by the target digest, so a caller can never
     * name a different file - or traverse out of the governed directory. */
    if backup_leaf != backup_leaf_name(local_storage_raw_sha256_hex) {
        return Err(V2Failure::BackupConflict);
    }
    let existing =
        std::fs::read_to_string(root.join(backup_leaf)).map_err(|_| V2Failure::BackupMissing)?;
    let pool = sqlite_pool(db_instances)
        .await
        .ok_or(V2Failure::DatabaseUnavailable)?;
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| V2Failure::DatabaseUnavailable)?;
    rollback_material_from_document(
        &mut conn,
        &existing,
        backup_leaf,
        backup_sha256_hex,
        local_storage_raw_sha256_hex,
        local_storage_fingerprint_sha256_hex,
        canonical_raw_sha256_hex,
        canonical_fingerprint_sha256_hex,
        ownership_baseline_sha256_hex,
    )
    .await
}

/* The decision core, free of filesystem and app state so every refusal in the
 * taxonomy is directly exercisable. */
#[allow(clippy::too_many_arguments)]
async fn rollback_material_from_document(
    conn: &mut SqliteConnection,
    existing: &str,
    backup_leaf: &str,
    backup_sha256_hex: &str,
    local_storage_raw_sha256_hex: &str,
    local_storage_fingerprint_sha256_hex: &str,
    canonical_raw_sha256_hex: &str,
    canonical_fingerprint_sha256_hex: &str,
    ownership_baseline_sha256_hex: &str,
) -> Result<RollbackMaterial, V2Failure> {
    if backup_leaf != backup_leaf_name(local_storage_raw_sha256_hex) {
        return Err(V2Failure::BackupConflict);
    }
    if sha256_hex(existing) != backup_sha256_hex {
        return Err(V2Failure::BackupConflict);
    }
    let document: JsonValue =
        serde_json::from_str(&existing).map_err(|_| V2Failure::BackupReadFailed)?;
    let object = document.as_object().ok_or(V2Failure::BackupReadFailed)?;
    if object.get("schema").and_then(JsonValue::as_str) != Some(V2_BACKUP_SCHEMA)
        || object.get("operation").and_then(JsonValue::as_str) != Some(V2_OPERATION)
    {
        return Err(V2Failure::BackupReadFailed);
    }
    let raw = object
        .get("localStorageRaw")
        .and_then(JsonValue::as_str)
        .ok_or(V2Failure::BackupReadFailed)?;
    let orphan = validate_identity_v2(raw).ok_or(V2Failure::BackupReadFailed)?;
    if orphan.raw_sha256_hex != local_storage_raw_sha256_hex
        || orphan.fingerprint != local_storage_fingerprint_sha256_hex
    {
        return Err(V2Failure::TargetDrift);
    }
    if object
        .get("canonicalSqliteRawSha256Hex")
        .and_then(JsonValue::as_str)
        != Some(canonical_raw_sha256_hex)
        || object
            .get("canonicalSqliteFingerprintSha256Hex")
            .and_then(JsonValue::as_str)
            != Some(canonical_fingerprint_sha256_hex)
    {
        return Err(V2Failure::BackupConflict);
    }
    /* Read-only: gather_evidence always rolls its transaction back. */
    let evidence = gather_evidence(conn, &orphan, None).await?;
    if evidence.canonical.raw_sha256_hex != canonical_raw_sha256_hex {
        return Err(V2Failure::CanonicalRowMismatch);
    }
    if evidence.canonical.fingerprint != canonical_fingerprint_sha256_hex {
        return Err(V2Failure::CanonicalFingerprintMismatch);
    }
    if evidence.baseline.baseline_sha256_hex != ownership_baseline_sha256_hex {
        return Err(V2Failure::OwnershipBaselineChanged);
    }
    Ok(RollbackMaterial {
        orphan,
        canonical_raw_sha256_hex: evidence.canonical.raw_sha256_hex.clone(),
        canonical_fingerprint_sha256_hex: evidence.canonical.fingerprint.clone(),
        ownership_baseline_sha256_hex: evidence.baseline.baseline_sha256_hex.clone(),
        ownership_owners_sha256_hex: evidence.baseline.owners_sha256_hex.clone(),
    })
}

/* The rollback authorization binds every value the removal bound: the exact
 * backup, the exact restoration target, the canonical row, and the complete
 * ownership baseline - plus a one-use nonce. */
fn rollback_lease_from(
    reconciliation_request_id: &str,
    nonce: &str,
    material: &RollbackMaterial,
    backup_leaf_name: &str,
    backup_sha256_hex: &str,
) -> V2Lease {
    V2Lease {
        operation: V2_ROLLBACK_OPERATION,
        request_id: reconciliation_request_id.to_string(),
        nonce: nonce.to_string(),
        local_storage_raw_sha256_hex: material.orphan.raw_sha256_hex.clone(),
        local_storage_fingerprint_sha256_hex: material.orphan.fingerprint.clone(),
        orphan_sync_peer_id: material.orphan.sync_peer_id.clone(),
        orphan_install_id: material.orphan.install_id.clone(),
        canonical_raw_sha256_hex: material.canonical_raw_sha256_hex.clone(),
        canonical_fingerprint_sha256_hex: material.canonical_fingerprint_sha256_hex.clone(),
        backup_leaf_name: backup_leaf_name.to_string(),
        backup_sha256_hex: backup_sha256_hex.to_string(),
        ownership_baseline_sha256_hex: material.ownership_baseline_sha256_hex.clone(),
        ownership_owners_sha256_hex: material.ownership_owners_sha256_hex.clone(),
        created: std::time::Instant::now(),
        consumed: false,
    }
}

fn rollback_blocked(failure: V2Failure, lease_consumed: bool) -> JsonValue {
    json!({
        "schema": V2_SCHEMA,
        "ok": false,
        "verdict": "blocked",
        "errorCode": failure.code(),
        "leaseConsumed": lease_consumed,
        "sqliteWrites": 0
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn h2o_p02_identity_orphan_reconciliation_v2_authorize_rollback(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    reconciliation_request_id: String,
    expected_backup_leaf_name: String,
    expected_backup_sha256_hex: String,
    expected_local_storage_raw_sha256_hex: String,
    expected_local_storage_fingerprint_sha256_hex: String,
    expected_canonical_raw_sha256_hex: String,
    expected_canonical_fingerprint_sha256_hex: String,
    expected_ownership_baseline_sha256_hex: String,
) -> Result<V2LeaseResult, String> {
    let material = match rollback_material(
        &app,
        &db_instances,
        &expected_backup_leaf_name,
        &expected_backup_sha256_hex,
        &expected_local_storage_raw_sha256_hex,
        &expected_local_storage_fingerprint_sha256_hex,
        &expected_canonical_raw_sha256_hex,
        &expected_canonical_fingerprint_sha256_hex,
        &expected_ownership_baseline_sha256_hex,
    )
    .await
    {
        Ok(material) => material,
        Err(failure) => return Ok(V2LeaseResult::blocked(failure)),
    };
    let nonce = match random_hex(32) {
        Ok(value) => value,
        Err(failure) => return Ok(V2LeaseResult::blocked(failure)),
    };
    Ok(with_lease(|slot| {
        if let Some(lease) = slot.as_ref() {
            if !lease.expired() && !lease.consumed {
                return Err(V2Failure::LeaseAlreadyActive);
            }
        }
        *slot = Some(rollback_lease_from(
            &reconciliation_request_id,
            &nonce,
            &material,
            &expected_backup_leaf_name,
            &expected_backup_sha256_hex,
        ));
        Ok(V2LeaseResult {
            schema: V2_SCHEMA,
            ok: true,
            verdict: "rollback-authorized",
            error_code: None,
            active: true,
            operation: Some(V2_ROLLBACK_OPERATION),
            reconciliation_request_id: Some(reconciliation_request_id.clone()),
            nonce: Some(nonce.clone()),
            ttl_seconds: V2_LEASE_TTL.as_secs(),
            sqlite_writes: 0,
        })
    })
    .unwrap_or_else(V2LeaseResult::blocked))
}

/* One-use claim of a rollback authorization. Consumed before any fallible
 * work, so a failed re-proof never leaves a replayable authorization behind. */
fn claim_rollback_lease(
    reconciliation_request_id: &str,
    lease_nonce: &str,
    expected_backup_sha256_hex: &str,
    expected_local_storage_raw_sha256_hex: &str,
) -> Result<V2Lease, V2Failure> {
    with_lease(|slot| {
        let Some(lease) = slot.as_mut() else {
            return Err(V2Failure::LeaseMissing);
        };
        if lease.expired() {
            *slot = None;
            return Err(V2Failure::LeaseExpired);
        }
        if lease.consumed {
            return Err(V2Failure::LeaseAlreadyConsumed);
        }
        if lease.operation != V2_ROLLBACK_OPERATION {
            return Err(V2Failure::LeaseOperationMismatch);
        }
        if lease.request_id != reconciliation_request_id {
            return Err(V2Failure::LeaseBindingMismatch);
        }
        if lease.backup_sha256_hex != expected_backup_sha256_hex
            || lease.local_storage_raw_sha256_hex != expected_local_storage_raw_sha256_hex
        {
            return Err(V2Failure::LeaseBindingMismatch);
        }
        if !nonce_matches(&lease.nonce, lease_nonce) {
            return Err(V2Failure::LeaseNonceMismatch);
        }
        lease.consumed = true;
        Ok(lease.clone())
    })
}

#[tauri::command]
pub async fn h2o_p02_identity_orphan_reconciliation_v2_read_backup_with_nonce(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    reconciliation_request_id: String,
    lease_nonce: String,
    expected_backup_sha256_hex: String,
    expected_local_storage_raw_sha256_hex: String,
) -> Result<JsonValue, String> {
    let claimed = claim_rollback_lease(
        &reconciliation_request_id,
        &lease_nonce,
        &expected_backup_sha256_hex,
        &expected_local_storage_raw_sha256_hex,
    );
    let lease = match claimed {
        Ok(lease) => lease,
        Err(failure) => return Ok(rollback_blocked(failure, false)),
    };
    let material = match rollback_material(
        &app,
        &db_instances,
        &lease.backup_leaf_name,
        &lease.backup_sha256_hex,
        &lease.local_storage_raw_sha256_hex,
        &lease.local_storage_fingerprint_sha256_hex,
        &lease.canonical_raw_sha256_hex,
        &lease.canonical_fingerprint_sha256_hex,
        &lease.ownership_baseline_sha256_hex,
    )
    .await
    {
        Ok(material) => material,
        Err(failure) => return Ok(rollback_blocked(failure, true)),
    };
    if material.ownership_owners_sha256_hex != lease.ownership_owners_sha256_hex {
        return Ok(rollback_blocked(V2Failure::OwnershipNewOwner, true));
    }
    Ok(json!({
        "schema": V2_SCHEMA,
        "ok": true,
        "verdict": "rollback-material",
        "leaseConsumed": true,
        "backupLeafName": lease.backup_leaf_name,
        "backupSha256Hex": lease.backup_sha256_hex,
        "localStorageIdentityRaw": material.orphan.raw,
        "localStorageRawSha256Hex": material.orphan.raw_sha256_hex,
        "localStorageFingerprintSha256Hex": material.orphan.fingerprint,
        "orphanSyncPeerId": material.orphan.sync_peer_id,
        "canonicalRawSha256Hex": material.canonical_raw_sha256_hex,
        "canonicalFingerprintSha256Hex": material.canonical_fingerprint_sha256_hex,
        "ownershipBaselineSha256Hex": material.ownership_baseline_sha256_hex,
        "sqliteWrites": 0
    }))
}

#[tauri::command]
pub async fn h2o_p02_identity_orphan_reconciliation_v2_cancel_rollback(
) -> Result<V2LeaseResult, String> {
    h2o_p02_identity_orphan_reconciliation_v2_cancel_remove().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    /* The established Desktop idiom for async tests in this crate. */
    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    const CANONICAL: &str = "studio-desktop:tauri-desktop:sqlite:7d38016a-55c1-48b8-81de-162bf4586b9e";
    const ORPHAN: &str = "studio-desktop:tauri-desktop:sqlite:1f6a6a4a-7948-4ace-b02a-68563d1777ce";
    /* Historical Desktop-class and test residue, exactly the shapes production
     * carries. None of these is canonical or the candidate orphan. */
    const RESIDUE: &[&str] = &[
        "studio-desktop:tauri-desktop:sqlite:35bf956b-8b8d-45e6-904c-5b8c92df57f0",
        "studio-desktop:tauri-desktop:sqlite:bfb200a2-20ee-4041-99f6-922cf683787d",
        "chrome-studio",
        "fake-peer-for-f5f-validation",
        "desktop-smoke-phase-b6",
    ];

    fn identity_json(sync_peer_id: &str, install_id: &str) -> String {
        format!(
            "{{\"schema\":\"{IDENTITY_SCHEMA}\",\"installId\":\"{install_id}\",\
             \"physicalDeviceId\":\"9c2f1b64-2d55-4a71-bd0e-1f4c8a7e6b32\",\
             \"syncPeerId\":\"{sync_peer_id}\",\"surfaceKind\":\"studio-desktop\",\
             \"appKind\":\"tauri-desktop\",\"storeKind\":\"sqlite\",\
             \"displayName\":\"studio-desktop (sqlite)\",\
             \"createdAt\":\"2026-08-01T00:00:00.000Z\",\
             \"updatedAt\":\"2026-08-01T00:00:00.000Z\",\"surfaceHistory\":[]}}"
        )
    }
    fn canonical_json() -> String {
        identity_json(CANONICAL, "7d38016a-55c1-48b8-81de-162bf4586b9e")
    }
    fn orphan_json() -> String {
        identity_json(ORPHAN, "1f6a6a4a-7948-4ace-b02a-68563d1777ce")
    }

    /* A database with production's peer-scoped shape: canonical ownership well
     * above v1's frozen 26, canonical sync_object_state rows, and opaque
     * residue that v2 must preserve without trusting. */
    async fn seeded(extra_column: Option<(&str, &str)>) -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&mut conn).await.unwrap();
        for (table, columns) in [
            ("sync_conflicts", "id INTEGER PRIMARY KEY, decided_by_sync_peer_id TEXT, local_peer_id TEXT, remote_peer_id TEXT"),
            ("sync_inbound_revision_observations", "id INTEGER PRIMARY KEY, writer_sync_peer_id_sha256_hex TEXT"),
            ("sync_maintenance_log", "id INTEGER PRIMARY KEY, requested_by_sync_peer_id TEXT"),
            ("sync_object_state", "id INTEGER PRIMARY KEY, sync_peer_id TEXT"),
            ("sync_peer_watermarks", "id INTEGER PRIMARY KEY, observing_peer_id TEXT, source_peer_id TEXT"),
            ("sync_tombstone_reviews", "id INTEGER PRIMARY KEY, decided_by_sync_peer_id TEXT, remote_sync_peer_id TEXT"),
            ("sync_tombstones", "id INTEGER PRIMARY KEY, deleted_by_sync_peer_id TEXT, restored_by_sync_peer_id TEXT"),
        ] {
            sqlx::query(&format!("CREATE TABLE {table} ({columns})"))
                .execute(&mut conn).await.unwrap();
        }
        if let Some((table, column)) = extra_column {
            sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"))
                .execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO kv_store (key, value) VALUES (?, ?)")
            .bind(IDENTITY_KEY).bind(canonical_json())
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO kv_store (key, value) VALUES (?, ?)")
            .bind(SYNC_CONFIG_KEY)
            .bind("{\"schemaVersion\":1,\"mode\":\"manual\",\"configuredPeers\":[]}")
            .execute(&mut conn).await.unwrap();
        /* Canonical: 3 object-state rows + 20 review decisions + 4 tombstones
         * + 1 conflict + 1 restore = 29, deliberately not v1's frozen 26. */
        for _ in 0..3 {
            sqlx::query("INSERT INTO sync_object_state (sync_peer_id) VALUES (?)")
                .bind(CANONICAL).execute(&mut conn).await.unwrap();
        }
        for _ in 0..20 {
            sqlx::query("INSERT INTO sync_tombstone_reviews (decided_by_sync_peer_id) VALUES (?)")
                .bind(CANONICAL).execute(&mut conn).await.unwrap();
        }
        for _ in 0..4 {
            sqlx::query("INSERT INTO sync_tombstones (deleted_by_sync_peer_id) VALUES (?)")
                .bind(CANONICAL).execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO sync_conflicts (decided_by_sync_peer_id) VALUES (?)")
            .bind(CANONICAL).execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO sync_tombstones (restored_by_sync_peer_id) VALUES (?)")
            .bind(CANONICAL).execute(&mut conn).await.unwrap();
        /* Opaque residue across several surfaces, plaintext and hashed. */
        for peer in RESIDUE {
            sqlx::query("INSERT INTO sync_tombstone_reviews (remote_sync_peer_id) VALUES (?)")
                .bind(*peer).execute(&mut conn).await.unwrap();
            sqlx::query("INSERT INTO sync_tombstones (deleted_by_sync_peer_id) VALUES (?)")
                .bind(*peer).execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO sync_inbound_revision_observations (writer_sync_peer_id_sha256_hex) VALUES (?)")
            .bind(sha256_hex("some-remote-writer")).execute(&mut conn).await.unwrap();
        conn
    }

    async fn evidence_for(conn: &mut SqliteConnection, orphan_raw: &str)
        -> Result<PrepareEvidence, V2Failure> {
        let orphan = validate_identity_v2(orphan_raw).expect("orphan parses");
        gather_evidence(conn, &orphan, None).await
    }

    /* A: orphan owns nothing while opaque residue exists -> allowed. */
    #[test]
    fn orphan_zero_with_opaque_residue_is_allowed() {
        block_on(async {
        let mut conn = seeded(None).await;
        let evidence = evidence_for(&mut conn, &orphan_json()).await.expect("prepared");
        assert_eq!(evidence.orphan_owned, 0, "orphan owns nothing");
        assert_eq!(evidence.canonical_owned, 29, "canonical owns N, not v1's 26");
        assert!(evidence.residue_rows > 0, "opaque residue is present and counted");
        assert_eq!(evidence.canonical.sync_peer_id, CANONICAL);
        });
    }

    /* B: orphan owns a plaintext peer-scoped row -> block. */
    #[test]
    fn orphan_plaintext_ownership_blocks() {
        block_on(async {
        let mut conn = seeded(None).await;
        sqlx::query("INSERT INTO sync_object_state (sync_peer_id) VALUES (?)")
            .bind(ORPHAN).execute(&mut conn).await.unwrap();
        assert_eq!(
            evidence_for(&mut conn, &orphan_json()).await.err(),
            Some(V2Failure::CandidateOwnsRows)
        );
        });
    }

    /* C: orphan owns a HASHED peer-scoped row -> block. This is the column v1
     * does not understand at all. */
    #[test]
    fn orphan_hashed_ownership_blocks() {
        block_on(async {
        let mut conn = seeded(None).await;
        sqlx::query(
            "INSERT INTO sync_inbound_revision_observations (writer_sync_peer_id_sha256_hex) VALUES (?)",
        )
        .bind(sha256_hex(ORPHAN)).execute(&mut conn).await.unwrap();
        assert_eq!(
            evidence_for(&mut conn, &orphan_json()).await.err(),
            Some(V2Failure::CandidateOwnsRows)
        );
        });
    }

    /* E: an unknown peer-scoped column appears -> block before anything else. */
    #[test]
    fn unknown_peer_scoped_column_blocks() {
        block_on(async {
        let mut conn = seeded(Some(("sync_object_state", "future_owner_sync_peer_id"))).await;
        assert_eq!(
            evidence_for(&mut conn, &orphan_json()).await.err(),
            Some(V2Failure::SchemaUnknownPeerColumn)
        );
        });
    }

    /* F: canonical owns nothing -> direction is not provable, and v2 must never
     * mint a replacement. */
    #[test]
    fn canonical_without_ownership_is_ambiguous() {
        block_on(async {
        let mut conn = seeded(None).await;
        for table in ["sync_object_state", "sync_tombstone_reviews", "sync_tombstones", "sync_conflicts"] {
            sqlx::query(&format!("DELETE FROM {table}")).execute(&mut conn).await.unwrap();
        }
        assert_eq!(
            evidence_for(&mut conn, &orphan_json()).await.err(),
            Some(V2Failure::SqliteIdentityAmbiguous)
        );
        });
    }

    /* Candidate identical to canonical is not an orphan. */
    #[test]
    fn non_divergent_candidate_blocks() {
        block_on(async {
        let mut conn = seeded(None).await;
        assert_eq!(
            evidence_for(&mut conn, &canonical_json()).await.err(),
            Some(V2Failure::CandidateNotDivergent)
        );
        });
    }

    /* G/H/I: the baseline is deterministic, covers residue, and any change to a
     * residue row - or a brand-new owner - alters it. */
    #[test]
    fn ownership_baseline_is_deterministic_and_covers_residue() {
        block_on(async {
        let mut conn = seeded(None).await;
        let first = evidence_for(&mut conn, &orphan_json()).await.unwrap().baseline;
        let second = evidence_for(&mut conn, &orphan_json()).await.unwrap().baseline;
        assert_eq!(first, second, "baseline is stable across reads");
        assert_eq!(first.surfaces.len(), V2_PEER_SCOPED_COLUMNS.len());
        assert!(first.distinct_owner_count >= RESIDUE.len() + 1, "residue counted");

        /* H: a residue row changes -> baseline changes. */
        let mut changed = seeded(None).await;
        sqlx::query("UPDATE sync_tombstones SET deleted_by_sync_peer_id = ? WHERE deleted_by_sync_peer_id = ?")
            .bind("chrome-studio-RENAMED").bind("chrome-studio")
            .execute(&mut changed).await.unwrap();
        let mutated = evidence_for(&mut changed, &orphan_json()).await.unwrap().baseline;
        assert_ne!(first.baseline_sha256_hex, mutated.baseline_sha256_hex,
            "changing opaque residue is detected");
        assert_ne!(first.owners_sha256_hex, mutated.owners_sha256_hex);

        /* I: a brand-new owner appears -> owners digest changes. */
        let mut added = seeded(None).await;
        sqlx::query("INSERT INTO sync_object_state (sync_peer_id) VALUES (?)")
            .bind("brand-new-unknown-owner").execute(&mut added).await.unwrap();
        let grown = evidence_for(&mut added, &orphan_json()).await.unwrap().baseline;
        assert_ne!(first.owners_sha256_hex, grown.owners_sha256_hex,
            "a new owner is never silently tolerated");
        });
    }

    /* J: the canonical subset is inside the baseline, so canonical change is
     * detected too. */
    #[test]
    fn canonical_ownership_change_is_detected() {
        block_on(async {
        let mut conn = seeded(None).await;
        let before = evidence_for(&mut conn, &orphan_json()).await.unwrap();
        sqlx::query("DELETE FROM sync_object_state WHERE sync_peer_id = ?")
            .bind(CANONICAL).execute(&mut conn).await.unwrap();
        let after = evidence_for(&mut conn, &orphan_json()).await.unwrap();
        assert_ne!(before.baseline.baseline_sha256_hex, after.baseline.baseline_sha256_hex);
        assert_eq!(before.canonical_owned, 29);
        assert_eq!(after.canonical_owned, 26);
        });
    }

    /* L: canonical identity changing invalidates the bound canonical hashes. */
    #[test]
    fn canonical_identity_change_is_visible() {
        block_on(async {
        let mut conn = seeded(None).await;
        let before = evidence_for(&mut conn, &orphan_json()).await.unwrap();
        sqlx::query("UPDATE kv_store SET value = ? WHERE key = ?")
            .bind(identity_json(CANONICAL, "7d38016a-55c1-48b8-81de-162bf4586b9e")
                .replace("studio-desktop (sqlite)", "renamed"))
            .bind(IDENTITY_KEY).execute(&mut conn).await.unwrap();
        let after = evidence_for(&mut conn, &orphan_json()).await.unwrap();
        assert_ne!(before.canonical.raw_sha256_hex, after.canonical.raw_sha256_hex);
        });
    }

    /* U: evidence gathering performs zero writes - the transaction is always
     * rolled back, proven by a row inserted and then not observed. */
    #[test]
    fn evidence_gathering_writes_nothing() {
        block_on(async {
        let mut conn = seeded(None).await;
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_object_state")
            .fetch_one(&mut conn).await.unwrap();
        let _ = evidence_for(&mut conn, &orphan_json()).await.unwrap();
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_object_state")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(before, after, "no rows added or removed");
        let identity: String =
            sqlx::query_scalar("SELECT value FROM kv_store WHERE key = ?")
                .bind(IDENTITY_KEY).fetch_one(&mut conn).await.unwrap();
        assert_eq!(identity, canonical_json(), "canonical identity byte-identical");
        let config: String = sqlx::query_scalar("SELECT value FROM kv_store WHERE key = ?")
            .bind(SYNC_CONFIG_KEY).fetch_one(&mut conn).await.unwrap();
        assert!(config.contains("\"configuredPeers\":[]"), "Sync config untouched");
        });
    }

    /* M/N/O/P: append-only content-addressed backup. */
    #[test]
    fn backup_is_content_addressed_and_append_only() {
        let root = std::env::temp_dir().join(format!("p02-v2-backup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let orphan = validate_identity_v2(&orphan_json()).unwrap();
        let canonical = validate_identity_v2(&canonical_json()).unwrap();

        /* M: a v1 singleton in the same root is neither read nor overwritten. */
        std::fs::create_dir_all(&root).unwrap();
        let v1 = root.join("localstorage-identity-backup.v1.json");
        std::fs::write(&v1, "{\"schema\":\"h2o.round2.item11.identity-orphan-backup.v1\"}").unwrap();

        let (leaf, sha) = write_backup(&root, &orphan, &canonical, "2026-09-07T00:00:00.000Z", "req-1").unwrap();
        assert_eq!(leaf, backup_leaf_name(&orphan.raw_sha256_hex));
        assert!(leaf.contains(&orphan.raw_sha256_hex), "leaf is keyed by exact orphan bytes");
        assert_eq!(
            std::fs::read_to_string(&v1).unwrap(),
            "{\"schema\":\"h2o.round2.item11.identity-orphan-backup.v1\"}",
            "v1 singleton untouched"
        );

        /* O: the same orphan reuses the byte-identical leaf idempotently. */
        let (leaf_again, sha_again) =
            write_backup(&root, &orphan, &canonical, "2026-09-07T01:00:00.000Z", "req-2").unwrap();
        assert_eq!((leaf.clone(), sha.clone()), (leaf_again, sha_again),
            "identical orphan reuses the existing leaf without rewriting it");

        /* N/P: a different orphan generation gets its own leaf; both survive. */
        let other_raw = identity_json(
            "studio-desktop:tauri-desktop:sqlite:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        );
        let other = validate_identity_v2(&other_raw).unwrap();
        let (other_leaf, _) =
            write_backup(&root, &other, &canonical, "2026-09-07T02:00:00.000Z", "req-3").unwrap();
        assert_ne!(leaf, other_leaf, "different generation, different leaf");
        assert!(root.join(&leaf).is_file() && root.join(&other_leaf).is_file(),
            "append-only: every generation preserved");

        /* A corrupted leaf for these bytes is a conflict, never an overwrite. */
        std::fs::write(root.join(&leaf), "{\"schema\":\"wrong\"}").unwrap();
        assert_eq!(
            write_backup(&root, &orphan, &canonical, "2026-09-07T03:00:00.000Z", "req-4").err(),
            Some(V2Failure::BackupConflict)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /* The lease nonce is random, hex, and compared without early exit. */
    #[test]
    fn lease_nonce_is_random_and_compared_exactly() {
        let a = random_hex(32).unwrap();
        let b = random_hex(32).unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(a.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(nonce_matches(&a, &a));
        assert!(!nonce_matches(&a, &b));
        assert!(!nonce_matches(&a, &a[..a.len() - 1]));
    }

    /* Identity validation rejects anything that is not an exact peer identity. */
    #[test]
    fn identity_validation_is_exact() {
        assert!(validate_identity_v2(&orphan_json()).is_some());
        assert!(validate_identity_v2("{}").is_none());
        assert!(validate_identity_v2(&orphan_json().replace(IDENTITY_SCHEMA, "other")).is_none());
        /* syncPeerId must be derived from the surface triple + installId. */
        assert!(validate_identity_v2(&orphan_json().replace(ORPHAN, "mismatched:peer:id:x")).is_none());
        /* an extra key is a different shape, not a superset */
        assert!(validate_identity_v2(&orphan_json().replace("\"surfaceHistory\":[]", "\"surfaceHistory\":[],\"extra\":1")).is_none());
    }

    /* D: an orphan that holds a repository writer directory is not an orphan;
     * removing its identity would strand durable P02 authority. */
    #[test]
    fn orphan_repository_writer_blocks() {
        let root = std::env::temp_dir()
            .join(format!("p02-v2-writers-{}-{}", std::process::id(), 1));
        let _ = std::fs::remove_dir_all(&root);
        let canonical_key = crate::sync_contract_v2::writer_key_hex_v2(CANONICAL);
        let orphan_key = crate::sync_contract_v2::writer_key_hex_v2(ORPHAN);
        std::fs::create_dir_all(root.join("writers").join(&canonical_key)).unwrap();

        /* canonical writer present, orphan absent -> permitted */
        let (canonical_present, orphan_present) =
            writer_ownership(Some(root.as_path()), CANONICAL, ORPHAN);
        assert!(canonical_present && !orphan_present);

        /* orphan writer appears -> the ceremony must refuse */
        std::fs::create_dir_all(root.join("writers").join(&orphan_key)).unwrap();
        let (_, orphan_now) = writer_ownership(Some(root.as_path()), CANONICAL, ORPHAN);
        assert!(orphan_now, "orphan writer directory is detected");

        block_on(async {
            let mut conn = seeded(None).await;
            let orphan = validate_identity_v2(&orphan_json()).unwrap();
            assert_eq!(
                gather_evidence(&mut conn, &orphan, Some(root.as_path())).await.err(),
                Some(V2Failure::CandidateWriterPresent)
            );
        });

        /* canonical writer missing from a real repository -> also refuses */
        let bare = std::env::temp_dir()
            .join(format!("p02-v2-writers-{}-{}", std::process::id(), 2));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(bare.join("writers")).unwrap();
        block_on(async {
            let mut conn = seeded(None).await;
            let orphan = validate_identity_v2(&orphan_json()).unwrap();
            assert_eq!(
                gather_evidence(&mut conn, &orphan, Some(bare.as_path())).await.err(),
                Some(V2Failure::CanonicalWriterMissing)
            );
        });
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&bare);
    }

    /* The writer key is the canonical product derivation and cannot traverse. */
    #[test]
    fn writer_key_is_the_canonical_derivation() {
        let key = crate::sync_contract_v2::writer_key_hex_v2(CANONICAL);
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(key, crate::sync_contract_v2::writer_key_hex_v2(ORPHAN));
    }

    /* The allowlist matches the governed taxonomy and includes the hashed
     * column v1 lacks. */
    #[test]
    fn allowlist_covers_the_governed_taxonomy() {
        assert_eq!(V2_PEER_SCOPED_COLUMNS.len(), 12);
        assert!(V2_PEER_SCOPED_COLUMNS.iter().any(|(table, column, hashed)| {
            *table == "sync_inbound_revision_observations"
                && *column == "writer_sync_peer_id_sha256_hex"
                && *hashed
        }), "the hashed inbound-observation column v1 misses is understood");
        for (_, column, _) in V2_PEER_SCOPED_COLUMNS {
            assert!(is_peer_scoped_name(column), "{column} matches the taxonomy");
        }
    }

    /* ─── rollback path ─────────────────────────────────────────────────── */

    /* The rollback lease is process-global; these assertions must not race. */
    static LEASE_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct RollbackFixture {
        document: String,
        document_sha: String,
        leaf: String,
        orphan: ValidIdentityV2,
        canonical: ValidIdentityV2,
        baseline: String,
        owners: String,
    }

    async fn rollback_fixture(conn: &mut SqliteConnection) -> RollbackFixture {
        let orphan = validate_identity_v2(&orphan_json()).expect("orphan parses");
        let canonical = validate_identity_v2(&canonical_json()).expect("canonical parses");
        let evidence = gather_evidence(conn, &orphan, None).await.expect("evidence");
        let document = backup_document("2026-09-07T00:00:00.000Z", "req-1", &orphan, &canonical);
        RollbackFixture {
            document_sha: sha256_hex(&document),
            leaf: backup_leaf_name(&orphan.raw_sha256_hex),
            document,
            orphan,
            canonical,
            baseline: evidence.baseline.baseline_sha256_hex.clone(),
            owners: evidence.baseline.owners_sha256_hex.clone(),
        }
    }

    async fn material_for(
        conn: &mut SqliteConnection,
        f: &RollbackFixture,
    ) -> Result<RollbackMaterial, V2Failure> {
        rollback_material_from_document(
            conn, &f.document, &f.leaf, &f.document_sha,
            &f.orphan.raw_sha256_hex, &f.orphan.fingerprint,
            &f.canonical.raw_sha256_hex, &f.canonical.fingerprint, &f.baseline,
        ).await
    }

    /* A digest over every peer-scoped surface plus the identity row, so "no
     * write" is proven by content and not by a single count. */
    async fn store_digest(conn: &mut SqliteConnection) -> String {
        let mut material = String::new();
        for (table, column, _) in V2_PEER_SCOPED_COLUMNS {
            let rows: Vec<(Option<String>, i64)> = sqlx::query_as(&format!(
                "SELECT \"{column}\" AS o, COUNT(*) AS n FROM \"{table}\" \
                 WHERE \"{column}\" IS NOT NULL GROUP BY \"{column}\" ORDER BY \"{column}\""
            )).fetch_all(&mut *conn).await.unwrap();
            for (owner, n) in rows {
                material.push_str(&format!("{table}\u{1f}{column}\u{1f}{}\u{1f}{n}\u{1e}",
                    owner.unwrap_or_default()));
            }
        }
        let identity: String = sqlx::query_scalar("SELECT value FROM kv_store WHERE key = ?")
            .bind(IDENTITY_KEY).fetch_one(&mut *conn).await.unwrap();
        material.push_str(&identity);
        sha256_hex(&material)
    }

    /* E/O/P: the exact orphan bytes come back, canonical is untouched, and
     * nothing is reminted. */
    #[test]
    fn rollback_returns_the_exact_orphan_bytes() {
        block_on(async {
        let mut conn = seeded(None).await;
        let f = rollback_fixture(&mut conn).await;
        let material = material_for(&mut conn, &f).await.expect("rollback material");
        assert_eq!(material.orphan.raw, orphan_json(), "exact original bytes restored");
        assert_eq!(material.orphan.raw_sha256_hex, f.orphan.raw_sha256_hex);
        assert_eq!(material.orphan.fingerprint, f.orphan.fingerprint);
        assert_eq!(material.orphan.sync_peer_id, ORPHAN);
        /* N: restoring a peer that differs from canonical is what makes the
         * authority divergent again. */
        assert_ne!(material.orphan.fingerprint, material.canonical_fingerprint_sha256_hex,
            "restored identity diverges from canonical");
        /* O/P: canonical row unchanged, no new identity minted. */
        assert_eq!(material.canonical_raw_sha256_hex, f.canonical.raw_sha256_hex);
        let identity: String = sqlx::query_scalar("SELECT value FROM kv_store WHERE key = ?")
            .bind(IDENTITY_KEY).fetch_one(&mut conn).await.unwrap();
        assert_eq!(identity, canonical_json(), "canonical identity byte-identical");
        });
    }

    /* L/M: rollback reads only - no SQLite write, no ownership row changed. */
    #[test]
    fn rollback_writes_nothing_and_changes_no_ownership_row() {
        block_on(async {
        let mut conn = seeded(None).await;
        let f = rollback_fixture(&mut conn).await;
        let before = store_digest(&mut conn).await;
        let material = material_for(&mut conn, &f).await.expect("rollback material");
        let after = store_digest(&mut conn).await;
        assert_eq!(before, after, "rollback performed zero SQLite writes");
        assert_eq!(material.ownership_baseline_sha256_hex, f.baseline, "baseline preserved");
        assert_eq!(material.ownership_owners_sha256_hex, f.owners, "owner set preserved");
        });
    }

    /* H: the protected backup must hash exactly. */
    #[test]
    fn rollback_refuses_a_backup_hash_mismatch() {
        block_on(async {
        let mut conn = seeded(None).await;
        let f = rollback_fixture(&mut conn).await;
        let wrong = sha256_hex("not-the-backup");
        let outcome = rollback_material_from_document(
            &mut conn, &f.document, &f.leaf, &wrong,
            &f.orphan.raw_sha256_hex, &f.orphan.fingerprint,
            &f.canonical.raw_sha256_hex, &f.canonical.fingerprint, &f.baseline,
        ).await;
        assert_eq!(outcome.err(), Some(V2Failure::BackupConflict));
        /* And a leaf that is not the content address of the target is refused
         * before anything is read. */
        let outcome = rollback_material_from_document(
            &mut conn, &f.document, "localstorage-identity-backup.deadbeef.v2.json",
            &f.document_sha, &f.orphan.raw_sha256_hex, &f.orphan.fingerprint,
            &f.canonical.raw_sha256_hex, &f.canonical.fingerprint, &f.baseline,
        ).await;
        assert_eq!(outcome.err(), Some(V2Failure::BackupConflict));
        });
    }

    /* I: the restoration target must be exactly the one that was authorized. */
    #[test]
    fn rollback_refuses_target_drift() {
        block_on(async {
        let mut conn = seeded(None).await;
        let f = rollback_fixture(&mut conn).await;
        /* A different target: its content address names a different leaf, and
         * the backup we hold does not carry it. */
        let other = validate_identity_v2(&identity_json(
            "studio-desktop:tauri-desktop:sqlite:2c6b8f10-9a44-4e21-8d0f-77b1c3a45e90",
            "2c6b8f10-9a44-4e21-8d0f-77b1c3a45e90")).expect("other parses");
        let outcome = rollback_material_from_document(
            &mut conn, &f.document, &backup_leaf_name(&other.raw_sha256_hex), &f.document_sha,
            &other.raw_sha256_hex, &other.fingerprint,
            &f.canonical.raw_sha256_hex, &f.canonical.fingerprint, &f.baseline,
        ).await;
        assert_eq!(outcome.err(), Some(V2Failure::TargetDrift));
        });
    }

    /* J: the canonical row may not move under the rollback. */
    #[test]
    fn rollback_refuses_canonical_identity_drift() {
        block_on(async {
        let mut conn = seeded(None).await;
        let f = rollback_fixture(&mut conn).await;
        /* Same peer (ownership unchanged) but different bytes. */
        let drifted = canonical_json().replace(
            "\"updatedAt\":\"2026-08-01T00:00:00.000Z\"",
            "\"updatedAt\":\"2026-09-01T00:00:00.000Z\"");
        assert_ne!(drifted, canonical_json());
        sqlx::query("UPDATE kv_store SET value = ? WHERE key = ?")
            .bind(&drifted).bind(IDENTITY_KEY).execute(&mut conn).await.unwrap();
        let outcome = material_for(&mut conn, &f).await;
        assert_eq!(outcome.err(), Some(V2Failure::CanonicalRowMismatch));
        });
    }

    /* K: the frozen ownership baseline may not move under the rollback. */
    #[test]
    fn rollback_refuses_ownership_baseline_drift() {
        block_on(async {
        let mut conn = seeded(None).await;
        let f = rollback_fixture(&mut conn).await;
        sqlx::query("INSERT INTO sync_tombstones (deleted_by_sync_peer_id) VALUES (?)")
            .bind(RESIDUE[0]).execute(&mut conn).await.unwrap();
        let outcome = material_for(&mut conn, &f).await;
        assert_eq!(outcome.err(), Some(V2Failure::OwnershipBaselineChanged));
        });
    }

    /* A/B/C/D/F/G: the one-use rollback authorization, end to end. */
    #[test]
    fn rollback_lease_binds_exactly_and_is_one_use() {
        let _guard = LEASE_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        block_on(async {
        let mut conn = seeded(None).await;
        let f = rollback_fixture(&mut conn).await;
        let material = material_for(&mut conn, &f).await.expect("material");

        /* A: no lease -> reported inactive, and a claim is refused. */
        let _ = h2o_p02_identity_orphan_reconciliation_v2_cancel_rollback().await;
        let status = h2o_p02_identity_orphan_reconciliation_v2_lease_status().await.unwrap();
        assert!(!status.active, "fresh state reports no active lease");
        assert_eq!(
            claim_rollback_lease("req-1", "n", &f.document_sha, &f.orphan.raw_sha256_hex).err(),
            Some(V2Failure::LeaseMissing));

        /* B: the authorization binds backup, target, canonical and ownership. */
        let nonce = random_hex(32).expect("nonce");
        assert_eq!(nonce.len(), 64, "one-use nonce is full width");
        let lease = rollback_lease_from("req-1", &nonce, &material, &f.leaf, &f.document_sha);
        assert_eq!(lease.operation, V2_ROLLBACK_OPERATION);
        assert_eq!(lease.backup_leaf_name, f.leaf);
        assert_eq!(lease.backup_sha256_hex, f.document_sha);
        assert_eq!(lease.local_storage_raw_sha256_hex, f.orphan.raw_sha256_hex);
        assert_eq!(lease.local_storage_fingerprint_sha256_hex, f.orphan.fingerprint);
        assert_eq!(lease.orphan_sync_peer_id, ORPHAN);
        assert_eq!(lease.canonical_raw_sha256_hex, f.canonical.raw_sha256_hex);
        assert_eq!(lease.canonical_fingerprint_sha256_hex, f.canonical.fingerprint);
        assert_eq!(lease.ownership_baseline_sha256_hex, f.baseline);
        assert_eq!(lease.ownership_owners_sha256_hex, f.owners);
        assert!(!lease.consumed);
        with_lease(|slot| { *slot = Some(lease.clone()); Ok::<(), V2Failure>(()) }).unwrap();

        /* A: an installed authorization is reported active and bound. */
        let status = h2o_p02_identity_orphan_reconciliation_v2_lease_status().await.unwrap();
        assert!(status.active, "authorized lease is reported active");
        assert_eq!(status.operation, Some(V2_ROLLBACK_OPERATION));
        assert_eq!(status.reconciliation_request_id.as_deref(), Some("req-1"));
        assert!(status.nonce.is_none(), "lease_status never re-reveals the nonce");

        /* G: wrong request id, wrong binding, wrong nonce and the removal
         * operation are each refused distinctly. */
        assert_eq!(
            claim_rollback_lease("req-2", &nonce, &f.document_sha, &f.orphan.raw_sha256_hex).err(),
            Some(V2Failure::LeaseBindingMismatch));
        assert_eq!(
            claim_rollback_lease("req-1", &nonce, &sha256_hex("other"), &f.orphan.raw_sha256_hex).err(),
            Some(V2Failure::LeaseBindingMismatch));
        assert_eq!(
            claim_rollback_lease("req-1", &nonce, &f.document_sha, &sha256_hex("other")).err(),
            Some(V2Failure::LeaseBindingMismatch));
        let stale = random_hex(32).expect("nonce");
        assert_eq!(
            claim_rollback_lease("req-1", &stale, &f.document_sha, &f.orphan.raw_sha256_hex).err(),
            Some(V2Failure::LeaseNonceMismatch));

        /* C: the correct nonce yields exactly the authorized material. */
        let claimed = claim_rollback_lease("req-1", &nonce, &f.document_sha, &f.orphan.raw_sha256_hex)
            .expect("claim succeeds");
        assert_eq!(claimed.backup_leaf_name, f.leaf);
        assert_eq!(claimed.local_storage_raw_sha256_hex, f.orphan.raw_sha256_hex);

        /* F: a second use of the same authorization is blocked. */
        assert_eq!(
            claim_rollback_lease("req-1", &nonce, &f.document_sha, &f.orphan.raw_sha256_hex).err(),
            Some(V2Failure::LeaseAlreadyConsumed));

        /* G: an expired authorization is blocked and cleared. */
        let mut expired = rollback_lease_from("req-3", &nonce, &material, &f.leaf, &f.document_sha);
        expired.created = std::time::Instant::now() - (V2_LEASE_TTL + std::time::Duration::from_secs(1));
        with_lease(|slot| { *slot = Some(expired); Ok::<(), V2Failure>(()) }).unwrap();
        assert_eq!(
            claim_rollback_lease("req-3", &nonce, &f.document_sha, &f.orphan.raw_sha256_hex).err(),
            Some(V2Failure::LeaseExpired));

        /* An authorization for the REMOVAL operation is never usable here. */
        let mut wrong_op = rollback_lease_from("req-4", &nonce, &material, &f.leaf, &f.document_sha);
        wrong_op.operation = V2_OPERATION;
        with_lease(|slot| { *slot = Some(wrong_op); Ok::<(), V2Failure>(()) }).unwrap();
        assert_eq!(
            claim_rollback_lease("req-4", &nonce, &f.document_sha, &f.orphan.raw_sha256_hex).err(),
            Some(V2Failure::LeaseOperationMismatch));

        /* D: cancel clears the authority cleanly. */
        let cancelled = h2o_p02_identity_orphan_reconciliation_v2_cancel_rollback().await.unwrap();
        assert!(cancelled.ok, "cancel succeeds");
        let status = h2o_p02_identity_orphan_reconciliation_v2_lease_status().await.unwrap();
        assert!(!status.active, "no authority survives cancel");
        assert_eq!(
            claim_rollback_lease("req-1", &nonce, &f.document_sha, &f.orphan.raw_sha256_hex).err(),
            Some(V2Failure::LeaseMissing));
        });
    }


    /* K: the exact localStorage target changing after prepare is a CAS block.
       AA/Z: a removal authorization is one-use and refuses stale/wrong leases. */
    #[test]
    fn removal_authorization_is_one_use_and_target_bound() {
        let _guard = LEASE_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        block_on(async {
        let mut conn = seeded(None).await;
        let f = rollback_fixture(&mut conn).await;
        let material = material_for(&mut conn, &f).await.expect("material");
        let nonce = random_hex(32).expect("nonce");

        let mut lease = rollback_lease_from("req-r", &nonce, &material, &f.leaf, &f.document_sha);
        lease.operation = V2_OPERATION;
        with_lease(|slot| { *slot = Some(lease.clone()); Ok::<(), V2Failure>(()) }).unwrap();

        /* K: the authorized target still matches; a different record does not. */
        let observed = validate_identity_v2(&orphan_json()).expect("observed");
        assert!(target_matches(&lease, &observed), "the authorized record matches");
        let drifted = validate_identity_v2(&identity_json(
            "studio-desktop:tauri-desktop:sqlite:2c6b8f10-9a44-4e21-8d0f-77b1c3a45e90",
            "2c6b8f10-9a44-4e21-8d0f-77b1c3a45e90")).expect("drifted");
        assert!(!target_matches(&lease, &drifted), "a changed target is refused");
        /* A re-mint cannot even be constructed as "the same peer": syncPeerId
         * embeds installId, so a new install id IS a different target. */
        assert!(validate_identity_v2(&identity_json(
            ORPHAN, "3d49127b-6b55-4f32-9e1f-88c2d4b56fa1")).is_none(),
            "syncPeerId must agree with installId");

        /* Z: wrong request id and wrong nonce are refused distinctly. */
        assert_eq!(claim_removal_lease("req-x", &nonce).err(), Some(V2Failure::LeaseBindingMismatch));
        let other = random_hex(32).expect("nonce");
        assert_eq!(claim_removal_lease("req-r", &other).err(), Some(V2Failure::LeaseNonceMismatch));

        /* AA: first use succeeds, second use of the same authorization blocks. */
        assert!(claim_removal_lease("req-r", &nonce).is_ok(), "first use succeeds");
        assert_eq!(claim_removal_lease("req-r", &nonce).err(), Some(V2Failure::LeaseAlreadyConsumed));

        /* A rollback authorization is never usable as a removal authorization. */
        let rollback = rollback_lease_from("req-b", &nonce, &material, &f.leaf, &f.document_sha);
        with_lease(|slot| { *slot = Some(rollback); Ok::<(), V2Failure>(()) }).unwrap();
        assert_eq!(claim_removal_lease("req-b", &nonce).err(), Some(V2Failure::LeaseOperationMismatch));

        let _ = h2o_p02_identity_orphan_reconciliation_v2_cancel_rollback().await;
        });
    }

}
