//! Transport-free sync revision/head document authority.
//!
//! These primitives define the canonical bytes of a Round 2A revision envelope
//! and head document.  They depend only on serde, never on transport, secret or
//! registry material and never on a remote request/response, so both the WebDAV
//! transport and any local direct-delivery producer can share one document
//! implementation instead of growing a second one.
//!
//! Definitions here were moved verbatim from `sync_object_transport.rs`; only
//! visibility was widened to `pub(crate)` where the transport module needs it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const REVISION_SCHEMA: &str = "h2o.studio.syncRevision.v1";
pub(crate) const HEAD_SCHEMA: &str = "h2o.studio.syncHead.v1";
const DESKTOP_WRITER_PREFIX: &str = "studio-desktop:tauri-desktop:sqlite:";
const CHROME_WRITER_PREFIX: &str = "studio-chrome:mv3-chrome:idb-archive:";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PeerWriterRole {
    DesktopOutbound,
    ChromeInbound,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn object_key_hex(object_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"studio.chat.saved-state.v1");
    hash.update([0]);
    hash.update(object_id.as_bytes());
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn is_lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SyncRevision {
    pub(crate) schema: String,
    #[serde(rename = "objectId")]
    pub(crate) object_id: String,
    #[serde(rename = "objectKey")]
    pub(crate) object_key: String,
    #[serde(rename = "revisionId")]
    pub(crate) revision_id: String,
    #[serde(rename = "payloadSha256")]
    pub(crate) payload_sha256: String,
    pub(crate) payload: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SyncHead {
    pub schema: String,
    #[serde(rename = "objectId")]
    pub object_id: String,
    #[serde(rename = "objectKey")]
    pub object_key: String,
    #[serde(rename = "revisionId")]
    pub revision_id: String,
    #[serde(rename = "payloadSha256")]
    pub payload_sha256: String,
    #[serde(rename = "revisionBlobSha256")]
    pub revision_blob_sha256: String,
    #[serde(rename = "writerSyncPeerId")]
    pub writer_sync_peer_id: String,
    #[serde(rename = "previousRevisionId")]
    pub previous_revision_id: Option<String>,
    #[serde(rename = "sourceUpdatedAtIso")]
    pub source_updated_at_iso: String,
}

pub(crate) fn canonical_value(value: &Value) -> Result<String, String> {
    fn normalize(value: &Value) -> Result<Value, String> {
        match value {
            Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.clone()),
            Value::Number(number) => {
                if number.as_f64().is_some_and(f64::is_finite) {
                    Ok(value.clone())
                } else {
                    Err("round2a-json-number-invalid".into())
                }
            }
            Value::Array(items) => items
                .iter()
                .map(normalize)
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array),
            Value::Object(map) => {
                let mut sorted = serde_json::Map::new();
                let mut keys = map.keys().collect::<Vec<_>>();
                keys.sort();
                for key in keys {
                    sorted.insert(key.clone(), normalize(&map[key])?);
                }
                Ok(Value::Object(sorted))
            }
        }
    }
    serde_json::to_string(&normalize(value)?).map_err(|_| "round2a-json-invalid".into())
}

pub(crate) fn canonical_head(head: &SyncHead) -> Result<String, String> {
    let value = serde_json::to_value(head).map_err(|_| "round2a-head-invalid")?;
    canonical_value(&value)
}

pub(crate) fn valid_identity(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)
}

fn is_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => *byte == b'4',
            19 => matches!(*byte, b'8' | b'9' | b'a' | b'b'),
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
}

pub(crate) fn valid_writer_identity(value: &str, role: PeerWriterRole) -> bool {
    let prefix = match role {
        PeerWriterRole::DesktopOutbound => DESKTOP_WRITER_PREFIX,
        PeerWriterRole::ChromeInbound => CHROME_WRITER_PREFIX,
    };
    value.strip_prefix(prefix).is_some_and(is_uuid_v4)
}
