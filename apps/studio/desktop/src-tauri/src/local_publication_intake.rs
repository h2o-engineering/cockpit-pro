//! Desktop-only intake for one Chrome-authored local-publication slot.
//!
//! The native command owns the fixed filename and reuses the Item 11 folder
//! authorization binding. Valid publications are observed into an immutable
//! branch ledger. This module never writes the shared folder and never mutates
//! materialized chat, snapshot, turn, or sync baseline state.

use crate::item11_delivery_destination::resolve_authorized_delivery_directory;
use crate::sync_object_document::{
    canonical_head, canonical_value, object_key_hex, sha256_hex, valid_identity,
    valid_writer_identity, PeerWriterRole, SyncHead, SyncRevision, HEAD_SCHEMA, REVISION_SCHEMA,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Connection, Row, SqliteConnection, SqlitePool, Transaction};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::Path;
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

const DB_URL: &str = "sqlite:studio-v1.db";
const PUBLICATION_FILE: &str = "h2o-local-publication.v1.json";
const PUBLICATION_SCHEMA: &str = "h2o.studio.local-publication.v1";
const OBSERVATION_SCHEMA: &str = "h2o.studio.inbound-revision-observation.v1";
const PUBLICATION_SCHEMA_VERSION: u64 = 1;
const MAX_PUBLICATION_BYTES: usize = 8 * 1024 * 1024;
const MAX_HEAD_BYTES: usize = 64 * 1024;
const MAX_REVISION_BYTES: usize = 5 * 1024 * 1024;
// P02 Wave 1 / Z7 implements Decision Point V9 (Evidence Capacity Policy,
// SHA-256 34607b01...). The inherited P01 bounds were 64 rows / 32 MiB, which
// V9 rejected: they fail a 100-revision offline catch-up before any conflict
// load, and a single hard threshold makes an object holding an unresolved fork
// permanently unresolvable, because P02 never deletes evidence.
//
// Same logical policy as the Chrome side and the shared core module, per
// (peer, object): normal budget, then a bounded reserve that only locally
// provable recovery-critical evidence may consume, then an absolute
// fail-closed hard limit. Nothing is ever deleted, compacted or evicted.
const NORMAL_INBOUND_ROWS: i64 = 256;
const NORMAL_INBOUND_CANONICAL_BYTES: i64 = 128 * 1024 * 1024;
const RESERVE_INBOUND_ROWS: i64 = 64;
const RESERVE_INBOUND_CANONICAL_BYTES: i64 = 32 * 1024 * 1024;
const HARD_INBOUND_ROWS: i64 = NORMAL_INBOUND_ROWS + RESERVE_INBOUND_ROWS;
const HARD_INBOUND_CANONICAL_BYTES: i64 =
    NORMAL_INBOUND_CANONICAL_BYTES + RESERVE_INBOUND_CANONICAL_BYTES;

