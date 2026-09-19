//! Saved-Chat asset restoration T02 — purpose-bounded native recovery
//! transaction for asset-bearing Recover as New.
//!
//! The renderer-side store adapters have no transaction spanning the recovered
//! chat, the recovered snapshot and its turns, the asset registry rows and the
//! `snapshot_turn_assets` links, and the SQL plugin's pool is not connection-
//! affine across separate `plugin:sql|execute` calls. This module therefore
//! owns exactly ONE connection-affine SQLite transaction for that write set
//! (accepted contract §10), reached the same way the other purpose-bounded
//! native transactions are reached (`apply_folder_metadata_color`,
//! `synthetic_cleanup_commit`): the command wrapper in `lib.rs` resolves the
//! Desktop pool, acquires one connection and hands it to [`run_commit`], which
//! begins, executes every statement on that connection and commits once or
//! rolls everything back.
//!
//! Authority boundaries (contract §10.1):
//!   - closed input schema (`deny_unknown_fields`); no SQL text and no table,
//!     column or predicate is ever accepted from the renderer;
//!   - insert-only: it never UPDATEs or DELETEs an existing chat, snapshot,
//!     turn, link or registry row (the only UPDATE is the authoritative
//!     refcount recompute of the assets the new links reference, which is the
//!     registry's existing refcount rule);
//!   - no overwrite / relink / restore-original-identity mode exists;
//!   - fresh identities only: the recovered chat id (minted renderer-side by the
//!     existing importer generator) is asserted absent inside the transaction,
//!     the recovered snapshot id is minted HERE from OS entropy and asserted
//!     absent, and neither may equal the package's original identities;
//!   - existing registry rows keep their presentation metadata; a byte-size
//!     contradiction with the verified CAS object is a refusal, not a repair;
//!   - it touches no file: destination CAS objects are verified by the caller
//!     BEFORE this command is invoked (CAS-first ordering, contract §7).
//!
//! Every failure before the commit point rolls the whole mutation back and is
//! reported as a closed `{ stage, code }` pair; sqlx errors never propagate as
//! authority to the renderer.

use serde::{Deserialize, Serialize};
use sqlx::{Connection, SqliteConnection};
use std::collections::{BTreeMap, BTreeSet};

pub const RECOVERY_COMMIT_SCHEMA: &str = "h2o.savedChatAssetRecoveryCommit.v1";

const MAX_ID_LEN: usize = 128;
const MAX_TITLE_LEN: usize = 4096;
const MAX_TURNS: usize = 20_000;
const MAX_ASSETS: usize = 4_096;
const MAX_LINKS: usize = 65_536;
const MAX_META_JSON_LEN: usize = 4 * 1024 * 1024;
const MAX_DETAIL_LEN: usize = 512;
const SNAPSHOT_ID_MINT_ATTEMPTS: usize = 5;

