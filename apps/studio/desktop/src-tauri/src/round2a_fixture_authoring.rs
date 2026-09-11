//! Round 2A local-only deterministic acceptance fixture authoring.
//!
//! This module owns three closed synthetic targets with two immutable revisions
//! each. It has no transport dependency and exposes no caller-selected IDs,
//! content, table names, or SQL. Every mutation is performed and verified in
//! one SQLite transaction. Divergent or partial state is never repaired
//! automatically.

use serde::Serialize;
use serde_json::Value as JsonValue;
use sqlx::{Connection, Row, SqliteConnection, Transaction};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

const DB_URL: &str = "sqlite:studio-v1.db";

pub const CHAT_ID: &str = "round2a-acceptance-synthetic-chat-20260727";
pub const CHAT_TITLE: &str = "Round 2A Acceptance — Synthetic";
pub const REVISION_1_ID: &str = "round2a-acceptance-synthetic-chat-20260727-r1";
pub const REVISION_2_ID: &str = "round2a-acceptance-synthetic-chat-20260727-r2";
pub const REVISION_1_ISO: &str = "2026-07-27T12:00:00.000Z";
pub const REVISION_2_ISO: &str = "2026-07-27T12:01:00.000Z";
const REVISION_1_MILLIS: i64 = 1_785_153_600_000;
const REVISION_2_MILLIS: i64 = 1_785_153_660_000;

pub const ITEM9_CANARY_CHAT_ID: &str = "round2-item9-live-canary-3c1-v1";
pub const ITEM9_CANARY_CHAT_TITLE: &str = "Round 2 Item 9 Live Canary 3C1 — Synthetic";
pub const ITEM9_CANARY_REVISION_1_ID: &str = "round2-item9-live-canary-3c1-v1-r1";
pub const ITEM9_CANARY_REVISION_2_ID: &str = "round2-item9-live-canary-3c1-v1-r2";
pub const ITEM9_CANARY_REVISION_1_ISO: &str = "2026-07-30T12:00:00.000Z";
pub const ITEM9_CANARY_REVISION_2_ISO: &str = "2026-07-30T12:01:00.000Z";
const ITEM9_CANARY_REVISION_1_MILLIS: i64 = 1_785_412_800_000;
const ITEM9_CANARY_REVISION_2_MILLIS: i64 = 1_785_412_860_000;

pub const ITEM11_DIRECT_TRANSPORT_CHAT_ID: &str = "round2-item11-direct-transport-v1";
pub const ITEM11_DIRECT_TRANSPORT_CHAT_TITLE: &str = "Round 2 Item 11 Direct Transport — Synthetic";
pub const ITEM11_DIRECT_TRANSPORT_REVISION_1_ID: &str = "round2-item11-direct-transport-v1-r1";
pub const ITEM11_DIRECT_TRANSPORT_REVISION_2_ID: &str = "round2-item11-direct-transport-v1-r2";
pub const ITEM11_DIRECT_TRANSPORT_REVISION_1_ISO: &str = "2026-08-03T12:00:00.000Z";
pub const ITEM11_DIRECT_TRANSPORT_REVISION_2_ISO: &str = "2026-08-03T12:01:00.000Z";
const ITEM11_DIRECT_TRANSPORT_REVISION_1_MILLIS: i64 = 1_785_758_400_000;
const ITEM11_DIRECT_TRANSPORT_REVISION_2_MILLIS: i64 = 1_785_758_460_000;

const REVISION_1_TURNS: [FixtureTurn; 2] = [
    FixtureTurn {
        turn_idx: 0,
        role: "user",
        text: "ROUND2A SYNTHETIC REVISION 1 — INPUT",
        outer_html: "<p>ROUND2A SYNTHETIC REVISION 1 — INPUT</p>",
    },
    FixtureTurn {
        turn_idx: 1,
        role: "assistant",
        text: "ROUND2A SYNTHETIC REVISION 1 — RESPONSE",
        outer_html: "<p>ROUND2A SYNTHETIC REVISION 1 — RESPONSE</p>",
    },
];

const REVISION_2_TURNS: [FixtureTurn; 4] = [
    REVISION_1_TURNS[0],
    REVISION_1_TURNS[1],
    FixtureTurn {
        turn_idx: 2,
        role: "user",
        text: "ROUND2A SYNTHETIC REVISION 2 — INPUT",
        outer_html: "<p>ROUND2A SYNTHETIC REVISION 2 — INPUT</p>",
    },
    FixtureTurn {
        turn_idx: 3,
        role: "assistant",
        text: "ROUND2A SYNTHETIC REVISION 2 — RESPONSE",
        outer_html: "<p>ROUND2A SYNTHETIC REVISION 2 — RESPONSE</p>",
    },
];

const ITEM9_CANARY_REVISION_1_TURNS: [FixtureTurn; 2] = [
    FixtureTurn {
        turn_idx: 0,
        role: "user",
        text: "ITEM9 3C1 LIVE CANARY REVISION 1 — INPUT",
        outer_html: "<p>ITEM9 3C1 LIVE CANARY REVISION 1 — INPUT</p>",
    },
    FixtureTurn {
        turn_idx: 1,
        role: "assistant",
        text: "ITEM9 3C1 LIVE CANARY REVISION 1 — RESPONSE",
        outer_html: "<p>ITEM9 3C1 LIVE CANARY REVISION 1 — RESPONSE</p>",
    },
];

const ITEM9_CANARY_REVISION_2_TURNS: [FixtureTurn; 4] = [
    ITEM9_CANARY_REVISION_1_TURNS[0],
    ITEM9_CANARY_REVISION_1_TURNS[1],
    FixtureTurn {
        turn_idx: 2,
        role: "user",
        text: "ITEM9 3C1 LIVE CANARY REVISION 2 — INPUT",
        outer_html: "<p>ITEM9 3C1 LIVE CANARY REVISION 2 — INPUT</p>",
    },
    FixtureTurn {
        turn_idx: 3,
        role: "assistant",
        text: "ITEM9 3C1 LIVE CANARY REVISION 2 — RESPONSE",
        outer_html: "<p>ITEM9 3C1 LIVE CANARY REVISION 2 — RESPONSE</p>",
    },
];

const ITEM11_DIRECT_TRANSPORT_REVISION_1_TURNS: [FixtureTurn; 2] = [
    FixtureTurn {
        turn_idx: 0,
        role: "user",
        text: "ITEM11 DIRECT TRANSPORT REVISION 1 — INPUT",
        outer_html: "<p>ITEM11 DIRECT TRANSPORT REVISION 1 — INPUT</p>",
    },
    FixtureTurn {
        turn_idx: 1,
        role: "assistant",
        text: "ITEM11 DIRECT TRANSPORT REVISION 1 — RESPONSE",
        outer_html: "<p>ITEM11 DIRECT TRANSPORT REVISION 1 — RESPONSE</p>",
    },
];

