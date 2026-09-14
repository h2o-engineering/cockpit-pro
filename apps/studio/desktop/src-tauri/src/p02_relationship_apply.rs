//! P02 folder-relationship materialization: the ONE fixed-statement Tauri
//! command (Mission p02-folder-relationship-synchronization, T01; Host
//! Integration lease `RELATIONSHIP_HOST_INTEGRATION_LEASE_APPROVED —
//! ONE_TAURI_ADAPTER_COMMAND`; writer-authority contract
//! `HDA_RATIFY_P02_RELATIONSHIP_APPLY_WRITER_AUTHORITY_CONTRACT`).
//!
//! This is a Host Integration adapter realizing the Library-owned
//! relationship-command semantics (create-with-verbatim-id, rename, bind,
//! unbind). It is invoked by Sync and is NOT a Folder authority of its own
//! (STAB-02): it never decides what a folder command means, only executes the
//! four admitted shapes with fixed parameterized SQL.
//!
//! Writer identity. `p02.relationship-apply` is installed on the acquired
//! connection for exactly one bounded transaction and reset before the
//! transaction ends - on success and on every failure path. The generic
//! `f15_authorized_sqlite_execute` path never accepts this identity
//! (`sqlite-writer-identity-not-allowed`); the v23 folder_bindings triggers
//! admit it when the F16 guard is on. No debug or emergency bypass exists.
//!
//! Allowed writes (contract §4/§5), and nothing else:
//!   folders          INSERT (verbatim id, canonical name, source='user',
//!                    created_at, updated_at; color stays NULL)
//!                    UPDATE name, updated_at WHERE id = ?
//!   folder_bindings  INSERT OR REPLACE (chat_id, folder_id, assigned_at)
//!                    DELETE WHERE chat_id = ?   (the chat's one binding)
//!
//! No `DELETE FROM folders`, no delete-by-folder, no chat/snapshot/turn,
//! label/tag/category/project/asset, tombstone, conflict, watermark, kv_store
//! or DDL statement exists in this module. Protocol bookkeeping in
//! sync_object_state is deliberately NOT performed here: under the current
//! architecture that bookkeeping is written by the Desktop Sync runtime
//! (domain-qualified since v23), and the Tauri adapter materializes only.
//!
//! The request is a bounded DTO with `deny_unknown_fields`: there is no SQL
//! parameter, no table name, no column set and no caller-supplied fragment.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqliteConnection};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

use crate::sqlite_writer_identity::install_writer_identity_function;
use crate::sync_contract_v2::{is_canonical_folder_name, is_chat_object_id, is_folder_object_id};

/// The scoped writer identity. Its only installation site is
/// `run_relationship_apply` below.
pub(crate) const P02_RELATIONSHIP_APPLY_IDENTITY: &str = "p02.relationship-apply";
pub const P02_RELATIONSHIP_APPLY_REQUEST_SCHEMA: &str = "h2o.studio.p02RelationshipApplyRequest.v1";
pub const P02_RELATIONSHIP_APPLY_RESULT_SCHEMA: &str = "h2o.studio.p02RelationshipApplyResult.v1";

const DB_URL: &str = "sqlite:studio-v1.db";
const FOLDER_SOURCE_USER: &str = "user";

pub const KIND_CREATE_FOLDER: &str = "create-folder";
pub const KIND_RENAME_FOLDER: &str = "rename-folder";
pub const KIND_BIND_CHAT: &str = "bind-chat";
pub const KIND_UNBIND_CHAT: &str = "unbind-chat";

pub const ERR_REQUEST_SCHEMA_INVALID: &str = "p02-relationship-apply-request-schema-invalid";
pub const ERR_KIND_INVALID: &str = "p02-relationship-apply-kind-invalid";
pub const ERR_REQUEST_SHAPE_INVALID: &str = "p02-relationship-apply-request-shape-invalid";
pub const ERR_FOLDER_ID_INVALID: &str = "p02-relationship-apply-folder-id-invalid";
pub const ERR_FOLDER_NAME_INVALID: &str = "p02-relationship-apply-folder-name-invalid";
pub const ERR_CHAT_ID_INVALID: &str = "p02-relationship-apply-chat-id-invalid";
pub const ERR_FOLDER_EXISTS: &str = "p02-relationship-apply-folder-exists";
pub const ERR_FOLDER_MISSING: &str = "p02-relationship-apply-folder-missing";
pub const ERR_FOLDER_NOT_ELIGIBLE: &str = "p02-relationship-apply-folder-not-eligible";
pub const ERR_CHAT_MISSING: &str = "p02-relationship-apply-chat-missing";
pub const ERR_DB_UNAVAILABLE: &str = "p02-relationship-apply-db-unavailable";
pub const ERR_IDENTITY_INSTALL_FAILED: &str = "p02-relationship-apply-identity-install-failed";
pub const ERR_TRANSACTION_FAILED: &str = "p02-relationship-apply-transaction-failed";
pub const ERR_STATEMENT_FAILED: &str = "p02-relationship-apply-statement-failed";
pub const ERR_AFFECTED_ROWS_MISMATCH: &str = "p02-relationship-apply-affected-rows-mismatch";

/// Bounded request DTO. Exactly the fields the admitted operation kinds need;
/// any other field is a deserialization failure, never an accepted input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct P02RelationshipApplyRequest {
    pub schema: String,
    pub kind: String,
    #[serde(default, rename = "folderId")]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, rename = "chatId")]
    pub chat_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P02RelationshipApplyResult {
    pub schema: &'static str,
    pub ok: bool,
    pub applied: bool,
    pub kind: String,
    pub outcome: &'static str,
    pub writer_identity: &'static str,
    pub rows_affected: u64,
    pub error_code: Option<String>,
}

