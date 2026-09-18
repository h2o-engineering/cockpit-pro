//! Native assurance for the purpose-bounded Saved-Chat asset recovery
//! transaction (T02 permanent harness, NATIVE level — accepted contract §20
//! vectors 13–19, 21, 22 and the closed-input / no-destruction rules of §10).
//!
//! Every test runs [`run_commit`] against a throwaway in-memory SQLite database
//! whose schema mirrors the real Tauri migrations for the five touched tables.
//! Failure injection is test-only and makes exactly one in-transaction step
//! fail so that rollback of the WHOLE destination mutation is observable.

use super::*;
use sqlx::{Column, Row};

const SHA_A: &str = "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: &str = "sha256-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ORIGINAL_CHAT: &str = "orig-chat-001";
const ORIGINAL_SNAPSHOT: &str = "snap_orig_001";
const RECOVERED_CHAT: &str = "recovered_11111111-2222-4333-8444-555555555555";
const NOW_MS: i64 = 1_758_153_600_000;
const NOW_ISO: &str = "2026-09-18T00:00:00.000Z";

const SCHEMA: &str = r#"
CREATE TABLE chats (
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
  snapshot_count INTEGER NOT NULL DEFAULT 0, last_snapshot_id TEXT, last_captured_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  digest TEXT, message_count INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  legacy INTEGER NOT NULL DEFAULT 0, captured_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE snapshot_turns (
  snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, role TEXT NOT NULL,
  outer_html TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (snapshot_id, turn_idx)
);
CREATE TABLE assets (
  sha256 TEXT PRIMARY KEY, mime_type TEXT NOT NULL DEFAULT '', ext TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '', refcount INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE snapshot_turn_assets (
  snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, sha256 TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'inline', created_at TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (snapshot_id, turn_idx, sha256)
);
CREATE INDEX idx_snapshot_turn_assets_sha256 ON snapshot_turn_assets(sha256);
"#;

async fn setup_conn() -> SqliteConnection {
    let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
    for statement in SCHEMA.split(';') {
        let sql = statement.trim();
        if sql.is_empty() {
            continue;
        }
        sqlx::query(sql).execute(&mut conn).await.unwrap();
    }
    conn
}

/// Pre-existing rows that recovery must never touch: an unrelated chat with a
/// snapshot, turns, one registry row (SHA_B, with its own presentation
/// metadata) and one link that already references SHA_B.
async fn seed_foreign_rows(conn: &mut SqliteConnection) {
    sqlx::query("INSERT INTO chats (id, title, created_at, updated_at, meta_json, is_saved) VALUES ('foreign-chat', 'Foreign', 1, 1, '{\"k\":1}', 1)")
        .execute(&mut *conn).await.unwrap();
    sqlx::query("INSERT INTO snapshots (id, chat_id, title, message_count, captured_at, updated_at, meta_json) VALUES ('snap_foreign', 'foreign-chat', 'Foreign', 1, 1, 1, '{}')")
        .execute(&mut *conn).await.unwrap();
    sqlx::query("INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES ('snap_foreign', 0, 'user', '<p>x</p>', 'x', '{}')")
        .execute(&mut *conn).await.unwrap();
    sqlx::query("INSERT INTO assets (sha256, mime_type, ext, byte_size, created_at, updated_at, refcount, meta_json) VALUES (?, 'image/webp', 'webp', 20, 'seed', 'seed', 1, '{\"origin\":\"seed\"}')")
        .bind(SHA_B)
        .execute(&mut *conn).await.unwrap();
    sqlx::query("INSERT INTO snapshot_turn_assets (snapshot_id, turn_idx, sha256, relation, created_at, meta_json) VALUES ('snap_foreign', 0, ?, 'inline', 'seed', '{}')")
        .bind(SHA_B)
        .execute(&mut *conn).await.unwrap();
}

fn turn(idx: i64, role: &str, html: &str) -> RecoveryTurnInput {
    RecoveryTurnInput {
        turn_idx: idx,
        role: role.to_string(),
        text: format!("text {idx}"),
        outer_html: html.to_string(),
        meta_json: format!("{{\"sourceMessageId\":\"m{idx}\"}}"),
    }
}

fn asset(sha: &str, mime: &str, ext: &str, size: i64) -> RecoveryAssetInput {
    RecoveryAssetInput {
        sha256: sha.to_string(),
        mime_type: mime.to_string(),
        ext: ext.to_string(),
        byte_size: size,
        meta_json: "{}".to_string(),
    }
}

fn link(idx: i64, sha: &str) -> RecoveryLinkInput {
    RecoveryLinkInput {
        turn_idx: idx,
        sha256: sha.to_string(),
        relation: "inline".to_string(),
        meta_json: "{\"sourceMessageId\":\"m\"}".to_string(),
    }
}

/// Three turns; SHA_A referenced by turns 1 and 2, SHA_B by turn 2 only.
fn valid_payload() -> AssetRecoveryCommitPayload {
    AssetRecoveryCommitPayload {
        schema: RECOVERY_COMMIT_SCHEMA.to_string(),
        recovered_chat_id: RECOVERED_CHAT.to_string(),
        original_chat_id: ORIGINAL_CHAT.to_string(),
        original_snapshot_id: ORIGINAL_SNAPSHOT.to_string(),
        chat: RecoveryChatInput {
            title: "Recovered: fixture".to_string(),
            is_saved: true,
            is_linked: false,
            message_count: 3,
            user_turn_count: 1,
            assistant_turn_count: 2,
            last_message_at: 1_700_000_000_000,
            meta_json: "{\"recovered\":{\"recoveredFromPackage\":true},\"answerCount\":2}"
                .to_string(),
        },
        snapshot: RecoverySnapshotInput {
            title: "Recovered: fixture".to_string(),
            message_count: 3,
            meta_json: "{\"recovered\":{\"recoveredFromPackage\":true}}".to_string(),
        },
        turns: vec![
            turn(0, "user", "<p>q</p>"),
            turn(1, "assistant", "<p>a</p><img src=\"assets/sha256-a.png\">"),
            turn(2, "assistant", "<p>b</p>"),
        ],
        assets: vec![
            asset(SHA_A, "image/png", "png", 68),
            asset(SHA_B, "image/png", "png", 20),
        ],
        links: vec![link(1, SHA_A), link(2, SHA_A), link(2, SHA_B)],
    }
}

async fn run(
    conn: &mut SqliteConnection,
    payload: AssetRecoveryCommitPayload,
    inject: Option<RecoveryFailure>,
) -> AssetRecoveryCommitResult {
    run_commit(conn, payload, NOW_MS, NOW_ISO.to_string(), inject).await
}

async fn count(conn: &mut SqliteConnection, table: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) AS n FROM {table}");
    let row = sqlx::query(&sql).fetch_one(&mut *conn).await.unwrap();
    row.get::<i64, _>("n")
}

async fn counts(conn: &mut SqliteConnection) -> [i64; 5] {
    [
        count(conn, "chats").await,
        count(conn, "snapshots").await,
        count(conn, "snapshot_turns").await,
        count(conn, "assets").await,
        count(conn, "snapshot_turn_assets").await,
    ]
}

/// Deterministic digest of every row in every touched table (ordered), used
/// to prove that pre-existing rows are byte-identical after recovery.
async fn table_digest(conn: &mut SqliteConnection, table: &str, order: &str) -> String {
    let sql = format!("SELECT * FROM {table} ORDER BY {order}");
    let rows = sqlx::query(&sql).fetch_all(&mut *conn).await.unwrap();
    let mut out = String::new();
    for row in rows {
        for (i, col) in row.columns().iter().enumerate() {
            let value: Option<String> = row.try_get::<Option<String>, _>(i).unwrap_or_else(|_| {
                row.try_get::<Option<i64>, _>(i)
                    .ok()
                    .flatten()
                    .map(|v| v.to_string())
            });
            out.push_str(col.name());
            out.push('=');
            out.push_str(&value.unwrap_or_default());
            out.push('|');
        }
        out.push('\n');
    }
    out
}

async fn foreign_digests(conn: &mut SqliteConnection) -> Vec<String> {
    vec![
        table_digest(conn, "chats WHERE id = 'foreign-chat'", "id").await,
        table_digest(conn, "snapshots WHERE id = 'snap_foreign'", "id").await,
        table_digest(
            conn,
            "snapshot_turns WHERE snapshot_id = 'snap_foreign'",
            "turn_idx",
        )
        .await,
        table_digest(
            conn,
            "snapshot_turn_assets WHERE snapshot_id = 'snap_foreign'",
            "turn_idx, sha256",
        )
        .await,
    ]
}

async fn refcount(conn: &mut SqliteConnection, sha: &str) -> i64 {
    let row = sqlx::query("SELECT refcount FROM assets WHERE sha256 = ?")
        .bind(sha)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    row.get::<i64, _>("refcount")
}

// ── closed input validation ─────────────────────────────────────────────────

#[test]
fn unknown_fields_and_wrong_schema_are_refused_before_any_write() {
    tauri::async_runtime::block_on(async {
        // deny_unknown_fields at every level of the closed schema.
        let extra = serde_json::json!({
            "schema": RECOVERY_COMMIT_SCHEMA,
            "recoveredChatId": RECOVERED_CHAT,
            "originalChatId": ORIGINAL_CHAT,
            "originalSnapshotId": ORIGINAL_SNAPSHOT,
            "sql": "DROP TABLE chats",
            "chat": {"title":"t","isSaved":true,"isLinked":false,"messageCount":1,"userTurnCount":1,"assistantTurnCount":0,"metaJson":"{}"},
            "snapshot": {"title":"t","messageCount":1,"metaJson":"{}"},
            "turns": [{"turnIdx":0,"role":"user","text":"","outerHtml":"","metaJson":"{}"}],
            "assets": [{"sha256":SHA_A,"mimeType":"image/png","ext":"png","byteSize":1,"metaJson":"{}"}],
            "links": []
        });
        assert!(serde_json::from_value::<AssetRecoveryCommitPayload>(extra).is_err());

        let mut conn = setup_conn().await;
        let mut payload = valid_payload();
        payload.schema = "h2o.somethingElse.v9".to_string();
        let result = run(&mut conn, payload, None).await;
        assert!(!result.ok && !result.committed);
        assert_eq!(result.stage, Some("validate"));
        assert_eq!(result.code.as_deref(), Some("schema-mismatch"));
        assert_eq!(counts(&mut conn).await, [0, 0, 0, 0, 0]);
    });
}

#[test]
fn validation_refuses_identity_reuse_empty_assets_unknown_links_and_bad_shas() {
    tauri::async_runtime::block_on(async {
        let mut conn = setup_conn().await;

        let mut reuse = valid_payload();
        reuse.recovered_chat_id = ORIGINAL_CHAT.to_string();
        let r = run(&mut conn, reuse, None).await;
        assert_eq!(r.code.as_deref(), Some("recovered-chat-id-reuses-original"));

        let mut no_assets = valid_payload();
        no_assets.assets.clear();
        no_assets.links.clear();
        let r = run(&mut conn, no_assets, None).await;
        assert_eq!(r.code.as_deref(), Some("no-assets"));

        let mut unknown_turn = valid_payload();
        unknown_turn.links.push(link(9, SHA_A));
        let r = run(&mut conn, unknown_turn, None).await;
        assert_eq!(r.code.as_deref(), Some("link-turn-unknown"));

        let mut unknown_asset = valid_payload();
        unknown_asset.links.push(link(
            0,
            "sha256-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        ));
        let r = run(&mut conn, unknown_asset, None).await;
        assert_eq!(r.code.as_deref(), Some("link-asset-unknown"));

        let mut bad_sha = valid_payload();
        bad_sha.assets[0].sha256 = "SHA256-AAAA".to_string();
        let r = run(&mut conn, bad_sha, None).await;
        assert_eq!(r.code.as_deref(), Some("asset-sha-invalid"));

        let mut bad_meta = valid_payload();
        bad_meta.snapshot.meta_json = "[]".to_string();
        let r = run(&mut conn, bad_meta, None).await;
        assert_eq!(r.code.as_deref(), Some("meta-json-invalid"));

        let mut count_mismatch = valid_payload();
        count_mismatch.snapshot.message_count = 2;
        let r = run(&mut conn, count_mismatch, None).await;
        assert_eq!(r.code.as_deref(), Some("message-count-mismatch"));

        assert_eq!(counts(&mut conn).await, [0, 0, 0, 0, 0]);
    });
}

#[test]
fn duplicate_logical_link_is_refused_consistent_with_the_pre_deduped_plan() {
    tauri::async_runtime::block_on(async {
        let mut conn = setup_conn().await;
        let mut payload = valid_payload();
        payload.links.push(link(1, SHA_A));
        let result = run(&mut conn, payload, None).await;
        assert!(!result.ok);
        assert_eq!(result.stage, Some("validate"));
        assert_eq!(result.code.as_deref(), Some("duplicate-logical-link"));
        assert_eq!(counts(&mut conn).await, [0, 0, 0, 0, 0]);
    });
}

// ── success path ────────────────────────────────────────────────────────────

#[test]
fn successful_commit_writes_exactly_the_planned_rows_with_fresh_identities() {
    tauri::async_runtime::block_on(async {
        let mut conn = setup_conn().await;
        seed_foreign_rows(&mut conn).await;
        let before = foreign_digests(&mut conn).await;

        let result = run(&mut conn, valid_payload(), None).await;
        assert!(result.ok && result.committed, "{result:?}");
        assert_eq!(result.recovered_chat_id.as_deref(), Some(RECOVERED_CHAT));
        let snapshot_id = result.recovered_snapshot_id.clone().unwrap();
        assert!(snapshot_id.starts_with("snap_"));
        assert_eq!(snapshot_id.len(), "snap_".len() + 36);
        assert_ne!(snapshot_id, ORIGINAL_SNAPSHOT);
        assert_ne!(snapshot_id, ORIGINAL_CHAT);
        assert_eq!(result.counts.turns, 3);
        assert_eq!(result.counts.assets_inserted, 1); // SHA_A
        assert_eq!(result.counts.assets_existing, 1); // SHA_B (seeded)
        assert_eq!(result.counts.links, 3);
        assert_eq!(result.counts.refcounts_recomputed, 2);

        // +1 chat, +1 snapshot, +3 turns, +1 registry row, +3 links.
        assert_eq!(counts(&mut conn).await, [2, 2, 4, 2, 4]);

        let chat = sqlx::query("SELECT * FROM chats WHERE id = ?")
            .bind(RECOVERED_CHAT)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(chat.get::<String, _>("title"), "Recovered: fixture");
        assert_eq!(chat.get::<i64, _>("is_saved"), 1);
        assert_eq!(chat.get::<i64, _>("is_linked"), 0);
        assert_eq!(chat.get::<i64, _>("message_count"), 3);
        assert_eq!(chat.get::<i64, _>("user_turn_count"), 1);
        assert_eq!(chat.get::<i64, _>("assistant_turn_count"), 2);
        assert_eq!(chat.get::<i64, _>("last_message_at"), 1_700_000_000_000);
        assert_eq!(chat.get::<i64, _>("created_at"), NOW_MS);
        assert_eq!(chat.get::<i64, _>("updated_at"), NOW_MS);
        assert_eq!(chat.get::<Option<String>, _>("category_id"), None);
        assert_eq!(
            chat.get::<String, _>("meta_json"),
            "{\"recovered\":{\"recoveredFromPackage\":true},\"answerCount\":2}"
        );

        let snap = sqlx::query("SELECT * FROM snapshots WHERE id = ?")
            .bind(&snapshot_id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(snap.get::<String, _>("chat_id"), RECOVERED_CHAT);
        assert_eq!(snap.get::<i64, _>("message_count"), 3);
        assert_eq!(snap.get::<i64, _>("captured_at"), NOW_MS);
        assert_eq!(snap.get::<Option<String>, _>("digest"), None);
        assert_eq!(
            snap.get::<String, _>("meta_json"),
            "{\"recovered\":{\"recoveredFromPackage\":true}}"
        );

        let turns = sqlx::query(
            "SELECT turn_idx, role, outer_html, meta_json FROM snapshot_turns WHERE snapshot_id = ? ORDER BY turn_idx",
        )
        .bind(&snapshot_id)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[1].get::<String, _>("role"), "assistant");
        assert_eq!(
            turns[1].get::<String, _>("outer_html"),
            "<p>a</p><img src=\"assets/sha256-a.png\">"
        );
        assert_eq!(
            turns[2].get::<String, _>("meta_json"),
            "{\"sourceMessageId\":\"m2\"}"
        );

        let links = sqlx::query(
            "SELECT turn_idx, sha256, relation, created_at FROM snapshot_turn_assets WHERE snapshot_id = ? ORDER BY turn_idx, sha256",
        )
        .bind(&snapshot_id)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        let link_keys: Vec<(i64, String)> = links
            .iter()
            .map(|r| (r.get::<i64, _>("turn_idx"), r.get::<String, _>("sha256")))
            .collect();
        assert_eq!(
            link_keys,
            vec![
                (1, SHA_A.to_string()),
                (2, SHA_A.to_string()),
                (2, SHA_B.to_string())
            ]
        );
        assert!(links
            .iter()
            .all(|r| r.get::<String, _>("relation") == "inline"));
        assert!(links
            .iter()
            .all(|r| r.get::<String, _>("created_at") == NOW_ISO));

        // registry: SHA_A inserted from the descriptor; SHA_B kept its seeded
        // presentation metadata (no clobber) while its refcount was recomputed
        // from the authoritative join relation (1 foreign + 1 new = 2).
        let a = sqlx::query("SELECT * FROM assets WHERE sha256 = ?")
            .bind(SHA_A)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(a.get::<String, _>("mime_type"), "image/png");
        assert_eq!(a.get::<String, _>("ext"), "png");
        assert_eq!(a.get::<i64, _>("byte_size"), 68);
        assert_eq!(a.get::<String, _>("created_at"), NOW_ISO);
        assert_eq!(refcount(&mut conn, SHA_A).await, 2);

        let b = sqlx::query("SELECT * FROM assets WHERE sha256 = ?")
            .bind(SHA_B)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(b.get::<String, _>("mime_type"), "image/webp");
        assert_eq!(b.get::<String, _>("ext"), "webp");
        assert_eq!(b.get::<String, _>("meta_json"), "{\"origin\":\"seed\"}");
        assert_eq!(b.get::<String, _>("created_at"), "seed");
        assert_eq!(refcount(&mut conn, SHA_B).await, 2);

        // no destructive update / delete of any pre-existing row.
        assert_eq!(foreign_digests(&mut conn).await, before);
    });
}

#[test]
fn repeated_explicit_recovery_mints_distinct_fresh_identities_and_dedupes_registry() {
    tauri::async_runtime::block_on(async {
        let mut conn = setup_conn().await;
        let first = run(&mut conn, valid_payload(), None).await;
        assert!(first.ok);

        let mut second_payload = valid_payload();
        second_payload.recovered_chat_id =
            "recovered_second-4444-4444-8444-666666666666".to_string();
        let second = run(&mut conn, second_payload, None).await;
        assert!(second.ok, "{second:?}");
        assert_ne!(first.recovered_snapshot_id, second.recovered_snapshot_id);
        assert_eq!(second.counts.assets_inserted, 0);
        assert_eq!(second.counts.assets_existing, 2);
        assert_eq!(counts(&mut conn).await, [2, 2, 6, 2, 6]);
        assert_eq!(refcount(&mut conn, SHA_A).await, 4);
        assert_eq!(refcount(&mut conn, SHA_B).await, 2);

        // the same recovered chat id a second time is a fresh-identity refusal.
        let again = run(&mut conn, valid_payload(), None).await;
        assert!(!again.ok);
        assert_eq!(again.stage, Some("assert-fresh"));
        assert_eq!(again.code.as_deref(), Some("recovered-chat-id-exists"));
        assert_eq!(counts(&mut conn).await, [2, 2, 6, 2, 6]);
    });
}

// ── refusals inside the transaction ─────────────────────────────────────────

#[test]
fn registry_byte_size_contradiction_rolls_back_everything() {
    tauri::async_runtime::block_on(async {
        let mut conn = setup_conn().await;
        seed_foreign_rows(&mut conn).await;
        let before = foreign_digests(&mut conn).await;
        let mut payload = valid_payload();
        payload.assets[1].byte_size = 21; // SHA_B seeded with 20
        let result = run(&mut conn, payload, None).await;
        assert!(!result.ok && !result.committed);
        assert_eq!(result.stage, Some("registry-ensure"));
        assert_eq!(
            result.code.as_deref(),
            Some("registry-byte-size-contradiction")
        );
        assert_eq!(counts(&mut conn).await, [1, 1, 1, 1, 1]);
        assert_eq!(foreign_digests(&mut conn).await, before);
        // SHA_A (processed before SHA_B in sorted order) must not survive.
        let a = sqlx::query("SELECT 1 FROM assets WHERE sha256 = ?")
            .bind(SHA_A)
            .fetch_optional(&mut conn)
            .await
            .unwrap();
        assert!(a.is_none());
    });
}

#[test]
fn unknown_byte_size_zero_on_an_existing_row_is_tolerated_and_never_filled() {
    tauri::async_runtime::block_on(async {
        let mut conn = setup_conn().await;
        sqlx::query("INSERT INTO assets (sha256, mime_type, ext, byte_size) VALUES (?, '', '', 0)")
            .bind(SHA_A)
            .execute(&mut conn)
            .await
            .unwrap();
        let result = run(&mut conn, valid_payload(), None).await;
        assert!(result.ok, "{result:?}");
        let a = sqlx::query("SELECT mime_type, ext, byte_size FROM assets WHERE sha256 = ?")
            .bind(SHA_A)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(a.get::<String, _>("mime_type"), "");
        assert_eq!(a.get::<String, _>("ext"), "");
        assert_eq!(a.get::<i64, _>("byte_size"), 0);
    });
}

#[test]
fn every_injected_failure_point_rolls_back_the_whole_mutation() {
    tauri::async_runtime::block_on(async {
        let cases = [
            (RecoveryFailure::RegistryEnsure, "registry-ensure"),
            (RecoveryFailure::ChatInsert, "chat-insert"),
            (RecoveryFailure::SnapshotInsert, "snapshot-insert"),
            (RecoveryFailure::TurnInsert, "turn-insert"),
            (RecoveryFailure::LinkInsert, "link-insert"),
            (RecoveryFailure::Refcount, "refcount"),
            (RecoveryFailure::Commit, "commit"),
        ];
        for (failure, stage) in cases {
            let mut conn = setup_conn().await;
            seed_foreign_rows(&mut conn).await;
            let before = foreign_digests(&mut conn).await;
            let result = run(&mut conn, valid_payload(), Some(failure)).await;
            assert!(!result.ok && !result.committed, "{failure:?}");
            assert_eq!(result.stage, Some(stage), "{failure:?}");
            assert_eq!(result.code.as_deref(), Some("injected-failure"));
            assert!(result.recovered_chat_id.is_none());
            assert!(result.recovered_snapshot_id.is_none());
            assert_eq!(counts(&mut conn).await, [1, 1, 1, 1, 1], "{failure:?}");
            assert_eq!(foreign_digests(&mut conn).await, before, "{failure:?}");
            assert_eq!(refcount(&mut conn, SHA_B).await, 1, "{failure:?}");

            // control: the SAME database accepts the SAME payload without
            // injection, so the injection point really was inside the
            // transaction and rollback (not a pre-transaction refusal) is what
            // kept the tables unchanged.
            let ok = run(&mut conn, valid_payload(), None).await;
            assert!(ok.ok && ok.committed, "{failure:?} control: {ok:?}");
            assert_eq!(counts(&mut conn).await, [2, 2, 4, 2, 4], "{failure:?}");
        }
    });
}

#[test]
fn a_real_constraint_failure_mid_transaction_rolls_back_without_panicking() {
    tauri::async_runtime::block_on(async {
        // Provoke a GENUINE SQL error mid-transaction (not an injected one):
        // this test database's `snapshot_turns` carries a CHECK constraint that
        // refuses assistant turns, so the second turn insert fails after the
        // chat and snapshot rows have already been written inside the
        // transaction.
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        for statement in SCHEMA
            .replace(
                "role TEXT NOT NULL,\n  outer_html",
                "role TEXT NOT NULL CHECK (role <> 'assistant'),\n  outer_html",
            )
            .split(';')
        {
            let sql = statement.trim();
            if sql.is_empty() {
                continue;
            }
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        let result = run(&mut conn, valid_payload(), None).await;
        assert!(!result.ok && !result.committed);
        assert_eq!(result.stage, Some("turn-insert"));
        assert_eq!(result.code.as_deref(), Some("sql-error"));
        let detail = result.detail.clone().unwrap_or_default();
        assert!(detail.len() <= MAX_DETAIL_LEN);
        assert!(
            !detail.contains("<p>a</p>"),
            "bound values never leak into detail"
        );
        // the chat and snapshot rows inserted before the failing turn are gone.
        assert_eq!(counts(&mut conn).await, [0, 0, 0, 0, 0]);
    });
}

#[test]
fn schema_absence_is_a_refusal_not_a_panic() {
    tauri::async_runtime::block_on(async {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        let result = run(&mut conn, valid_payload(), None).await;
        assert!(!result.ok);
        assert_eq!(result.stage, Some("assert-fresh"));
        assert_eq!(result.code.as_deref(), Some("schema-unavailable"));
    });
}

// ── helpers ─────────────────────────────────────────────────────────────────

#[test]
fn minted_snapshot_ids_are_fresh_uuid_shaped_and_distinct() {
    let a = mint_snapshot_id();
    let b = mint_snapshot_id();
    assert_ne!(a, b);
    for id in [&a, &b] {
        assert!(id.starts_with("snap_"));
        let uuid = &id["snap_".len()..];
        assert_eq!(uuid.len(), 36);
        assert_eq!(&uuid[14..15], "4", "version nibble");
        assert!(
            matches!(&uuid[19..20], "8" | "9" | "a" | "b"),
            "variant nibble"
        );
        assert!(uuid
            .chars()
            .all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c)));
    }
}

#[test]
fn detail_is_bounded_on_a_char_boundary() {
    let long = "é".repeat(MAX_DETAIL_LEN); // 2 bytes each
    let bounded = bound_detail(long);
    assert!(bounded.len() <= MAX_DETAIL_LEN);
    assert!(bounded.chars().all(|c| c == 'é'));
}

#[test]
fn canonical_sha_and_identity_predicates() {
    assert!(is_canonical_sha(SHA_A));
    assert!(!is_canonical_sha(&SHA_A.to_ascii_uppercase()));
    assert!(!is_canonical_sha(&SHA_A[7..]));
    assert!(!is_canonical_sha("sha256-zz"));
    assert!(is_clean_identity(RECOVERED_CHAT));
    assert!(!is_clean_identity(" padded"));
    assert!(!is_clean_identity("has\u{0001}control"));
    assert!(!is_clean_identity(&"x".repeat(MAX_ID_LEN + 1)));
}