const ITEM11_DIRECT_TRANSPORT_REVISION_2_TURNS: [FixtureTurn; 4] = [
    ITEM11_DIRECT_TRANSPORT_REVISION_1_TURNS[0],
    ITEM11_DIRECT_TRANSPORT_REVISION_1_TURNS[1],
    FixtureTurn {
        turn_idx: 2,
        role: "user",
        text: "ITEM11 DIRECT TRANSPORT REVISION 2 — INPUT",
        outer_html: "<p>ITEM11 DIRECT TRANSPORT REVISION 2 — INPUT</p>",
    },
    FixtureTurn {
        turn_idx: 3,
        role: "assistant",
        text: "ITEM11 DIRECT TRANSPORT REVISION 2 — RESPONSE",
        outer_html: "<p>ITEM11 DIRECT TRANSPORT REVISION 2 — RESPONSE</p>",
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FixtureTurn {
    turn_idx: i64,
    role: &'static str,
    text: &'static str,
    outer_html: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FixtureTarget {
    Round2aLegacy,
    Item9LiveCanary3c1,
    Item11DirectTransport,
}

impl FixtureTarget {
    fn parse(value: Option<&str>) -> Option<Self> {
        match value {
            None | Some(CHAT_ID) => Some(Self::Round2aLegacy),
            Some(ITEM9_CANARY_CHAT_ID) => Some(Self::Item9LiveCanary3c1),
            Some(ITEM11_DIRECT_TRANSPORT_CHAT_ID) => Some(Self::Item11DirectTransport),
            Some(_) => None,
        }
    }

    fn definition(self) -> &'static FixtureDefinition {
        match self {
            Self::Round2aLegacy => &ROUND2A_LEGACY_FIXTURE,
            Self::Item9LiveCanary3c1 => &ITEM9_LIVE_CANARY_FIXTURE,
            Self::Item11DirectTransport => &ITEM11_DIRECT_TRANSPORT_FIXTURE,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FixtureDefinition {
    object_id: &'static str,
    title: &'static str,
    revision_1_id: &'static str,
    revision_2_id: &'static str,
    revision_1_millis: i64,
    revision_2_millis: i64,
    revision_1_turns: &'static [FixtureTurn],
    revision_2_turns: &'static [FixtureTurn],
}

const ROUND2A_LEGACY_FIXTURE: FixtureDefinition = FixtureDefinition {
    object_id: CHAT_ID,
    title: CHAT_TITLE,
    revision_1_id: REVISION_1_ID,
    revision_2_id: REVISION_2_ID,
    revision_1_millis: REVISION_1_MILLIS,
    revision_2_millis: REVISION_2_MILLIS,
    revision_1_turns: &REVISION_1_TURNS,
    revision_2_turns: &REVISION_2_TURNS,
};

const ITEM9_LIVE_CANARY_FIXTURE: FixtureDefinition = FixtureDefinition {
    object_id: ITEM9_CANARY_CHAT_ID,
    title: ITEM9_CANARY_CHAT_TITLE,
    revision_1_id: ITEM9_CANARY_REVISION_1_ID,
    revision_2_id: ITEM9_CANARY_REVISION_2_ID,
    revision_1_millis: ITEM9_CANARY_REVISION_1_MILLIS,
    revision_2_millis: ITEM9_CANARY_REVISION_2_MILLIS,
    revision_1_turns: &ITEM9_CANARY_REVISION_1_TURNS,
    revision_2_turns: &ITEM9_CANARY_REVISION_2_TURNS,
};

const ITEM11_DIRECT_TRANSPORT_FIXTURE: FixtureDefinition = FixtureDefinition {
    object_id: ITEM11_DIRECT_TRANSPORT_CHAT_ID,
    title: ITEM11_DIRECT_TRANSPORT_CHAT_TITLE,
    revision_1_id: ITEM11_DIRECT_TRANSPORT_REVISION_1_ID,
    revision_2_id: ITEM11_DIRECT_TRANSPORT_REVISION_2_ID,
    revision_1_millis: ITEM11_DIRECT_TRANSPORT_REVISION_1_MILLIS,
    revision_2_millis: ITEM11_DIRECT_TRANSPORT_REVISION_2_MILLIS,
    revision_1_turns: &ITEM11_DIRECT_TRANSPORT_REVISION_1_TURNS,
    revision_2_turns: &ITEM11_DIRECT_TRANSPORT_REVISION_2_TURNS,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FixtureAction {
    PrepareRevision1,
    AdvanceRevision2,
}

impl FixtureAction {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "prepare-revision-1" => Some(Self::PrepareRevision1),
            "advance-revision-2" => Some(Self::AdvanceRevision2),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::PrepareRevision1 => "prepare-revision-1",
            Self::AdvanceRevision2 => "advance-revision-2",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FixtureState {
    Absent,
    Revision1Current,
    Revision2Current,
}

impl FixtureState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Revision1Current => "revision-1-current",
            Self::Revision2Current => "revision-2-current",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FixtureFailure {
    ActionInvalid,
    TargetInvalid,
    ChatDivergent,
    SnapshotDivergent,
    TurnsDivergent,
    RelationshipsPresent,
    PartialState,
    PointerDivergent,
    TransactionFailed,
    VerificationFailed,
    DatabaseUnavailable,
}

impl FixtureFailure {
    fn code(self) -> &'static str {
        match self {
            Self::ActionInvalid => "round2a-fixture-action-invalid",
            Self::TargetInvalid => "round2a-fixture-target-invalid",
            Self::ChatDivergent => "round2a-fixture-chat-divergent",
            Self::SnapshotDivergent => "round2a-fixture-snapshot-divergent",
            Self::TurnsDivergent => "round2a-fixture-turns-divergent",
            Self::RelationshipsPresent => "round2a-fixture-relationships-present",
            Self::PartialState => "round2a-fixture-partial-state",
            Self::PointerDivergent => "round2a-fixture-pointer-divergent",
            Self::TransactionFailed => "round2a-fixture-transaction-failed",
            Self::VerificationFailed => "round2a-fixture-verification-failed",
            Self::DatabaseUnavailable => "round2a-fixture-database-unavailable",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum InjectedFailure {
    AfterSnapshotInsert,
    BeforePointerUpdate,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Round2aFixtureResult {
    schema: &'static str,
    ok: bool,
    verdict: &'static str,
    action: &'static str,
    fixture_status: &'static str,
    object_id: &'static str,
    revision_id: Option<&'static str>,
    created_chat: bool,
    created_revision: bool,
    pointer_advanced: bool,
    verified: bool,
    no_network: bool,
    error_code: Option<&'static str>,
}

impl Round2aFixtureResult {
    fn success(
        definition: &FixtureDefinition,
        action: FixtureAction,
        state: FixtureState,
        verdict: &'static str,
        created_chat: bool,
        created_revision: bool,
        pointer_advanced: bool,
    ) -> Self {
        Self {
            schema: "h2o.round2a.local-synthetic-fixture-result.v1",
            ok: true,
            verdict,
            action: action.as_str(),
            fixture_status: state.as_str(),
            object_id: definition.object_id,
            revision_id: Some(match state {
                FixtureState::Revision1Current => definition.revision_1_id,
                FixtureState::Revision2Current => definition.revision_2_id,
                FixtureState::Absent => "",
            }),
            created_chat,
            created_revision,
            pointer_advanced,
            verified: true,
            no_network: true,
            error_code: None,
        }
    }

    fn blocked(
        definition: &FixtureDefinition,
        action: &'static str,
        failure: FixtureFailure,
    ) -> Self {
        Self {
            schema: "h2o.round2a.local-synthetic-fixture-result.v1",
            ok: false,
            verdict: "blocked-divergent",
            action,
            fixture_status: "divergent",
            object_id: definition.object_id,
            revision_id: None,
            created_chat: false,
            created_revision: false,
            pointer_advanced: false,
            verified: false,
            no_network: true,
            error_code: Some(failure.code()),
        }
    }
}

fn is_empty_json_object(raw: &str) -> bool {
    matches!(
        serde_json::from_str::<JsonValue>(raw),
        Ok(JsonValue::Object(ref map)) if map.is_empty()
    )
}

async fn count_query(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    sql: &str,
    value: &str,
) -> Result<i64, FixtureFailure> {
    sqlx::query_scalar::<_, i64>(sql)
        .bind(value)
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| FixtureFailure::VerificationFailed)
}

async fn relationships_absent(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    definition: &FixtureDefinition,
) -> Result<bool, FixtureFailure> {
    let binding_counts = [
        count_query(
            tx,
            "SELECT COUNT(*) FROM folder_bindings WHERE chat_id = ?",
            definition.object_id,
        )
        .await?,
        count_query(
            tx,
            "SELECT COUNT(*) FROM label_bindings WHERE chat_id = ?",
            definition.object_id,
        )
        .await?,
        count_query(
            tx,
            "SELECT COUNT(*) FROM tag_bindings WHERE chat_id = ?",
            definition.object_id,
        )
        .await?,
    ];
    let asset_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM snapshot_turn_assets WHERE snapshot_id IN (?, ?)",
    )
    .bind(definition.revision_1_id)
    .bind(definition.revision_2_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| FixtureFailure::VerificationFailed)?;
    Ok(binding_counts.iter().all(|count| *count == 0) && asset_count == 0)
}

async fn verify_turns(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    snapshot_id: &str,
    expected: &[FixtureTurn],
) -> Result<bool, FixtureFailure> {
    let rows = sqlx::query(
        "SELECT turn_idx, role, outer_html, text, meta_json \
         FROM snapshot_turns WHERE snapshot_id = ? ORDER BY turn_idx ASC",
    )
    .bind(snapshot_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|_| FixtureFailure::VerificationFailed)?;
    if rows.len() != expected.len() {
        return Ok(false);
    }
    for (row, turn) in rows.iter().zip(expected.iter()) {
        let turn_idx: i64 = row
            .try_get("turn_idx")
            .map_err(|_| FixtureFailure::VerificationFailed)?;
        let role: String = row
            .try_get("role")
            .map_err(|_| FixtureFailure::VerificationFailed)?;
        let outer_html: String = row
            .try_get("outer_html")
            .map_err(|_| FixtureFailure::VerificationFailed)?;
        let text: String = row
            .try_get("text")
            .map_err(|_| FixtureFailure::VerificationFailed)?;
        let meta_json: String = row
            .try_get("meta_json")
            .map_err(|_| FixtureFailure::VerificationFailed)?;
        if turn_idx != turn.turn_idx
            || role != turn.role
            || outer_html != turn.outer_html
            || text != turn.text
            || !is_empty_json_object(&meta_json)
        {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn verify_target_snapshot(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    definition: &FixtureDefinition,
    snapshot_id: &str,
    timestamp_millis: i64,
    turns: &[FixtureTurn],
) -> Result<bool, FixtureFailure> {
    let row = sqlx::query(
        "SELECT id, chat_id, title, digest, message_count, pinned, legacy, \
         captured_at, updated_at, meta_json FROM snapshots WHERE id = ? LIMIT 1",
    )
    .bind(snapshot_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| FixtureFailure::VerificationFailed)?;
    let Some(row) = row else {
        return Ok(false);
    };
    let id: String = row
        .try_get("id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let chat_id: String = row
        .try_get("chat_id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let title: String = row
        .try_get("title")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let digest: Option<String> = row
        .try_get("digest")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let message_count: i64 = row
        .try_get("message_count")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let pinned: i64 = row
        .try_get("pinned")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let legacy: i64 = row
        .try_get("legacy")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let captured_at: i64 = row
        .try_get("captured_at")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let updated_at: i64 = row
        .try_get("updated_at")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let meta_json: String = row
        .try_get("meta_json")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    Ok(id == snapshot_id
        && chat_id == definition.object_id
        && title == definition.title
        && digest.is_none()
        && message_count == turns.len() as i64
        && pinned == 0
        && legacy == 0
        && captured_at == timestamp_millis
        && updated_at == timestamp_millis
        && is_empty_json_object(&meta_json)
        && verify_turns(tx, snapshot_id, turns).await?)
}

async fn verify_snapshot(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    snapshot_id: &str,
    timestamp_millis: i64,
    turns: &[FixtureTurn],
) -> Result<bool, FixtureFailure> {
    verify_target_snapshot(
        tx,
        &ROUND2A_LEGACY_FIXTURE,
        snapshot_id,
        timestamp_millis,
        turns,
    )
    .await
}

async fn verify_chat(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    definition: &FixtureDefinition,
    state: FixtureState,
) -> Result<bool, FixtureFailure> {
    let row = sqlx::query(
        "SELECT id, source_id, title, created_at, updated_at, last_message_at, \
         message_count, user_turn_count, assistant_turn_count, is_pinned, \
         is_archived, is_starred, is_deleted, folder_id, category_id, project_id, \
         current_leaf_id, import_batch_id, meta_json, is_saved, is_linked, \
         linked_at, linked_from, link_source_href, href, normalized_href, \
         snapshot_count, last_snapshot_id, last_captured_at \
         FROM chats WHERE id = ? LIMIT 1",
    )
    .bind(definition.object_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| FixtureFailure::VerificationFailed)?;
    let Some(row) = row else {
        return Ok(false);
    };
    let (revision_id, timestamp, message_count, snapshot_count) = match state {
        FixtureState::Revision1Current => (
            definition.revision_1_id,
            definition.revision_1_millis,
            2_i64,
            1_i64,
        ),
        FixtureState::Revision2Current => (
            definition.revision_2_id,
            definition.revision_2_millis,
            4_i64,
            2_i64,
        ),
        FixtureState::Absent => return Ok(false),
    };
    let id: String = row
        .try_get("id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let title: String = row
        .try_get("title")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let source_id: Option<String> = row
        .try_get("source_id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let folder_id: Option<String> = row
        .try_get("folder_id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let category_id: Option<String> = row
        .try_get("category_id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let current_leaf_id: Option<String> = row
        .try_get("current_leaf_id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let import_batch_id: Option<String> = row
        .try_get("import_batch_id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let href: Option<String> = row
        .try_get("href")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let normalized_href: Option<String> = row
        .try_get("normalized_href")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let project_id: String = row
        .try_get("project_id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let linked_from: String = row
        .try_get("linked_from")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let link_source_href: String = row
        .try_get("link_source_href")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let meta_json: String = row
        .try_get("meta_json")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let last_snapshot_id: Option<String> = row
        .try_get("last_snapshot_id")
        .map_err(|_| FixtureFailure::VerificationFailed)?;

    for column in [
        "is_pinned",
        "is_archived",
        "is_starred",
        "is_deleted",
        "linked_at",
    ] {
        let value: i64 = row
            .try_get(column)
            .map_err(|_| FixtureFailure::VerificationFailed)?;
        if value != 0 {
            return Ok(false);
        }
    }
    let created_at: i64 = row
        .try_get("created_at")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let updated_at: i64 = row
        .try_get("updated_at")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let last_message_at: i64 = row
        .try_get("last_message_at")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let row_message_count: i64 = row
        .try_get("message_count")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let user_turn_count: i64 = row
        .try_get("user_turn_count")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let assistant_turn_count: i64 = row
        .try_get("assistant_turn_count")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let is_saved: i64 = row
        .try_get("is_saved")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let is_linked: i64 = row
        .try_get("is_linked")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let row_snapshot_count: i64 = row
        .try_get("snapshot_count")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    let last_captured_at: i64 = row
        .try_get("last_captured_at")
        .map_err(|_| FixtureFailure::VerificationFailed)?;
    Ok(id == definition.object_id
        && source_id.is_none()
        && title == definition.title
        && created_at == definition.revision_1_millis
        && updated_at == timestamp
        && last_message_at == timestamp
        && row_message_count == message_count
        && user_turn_count == message_count / 2
        && assistant_turn_count == message_count / 2
        && folder_id.is_none()
        && category_id.is_none()
        && project_id.is_empty()
        && current_leaf_id.is_none()
        && import_batch_id.is_none()
        && is_empty_json_object(&meta_json)
        && is_saved == 1
        && is_linked == 1
        && linked_from.is_empty()
        && link_source_href.is_empty()
        && href.is_none()
        && normalized_href.is_none()
        && row_snapshot_count == snapshot_count
        && last_snapshot_id.as_deref() == Some(revision_id)
        && last_captured_at == timestamp)
}

async fn count_fixture_snapshots(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    definition: &FixtureDefinition,
) -> Result<i64, FixtureFailure> {
    count_query(
        tx,
        "SELECT COUNT(*) FROM snapshots WHERE chat_id = ?",
        definition.object_id,
    )
    .await
}

async fn classify_target_state(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    definition: &FixtureDefinition,
) -> Result<FixtureState, FixtureFailure> {
    if !relationships_absent(tx, definition).await? {
        return Err(FixtureFailure::RelationshipsPresent);
    }
    let chat_count = count_query(
        tx,
        "SELECT COUNT(*) FROM chats WHERE id = ?",
        definition.object_id,
    )
    .await?;
    let r1_snapshot_count = count_query(
        tx,
        "SELECT COUNT(*) FROM snapshots WHERE id = ?",
        definition.revision_1_id,
    )
    .await?;
    let r2_snapshot_count = count_query(
        tx,
        "SELECT COUNT(*) FROM snapshots WHERE id = ?",
        definition.revision_2_id,
    )
    .await?;
    let r1_turn_count = count_query(
        tx,
        "SELECT COUNT(*) FROM snapshot_turns WHERE snapshot_id = ?",
        definition.revision_1_id,
    )
    .await?;
    let r2_turn_count = count_query(
        tx,
        "SELECT COUNT(*) FROM snapshot_turns WHERE snapshot_id = ?",
        definition.revision_2_id,
    )
    .await?;
    if chat_count == 0
        && r1_snapshot_count == 0
        && r2_snapshot_count == 0
        && r1_turn_count == 0
        && r2_turn_count == 0
    {
        return Ok(FixtureState::Absent);
    }
    if chat_count != 1 || r1_snapshot_count != 1 {
        return Err(FixtureFailure::PartialState);
    }
    let fixture_snapshot_count = count_fixture_snapshots(tx, definition).await?;
    let r1_exact = verify_target_snapshot(
        tx,
        definition,
        definition.revision_1_id,
        definition.revision_1_millis,
        definition.revision_1_turns,
    )
    .await?;
    if !r1_exact {
        return Err(
            if r1_turn_count == definition.revision_1_turns.len() as i64 {
                FixtureFailure::SnapshotDivergent
            } else {
                FixtureFailure::TurnsDivergent
            },
        );
    }
    if r2_snapshot_count == 0 && r2_turn_count == 0 && fixture_snapshot_count == 1 {
        if verify_chat(tx, definition, FixtureState::Revision1Current).await? {
            return Ok(FixtureState::Revision1Current);
        }
        return Err(FixtureFailure::ChatDivergent);
    }
    if r2_snapshot_count != 1 || fixture_snapshot_count != 2 {
        return Err(FixtureFailure::PartialState);
    }
    if !verify_target_snapshot(
        tx,
        definition,
        definition.revision_2_id,
        definition.revision_2_millis,
        definition.revision_2_turns,
    )
    .await?
    {
        return Err(
            if r2_turn_count == definition.revision_2_turns.len() as i64 {
                FixtureFailure::SnapshotDivergent
            } else {
                FixtureFailure::TurnsDivergent
            },
        );
    }
    if verify_chat(tx, definition, FixtureState::Revision2Current).await? {
        return Ok(FixtureState::Revision2Current);
    }
    Err(FixtureFailure::PointerDivergent)
}

async fn classify_state(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
) -> Result<FixtureState, FixtureFailure> {
    classify_target_state(tx, &ROUND2A_LEGACY_FIXTURE).await
}

pub(crate) async fn is_exact_revision_1(tx: &mut Transaction<'_, sqlx::Sqlite>) -> bool {
    matches!(classify_state(tx).await, Ok(FixtureState::Revision1Current))
}

async fn insert_turns(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    snapshot_id: &str,
    turns: &[FixtureTurn],
) -> Result<(), FixtureFailure> {
    for turn in turns {
        let inserted = sqlx::query(
            "INSERT INTO snapshot_turns \
             (snapshot_id, turn_idx, role, outer_html, text, meta_json) \
             VALUES (?, ?, ?, ?, ?, '{}')",
        )
        .bind(snapshot_id)
        .bind(turn.turn_idx)
        .bind(turn.role)
        .bind(turn.outer_html)
        .bind(turn.text)
        .execute(&mut **tx)
        .await
        .map_err(|_| FixtureFailure::TransactionFailed)?;
        if inserted.rows_affected() != 1 {
            return Err(FixtureFailure::TransactionFailed);
        }
    }
    Ok(())
}

async fn insert_snapshot(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    definition: &FixtureDefinition,
    snapshot_id: &str,
    timestamp_millis: i64,
    turns: &[FixtureTurn],
) -> Result<(), FixtureFailure> {
    let inserted = sqlx::query(
        "INSERT INTO snapshots \
         (id, chat_id, title, digest, message_count, pinned, legacy, captured_at, updated_at, meta_json) \
         VALUES (?, ?, ?, NULL, ?, 0, 0, ?, ?, '{}')",
    )
    .bind(snapshot_id)
    .bind(definition.object_id)
    .bind(definition.title)
    .bind(turns.len() as i64)
    .bind(timestamp_millis)
    .bind(timestamp_millis)
    .execute(&mut **tx)
    .await
    .map_err(|_| FixtureFailure::TransactionFailed)?;
    if inserted.rows_affected() != 1 {
        return Err(FixtureFailure::TransactionFailed);
    }
    insert_turns(tx, snapshot_id, turns).await
}

async fn insert_revision_1(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    definition: &FixtureDefinition,
) -> Result<(), FixtureFailure> {
    let inserted = sqlx::query(
        "INSERT INTO chats \
         (id, source_id, title, created_at, updated_at, last_message_at, message_count, \
          user_turn_count, assistant_turn_count, is_pinned, is_archived, is_starred, \
          is_deleted, folder_id, category_id, project_id, current_leaf_id, import_batch_id, \
          meta_json, is_saved, is_linked, linked_at, linked_from, link_source_href, href, \
          normalized_href, snapshot_count, last_snapshot_id, last_captured_at) \
         VALUES (?, NULL, ?, ?, ?, ?, 2, 1, 1, 0, 0, 0, 0, NULL, NULL, '', NULL, NULL, \
                 '{}', 1, 1, 0, '', '', NULL, NULL, 1, ?, ?)",
    )
    .bind(definition.object_id)
    .bind(definition.title)
    .bind(definition.revision_1_millis)
    .bind(definition.revision_1_millis)
    .bind(definition.revision_1_millis)
    .bind(definition.revision_1_id)
    .bind(definition.revision_1_millis)
    .execute(&mut **tx)
    .await
    .map_err(|_| FixtureFailure::TransactionFailed)?;
    if inserted.rows_affected() != 1 {
        return Err(FixtureFailure::TransactionFailed);
    }
    insert_snapshot(
        tx,
        definition,
        definition.revision_1_id,
        definition.revision_1_millis,
        definition.revision_1_turns,
    )
    .await
}

async fn advance_revision_2(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    definition: &FixtureDefinition,
    injected_failure: Option<InjectedFailure>,
) -> Result<(), FixtureFailure> {
    insert_snapshot(
        tx,
        definition,
        definition.revision_2_id,
        definition.revision_2_millis,
        definition.revision_2_turns,
    )
    .await?;
    if injected_failure == Some(InjectedFailure::AfterSnapshotInsert) {
        return Err(FixtureFailure::TransactionFailed);
    }
    let revision_2_verified = if definition.object_id == CHAT_ID {
        verify_snapshot(tx, REVISION_2_ID, REVISION_2_MILLIS, &REVISION_2_TURNS).await?
    } else {
        verify_target_snapshot(
            tx,
            definition,
            definition.revision_2_id,
            definition.revision_2_millis,
            definition.revision_2_turns,
        )
        .await?
    };
    if !revision_2_verified {
        return Err(FixtureFailure::VerificationFailed);
    }
    if injected_failure == Some(InjectedFailure::BeforePointerUpdate) {
        return Err(FixtureFailure::TransactionFailed);
    }
    let updated = sqlx::query(
        "UPDATE chats SET last_snapshot_id = ?, snapshot_count = 2, message_count = 4, \
         user_turn_count = 2, assistant_turn_count = 2, updated_at = ?, \
         last_message_at = ?, last_captured_at = ? \
         WHERE id = ? AND last_snapshot_id = ?",
    )
    .bind(definition.revision_2_id)
    .bind(definition.revision_2_millis)
    .bind(definition.revision_2_millis)
    .bind(definition.revision_2_millis)
    .bind(definition.object_id)
    .bind(definition.revision_1_id)
    .execute(&mut **tx)
    .await
    .map_err(|_| FixtureFailure::TransactionFailed)?;
    if updated.rows_affected() != 1 {
        return Err(FixtureFailure::PointerDivergent);
    }
    Ok(())
}

async fn run_fixture_transaction(
    conn: &mut SqliteConnection,
    target: FixtureTarget,
    action: FixtureAction,
    injected_failure: Option<InjectedFailure>,
) -> Result<Round2aFixtureResult, FixtureFailure> {
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| FixtureFailure::TransactionFailed)?;
    let definition = target.definition();
    let initial = match target {
        FixtureTarget::Round2aLegacy => classify_state(&mut tx).await?,
        FixtureTarget::Item9LiveCanary3c1 | FixtureTarget::Item11DirectTransport => {
            classify_target_state(&mut tx, definition).await?
        }
    };
    let result = match (action, initial) {
        (FixtureAction::PrepareRevision1, FixtureState::Absent) => {
            insert_revision_1(&mut tx, definition).await?;
            if target == FixtureTarget::Round2aLegacy
                && classify_state(&mut tx).await? != FixtureState::Revision1Current
            {
                return Err(FixtureFailure::VerificationFailed);
            }
            if target != FixtureTarget::Round2aLegacy
                && classify_target_state(&mut tx, definition).await?
                    != FixtureState::Revision1Current
            {
                return Err(FixtureFailure::VerificationFailed);
            }
            Round2aFixtureResult::success(
                definition,
                action,
                FixtureState::Revision1Current,
                "created",
                true,
                true,
                false,
            )
        }
        (FixtureAction::PrepareRevision1, FixtureState::Revision1Current) => {
            Round2aFixtureResult::success(
                definition,
                action,
                FixtureState::Revision1Current,
                "verified-no-op",
                false,
                false,
                false,
            )
        }
        (FixtureAction::PrepareRevision1, FixtureState::Revision2Current) => {
            return Err(FixtureFailure::PointerDivergent);
        }
        (FixtureAction::AdvanceRevision2, FixtureState::Revision1Current) => {
            advance_revision_2(&mut tx, definition, injected_failure).await?;
            if target == FixtureTarget::Round2aLegacy
                && classify_state(&mut tx).await? != FixtureState::Revision2Current
            {
                return Err(FixtureFailure::VerificationFailed);
            }
            if target != FixtureTarget::Round2aLegacy
                && classify_target_state(&mut tx, definition).await?
                    != FixtureState::Revision2Current
            {
                return Err(FixtureFailure::VerificationFailed);
            }
            Round2aFixtureResult::success(
                definition,
                action,
                FixtureState::Revision2Current,
                "advanced",
                false,
                true,
                true,
            )
        }
        (FixtureAction::AdvanceRevision2, FixtureState::Revision2Current) => {
            Round2aFixtureResult::success(
                definition,
                action,
                FixtureState::Revision2Current,
                "verified-no-op",
                false,
                false,
                false,
            )
        }
        (FixtureAction::AdvanceRevision2, FixtureState::Absent) => {
            return Err(FixtureFailure::PartialState);
        }
    };
    tx.commit()
        .await
        .map_err(|_| FixtureFailure::TransactionFailed)?;
    Ok(result)
}

#[tauri::command]
pub async fn h2o_round2a_author_local_fixture(
    db_instances: State<'_, DbInstances>,
    action: String,
    target: Option<String>,
) -> Result<Round2aFixtureResult, String> {
    let Some(parsed_target) = FixtureTarget::parse(target.as_deref()) else {
        return Ok(Round2aFixtureResult::blocked(
            &ROUND2A_LEGACY_FIXTURE,
            "invalid",
            FixtureFailure::TargetInvalid,
        ));
    };
    let definition = parsed_target.definition();
    let Some(parsed_action) = FixtureAction::parse(action.trim()) else {
        return Ok(Round2aFixtureResult::blocked(
            definition,
            "invalid",
            FixtureFailure::ActionInvalid,
        ));
    };
    let pool = {
        let instances = db_instances.0.read().await;
        let Some(db) = instances.get(DB_URL) else {
            return Ok(Round2aFixtureResult::blocked(
                definition,
                parsed_action.as_str(),
                FixtureFailure::DatabaseUnavailable,
            ));
        };
        match db {
            DbPool::Sqlite(pool) => pool.clone(),
            #[allow(unreachable_patterns)]
            _ => {
                return Ok(Round2aFixtureResult::blocked(
                    definition,
                    parsed_action.as_str(),
                    FixtureFailure::DatabaseUnavailable,
                ))
            }
        }
    };
    let mut conn = match pool.acquire().await {
        Ok(conn) => conn,
        Err(_) => {
            return Ok(Round2aFixtureResult::blocked(
                definition,
                parsed_action.as_str(),
                FixtureFailure::DatabaseUnavailable,
            ))
        }
    };
    match run_fixture_transaction(&mut conn, parsed_target, parsed_action, None).await {
        Ok(result) => Ok(result),
        Err(failure) => Ok(Round2aFixtureResult::blocked(
            definition,
            parsed_action.as_str(),
            failure,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    async fn database() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:")
            .await
            .expect("in-memory fixture database");
        for sql in [
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
            "CREATE TABLE snapshot_turn_assets (
              snapshot_id TEXT NOT NULL, turn_idx INTEGER NOT NULL, sha256 TEXT NOT NULL
            )",
            "CREATE TABLE unrelated_records (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
            "INSERT INTO unrelated_records (id, value) VALUES ('keep', 'byte-identical')",
        ] {
            sqlx::query(sql)
                .execute(&mut conn)
                .await
                .expect("fixture schema");
        }
        conn
    }

    async fn run(
        conn: &mut SqliteConnection,
        action: FixtureAction,
    ) -> Result<Round2aFixtureResult, FixtureFailure> {
        run_fixture_transaction(conn, FixtureTarget::Round2aLegacy, action, None).await
    }

    async fn run_canary(
        conn: &mut SqliteConnection,
        action: FixtureAction,
    ) -> Result<Round2aFixtureResult, FixtureFailure> {
        run_fixture_transaction(conn, FixtureTarget::Item9LiveCanary3c1, action, None).await
    }

    async fn run_item11(
        conn: &mut SqliteConnection,
        action: FixtureAction,
    ) -> Result<Round2aFixtureResult, FixtureFailure> {
        run_fixture_transaction(conn, FixtureTarget::Item11DirectTransport, action, None).await
    }

    async fn scalar(conn: &mut SqliteConnection, sql: &str) -> i64 {
        sqlx::query_scalar(sql)
            .fetch_one(conn)
            .await
            .expect("scalar")
    }

    #[test]
    fn constants_are_exact() {
        assert_eq!(CHAT_ID, "round2a-acceptance-synthetic-chat-20260727");
        assert_eq!(CHAT_TITLE, "Round 2A Acceptance — Synthetic");
        assert_eq!(
            REVISION_1_ID,
            "round2a-acceptance-synthetic-chat-20260727-r1"
        );
        assert_eq!(
            REVISION_2_ID,
            "round2a-acceptance-synthetic-chat-20260727-r2"
        );
        assert_eq!(REVISION_1_ISO, "2026-07-27T12:00:00.000Z");
        assert_eq!(REVISION_2_ISO, "2026-07-27T12:01:00.000Z");
        assert_eq!(REVISION_1_TURNS.len(), 2);
        assert_eq!(REVISION_2_TURNS.len(), 4);
        assert_eq!(REVISION_2_TURNS[..2], REVISION_1_TURNS);
        assert_eq!(ITEM9_CANARY_CHAT_ID, "round2-item9-live-canary-3c1-v1");
        assert_eq!(
            ITEM9_CANARY_CHAT_TITLE,
            "Round 2 Item 9 Live Canary 3C1 — Synthetic"
        );
        assert_eq!(
            ITEM9_CANARY_REVISION_1_ID,
            "round2-item9-live-canary-3c1-v1-r1"
        );
        assert_eq!(
            ITEM9_CANARY_REVISION_2_ID,
            "round2-item9-live-canary-3c1-v1-r2"
        );
        assert_eq!(ITEM9_CANARY_REVISION_1_ISO, "2026-07-30T12:00:00.000Z");
        assert_eq!(ITEM9_CANARY_REVISION_2_ISO, "2026-07-30T12:01:00.000Z");
        assert_eq!(ITEM9_CANARY_REVISION_1_TURNS.len(), 2);
        assert_eq!(ITEM9_CANARY_REVISION_2_TURNS.len(), 4);
        assert_eq!(
            ITEM9_CANARY_REVISION_2_TURNS[..2],
            ITEM9_CANARY_REVISION_1_TURNS
        );
        assert_eq!(
            ITEM11_DIRECT_TRANSPORT_CHAT_ID,
            "round2-item11-direct-transport-v1"
        );
        assert_eq!(
            ITEM11_DIRECT_TRANSPORT_CHAT_TITLE,
            "Round 2 Item 11 Direct Transport — Synthetic"
        );
        assert_eq!(
            ITEM11_DIRECT_TRANSPORT_REVISION_1_ID,
            "round2-item11-direct-transport-v1-r1"
        );
        assert_eq!(
            ITEM11_DIRECT_TRANSPORT_REVISION_2_ID,
            "round2-item11-direct-transport-v1-r2"
        );
        assert_eq!(
            ITEM11_DIRECT_TRANSPORT_REVISION_1_ISO,
            "2026-08-03T12:00:00.000Z"
        );
        assert_eq!(
            ITEM11_DIRECT_TRANSPORT_REVISION_2_ISO,
            "2026-08-03T12:01:00.000Z"
        );
        assert_eq!(ITEM11_DIRECT_TRANSPORT_REVISION_1_TURNS.len(), 2);
        assert_eq!(ITEM11_DIRECT_TRANSPORT_REVISION_2_TURNS.len(), 4);
        assert_eq!(
            ITEM11_DIRECT_TRANSPORT_REVISION_2_TURNS[..2],
            ITEM11_DIRECT_TRANSPORT_REVISION_1_TURNS
        );
    }

    #[test]
    fn target_allowlist_preserves_legacy_default_and_rejects_without_reflection() {
        assert_eq!(
            FixtureTarget::parse(None),
            Some(FixtureTarget::Round2aLegacy)
        );
        assert_eq!(
            FixtureTarget::parse(Some(CHAT_ID)),
            Some(FixtureTarget::Round2aLegacy)
        );
        assert_eq!(
            FixtureTarget::parse(Some(ITEM9_CANARY_CHAT_ID)),
            Some(FixtureTarget::Item9LiveCanary3c1)
        );
        assert_eq!(
            FixtureTarget::parse(Some(ITEM11_DIRECT_TRANSPORT_CHAT_ID)),
            Some(FixtureTarget::Item11DirectTransport)
        );
        for rejected in [
            "",
            " round2-item9-live-canary-3c1-v1",
            "round2-item9-live-canary-3c1-v1 ",
            ITEM9_CANARY_REVISION_1_ID,
            ITEM9_CANARY_REVISION_2_ID,
            " round2-item11-direct-transport-v1",
            "round2-item11-direct-transport-v1 ",
            ITEM11_DIRECT_TRANSPORT_REVISION_1_ID,
            ITEM11_DIRECT_TRANSPORT_REVISION_2_ID,
            "operator-entered-object",
        ] {
            assert_eq!(FixtureTarget::parse(Some(rejected)), None);
            let blocked = Round2aFixtureResult::blocked(
                &ROUND2A_LEGACY_FIXTURE,
                "invalid",
                FixtureFailure::TargetInvalid,
            );
            let serialized = serde_json::to_string(&blocked).expect("serialize blocked target");
            assert_eq!(blocked.error_code, Some("round2a-fixture-target-invalid"));
            if !rejected.is_empty() {
                assert!(!serialized.contains(rejected));
            }
        }
    }

    #[test]
    fn legacy_revision_1_result_shape_is_byte_compatible() {
        block_on(async {
            let mut conn = database().await;
            let result = run(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("legacy revision 1");
            assert_eq!(
                serde_json::to_value(result).expect("serialize legacy result"),
                serde_json::json!({
                    "schema": "h2o.round2a.local-synthetic-fixture-result.v1",
                    "ok": true,
                    "verdict": "created",
                    "action": "prepare-revision-1",
                    "fixtureStatus": "revision-1-current",
                    "objectId": "round2a-acceptance-synthetic-chat-20260727",
                    "revisionId": "round2a-acceptance-synthetic-chat-20260727-r1",
                    "createdChat": true,
                    "createdRevision": true,
                    "pointerAdvanced": false,
                    "verified": true,
                    "noNetwork": true,
                    "errorCode": null
                })
            );
        });
    }

    #[test]
    fn revision_1_create_and_repeat_noop() {
        block_on(async {
            let mut conn = database().await;
            let created = run(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("create revision 1");
            assert!(created.ok && created.created_chat && created.created_revision);
            assert_eq!(created.fixture_status, "revision-1-current");
            let repeated = run(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("repeat revision 1");
            assert_eq!(repeated.verdict, "verified-no-op");
            assert!(!repeated.created_chat && !repeated.created_revision);
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM snapshots").await, 1);
            assert_eq!(
                scalar(&mut conn, "SELECT COUNT(*) FROM snapshot_turns").await,
                2
            );
        });
    }

    #[test]
    fn revision_1_divergence_fails_closed() {
        block_on(async {
            let mut conn = database().await;
            run(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("seed revision 1");
            sqlx::query("UPDATE snapshots SET title = 'divergent' WHERE id = ?")
                .bind(REVISION_1_ID)
                .execute(&mut conn)
                .await
                .expect("inject divergence");
            let failure = run(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect_err("divergent revision must block");
            assert_eq!(failure, FixtureFailure::SnapshotDivergent);
            assert_eq!(
                scalar(&mut conn, "SELECT COUNT(*) FROM snapshot_turns").await,
                2
            );
        });
    }

    #[test]
    fn revision_2_advance_repeat_and_revision_1_immutability() {
        block_on(async {
            let mut conn = database().await;
            run(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("seed revision 1");
            let before: Vec<(i64, String, String, String)> = sqlx::query(
                "SELECT turn_idx, role, text, outer_html FROM snapshot_turns \
                 WHERE snapshot_id = ? ORDER BY turn_idx",
            )
            .bind(REVISION_1_ID)
            .fetch_all(&mut conn)
            .await
            .expect("revision 1 rows")
            .into_iter()
            .map(|row| {
                (
                    row.get("turn_idx"),
                    row.get("role"),
                    row.get("text"),
                    row.get("outer_html"),
                )
            })
            .collect();
            let advanced = run(&mut conn, FixtureAction::AdvanceRevision2)
                .await
                .expect("advance revision 2");
            assert!(advanced.ok && advanced.created_revision && advanced.pointer_advanced);
            assert_eq!(advanced.fixture_status, "revision-2-current");
            let repeated = run(&mut conn, FixtureAction::AdvanceRevision2)
                .await
                .expect("repeat revision 2");
            assert_eq!(repeated.verdict, "verified-no-op");
            let after: Vec<(i64, String, String, String)> = sqlx::query(
                "SELECT turn_idx, role, text, outer_html FROM snapshot_turns \
                 WHERE snapshot_id = ? ORDER BY turn_idx",
            )
            .bind(REVISION_1_ID)
            .fetch_all(&mut conn)
            .await
            .expect("revision 1 rows after")
            .into_iter()
            .map(|row| {
                (
                    row.get("turn_idx"),
                    row.get("role"),
                    row.get("text"),
                    row.get("outer_html"),
                )
            })
            .collect();
            assert_eq!(before, after);
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM snapshots").await, 2);
            assert_eq!(
                scalar(&mut conn, "SELECT COUNT(*) FROM snapshot_turns").await,
                6
            );
        });
    }

    #[test]
    fn revision_2_divergence_and_relationships_fail_closed() {
        block_on(async {
            let mut conn = database().await;
            run(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("seed revision 1");
            sqlx::query("INSERT INTO folder_bindings (chat_id, folder_id) VALUES (?, 'foreign')")
                .bind(CHAT_ID)
                .execute(&mut conn)
                .await
                .expect("inject relationship");
            assert_eq!(
                run(&mut conn, FixtureAction::AdvanceRevision2)
                    .await
                    .expect_err("relationship must block"),
                FixtureFailure::RelationshipsPresent
            );
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM snapshots").await, 1);
        });
    }

    #[test]
    fn rollback_after_snapshot_insert_and_before_pointer_update() {
        for failure in [
            InjectedFailure::AfterSnapshotInsert,
            InjectedFailure::BeforePointerUpdate,
        ] {
            block_on(async {
                let mut conn = database().await;
                run(&mut conn, FixtureAction::PrepareRevision1)
                    .await
                    .expect("seed revision 1");
                let result = run_fixture_transaction(
                    &mut conn,
                    FixtureTarget::Round2aLegacy,
                    FixtureAction::AdvanceRevision2,
                    Some(failure),
                )
                .await;
                assert_eq!(
                    result.expect_err("injected failure"),
                    FixtureFailure::TransactionFailed
                );
                assert_eq!(
                    scalar(
                        &mut conn,
                        "SELECT COUNT(*) FROM snapshots WHERE id = \
                         'round2a-acceptance-synthetic-chat-20260727-r2'"
                    )
                    .await,
                    0
                );
                let pointer: String =
                    sqlx::query_scalar("SELECT last_snapshot_id FROM chats WHERE id = ?")
                        .bind(CHAT_ID)
                        .fetch_one(&mut conn)
                        .await
                        .expect("pointer");
                assert_eq!(pointer, REVISION_1_ID);
            });
        }
    }

    #[test]
    fn unrelated_data_is_unchanged_and_no_relationships_are_created() {
        block_on(async {
            let mut conn = database().await;
            run(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("seed revision 1");
            run(&mut conn, FixtureAction::AdvanceRevision2)
                .await
                .expect("advance revision 2");
            let unrelated: String =
                sqlx::query_scalar("SELECT value FROM unrelated_records WHERE id = 'keep'")
                    .fetch_one(&mut conn)
                    .await
                    .expect("unrelated row");
            assert_eq!(unrelated, "byte-identical");
            for table in [
                "folder_bindings",
                "label_bindings",
                "tag_bindings",
                "snapshot_turn_assets",
            ] {
                assert_eq!(
                    scalar(&mut conn, &format!("SELECT COUNT(*) FROM {table}")).await,
                    0
                );
            }
        });
    }

    #[test]
    fn foreign_owned_snapshot_and_partial_turn_state_block() {
        block_on(async {
            let mut conn = database().await;
            sqlx::query(
                "INSERT INTO snapshots \
                 (id, chat_id, title, message_count, captured_at, updated_at) \
                 VALUES (?, 'foreign-chat', ?, 2, ?, ?)",
            )
            .bind(REVISION_1_ID)
            .bind(CHAT_TITLE)
            .bind(REVISION_1_MILLIS)
            .bind(REVISION_1_MILLIS)
            .execute(&mut conn)
            .await
            .expect("foreign snapshot");
            assert_eq!(
                run(&mut conn, FixtureAction::PrepareRevision1)
                    .await
                    .expect_err("foreign snapshot blocks"),
                FixtureFailure::PartialState
            );
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM chats").await, 0);
        });
    }

    #[test]
    fn canary_revision_1_create_noop_revision_2_advance_and_noop() {
        block_on(async {
            let mut conn = database().await;
            let created = run_canary(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("create canary revision 1");
            assert_eq!(created.object_id, ITEM9_CANARY_CHAT_ID);
            assert_eq!(created.revision_id, Some(ITEM9_CANARY_REVISION_1_ID));
            assert!(created.created_chat && created.created_revision && !created.pointer_advanced);
            let replay_r1 = run_canary(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("replay canary revision 1");
            assert_eq!(replay_r1.verdict, "verified-no-op");
            let advanced = run_canary(&mut conn, FixtureAction::AdvanceRevision2)
                .await
                .expect("advance canary revision 2");
            assert_eq!(advanced.object_id, ITEM9_CANARY_CHAT_ID);
            assert_eq!(advanced.revision_id, Some(ITEM9_CANARY_REVISION_2_ID));
            assert!(
                !advanced.created_chat && advanced.created_revision && advanced.pointer_advanced
            );
            let replay_r2 = run_canary(&mut conn, FixtureAction::AdvanceRevision2)
                .await
                .expect("replay canary revision 2");
            assert_eq!(replay_r2.verdict, "verified-no-op");
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM snapshots").await, 2);
            assert_eq!(
                scalar(&mut conn, "SELECT COUNT(*) FROM snapshot_turns").await,
                6
            );
        });
    }

    #[test]
    fn item11_revision_1_parentless_then_revision_2_points_to_retained_revision_1() {
        block_on(async {
            let mut conn = database().await;
            let created = run_item11(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("create Item 11 revision 1");
            assert_eq!(created.object_id, ITEM11_DIRECT_TRANSPORT_CHAT_ID);
            assert_eq!(
                created.revision_id,
                Some(ITEM11_DIRECT_TRANSPORT_REVISION_1_ID)
            );
            assert!(created.created_chat && created.created_revision && !created.pointer_advanced);
            assert!(created.no_network && created.verified);
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM chats").await, 1);
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM snapshots").await, 1);
            assert_eq!(
                scalar(
                    &mut conn,
                    "SELECT COUNT(*) FROM snapshots WHERE id = \
                     'round2-item11-direct-transport-v1-r1'"
                )
                .await,
                1
            );
            let r1_pointer: String =
                sqlx::query_scalar("SELECT last_snapshot_id FROM chats WHERE id = ?")
                    .bind(ITEM11_DIRECT_TRANSPORT_CHAT_ID)
                    .fetch_one(&mut conn)
                    .await
                    .expect("Item 11 revision 1 pointer");
            assert_eq!(r1_pointer, ITEM11_DIRECT_TRANSPORT_REVISION_1_ID);

            let replay_r1 = run_item11(&mut conn, FixtureAction::PrepareRevision1)
                .await
                .expect("replay Item 11 revision 1");
            assert_eq!(replay_r1.verdict, "verified-no-op");

            let advanced = run_item11(&mut conn, FixtureAction::AdvanceRevision2)
                .await
                .expect("advance Item 11 revision 2");
            assert_eq!(advanced.object_id, ITEM11_DIRECT_TRANSPORT_CHAT_ID);
            assert_eq!(
                advanced.revision_id,
                Some(ITEM11_DIRECT_TRANSPORT_REVISION_2_ID)
            );
            assert!(
                !advanced.created_chat && advanced.created_revision && advanced.pointer_advanced
            );
            assert!(advanced.no_network && advanced.verified);
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM chats").await, 1);
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM snapshots").await, 2);
            assert_eq!(
                scalar(
                    &mut conn,
                    "SELECT COUNT(*) FROM snapshots WHERE id IN \
                     ('round2-item11-direct-transport-v1-r1', \
                      'round2-item11-direct-transport-v1-r2')"
                )
                .await,
                2
            );
            let r2_pointer: String =
                sqlx::query_scalar("SELECT last_snapshot_id FROM chats WHERE id = ?")
                    .bind(ITEM11_DIRECT_TRANSPORT_CHAT_ID)
                    .fetch_one(&mut conn)
                    .await
                    .expect("Item 11 revision 2 pointer");
            assert_eq!(r2_pointer, ITEM11_DIRECT_TRANSPORT_REVISION_2_ID);

            let replay_r2 = run_item11(&mut conn, FixtureAction::AdvanceRevision2)
                .await
                .expect("replay Item 11 revision 2");
            assert_eq!(replay_r2.verdict, "verified-no-op");
            assert_eq!(scalar(&mut conn, "SELECT COUNT(*) FROM snapshots").await, 2);
        });
    }

    #[test]
    fn canary_divergence_and_cross_target_identity_mix_fail_closed() {
        block_on(async {
            let mut divergent = database().await;
            run_canary(&mut divergent, FixtureAction::PrepareRevision1)
                .await
                .expect("seed canary");
            sqlx::query("UPDATE snapshot_turns SET text = 'divergent' WHERE snapshot_id = ?")
                .bind(ITEM9_CANARY_REVISION_1_ID)
                .execute(&mut divergent)
                .await
                .expect("inject canary divergence");
            assert_eq!(
                run_canary(&mut divergent, FixtureAction::PrepareRevision1)
                    .await
                    .expect_err("canary divergence blocks"),
                FixtureFailure::SnapshotDivergent
            );

            let mut mixed = database().await;
            sqlx::query(
                "INSERT INTO snapshots \
                 (id, chat_id, title, message_count, captured_at, updated_at) \
                 VALUES (?, ?, ?, 2, ?, ?)",
            )
            .bind(ITEM9_CANARY_REVISION_1_ID)
            .bind(CHAT_ID)
            .bind(ITEM9_CANARY_CHAT_TITLE)
            .bind(ITEM9_CANARY_REVISION_1_MILLIS)
            .bind(ITEM9_CANARY_REVISION_1_MILLIS)
            .execute(&mut mixed)
            .await
            .expect("inject cross-target snapshot");
            assert_eq!(
                run_canary(&mut mixed, FixtureAction::PrepareRevision1)
                    .await
                    .expect_err("cross-target state blocks"),
                FixtureFailure::PartialState
            );
        });
    }

    #[test]
    fn canary_rolls_back_at_both_boundaries_and_leaves_unrelated_rows_unchanged() {
        for failure in [
            InjectedFailure::AfterSnapshotInsert,
            InjectedFailure::BeforePointerUpdate,
        ] {
            block_on(async {
                let mut conn = database().await;
                run_canary(&mut conn, FixtureAction::PrepareRevision1)
                    .await
                    .expect("seed canary revision 1");
                let result = run_fixture_transaction(
                    &mut conn,
                    FixtureTarget::Item9LiveCanary3c1,
                    FixtureAction::AdvanceRevision2,
                    Some(failure),
                )
                .await;
                assert_eq!(
                    result.expect_err("injected canary failure"),
                    FixtureFailure::TransactionFailed
                );
                assert_eq!(
                    scalar(
                        &mut conn,
                        "SELECT COUNT(*) FROM snapshots WHERE id = \
                         'round2-item9-live-canary-3c1-v1-r2'"
                    )
                    .await,
                    0
                );
                let pointer: String =
                    sqlx::query_scalar("SELECT last_snapshot_id FROM chats WHERE id = ?")
                        .bind(ITEM9_CANARY_CHAT_ID)
                        .fetch_one(&mut conn)
                        .await
                        .expect("canary pointer");
                assert_eq!(pointer, ITEM9_CANARY_REVISION_1_ID);
                let unrelated: String =
                    sqlx::query_scalar("SELECT value FROM unrelated_records WHERE id = 'keep'")
                        .fetch_one(&mut conn)
                        .await
                        .expect("unrelated row");
                assert_eq!(unrelated, "byte-identical");
                for table in [
                    "folder_bindings",
                    "label_bindings",
                    "tag_bindings",
                    "snapshot_turn_assets",
                ] {
                    assert_eq!(
                        scalar(&mut conn, &format!("SELECT COUNT(*) FROM {table}")).await,
                        0
                    );
                }
            });
        }
    }
}