pub const PUBLICATION_ABSENT: &str = "local-publication-absent";
pub const PUBLICATION_REJECTED: &str = "publication-rejected";
pub const REVISION_ADMITTED: &str = "revision-admitted";
pub const REVISION_STAGED_DIVERGENT: &str = "revision-staged-divergent";
pub const IDENTICAL_REPLAY: &str = "identical-replay";
pub const REVISION_IDENTITY_CONFLICT: &str = "revision-identity-conflict";
pub const BASELINE_UNAVAILABLE: &str = "local-baseline-unavailable";
pub const INBOUND_QUOTA_EXCEEDED: &str = "local-publication-inbound-quota-exceeded";
pub const PUBLICATION_INVALID: &str = "local-publication-invalid";
pub const PUBLICATION_FILE_UNSAFE: &str = "local-publication-file-unsafe";
pub const PUBLICATION_FILE_OVERSIZE: &str = "local-publication-file-oversize";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalPublicationEnvelope {
    schema: String,
    publication_schema_version: u64,
    object_id: String,
    head_bytes_base64: String,
    head_sha256_hex: String,
    revision_bytes_base64: String,
    revision_blob_sha256_hex: String,
    produced_at_iso: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct VerifiedPublication {
    object_id: String,
    object_key: String,
    revision_id: String,
    parent_revision_id: Option<String>,
    head_bytes: Vec<u8>,
    revision_bytes: Vec<u8>,
    head_sha256_hex: String,
    revision_blob_sha256_hex: String,
    payload_sha256_hex: String,
    writer_sync_peer_id_sha256_hex: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum BaselinePosture {
    Anchor(Option<String>),
    Deleted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct StoredObservation {
    key: String,
    peer_object_key: String,
    object_id: String,
    object_key: String,
    revision_id: String,
    revision_key: String,
    parent_revision_id: Option<String>,
    parent_key: String,
    admission_disposition: String,
    admission_reason: String,
    head_bytes: Vec<u8>,
    revision_bytes: Vec<u8>,
    head_sha256_hex: String,
    revision_blob_sha256_hex: String,
    payload_sha256_hex: String,
    writer_hash: String,
    observed_state: String,
    apply_state: String,
    first_observed_at: String,
    last_observed_at: String,
    observation_count: i64,
    admitted_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPublicationReceiveResult {
    schema: &'static str,
    ok: bool,
    verdict: &'static str,
    reason: Option<String>,
    object_id: Option<String>,
    revision_id: Option<String>,
    historical_admission: Option<String>,
    unchanged_no_op: bool,
    observation_count: u64,
    no_apply: bool,
    no_network: bool,
}

impl LocalPublicationReceiveResult {
    fn absent() -> Self {
        Self {
            schema: "h2o.studio.local-publication-receive-result.v1",
            ok: true,
            verdict: PUBLICATION_ABSENT,
            reason: None,
            object_id: None,
            revision_id: None,
            historical_admission: None,
            unchanged_no_op: true,
            observation_count: 0,
            no_apply: true,
            no_network: true,
        }
    }

    fn rejected(reason: &str) -> Self {
        Self::failure(PUBLICATION_REJECTED, reason)
    }

    fn failure(verdict: &'static str, reason: &str) -> Self {
        Self {
            schema: "h2o.studio.local-publication-receive-result.v1",
            ok: false,
            verdict,
            reason: Some(reason.to_string()),
            object_id: None,
            revision_id: None,
            historical_admission: None,
            unchanged_no_op: true,
            observation_count: 0,
            no_apply: true,
            no_network: true,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundBranchProjection {
    revision_id: String,
    parent_revision_id: Option<String>,
    historical_admission: String,
    admission_reason: String,
    current_relationship: String,
    revision_blob_sha256_hex: String,
    payload_sha256_hex: String,
    head_sha256_hex: String,
    writer_sync_peer_id_sha256_hex: String,
    apply_state: String,
    first_observed_at: String,
    last_observed_at: String,
    observation_count: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPublicationBranchesResult {
    schema: &'static str,
    ok: bool,
    object_id: String,
    anchor: Option<String>,
    unavailable_reason: Option<String>,
    pending_chain: Vec<String>,
    branches: Vec<InboundBranchProjection>,
    no_apply: bool,
    no_network: bool,
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = crate::synthetic_marker::civil_from_days_pub(now.div_euclid(86_400));
    let seconds = now.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        seconds / 3600,
        (seconds % 3600) / 60,
        seconds % 60
    )
}

fn accepted_timestamp(value: &str) -> bool {
    value.len() >= 20
        && value.len() <= 40
        && value.ends_with('Z')
        && !value.chars().any(char::is_control)
}

fn strict_identity(value: &str) -> bool {
    valid_identity(value) && value.trim() == value
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let value = (b0 << 16) | (b1 << 8) | b2;
        output.push(ALPHABET[((value >> 18) & 63) as usize] as char);
        output.push(ALPHABET[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            ALPHABET[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            ALPHABET[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn base64_decode_exact(value: &str) -> Result<Vec<u8>, &'static str> {
    if value.is_empty() || value.len() % 4 != 0 {
        return Err(PUBLICATION_INVALID);
    }
    let padding = value.bytes().rev().take_while(|byte| *byte == b'=').count();
    if padding > 2
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || byte == b'+'
                || byte == b'/'
                || (byte == b'=' && index >= value.len() - padding)
        })
    {
        return Err(PUBLICATION_INVALID);
    }
    let mut output = Vec::with_capacity(value.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in value.bytes().take_while(|byte| *byte != b'=') {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(PUBLICATION_INVALID),
        };
        buffer = (buffer << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
    }
    if base64_encode(&output) != value {
        return Err(PUBLICATION_INVALID);
    }
    Ok(output)
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.keys().map(String::as_str).collect::<BTreeSet<_>>()
            == expected.iter().copied().collect::<BTreeSet<_>>()
    })
}

fn has_unsupported_relationship(value: &Value) -> bool {
    let forbidden = [
        "asset",
        "assets",
        "attachment",
        "attachments",
        "externalassets",
        "folder",
        "folderid",
        "folderids",
        "folderbinding",
        "folderbindings",
        "label",
        "labels",
        "labelids",
        "tag",
        "tags",
        "tagids",
        "category",
        "categoryid",
        "categoryrelationship",
        "categories",
        "project",
        "projectid",
        "projectids",
        "projectrelationship",
        "projects",
        "organization",
        "organizationstate",
        "organizationid",
        "organizationids",
        "organizationrelationship",
        "organizations",
        "orgid",
        "orgstate",
    ];
    match value {
        Value::Array(values) => values.iter().any(has_unsupported_relationship),
        Value::Object(object) => object.iter().any(|(key, item)| {
            let compact = key
                .chars()
                .filter(|value| value.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect::<String>();
            let populated = !item.is_null()
                && item.as_str() != Some("")
                && item.as_bool() != Some(false)
                && item.as_array().is_none_or(|value| !value.is_empty())
                && item.as_object().is_none_or(|value| !value.is_empty());
            (forbidden.contains(&compact.as_str()) && populated)
                || has_unsupported_relationship(item)
        }),
        _ => false,
    }
}

fn validate_content_payload(
    payload: &Value,
    object_id: &str,
    revision_id: &str,
) -> Result<(), &'static str> {
    let object = payload.as_object().ok_or(PUBLICATION_INVALID)?;
    if !exact_keys(
        payload,
        &["schema", "chatArchive", "chromeStorageLocal", "libraryKv"],
    ) || object.get("schema").and_then(Value::as_str) != Some("h2o.studio.fullBundle.v2")
        || object
            .get("chromeStorageLocal")
            .and_then(Value::as_object)
            .is_none_or(|value| !value.is_empty())
        || object
            .get("libraryKv")
            .and_then(Value::as_array)
            .is_none_or(|value| !value.is_empty())
    {
        return Err(PUBLICATION_INVALID);
    }
    let archive = object
        .get("chatArchive")
        .and_then(Value::as_object)
        .ok_or(PUBLICATION_INVALID)?;
    if !exact_keys(
        object.get("chatArchive").ok_or(PUBLICATION_INVALID)?,
        &["chats", "catalogs"],
    ) {
        return Err(PUBLICATION_INVALID);
    }
    let chats = archive
        .get("chats")
        .and_then(Value::as_array)
        .ok_or(PUBLICATION_INVALID)?;
    let catalogs = archive
        .get("catalogs")
        .and_then(Value::as_object)
        .ok_or(PUBLICATION_INVALID)?;
    if chats.len() != 1
        || !exact_keys(
            archive.get("catalogs").ok_or(PUBLICATION_INVALID)?,
            &["categories", "labels", "tags"],
        )
        || ["categories", "labels", "tags"].iter().any(|key| {
            catalogs
                .get(*key)
                .and_then(Value::as_array)
                .is_none_or(|value| !value.is_empty())
        })
    {
        return Err(PUBLICATION_INVALID);
    }
    let chat = &chats[0];
    let chat_object = chat.as_object().ok_or(PUBLICATION_INVALID)?;
    let chat_index = chat_object.get("chatIndex").ok_or(PUBLICATION_INVALID)?;
    let snapshots = chat_object
        .get("snapshots")
        .and_then(Value::as_array)
        .ok_or(PUBLICATION_INVALID)?;
    if !exact_keys(chat, &["chatId", "title", "chatIndex", "snapshots"])
        || chat_object.get("chatId").and_then(Value::as_str) != Some(object_id)
        || chat_object.get("title").and_then(Value::as_str).is_none()
        || snapshots.len() != 1
        || !exact_keys(
            chat_index,
            &[
                "title",
                "lastSnapshotId",
                "snapshotCount",
                "messageCount",
                "state",
                "organization",
            ],
        )
        || chat_index.get("lastSnapshotId").and_then(Value::as_str) != Some(revision_id)
        || chat_index.get("snapshotCount").and_then(Value::as_u64) != Some(1)
        || !exact_keys(&chat_index["state"], &["isSaved", "isLinked"])
        || chat_index["state"]["isSaved"].as_bool() != Some(true)
        || chat_index["state"]["isLinked"].as_bool() != Some(true)
        || chat_index
            .get("organization")
            .and_then(Value::as_object)
            .is_none_or(|value| !value.is_empty())
    {
        return Err(PUBLICATION_INVALID);
    }
    let snapshot = &snapshots[0];
    let messages = snapshot
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(PUBLICATION_INVALID)?;
    let rich_turns = snapshot
        .get("meta")
        .and_then(|value| value.get("richTurns"))
        .and_then(Value::as_array)
        .ok_or(PUBLICATION_INVALID)?;
    if !exact_keys(
        snapshot,
        &[
            "snapshotId",
            "chatId",
            "createdAt",
            "messageCount",
            "messages",
            "meta",
        ],
    ) || snapshot.get("snapshotId").and_then(Value::as_str) != Some(revision_id)
        || snapshot.get("chatId").and_then(Value::as_str) != Some(object_id)
        || snapshot
            .get("createdAt")
            .and_then(Value::as_str)
            .is_none_or(|value| !accepted_timestamp(value))
        || messages.is_empty()
        || snapshot.get("messageCount").and_then(Value::as_u64) != Some(messages.len() as u64)
        || chat_index.get("messageCount").and_then(Value::as_u64) != Some(messages.len() as u64)
        || !exact_keys(&snapshot["meta"], &["title", "richTurns"])
        || snapshot["meta"]
            .get("title")
            .and_then(Value::as_str)
            .is_none()
        || rich_turns.len() != messages.len()
    {
        return Err(PUBLICATION_INVALID);
    }
    let mut orders = HashSet::new();
    for (message, detail) in messages.iter().zip(rich_turns) {
        let order = message
            .get("order")
            .and_then(Value::as_u64)
            .ok_or(PUBLICATION_INVALID)?;
        if !exact_keys(message, &["order", "role", "text"])
            || !orders.insert(order)
            || message
                .get("role")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            || message.get("text").and_then(Value::as_str).is_none()
            || !exact_keys(detail, &["turnIdx", "role", "outerHTML", "meta"])
            || detail.get("turnIdx").and_then(Value::as_u64) != Some(order)
            || detail.get("role").and_then(Value::as_str)
                != message.get("role").and_then(Value::as_str)
            || detail.get("outerHTML").and_then(Value::as_str).is_none()
            || detail.get("meta").and_then(Value::as_object).is_none()
            || (message.get("text").and_then(Value::as_str) == Some("")
                && detail.get("outerHTML").and_then(Value::as_str) == Some(""))
            || has_unsupported_relationship(&detail["meta"])
        {
            return Err(PUBLICATION_INVALID);
        }
    }
    Ok(())
}

fn verify_envelope(bytes: &[u8]) -> Result<VerifiedPublication, &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_PUBLICATION_BYTES {
        return Err(if bytes.len() > MAX_PUBLICATION_BYTES {
            PUBLICATION_FILE_OVERSIZE
        } else {
            PUBLICATION_INVALID
        });
    }
    let envelope: LocalPublicationEnvelope =
        serde_json::from_slice(bytes).map_err(|_| PUBLICATION_INVALID)?;
    if envelope.schema != PUBLICATION_SCHEMA
        || envelope.publication_schema_version != PUBLICATION_SCHEMA_VERSION
        || !strict_identity(&envelope.object_id)
        || !accepted_timestamp(&envelope.produced_at_iso)
    {
        return Err(PUBLICATION_INVALID);
    }
    let head_bytes = base64_decode_exact(&envelope.head_bytes_base64)?;
    let revision_bytes = base64_decode_exact(&envelope.revision_bytes_base64)?;
    if head_bytes.is_empty()
        || head_bytes.len() > MAX_HEAD_BYTES
        || revision_bytes.is_empty()
        || revision_bytes.len() > MAX_REVISION_BYTES
        || sha256_hex(&head_bytes) != envelope.head_sha256_hex
        || sha256_hex(&revision_bytes) != envelope.revision_blob_sha256_hex
    {
        return Err(PUBLICATION_INVALID);
    }
    let head_value: Value = serde_json::from_slice(&head_bytes).map_err(|_| PUBLICATION_INVALID)?;
    let revision_value: Value =
        serde_json::from_slice(&revision_bytes).map_err(|_| PUBLICATION_INVALID)?;
    if !exact_keys(
        &head_value,
        &[
            "schema",
            "objectId",
            "objectKey",
            "revisionId",
            "payloadSha256",
            "revisionBlobSha256",
            "writerSyncPeerId",
            "previousRevisionId",
            "sourceUpdatedAtIso",
        ],
    ) || !exact_keys(
        &revision_value,
        &[
            "schema",
            "objectId",
            "objectKey",
            "revisionId",
            "payloadSha256",
            "payload",
        ],
    ) || canonical_value(&head_value)
        .map_err(|_| PUBLICATION_INVALID)?
        .as_bytes()
        != head_bytes
        || canonical_value(&revision_value)
            .map_err(|_| PUBLICATION_INVALID)?
            .as_bytes()
            != revision_bytes
    {
        return Err(PUBLICATION_INVALID);
    }
    let head: SyncHead = serde_json::from_value(head_value).map_err(|_| PUBLICATION_INVALID)?;
    let revision: SyncRevision =
        serde_json::from_value(revision_value).map_err(|_| PUBLICATION_INVALID)?;
    validate_content_payload(
        &revision.payload,
        &envelope.object_id,
        &revision.revision_id,
    )?;
    let payload_sha256 = sha256_hex(
        canonical_value(&revision.payload)
            .map_err(|_| PUBLICATION_INVALID)?
            .as_bytes(),
    );
    let derived_object_key = object_key_hex(&envelope.object_id);
    if head.schema != HEAD_SCHEMA
        || revision.schema != REVISION_SCHEMA
        || head.object_id != envelope.object_id
        || revision.object_id != envelope.object_id
        || head.object_key != derived_object_key
        || revision.object_key != derived_object_key
        || head.revision_id != revision.revision_id
        || head.payload_sha256 != revision.payload_sha256
        || head.payload_sha256 != payload_sha256
        || head.revision_blob_sha256 != envelope.revision_blob_sha256_hex
        || !strict_identity(&head.revision_id)
        || head
            .previous_revision_id
            .as_deref()
            .is_some_and(|value| !strict_identity(value))
        || !accepted_timestamp(&head.source_updated_at_iso)
        || !valid_writer_identity(&head.writer_sync_peer_id, PeerWriterRole::ChromeInbound)
        || canonical_head(&head)
            .map_err(|_| PUBLICATION_INVALID)?
            .as_bytes()
            != head_bytes
    {
        return Err(PUBLICATION_INVALID);
    }
    Ok(VerifiedPublication {
        object_id: envelope.object_id,
        object_key: derived_object_key,
        revision_id: head.revision_id,
        parent_revision_id: head.previous_revision_id,
        head_bytes,
        revision_bytes,
        head_sha256_hex: envelope.head_sha256_hex,
        revision_blob_sha256_hex: envelope.revision_blob_sha256_hex,
        payload_sha256_hex: payload_sha256,
        writer_sync_peer_id_sha256_hex: sha256_hex(head.writer_sync_peer_id.as_bytes()),
    })
}

fn read_publication_file(directory: &Path) -> Result<Option<Vec<u8>>, &'static str> {
    let path = directory.join(PUBLICATION_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(PUBLICATION_FILE_UNSAFE),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PUBLICATION_FILE_UNSAFE);
    }
    if metadata.len() > MAX_PUBLICATION_BYTES as u64 {
        return Err(PUBLICATION_FILE_OVERSIZE);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let file = options.open(&path).map_err(|_| PUBLICATION_FILE_UNSAFE)?;
    let opened_metadata = file.metadata().map_err(|_| PUBLICATION_FILE_UNSAFE)?;
    if !opened_metadata.is_file() || opened_metadata.len() > MAX_PUBLICATION_BYTES as u64 {
        return Err(if opened_metadata.len() > MAX_PUBLICATION_BYTES as u64 {
            PUBLICATION_FILE_OVERSIZE
        } else {
            PUBLICATION_FILE_UNSAFE
        });
    }
    let mut bytes = Vec::with_capacity(opened_metadata.len() as usize);
    file.take((MAX_PUBLICATION_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| PUBLICATION_FILE_UNSAFE)?;
    if bytes.len() > MAX_PUBLICATION_BYTES {
        return Err(PUBLICATION_FILE_OVERSIZE);
    }
    Ok(Some(bytes))
}

fn parent_key(parent: Option<&str>) -> String {
    parent
        .map(|value| format!("p:{value}"))
        .unwrap_or_else(|| "root".into())
}

fn peer_object_key(publication: &VerifiedPublication) -> String {
    sha256_hex(
        format!(
            "{}\0{}",
            publication.writer_sync_peer_id_sha256_hex, publication.object_key
        )
        .as_bytes(),
    )
}

fn revision_key(publication: &VerifiedPublication) -> String {
    sha256_hex(
        format!(
            "{}\0{}",
            peer_object_key(publication),
            publication.revision_id
        )
        .as_bytes(),
    )
}

fn row_from_sql(row: &sqlx::sqlite::SqliteRow) -> Result<StoredObservation, &'static str> {
    let get = |name| {
        row.try_get::<String, _>(name)
            .map_err(|_| BASELINE_UNAVAILABLE)
    };
    let get_opt = |name| {
        row.try_get::<Option<String>, _>(name)
            .map_err(|_| BASELINE_UNAVAILABLE)
    };
    let head_bytes = row
        .try_get::<Vec<u8>, _>("canonical_head_bytes")
        .map_err(|_| BASELINE_UNAVAILABLE)?;
    let revision_bytes = row
        .try_get::<Vec<u8>, _>("canonical_revision_bytes")
        .map_err(|_| BASELINE_UNAVAILABLE)?;
    let value = StoredObservation {
        key: get("key")?,
        peer_object_key: get("peer_object_key")?,
        object_id: get("object_id")?,
        object_key: get("object_key_sha256_hex")?,
        revision_id: get("revision_id")?,
        revision_key: get("revision_key_sha256_hex")?,
        parent_revision_id: get_opt("parent_revision_id")?,
        parent_key: get("parent_key")?,
        admission_disposition: get("admission_disposition")?,
        admission_reason: get("admission_reason")?,
        head_bytes,
        revision_bytes,
        head_sha256_hex: get("head_sha256_hex")?,
        revision_blob_sha256_hex: get("revision_blob_sha256_hex")?,
        payload_sha256_hex: get("payload_sha256_hex")?,
        writer_hash: get("writer_sync_peer_id_sha256_hex")?,
        observed_state: get("observed_state")?,
        apply_state: get("apply_state")?,
        first_observed_at: get("first_observed_at")?,
        last_observed_at: get("last_observed_at")?,
        observation_count: row
            .try_get("observation_count")
            .map_err(|_| BASELINE_UNAVAILABLE)?,
        admitted_at: get("admitted_at")?,
    };
    let schema = get("schema")?;
    let head_value: Value =
        serde_json::from_slice(&value.head_bytes).map_err(|_| BASELINE_UNAVAILABLE)?;
    let revision_value: Value =
        serde_json::from_slice(&value.revision_bytes).map_err(|_| BASELINE_UNAVAILABLE)?;
    let head: SyncHead =
        serde_json::from_value(head_value.clone()).map_err(|_| BASELINE_UNAVAILABLE)?;
    let revision: SyncRevision =
        serde_json::from_value(revision_value.clone()).map_err(|_| BASELINE_UNAVAILABLE)?;
    let payload_sha256 = sha256_hex(
        canonical_value(&revision.payload)
            .map_err(|_| BASELINE_UNAVAILABLE)?
            .as_bytes(),
    );
    let expected_peer_object_key =
        sha256_hex(format!("{}\0{}", value.writer_hash, value.object_key).as_bytes());
    let expected_revision_key =
        sha256_hex(format!("{}\0{}", value.peer_object_key, value.revision_id).as_bytes());
    if schema != OBSERVATION_SCHEMA
        || value.key != value.revision_key
        || !exact_keys(
            &head_value,
            &[
                "schema",
                "objectId",
                "objectKey",
                "revisionId",
                "payloadSha256",
                "revisionBlobSha256",
                "writerSyncPeerId",
                "previousRevisionId",
                "sourceUpdatedAtIso",
            ],
        )
        || !exact_keys(
            &revision_value,
            &[
                "schema",
                "objectId",
                "objectKey",
                "revisionId",
                "payloadSha256",
                "payload",
            ],
        )
        || value.peer_object_key != expected_peer_object_key
        || value.revision_key != expected_revision_key
        || value.object_key != object_key_hex(&value.object_id)
        || value.head_bytes.is_empty()
        || value.head_bytes.len() > MAX_HEAD_BYTES
        || value.revision_bytes.is_empty()
        || value.revision_bytes.len() > MAX_REVISION_BYTES
        || sha256_hex(&value.head_bytes) != value.head_sha256_hex
        || sha256_hex(&value.revision_bytes) != value.revision_blob_sha256_hex
        || canonical_value(&head_value)
            .map_err(|_| BASELINE_UNAVAILABLE)?
            .as_bytes()
            != value.head_bytes
        || canonical_value(&revision_value)
            .map_err(|_| BASELINE_UNAVAILABLE)?
            .as_bytes()
            != value.revision_bytes
        || head.object_id != value.object_id
        || head.schema != HEAD_SCHEMA
        || revision.schema != REVISION_SCHEMA
        || revision.object_id != value.object_id
        || head.object_key != value.object_key
        || revision.object_key != value.object_key
        || head.revision_id != value.revision_id
        || revision.revision_id != value.revision_id
        || head.previous_revision_id != value.parent_revision_id
        || !strict_identity(&value.object_id)
        || !strict_identity(&value.revision_id)
        || value
            .parent_revision_id
            .as_deref()
            .is_some_and(|revision_id| !strict_identity(revision_id))
        || !accepted_timestamp(&head.source_updated_at_iso)
        || head.revision_blob_sha256 != value.revision_blob_sha256_hex
        || head.payload_sha256 != value.payload_sha256_hex
        || revision.payload_sha256 != value.payload_sha256_hex
        || payload_sha256 != value.payload_sha256_hex
        || sha256_hex(head.writer_sync_peer_id.as_bytes()) != value.writer_hash
        || !valid_writer_identity(&head.writer_sync_peer_id, PeerWriterRole::ChromeInbound)
        || validate_content_payload(&revision.payload, &value.object_id, &value.revision_id)
            .is_err()
        || canonical_head(&head)
            .map_err(|_| BASELINE_UNAVAILABLE)?
            .as_bytes()
            != value.head_bytes
        || value.parent_key != parent_key(value.parent_revision_id.as_deref())
        || value.observed_state != "observed"
        || value.apply_state != "not-applied"
        || value.observation_count < 1
        || !accepted_timestamp(&value.first_observed_at)
        || !accepted_timestamp(&value.last_observed_at)
        || !accepted_timestamp(&value.admitted_at)
        || !matches!(
            value.admission_disposition.as_str(),
            "accepted-linear" | "divergent-staged"
        )
        || !matches!(
            value.admission_reason.as_str(),
            "fast-forward"
                | "competing-root"
                | "stale-parent"
                | "sibling-fork"
                | "unknown-parent"
                | "baseline-deleted"
                | "local-unexported-change"
        )
    {
        return Err(BASELINE_UNAVAILABLE);
    }
    Ok(value)
}

async fn rows_for_peer<'a>(
    tx: &mut Transaction<'a, sqlx::Sqlite>,
    key: &str,
) -> Result<Vec<StoredObservation>, &'static str> {
    let rows = sqlx::query(
        "SELECT * FROM sync_inbound_revision_observations WHERE peer_object_key = ? ORDER BY key",
    )
    .bind(key)
    .fetch_all(&mut **tx)
    .await
    .map_err(|_| BASELINE_UNAVAILABLE)?;
    rows.iter().map(row_from_sql).collect()
}

async fn derive_baseline<'a>(
    tx: &mut Transaction<'a, sqlx::Sqlite>,
    object_id: &str,
) -> Result<BaselinePosture, &'static str> {
    let chat = sqlx::query("SELECT last_snapshot_id, is_deleted FROM chats WHERE id = ?")
        .bind(object_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| BASELINE_UNAVAILABLE)?;
    let (lmr, chat_deleted) = match chat.as_ref() {
        Some(row) => {
            let deleted: i64 = row
                .try_get("is_deleted")
                .map_err(|_| BASELINE_UNAVAILABLE)?;
            let revision = row
                .try_get::<Option<String>, _>("last_snapshot_id")
                .map_err(|_| BASELINE_UNAVAILABLE)?;
            if revision
                .as_deref()
                .is_some_and(|value| !strict_identity(value))
            {
                return Err(BASELINE_UNAVAILABLE);
            }
            (revision, deleted != 0)
        }
        None => (None, false),
    };
    let tombstones: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sync_tombstones WHERE record_kind = 'chat' AND record_id = ? AND (restored_at IS NULL OR restored_at = '')"
    ).bind(object_id).fetch_one(&mut **tx).await.map_err(|_| BASELINE_UNAVAILABLE)?;
    let sab_rows: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT DISTINCT last_applied_revision_id FROM sync_object_state WHERE object_id = ? AND last_applied_revision_id IS NOT NULL"
    ).bind(object_id).fetch_all(&mut **tx).await.map_err(|_| BASELINE_UNAVAILABLE)?;
    if sab_rows.len() > 1 {
        return Err(BASELINE_UNAVAILABLE);
    }
    let sab = sab_rows.into_iter().next().flatten();
    if sab.as_deref().is_some_and(|value| !strict_identity(value)) {
        return Err(BASELINE_UNAVAILABLE);
    }
    if (chat_deleted || tombstones > 0) && lmr.is_some() {
        return Err(BASELINE_UNAVAILABLE);
    }
    if chat_deleted || (lmr.is_none() && tombstones > 0) {
        return Ok(BaselinePosture::Deleted);
    }
    match (lmr, sab) {
        (None, None) => Ok(BaselinePosture::Anchor(None)),
        (None, Some(_)) => Err(BASELINE_UNAVAILABLE),
        (Some(lmr), None) => Ok(BaselinePosture::Anchor(Some(lmr))),
        (Some(lmr), Some(sab)) if lmr == sab => Ok(BaselinePosture::Anchor(Some(lmr))),
        /* Apply state is remote provenance, not canonicality. A different
         * durable chat pointer is a coherent locally-authored canonical tip;
         * candidate parent comparison below decides whether an inbound
         * revision descends from it or is a sibling/stale branch. */
        (Some(lmr), Some(_)) => Ok(BaselinePosture::Anchor(Some(lmr))),
    }
}