impl P02RelationshipApplyResult {
    fn refused(kind: &str, code: &str) -> Self {
        Self {
            schema: P02_RELATIONSHIP_APPLY_RESULT_SCHEMA,
            ok: false,
            applied: false,
            kind: kind.to_string(),
            outcome: "refused",
            writer_identity: P02_RELATIONSHIP_APPLY_IDENTITY,
            rows_affected: 0,
            error_code: Some(code.to_string()),
        }
    }

    fn applied(kind: &str, outcome: &'static str, rows_affected: u64) -> Self {
        Self {
            schema: P02_RELATIONSHIP_APPLY_RESULT_SCHEMA,
            ok: true,
            applied: true,
            kind: kind.to_string(),
            outcome,
            writer_identity: P02_RELATIONSHIP_APPLY_IDENTITY,
            rows_affected,
            error_code: None,
        }
    }
}

/// The admitted operation shapes. Validation is total: a value of this type
/// carries only identifiers and names that already satisfy the ratified
/// contract grammar.
#[derive(Clone, Debug, Eq, PartialEq)]
enum AdmittedOperation {
    CreateFolder { folder_id: String, name: String },
    RenameFolder { folder_id: String, name: String },
    BindChat { chat_id: String, folder_id: String },
    UnbindChat { chat_id: String },
}

impl AdmittedOperation {
    fn kind(&self) -> &'static str {
        match self {
            Self::CreateFolder { .. } => KIND_CREATE_FOLDER,
            Self::RenameFolder { .. } => KIND_RENAME_FOLDER,
            Self::BindChat { .. } => KIND_BIND_CHAT,
            Self::UnbindChat { .. } => KIND_UNBIND_CHAT,
        }
    }
}

fn validate_request(request: &P02RelationshipApplyRequest) -> Result<AdmittedOperation, &'static str> {
    if request.schema != P02_RELATIONSHIP_APPLY_REQUEST_SCHEMA {
        return Err(ERR_REQUEST_SCHEMA_INVALID);
    }
    let folder_id = |value: &Option<String>| -> Result<String, &'static str> {
        match value {
            Some(id) if is_folder_object_id(id) => Ok(id.clone()),
            Some(_) => Err(ERR_FOLDER_ID_INVALID),
            None => Err(ERR_REQUEST_SHAPE_INVALID),
        }
    };
    let name = |value: &Option<String>| -> Result<String, &'static str> {
        match value {
            Some(name) if is_canonical_folder_name(name) => Ok(name.clone()),
            Some(_) => Err(ERR_FOLDER_NAME_INVALID),
            None => Err(ERR_REQUEST_SHAPE_INVALID),
        }
    };
    let chat_id = |value: &Option<String>| -> Result<String, &'static str> {
        match value {
            Some(id) if is_chat_object_id(id) => Ok(id.clone()),
            Some(_) => Err(ERR_CHAT_ID_INVALID),
            None => Err(ERR_REQUEST_SHAPE_INVALID),
        }
    };
    let absent = |value: &Option<String>| -> Result<(), &'static str> {
        if value.is_some() {
            Err(ERR_REQUEST_SHAPE_INVALID)
        } else {
            Ok(())
        }
    };
    match request.kind.as_str() {
        KIND_CREATE_FOLDER => {
            absent(&request.chat_id)?;
            Ok(AdmittedOperation::CreateFolder {
                folder_id: folder_id(&request.folder_id)?,
                name: name(&request.name)?,
            })
        }
        KIND_RENAME_FOLDER => {
            absent(&request.chat_id)?;
            Ok(AdmittedOperation::RenameFolder {
                folder_id: folder_id(&request.folder_id)?,
                name: name(&request.name)?,
            })
        }
        KIND_BIND_CHAT => {
            absent(&request.name)?;
            Ok(AdmittedOperation::BindChat {
                chat_id: chat_id(&request.chat_id)?,
                folder_id: folder_id(&request.folder_id)?,
            })
        }
        KIND_UNBIND_CHAT => {
            absent(&request.name)?;
            absent(&request.folder_id)?;
            Ok(AdmittedOperation::UnbindChat {
                chat_id: chat_id(&request.chat_id)?,
            })
        }
        _ => Err(ERR_KIND_INVALID),
    }
}

async fn control(conn: &mut SqliteConnection, sql: &str) -> Result<(), &'static str> {
    sqlx::query(sql)
        .execute(conn)
        .await
        .map(|_| ())
        .map_err(|_| ERR_TRANSACTION_FAILED)
}

/// Folder dependency check for rename/bind: the row must exist and be a
/// user-created local folder. Project-backed, system and reserved folders are
/// typed-ineligible (K10) and are never touched.
async fn require_user_folder(conn: &mut SqliteConnection, folder_id: &str) -> Result<(), &'static str> {
    let row = sqlx::query("SELECT source FROM folders WHERE id = ? LIMIT 1")
        .bind(folder_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|_| ERR_STATEMENT_FAILED)?;
    let Some(row) = row else {
        return Err(ERR_FOLDER_MISSING);
    };
    let source: String = row.try_get("source").map_err(|_| ERR_STATEMENT_FAILED)?;
    if source != FOLDER_SOURCE_USER {
        return Err(ERR_FOLDER_NOT_ELIGIBLE);
    }
    Ok(())
}

/// Chat dependency check for bind/unbind: a live (not soft-deleted) chat row.
async fn require_live_chat(conn: &mut SqliteConnection, chat_id: &str) -> Result<(), &'static str> {
    let row = sqlx::query("SELECT is_deleted FROM chats WHERE id = ? LIMIT 1")
        .bind(chat_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|_| ERR_STATEMENT_FAILED)?;
    let Some(row) = row else {
        return Err(ERR_CHAT_MISSING);
    };
    let deleted: i64 = row.try_get("is_deleted").map_err(|_| ERR_STATEMENT_FAILED)?;
    if deleted != 0 {
        return Err(ERR_CHAT_MISSING);
    }
    Ok(())
}

