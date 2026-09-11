//! P02 Wave 1 / Z1 transport-free v2 sync contract authority.
//!
//! These models are additive and deliberately live beside the frozen P01 v1
//! models in `sync_object_document`. Every document is strict, version-tagged,
//! canonical-byte checked, and free of transport or persistent-state effects.

use crate::sync_object_document::{canonical_value, is_lower_hex_64, sha256_hex};
use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(crate) const REVISION_SCHEMA_V2: &str = "h2o.studio.syncRevision.v2";
pub(crate) const HEAD_SCHEMA_V2: &str = "h2o.studio.syncHead.v2";
pub(crate) const CLOSURE_PAYLOAD_SCHEMA_V1: &str = "h2o.studio.syncClosurePayload.v1";
pub(crate) const HEADS_SNAPSHOT_SCHEMA_V2: &str = "h2o.studio.syncHeadsSnapshot.v2";
pub(crate) const WRITER_STATE_SCHEMA_V2: &str = "h2o.studio.syncWriterState.v2";
pub(crate) const LIBRARY_INFO_SCHEMA_V1: &str = "h2o.studio.syncLibraryInfo.v1";
pub(crate) const LEGACY_BASELINE_RECEIPT_SCHEMA_V1: &str =
    "h2o.studio.syncLegacyBaselineReceipt.v1";

pub(crate) const MAX_REVISION_BYTES_V2: usize = 5 * 1024 * 1024;
pub(crate) const MAX_PAYLOAD_BYTES_V2: usize = 5 * 1024 * 1024;
pub(crate) const MAX_HEAD_BYTES_V2: usize = 64 * 1024;
pub(crate) const MAX_HEADS_SNAPSHOT_BYTES_V2: usize = 5 * 1024 * 1024;
pub(crate) const MAX_POINTER_BYTES_V2: usize = 4 * 1024;
pub(crate) const MAX_LIBRARY_INFO_BYTES_V2: usize = 64 * 1024;
pub(crate) const MAX_RECEIPT_BYTES_V2: usize = 64 * 1024;
pub(crate) const MAX_ID_LENGTH_V2: usize = 512;

pub(crate) const FORMAT_VERSION_V2: u64 = 2;
pub(crate) const PROTOCOL_VERSION_V2: u64 = 2;
pub(crate) const LAYOUT_EPOCH_V2: u64 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ContractErrorV2 {
    SchemaInvalid,
    CanonicalBytesMismatch,
    ObjectKeyMismatch,
    PayloadHashMismatch,
    BlobAddressMismatch,
    LimitExceeded,
    UnsupportedFormat,
    UnsupportedProtocol,
    UnsupportedEpoch,
}

impl ContractErrorV2 {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::SchemaInvalid => "p02-z1-schema-invalid",
            Self::CanonicalBytesMismatch => "p02-z1-canonical-bytes-mismatch",
            Self::ObjectKeyMismatch => "p02-z1-object-key-mismatch",
            Self::PayloadHashMismatch => "p02-z1-payload-hash-mismatch",
            Self::BlobAddressMismatch => "p02-z1-blob-address-mismatch",
            Self::LimitExceeded => "p02-z1-limit-exceeded",
            Self::UnsupportedFormat => "p02-z1-unsupported-format",
            Self::UnsupportedProtocol => "p02-z1-unsupported-protocol",
            Self::UnsupportedEpoch => "p02-z1-unsupported-epoch",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ContractKindV2 {
    Revision,
    Head,
    HeadsSnapshot,
    WriterState,
    LibraryInfo,
    LegacyBaselineReceipt,
}

impl ContractKindV2 {
    fn parse(value: &str) -> Result<Self, ContractErrorV2> {
        match value {
            "revision" => Ok(Self::Revision),
            "head" => Ok(Self::Head),
            "heads-snapshot" => Ok(Self::HeadsSnapshot),
            "writer-state" => Ok(Self::WriterState),
            "library-info" => Ok(Self::LibraryInfo),
            "legacy-baseline-receipt" => Ok(Self::LegacyBaselineReceipt),
            _ => Err(ContractErrorV2::SchemaInvalid),
        }
    }