fn pending_chain(
    rows: &[StoredObservation],
    anchor: Option<&str>,
) -> Result<Vec<String>, &'static str> {
    let accepted: HashMap<&str, &StoredObservation> = rows
        .iter()
        .filter(|row| row.admission_disposition == "accepted-linear")
        .map(|row| (row.revision_id.as_str(), row))
        .collect();
    for start in accepted.keys() {
        let mut path = HashSet::new();
        let mut cursor = Some(*start);
        while let Some(revision_id) = cursor {
            if !path.insert(revision_id) {
                return Err("ambiguous-accepted-children");
            }
            cursor = accepted
                .get(revision_id)
                .and_then(|row| row.parent_revision_id.as_deref());
        }
    }
    let mut children: HashMap<Option<&str>, Vec<&StoredObservation>> = HashMap::new();
    for row in accepted.values() {
        children
            .entry(row.parent_revision_id.as_deref())
            .or_default()
            .push(*row);
    }
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = anchor.map(str::to_string);
    loop {
        let matches = children
            .get(&cursor.as_deref())
            .cloned()
            .unwrap_or_default();
        if matches.is_empty() {
            break;
        }
        if matches.len() != 1 {
            return Err("ambiguous-accepted-children");
        }
        let next = matches[0].revision_id.clone();
        if !seen.insert(next.clone()) {
            return Err("ambiguous-accepted-children");
        }
        chain.push(next.clone());
        cursor = Some(next);
    }
    Ok(chain)
}

fn immutable_matches(row: &StoredObservation, publication: &VerifiedPublication) -> bool {
    row.object_id == publication.object_id
        && row.object_key == publication.object_key
        && row.revision_id == publication.revision_id
        && row.revision_key == revision_key(publication)
        && row.parent_revision_id == publication.parent_revision_id
        && row.parent_key == parent_key(publication.parent_revision_id.as_deref())
        && row.head_bytes == publication.head_bytes
        && row.revision_bytes == publication.revision_bytes
        && row.head_sha256_hex == publication.head_sha256_hex
        && row.revision_blob_sha256_hex == publication.revision_blob_sha256_hex
        && row.payload_sha256_hex == publication.payload_sha256_hex
        && row.writer_hash == publication.writer_sync_peer_id_sha256_hex
        && row.observed_state == "observed"
        && row.apply_state == "not-applied"
}

async fn insert_observation<'a>(
    tx: &mut Transaction<'a, sqlx::Sqlite>,
    publication: &VerifiedPublication,
    disposition: &str,
    reason: &str,
    now: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO sync_inbound_revision_observations (key, schema, peer_object_key, object_id, object_key_sha256_hex, revision_id, revision_key_sha256_hex, parent_revision_id, parent_key, admission_disposition, admission_reason, canonical_head_bytes, canonical_revision_bytes, head_sha256_hex, revision_blob_sha256_hex, payload_sha256_hex, writer_sync_peer_id_sha256_hex, observed_state, apply_state, first_observed_at, last_observed_at, observation_count, admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', 'not-applied', ?, ?, 1, ?)"
    )
    .bind(revision_key(publication)).bind(OBSERVATION_SCHEMA).bind(peer_object_key(publication))
    .bind(&publication.object_id).bind(&publication.object_key).bind(&publication.revision_id)
    .bind(revision_key(publication)).bind(&publication.parent_revision_id)
    .bind(parent_key(publication.parent_revision_id.as_deref())).bind(disposition).bind(reason)
    .bind(&publication.head_bytes).bind(&publication.revision_bytes).bind(&publication.head_sha256_hex)
    .bind(&publication.revision_blob_sha256_hex).bind(&publication.payload_sha256_hex)
    .bind(&publication.writer_sync_peer_id_sha256_hex).bind(now).bind(now).bind(now)
    .execute(&mut **tx).await.map(|_| ())
}

fn accepted_child_insert_conflict(error: &sqlx::Error) -> bool {
    error.as_database_error().is_some_and(|value| {
        value.is_unique_violation() || value.message().contains("sync-inbound-replacement-guard")
    })
}

