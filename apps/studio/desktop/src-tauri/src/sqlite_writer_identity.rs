use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{Connection, SqliteConnection};
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_void};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

const DB_URL: &str = "sqlite:studio-v1.db";
const FUNCTION_NAME: &str = "h2o_writer_identity";
const SETTLEMENT_IDENTITY: &str = "f15.execute-settlement-writer";
const BULK_MIGRATION_IDENTITY: &str = "f15.bulk-migration";
const FOLDER_LEGACY_FALLBACK_IDENTITY: &str = "f16.folder-legacy-fallback";
const DEBUG_BYPASS_IDENTITY: &str = "f15.debug-bypass";
const EMERGENCY_REPAIR_IDENTITY: &str = "f15.emergency-repair";
const DEBUG_BYPASS_TOKEN: &str = "I_UNDERSTAND_F15_DEBUG_BYPASS";
const EMERGENCY_REPAIR_TOKEN: &str = "I_UNDERSTAND_F15_EMERGENCY_REPAIR";
const FOLDER_BINDINGS_TRIGGER_TOKEN: &str = "I_UNDERSTAND_F16_FOLDER_BINDINGS_TRIGGER_PROTECTION";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct F15AuthorizedSqlStatement {
    pub query: String,
    #[serde(default)]
    pub values: Vec<JsonValue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct F15AuthorizedSqlPayload {
    pub identity: String,
    #[serde(default)]
    pub statements: Vec<F15AuthorizedSqlStatement>,
    #[serde(default)]
    pub bulk_migration_enabled: bool,
    #[serde(default)]
    pub folder_legacy_fallback_enabled: bool,
    #[serde(default)]
    pub debug_bypass_token: Option<String>,
    #[serde(default)]
    pub emergency_repair_token: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct F16FolderBindingsTriggerPayload {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub activation_token: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct F15AuthorizedSqlResult {
    pub ok: bool,
    pub executed: bool,
    pub identity: String,
    pub statement_count: usize,
    pub rows_affected: u64,
    pub sqlite_sentinel_used: bool,
    pub audit_warning: Option<String>,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
}

impl F15AuthorizedSqlResult {
    fn blocked(identity: &str, code: &str) -> Self {
        Self {
            ok: false,
            executed: false,
            identity: identity.to_string(),
            statement_count: 0,
            rows_affected: 0,
            sqlite_sentinel_used: false,
            audit_warning: None,
            blockers: vec![code.to_string()],
            warnings: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct F15SentinelProofResult {
    pub ok: bool,
    pub unauthorized_before_blocked: bool,
    pub authorized_write_passed: bool,
    pub unauthorized_after_clear_blocked: bool,
    pub unregistered_connection_failed_closed: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct F16FolderBindingsTriggerResult {
    pub ok: bool,
    pub enabled: bool,
    pub trigger_guarded: bool,
    pub trigger_installed: bool,
    pub activation_explicit: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct F16FolderBindingsTriggerProofResult {
    pub ok: bool,
    pub trigger_mode_off_legacy_write_passed: bool,
    pub unauthorized_insert_blocked: bool,
    pub unauthorized_update_blocked: bool,
    pub unauthorized_delete_blocked: bool,
    pub settlement_identity_write_passed: bool,
    pub legacy_fallback_identity_bind_passed: bool,
    pub legacy_fallback_identity_unbind_passed: bool,
    /* P02 T01 successor assertions (writer-authority contract, AC04). */
    pub p02_relationship_apply_identity_bind_passed: bool,
    pub p02_relationship_apply_identity_move_passed: bool,
    pub p02_relationship_apply_identity_unbind_passed: bool,
    pub p02_relationship_apply_lookalike_identity_blocked: bool,
    pub p02_relationship_apply_identity_cleared_blocked: bool,
    pub trigger_guarded: bool,
    pub trigger_default_enabled: bool,
    pub blockers: Vec<String>,
    pub warnings: Vec<String>,
}

struct WriterIdentityState {
    value: CString,
}

unsafe extern "C" fn writer_identity_fn(
    ctx: *mut libsqlite3_sys::sqlite3_context,
    _argc: c_int,
    _argv: *mut *mut libsqlite3_sys::sqlite3_value,
) {
    let data = libsqlite3_sys::sqlite3_user_data(ctx) as *const WriterIdentityState;
    if data.is_null() {
        libsqlite3_sys::sqlite3_result_text(ctx, b"\0".as_ptr() as *const i8, 0, libsqlite3_sys::SQLITE_TRANSIENT());
        return;
    }
    let state = &*data;
    libsqlite3_sys::sqlite3_result_text(
        ctx,
        state.value.as_ptr(),
        -1,
        libsqlite3_sys::SQLITE_TRANSIENT(),
    );
}

unsafe extern "C" fn drop_writer_identity_state(ptr: *mut c_void) {
    if !ptr.is_null() {
        let _ = Box::from_raw(ptr as *mut WriterIdentityState);
    }
}

unsafe fn register_writer_identity_function_on_raw(
    raw_handle: *mut libsqlite3_sys::sqlite3,
    identity: &str,
) -> Result<(), c_int> {
    if raw_handle.is_null() {
        return Err(libsqlite3_sys::SQLITE_MISUSE);
    }
    let function_name = CString::new(FUNCTION_NAME).map_err(|_| libsqlite3_sys::SQLITE_MISUSE)?;
    let state = Box::new(WriterIdentityState {
        value: CString::new(identity).map_err(|_| libsqlite3_sys::SQLITE_MISUSE)?,
    });
    let state_ptr = Box::into_raw(state) as *mut c_void;
    let rc = libsqlite3_sys::sqlite3_create_function_v2(
        raw_handle,
        function_name.as_ptr(),
        0,
        libsqlite3_sys::SQLITE_UTF8 | libsqlite3_sys::SQLITE_DETERMINISTIC,
        state_ptr,
        Some(writer_identity_fn),
        None,
        None,
        Some(drop_writer_identity_state),
    );
    if rc != libsqlite3_sys::SQLITE_OK {
        let _ = Box::from_raw(state_ptr as *mut WriterIdentityState);
        return Err(rc);
    }
    Ok(())
}

unsafe extern "C" fn writer_identity_auto_extension(
    db: *mut libsqlite3_sys::sqlite3,
    _pz_err_msg: *mut *mut c_char,
    _api: *const libsqlite3_sys::sqlite3_api_routines,
) -> c_int {
    match register_writer_identity_function_on_raw(db, "") {
        Ok(()) => libsqlite3_sys::SQLITE_OK,
        Err(rc) => rc,
    }
}

pub fn install_writer_identity_auto_extension() -> Result<(), String> {
    let rc =
        unsafe { libsqlite3_sys::sqlite3_auto_extension(Some(writer_identity_auto_extension)) };
    if rc != libsqlite3_sys::SQLITE_OK {
        return Err(format!("sqlite-writer-identity-auto-extension-failed:{rc}"));
    }
    Ok(())
}

pub async fn install_writer_identity_function(
    conn: &mut SqliteConnection,
    identity: &str,
) -> Result<(), String> {
    let mut handle = conn
        .lock_handle()
        .await
        .map_err(|e| format!("sqlite-writer-identity-lock-failed:{e}"))?;
    unsafe { register_writer_identity_function_on_raw(handle.as_raw_handle().as_ptr(), identity) }
        .map_err(|rc| format!("sqlite-writer-identity-register-failed:{rc}"))
}

fn validate_identity(payload: &F15AuthorizedSqlPayload) -> Result<Option<String>, String> {
    match payload.identity.as_str() {
        SETTLEMENT_IDENTITY => Ok(None),
        BULK_MIGRATION_IDENTITY => {
            if payload.bulk_migration_enabled {
                Ok(Some("f15-bulk-migration-explicitly-enabled".to_string()))
            } else {
                Err("sqlite-writer-identity-bulk-migration-not-enabled".to_string())
            }
        }
        FOLDER_LEGACY_FALLBACK_IDENTITY => {
            if payload.folder_legacy_fallback_enabled {
                Ok(Some("f16-folder-legacy-fallback-explicitly-enabled".to_string()))
            } else {
                Err("sqlite-writer-identity-folder-legacy-fallback-not-enabled".to_string())
            }
        }
        DEBUG_BYPASS_IDENTITY => {
            if payload.debug_bypass_token.as_deref() == Some(DEBUG_BYPASS_TOKEN) {
                Ok(Some("f15-debug-bypass-used".to_string()))
            } else {
                Err("sqlite-writer-identity-debug-bypass-not-enabled".to_string())
            }
        }
        EMERGENCY_REPAIR_IDENTITY => {
            if payload.emergency_repair_token.as_deref() == Some(EMERGENCY_REPAIR_TOKEN) {
                Ok(Some("f15-emergency-repair-used".to_string()))
            } else {
                Err("sqlite-writer-identity-emergency-repair-not-enabled".to_string())
            }
        }
        _ => Err("sqlite-writer-identity-not-allowed".to_string()),
    }
}

async fn execute_statement(
    conn: &mut SqliteConnection,
    statement: &F15AuthorizedSqlStatement,
) -> Result<u64, String> {
    if statement.query.trim().is_empty() {
        return Err("sqlite-authorized-query-empty".to_string());
    }
    let mut query = sqlx::query(&statement.query);
    for value in &statement.values {
        if value.is_null() {
            query = query.bind(None::<String>);
        } else if let Some(s) = value.as_str() {
            query = query.bind(s.to_string());
        } else if let Some(i) = value.as_i64() {
            query = query.bind(i);
        } else if let Some(u) = value.as_u64() {
            if u <= i64::MAX as u64 {
                query = query.bind(u as i64);
            } else {
                query = query.bind(u.to_string());
            }
        } else if let Some(f) = value.as_f64() {
            query = query.bind(f);
        } else if let Some(b) = value.as_bool() {
            query = query.bind(if b { 1_i64 } else { 0_i64 });
        } else {
            query = query.bind(value.to_string());
        }
    }
    let result = query
        .execute(conn)
        .await
        .map_err(|e| format!("sqlite-authorized-query-failed:{e}"))?;
    Ok(result.rows_affected())
}

async fn execute_control_sql(conn: &mut SqliteConnection, sql: &str, code: &str) -> Result<(), String> {
    sqlx::query(sql)
        .execute(conn)
        .await
        .map(|_| ())
        .map_err(|e| format!("{code}:{e}"))
}

/* F16.4.c infrastructure. The allowlist is the v23 SUCCESSOR allowlist (P02
 * T01, writer-authority contract §8): f15.execute-settlement-writer,
 * f16.folder-legacy-fallback and p02.relationship-apply. The last one is
 * admitted by the trigger only; it is NOT an identity that
 * f15_authorized_sqlite_execute will ever install - see validate_identity. */
async fn install_folder_bindings_trigger_infrastructure(
    conn: &mut SqliteConnection,
) -> Result<(), String> {
    let statements = [
        r#"
        CREATE TABLE IF NOT EXISTS f16_folder_bindings_trigger_guard (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          updated_at TEXT,
          reason     TEXT NOT NULL DEFAULT ''
        )
        "#,
        r#"
        INSERT OR IGNORE INTO f16_folder_bindings_trigger_guard(id, enabled, updated_at, reason)
        VALUES (1, 0, NULL, 'f16.4.c-default-off')
        "#,
        r#"
        CREATE TRIGGER IF NOT EXISTS f16_protect_folder_bindings_insert
        BEFORE INSERT ON folder_bindings
        WHEN (SELECT COALESCE(enabled, 0) FROM f16_folder_bindings_trigger_guard WHERE id = 1) = 1
        BEGIN
          SELECT CASE
            WHEN COALESCE(h2o_writer_identity(), '') NOT IN (
              'f15.execute-settlement-writer',
              'f16.folder-legacy-fallback',
              'p02.relationship-apply'
            )
            THEN RAISE(ABORT, 'f16-folder-bindings-write-protected:insert')
          END;
        END
        "#,
        r#"
        CREATE TRIGGER IF NOT EXISTS f16_protect_folder_bindings_update
        BEFORE UPDATE ON folder_bindings
        WHEN (SELECT COALESCE(enabled, 0) FROM f16_folder_bindings_trigger_guard WHERE id = 1) = 1
        BEGIN
          SELECT CASE
            WHEN COALESCE(h2o_writer_identity(), '') NOT IN (
              'f15.execute-settlement-writer',
              'f16.folder-legacy-fallback',
              'p02.relationship-apply'
            )
            THEN RAISE(ABORT, 'f16-folder-bindings-write-protected:update')
          END;
        END
        "#,
        r#"
        CREATE TRIGGER IF NOT EXISTS f16_protect_folder_bindings_delete
        BEFORE DELETE ON folder_bindings
        WHEN (SELECT COALESCE(enabled, 0) FROM f16_folder_bindings_trigger_guard WHERE id = 1) = 1
        BEGIN
          SELECT CASE
            WHEN COALESCE(h2o_writer_identity(), '') NOT IN (
              'f15.execute-settlement-writer',
              'f16.folder-legacy-fallback',
              'p02.relationship-apply'
            )
            THEN RAISE(ABORT, 'f16-folder-bindings-write-protected:delete')
          END;
        END
        "#,
    ];
    for statement in statements {
        execute_control_sql(
            conn,
            statement,
            "sqlite-folder-bindings-trigger-install-failed",
        )
        .await?;
    }
    Ok(())
}

async fn set_folder_bindings_trigger_guard(
    conn: &mut SqliteConnection,
    enabled: bool,
    reason: &str,
) -> Result<(), String> {
    sqlx::query(
        r#"
        UPDATE f16_folder_bindings_trigger_guard
        SET enabled = ?, updated_at = datetime('now'), reason = ?
        WHERE id = 1
        "#,
    )
    .bind(if enabled { 1_i64 } else { 0_i64 })
    .bind(reason)
    .execute(conn)
    .await
    .map(|_| ())
    .map_err(|e| format!("sqlite-folder-bindings-trigger-guard-update-failed:{e}"))
}

async fn acquire_studio_sqlite_pool(
    db_instances: &State<'_, DbInstances>,
) -> Result<sqlx::Pool<sqlx::Sqlite>, String> {
    let instances = db_instances.0.read().await;
    let Some(db) = instances.get(DB_URL) else {
        return Err("sqlite-db-unavailable".to_string());
    };
    match db {
        DbPool::Sqlite(pool) => Ok(pool.clone()),
        #[allow(unreachable_patterns)]
        _ => Err("sqlite-db-unavailable".to_string()),
    }
}

#[tauri::command]
pub async fn f15_authorized_sqlite_execute(
    db_instances: State<'_, DbInstances>,
    payload: F15AuthorizedSqlPayload,
) -> Result<F15AuthorizedSqlResult, String> {
    let identity = payload.identity.trim().to_string();
    let audit_warning = match validate_identity(&payload) {
        Ok(warning) => warning,
        Err(code) => return Ok(F15AuthorizedSqlResult::blocked(&identity, &code)),
    };
    if payload.statements.is_empty() {
        return Ok(F15AuthorizedSqlResult::blocked(
            &identity,
            "sqlite-authorized-statements-required",
        ));
    }

    let pool = match acquire_studio_sqlite_pool(&db_instances).await {
        Ok(pool) => pool,
        Err(code) => return Ok(F15AuthorizedSqlResult::blocked(&identity, &code)),
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(e) => {
            return Ok(F15AuthorizedSqlResult::blocked(
                &identity,
                &format!("sqlite-db-acquire-failed:{e}"),
            ));
        }
    };

    if let Err(code) = install_writer_identity_function(&mut *conn, &identity).await {
        return Ok(F15AuthorizedSqlResult::blocked(&identity, &code));
    }

    let mut rows_affected = 0_u64;
    if let Err(code) = execute_control_sql(&mut *conn, "BEGIN IMMEDIATE", "sqlite-authorized-transaction-begin-failed").await {
        let _ = install_writer_identity_function(&mut *conn, "").await;
        return Ok(F15AuthorizedSqlResult::blocked(
            &identity,
            &code,
        ));
    }

    for statement in &payload.statements {
        match execute_statement(&mut *conn, statement).await {
            Ok(rows) => rows_affected += rows,
            Err(code) => {
                let _ = install_writer_identity_function(&mut *conn, "").await;
                let _ = execute_control_sql(&mut *conn, "ROLLBACK", "sqlite-authorized-transaction-rollback-failed").await;
                return Ok(F15AuthorizedSqlResult::blocked(&identity, &code));
            }
        }
    }

    if let Err(code) = install_writer_identity_function(&mut *conn, "").await {
        let _ = execute_control_sql(&mut *conn, "ROLLBACK", "sqlite-authorized-transaction-rollback-failed").await;
        return Ok(F15AuthorizedSqlResult::blocked(&identity, &code));
    }

    if let Err(code) = execute_control_sql(&mut *conn, "COMMIT", "sqlite-authorized-transaction-commit-failed").await {
        let _ = execute_control_sql(&mut *conn, "ROLLBACK", "sqlite-authorized-transaction-rollback-failed").await;
        return Ok(F15AuthorizedSqlResult::blocked(
            &identity,
            &code,
        ));
    }

    Ok(F15AuthorizedSqlResult {
        ok: true,
        executed: true,
        identity,
        statement_count: payload.statements.len(),
        rows_affected,
        sqlite_sentinel_used: true,
        audit_warning,
        blockers: Vec::new(),
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub async fn f16_configure_folder_bindings_trigger_protection(
    db_instances: State<'_, DbInstances>,
    payload: F16FolderBindingsTriggerPayload,
) -> Result<F16FolderBindingsTriggerResult, String> {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let activation_explicit = payload.activation_token.as_deref() == Some(FOLDER_BINDINGS_TRIGGER_TOKEN);
    if payload.enabled && !activation_explicit {
        return Ok(F16FolderBindingsTriggerResult {
            ok: false,
            enabled: false,
            trigger_guarded: true,
            trigger_installed: false,
            activation_explicit: false,
            blockers: vec!["sqlite-folder-bindings-trigger-activation-token-required".to_string()],
            warnings,
        });
    }

    let pool = match acquire_studio_sqlite_pool(&db_instances).await {
        Ok(pool) => pool,
        Err(code) => {
            blockers.push(code);
            return Ok(F16FolderBindingsTriggerResult {
                ok: false,
                enabled: false,
                trigger_guarded: true,
                trigger_installed: false,
                activation_explicit,
                blockers,
                warnings,
            });
        }
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(e) => {
            blockers.push(format!("sqlite-db-acquire-failed:{e}"));
            return Ok(F16FolderBindingsTriggerResult {
                ok: false,
                enabled: false,
                trigger_guarded: true,
                trigger_installed: false,
                activation_explicit,
                blockers,
                warnings,
            });
        }
    };

    if let Err(code) = install_folder_bindings_trigger_infrastructure(&mut *conn).await {
        blockers.push(code);
        return Ok(F16FolderBindingsTriggerResult {
            ok: false,
            enabled: false,
            trigger_guarded: true,
            trigger_installed: false,
            activation_explicit,
            blockers,
            warnings,
        });
    }

    let reason = payload
        .reason
        .as_deref()
        .unwrap_or(if payload.enabled {
            "f16.4.c-explicit-enable"
        } else {
            "f16.4.c-explicit-disable"
        });
    if let Err(code) = set_folder_bindings_trigger_guard(&mut *conn, payload.enabled, reason).await {
        blockers.push(code);
    }
    if !payload.enabled {
        warnings.push("sqlite-folder-bindings-trigger-installed-disabled".to_string());
    }

    Ok(F16FolderBindingsTriggerResult {
        ok: blockers.is_empty(),
        enabled: payload.enabled && blockers.is_empty(),
        trigger_guarded: true,
        trigger_installed: blockers.is_empty(),
        activation_explicit,
        blockers,
        warnings,
    })
}

async fn probe_insert(conn: &mut SqliteConnection, id: &str) -> bool {
    sqlx::query("INSERT INTO protected_test(id, value) VALUES (?, ?)")
        .bind(id)
        .bind("value")
        .execute(conn)
        .await
        .is_ok()
}

async fn folder_binding_insert(conn: &mut SqliteConnection, chat_id: &str, folder_id: &str) -> bool {
    sqlx::query("INSERT INTO folder_bindings(chat_id, folder_id, assigned_at) VALUES (?, ?, ?)")
        .bind(chat_id)
        .bind(folder_id)
        .bind(1_i64)
        .execute(conn)
        .await
        .is_ok()
}

async fn folder_binding_update(conn: &mut SqliteConnection, chat_id: &str, folder_id: &str) -> bool {
    sqlx::query("UPDATE folder_bindings SET folder_id = ? WHERE chat_id = ?")
        .bind(folder_id)
        .bind(chat_id)
        .execute(conn)
        .await
        .is_ok()
}

async fn folder_binding_delete(conn: &mut SqliteConnection, chat_id: &str) -> bool {
    sqlx::query("DELETE FROM folder_bindings WHERE chat_id = ?")
        .bind(chat_id)
        .execute(conn)
        .await
        .is_ok()
}

#[tauri::command]
pub async fn f15_prove_sqlite_writer_identity_sentinel() -> Result<F15SentinelProofResult, String> {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let mut conn = SqliteConnection::connect("sqlite::memory:")
        .await
        .map_err(|e| format!("sqlite-sentinel-proof-open-failed:{e}"))?;
    sqlx::query("CREATE TABLE protected_test(id TEXT PRIMARY KEY, value TEXT)")
        .execute(&mut conn)
        .await
        .map_err(|e| format!("sqlite-sentinel-proof-schema-failed:{e}"))?;
    sqlx::query(
        r#"
        CREATE TRIGGER f15_protect_test_insert
        BEFORE INSERT ON protected_test
        BEGIN
          SELECT CASE
            WHEN COALESCE(h2o_writer_identity(), '') != 'f15.execute-settlement-writer'
            THEN RAISE(ABORT, 'f15-store-write-protected:protected_test')
          END;
        END
        "#,
    )
    .execute(&mut conn)
    .await
    .map_err(|e| format!("sqlite-sentinel-proof-trigger-failed:{e}"))?;

    install_writer_identity_function(&mut conn, "").await?;
    let unauthorized_before_blocked = !probe_insert(&mut conn, "unauthorized-before").await;
    install_writer_identity_function(&mut conn, SETTLEMENT_IDENTITY).await?;
    let authorized_write_passed = probe_insert(&mut conn, "authorized").await;
    install_writer_identity_function(&mut conn, "").await?;
    let unauthorized_after_clear_blocked = !probe_insert(&mut conn, "unauthorized-after").await;

    let mut other = SqliteConnection::connect("sqlite::memory:")
        .await
        .map_err(|e| format!("sqlite-sentinel-proof-open-failed:{e}"))?;
    sqlx::query("CREATE TABLE protected_test(id TEXT PRIMARY KEY, value TEXT)")
        .execute(&mut other)
        .await
        .map_err(|e| format!("sqlite-sentinel-proof-schema-failed:{e}"))?;
    sqlx::query(
        r#"
        CREATE TRIGGER f15_protect_test_insert
        BEFORE INSERT ON protected_test
        BEGIN
          SELECT CASE
            WHEN COALESCE(h2o_writer_identity(), '') != 'f15.execute-settlement-writer'
            THEN RAISE(ABORT, 'f15-store-write-protected:protected_test')
          END;
        END
        "#,
    )
    .execute(&mut other)
    .await
    .map_err(|e| format!("sqlite-sentinel-proof-trigger-failed:{e}"))?;
    let unregistered_connection_failed_closed = !probe_insert(&mut other, "unregistered").await;

    if !unauthorized_before_blocked {
        blockers.push("sqlite-sentinel-proof-unauthorized-before-passed".to_string());
    }
    if !authorized_write_passed {
        blockers.push("sqlite-sentinel-proof-authorized-blocked".to_string());
    }
    if !unauthorized_after_clear_blocked {
        blockers.push("sqlite-sentinel-proof-unauthorized-after-passed".to_string());
    }
    if !unregistered_connection_failed_closed {
        blockers.push("sqlite-sentinel-proof-unregistered-passed".to_string());
    }
    if blockers.is_empty() {
        warnings.push("sqlite-sentinel-proof-in-memory-only".to_string());
    }

    Ok(F15SentinelProofResult {
        ok: blockers.is_empty(),
        unauthorized_before_blocked,
        authorized_write_passed,
        unauthorized_after_clear_blocked,
        unregistered_connection_failed_closed,
        blockers,
        warnings,
    })
}

#[tauri::command]
pub async fn f16_prove_folder_bindings_trigger_protection() -> Result<F16FolderBindingsTriggerProofResult, String> {
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let mut conn = SqliteConnection::connect("sqlite::memory:")
        .await
        .map_err(|e| format!("sqlite-folder-bindings-trigger-proof-open-failed:{e}"))?;
    sqlx::query(
        r#"
        CREATE TABLE folder_bindings (
          chat_id     TEXT PRIMARY KEY,
          folder_id   TEXT NOT NULL,
          assigned_at INTEGER
        )
        "#,
    )
    .execute(&mut conn)
    .await
    .map_err(|e| format!("sqlite-folder-bindings-trigger-proof-schema-failed:{e}"))?;
    install_folder_bindings_trigger_infrastructure(&mut conn).await?;

    install_writer_identity_function(&mut conn, "").await?;
    let trigger_mode_off_legacy_write_passed =
        folder_binding_insert(&mut conn, "proof-off", "folder-off").await;

    set_folder_bindings_trigger_guard(&mut conn, true, "f16.4.c-proof").await?;
    install_writer_identity_function(&mut conn, "").await?;
    let unauthorized_insert_blocked =
        !folder_binding_insert(&mut conn, "proof-unauthorized-insert", "folder-blocked").await;
    let unauthorized_update_blocked =
        !folder_binding_update(&mut conn, "proof-off", "folder-unauthorized-update").await;
    let unauthorized_delete_blocked = !folder_binding_delete(&mut conn, "proof-off").await;

    install_writer_identity_function(&mut conn, SETTLEMENT_IDENTITY).await?;
    let settlement_identity_write_passed =
        folder_binding_insert(&mut conn, "proof-settlement", "folder-settlement").await;

    install_writer_identity_function(&mut conn, FOLDER_LEGACY_FALLBACK_IDENTITY).await?;
    let legacy_fallback_identity_bind_passed =
        folder_binding_insert(&mut conn, "proof-fallback", "folder-fallback").await;
    let legacy_fallback_identity_unbind_passed =
        folder_binding_delete(&mut conn, "proof-fallback").await;

    /* P02 T01: the fixed-statement relationship identity is admitted for the
     * exact binding operations the command performs (bind, move, Unfile), a
     * look-alike identity is not, and clearing the identity closes the door
     * again. This proves the trigger allowlist, not the command itself. */
    install_writer_identity_function(
        &mut conn,
        crate::p02_relationship_apply::P02_RELATIONSHIP_APPLY_IDENTITY,
    )
    .await?;
    let p02_relationship_apply_identity_bind_passed =
        folder_binding_insert(&mut conn, "proof-p02", "folder-p02-a").await;
    let p02_relationship_apply_identity_move_passed =
        folder_binding_update(&mut conn, "proof-p02", "folder-p02-b").await;
    let p02_relationship_apply_identity_unbind_passed =
        folder_binding_delete(&mut conn, "proof-p02").await;
    install_writer_identity_function(&mut conn, "p02.relationship-apply-lookalike").await?;
    let p02_relationship_apply_lookalike_identity_blocked =
        !folder_binding_insert(&mut conn, "proof-p02-lookalike", "folder-p02-c").await;

    install_writer_identity_function(&mut conn, "").await?;
    let p02_relationship_apply_identity_cleared_blocked =
        !folder_binding_insert(&mut conn, "proof-p02-cleared", "folder-p02-d").await;

    if !trigger_mode_off_legacy_write_passed {
        blockers.push("folder-bindings-trigger-proof-default-off-blocked-legacy".to_string());
    }
    if !unauthorized_insert_blocked {
        blockers.push("folder-bindings-trigger-proof-unauthorized-insert-passed".to_string());
    }
    if !unauthorized_update_blocked {
        blockers.push("folder-bindings-trigger-proof-unauthorized-update-passed".to_string());
    }
    if !unauthorized_delete_blocked {
        blockers.push("folder-bindings-trigger-proof-unauthorized-delete-passed".to_string());
    }
    if !settlement_identity_write_passed {
        blockers.push("folder-bindings-trigger-proof-settlement-blocked".to_string());
    }
    if !legacy_fallback_identity_bind_passed {
        blockers.push("folder-bindings-trigger-proof-fallback-bind-blocked".to_string());
    }
    if !legacy_fallback_identity_unbind_passed {
        blockers.push("folder-bindings-trigger-proof-fallback-unbind-blocked".to_string());
    }
    if !p02_relationship_apply_identity_bind_passed {
        blockers.push("folder-bindings-trigger-proof-p02-relationship-apply-bind-blocked".to_string());
    }
    if !p02_relationship_apply_identity_move_passed {
        blockers.push("folder-bindings-trigger-proof-p02-relationship-apply-move-blocked".to_string());
    }
    if !p02_relationship_apply_identity_unbind_passed {
        blockers.push("folder-bindings-trigger-proof-p02-relationship-apply-unbind-blocked".to_string());
    }
    if !p02_relationship_apply_lookalike_identity_blocked {
        blockers.push("folder-bindings-trigger-proof-p02-relationship-apply-lookalike-passed".to_string());
    }
    if !p02_relationship_apply_identity_cleared_blocked {
        blockers.push("folder-bindings-trigger-proof-p02-relationship-apply-cleared-passed".to_string());
    }
    if blockers.is_empty() {
        warnings.push("folder-bindings-trigger-proof-in-memory-only".to_string());
    }

    Ok(F16FolderBindingsTriggerProofResult {
        ok: blockers.is_empty(),
        trigger_mode_off_legacy_write_passed,
        unauthorized_insert_blocked,
        unauthorized_update_blocked,
        unauthorized_delete_blocked,
        settlement_identity_write_passed,
        legacy_fallback_identity_bind_passed,
        legacy_fallback_identity_unbind_passed,
        p02_relationship_apply_identity_bind_passed,
        p02_relationship_apply_identity_move_passed,
        p02_relationship_apply_identity_unbind_passed,
        p02_relationship_apply_lookalike_identity_blocked,
        p02_relationship_apply_identity_cleared_blocked,
        trigger_guarded: true,
        trigger_default_enabled: false,
        blockers,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(identity: &str) -> F15AuthorizedSqlPayload {
        F15AuthorizedSqlPayload {
            identity: identity.to_string(),
            statements: Vec::new(),
            bulk_migration_enabled: false,
            folder_legacy_fallback_enabled: false,
            debug_bypass_token: None,
            emergency_repair_token: None,
            reason: None,
        }
    }

    #[test]
    fn writer_identity_sentinel_blocks_and_allows() {
        let result = tauri::async_runtime::block_on(f15_prove_sqlite_writer_identity_sentinel())
            .expect("sentinel proof should run");
        assert!(result.ok, "sentinel proof blockers: {:?}", result.blockers);
        assert!(result.unauthorized_before_blocked);
        assert!(result.authorized_write_passed);
        assert!(result.unauthorized_after_clear_blocked);
        assert!(result.unregistered_connection_failed_closed);
    }

    #[test]
    fn writer_identity_requires_explicit_bypass_enablement() {
        assert!(validate_identity(&payload(SETTLEMENT_IDENTITY)).unwrap().is_none());

        let mut bulk = payload(BULK_MIGRATION_IDENTITY);
        assert_eq!(
            validate_identity(&bulk).unwrap_err(),
            "sqlite-writer-identity-bulk-migration-not-enabled"
        );
        bulk.bulk_migration_enabled = true;
        assert_eq!(
            validate_identity(&bulk).unwrap().as_deref(),
            Some("f15-bulk-migration-explicitly-enabled")
        );

        let mut folder_fallback = payload(FOLDER_LEGACY_FALLBACK_IDENTITY);
        assert_eq!(
            validate_identity(&folder_fallback).unwrap_err(),
            "sqlite-writer-identity-folder-legacy-fallback-not-enabled"
        );
        folder_fallback.folder_legacy_fallback_enabled = true;
        assert_eq!(
            validate_identity(&folder_fallback).unwrap().as_deref(),
            Some("f16-folder-legacy-fallback-explicitly-enabled")
        );

        let mut debug = payload(DEBUG_BYPASS_IDENTITY);
        assert_eq!(
            validate_identity(&debug).unwrap_err(),
            "sqlite-writer-identity-debug-bypass-not-enabled"
        );
        debug.debug_bypass_token = Some(DEBUG_BYPASS_TOKEN.to_string());
        assert_eq!(
            validate_identity(&debug).unwrap().as_deref(),
            Some("f15-debug-bypass-used")
        );

        let mut emergency = payload(EMERGENCY_REPAIR_IDENTITY);
        assert_eq!(
            validate_identity(&emergency).unwrap_err(),
            "sqlite-writer-identity-emergency-repair-not-enabled"
        );
        emergency.emergency_repair_token = Some(EMERGENCY_REPAIR_TOKEN.to_string());
        assert_eq!(
            validate_identity(&emergency).unwrap().as_deref(),
            Some("f15-emergency-repair-used")
        );
    }

    /// P02 T01 writer-authority contract §1: generic caller-supplied SQL under
    /// p02.relationship-apply is refused with the generic typed error, and no
    /// flag or token changes that. The identity lives only inside the
    /// fixed-statement command (p02_relationship_apply.rs).
    #[test]
    fn writer_identity_rejects_p02_relationship_apply_generically() {
        let identity = crate::p02_relationship_apply::P02_RELATIONSHIP_APPLY_IDENTITY;
        assert_eq!(identity, "p02.relationship-apply");

        let mut generic = payload(identity);
        generic.statements = vec![F15AuthorizedSqlStatement {
            query: "INSERT INTO folder_bindings (chat_id, folder_id, assigned_at) VALUES (?, ?, ?)"
                .to_string(),
            values: vec![
                serde_json::json!("chat-a"),
                serde_json::json!("f_a"),
                serde_json::json!(1),
            ],
        }];
        assert_eq!(
            validate_identity(&generic).unwrap_err(),
            "sqlite-writer-identity-not-allowed"
        );

        let mut everything_enabled = payload(identity);
        everything_enabled.statements = vec![F15AuthorizedSqlStatement {
            query: "DELETE FROM folders WHERE id = ?".to_string(),
            values: vec![serde_json::json!("f_a")],
        }];
        everything_enabled.bulk_migration_enabled = true;
        everything_enabled.folder_legacy_fallback_enabled = true;
        everything_enabled.debug_bypass_token = Some(DEBUG_BYPASS_TOKEN.to_string());
        everything_enabled.emergency_repair_token = Some(EMERGENCY_REPAIR_TOKEN.to_string());
        everything_enabled.reason = Some("p02 relationship apply".to_string());
        assert_eq!(
            validate_identity(&everything_enabled).unwrap_err(),
            "sqlite-writer-identity-not-allowed"
        );

        /* Whitespace/case look-alikes are not the identity either. */
        for lookalike in [" p02.relationship-apply", "P02.RELATIONSHIP-APPLY", "p02.relationship-apply\n"] {
            assert_eq!(
                validate_identity(&payload(lookalike)).unwrap_err(),
                "sqlite-writer-identity-not-allowed",
                "{lookalike:?}"
            );
        }
    }

    /// The F16 proof command carries the P02 successor assertions.
    #[test]
    fn folder_bindings_trigger_proof_admits_p02_relationship_apply_only_by_identity() {
        let result = tauri::async_runtime::block_on(f16_prove_folder_bindings_trigger_protection())
            .expect("folder bindings trigger proof should run");
        assert!(result.ok, "proof blockers: {:?}", result.blockers);
        assert!(result.trigger_mode_off_legacy_write_passed);
        assert!(result.unauthorized_insert_blocked);
        assert!(result.unauthorized_update_blocked);
        assert!(result.unauthorized_delete_blocked);
        assert!(result.settlement_identity_write_passed);
        assert!(result.legacy_fallback_identity_bind_passed);
        assert!(result.legacy_fallback_identity_unbind_passed);
        assert!(result.p02_relationship_apply_identity_bind_passed);
        assert!(result.p02_relationship_apply_identity_move_passed);
        assert!(result.p02_relationship_apply_identity_unbind_passed);
        assert!(result.p02_relationship_apply_lookalike_identity_blocked);
        assert!(result.p02_relationship_apply_identity_cleared_blocked);
        assert!(!result.trigger_default_enabled);
    }
}