    fn maximum_bytes(self) -> usize {
        match self {
            Self::Revision => MAX_REVISION_BYTES_V2,
            Self::Head => MAX_HEAD_BYTES_V2,
            Self::HeadsSnapshot => MAX_HEADS_SNAPSHOT_BYTES_V2,
            Self::WriterState => MAX_POINTER_BYTES_V2,
            Self::LibraryInfo => MAX_LIBRARY_INFO_BYTES_V2,
            Self::LegacyBaselineReceipt => MAX_RECEIPT_BYTES_V2,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub(crate) struct RequiredNullable<T>(pub(crate) Option<T>);

impl<'de, T> Deserialize<'de> for RequiredNullable<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Self)
    }
}

fn deserialize_optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub(crate) enum ClosureTypeV2 {
    ObjectDeleted,
    BranchSuperseded,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SelectedRevisionV2 {
    #[serde(rename = "revisionId")]
    pub(crate) revision_id: String,
    #[serde(rename = "revisionBlobSha256")]
    pub(crate) revision_blob_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SyncRevisionV2 {
    pub(crate) schema: String,
    #[serde(rename = "objectDomain")]
    pub(crate) object_domain: String,
    #[serde(rename = "objectId")]
    pub(crate) object_id: String,
    #[serde(rename = "revisionId")]
    pub(crate) revision_id: String,
    #[serde(rename = "previousRevisionId")]
    pub(crate) previous_revision_id: RequiredNullable<String>,
    #[serde(rename = "previousRevisionBlobSha256")]
    pub(crate) previous_revision_blob_sha256: RequiredNullable<String>,
    #[serde(rename = "payloadSha256")]
    pub(crate) payload_sha256: String,
    #[serde(rename = "writerSyncPeerId")]
    pub(crate) writer_sync_peer_id: String,
    pub(crate) payload: Value,
    #[serde(
        rename = "closureType",
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) closure_type: Option<ClosureTypeV2>,
    #[serde(
        rename = "selectedRevision",
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub(crate) selected_revision: Option<SelectedRevisionV2>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct SyncHeadV2 {
    pub(crate) schema: String,
    #[serde(rename = "objectDomain")]
    pub(crate) object_domain: String,
    #[serde(rename = "objectId")]
    pub(crate) object_id: String,
    #[serde(rename = "objectKey")]
    pub(crate) object_key: String,
    #[serde(rename = "revisionId")]
    pub(crate) revision_id: String,
    #[serde(rename = "payloadSha256")]
    pub(crate) payload_sha256: String,
    #[serde(rename = "revisionBlobSha256")]
    pub(crate) revision_blob_sha256: String,
    #[serde(rename = "writerSyncPeerId")]
    pub(crate) writer_sync_peer_id: String,
    #[serde(rename = "previousRevisionId")]
    pub(crate) previous_revision_id: RequiredNullable<String>,
    #[serde(rename = "previousRevisionBlobSha256")]
    pub(crate) previous_revision_blob_sha256: RequiredNullable<String>,
    #[serde(rename = "sourceUpdatedAtIso")]
    pub(crate) source_updated_at_iso: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct HeadsTipV2 {
    #[serde(rename = "revisionId")]
    pub(crate) revision_id: String,
    #[serde(rename = "payloadSha256")]
    pub(crate) payload_sha256: String,
    #[serde(rename = "revisionBlobSha256")]
    pub(crate) revision_blob_sha256: String,
    #[serde(rename = "previousRevisionId")]
    pub(crate) previous_revision_id: RequiredNullable<String>,
    #[serde(rename = "previousRevisionBlobSha256")]
    pub(crate) previous_revision_blob_sha256: RequiredNullable<String>,
    #[serde(rename = "sourceUpdatedAtIso")]
    pub(crate) source_updated_at_iso: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct HeadsObjectGroupV2 {
    #[serde(rename = "headSchema")]
    pub(crate) head_schema: String,
    #[serde(rename = "objectDomain")]
    pub(crate) object_domain: String,
    #[serde(rename = "objectId")]
    pub(crate) object_id: String,
    #[serde(rename = "objectKey")]
    pub(crate) object_key: String,
    pub(crate) tips: Vec<HeadsTipV2>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct HeadsSnapshotV2 {
    pub(crate) schema: String,
    #[serde(rename = "writerSyncPeerId")]
    pub(crate) writer_sync_peer_id: String,
    pub(crate) objects: Vec<HeadsObjectGroupV2>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct WriterStateV2 {
    pub(crate) schema: String,
    #[serde(rename = "writerSyncPeerId")]
    pub(crate) writer_sync_peer_id: String,
    #[serde(rename = "currentHeadsSnapshotSha256")]
    pub(crate) current_heads_snapshot_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct LibraryInfoV2 {
    pub(crate) schema: String,
    #[serde(rename = "formatVersion")]
    pub(crate) format_version: u64,
    #[serde(rename = "minimumCompatibleProtocolVersion")]
    pub(crate) minimum_compatible_protocol_version: u64,
    #[serde(rename = "layoutEpoch")]
    pub(crate) layout_epoch: u64,
    #[serde(rename = "legacyBaselineReceiptSha256")]
    pub(crate) legacy_baseline_receipt_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(tag = "status", deny_unknown_fields)]
pub(crate) enum LegacyArtifactObservationV1 {
    #[serde(rename = "absent")]
    Absent,
    #[serde(rename = "sha256")]
    Sha256 { sha256: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyArtifactReceiptV1 {
    pub(crate) path: String,
    pub(crate) observation: LegacyArtifactObservationV1,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct LegacyBaselineReceiptV1 {
    pub(crate) schema: String,
    pub(crate) artifacts: Vec<LegacyArtifactReceiptV1>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(untagged)]
pub(crate) enum ContractDocumentV2 {
    Revision(SyncRevisionV2),
    Head(SyncHeadV2),
    HeadsSnapshot(HeadsSnapshotV2),
    WriterState(WriterStateV2),
    LibraryInfo(LibraryInfoV2),
    LegacyBaselineReceipt(LegacyBaselineReceiptV1),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ContractPolicyV2 {
    pub(crate) format_version: u64,
    pub(crate) protocol_version: u64,
    pub(crate) layout_epoch: u64,
}

impl Default for ContractPolicyV2 {
    fn default() -> Self {
        Self {
            format_version: FORMAT_VERSION_V2,
            protocol_version: PROTOCOL_VERSION_V2,
            layout_epoch: LAYOUT_EPOCH_V2,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ValidatedContractDocumentV2 {
    pub(crate) document: ContractDocumentV2,
    pub(crate) blob_sha256: String,
}

pub(crate) fn object_key_hex_v2(object_domain: &str, object_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(object_domain.as_bytes());
    hash.update([0]);
    hash.update(object_id.as_bytes());
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn writer_key_hex_v2(writer_sync_peer_id: &str) -> String {
    object_key_hex_v2("h2o.studio.sync-writer.v1", writer_sync_peer_id)
}

fn strict_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_ID_LENGTH_V2
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn object_domain(value: &str) -> bool {
    strict_identifier(value) && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && matches!(bytes[4], b'-')
        && matches!(bytes[7], b'-')
        && matches!(bytes[10], b'T')
        && matches!(bytes[13], b':')
        && matches!(bytes[16], b':')
        && matches!(bytes[19], b'.')
        && matches!(bytes[23], b'Z')
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        })
}

fn parent_pair_valid(
    revision_id: &RequiredNullable<String>,
    blob_sha256: &RequiredNullable<String>,
) -> bool {
    match (&revision_id.0, &blob_sha256.0) {
        (None, None) => true,
        (Some(revision), Some(blob)) => strict_identifier(revision) && is_lower_hex_64(blob),
        _ => false,
    }
}

fn decode_canonical(kind: ContractKindV2, bytes: &[u8]) -> Result<Value, ContractErrorV2> {
    if bytes.is_empty() || bytes.len() > kind.maximum_bytes() {
        return Err(ContractErrorV2::LimitExceeded);
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| ContractErrorV2::SchemaInvalid)?;
    if !value.is_object() {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    let canonical = canonical_value(&value).map_err(|_| ContractErrorV2::SchemaInvalid)?;
    if canonical.as_bytes() != bytes {
        return Err(ContractErrorV2::CanonicalBytesMismatch);
    }
    Ok(value)
}

fn parse_typed<T>(value: Value) -> Result<T, ContractErrorV2>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(value).map_err(|_| ContractErrorV2::SchemaInvalid)
}

fn required_parent_keys_present(value: &Value) -> bool {
    value.as_object().is_some_and(|object| {
        object.contains_key("previousRevisionId")
            && object.contains_key("previousRevisionBlobSha256")
    })
}

fn validate_revision(value: Value) -> Result<SyncRevisionV2, ContractErrorV2> {
    if !required_parent_keys_present(&value) {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    let revision: SyncRevisionV2 = parse_typed(value)?;
    if revision.schema != REVISION_SCHEMA_V2
        || !object_domain(&revision.object_domain)
        || !strict_identifier(&revision.object_id)
        || !strict_identifier(&revision.revision_id)
        || !strict_identifier(&revision.writer_sync_peer_id)
        || !is_lower_hex_64(&revision.payload_sha256)
        || !revision.payload.is_object()
        || !parent_pair_valid(
            &revision.previous_revision_id,
            &revision.previous_revision_blob_sha256,
        )
    {
        return Err(ContractErrorV2::SchemaInvalid);
    }

    match (&revision.closure_type, &revision.selected_revision) {
        (None, None) => {}
        (Some(ClosureTypeV2::ObjectDeleted), None) => {
            validate_closure_payload(&revision)?;
        }
        (Some(ClosureTypeV2::BranchSuperseded), Some(selected)) => {
            validate_closure_payload(&revision)?;
            if !strict_identifier(&selected.revision_id)
                || !is_lower_hex_64(&selected.revision_blob_sha256)
                || revision.previous_revision_id.0.as_ref() == Some(&selected.revision_id)
                || revision.previous_revision_blob_sha256.0.as_ref()
                    == Some(&selected.revision_blob_sha256)
            {
                return Err(ContractErrorV2::SchemaInvalid);
            }
        }
        _ => return Err(ContractErrorV2::SchemaInvalid),
    }

    let payload = canonical_value(&revision.payload).map_err(|_| ContractErrorV2::SchemaInvalid)?;
    if payload.len() > MAX_PAYLOAD_BYTES_V2 {
        return Err(ContractErrorV2::LimitExceeded);
    }
    if sha256_hex(payload.as_bytes()) != revision.payload_sha256 {
        return Err(ContractErrorV2::PayloadHashMismatch);
    }
    Ok(revision)
}

fn validate_closure_payload(revision: &SyncRevisionV2) -> Result<(), ContractErrorV2> {
    let valid_payload = revision.payload.as_object().is_some_and(|payload| {
        payload.len() == 1
            && payload.get("schema").and_then(Value::as_str) == Some(CLOSURE_PAYLOAD_SCHEMA_V1)
    });
    if revision.previous_revision_id.0.is_none() || !valid_payload {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    Ok(())
}

fn validate_head_struct(head: &SyncHeadV2) -> Result<(), ContractErrorV2> {
    if head.schema != HEAD_SCHEMA_V2
        || !object_domain(&head.object_domain)
        || !strict_identifier(&head.object_id)
        || !strict_identifier(&head.revision_id)
        || !strict_identifier(&head.writer_sync_peer_id)
        || !is_lower_hex_64(&head.object_key)
        || !is_lower_hex_64(&head.payload_sha256)
        || !is_lower_hex_64(&head.revision_blob_sha256)
        || !timestamp(&head.source_updated_at_iso)
        || !parent_pair_valid(
            &head.previous_revision_id,
            &head.previous_revision_blob_sha256,
        )
    {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    if object_key_hex_v2(&head.object_domain, &head.object_id) != head.object_key {
        return Err(ContractErrorV2::ObjectKeyMismatch);
    }
    Ok(())
}

fn validate_head(value: Value) -> Result<SyncHeadV2, ContractErrorV2> {
    if !required_parent_keys_present(&value) {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    let head: SyncHeadV2 = parse_typed(value)?;
    validate_head_struct(&head)?;
    Ok(head)
}

fn validate_heads_snapshot(value: Value) -> Result<HeadsSnapshotV2, ContractErrorV2> {
    let all_parent_keys_present =
        value
            .get("objects")
            .and_then(Value::as_array)
            .is_some_and(|groups| {
                groups.iter().all(|group| {
                    group
                        .get("tips")
                        .and_then(Value::as_array)
                        .is_some_and(|tips| tips.iter().all(required_parent_keys_present))
                })
            });
    if !all_parent_keys_present {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    let snapshot: HeadsSnapshotV2 = parse_typed(value)?;
    if snapshot.schema != HEADS_SNAPSHOT_SCHEMA_V2
        || !strict_identifier(&snapshot.writer_sync_peer_id)
        || snapshot.objects.is_empty()
    {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    let mut object_keys = BTreeSet::new();
    for group in &snapshot.objects {
        if group.head_schema != HEAD_SCHEMA_V2
            || !object_domain(&group.object_domain)
            || !strict_identifier(&group.object_id)
            || !is_lower_hex_64(&group.object_key)
            || group.tips.is_empty()
            || !object_keys.insert(group.object_key.clone())
        {
            return Err(ContractErrorV2::SchemaInvalid);
        }
        let mut tip_blobs = BTreeSet::new();
        for tip in &group.tips {
            if !tip_blobs.insert(tip.revision_blob_sha256.clone()) {
                return Err(ContractErrorV2::SchemaInvalid);
            }
            let head = SyncHeadV2 {
                schema: group.head_schema.clone(),
                object_domain: group.object_domain.clone(),
                object_id: group.object_id.clone(),
                object_key: group.object_key.clone(),
                revision_id: tip.revision_id.clone(),
                payload_sha256: tip.payload_sha256.clone(),
                revision_blob_sha256: tip.revision_blob_sha256.clone(),
                writer_sync_peer_id: snapshot.writer_sync_peer_id.clone(),
                previous_revision_id: tip.previous_revision_id.clone(),
                previous_revision_blob_sha256: tip.previous_revision_blob_sha256.clone(),
                source_updated_at_iso: tip.source_updated_at_iso.clone(),
            };
            validate_head_struct(&head)?;
        }
    }
    Ok(snapshot)
}

fn validate_writer_state(value: Value) -> Result<WriterStateV2, ContractErrorV2> {
    let pointer: WriterStateV2 = parse_typed(value)?;
    if pointer.schema != WRITER_STATE_SCHEMA_V2
        || !strict_identifier(&pointer.writer_sync_peer_id)
        || !is_lower_hex_64(&pointer.current_heads_snapshot_sha256)
    {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    Ok(pointer)
}

fn validate_library_info(
    value: Value,
    policy: ContractPolicyV2,
) -> Result<LibraryInfoV2, ContractErrorV2> {
    let info: LibraryInfoV2 = parse_typed(value)?;
    if info.schema != LIBRARY_INFO_SCHEMA_V1
        || info.format_version == 0
        || info.minimum_compatible_protocol_version == 0
        || info.layout_epoch == 0
        || !is_lower_hex_64(&info.legacy_baseline_receipt_sha256)
    {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    if info.format_version != policy.format_version {
        return Err(ContractErrorV2::UnsupportedFormat);
    }
    if info.minimum_compatible_protocol_version > policy.protocol_version {
        return Err(ContractErrorV2::UnsupportedProtocol);
    }
    if info.layout_epoch != policy.layout_epoch {
        return Err(ContractErrorV2::UnsupportedEpoch);
    }
    Ok(info)
}

fn validate_legacy_receipt(value: Value) -> Result<LegacyBaselineReceiptV1, ContractErrorV2> {
    let receipt: LegacyBaselineReceiptV1 = parse_typed(value)?;
    if receipt.schema != LEGACY_BASELINE_RECEIPT_SCHEMA_V1 || receipt.artifacts.is_empty() {
        return Err(ContractErrorV2::SchemaInvalid);
    }
    let mut previous_path = None::<&str>;
    for artifact in &receipt.artifacts {
        if !strict_identifier(&artifact.path)
            || !artifact
                .path
                .bytes()
                .all(|byte| (0x21..=0x7e).contains(&byte))
            || previous_path.is_some_and(|previous| artifact.path.as_str() <= previous)
        {
            return Err(ContractErrorV2::SchemaInvalid);
        }
        if let LegacyArtifactObservationV1::Sha256 { sha256 } = &artifact.observation {
            if !is_lower_hex_64(sha256) {
                return Err(ContractErrorV2::SchemaInvalid);
            }
        }
        previous_path = Some(&artifact.path);
    }
    Ok(receipt)
}

pub(crate) fn validate_contract_document_v2(
    kind: ContractKindV2,
    bytes: &[u8],
    expected_blob_sha256: Option<&str>,
    policy: ContractPolicyV2,
) -> Result<ValidatedContractDocumentV2, ContractErrorV2> {
    let value = decode_canonical(kind, bytes)?;
    let document = match kind {
        ContractKindV2::Revision => ContractDocumentV2::Revision(validate_revision(value)?),
        ContractKindV2::Head => ContractDocumentV2::Head(validate_head(value)?),
        ContractKindV2::HeadsSnapshot => {
            ContractDocumentV2::HeadsSnapshot(validate_heads_snapshot(value)?)
        }
        ContractKindV2::WriterState => {
            ContractDocumentV2::WriterState(validate_writer_state(value)?)
        }
        ContractKindV2::LibraryInfo => {
            ContractDocumentV2::LibraryInfo(validate_library_info(value, policy)?)
        }
        ContractKindV2::LegacyBaselineReceipt => {
            ContractDocumentV2::LegacyBaselineReceipt(validate_legacy_receipt(value)?)
        }
    };
    let blob_sha256 = sha256_hex(bytes);
    if expected_blob_sha256
        .is_some_and(|expected| !is_lower_hex_64(expected) || expected != blob_sha256)
    {
        return Err(ContractErrorV2::BlobAddressMismatch);
    }
    Ok(ValidatedContractDocumentV2 {
        document,
        blob_sha256,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn vectors() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../tools/validation/sync/fixtures/p02-z1-contract-vectors.json");
        serde_json::from_slice(&fs::read(path).expect("read shared P02 Z1 vectors"))
            .expect("parse shared P02 Z1 vectors")
    }

    #[test]
    fn positive_contract_vectors_match_canonical_bytes_and_hashes() {
        let vectors = vectors();
        let positives = vectors["positive"].as_array().expect("positive vectors");
        for vector in positives {
            let id = vector["id"].as_str().expect("vector id");
            let kind =
                ContractKindV2::parse(vector["kind"].as_str().expect("kind")).expect("known kind");
            let bytes = vector["canonicalBytes"]
                .as_str()
                .expect("canonical bytes")
                .as_bytes();
            let expected = vector["sha256"].as_str().expect("sha256");
            let validated = validate_contract_document_v2(
                kind,
                bytes,
                Some(expected),
                ContractPolicyV2::default(),
            )
            .unwrap_or_else(|error| panic!("positive vector {id}: {}", error.as_str()));
            assert_eq!(validated.blob_sha256, expected, "positive vector {id}");
            let produced = serde_json::to_value(&validated.document).expect("serialize model");
            assert_eq!(
                canonical_value(&produced).expect("canonicalize typed model"),
                std::str::from_utf8(bytes).unwrap()
            );
        }
    }

    #[test]
    fn negative_contract_vectors_reject_with_authoritative_class() {
        let vectors = vectors();
        let negatives = vectors["negative"].as_array().expect("negative vectors");
        for vector in negatives {
            let id = vector["id"].as_str().expect("vector id");
            let kind =
                ContractKindV2::parse(vector["kind"].as_str().expect("kind")).expect("known kind");
            let bytes = if vector["generator"] == "over-limit-revision" {
                vec![b'x'; MAX_REVISION_BYTES_V2 + 1]
            } else {
                vector["canonicalBytes"]
                    .as_str()
                    .expect("canonical bytes")
                    .as_bytes()
                    .to_vec()
            };
            assert_eq!(
                sha256_hex(&bytes),
                vector["sha256"].as_str().expect("negative vector hash"),
                "negative vector bytes drifted: {id}"
            );
            let expected_blob = vector["expectedBlobSha256"].as_str();
            let error = validate_contract_document_v2(
                kind,
                &bytes,
                expected_blob,
                ContractPolicyV2::default(),
            )
            .expect_err(id);
            assert_eq!(
                error.as_str(),
                vector["expectedClass"].as_str().expect("expected class"),
                "negative vector {id}"
            );
        }
    }

    #[test]
    fn shared_vector_constants_pin_the_frozen_baselines() {
        let vectors = vectors();
        assert_eq!(vectors["limits"]["maxRevisionBytes"], MAX_REVISION_BYTES_V2);
        assert_eq!(vectors["limits"]["maxPayloadBytes"], MAX_PAYLOAD_BYTES_V2);
        assert_eq!(vectors["limits"]["maxHeadBytes"], MAX_HEAD_BYTES_V2);
        assert_eq!(vectors["limits"]["maxIdLength"], MAX_ID_LENGTH_V2);
        assert_ne!(
            REVISION_SCHEMA_V2,
            super::super::sync_object_document::REVISION_SCHEMA
        );
        assert_ne!(
            HEAD_SCHEMA_V2,
            super::super::sync_object_document::HEAD_SCHEMA
        );
    }

    #[test]
    fn generic_identity_derivations_are_domain_separated() {
        assert_ne!(
            object_key_hex_v2("studio.chat.saved-state.v1", "object-a"),
            object_key_hex_v2("studio.other.v1", "object-a")
        );
        assert_ne!(
            writer_key_hex_v2("writer-a"),
            object_key_hex_v2("studio.chat.saved-state.v1", "writer-a")
        );
    }
}