async fn admit_once(
    conn: &mut SqliteConnection,
    publication: &VerifiedPublication,
    now: &str,
    force_sibling: bool,
) -> Result<LocalPublicationReceiveResult, &'static str> {
    let mut tx = conn.begin().await.map_err(|_| BASELINE_UNAVAILABLE)?;
    let peer_key = peer_object_key(publication);
    let rows = rows_for_peer(&mut tx, &peer_key).await?;
    if let Some(existing) = rows
        .iter()
        .find(|row| row.revision_id == publication.revision_id)
    {
        if !immutable_matches(existing, publication) {
            tx.rollback().await.ok();
            return Err(REVISION_IDENTITY_CONFLICT);
        }
        let updated = sqlx::query("UPDATE sync_inbound_revision_observations SET last_observed_at = ?, observation_count = observation_count + 1 WHERE key = ?")
            .bind(now).bind(&existing.key).execute(&mut *tx).await.map_err(|_| BASELINE_UNAVAILABLE)?;
        if updated.rows_affected() != 1 {
            tx.rollback().await.ok();
            return Err(BASELINE_UNAVAILABLE);
        }
        tx.commit().await.map_err(|_| BASELINE_UNAVAILABLE)?;
        return Ok(LocalPublicationReceiveResult {
            schema: "h2o.studio.local-publication-receive-result.v1",
            ok: true,
            verdict: IDENTICAL_REPLAY,
            reason: Some(existing.admission_reason.clone()),
            object_id: Some(publication.object_id.clone()),
            revision_id: Some(publication.revision_id.clone()),
            historical_admission: Some(existing.admission_disposition.clone()),
            unchanged_no_op: true,
            observation_count: (existing.observation_count + 1) as u64,
            no_apply: true,
            no_network: true,
        });
    }
    let baseline = derive_baseline(&mut tx, &publication.object_id).await?;
    let (disposition, reason) = match baseline {
        BaselinePosture::Deleted => ("divergent-staged", "baseline-deleted"),
        BaselinePosture::Anchor(anchor) => {
            let chain = pending_chain(&rows, anchor.as_deref())?;
            let pending_head = chain.last().cloned().or(anchor.clone());
            let occupied = rows.iter().any(|row| {
                row.admission_disposition == "accepted-linear"
                    && row.parent_key == parent_key(publication.parent_revision_id.as_deref())
            });
            if !force_sibling
                && publication.parent_revision_id == pending_head
                && publication.parent_revision_id.as_deref() != Some(&publication.revision_id)
                && !occupied
            {
                ("accepted-linear", "fast-forward")
            } else if occupied || force_sibling {
                ("divergent-staged", "sibling-fork")
            } else if publication.parent_revision_id.is_none() && anchor.is_some() {
                ("divergent-staged", "competing-root")
            } else if publication
                .parent_revision_id
                .as_ref()
                .is_some_and(|parent| {
                    chain.contains(parent)
                        || anchor.as_ref() == Some(parent)
                        || rows.iter().any(|row| {
                            row.admission_disposition == "accepted-linear"
                                && row.revision_id == *parent
                        })
                })
            {
                ("divergent-staged", "stale-parent")
            } else {
                ("divergent-staged", "unknown-parent")
            }
        }
    };
    let quota_rows = sqlx::query(
        "SELECT * FROM sync_inbound_revision_observations WHERE object_id = ? ORDER BY key",
    )
    .bind(&publication.object_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| BASELINE_UNAVAILABLE)?;
    let quota_observations = quota_rows
        .iter()
        .map(row_from_sql)
        .collect::<Result<Vec<_>, _>>()?;
    let row_count = i64::try_from(quota_observations.len()).map_err(|_| INBOUND_QUOTA_EXCEEDED)?;
    let byte_count = quota_observations.iter().try_fold(0_i64, |total, row| {
        let row_bytes = row
            .head_bytes
            .len()
            .checked_add(row.revision_bytes.len())
            .and_then(|value| i64::try_from(value).ok())
            .ok_or(INBOUND_QUOTA_EXCEEDED)?;
        total.checked_add(row_bytes).ok_or(INBOUND_QUOTA_EXCEEDED)
    })?;
    let added = publication
        .head_bytes
        .len()
        .checked_add(publication.revision_bytes.len())
        .ok_or(INBOUND_QUOTA_EXCEEDED)? as i64;
    // V9 recovery-critical eligibility, clause 1: the candidate is an ancestor
    // that already-retained evidence names as its parent but which is not
    // itself retained. Derived purely from local rows, so an arbitrary peer
    // cannot label an ordinary revision as recovery-critical.
    let recovery_critical = quota_observations.iter().any(|row| {
        row.parent_revision_id.as_deref() == Some(publication.revision_id.as_str())
    }) && !quota_observations
        .iter()
        .any(|row| row.revision_id == publication.revision_id);
    let next_bytes = byte_count.checked_add(added).ok_or(INBOUND_QUOTA_EXCEEDED)?;
    let within_normal =
        row_count < NORMAL_INBOUND_ROWS && next_bytes <= NORMAL_INBOUND_CANONICAL_BYTES;
    let within_reserve = recovery_critical
        && row_count < HARD_INBOUND_ROWS
        && next_bytes <= HARD_INBOUND_CANONICAL_BYTES;
    if !within_normal && !within_reserve {
        // Fail closed. Everything already retained stays exactly as it is, no
        // canonical content is touched, and nothing is evicted.
        tx.rollback().await.ok();
        return Err(INBOUND_QUOTA_EXCEEDED);
    }
    match insert_observation(&mut tx, publication, disposition, reason, now).await {
        Ok(()) => {}
        Err(error)
            if disposition == "accepted-linear" && accepted_child_insert_conflict(&error) =>
        {
            tx.rollback().await.ok();
            return Err("accepted-child-race");
        }
        Err(_) => {
            tx.rollback().await.ok();
            return Err(BASELINE_UNAVAILABLE);
        }
    }
    tx.commit().await.map_err(|_| BASELINE_UNAVAILABLE)?;
    Ok(LocalPublicationReceiveResult {
        schema: "h2o.studio.local-publication-receive-result.v1",
        ok: true,
        verdict: if disposition == "accepted-linear" {
            REVISION_ADMITTED
        } else {
            REVISION_STAGED_DIVERGENT
        },
        reason: Some(reason.into()),
        object_id: Some(publication.object_id.clone()),
        revision_id: Some(publication.revision_id.clone()),
        historical_admission: Some(disposition.into()),
        unchanged_no_op: false,
        observation_count: 1,
        no_apply: true,
        no_network: true,
    })
}

async fn admit_publication(
    conn: &mut SqliteConnection,
    publication: &VerifiedPublication,
    now: &str,
) -> Result<LocalPublicationReceiveResult, &'static str> {
    match admit_once(conn, publication, now, false).await {
        Err("accepted-child-race") => admit_once(conn, publication, now, true).await,
        result => result,
    }
}

async fn sqlite_pool(db_instances: &DbInstances) -> Result<SqlitePool, String> {
    let instances = db_instances.0.read().await;
    match instances.get(DB_URL) {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err(BASELINE_UNAVAILABLE.into()),
    }
}

#[tauri::command]
pub async fn h2o_local_publication_receive(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
) -> Result<LocalPublicationReceiveResult, String> {
    let directory = match resolve_authorized_delivery_directory(&app) {
        Ok(directory) => directory,
        Err(code) => return Ok(LocalPublicationReceiveResult::rejected(&code)),
    };
    let bytes = match read_publication_file(&directory) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Ok(LocalPublicationReceiveResult::absent()),
        Err(code) => return Ok(LocalPublicationReceiveResult::rejected(code)),
    };
    let publication = match verify_envelope(&bytes) {
        Ok(publication) => publication,
        Err(code) => return Ok(LocalPublicationReceiveResult::rejected(code)),
    };
    let pool = match sqlite_pool(&db_instances).await {
        Ok(pool) => pool,
        Err(_) => {
            return Ok(LocalPublicationReceiveResult::rejected(
                BASELINE_UNAVAILABLE,
            ))
        }
    };
    let mut connection = match pool.acquire().await {
        Ok(connection) => connection,
        Err(_) => {
            return Ok(LocalPublicationReceiveResult::rejected(
                BASELINE_UNAVAILABLE,
            ))
        }
    };
    match admit_publication(&mut connection, &publication, &now_iso()).await {
        Ok(result) => Ok(result),
        Err(REVISION_IDENTITY_CONFLICT) => Ok(LocalPublicationReceiveResult::failure(
            REVISION_IDENTITY_CONFLICT,
            REVISION_IDENTITY_CONFLICT,
        )),
        Err(code) => Ok(LocalPublicationReceiveResult::rejected(code)),
    }
}

async fn project_branches(
    conn: &mut SqliteConnection,
    object_id: &str,
) -> Result<LocalPublicationBranchesResult, &'static str> {
    if !strict_identity(object_id) {
        return Err(PUBLICATION_INVALID);
    }
    let mut tx = conn.begin().await.map_err(|_| BASELINE_UNAVAILABLE)?;
    let baseline = derive_baseline(&mut tx, object_id).await;
    let rows_sql = sqlx::query(
        "SELECT * FROM sync_inbound_revision_observations WHERE object_id = ? ORDER BY key",
    )
    .bind(object_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| BASELINE_UNAVAILABLE)?;
    let rows: Vec<StoredObservation> = rows_sql
        .iter()
        .map(row_from_sql)
        .collect::<Result<_, _>>()?;
    let peer_keys: HashSet<&str> = rows
        .iter()
        .map(|row| row.peer_object_key.as_str())
        .collect();
    let (anchor, mut unavailable_reason) = match baseline {
        Ok(BaselinePosture::Anchor(anchor)) => (anchor, None),
        Ok(BaselinePosture::Deleted) => (None, Some("baseline-deleted".into())),
        Err(_) => (None, Some(BASELINE_UNAVAILABLE.into())),
    };
    if unavailable_reason.is_none() && peer_keys.len() > 1 {
        unavailable_reason = Some("multiple-inbound-peer-authorities".into());
    }
    let pending_chain = if unavailable_reason.is_none() {
        pending_chain(&rows, anchor.as_deref())?
    } else {
        Vec::new()
    };
    let reachable: HashSet<&str> = pending_chain.iter().map(String::as_str).collect();
    let branches = rows
        .into_iter()
        .map(|row| {
            let current_relationship = if row.admission_disposition == "divergent-staged" {
                "divergent-staged"
            } else if unavailable_reason.is_some() {
                "baseline-unavailable"
            } else if reachable.contains(row.revision_id.as_str()) {
                "pending-from-current-anchor"
            } else {
                "orphaned-by-baseline-move"
            };
            InboundBranchProjection {
                revision_id: row.revision_id,
                parent_revision_id: row.parent_revision_id,
                historical_admission: row.admission_disposition,
                admission_reason: row.admission_reason,
                current_relationship: current_relationship.into(),
                revision_blob_sha256_hex: row.revision_blob_sha256_hex,
                payload_sha256_hex: row.payload_sha256_hex,
                head_sha256_hex: row.head_sha256_hex,
                writer_sync_peer_id_sha256_hex: row.writer_hash,
                apply_state: row.apply_state,
                first_observed_at: row.first_observed_at,
                last_observed_at: row.last_observed_at,
                observation_count: row.observation_count as u64,
            }
        })
        .collect();
    tx.commit().await.map_err(|_| BASELINE_UNAVAILABLE)?;
    Ok(LocalPublicationBranchesResult {
        schema: "h2o.studio.local-publication-branches.v1",
        ok: true,
        object_id: object_id.into(),
        anchor,
        unavailable_reason,
        pending_chain,
        branches,
        no_apply: true,
        no_network: true,
    })
}