// ── closed input schema ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryChatInput {
    pub title: String,
    pub is_saved: bool,
    pub is_linked: bool,
    pub message_count: i64,
    pub user_turn_count: i64,
    pub assistant_turn_count: i64,
    #[serde(default)]
    pub last_message_at: i64,
    pub meta_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoverySnapshotInput {
    pub title: String,
    pub message_count: i64,
    pub meta_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryTurnInput {
    pub turn_idx: i64,
    pub role: String,
    pub text: String,
    pub outer_html: String,
    pub meta_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryAssetInput {
    pub sha256: String,
    pub mime_type: String,
    pub ext: String,
    pub byte_size: i64,
    pub meta_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryLinkInput {
    pub turn_idx: i64,
    pub sha256: String,
    pub relation: String,
    pub meta_json: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetRecoveryCommitPayload {
    pub schema: String,
    pub recovered_chat_id: String,
    pub original_chat_id: String,
    pub original_snapshot_id: String,
    pub chat: RecoveryChatInput,
    pub snapshot: RecoverySnapshotInput,
    pub turns: Vec<RecoveryTurnInput>,
    pub assets: Vec<RecoveryAssetInput>,
    pub links: Vec<RecoveryLinkInput>,
}

// ── closed result ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRecoveryCounts {
    pub turns: i64,
    pub assets_inserted: i64,
    pub assets_existing: i64,
    pub links: i64,
    pub refcounts_recomputed: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRecoveryCommitResult {
    pub schema: &'static str,
    pub ok: bool,
    pub committed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_chat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_snapshot_id: Option<String>,
    pub counts: AssetRecoveryCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AssetRecoveryCommitResult {
    pub fn refused(stage: &'static str, code: &str) -> Self {
        Self::refused_with_detail(stage, code, None)
    }

    pub fn refused_with_detail(stage: &'static str, code: &str, detail: Option<String>) -> Self {
        Self {
            schema: RECOVERY_COMMIT_SCHEMA,
            ok: false,
            committed: false,
            recovered_chat_id: None,
            recovered_snapshot_id: None,
            counts: AssetRecoveryCounts::default(),
            stage: Some(stage),
            code: Some(code.to_string()),
            detail: detail.map(bound_detail),
        }
    }

    fn committed(chat_id: String, snapshot_id: String, counts: AssetRecoveryCounts) -> Self {
        Self {
            schema: RECOVERY_COMMIT_SCHEMA,
            ok: true,
            committed: true,
            recovered_chat_id: Some(chat_id),
            recovered_snapshot_id: Some(snapshot_id),
            counts,
            stage: None,
            code: None,
            detail: None,
        }
    }
}

fn bound_detail(detail: String) -> String {
    if detail.len() <= MAX_DETAIL_LEN {
        return detail;
    }
    let mut end = MAX_DETAIL_LEN;
    while end > 0 && !detail.is_char_boundary(end) {
        end -= 1;
    }
    detail[..end].to_string()
}

/// Test-only failure injection: each variant makes exactly one in-transaction
/// step fail so the harness can prove that the whole destination mutation rolls
/// back from that point. Never reachable from the renderer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryFailure {
    RegistryEnsure,
    ChatInsert,
    SnapshotInsert,
    TurnInsert,
    LinkInsert,
    Refcount,
    Commit,
}

// ── validation (stage: validate) ────────────────────────────────────────────

fn is_clean_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_LEN
        && value.trim() == value
        && !value.chars().any(|c| c.is_control())
}

fn is_canonical_sha(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256-")
        && value[7..]
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn is_json_object_text(value: &str) -> bool {
    if value.len() > MAX_META_JSON_LEN {
        return false;
    }
    matches!(
        serde_json::from_str::<serde_json::Value>(value),
        Ok(serde_json::Value::Object(_))
    )
}

struct ValidatedPlan {
    turn_indexes: BTreeSet<i64>,
    asset_shas: BTreeSet<String>,
    link_keys: BTreeSet<(i64, String)>,
}

fn validate_payload(payload: &AssetRecoveryCommitPayload) -> Result<ValidatedPlan, &'static str> {
    if payload.schema != RECOVERY_COMMIT_SCHEMA {
        return Err("schema-mismatch");
    }
    if !is_clean_identity(&payload.recovered_chat_id) {
        return Err("recovered-chat-id-invalid");
    }
    if !is_clean_identity(&payload.original_chat_id)
        || !is_clean_identity(&payload.original_snapshot_id)
    {
        return Err("original-identity-invalid");
    }
    if payload.recovered_chat_id == payload.original_chat_id
        || payload.recovered_chat_id == payload.original_snapshot_id
    {
        return Err("recovered-chat-id-reuses-original");
    }
    if payload.chat.title.len() > MAX_TITLE_LEN || payload.snapshot.title.len() > MAX_TITLE_LEN {
        return Err("title-too-long");
    }
    if !is_json_object_text(&payload.chat.meta_json)
        || !is_json_object_text(&payload.snapshot.meta_json)
    {
        return Err("meta-json-invalid");
    }
    if payload.chat.message_count < 0
        || payload.chat.user_turn_count < 0
        || payload.chat.assistant_turn_count < 0
        || payload.chat.last_message_at < 0
        || payload.snapshot.message_count < 0
    {
        return Err("count-negative");
    }

    if payload.turns.is_empty() {
        return Err("no-turns");
    }
    if payload.turns.len() > MAX_TURNS {
        return Err("too-many-turns");
    }
    let mut turn_indexes = BTreeSet::new();
    for turn in &payload.turns {
        if turn.turn_idx < 0 {
            return Err("turn-idx-invalid");
        }
        if !turn_indexes.insert(turn.turn_idx) {
            return Err("turn-idx-duplicate");
        }
        if turn.role.trim().is_empty() || turn.role.chars().any(|c| c.is_control()) {
            return Err("turn-role-invalid");
        }
        if !is_json_object_text(&turn.meta_json) {
            return Err("meta-json-invalid");
        }
    }
    if payload.snapshot.message_count != payload.turns.len() as i64
        || payload.chat.message_count != payload.turns.len() as i64
    {
        return Err("message-count-mismatch");
    }

    if payload.assets.is_empty() {
        // The asset-free path never reaches this command (contract §15).
        return Err("no-assets");
    }
    if payload.assets.len() > MAX_ASSETS {
        return Err("too-many-assets");
    }
    let mut asset_shas = BTreeSet::new();
    for asset in &payload.assets {
        if !is_canonical_sha(&asset.sha256) {
            return Err("asset-sha-invalid");
        }
        if !asset_shas.insert(asset.sha256.clone()) {
            return Err("asset-sha-duplicate");
        }
        if asset.byte_size <= 0 {
            return Err("asset-byte-size-invalid");
        }
        if asset.mime_type.len() > 255
            || asset.ext.len() > 16
            || asset.mime_type.chars().any(|c| c.is_control())
            || !asset
                .ext
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        {
            return Err("asset-descriptor-invalid");
        }
        if !is_json_object_text(&asset.meta_json) {
            return Err("meta-json-invalid");
        }
    }

    if payload.links.len() > MAX_LINKS {
        return Err("too-many-links");
    }
    let mut link_keys = BTreeSet::new();
    for link in &payload.links {
        if !turn_indexes.contains(&link.turn_idx) {
            return Err("link-turn-unknown");
        }
        if !asset_shas.contains(&link.sha256) {
            return Err("link-asset-unknown");
        }
        if link.relation.trim().is_empty()
            || link.relation.len() > 32
            || link.relation.chars().any(|c| c.is_control())
        {
            return Err("link-relation-invalid");
        }
        if !is_json_object_text(&link.meta_json) {
            return Err("meta-json-invalid");
        }
        // The plan is pre-deduplicated (contract §5); a duplicate logical link
        // here is a caller defect, refused rather than silently collapsed.
        if !link_keys.insert((link.turn_idx, link.sha256.clone())) {
            return Err("duplicate-logical-link");
        }
    }

    Ok(ValidatedPlan {
        turn_indexes,
        asset_shas,
        link_keys,
    })
}

// ── identity minting ────────────────────────────────────────────────────────

/// Fresh recovered snapshot identity minted from OS entropy, RFC 4122 v4
/// shaped, in the same `snap_<uuid>` form the renderer store generates.
fn mint_snapshot_id() -> String {
    let hi = crate::archive_generation_publish::random_token_seed();
    let lo = crate::archive_generation_publish::random_token_seed();
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&hi.to_be_bytes());
    bytes[8..].copy_from_slice(&lo.to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "snap_{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

// ── transaction ─────────────────────────────────────────────────────────────

type Tx<'a> = sqlx::Transaction<'a, sqlx::Sqlite>;

async fn table_exists(tx: &mut Tx<'_>, table: &str) -> Result<bool, sqlx::Error> {
    let row =
        sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
            .bind(table)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(row.is_some())
}

async fn id_exists(tx: &mut Tx<'_>, table: &str, id: &str) -> Result<bool, sqlx::Error> {
    let sql = match table {
        "chats" => "SELECT 1 FROM chats WHERE id = ? LIMIT 1",
        "snapshots" => "SELECT 1 FROM snapshots WHERE id = ? LIMIT 1",
        _ => return Ok(true),
    };
    let row = sqlx::query(sql).bind(id).fetch_optional(&mut **tx).await?;
    Ok(row.is_some())
}

fn sqlx_detail(err: &sqlx::Error) -> String {
    // The sqlx error text names the failing table/constraint but never the
    // bound values; it is bounded before it reaches the renderer.
    bound_detail(format!("{err}"))
}

/// The whole recovery write as ONE transaction on `conn`. `now_ms` / `now_iso`
/// are supplied by the command wrapper so the module owns no time authority.
pub async fn run_commit(
    conn: &mut SqliteConnection,
    payload: AssetRecoveryCommitPayload,
    now_ms: i64,
    now_iso: String,
    inject_failure: Option<RecoveryFailure>,
) -> AssetRecoveryCommitResult {
    let plan = match validate_payload(&payload) {
        Ok(plan) => plan,
        Err(code) => return AssetRecoveryCommitResult::refused("validate", code),
    };

    let mut tx = match conn.begin().await {
        Ok(tx) => tx,
        Err(err) => {
            return AssetRecoveryCommitResult::refused_with_detail(
                "begin",
                "transaction-begin-failed",
                Some(sqlx_detail(&err)),
            )
        }
    };

    macro_rules! rollback_with {
        ($stage:expr, $code:expr, $detail:expr) => {{
            let _ = tx.rollback().await;
            return AssetRecoveryCommitResult::refused_with_detail($stage, $code, $detail);
        }};
    }

    for table in [
        "chats",
        "snapshots",
        "snapshot_turns",
        "assets",
        "snapshot_turn_assets",
    ] {
        match table_exists(&mut tx, table).await {
            Ok(true) => {}
            Ok(false) => rollback_with!(
                "assert-fresh",
                "schema-unavailable",
                Some(table.to_string())
            ),
            Err(err) => rollback_with!("assert-fresh", "sql-error", Some(sqlx_detail(&err))),
        }
    }

    // 1. the proposed recovered chat identity must not exist.
    match id_exists(&mut tx, "chats", &payload.recovered_chat_id).await {
        Ok(false) => {}
        Ok(true) => rollback_with!("assert-fresh", "recovered-chat-id-exists", None),
        Err(err) => rollback_with!("assert-fresh", "sql-error", Some(sqlx_detail(&err))),
    }

    // 2. mint the recovered snapshot identity here and assert it is absent.
    let mut snapshot_id: Option<String> = None;
    for _ in 0..SNAPSHOT_ID_MINT_ATTEMPTS {
        let candidate = mint_snapshot_id();
        if candidate == payload.original_snapshot_id || candidate == payload.original_chat_id {
            continue;
        }
        match id_exists(&mut tx, "snapshots", &candidate).await {
            Ok(false) => {
                snapshot_id = Some(candidate);
                break;
            }
            Ok(true) => continue,
            Err(err) => rollback_with!("assert-fresh", "sql-error", Some(sqlx_detail(&err))),
        }
    }
    let Some(snapshot_id) = snapshot_id else {
        rollback_with!("assert-fresh", "snapshot-id-collision", None);
    };

    let mut counts = AssetRecoveryCounts {
        turns: 0,
        assets_inserted: 0,
        assets_existing: 0,
        links: 0,
        refcounts_recomputed: 0,
    };

    // 3. registry ensure — insert absent rows; existing rows keep their
    //    metadata and must agree on byte size (contract §10.3).
    if inject_failure == Some(RecoveryFailure::RegistryEnsure) {
        rollback_with!("registry-ensure", "injected-failure", None);
    }
    let mut assets_by_sha: BTreeMap<&str, &RecoveryAssetInput> = BTreeMap::new();
    for asset in &payload.assets {
        assets_by_sha.insert(asset.sha256.as_str(), asset);
    }
    for sha in &plan.asset_shas {
        let asset = assets_by_sha[sha.as_str()];
        let existing = match sqlx::query_as::<_, (i64,)>(
            "SELECT byte_size FROM assets WHERE sha256 = ? LIMIT 1",
        )
        .bind(&asset.sha256)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(row) => row,
            Err(err) => rollback_with!("registry-ensure", "sql-error", Some(sqlx_detail(&err))),
        };
        match existing {
            Some((byte_size,)) => {
                if byte_size != 0 && byte_size != asset.byte_size {
                    rollback_with!(
                        "registry-ensure",
                        "registry-byte-size-contradiction",
                        Some(asset.sha256.clone())
                    );
                }
                counts.assets_existing += 1;
            }
            None => {
                let inserted = sqlx::query(
                    "INSERT INTO assets (sha256, mime_type, ext, byte_size, created_at, updated_at, refcount, meta_json) \
                     VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
                )
                .bind(&asset.sha256)
                .bind(&asset.mime_type)
                .bind(&asset.ext)
                .bind(asset.byte_size)
                .bind(&now_iso)
                .bind(&now_iso)
                .bind(&asset.meta_json)
                .execute(&mut *tx)
                .await;
                if let Err(err) = inserted {
                    rollback_with!("registry-ensure", "sql-error", Some(sqlx_detail(&err)));
                }
                counts.assets_inserted += 1;
            }
        }
    }

    // 4. recovered chat row — the exact column set the legacy adapter insert
    //    produces for a fresh recovered chat.
    if inject_failure == Some(RecoveryFailure::ChatInsert) {
        rollback_with!("chat-insert", "injected-failure", None);
    }
    let chat_inserted = sqlx::query(
        "INSERT INTO chats (id, title, is_saved, is_linked, message_count, user_turn_count, assistant_turn_count, \
         last_message_at, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&payload.recovered_chat_id)
    .bind(&payload.chat.title)
    .bind(if payload.chat.is_saved { 1i64 } else { 0i64 })
    .bind(if payload.chat.is_linked { 1i64 } else { 0i64 })
    .bind(payload.chat.message_count)
    .bind(payload.chat.user_turn_count)
    .bind(payload.chat.assistant_turn_count)
    .bind(payload.chat.last_message_at)
    .bind(now_ms)
    .bind(now_ms)
    .bind(&payload.chat.meta_json)
    .execute(&mut *tx)
    .await;
    match chat_inserted {
        Ok(done) if done.rows_affected() == 1 => {}
        Ok(_) => rollback_with!("chat-insert", "chat-insert-rows-mismatch", None),
        Err(err) => rollback_with!("chat-insert", "sql-error", Some(sqlx_detail(&err))),
    }

    // 5. recovered snapshot row.
    if inject_failure == Some(RecoveryFailure::SnapshotInsert) {
        rollback_with!("snapshot-insert", "injected-failure", None);
    }
    let snapshot_inserted = sqlx::query(
        "INSERT INTO snapshots (id, chat_id, title, message_count, captured_at, updated_at, meta_json) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&snapshot_id)
    .bind(&payload.recovered_chat_id)
    .bind(&payload.snapshot.title)
    .bind(payload.snapshot.message_count)
    .bind(now_ms)
    .bind(now_ms)
    .bind(&payload.snapshot.meta_json)
    .execute(&mut *tx)
    .await;
    match snapshot_inserted {
        Ok(done) if done.rows_affected() == 1 => {}
        Ok(_) => rollback_with!("snapshot-insert", "snapshot-insert-rows-mismatch", None),
        Err(err) => rollback_with!("snapshot-insert", "sql-error", Some(sqlx_detail(&err))),
    }

    // 6. normalized turns.
    for turn in &payload.turns {
        if inject_failure == Some(RecoveryFailure::TurnInsert) {
            rollback_with!("turn-insert", "injected-failure", None);
        }
        let inserted = sqlx::query(
            "INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&snapshot_id)
        .bind(turn.turn_idx)
        .bind(&turn.role)
        .bind(&turn.outer_html)
        .bind(&turn.text)
        .bind(&turn.meta_json)
        .execute(&mut *tx)
        .await;
        match inserted {
            Ok(done) if done.rows_affected() == 1 => counts.turns += 1,
            Ok(_) => rollback_with!("turn-insert", "turn-insert-rows-mismatch", None),
            Err(err) => rollback_with!("turn-insert", "sql-error", Some(sqlx_detail(&err))),
        }
    }
    debug_assert_eq!(counts.turns as usize, plan.turn_indexes.len());

    // 7. one link per trusted logical reference (plain INSERT: the plan is
    //    pre-deduplicated and the snapshot is fresh, so a PK violation is a
    //    defect, never something to ignore).
    let mut linked_shas: BTreeSet<&str> = BTreeSet::new();
    for link in &payload.links {
        if inject_failure == Some(RecoveryFailure::LinkInsert) {
            rollback_with!("link-insert", "injected-failure", None);
        }
        let inserted = sqlx::query(
            "INSERT INTO snapshot_turn_assets (snapshot_id, turn_idx, sha256, relation, created_at, meta_json) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&snapshot_id)
        .bind(link.turn_idx)
        .bind(&link.sha256)
        .bind(&link.relation)
        .bind(&now_iso)
        .bind(&link.meta_json)
        .execute(&mut *tx)
        .await;
        match inserted {
            Ok(done) if done.rows_affected() == 1 => {
                counts.links += 1;
                linked_shas.insert(link.sha256.as_str());
            }
            Ok(_) => rollback_with!("link-insert", "link-insert-rows-mismatch", None),
            Err(err) => rollback_with!("link-insert", "sql-error", Some(sqlx_detail(&err))),
        }
    }
    debug_assert_eq!(counts.links as usize, plan.link_keys.len());

    // 8. authoritative refcount recompute from the join relation for every
    //    asset that received a link (the registry's existing rule).
    for sha in &linked_shas {
        if inject_failure == Some(RecoveryFailure::Refcount) {
            rollback_with!("refcount", "injected-failure", None);
        }
        let updated = sqlx::query(
            "UPDATE assets SET refcount = (SELECT COUNT(*) FROM snapshot_turn_assets WHERE sha256 = ?), \
             updated_at = ? WHERE sha256 = ?",
        )
        .bind(sha)
        .bind(&now_iso)
        .bind(sha)
        .execute(&mut *tx)
        .await;
        match updated {
            Ok(done) if done.rows_affected() == 1 => counts.refcounts_recomputed += 1,
            Ok(_) => rollback_with!("refcount", "refcount-rows-mismatch", None),
            Err(err) => rollback_with!("refcount", "sql-error", Some(sqlx_detail(&err))),
        }
    }

    // 9. commit exactly once.
    if inject_failure == Some(RecoveryFailure::Commit) {
        rollback_with!("commit", "injected-failure", None);
    }
    if let Err(err) = tx.commit().await {
        return AssetRecoveryCommitResult::refused_with_detail(
            "commit",
            "commit-failed",
            Some(sqlx_detail(&err)),
        );
    }

    AssetRecoveryCommitResult::committed(payload.recovered_chat_id, snapshot_id, counts)
}

#[cfg(test)]
mod tests;