async fn execute_admitted(
    conn: &mut SqliteConnection,
    operation: &AdmittedOperation,
    now_millis: i64,
) -> Result<(&'static str, u64), &'static str> {
    match operation {
        AdmittedOperation::CreateFolder { folder_id, name } => {
            let existing = sqlx::query("SELECT 1 FROM folders WHERE id = ? LIMIT 1")
                .bind(folder_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|_| ERR_STATEMENT_FAILED)?;
            if existing.is_some() {
                return Err(ERR_FOLDER_EXISTS);
            }
            let inserted = sqlx::query(
                "INSERT INTO folders (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(folder_id)
            .bind(name)
            .bind(FOLDER_SOURCE_USER)
            .bind(now_millis)
            .bind(now_millis)
            .execute(&mut *conn)
            .await
            .map_err(|_| ERR_STATEMENT_FAILED)?
            .rows_affected();
            if inserted != 1 {
                return Err(ERR_AFFECTED_ROWS_MISMATCH);
            }
            Ok(("created", inserted))
        }
        AdmittedOperation::RenameFolder { folder_id, name } => {
            require_user_folder(conn, folder_id).await?;
            let updated = sqlx::query("UPDATE folders SET name = ?, updated_at = ? WHERE id = ?")
                .bind(name)
                .bind(now_millis)
                .bind(folder_id)
                .execute(&mut *conn)
                .await
                .map_err(|_| ERR_STATEMENT_FAILED)?
                .rows_affected();
            if updated != 1 {
                return Err(ERR_AFFECTED_ROWS_MISMATCH);
            }
            Ok(("renamed", updated))
        }
        AdmittedOperation::BindChat { chat_id, folder_id } => {
            require_live_chat(conn, chat_id).await?;
            require_user_folder(conn, folder_id).await?;
            let bound = sqlx::query(
                "INSERT OR REPLACE INTO folder_bindings (chat_id, folder_id, assigned_at) VALUES (?, ?, ?)",
            )
            .bind(chat_id)
            .bind(folder_id)
            .bind(now_millis)
            .execute(&mut *conn)
            .await
            .map_err(|_| ERR_STATEMENT_FAILED)?
            .rows_affected();
            if bound != 1 {
                return Err(ERR_AFFECTED_ROWS_MISMATCH);
            }
            Ok(("bound", bound))
        }
        AdmittedOperation::UnbindChat { chat_id } => {
            require_live_chat(conn, chat_id).await?;
            /* chat_id is the folder_bindings PRIMARY KEY: this deletes at most
             * the chat's one current binding and nothing else. */
            let removed = sqlx::query("DELETE FROM folder_bindings WHERE chat_id = ?")
                .bind(chat_id)
                .execute(&mut *conn)
                .await
                .map_err(|_| ERR_STATEMENT_FAILED)?
                .rows_affected();
            if removed > 1 {
                return Err(ERR_AFFECTED_ROWS_MISMATCH);
            }
            Ok((if removed == 1 { "unfiled" } else { "already-unfiled" }, removed))
        }
    }
}

/// Identity cleanup for every failure path: reset the connection identity,
/// then roll back. Both are best-effort here because the caller already holds
/// the typed error that explains the refusal.
async fn abort(conn: &mut SqliteConnection) {
    let _ = install_writer_identity_function(conn, "").await;
    let _ = control(conn, "ROLLBACK").await;
}

/// The bounded transaction. Testable on any SqliteConnection.
pub async fn run_relationship_apply(
    conn: &mut SqliteConnection,
    request: &P02RelationshipApplyRequest,
    now_millis: i64,
) -> P02RelationshipApplyResult {
    let operation = match validate_request(request) {
        Ok(operation) => operation,
        Err(code) => return P02RelationshipApplyResult::refused(&request.kind, code),
    };
    let kind = operation.kind();

    if install_writer_identity_function(conn, P02_RELATIONSHIP_APPLY_IDENTITY)
        .await
        .is_err()
    {
        let _ = install_writer_identity_function(conn, "").await;
        return P02RelationshipApplyResult::refused(kind, ERR_IDENTITY_INSTALL_FAILED);
    }
    if control(conn, "BEGIN IMMEDIATE").await.is_err() {
        let _ = install_writer_identity_function(conn, "").await;
        return P02RelationshipApplyResult::refused(kind, ERR_TRANSACTION_FAILED);
    }

    let (outcome, rows_affected) = match execute_admitted(conn, &operation, now_millis).await {
        Ok(applied) => applied,
        Err(code) => {
            abort(conn).await;
            return P02RelationshipApplyResult::refused(kind, code);
        }
    };

    if install_writer_identity_function(conn, "").await.is_err() {
        abort(conn).await;
        return P02RelationshipApplyResult::refused(kind, ERR_IDENTITY_INSTALL_FAILED);
    }
    if control(conn, "COMMIT").await.is_err() {
        abort(conn).await;
        return P02RelationshipApplyResult::refused(kind, ERR_TRANSACTION_FAILED);
    }

    P02RelationshipApplyResult::applied(kind, outcome, rows_affected)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub async fn h2o_p02_relationship_apply(
    db_instances: State<'_, DbInstances>,
    request: P02RelationshipApplyRequest,
) -> Result<P02RelationshipApplyResult, String> {
    let pool = {
        let instances = db_instances.0.read().await;
        match instances.get(DB_URL) {
            Some(DbPool::Sqlite(pool)) => pool.clone(),
            #[allow(unreachable_patterns)]
            _ => return Ok(P02RelationshipApplyResult::refused(&request.kind, ERR_DB_UNAVAILABLE)),
        }
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => return Ok(P02RelationshipApplyResult::refused(&request.kind, ERR_DB_UNAVAILABLE)),
    };
    Ok(run_relationship_apply(&mut conn, &request, now_millis()).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::migrate::{Migration as SqlxMigration, MigrationType, Migrator};
    use sqlx::Connection;
    use std::borrow::Cow;

    /// The Product migration list exactly as the SQL plugin hands it to sqlx:
    /// one Migrator over `studio_migrations()`, each version applied inside
    /// its own transaction and recorded in `_sqlx_migrations`.
    fn migrator(max_version: i64) -> Migrator {
        let migrations = crate::studio_migrations()
            .into_iter()
            .filter(|migration| migration.version <= max_version)
            .map(|migration| {
                SqlxMigration::new(
                    migration.version,
                    migration.description.into(),
                    MigrationType::ReversibleUp,
                    migration.sql.into(),
                    false,
                )
            })
            .collect::<Vec<_>>();
        Migrator {
            migrations: Cow::Owned(migrations),
            ignore_missing: false,
            locking: true,
            no_tx: false,
        }
    }

    async fn connection() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite");
        install_writer_identity_function(&mut conn, "")
            .await
            .expect("empty writer identity");
        conn
    }

    async fn migrated(max_version: i64) -> SqliteConnection {
        let mut conn = connection().await;
        migrator(max_version)
            .run(&mut conn)
            .await
            .unwrap_or_else(|error| panic!("migrations to v{max_version}: {error}"));
        conn
    }

    async fn applied_versions(conn: &mut SqliteConnection) -> Vec<i64> {
        sqlx::query_scalar::<_, i64>("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(conn)
            .await
            .expect("applied versions")
    }

    async fn column_names(conn: &mut SqliteConnection, table: &str) -> Vec<String> {
        sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(conn)
            .await
            .expect("table_info")
            .iter()
            .map(|row| row.get::<String, _>("name"))
            .collect()
    }

    async fn primary_key(conn: &mut SqliteConnection, table: &str) -> Vec<String> {
        let mut rows = sqlx::query(&format!("PRAGMA table_info({table})"))
            .fetch_all(conn)
            .await
            .expect("table_info")
            .iter()
            .map(|row| (row.get::<i64, _>("pk"), row.get::<String, _>("name")))
            .filter(|(pk, _)| *pk > 0)
            .collect::<Vec<_>>();
        rows.sort();
        rows.into_iter().map(|(_, name)| name).collect()
    }

    const PRE_V23_COLUMNS: [&str; 27] = [
        "sync_peer_id",
        "object_id",
        "last_published_revision_id",
        "last_published_revision_blob_sha256",
        "last_applied_revision_id",
        "last_applied_revision_blob_sha256",
        "remote_head_strong_etag",
        "remote_head_revision_blob_sha256",
        "pending_operation",
        "operation_phase",
        "operation_token",
        "owner_boot_id",
        "owner_context_id",
        "owner_token",
        "intended_object_key",
        "intended_revision_id",
        "intended_payload_sha256",
        "intended_revision_blob_sha256",
        "convergence_watermark_sha256",
        "consumed_revision_blob_sha256",
        "last_conflict_class",
        "last_error_code",
        "created_at",
        "updated_at",
        "last_published_payload_sha256",
        "last_applied_payload_sha256",
        "last_converged_direction",
    ];

    /// Seeds one fully populated row per (peer, object) plus one row that is
    /// mostly NULL, and returns every row as (column -> value) so the
    /// post-migration comparison is column-by-column.
    async fn seed_pre_v23_rows(conn: &mut SqliteConnection) -> Vec<Vec<(String, Option<String>)>> {
        let peers = ["studio-desktop:tauri-desktop:sqlite:peer-a", "studio-chrome:mv3-chrome:idb-archive:peer-b"];
        let objects = ["chat-1", "chat-2"];
        let mut seeded = Vec::new();
        for (peer_index, peer) in peers.iter().enumerate() {
            for (object_index, object) in objects.iter().enumerate() {
                let tag = format!("{peer_index}{object_index}");
                let sparse = peer_index == 1 && object_index == 1;
                let value = |name: &str| -> Option<String> {
                    if sparse && !matches!(name, "sync_peer_id" | "object_id" | "created_at" | "updated_at") {
                        None
                    } else {
                        Some(match name {
                            "sync_peer_id" => peer.to_string(),
                            "object_id" => object.to_string(),
                            "created_at" | "updated_at" => format!("2026-09-14T00:00:00.{tag}0Z"),
                            other => format!("{other}-{tag}"),
                        })
                    }
                };
                let row: Vec<(String, Option<String>)> = PRE_V23_COLUMNS
                    .iter()
                    .map(|name| (name.to_string(), value(name)))
                    .collect();
                let columns = PRE_V23_COLUMNS.join(", ");
                let placeholders = vec!["?"; PRE_V23_COLUMNS.len()].join(", ");
                let insert = format!(
                    "INSERT INTO sync_object_state ({columns}) VALUES ({placeholders})"
                );
                let mut query = sqlx::query(&insert);
                for (_, value) in &row {
                    query = query.bind(value.clone());
                }
                query.execute(&mut *conn).await.expect("seed pre-v23 row");
                seeded.push(row);
            }
        }
        seeded
    }

    async fn read_rows(conn: &mut SqliteConnection) -> Vec<Vec<(String, Option<String>)>> {
        let columns = column_names(conn, "sync_object_state").await;
        let rows = sqlx::query("SELECT * FROM sync_object_state ORDER BY sync_peer_id, object_domain, object_id")
            .fetch_all(conn)
            .await
            .expect("rows");
        rows.iter()
            .map(|row| {
                columns
                    .iter()
                    .map(|name| (name.clone(), row.get::<Option<String>, _>(name.as_str())))
                    .collect()
            })
            .collect()
    }

    fn cell<'a>(row: &'a [(String, Option<String>)], name: &str) -> &'a Option<String> {
        &row.iter().find(|(column, _)| column == name).expect(name).1
    }

    #[test]
    fn v23_rebuild_is_lossless_domain_qualified_and_never_rerun() {
        tauri::async_runtime::block_on(async {
            let mut conn = migrated(22).await;
            assert_eq!(applied_versions(&mut conn).await.last(), Some(&22));
            assert_eq!(column_names(&mut conn, "sync_object_state").await, PRE_V23_COLUMNS);

            let seeded = seed_pre_v23_rows(&mut conn).await;
            sqlx::query("UPDATE f16_folder_bindings_trigger_guard SET enabled = 1, reason = 'proof-on' WHERE id = 1")
                .execute(&mut conn)
                .await
                .expect("guard on");

            migrator(23).run(&mut conn).await.expect("v22 -> v23");
            assert_eq!(applied_versions(&mut conn).await.last(), Some(&23));

            /* Schema: object_domain is second, NOT NULL, no default; PK is the
             * domain-qualified triple; every pre-v23 column survives in order. */
            let columns = column_names(&mut conn, "sync_object_state").await;
            assert_eq!(columns[0], "sync_peer_id");
            assert_eq!(columns[1], "object_domain");
            assert_eq!(&columns[2..], &PRE_V23_COLUMNS[1..]);
            let domain_info = sqlx::query("PRAGMA table_info(sync_object_state)")
                .fetch_all(&mut conn)
                .await
                .unwrap()
                .into_iter()
                .find(|row| row.get::<String, _>("name") == "object_domain")
                .expect("object_domain column");
            assert_eq!(domain_info.get::<i64, _>("notnull"), 1);
            assert!(domain_info.get::<Option<String>, _>("dflt_value").is_none());
            assert_eq!(
                primary_key(&mut conn, "sync_object_state").await,
                ["sync_peer_id", "object_domain", "object_id"]
            );

            /* Data: row count preserved, every governed column byte-identical,
             * every row backfilled to the chat domain. */
            let migrated_rows = read_rows(&mut conn).await;
            assert_eq!(migrated_rows.len(), seeded.len());
            for expected in &seeded {
                let peer = cell(expected, "sync_peer_id").clone().unwrap();
                let object = cell(expected, "object_id").clone().unwrap();
                let actual = migrated_rows
                    .iter()
                    .find(|row| cell(row, "sync_peer_id").as_deref() == Some(peer.as_str())
                        && cell(row, "object_id").as_deref() == Some(object.as_str()))
                    .expect("migrated row");
                assert_eq!(
                    cell(actual, "object_domain").as_deref(),
                    Some(crate::sync_contract_v2::CHAT_OBJECT_DOMAIN_V1)
                );
                for (name, value) in expected {
                    assert_eq!(cell(actual, name), value, "{peer}/{object}/{name}");
                }
            }

            /* Key: the same peer + objectId now coexists across domains, the
             * old-key duplicate is still refused, and a domain-less write is
             * impossible rather than silently chat. */
            sqlx::query(
                "INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, created_at, updated_at) VALUES (?, ?, ?, 'now', 'now')",
            )
            .bind("studio-desktop:tauri-desktop:sqlite:peer-a")
            .bind(crate::sync_contract_v2::CHAT_FOLDER_BINDING_OBJECT_DOMAIN_V1)
            .bind("chat-1")
            .execute(&mut conn)
            .await
            .expect("binding row beside the chat row");
            assert!(sqlx::query(
                "INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, created_at, updated_at) VALUES (?, ?, ?, 'now', 'now')",
            )
            .bind("studio-desktop:tauri-desktop:sqlite:peer-a")
            .bind(crate::sync_contract_v2::CHAT_OBJECT_DOMAIN_V1)
            .bind("chat-1")
            .execute(&mut conn)
            .await
            .is_err());
            assert!(sqlx::query(
                "INSERT INTO sync_object_state (sync_peer_id, object_id, created_at, updated_at) VALUES (?, ?, 'now', 'now')",
            )
            .bind("studio-desktop:tauri-desktop:sqlite:peer-a")
            .bind("chat-9")
            .execute(&mut conn)
            .await
            .is_err());
            assert!(sqlx::query(
                "INSERT INTO sync_object_state (sync_peer_id, object_domain, object_id, created_at, updated_at) VALUES (?, '', ?, 'now', 'now')",
            )
            .bind("studio-desktop:tauri-desktop:sqlite:peer-a")
            .bind("chat-9")
            .execute(&mut conn)
            .await
            .is_err());

            /* F16 successor triggers carry the three-identity allowlist, the
             * guard row kept its state, and no sync_object_state trigger or
             * index was invented. */
            for trigger in [
                "f16_protect_folder_bindings_insert",
                "f16_protect_folder_bindings_update",
                "f16_protect_folder_bindings_delete",
            ] {
                let sql: String = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
                    .bind(trigger)
                    .fetch_one(&mut conn)
                    .await
                    .expect(trigger);
                assert!(sql.contains("'f15.execute-settlement-writer'"), "{trigger}");
                assert!(sql.contains("'f16.folder-legacy-fallback'"), "{trigger}");
                assert!(sql.contains("'p02.relationship-apply'"), "{trigger}");
                assert!(sql.contains("f16_folder_bindings_trigger_guard"), "{trigger}");
            }
            let (enabled, reason): (i64, String) =
                sqlx::query_as("SELECT enabled, reason FROM f16_folder_bindings_trigger_guard WHERE id = 1")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!((enabled, reason.as_str()), (1, "proof-on"));
            let leftovers: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'sync_object_state_v23%' OR (type IN ('trigger', 'index') AND tbl_name = 'sync_object_state' AND sql IS NOT NULL)",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert_eq!(leftovers, 0);

            /* Rerun under the framework is a no-op: nothing is re-applied and
             * the binding row is still there. */
            migrator(23).run(&mut conn).await.expect("rerun");
            assert_eq!(applied_versions(&mut conn).await.iter().filter(|v| **v == 23).count(), 1);
            let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_object_state")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(rows as usize, seeded.len() + 1);
        });
    }

    #[test]
    fn fresh_install_reaches_v23_with_the_domain_qualified_key() {
        tauri::async_runtime::block_on(async {
            let mut conn = migrated(23).await;
            assert_eq!(applied_versions(&mut conn).await, (1..=23).collect::<Vec<_>>());
            assert_eq!(
                primary_key(&mut conn, "sync_object_state").await,
                ["sync_peer_id", "object_domain", "object_id"]
            );
            let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_object_state")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(rows, 0);
        });
    }

    fn request(kind: &str, folder_id: Option<&str>, name: Option<&str>, chat_id: Option<&str>) -> P02RelationshipApplyRequest {
        P02RelationshipApplyRequest {
            schema: P02_RELATIONSHIP_APPLY_REQUEST_SCHEMA.to_string(),
            kind: kind.to_string(),
            folder_id: folder_id.map(str::to_string),
            name: name.map(str::to_string),
            chat_id: chat_id.map(str::to_string),
        }
    }

    async fn seed_chat(conn: &mut SqliteConnection, id: &str, deleted: i64) {
        sqlx::query("INSERT INTO chats (id, title, created_at, updated_at, is_deleted) VALUES (?, ?, 1, 1, ?)")
            .bind(id)
            .bind(format!("chat {id}"))
            .bind(deleted)
            .execute(conn)
            .await
            .expect("seed chat");
    }

    async fn identity(conn: &mut SqliteConnection) -> String {
        sqlx::query_scalar::<_, String>("SELECT COALESCE(h2o_writer_identity(), '')")
            .fetch_one(conn)
            .await
            .expect("identity readback")
    }

    async fn counts(conn: &mut SqliteConnection) -> Vec<(String, i64)> {
        let mut out = Vec::new();
        for table in [
            "chats", "snapshots", "snapshot_turns", "labels", "tags", "categories", "label_bindings",
            "tag_bindings", "sync_tombstones", "sync_tombstone_reviews", "sync_conflicts",
            "sync_object_state", "sync_peer_watermarks", "kv_store", "assets",
        ] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&mut *conn)
                .await
                .expect(table);
            out.push((table.to_string(), count));
        }
        out
    }

    async fn folder(conn: &mut SqliteConnection, id: &str) -> Option<(String, String, Option<String>, Option<String>, i64, i64, i64, String)> {
        sqlx::query("SELECT name, source, color, parent_id, sort_order, created_at, updated_at, meta_json FROM folders WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await
            .expect("folder")
            .map(|row| (
                row.get("name"),
                row.get("source"),
                row.get("color"),
                row.get("parent_id"),
                row.get("sort_order"),
                row.get("created_at"),
                row.get("updated_at"),
                row.get("meta_json"),
            ))
    }

    async fn binding(conn: &mut SqliteConnection, chat_id: &str) -> Option<(String, i64)> {
        sqlx::query("SELECT folder_id, assigned_at FROM folder_bindings WHERE chat_id = ?")
            .bind(chat_id)
            .fetch_optional(conn)
            .await
            .expect("binding")
            .map(|row| (row.get("folder_id"), row.get("assigned_at")))
    }

    #[test]
    fn admitted_operations_apply_through_the_fixed_statements() {
        tauri::async_runtime::block_on(async {
            let mut conn = migrated(23).await;
            seed_chat(&mut conn, "chat-a", 0).await;
            let before = counts(&mut conn).await;

            let created = run_relationship_apply(&mut conn, &request(KIND_CREATE_FOLDER, Some("f_study"), Some("Study"), None), 1_000).await;
            assert!(created.ok && created.applied, "{created:?}");
            assert_eq!((created.outcome, created.rows_affected), ("created", 1));
            assert_eq!(
                folder(&mut conn, "f_study").await,
                Some(("Study".into(), "user".into(), None, None, 0, 1_000, 1_000, "{}".into()))
            );
            assert_eq!(identity(&mut conn).await, "");

            let renamed = run_relationship_apply(&mut conn, &request(KIND_RENAME_FOLDER, Some("f_study"), Some("Study Notes"), None), 2_000).await;
            assert!(renamed.ok, "{renamed:?}");
            assert_eq!(renamed.outcome, "renamed");
            assert_eq!(
                folder(&mut conn, "f_study").await,
                Some(("Study Notes".into(), "user".into(), None, None, 0, 1_000, 2_000, "{}".into()))
            );

            let bound = run_relationship_apply(&mut conn, &request(KIND_BIND_CHAT, Some("f_study"), None, Some("chat-a")), 3_000).await;
            assert!(bound.ok, "{bound:?}");
            assert_eq!(bound.outcome, "bound");
            assert_eq!(binding(&mut conn, "chat-a").await, Some(("f_study".into(), 3_000)));

            run_relationship_apply(&mut conn, &request(KIND_CREATE_FOLDER, Some("fold_chrome_code"), Some("Code"), None), 3_500).await;
            let moved = run_relationship_apply(&mut conn, &request(KIND_BIND_CHAT, Some("fold_chrome_code"), None, Some("chat-a")), 4_000).await;
            assert!(moved.ok, "{moved:?}");
            assert_eq!(binding(&mut conn, "chat-a").await, Some(("fold_chrome_code".into(), 4_000)));
            let bindings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folder_bindings").fetch_one(&mut conn).await.unwrap();
            assert_eq!(bindings, 1, "move replaces, never duplicates");

            let unfiled = run_relationship_apply(&mut conn, &request(KIND_UNBIND_CHAT, None, None, Some("chat-a")), 5_000).await;
            assert!(unfiled.ok, "{unfiled:?}");
            assert_eq!((unfiled.outcome, unfiled.rows_affected), ("unfiled", 1));
            assert_eq!(binding(&mut conn, "chat-a").await, None);

            let again = run_relationship_apply(&mut conn, &request(KIND_UNBIND_CHAT, None, None, Some("chat-a")), 6_000).await;
            assert!(again.ok, "{again:?}");
            assert_eq!((again.outcome, again.rows_affected), ("already-unfiled", 0));

            /* Nothing outside folders / folder_bindings moved. */
            assert_eq!(counts(&mut conn).await, before);
            let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders").fetch_one(&mut conn).await.unwrap();
            assert_eq!(folders, 2);
            assert_eq!(identity(&mut conn).await, "");
        });
    }

    #[test]
    fn admitted_operations_pass_the_enabled_f16_guard_only_through_the_command() {
        tauri::async_runtime::block_on(async {
            let mut conn = migrated(23).await;
            seed_chat(&mut conn, "chat-a", 0).await;
            sqlx::query("UPDATE f16_folder_bindings_trigger_guard SET enabled = 1, reason = 'proof-on' WHERE id = 1")
                .execute(&mut conn)
                .await
                .unwrap();
            run_relationship_apply(&mut conn, &request(KIND_CREATE_FOLDER, Some("f_study"), Some("Study"), None), 1_000).await;

            /* Direct write on the same connection, identity cleared: refused. */
            assert!(sqlx::query("INSERT INTO folder_bindings (chat_id, folder_id, assigned_at) VALUES ('chat-a', 'f_study', 1)")
                .execute(&mut conn)
                .await
                .is_err());

            let bound = run_relationship_apply(&mut conn, &request(KIND_BIND_CHAT, Some("f_study"), None, Some("chat-a")), 2_000).await;
            assert!(bound.ok, "{bound:?}");
            assert_eq!(binding(&mut conn, "chat-a").await, Some(("f_study".into(), 2_000)));
            let unfiled = run_relationship_apply(&mut conn, &request(KIND_UNBIND_CHAT, None, None, Some("chat-a")), 3_000).await;
            assert!(unfiled.ok, "{unfiled:?}");
            assert_eq!(binding(&mut conn, "chat-a").await, None);

            /* The identity is gone again afterwards: a direct delete of a
             * binding the command just created is refused by the guard. */
            assert_eq!(identity(&mut conn).await, "");
            let rebound = run_relationship_apply(&mut conn, &request(KIND_BIND_CHAT, Some("f_study"), None, Some("chat-a")), 4_000).await;
            assert!(rebound.ok, "{rebound:?}");
            assert!(sqlx::query("DELETE FROM folder_bindings WHERE chat_id = 'chat-a'")
                .execute(&mut conn)
                .await
                .is_err());
            assert!(sqlx::query("UPDATE folder_bindings SET folder_id = 'f_other' WHERE chat_id = 'chat-a'")
                .execute(&mut conn)
                .await
                .is_err());
            assert_eq!(binding(&mut conn, "chat-a").await, Some(("f_study".into(), 4_000)));
        });
    }

    #[test]
    fn refusals_are_typed_roll_back_and_clear_the_identity() {
        tauri::async_runtime::block_on(async {
            let mut conn = migrated(23).await;
            seed_chat(&mut conn, "chat-a", 0).await;
            seed_chat(&mut conn, "chat-gone", 1).await;
            sqlx::query("INSERT INTO folders (id, name, source, created_at, updated_at, meta_json) VALUES ('f_proj', 'Project', 'project_backed', 1, 1, '{\"kind\":\"project_backed\"}')")
                .execute(&mut conn)
                .await
                .unwrap();
            let before = counts(&mut conn).await;

            let cases: Vec<(P02RelationshipApplyRequest, &str)> = vec![
                (P02RelationshipApplyRequest { schema: "h2o.studio.p02RelationshipApplyRequest.v9".into(), ..request(KIND_CREATE_FOLDER, Some("f_a"), Some("A"), None) }, ERR_REQUEST_SCHEMA_INVALID),
                (request("delete-folder", Some("f_a"), None, None), ERR_KIND_INVALID),
                (request("bulk-rebind", Some("f_a"), None, None), ERR_KIND_INVALID),
                (request(KIND_CREATE_FOLDER, None, Some("A"), None), ERR_REQUEST_SHAPE_INVALID),
                (request(KIND_CREATE_FOLDER, Some("f_a"), None, None), ERR_REQUEST_SHAPE_INVALID),
                (request(KIND_CREATE_FOLDER, Some("f_a"), Some("A"), Some("chat-a")), ERR_REQUEST_SHAPE_INVALID),
                (request(KIND_UNBIND_CHAT, Some("f_a"), None, Some("chat-a")), ERR_REQUEST_SHAPE_INVALID),
                (request(KIND_BIND_CHAT, Some("f_a"), Some("A"), Some("chat-a")), ERR_REQUEST_SHAPE_INVALID),
                (request(KIND_CREATE_FOLDER, Some("f a"), Some("A"), None), ERR_FOLDER_ID_INVALID),
                (request(KIND_CREATE_FOLDER, Some("f_a"), Some(" A"), None), ERR_FOLDER_NAME_INVALID),
                (request(KIND_CREATE_FOLDER, Some("f_a"), Some(""), None), ERR_FOLDER_NAME_INVALID),
                (request(KIND_BIND_CHAT, Some("f_a"), None, Some(" chat")), ERR_CHAT_ID_INVALID),
                (request(KIND_CREATE_FOLDER, Some("f_proj"), Some("Again"), None), ERR_FOLDER_EXISTS),
                (request(KIND_RENAME_FOLDER, Some("f_missing"), Some("New"), None), ERR_FOLDER_MISSING),
                (request(KIND_RENAME_FOLDER, Some("f_proj"), Some("New"), None), ERR_FOLDER_NOT_ELIGIBLE),
                (request(KIND_BIND_CHAT, Some("f_missing"), None, Some("chat-a")), ERR_FOLDER_MISSING),
                (request(KIND_BIND_CHAT, Some("f_proj"), None, Some("chat-a")), ERR_FOLDER_NOT_ELIGIBLE),
                (request(KIND_BIND_CHAT, Some("f_proj"), None, Some("chat-missing")), ERR_CHAT_MISSING),
                (request(KIND_BIND_CHAT, Some("f_proj"), None, Some("chat-gone")), ERR_CHAT_MISSING),
                (request(KIND_UNBIND_CHAT, None, None, Some("chat-missing")), ERR_CHAT_MISSING),
            ];
            for (refused_request, expected) in cases {
                let result = run_relationship_apply(&mut conn, &refused_request, 9_000).await;
                assert!(!result.ok && !result.applied, "{refused_request:?}");
                assert_eq!(result.error_code.as_deref(), Some(expected), "{refused_request:?}");
                assert_eq!(result.outcome, "refused");
                assert_eq!(identity(&mut conn).await, "", "identity cleared after {expected}");
                /* No transaction is left open: a fresh BEGIN succeeds. */
                control(&mut conn, "BEGIN").await.expect("no dangling transaction");
                control(&mut conn, "ROLLBACK").await.unwrap();
            }
            assert_eq!(counts(&mut conn).await, before);
            let folders: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folders").fetch_one(&mut conn).await.unwrap();
            assert_eq!(folders, 1);
            assert_eq!(folder(&mut conn, "f_proj").await.map(|row| row.0), Some("Project".into()));
            let bindings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM folder_bindings").fetch_one(&mut conn).await.unwrap();
            assert_eq!(bindings, 0);
        });
    }

    #[test]
    fn request_dto_admits_no_sql_table_or_column_input() {
        for extra in [
            r#"{"schema":"h2o.studio.p02RelationshipApplyRequest.v1","kind":"create-folder","folderId":"f_a","name":"A","sql":"DELETE FROM folders"}"#,
            r#"{"schema":"h2o.studio.p02RelationshipApplyRequest.v1","kind":"create-folder","folderId":"f_a","name":"A","table":"chats"}"#,
            r#"{"schema":"h2o.studio.p02RelationshipApplyRequest.v1","kind":"create-folder","folderId":"f_a","name":"A","columns":["color"]}"#,
            r##"{"schema":"h2o.studio.p02RelationshipApplyRequest.v1","kind":"create-folder","folderId":"f_a","name":"A","color":"#ff0000"}"##,
            r#"{"schema":"h2o.studio.p02RelationshipApplyRequest.v1","kind":"create-folder","folderId":"f_a","name":"A","identity":"f15.debug-bypass"}"#,
            r#"{"schema":"h2o.studio.p02RelationshipApplyRequest.v1","kind":"create-folder","folderId":"f_a","name":"A","statements":[]}"#,
        ] {
            assert!(serde_json::from_str::<P02RelationshipApplyRequest>(extra).is_err(), "{extra}");
        }
        let admitted: P02RelationshipApplyRequest = serde_json::from_str(
            r#"{"schema":"h2o.studio.p02RelationshipApplyRequest.v1","kind":"bind-chat","chatId":"chat-a","folderId":"f_a"}"#,
        )
        .unwrap();
        assert_eq!(
            validate_request(&admitted).unwrap(),
            AdmittedOperation::BindChat { chat_id: "chat-a".into(), folder_id: "f_a".into() }
        );
        assert_eq!(
            validate_request(&serde_json::from_str::<P02RelationshipApplyRequest>(
                r#"{"schema":"h2o.studio.p02RelationshipApplyRequest.v1","kind":"unbind-chat","chatId":"chat-a","folderId":null}"#
            ).unwrap())
            .unwrap(),
            AdmittedOperation::UnbindChat { chat_id: "chat-a".into() }
        );
    }

    /// The module's own SQL inventory is the contract allowlist and nothing
    /// more. Every string literal in the production half of this file is
    /// inspected, so a future edit cannot add a write statement, a forbidden
    /// table or a formatted (non-fixed) statement without failing here.
    #[test]
    fn fixed_statement_inventory_matches_the_writer_authority_contract() {
        let source = include_str!("p02_relationship_apply.rs");
        let production = &source[..source.find("#[cfg(test)]").expect("test marker")];
        let literals: Vec<&str> = production
            .split('"')
            .enumerate()
            .filter(|(index, _)| index % 2 == 1)
            .map(|(_, literal)| literal)
            .collect();
        let sql: Vec<&str> = literals
            .iter()
            .copied()
            .filter(|literal| {
                let upper = literal.trim_start().to_ascii_uppercase();
                ["SELECT ", "INSERT ", "UPDATE ", "DELETE ", "BEGIN", "COMMIT", "ROLLBACK"]
                    .iter()
                    .any(|verb| upper.starts_with(verb))
            })
            .collect();
        let expected = [
            "SELECT source FROM folders WHERE id = ? LIMIT 1",
            "SELECT is_deleted FROM chats WHERE id = ? LIMIT 1",
            "SELECT 1 FROM folders WHERE id = ? LIMIT 1",
            "INSERT INTO folders (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            "UPDATE folders SET name = ?, updated_at = ? WHERE id = ?",
            "INSERT OR REPLACE INTO folder_bindings (chat_id, folder_id, assigned_at) VALUES (?, ?, ?)",
            "DELETE FROM folder_bindings WHERE chat_id = ?",
            "ROLLBACK",
            "BEGIN IMMEDIATE",
            "COMMIT",
        ];
        let mut observed = sql.clone();
        observed.sort_unstable();
        let mut wanted = expected.to_vec();
        wanted.sort_unstable();
        assert_eq!(observed, wanted, "fixed statement inventory drifted");
        assert!(!production.contains("format!(\"SELECT")
            && !production.contains("format!(\"INSERT")
            && !production.contains("format!(\"UPDATE")
            && !production.contains("format!(\"DELETE"));
        for forbidden in [
            "sync_object_state", "sync_tombstones", "sync_tombstone_reviews", "sync_conflicts",
            "kv_store", "category_id", "label_bindings", "tag_bindings", "snapshots",
            "f15.debug-bypass", "f15.emergency-repair",
        ] {
            assert!(!literals.iter().any(|literal| literal.contains(forbidden)), "forbidden fragment: {forbidden}");
        }
    }
}