#[tauri::command]
pub async fn h2o_local_publication_read_branches(
    db_instances: State<'_, DbInstances>,
    object_id: String,
) -> Result<LocalPublicationBranchesResult, String> {
    let pool = sqlite_pool(&db_instances).await?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| BASELINE_UNAVAILABLE.to_string())?;
    project_branches(&mut connection, object_id.trim())
        .await
        .map_err(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(1);
    const CHROME_WRITER: &str =
        "studio-chrome:mv3-chrome:idb-archive:11111111-2222-4333-8444-555555555555";

    async fn database() -> SqliteConnection {
        let mut conn = SqliteConnection::connect(":memory:").await.unwrap();
        for sql in [
            "CREATE TABLE chats (id TEXT PRIMARY KEY, last_snapshot_id TEXT, is_deleted INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE sync_tombstones (record_kind TEXT, record_id TEXT, restored_at TEXT)",
            "CREATE TABLE sync_object_state (sync_peer_id TEXT, object_id TEXT, last_applied_revision_id TEXT)",
        ] { sqlx::query(sql).execute(&mut conn).await.unwrap(); }
        for migration in crate::studio_migrations()
            .into_iter()
            .filter(|migration| matches!(migration.version, 19 | 20))
        {
            sqlx::raw_sql(migration.sql)
                .execute(&mut conn)
                .await
                .unwrap();
        }
        conn
    }

    fn publication(
        object_id: &str,
        revision_id: &str,
        parent: Option<&str>,
        text: &str,
    ) -> (Vec<u8>, VerifiedPublication) {
        let object_key = object_key_hex(object_id);
        let message_text = if text == "noncanonical-envelope" {
            "message"
        } else {
            text
        };
        let payload = json!({
            "schema":"h2o.studio.fullBundle.v2",
            "chatArchive":{
                "chats":[{
                    "chatId":object_id,
                    "title":"Publication fixture",
                    "chatIndex":{
                        "title":"Publication fixture",
                        "lastSnapshotId":revision_id,
                        "snapshotCount":1,
                        "messageCount":1,
                        "state":{"isSaved":true,"isLinked":true},
                        "organization":{}
                    },
                    "snapshots":[{
                        "snapshotId":revision_id,
                        "chatId":object_id,
                        "createdAt":"2026-08-12T12:00:00.000Z",
                        "messageCount":1,
                        "messages":[{"order":0,"role":"user","text":message_text}],
                        "meta":{"title":"Publication fixture","richTurns":[{
                            "turnIdx":0,"role":"user","outerHTML":format!("<p>{message_text}</p>"),"meta":{}
                        }]}
                    }]
                }],
                "catalogs":{"categories":[],"labels":[],"tags":[]}
            },
            "chromeStorageLocal":{},
            "libraryKv":[]
        });
        let payload_hash = sha256_hex(canonical_value(&payload).unwrap().as_bytes());
        let revision = json!({"schema":REVISION_SCHEMA,"objectId":object_id,"objectKey":object_key,"revisionId":revision_id,"payloadSha256":payload_hash,"payload":payload});
        let revision_bytes = canonical_value(&revision).unwrap().into_bytes();
        let revision_hash = sha256_hex(&revision_bytes);
        let head = SyncHead {
            schema: HEAD_SCHEMA.into(),
            object_id: object_id.into(),
            object_key: object_key.clone(),
            revision_id: revision_id.into(),
            payload_sha256: payload_hash.clone(),
            revision_blob_sha256: revision_hash.clone(),
            writer_sync_peer_id: CHROME_WRITER.into(),
            previous_revision_id: parent.map(str::to_string),
            source_updated_at_iso: "2026-08-12T12:00:00.000Z".into(),
        };
        let head_bytes = canonical_head(&head).unwrap().into_bytes();
        let envelope = json!({"schema":PUBLICATION_SCHEMA,"publicationSchemaVersion":1,"objectId":object_id,"headBytesBase64":base64_encode(&head_bytes),"headSha256Hex":sha256_hex(&head_bytes),"revisionBytesBase64":base64_encode(&revision_bytes),"revisionBlobSha256Hex":revision_hash,"producedAtIso":"2026-08-12T12:00:01.000Z"});
        let mut bytes = canonical_value(&envelope).unwrap().into_bytes();
        if text == "noncanonical-envelope" {
            bytes.push(b' ');
        }
        let verified = verify_envelope(&canonical_value(&envelope).unwrap().into_bytes()).unwrap();
        (bytes, verified)
    }

    async fn set_lmr(conn: &mut SqliteConnection, object: &str, lmr: Option<&str>) {
        sqlx::query(
            "INSERT OR REPLACE INTO chats (id, last_snapshot_id, is_deleted) VALUES (?, ?, 0)",
        )
        .bind(object)
        .bind(lmr)
        .execute(conn)
        .await
        .unwrap();
    }

    async fn stored_by_revision(
        conn: &mut SqliteConnection,
        revision_id: &str,
    ) -> StoredObservation {
        let row =
            sqlx::query("SELECT * FROM sync_inbound_revision_observations WHERE revision_id = ?")
                .bind(revision_id)
                .fetch_one(conn)
                .await
                .unwrap();
        row_from_sql(&row).unwrap()
    }

    #[test]
    #[ignore = "invoked only by the deterministic JS-to-Rust composition harness"]
    fn real_chrome_writer_bytes_verify_and_admit() {
        tauri::async_runtime::block_on(async {
            let root = std::path::PathBuf::from(
                std::env::var("H2O_LOCAL_PUBLICATION_COMPOSITION_DIR")
                    .expect("composition scratch directory supplied by Node harness"),
            );
            let c1_bytes =
                fs::read(root.join("root-c1.json")).expect("real Chrome writer root bytes exist");
            let c2_bytes =
                fs::read(root.join("child-c2.json")).expect("real Chrome writer child bytes exist");
            let replay_bytes = fs::read(root.join("replay-c2.json"))
                .expect("real Chrome writer replay bytes exist");
            assert_eq!(
                c2_bytes, replay_bytes,
                "writer replay must be byte-identical"
            );

            for bytes in [&c1_bytes, &c2_bytes, &replay_bytes] {
                let envelope: Value = serde_json::from_slice(bytes).unwrap();
                assert_eq!(envelope.as_object().unwrap().len(), 8);
            }
            let c1 = verify_envelope(&c1_bytes)
                .expect("production Rust verifier accepts real writer root");
            let c2 = verify_envelope(&c2_bytes)
                .expect("production Rust verifier accepts real writer child");
            let replay = verify_envelope(&replay_bytes)
                .expect("production Rust verifier accepts real writer replay");
            assert_eq!(c1.object_id, "local-publication-writer-chat");
            assert_eq!(c1.revision_id, "c1");
            assert_eq!(c1.parent_revision_id, None);
            assert_eq!(c2.revision_id, "c2");
            assert_eq!(c2.parent_revision_id.as_deref(), Some("c1"));
            assert_eq!(c2.object_key, object_key_hex(&c2.object_id));
            assert_eq!(c2, replay);
            assert_eq!(
                c2.writer_sync_peer_id_sha256_hex,
                sha256_hex(CHROME_WRITER.as_bytes())
            );

            let mut conn = database().await;
            sqlx::query("CREATE TABLE snapshots (id TEXT PRIMARY KEY)")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query("CREATE TABLE snapshot_turns (id TEXT PRIMARY KEY)")
                .execute(&mut conn)
                .await
                .unwrap();
            let protected_before: (i64, i64, i64, i64) = (
                sqlx::query_scalar("SELECT COUNT(*) FROM chats")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
                sqlx::query_scalar("SELECT COUNT(*) FROM snapshots")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
                sqlx::query_scalar("SELECT COUNT(*) FROM snapshot_turns")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_object_state")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
            );

            let root_result = admit_publication(&mut conn, &c1, "2026-08-12T12:20:00.000Z")
                .await
                .expect("production Rust admission accepts writer root");
            assert_eq!(root_result.verdict, REVISION_ADMITTED);
            assert_eq!(
                root_result.historical_admission.as_deref(),
                Some("accepted-linear")
            );
            assert!(!root_result.unchanged_no_op);
            let root_row = stored_by_revision(&mut conn, "c1").await;
            assert_eq!(root_row.parent_revision_id, None);
            assert_eq!(root_row.apply_state, "not-applied");

            let child_result = admit_publication(&mut conn, &c2, "2026-08-12T12:20:01.000Z")
                .await
                .expect("production Rust admission accepts writer child");
            assert_eq!(child_result.verdict, REVISION_ADMITTED);
            assert_eq!(
                child_result.historical_admission.as_deref(),
                Some("accepted-linear")
            );
            let child_before_replay = stored_by_revision(&mut conn, "c2").await;
            assert_eq!(
                child_before_replay.parent_revision_id.as_deref(),
                Some("c1")
            );
            assert_eq!(child_before_replay.apply_state, "not-applied");
            let view = project_branches(&mut conn, &c2.object_id).await.unwrap();
            assert_eq!(view.pending_chain, vec!["c1", "c2"]);

            let row_count_before: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_inbound_revision_observations")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            let replay_result = admit_publication(&mut conn, &replay, "2026-08-12T12:20:02.000Z")
                .await
                .expect("production Rust admission recognizes writer replay");
            assert_eq!(replay_result.verdict, IDENTICAL_REPLAY);
            assert!(replay_result.unchanged_no_op);
            assert_eq!(
                replay_result.historical_admission.as_deref(),
                Some("accepted-linear")
            );
            let row_count_after: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_inbound_revision_observations")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(row_count_after, row_count_before);
            let child_after_replay = stored_by_revision(&mut conn, "c2").await;
            assert_eq!(child_after_replay.observation_count, 2);
            assert_eq!(
                child_after_replay.last_observed_at,
                "2026-08-12T12:20:02.000Z"
            );
            assert_eq!(
                (
                    &child_after_replay.admission_disposition,
                    &child_after_replay.admission_reason,
                    &child_after_replay.head_bytes,
                    &child_after_replay.revision_bytes,
                    &child_after_replay.apply_state,
                ),
                (
                    &child_before_replay.admission_disposition,
                    &child_before_replay.admission_reason,
                    &child_before_replay.head_bytes,
                    &child_before_replay.revision_bytes,
                    &child_before_replay.apply_state,
                )
            );

            let protected_after: (i64, i64, i64, i64) = (
                sqlx::query_scalar("SELECT COUNT(*) FROM chats")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
                sqlx::query_scalar("SELECT COUNT(*) FROM snapshots")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
                sqlx::query_scalar("SELECT COUNT(*) FROM snapshot_turns")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_object_state")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
            );
            assert_eq!(protected_after, protected_before);
            assert!(sqlx::query_scalar::<_, String>(
                "SELECT DISTINCT apply_state FROM sync_inbound_revision_observations",
            )
            .fetch_all(&mut conn)
            .await
            .unwrap()
            .iter()
            .all(|state| state == "not-applied"));
            println!(
                "LOCAL_PUBLICATION_RUST_COMPOSITION_PASS rootVerdict={} childVerdict={} replayVerdict={} pendingPath=c1,c2 applyState=not-applied protectedObjectMutations=0",
                root_result.verdict, child_result.verdict, replay_result.verdict
            );
        });
    }

    #[test]
    fn envelope_validation_covers_exact_keys_bounds_hashes_and_peer_role() {
        let (bytes, _) = publication("chat-a", "c1", None, "ok");
        assert!(verify_envelope(&bytes).is_ok());
        let mut value: Value = serde_json::from_slice(&bytes).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("unknown".into(), Value::Bool(true));
        assert_eq!(
            verify_envelope(&serde_json::to_vec(&value).unwrap()).unwrap_err(),
            PUBLICATION_INVALID
        );
        for (key, value) in [
            ("schema", json!("wrong")),
            ("publicationSchemaVersion", json!(2)),
            ("headBytesBase64", json!("%%%=")),
            ("headSha256Hex", json!("0".repeat(64))),
            ("revisionBlobSha256Hex", json!("f".repeat(64))),
        ] {
            let mut changed: Value = serde_json::from_slice(&bytes).unwrap();
            changed.as_object_mut().unwrap().insert(key.into(), value);
            assert!(verify_envelope(&serde_json::to_vec(&changed).unwrap()).is_err());
        }
        assert_eq!(
            verify_envelope(&vec![b'x'; MAX_PUBLICATION_BYTES + 1]).unwrap_err(),
            PUBLICATION_FILE_OVERSIZE
        );
        let (_, verified) = publication("chat-a", "c1", None, "ok");
        let mut head: Value = serde_json::from_slice(&verified.head_bytes).unwrap();
        head["writerSyncPeerId"] =
            json!("studio-desktop:tauri-desktop:sqlite:11111111-2222-4333-8444-555555555555");
        let head_bytes = canonical_value(&head).unwrap().into_bytes();
        let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
        envelope["headBytesBase64"] = json!(base64_encode(&head_bytes));
        envelope["headSha256Hex"] = json!(sha256_hex(&head_bytes));
        assert_eq!(
            verify_envelope(&serde_json::to_vec(&envelope).unwrap()).unwrap_err(),
            PUBLICATION_INVALID
        );
    }

    #[test]
    fn canonical_blob_bounds_and_cross_authorities_are_recomputed() {
        let (bytes, verified) = publication("chat-bounds", "c1", None, "ok");
        let mutate_blob = |field: &str, hash_field: &str, blob: Vec<u8>| {
            let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
            envelope[field] = json!(base64_encode(&blob));
            envelope[hash_field] = json!(sha256_hex(&blob));
            serde_json::to_vec(&envelope).unwrap()
        };
        let mut noncanonical_head = verified.head_bytes.clone();
        noncanonical_head.push(b' ');
        assert_eq!(
            verify_envelope(&mutate_blob(
                "headBytesBase64",
                "headSha256Hex",
                noncanonical_head
            ))
            .unwrap_err(),
            PUBLICATION_INVALID
        );
        let mut noncanonical_revision = verified.revision_bytes.clone();
        noncanonical_revision.push(b' ');
        assert_eq!(
            verify_envelope(&mutate_blob(
                "revisionBytesBase64",
                "revisionBlobSha256Hex",
                noncanonical_revision
            ))
            .unwrap_err(),
            PUBLICATION_INVALID
        );

        let mut extra_head: Value = serde_json::from_slice(&verified.head_bytes).unwrap();
        extra_head["unexpected"] = json!(true);
        let extra_head = canonical_value(&extra_head).unwrap().into_bytes();
        assert_eq!(
            verify_envelope(&mutate_blob("headBytesBase64", "headSha256Hex", extra_head))
                .unwrap_err(),
            PUBLICATION_INVALID
        );
        let mut extra_revision: Value = serde_json::from_slice(&verified.revision_bytes).unwrap();
        extra_revision["unexpected"] = json!(true);
        let extra_revision = canonical_value(&extra_revision).unwrap().into_bytes();
        assert_eq!(
            verify_envelope(&mutate_blob(
                "revisionBytesBase64",
                "revisionBlobSha256Hex",
                extra_revision
            ))
            .unwrap_err(),
            PUBLICATION_INVALID
        );
        assert_eq!(
            verify_envelope(&mutate_blob(
                "headBytesBase64",
                "headSha256Hex",
                vec![b'x'; MAX_HEAD_BYTES + 1]
            ))
            .unwrap_err(),
            PUBLICATION_INVALID
        );
        assert_eq!(
            verify_envelope(&mutate_blob(
                "revisionBytesBase64",
                "revisionBlobSha256Hex",
                vec![b'x'; MAX_REVISION_BYTES + 1]
            ))
            .unwrap_err(),
            PUBLICATION_INVALID
        );

        for (target, replacement) in [
            ("objectKey", json!("f".repeat(64))),
            ("revisionId", json!("different")),
            ("payloadSha256", json!("e".repeat(64))),
        ] {
            let mut revision: Value = serde_json::from_slice(&verified.revision_bytes).unwrap();
            revision[target] = replacement;
            let revision_bytes = canonical_value(&revision).unwrap().into_bytes();
            let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
            envelope["revisionBytesBase64"] = json!(base64_encode(&revision_bytes));
            envelope["revisionBlobSha256Hex"] = json!(sha256_hex(&revision_bytes));
            assert_eq!(
                verify_envelope(&serde_json::to_vec(&envelope).unwrap()).unwrap_err(),
                PUBLICATION_INVALID
            );
        }

        let mut payload_revision: Value = serde_json::from_slice(&verified.revision_bytes).unwrap();
        payload_revision["payload"]["chatArchive"]["chats"][0]["snapshots"][0]["messages"][0]
            ["text"] = json!("changed");
        let revision_bytes = canonical_value(&payload_revision).unwrap().into_bytes();
        let mut envelope: Value = serde_json::from_slice(&bytes).unwrap();
        envelope["revisionBytesBase64"] = json!(base64_encode(&revision_bytes));
        envelope["revisionBlobSha256Hex"] = json!(sha256_hex(&revision_bytes));
        assert_eq!(
            verify_envelope(&serde_json::to_vec(&envelope).unwrap()).unwrap_err(),
            PUBLICATION_INVALID
        );
    }

    #[test]
    fn fixed_slot_absence_and_file_posture_are_fail_closed() {
        let root = std::env::temp_dir().join(format!(
            "h2o-local-intake-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        assert!(read_publication_file(&root).unwrap().is_none());
        fs::create_dir(root.join(PUBLICATION_FILE)).unwrap();
        assert_eq!(
            read_publication_file(&root).unwrap_err(),
            PUBLICATION_FILE_UNSAFE
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn fixed_slot_symlink_is_rejected_without_following_it() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "h2o-local-intake-link-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("target.json");
        fs::write(&target, b"{}").unwrap();
        symlink(&target, root.join(PUBLICATION_FILE)).unwrap();
        assert_eq!(
            read_publication_file(&root).unwrap_err(),
            PUBLICATION_FILE_UNSAFE
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn peer_roles_are_explicit_and_item11_desktop_form_remains_distinct() {
        assert!(valid_writer_identity(
            CHROME_WRITER,
            PeerWriterRole::ChromeInbound
        ));
        assert!(!valid_writer_identity(
            CHROME_WRITER,
            PeerWriterRole::DesktopOutbound
        ));
        let desktop = "studio-desktop:tauri-desktop:sqlite:11111111-2222-4333-8444-555555555555";
        assert!(valid_writer_identity(
            desktop,
            PeerWriterRole::DesktopOutbound
        ));
        assert!(!valid_writer_identity(
            desktop,
            PeerWriterRole::ChromeInbound
        ));
    }

    #[test]
    fn replacement_guard_blocks_every_delete_path_and_preserves_races() {
        tauri::async_runtime::block_on(async {
            let mut conn = database().await;
            let (_, c1) = publication("chat-replace", "c1", None, "root");
            assert_eq!(
                admit_publication(&mut conn, &c1, "2026-08-12T12:30:00.000Z")
                    .await
                    .unwrap()
                    .verdict,
                REVISION_ADMITTED
            );
            let original = stored_by_revision(&mut conn, "c1").await;
            let original_rowid: i64 = sqlx::query_scalar(
                "SELECT rowid FROM sync_inbound_revision_observations WHERE revision_id = 'c1'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap();
            sqlx::query(
                "CREATE TEMP TABLE inbound_replacement AS SELECT * FROM sync_inbound_revision_observations WHERE 0",
            )
            .execute(&mut conn)
            .await
            .unwrap();

            // Primary-key conflict: immutable reason/blob replacements cannot
            // delete and recreate the authoritative row.
            sqlx::query(
                "INSERT INTO inbound_replacement SELECT * FROM sync_inbound_revision_observations WHERE revision_id = 'c1'",
            )
            .execute(&mut conn).await.unwrap();
            sqlx::query(
                "UPDATE inbound_replacement SET admission_disposition = 'divergent-staged', admission_reason = 'replacement-attempt', canonical_head_bytes = x'00', canonical_revision_bytes = x'01'",
            )
            .execute(&mut conn).await.unwrap();
            assert!(sqlx::query(
                "INSERT OR REPLACE INTO sync_inbound_revision_observations SELECT * FROM inbound_replacement",
            )
            .execute(&mut conn).await.is_err());
            assert_eq!(stored_by_revision(&mut conn, "c1").await, original);

            // apply_state is independently schema-pinned to not-applied and
            // cannot be smuggled through a replacement statement.
            sqlx::query(
                "UPDATE inbound_replacement SET admission_disposition = 'accepted-linear', apply_state = 'applied'",
            )
            .execute(&mut conn)
            .await
            .unwrap();
            assert!(sqlx::query(
                "INSERT OR REPLACE INTO sync_inbound_revision_observations SELECT * FROM inbound_replacement",
            )
            .execute(&mut conn)
            .await
            .is_err());
            assert_eq!(stored_by_revision(&mut conn, "c1").await, original);

            // Different key, same peer/revision UNIQUE authority.
            sqlx::query("DELETE FROM inbound_replacement")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO inbound_replacement SELECT * FROM sync_inbound_revision_observations WHERE revision_id = 'c1'",
            )
            .execute(&mut conn).await.unwrap();
            sqlx::query(
                "UPDATE inbound_replacement SET key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', revision_key_sha256_hex = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', admission_reason = 'replacement-attempt'",
            )
            .execute(&mut conn).await.unwrap();
            assert!(sqlx::query(
                "INSERT OR REPLACE INTO sync_inbound_revision_observations SELECT * FROM inbound_replacement",
            )
            .execute(&mut conn).await.is_err());
            assert_eq!(stored_by_revision(&mut conn, "c1").await, original);

            // Different revision/key, same accepted parent partial-UNIQUE path.
            sqlx::query("DELETE FROM inbound_replacement")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO inbound_replacement SELECT * FROM sync_inbound_revision_observations WHERE revision_id = 'c1'",
            )
            .execute(&mut conn).await.unwrap();
            sqlx::query(
                "UPDATE inbound_replacement SET key = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', revision_key_sha256_hex = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', revision_id = 'accepted-replacement', admission_reason = 'replacement-attempt'",
            )
            .execute(&mut conn).await.unwrap();
            assert!(sqlx::query(
                "INSERT OR REPLACE INTO sync_inbound_revision_observations SELECT * FROM inbound_replacement",
            )
            .execute(&mut conn).await.is_err());
            assert_eq!(stored_by_revision(&mut conn, "c1").await, original);

            // Explicit rowid is SQLite's fourth replacement-delete authority.
            sqlx::query("DELETE FROM inbound_replacement")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO inbound_replacement SELECT * FROM sync_inbound_revision_observations WHERE revision_id = 'c1'",
            )
            .execute(&mut conn).await.unwrap();
            sqlx::query(
                "UPDATE inbound_replacement SET key = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', revision_key_sha256_hex = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', revision_id = 'rowid-replacement', parent_revision_id = 'other-parent', parent_key = 'p:other-parent', admission_disposition = 'divergent-staged', admission_reason = 'unknown-parent'",
            )
            .execute(&mut conn).await.unwrap();
            assert!(sqlx::query(
                "INSERT OR REPLACE INTO sync_inbound_revision_observations (rowid, key, schema, peer_object_key, object_id, object_key_sha256_hex, revision_id, revision_key_sha256_hex, parent_revision_id, parent_key, admission_disposition, admission_reason, canonical_head_bytes, canonical_revision_bytes, head_sha256_hex, revision_blob_sha256_hex, payload_sha256_hex, writer_sync_peer_id_sha256_hex, observed_state, apply_state, first_observed_at, last_observed_at, observation_count, admitted_at) SELECT ?, key, schema, peer_object_key, object_id, object_key_sha256_hex, revision_id, revision_key_sha256_hex, parent_revision_id, parent_key, admission_disposition, admission_reason, canonical_head_bytes, canonical_revision_bytes, head_sha256_hex, revision_blob_sha256_hex, payload_sha256_hex, writer_sync_peer_id_sha256_hex, observed_state, apply_state, first_observed_at, last_observed_at, observation_count, admitted_at FROM inbound_replacement",
            )
            .bind(original_rowid)
            .execute(&mut conn).await.is_err());
            assert_eq!(stored_by_revision(&mut conn, "c1").await, original);

            assert!(sqlx::query(
                "DELETE FROM sync_inbound_revision_observations WHERE revision_id = 'c1'"
            )
            .execute(&mut conn)
            .await
            .is_err());
            assert_eq!(stored_by_revision(&mut conn, "c1").await, original);

            // A legitimate divergent sibling does not participate in the
            // accepted-child partial index and remains insertable.
            let (_, sibling) = publication("chat-replace", "x1", None, "sibling");
            let sibling_result = admit_publication(&mut conn, &sibling, "2026-08-12T12:30:01.000Z")
                .await
                .unwrap();
            assert_eq!(
                (sibling_result.verdict, sibling_result.reason.as_deref()),
                (REVISION_STAGED_DIVERGENT, Some("sibling-fork"))
            );

            // Replay remains the sole mutable path and changes only its count
            // and last-observed timestamp.
            let before_replay = stored_by_revision(&mut conn, "c1").await;
            let replay_result = admit_publication(&mut conn, &c1, "2026-08-12T12:30:02.000Z")
                .await
                .unwrap();
            assert_eq!(replay_result.verdict, IDENTICAL_REPLAY);
            let after_replay = stored_by_revision(&mut conn, "c1").await;
            assert_eq!(
                after_replay.observation_count,
                before_replay.observation_count + 1
            );
            assert_eq!(after_replay.last_observed_at, "2026-08-12T12:30:02.000Z");
            let mut normalized = after_replay.clone();
            normalized.observation_count = before_replay.observation_count;
            normalized.last_observed_at = before_replay.last_observed_at.clone();
            assert_eq!(normalized, before_replay);

            // Model the unique-conflict result observed after the initial
            // pre-insert read. The normal admission wrapper retries once with
            // force_sibling and deterministically stages the revision.
            let mut race_conn = database().await;
            let (_, race_root) = publication("chat-race", "c1", None, "root");
            admit_publication(&mut race_conn, &race_root, "2026-08-12T12:31:00.000Z")
                .await
                .unwrap();
            sqlx::query(
                "CREATE TEMP TRIGGER simulate_accepted_child_race BEFORE INSERT ON sync_inbound_revision_observations WHEN NEW.revision_id = 'race-child' AND NEW.admission_disposition = 'accepted-linear' BEGIN SELECT RAISE(ABORT, 'sync-inbound-replacement-guard'); END",
            )
            .execute(&mut race_conn).await.unwrap();
            let (_, race_child) = publication("chat-race", "race-child", Some("c1"), "race");
            let raced = admit_publication(&mut race_conn, &race_child, "2026-08-12T12:31:01.000Z")
                .await
                .unwrap();
            assert_eq!(
                (
                    raced.verdict,
                    raced.reason.as_deref(),
                    raced.historical_admission.as_deref(),
                ),
                (
                    REVISION_STAGED_DIVERGENT,
                    Some("sibling-fork"),
                    Some("divergent-staged"),
                )
            );
        });
    }

    #[test]
    fn first_publication_and_pending_chain_cases_are_truthful() {
        tauri::async_runtime::block_on(async {
            let mut conn = database().await;
            let (_, c1) = publication("chat-a", "c1", None, "ok");
            let result = admit_publication(&mut conn, &c1, "2026-08-12T12:00:02.000Z")
                .await
                .unwrap();
            assert_eq!(result.verdict, REVISION_ADMITTED);
            let (_, c2) = publication("chat-a", "c2", Some("c1"), "ok");
            assert_eq!(
                admit_publication(&mut conn, &c2, "2026-08-12T12:00:03.000Z")
                    .await
                    .unwrap()
                    .verdict,
                REVISION_ADMITTED
            );
            let view = project_branches(&mut conn, "chat-a").await.unwrap();
            assert_eq!(view.pending_chain, vec!["c1", "c2"]);

            let mut existing = database().await;
            set_lmr(&mut existing, "chat-b", Some("d1")).await;
            let (_, root) = publication("chat-b", "c1", None, "ok");
            let staged = admit_publication(&mut existing, &root, "2026-08-12T12:00:02.000Z")
                .await
                .unwrap();
            assert_eq!(
                (staged.verdict, staged.reason.as_deref()),
                (REVISION_STAGED_DIVERGENT, Some("competing-root"))
            );
            let (_, child) = publication("chat-b", "c2", Some("d1"), "ok");
            assert_eq!(
                admit_publication(&mut existing, &child, "2026-08-12T12:00:03.000Z")
                    .await
                    .unwrap()
                    .verdict,
                REVISION_ADMITTED
            );
        });
    }

    #[test]
    fn stale_unknown_and_replay_decisions_preserve_the_accepted_chain() {
        tauri::async_runtime::block_on(async {
            let mut conn = database().await;
            set_lmr(&mut conn, "chat-chain", Some("d1")).await;
            let (_, c1) = publication("chat-chain", "c1", Some("d1"), "first");
            let (_, c2) = publication("chat-chain", "c2", Some("c1"), "second");
            let (_, stale) = publication("chat-chain", "stale", Some("d1"), "stale");
            let (_, unknown) = publication("chat-chain", "unknown", Some("missing"), "unknown");
            assert_eq!(
                admit_publication(&mut conn, &c1, "2026-08-12T12:00:02.000Z")
                    .await
                    .unwrap()
                    .verdict,
                REVISION_ADMITTED
            );
            assert_eq!(
                admit_publication(&mut conn, &c2, "2026-08-12T12:00:03.000Z")
                    .await
                    .unwrap()
                    .verdict,
                REVISION_ADMITTED
            );
            let stale_result = admit_publication(&mut conn, &stale, "2026-08-12T12:00:04.000Z")
                .await
                .unwrap();
            assert_eq!(
                (stale_result.verdict, stale_result.reason.as_deref()),
                (REVISION_STAGED_DIVERGENT, Some("sibling-fork"))
            );
            let unknown_result = admit_publication(&mut conn, &unknown, "2026-08-12T12:00:05.000Z")
                .await
                .unwrap();
            assert_eq!(
                (unknown_result.verdict, unknown_result.reason.as_deref()),
                (REVISION_STAGED_DIVERGENT, Some("unknown-parent"))
            );
            let before: (String, String, Vec<u8>, Vec<u8>, i64) = sqlx::query_as(
            "SELECT admission_disposition, admission_reason, canonical_head_bytes, canonical_revision_bytes, observation_count FROM sync_inbound_revision_observations WHERE revision_id = 'c2'",
        ).fetch_one(&mut conn).await.unwrap();
            let replay = admit_publication(&mut conn, &c2, "2026-08-12T12:00:06.000Z")
                .await
                .unwrap();
            assert_eq!(
                (
                    replay.verdict,
                    replay.historical_admission.as_deref(),
                    replay.unchanged_no_op
                ),
                (IDENTICAL_REPLAY, Some("accepted-linear"), true)
            );
            let after: (String, String, Vec<u8>, Vec<u8>, i64) = sqlx::query_as(
            "SELECT admission_disposition, admission_reason, canonical_head_bytes, canonical_revision_bytes, observation_count FROM sync_inbound_revision_observations WHERE revision_id = 'c2'",
        ).fetch_one(&mut conn).await.unwrap();
            assert_eq!(
                (&before.0, &before.1, &before.2, &before.3),
                (&after.0, &after.1, &after.2, &after.3)
            );
            assert_eq!((before.4, after.4), (1, 2));
            let view = project_branches(&mut conn, "chat-chain").await.unwrap();
            assert_eq!(view.pending_chain, vec!["c1", "c2"]);
            assert!(view
                .branches
                .iter()
                .filter(|row| row.historical_admission == "divergent-staged")
                .all(|row| row.current_relationship == "divergent-staged"));

            let mut stale_conn = database().await;
            set_lmr(&mut stale_conn, "chat-stale", Some("d1")).await;
            let (_, accepted) = publication("chat-stale", "c1", Some("d1"), "accepted");
            admit_publication(&mut stale_conn, &accepted, "2026-08-12T12:00:02.000Z")
                .await
                .unwrap();
            set_lmr(&mut stale_conn, "chat-stale", Some("d2")).await;
            let (_, stale_orphan_parent) =
                publication("chat-stale", "c2", Some("c1"), "stale parent");
            let stale = admit_publication(
                &mut stale_conn,
                &stale_orphan_parent,
                "2026-08-12T12:00:03.000Z",
            )
            .await
            .unwrap();
            assert_eq!(
                (stale.verdict, stale.reason.as_deref()),
                (REVISION_STAGED_DIVERGENT, Some("stale-parent"))
            );
        });
    }

    #[test]
    fn sibling_replay_identity_and_baseline_move_preserve_history() {
        tauri::async_runtime::block_on(async {
            let mut conn = database().await;
            set_lmr(&mut conn, "chat-c", Some("d1")).await;
            let (_, c1) = publication("chat-c", "c1", Some("d1"), "ok");
            let (_, x1) = publication("chat-c", "x1", Some("d1"), "ok");
            assert_eq!(
                admit_publication(&mut conn, &c1, "2026-08-12T12:00:02.000Z")
                    .await
                    .unwrap()
                    .verdict,
                REVISION_ADMITTED
            );
            let sibling = admit_publication(&mut conn, &x1, "2026-08-12T12:00:03.000Z")
                .await
                .unwrap();
            assert_eq!(
                (sibling.verdict, sibling.reason.as_deref()),
                (REVISION_STAGED_DIVERGENT, Some("sibling-fork"))
            );
            let replay = admit_publication(&mut conn, &x1, "2026-08-12T12:00:04.000Z")
                .await
                .unwrap();
            assert_eq!(
                (
                    replay.verdict,
                    replay.historical_admission.as_deref(),
                    replay.observation_count
                ),
                (IDENTICAL_REPLAY, Some("divergent-staged"), 2)
            );
            let before: (String, Vec<u8>, Vec<u8>) = sqlx::query_as("SELECT admission_disposition, canonical_head_bytes, canonical_revision_bytes FROM sync_inbound_revision_observations WHERE revision_id = 'c1'").fetch_one(&mut conn).await.unwrap();
            set_lmr(&mut conn, "chat-c", Some("d2")).await;
            let view = project_branches(&mut conn, "chat-c").await.unwrap();
            assert!(view.pending_chain.is_empty());
            assert_eq!(
                view.branches
                    .iter()
                    .find(|row| row.revision_id == "c1")
                    .unwrap()
                    .current_relationship,
                "orphaned-by-baseline-move"
            );
            assert_eq!(
                view.branches
                    .iter()
                    .find(|row| row.revision_id == "x1")
                    .unwrap()
                    .current_relationship,
                "divergent-staged"
            );
            let after: (String, Vec<u8>, Vec<u8>) = sqlx::query_as("SELECT admission_disposition, canonical_head_bytes, canonical_revision_bytes FROM sync_inbound_revision_observations WHERE revision_id = 'c1'").fetch_one(&mut conn).await.unwrap();
            assert_eq!(before, after);
        });
    }

    #[test]
    fn conflicts_drift_delete_quotas_and_redaction_fail_closed() {
        tauri::async_runtime::block_on(async {
            let mut conn = database().await;
            let (_, c1) = publication("chat-d", "c1", None, "ok");
            admit_publication(&mut conn, &c1, "2026-08-12T12:00:02.000Z")
                .await
                .unwrap();
            let mut conflict = c1.clone();
            conflict.head_sha256_hex = "f".repeat(64);
            assert_eq!(
                admit_publication(&mut conn, &conflict, "2026-08-12T12:00:03.000Z")
                    .await
                    .unwrap_err(),
                REVISION_IDENTITY_CONFLICT
            );
            let (_, changed_bytes) =
                publication("chat-d", "c1", None, "different immutable revision bytes");
            assert_eq!(
                admit_publication(&mut conn, &changed_bytes, "2026-08-12T12:00:03.000Z")
                    .await
                    .unwrap_err(),
                REVISION_IDENTITY_CONFLICT
            );

            let mut drift = database().await;
            set_lmr(&mut drift, "chat-e", Some("d1")).await;
            let (_, remote_base) = publication("chat-e", "d1", None, "base");
            admit_publication(&mut drift, &remote_base, "2026-08-12T12:00:00.000Z")
                .await
                .unwrap();
            set_lmr(&mut drift, "chat-e", Some("d2")).await;
            sqlx::query("INSERT INTO sync_object_state VALUES ('peer', 'chat-e', 'd1')")
                .execute(&mut drift)
                .await
                .unwrap();
            let (_, incoming) = publication("chat-e", "c1", Some("d2"), "ok");
            assert_eq!(
                admit_publication(&mut drift, &incoming, "2026-08-12T12:00:02.000Z")
                    .await
                    .unwrap()
                    .reason
                    .as_deref(),
                Some("fast-forward")
            );
            let (_, sibling) = publication("chat-e", "c2", Some("d1"), "sibling");
            assert_eq!(
                admit_publication(&mut drift, &sibling, "2026-08-12T12:00:03.000Z")
                    .await
                    .unwrap()
                    .reason
                    .as_deref(),
                Some("unknown-parent")
            );

            let mut deleted = database().await;
            sqlx::query("INSERT INTO sync_tombstones VALUES ('chat', 'chat-f', NULL)")
                .execute(&mut deleted)
                .await
                .unwrap();
            let (_, incoming) = publication("chat-f", "c1", None, "ok");
            assert_eq!(
                admit_publication(&mut deleted, &incoming, "2026-08-12T12:00:02.000Z")
                    .await
                    .unwrap()
                    .reason
                    .as_deref(),
                Some("baseline-deleted")
            );

            let mut quota = database().await;
            for index in 0..NORMAL_INBOUND_ROWS {
                let (_, row) = publication(
                    "chat-g",
                    &format!("r{index}"),
                    if index == 0 { None } else { Some("unrelated") },
                    "ok",
                );
                admit_publication(&mut quota, &row, "2026-08-12T12:00:02.000Z")
                    .await
                    .unwrap();
            }
            let before: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_inbound_revision_observations")
                    .fetch_one(&mut quota)
                    .await
                    .unwrap();
            let (_, overflow) = publication("chat-g", "overflow", Some("unrelated"), "ok");
            assert_eq!(
                admit_publication(&mut quota, &overflow, "2026-08-12T12:00:02.000Z")
                    .await
                    .unwrap_err(),
                INBOUND_QUOTA_EXCEEDED
            );
            let after: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_inbound_revision_observations")
                    .fetch_one(&mut quota)
                    .await
                    .unwrap();
            assert_eq!((before, after), (NORMAL_INBOUND_ROWS, NORMAL_INBOUND_ROWS));
            let redacted =
                serde_json::to_string(&project_branches(&mut conn, "chat-d").await.unwrap())
                    .unwrap();
            assert!(!redacted.contains(CHROME_WRITER));
            assert!(
                !redacted.contains("canonicalHeadBytes")
                    && !redacted.contains("canonicalRevisionBytes")
            );
        });
    }

    #[test]
    fn hard_baseline_and_insert_failures_write_nothing_and_apply_nothing() {
        tauri::async_runtime::block_on(async {
            let mut baseline_failure = database().await;
            sqlx::query("DROP TABLE chats")
                .execute(&mut baseline_failure)
                .await
                .unwrap();
            let (_, incoming) = publication("chat-failure", "c1", None, "ok");
            assert_eq!(
                admit_publication(&mut baseline_failure, &incoming, "2026-08-12T12:00:02.000Z")
                    .await
                    .unwrap_err(),
                BASELINE_UNAVAILABLE
            );
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_inbound_revision_observations")
                    .fetch_one(&mut baseline_failure)
                    .await
                    .unwrap();
            assert_eq!(count, 0);

            let mut insert_failure = database().await;
            sqlx::query("CREATE TRIGGER reject_inbound_insert BEFORE INSERT ON sync_inbound_revision_observations BEGIN SELECT RAISE(ABORT, 'injected-insert-failure'); END")
            .execute(&mut insert_failure).await.unwrap();
            assert_eq!(
                admit_publication(&mut insert_failure, &incoming, "2026-08-12T12:00:02.000Z")
                    .await
                    .unwrap_err(),
                BASELINE_UNAVAILABLE
            );
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM sync_inbound_revision_observations")
                    .fetch_one(&mut insert_failure)
                    .await
                    .unwrap();
            assert_eq!(count, 0);

            let mut apply_boundary = database().await;
            let before: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM chats), (SELECT COUNT(*) FROM sync_tombstones), (SELECT COUNT(*) FROM sync_object_state)",
        ).fetch_one(&mut apply_boundary).await.unwrap();
            admit_publication(&mut apply_boundary, &incoming, "2026-08-12T12:00:02.000Z")
                .await
                .unwrap();
            let after: (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM chats), (SELECT COUNT(*) FROM sync_tombstones), (SELECT COUNT(*) FROM sync_object_state)",
        ).fetch_one(&mut apply_boundary).await.unwrap();
            assert_eq!(before, after);
        });
    }

    #[test]
    // Opt-in: V9 raised the aggregate byte budget to 128 MiB, so exercising
    // it end-to-end writes ~128 MiB through SQLite and dominates the suite
    // (~9 minutes). The cheap row-bound test above already proves refusal
    // without eviction, and the deterministic V9 parity vectors cover the
    // byte boundaries. Run explicitly with:
    //   cargo test --lib canonical_byte_quota -- --ignored
    #[ignore]
    fn canonical_byte_quota_is_per_object_and_refuses_without_eviction() {
        tauri::async_runtime::block_on(async {
            let mut conn = database().await;
            // The canonical payload carries the text in both the compact message
            // and rich-turn form, keeping each row below 5 MiB while six rows stay
            // below the per-object aggregate bound and the seventh exceeds it.
            // Version-agnostic: fill until the aggregate byte bound refuses, rather
            // than pinning a row count derived from the superseded 32 MiB limit.
            // The intent under test is unchanged - the byte bound refuses WITHOUT
            // evicting anything - and it holds for any configured budget.
            let large_text = "x".repeat(2_450_000);
            let mut filled: i64 = 0;
            loop {
                let before: (i64, i64) = sqlx::query_as(
                    "SELECT COUNT(*), COALESCE(SUM(LENGTH(canonical_head_bytes) + LENGTH(canonical_revision_bytes)), 0) FROM sync_inbound_revision_observations",
                ).fetch_one(&mut conn).await.unwrap();
                let (_, row) = publication(
                    "chat-byte-quota",
                    &format!("large-{filled}"),
                    Some(&format!("unknown-{filled}")),
                    &large_text,
                );
                match admit_publication(&mut conn, &row, "2026-08-12T12:00:02.000Z").await {
                    Ok(result) => {
                        assert_eq!(result.verdict, REVISION_STAGED_DIVERGENT);
                        filled += 1;
                    }
                    Err(error) => {
                        assert_eq!(error, INBOUND_QUOTA_EXCEEDED);
                        let after: (i64, i64) = sqlx::query_as(
                            "SELECT COUNT(*), COALESCE(SUM(LENGTH(canonical_head_bytes) + LENGTH(canonical_revision_bytes)), 0) FROM sync_inbound_revision_observations",
                        ).fetch_one(&mut conn).await.unwrap();
                        assert_eq!(before, after, "capacity refusal evicts nothing");
                        assert!(before.1 <= NORMAL_INBOUND_CANONICAL_BYTES);
                        assert!(filled > 0, "the byte bound must admit before it refuses");
                        break;
                    }
                }
                assert!(
                    filled < NORMAL_INBOUND_ROWS,
                    "the byte bound must bind before the row bound for large revisions",
                );
            }
        });
    }

    #[test]
    fn stored_hash_corruption_and_unique_roots_are_detected() {
        tauri::async_runtime::block_on(async {
            let mut conn = database().await;
            let (_, c1) = publication("chat-h", "c1", None, "ok");
            admit_publication(&mut conn, &c1, "2026-08-12T12:00:02.000Z")
                .await
                .unwrap();
            let duplicate = sqlx::query("INSERT INTO sync_inbound_revision_observations SELECT 'other', schema, peer_object_key, object_id, object_key_sha256_hex, 'other', 'other-key', parent_revision_id, parent_key, admission_disposition, admission_reason, canonical_head_bytes, canonical_revision_bytes, head_sha256_hex, revision_blob_sha256_hex, payload_sha256_hex, writer_sync_peer_id_sha256_hex, observed_state, apply_state, first_observed_at, last_observed_at, observation_count, admitted_at FROM sync_inbound_revision_observations WHERE revision_id = 'c1'").execute(&mut conn).await;
            assert!(duplicate.is_err());
            assert!(sqlx::query("UPDATE sync_inbound_revision_observations SET admission_disposition = 'divergent-staged'").execute(&mut conn).await.is_err());
            assert!(
                sqlx::query("DELETE FROM sync_inbound_revision_observations")
                    .execute(&mut conn)
                    .await
                    .is_err()
            );
            sqlx::query("DROP TRIGGER trg_sync_inbound_immutable_authority")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query(
                "UPDATE sync_inbound_revision_observations SET canonical_head_bytes = x'00'",
            )
            .execute(&mut conn)
            .await
            .unwrap();
            assert_eq!(
                project_branches(&mut conn, "chat-h").await.unwrap_err(),
                BASELINE_UNAVAILABLE
            );
        });
    }

    #[test]
    fn ambiguous_accepted_children_fail_read_derivation_without_choosing() {
        tauri::async_runtime::block_on(async {
            let mut conn = database().await;
            set_lmr(&mut conn, "chat-ambiguous", Some("d1")).await;
            let (_, c1) = publication("chat-ambiguous", "c1", Some("d1"), "one");
            let (_, x1) = publication("chat-ambiguous", "x1", Some("d1"), "two");
            admit_publication(&mut conn, &c1, "2026-08-12T12:00:02.000Z")
                .await
                .unwrap();
            sqlx::query("DROP INDEX idx_sync_inbound_one_accepted_child")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query("DROP TRIGGER trg_sync_inbound_replacement_guard")
                .execute(&mut conn)
                .await
                .unwrap();
            let mut tx = conn.begin().await.unwrap();
            insert_observation(
                &mut tx,
                &x1,
                "accepted-linear",
                "fast-forward",
                "2026-08-12T12:00:03.000Z",
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            assert_eq!(
                project_branches(&mut conn, "chat-ambiguous")
                    .await
                    .unwrap_err(),
                "ambiguous-accepted-children"
            );

            let mut cycle = database().await;
            let (_, cycle_one) = publication("chat-cycle", "c1", Some("c2"), "one");
            let (_, cycle_two) = publication("chat-cycle", "c2", Some("c1"), "two");
            let mut tx = cycle.begin().await.unwrap();
            insert_observation(
                &mut tx,
                &cycle_one,
                "accepted-linear",
                "fast-forward",
                "2026-08-12T12:00:02.000Z",
            )
            .await
            .unwrap();
            insert_observation(
                &mut tx,
                &cycle_two,
                "accepted-linear",
                "fast-forward",
                "2026-08-12T12:00:03.000Z",
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            assert_eq!(
                project_branches(&mut cycle, "chat-cycle")
                    .await
                    .unwrap_err(),
                "ambiguous-accepted-children"
            );
        });
    }
}
