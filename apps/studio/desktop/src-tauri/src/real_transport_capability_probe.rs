use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const SCHEMA: &str = "h2o.studio.transport.real-capability-probe-result.v1";
pub const REQUEST_SCHEMA: &str = "h2o.studio.transport.real-capability-probe-request.v1";
pub const READONLY_PROBE_GATE: &str =
    "real-webdav-cloud-relay-transport-readonly-capability-probe-evaluate";
pub const LIVE_READONLY_PROBE_GATE: &str = "real-transport-w3-readonly-remote-root-probe";
const DESCRIPTOR_REGISTRY_FILE_ENV: &str = "H2O_RT_DESCRIPTOR_REGISTRY_FILE";
const DEFAULT_DESCRIPTOR_REGISTRY_FILE: &str =
    "/private/tmp/h2o-real-transport-w3-live-descriptor-registry.json";
const APP_LOCAL_DESCRIPTOR_REGISTRY_FILE_NAME: &str =
    "h2o-real-transport-w3-live-descriptor-registry.json";
const WRITE_GRADE_REGISTRY_REF_SCHEMA: &str =
    "h2o.studio.transport.write-grade-registry-public-ref.v1";
const WRITE_GRADE_REGISTRY_HASH_BOUNDARY: &str = "descriptor-refs-only-excludes-private-material";
const FIRST_WRITE_REQUEST_SCHEMA: &str = "h2o.studio.transport.first-write-request.v1";
const WRITE_GRADE_RECEIPT_SCHEMA: &str = "h2o.sync.real-transport.write-grade-receipt.v1";
const WRITE_GRADE_RECEIPT_CANONICALIZATION: &str = "json-sorted-keys-v1";
const FIRST_WRITE_OPERATION_KIND: &str = "first-sacrificial-probe-write";
const FIRST_WRITE_PAYLOAD_KIND: &str = "capability-probe-object";
const FIRST_WRITE_DETERMINISTIC_SENTINEL_PAYLOAD: &str = "h2o-w3-first-write-loopback-sentinel";
const FIRST_WRITE_GATE: &str = "real-transport-w3-4a-refused-first-write-loopback";
const FIRST_WRITE_LIVE_GATE: &str = "real-transport-w3-4b-live-sacrificial-webdav-invocation";
const W31_CLOSEOUT_COMMIT: &str = "7862270237955b86d48d943263fd53947cc71f72";
const W31_ALIGNMENT_COMMIT: &str = "70e7fcc9669b939b505de96a7bb0ec61509c3370";
const W32_MOCK_PROOF_COMMIT: &str = "649849e7e48c7e5bc5924bc811d857f2435866ae";
const W33A_DESIGN_COMMIT: &str = "671fdc1c855b345185e5ea257b206c0a07cdab36";
const W33B_STORAGE_COMMIT: &str = "388a952745ab7a21ba9556531eccf5c7e0ffe1ce";
const W33C_HASH_BOUNDARY_COMMIT: &str = "aba4c70068d95ee373d157fddea06bfb31b505b0";
const W34A_REFUSED_COMMAND_COMMIT: &str = "a830ccb6b633a9d6cee35e6db92464e870d5693d";
const W34B0_APPROVAL_PACKAGE_COMMIT: &str = "d196f4b26d904394c435c15dd14d12cd18f03190";
const W34B1_OPERATOR_APPROVAL_COMMIT: &str = "db4cdc5ccbd436913f05aa7b526fc14fec03e5ea";
const W34B1_R2_RENEWED_OPERATOR_APPROVAL_COMMIT: &str = "714f80a458808550dc8fd59ee937837349f416da";
const W34B3B_MISSING_TOKEN_COMMIT: &str = "d4171915b30cef69ef53234ef12a533e8ed6e846";
const W34B3_R3A_BINDING_MISMATCH_DIAGNOSTIC_COMMIT: &str =
    "d57fefebe66537ecbeac9ecf9ba56cf02f1b21dd";
const W34B3_R4_NO_WRITE_CLOSEOUT_COMMIT: &str = "f08f9b0f750e6d863a32c5de8f1edbe97955d0c1";
const W35B_PARENT_PROPFIND_FIX_COMMIT: &str = "305ff023ad12f14b6a9b505dab4123cf44c7cfba";
const R6_RECEIPT_SCHEMA_VERSION: &str = "h2o.r6.write-grade-receipt.v1";
const R6_APPROVAL_SCHEMA_VERSION: &str = "h2o.r6.approval.v1";
const R6_RECEIPT_HASH_DOMAIN: &[u8] = b"h2o.r6.write-grade-receipt-core.v1\n";
const R6_APPROVAL_HASH_DOMAIN: &[u8] = b"h2o.r6.approval-core.v1\n";
const R6_CEREMONY_POLICY_IDENTIFIER: &str = "h2o.r6.sacrificial-webdav-four-step.v1";
const R6_DESCENDANT_AUTHORIZATION_DESCRIPTOR: &str =
    "h2o.r6.constrained-descendant-authorization.v1";
const R6_CONSUMED_MARKER_SCHEMA_VERSION: &str = "h2o.sync.real-transport.r6-consumed-marker.v1";
const R6_E6_COMMIT: &str = "6cb091c75c49191f2e8e751847c347d11b3fa0a6";
const R6_E6_PARENT_COMMIT: &str = "cab9bbecaf9612208af6ab33afe446407b7b58d3";
const R6_E6_EVIDENCE_SHA256: &str =
    "sha256:049f19915ea16c6bee606813de59cfc14ee6396f6ade4c35d802be52ae44a134";
const R6_E6_RUNTIME_STDOUT_SHA256: &str =
    "sha256:181e81594a1f31e27c413a17d40ae1475f648f2b18d68516ad4ccfbc6fbca4d6";
const R6_GATED_EXECUTOR_COMMIT: &str = "3048ab2dba3f4cbff4ec199dbb36093975659b52";
const R6_CANONICAL_BINDING_FIX_COMMIT: &str = "d57fefebe66537ecbeac9ecf9ba56cf02f1b21dd";
const R5A_BINDING_FIX_PRESENT_COMMIT: &str = "a0695eac1b3f11d7617a4a080c54d0b82663d478";
const R6_W35D_IMPLEMENTATION_COMMIT: &str = "f8905a754d1ac6f3cfc8903b138aa3277706419d";
const R6_APPROVAL_GATE_SEALED: bool = true;
const R6_APPROVAL_COMMIT: &str = "b2de60b88aa750897948e504e6458d943bf83f3b";
const R6_APPROVAL_ARTIFACT_HASH: &str =
    "sha256:1ee20882c449c93536862c6dcd4448ac98e768bb58e50d20074170d32b67da13";
const R6_R4_BURNED_RECEIPT_CORE_HASH: &str =
    "sha256:b18da77e97eb2ab339ea974db93b5fb51bd1a5b4a478d69fa2bc5d18084fd183";
const R6_R5_BURNED_RECEIPT_CORE_HASH: &str =
    "sha256:b27b6eb6ed238c15d9b687a85d2d8b98e9db4434a7c6b1d30df26e96aaddca57";
const R6_BURNED_RECEIPT_CORE_HASHES: [&str; 2] = [
    R6_R4_BURNED_RECEIPT_CORE_HASH,
    R6_R5_BURNED_RECEIPT_CORE_HASH,
];
const R6_MAX_VALIDITY_SECONDS: i64 = 12 * 60 * 60;
const R6_CLOCK_SKEW_SECONDS: i64 = 120;
const BUILD_GIT_SHA: &str = env!("H2O_BUILD_GIT_SHA");
const BUILD_PROFILE: &str = env!("H2O_BUILD_PROFILE");
const BUILD_DIRTY: &str = env!("H2O_BUILD_DIRTY");
const PARENT_PROPFIND_FIX_PRESENT: &str = env!("H2O_PARENT_PROPFIND_FIX_PRESENT");
const R5A_BINDING_FIX_PRESENT: &str = env!("H2O_R5A_BINDING_FIX_PRESENT");
const WRITE_GRADE_MAX_RECEIPT_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;
const FIRST_WRITE_RECOMMENDED_AGE_SECONDS: i64 = 72 * 60 * 60;
const MAX_READONLY_RESPONSE_BYTES: usize = 64 * 1024;
const READONLY_TIMEOUT_SECONDS: u64 = 8;
const WEBDAV_PROPFIND_BODY: &str = "<?xml version=\"1.0\" encoding=\"utf-8\"?><D:propfind xmlns:D=\"DAV:\"><D:prop><D:resourcetype/></D:prop></D:propfind>";
const WEBDAV_XML_ACCEPT: &str = "application/xml,text/xml,*/*";
const WEBDAV_XML_CONTENT_TYPE: &str = "application/xml; charset=utf-8";

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RtCapabilityProbeRequest {
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub gate: Option<String>,
    #[serde(default)]
    pub diagnostic_only: Option<bool>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub dry_run: Option<bool>,
    #[serde(default)]
    pub endpoint_ref_hash: Option<String>,
    #[serde(default)]
    pub remote_root_ref_hash: Option<String>,
    #[serde(default)]
    pub credential_ref_hash: Option<String>,
    #[serde(default)]
    pub capability_probe_receipt_hash: Option<String>,
    #[serde(default)]
    pub resolver_check: Option<bool>,
    #[serde(default)]
    pub descriptor_registry_ref_hash: Option<String>,
    #[serde(default)]
    pub live_read_only_probe: Option<bool>,
    #[serde(default)]
    pub requested_operations: Option<Vec<String>>,
    #[serde(default)]
    pub product_sync_ready: Option<bool>,
    #[serde(default)]
    pub transport_ready: Option<bool>,
    #[serde(default)]
    pub real_webdav_transport_available: Option<bool>,
    #[serde(default)]
    pub writes_webdav: Option<bool>,
    #[serde(default)]
    pub writes_cloud: Option<bool>,
    #[serde(default)]
    pub writes_relay: Option<bool>,
    #[serde(default)]
    pub writes_cas: Option<bool>,
    #[serde(default)]
    pub writes_files: Option<bool>,
    #[serde(default)]
    pub enqueues_relay: Option<bool>,
    #[serde(default)]
    pub full_bundle_v3_started: Option<bool>,
    #[serde(default)]
    pub mints_export_id: Option<bool>,
    #[serde(default)]
    pub burns_sequence: Option<bool>,
    #[serde(default)]
    pub forbidden_evidence_tokens: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, JsonValue>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyRequestShape {
    pub target_shape: &'static str,
    pub trailing_slash: bool,
    pub double_slash: bool,
    pub auth_header_present: bool,
    pub propfind_depth_header_present: bool,
    pub propfind_body_present: bool,
    pub propfind_content_type_class: &'static str,
    pub accept_header_class: &'static str,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyMethodStatusFamily {
    pub operation: &'static str,
    pub status_code: u16,
    pub status_family: &'static str,
    pub request_shape: ReadOnlyRequestShape,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RtCapabilityProbeResult {
    pub schema: &'static str,
    pub request_schema: &'static str,
    pub ok: bool,
    pub status: &'static str,
    pub reason: &'static str,
    pub command: &'static str,
    pub gate_satisfied: bool,
    pub diagnostic_only: bool,
    pub read_only: bool,
    pub dry_run: bool,
    pub network_attempted: bool,
    pub endpoint_ref_hash: Option<String>,
    pub remote_root_ref_hash: Option<String>,
    pub credential_ref_hash: Option<String>,
    pub capability_probe_receipt_hash: Option<String>,
    pub resolver_available: bool,
    pub endpoint_descriptor_resolved: bool,
    pub remote_root_descriptor_resolved: bool,
    pub credential_descriptor_resolved: bool,
    pub descriptor_registry_ref_hash: Option<String>,
    pub receipt_core_placeholder: Option<&'static str>,
    pub root_exists: Option<bool>,
    pub root_empty: Option<bool>,
    pub listing_hash: Option<String>,
    pub child_404_ok: Option<bool>,
    pub method_status_families: Vec<ReadOnlyMethodStatusFamily>,
    pub dav_class_summary_hash: Option<String>,
    pub allowed_methods_summary_hash: Option<String>,
    pub create_only_behavior: &'static str,
    pub etag_behavior: &'static str,
    pub if_none_match_behavior: &'static str,
    pub real_webdav_transport_available: bool,
    pub product_sync_ready: bool,
    pub transport_ready: bool,
    pub writes_webdav: bool,
    pub writes_cloud: bool,
    pub writes_relay: bool,
    pub writes_cas: bool,
    pub writes_files: bool,
    pub enqueues_relay: bool,
    pub full_bundle_v3_started: bool,
    pub mints_export_id: bool,
    pub burns_sequence: bool,
    pub raw_private_fields_logged: bool,
    pub raw_input_rejected: bool,
    pub blockers: Vec<&'static str>,
    pub warnings: Vec<&'static str>,
}

impl RtCapabilityProbeResult {
    fn blocked(
        reason: &'static str,
        blockers: Vec<&'static str>,
        raw_input_rejected: bool,
    ) -> Self {
        Self {
            schema: SCHEMA,
            request_schema: REQUEST_SCHEMA,
            ok: false,
            status: "real-transport-readonly-capability-probe-blocked",
            reason,
            command: "h2o_rt_capability_probe",
            gate_satisfied: false,
            diagnostic_only: true,
            read_only: true,
            dry_run: true,
            network_attempted: false,
            endpoint_ref_hash: None,
            remote_root_ref_hash: None,
            credential_ref_hash: None,
            capability_probe_receipt_hash: None,
            resolver_available: false,
            endpoint_descriptor_resolved: false,
            remote_root_descriptor_resolved: false,
            credential_descriptor_resolved: false,
            descriptor_registry_ref_hash: None,
            receipt_core_placeholder: None,
            root_exists: None,
            root_empty: None,
            listing_hash: None,
            child_404_ok: None,
            method_status_families: vec![],
            dav_class_summary_hash: None,
            allowed_methods_summary_hash: None,
            create_only_behavior: "unknown",
            etag_behavior: "unknown",
            if_none_match_behavior: "unknown",
            real_webdav_transport_available: false,
            product_sync_ready: false,
            transport_ready: false,
            writes_webdav: false,
            writes_cloud: false,
            writes_relay: false,
            writes_cas: false,
            writes_files: false,
            enqueues_relay: false,
            full_bundle_v3_started: false,
            mints_export_id: false,
            burns_sequence: false,
            raw_private_fields_logged: false,
            raw_input_rejected,
            blockers,
            warnings: vec![],
        }
    }

    fn ready(
        request: &RtCapabilityProbeRequest,
        resolver_ready: bool,
        live_probe: Option<LiveReadOnlyProbeOutcome>,
    ) -> Self {
        let live_probe = live_probe.unwrap_or_default();
        Self {
            schema: SCHEMA,
            request_schema: REQUEST_SCHEMA,
            ok: true,
            status: "real-transport-readonly-capability-probe-ready",
            reason: "read-only-capability-probe-substrate-ready",
            command: "h2o_rt_capability_probe",
            gate_satisfied: true,
            diagnostic_only: true,
            read_only: true,
            dry_run: true,
            network_attempted: live_probe.network_attempted,
            endpoint_ref_hash: request.endpoint_ref_hash.clone(),
            remote_root_ref_hash: request.remote_root_ref_hash.clone(),
            credential_ref_hash: request.credential_ref_hash.clone(),
            capability_probe_receipt_hash: request.capability_probe_receipt_hash.clone(),
            resolver_available: resolver_ready,
            endpoint_descriptor_resolved: resolver_ready,
            remote_root_descriptor_resolved: resolver_ready,
            credential_descriptor_resolved: resolver_ready,
            descriptor_registry_ref_hash: request.descriptor_registry_ref_hash.clone(),
            receipt_core_placeholder: Some("not-generated-in-w3-1-implementation-slice"),
            root_exists: live_probe.root_exists,
            root_empty: live_probe.root_empty,
            listing_hash: live_probe.listing_hash,
            child_404_ok: live_probe.child_404_ok,
            method_status_families: live_probe.method_status_families,
            dav_class_summary_hash: live_probe.dav_class_summary_hash,
            allowed_methods_summary_hash: live_probe.allowed_methods_summary_hash,
            create_only_behavior: "unknown",
            etag_behavior: "unknown",
            if_none_match_behavior: "unknown",
            real_webdav_transport_available: false,
            product_sync_ready: false,
            transport_ready: false,
            writes_webdav: false,
            writes_cloud: false,
            writes_relay: false,
            writes_cas: false,
            writes_files: false,
            enqueues_relay: false,
            full_bundle_v3_started: false,
            mints_export_id: false,
            burns_sequence: false,
            raw_private_fields_logged: false,
            raw_input_rejected: false,
            blockers: vec![],
            warnings: if live_probe.network_attempted {
                vec!["real-remote-probe-readonly-only"]
            } else {
                vec!["real-remote-probe-not-performed-in-this-slice"]
            },
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DescriptorRegistry {
    schema: String,
    endpoint_ref_hash: String,
    remote_root_ref_hash: String,
    credential_ref_hash: String,
    #[serde(default)]
    pub(crate) endpoint_url_private: Option<String>,
    #[serde(default)]
    pub(crate) remote_root_path_private: Option<String>,
    #[serde(default)]
    pub(crate) auth_header_private: Option<String>,
    #[serde(default)]
    descriptor_mode: Option<String>,
    #[serde(flatten)]
    extra: BTreeMap<String, JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WritableDescriptorRegistry<'a> {
    schema: &'static str,
    descriptor_mode: &'static str,
    endpoint_ref_hash: &'a str,
    remote_root_ref_hash: &'a str,
    credential_ref_hash: &'a str,
    endpoint_url_private: &'a str,
    remote_root_path_private: &'a str,
    auth_header_private: &'a str,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RtWebDavSetupRequest {
    #[serde(default)]
    pub server_url: Option<String>,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub credential_identifier: Option<String>,
    #[serde(default)]
    pub credential_secret: Option<String>,
    #[serde(default)]
    pub endpoint_descriptor_label: Option<String>,
    #[serde(default)]
    pub remote_root_descriptor_label: Option<String>,
    #[serde(default)]
    pub credential_descriptor_label: Option<String>,
    #[serde(default)]
    pub confirm_non_production: Option<bool>,
    #[serde(default)]
    pub confirm_read_only_safe: Option<bool>,
    #[serde(default)]
    pub confirm_sacrificial_write_not_approved: Option<bool>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RtWebDavSetupStatusResult {
    pub schema: &'static str,
    pub ok: bool,
    pub status: &'static str,
    pub reason: &'static str,
    pub command: &'static str,
    pub registry_path_class: &'static str,
    pub registry_path_source: &'static str,
    pub write_grade_registry_eligible: bool,
    pub registry_file_owner_current_user: bool,
    pub registry_file_private_permissions: bool,
    pub registry_parent_owner_current_user: bool,
    pub registry_parent_private_permissions: bool,
    pub registry_owner_ok: bool,
    pub registry_permission_ok: bool,
    pub write_grade_registry_ref_hash: Option<String>,
    pub write_grade_registry_hash_boundary: &'static str,
    pub private_content_hash_available: bool,
    pub descriptor_registry_ref_hash: Option<String>,
    pub endpoint_ref_hash: Option<String>,
    pub remote_root_ref_hash: Option<String>,
    pub credential_ref_hash: Option<String>,
    pub saved_server_url: Option<String>,
    pub saved_root_path: Option<String>,
    pub saved_credential_identifier: Option<String>,
    pub json_parses: bool,
    pub required_private_fields_present: bool,
    pub credential_material_present: bool,
    pub credential_input_received_this_save: bool,
    pub credential_material_updated_this_save: bool,
    pub endpoint_no_longer_reserved_invalid_domain: bool,
    pub reachable_candidate: bool,
    pub network_attempted: bool,
    pub real_webdav_transport_available: bool,
    pub product_sync_ready: bool,
    pub transport_ready: bool,
    pub writes_webdav: bool,
    pub writes_cloud: bool,
    pub writes_relay: bool,
    pub writes_cas: bool,
    pub writes_files: bool,
    pub enqueues_relay: bool,
    pub full_bundle_v3_started: bool,
    pub mints_export_id: bool,
    pub burns_sequence: bool,
    pub raw_private_fields_logged: bool,
    pub blockers: Vec<&'static str>,
    pub warnings: Vec<&'static str>,
}

impl RtWebDavSetupStatusResult {
    fn base(
        ok: bool,
        status: &'static str,
        reason: &'static str,
        command: &'static str,
        blockers: Vec<&'static str>,
    ) -> Self {
        Self {
            schema: "h2o.studio.transport.real-webdav-setup-status.v1",
            ok,
            status,
            reason,
            command,
            registry_path_class: "private-out-of-repo-descriptor-registry",
            registry_path_source: descriptor_registry_path_source_for_setup(),
            write_grade_registry_eligible: false,
            registry_file_owner_current_user: false,
            registry_file_private_permissions: false,
            registry_parent_owner_current_user: false,
            registry_parent_private_permissions: false,
            registry_owner_ok: false,
            registry_permission_ok: false,
            write_grade_registry_ref_hash: None,
            write_grade_registry_hash_boundary: WRITE_GRADE_REGISTRY_HASH_BOUNDARY,
            private_content_hash_available: false,
            descriptor_registry_ref_hash: None,
            endpoint_ref_hash: None,
            remote_root_ref_hash: None,
            credential_ref_hash: None,
            saved_server_url: None,
            saved_root_path: None,
            saved_credential_identifier: None,
            json_parses: false,
            required_private_fields_present: false,
            credential_material_present: false,
            credential_input_received_this_save: false,
            credential_material_updated_this_save: false,
            endpoint_no_longer_reserved_invalid_domain: false,
            reachable_candidate: false,
            network_attempted: false,
            real_webdav_transport_available: false,
            product_sync_ready: false,
            transport_ready: false,
            writes_webdav: false,
            writes_cloud: false,
            writes_relay: false,
            writes_cas: false,
            writes_files: false,
            enqueues_relay: false,
            full_bundle_v3_started: false,
            mints_export_id: false,
            burns_sequence: false,
            raw_private_fields_logged: false,
            blockers,
            warnings: vec!["real-transport-webdav-setup-storage-only-no-probe"],
        }
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RtWebDavSetupHydrateFormRequest {
    #[serde(default)]
    pub remember_credential: Option<bool>,
    #[serde(default)]
    pub desktop_local_ui: Option<bool>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RtWebDavSetupHydrateFormResult {
    pub schema: &'static str,
    pub ok: bool,
    pub status: &'static str,
    pub reason: &'static str,
    pub command: &'static str,
    pub registry_path_class: &'static str,
    pub registry_path_source: &'static str,
    pub write_grade_registry_eligible: bool,
    pub registry_owner_ok: bool,
    pub registry_permission_ok: bool,
    pub saved_server_url: Option<String>,
    pub saved_root_path: Option<String>,
    pub saved_credential_identifier: Option<String>,
    pub remembered_credential_secret: Option<String>,
    pub credential_material_present: bool,
    pub remember_credential_enabled: bool,
    pub network_attempted: bool,
    pub writes_webdav: bool,
    pub writes_cloud: bool,
    pub writes_relay: bool,
    pub writes_cas: bool,
    pub writes_files: bool,
    pub enqueues_relay: bool,
    pub full_bundle_v3_started: bool,
    pub mints_export_id: bool,
    pub burns_sequence: bool,
    pub product_sync_ready: bool,
    pub transport_ready: bool,
    pub raw_private_fields_logged: bool,
    pub blockers: Vec<&'static str>,
    pub warnings: Vec<&'static str>,
}

impl RtWebDavSetupHydrateFormResult {
    fn blocked(reason: &'static str, blockers: Vec<&'static str>) -> Self {
        Self {
            schema: "h2o.studio.transport.real-webdav-setup-hydrate-form.v1",
            ok: false,
            status: "real-transport-webdav-setup-hydrate-form-blocked",
            reason,
            command: "h2o_rt_webdav_setup_hydrate_form",
            registry_path_class: "private-out-of-repo-descriptor-registry",
            registry_path_source: descriptor_registry_path_source_for_setup(),
            write_grade_registry_eligible: false,
            registry_owner_ok: false,
            registry_permission_ok: false,
            saved_server_url: None,
            saved_root_path: None,
            saved_credential_identifier: None,
            remembered_credential_secret: None,
            credential_material_present: false,
            remember_credential_enabled: false,
            network_attempted: false,
            writes_webdav: false,
            writes_cloud: false,
            writes_relay: false,
            writes_cas: false,
            writes_files: false,
            enqueues_relay: false,
            full_bundle_v3_started: false,
            mints_export_id: false,
            burns_sequence: false,
            product_sync_ready: false,
            transport_ready: false,
            raw_private_fields_logged: false,
            blockers,
            warnings: vec!["local-desktop-ui-hydration-only-no-probe-no-write"],
        }
    }
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RtFirstWriteRequest {
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub gate: Option<String>,
    #[serde(default)]
    pub mock_only: Option<bool>,
    #[serde(default)]
    pub loopback_mock: Option<bool>,
    #[serde(default)]
    pub live_webdav_invocation: Option<bool>,
    #[serde(default)]
    pub invocation_utc: Option<String>,
    #[serde(default)]
    pub receipt_core_hash: Option<String>,
    #[serde(default)]
    pub approval_expiry_utc: Option<String>,
    #[serde(default)]
    pub write_grade_receipt: Option<WriteGradeReceipt>,
    #[serde(default)]
    pub approval_artifact_hash: Option<String>,
    #[serde(default)]
    pub one_shot_token: Option<String>,
    #[serde(default)]
    pub one_shot_token_hash: Option<String>,
    #[serde(default)]
    pub kill_switch_token: Option<String>,
    #[serde(default)]
    pub kill_switch_token_hash: Option<String>,
    #[serde(default)]
    pub kill_switch_enabled: Option<bool>,
    #[serde(default)]
    pub kill_switch_fresh: Option<bool>,
    #[serde(default)]
    pub write_grade_registry_ref_hash: Option<String>,
    #[serde(default)]
    pub registry_path_source: Option<String>,
    #[serde(default)]
    pub write_grade_registry_eligible: Option<bool>,
    #[serde(default)]
    pub registry_owner_ok: Option<bool>,
    #[serde(default)]
    pub registry_permission_ok: Option<bool>,
    #[serde(default)]
    pub payload: Option<String>,
    #[serde(default)]
    pub payload_hash: Option<String>,
    #[serde(default)]
    pub payload_byte_max: Option<usize>,
    #[serde(default)]
    pub product_sync_ready: Option<bool>,
    #[serde(default)]
    pub transport_ready: Option<bool>,
    #[serde(default)]
    pub writes_webdav: Option<bool>,
    #[serde(default)]
    pub writes_cloud: Option<bool>,
    #[serde(default)]
    pub writes_relay: Option<bool>,
    #[serde(default)]
    pub writes_cas: Option<bool>,
    #[serde(default)]
    pub writes_files: Option<bool>,
    #[serde(default)]
    pub enqueues_relay: Option<bool>,
    #[serde(default)]
    pub full_bundle_v3_started: Option<bool>,
    #[serde(default)]
    pub mints_export_id: Option<bool>,
    #[serde(default)]
    pub burns_sequence: Option<bool>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, JsonValue>,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WriteGradeReceipt {
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub canonicalization: Option<String>,
    #[serde(default)]
    pub receipt_grade: Option<String>,
    #[serde(default)]
    pub mint_utc: Option<String>,
    #[serde(default)]
    pub expiry_utc: Option<String>,
    #[serde(default)]
    pub operation_kind: Option<String>,
    #[serde(default)]
    pub payload_kind: Option<String>,
    #[serde(default)]
    pub payload_count: Option<u32>,
    #[serde(default)]
    pub max_invocations: Option<u32>,
    #[serde(default)]
    pub request_budget: Option<WriteGradeRequestBudget>,
    #[serde(default)]
    pub sacrificial_object: Option<WriteGradeSacrificialObject>,
    #[serde(default)]
    pub bindings: Option<WriteGradeReceiptBindings>,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WriteGradeRequestBudget {
    #[serde(default)]
    pub create_only_put_max: Option<u32>,
    #[serde(default)]
    pub readback_get_max: Option<u32>,
    #[serde(default)]
    pub other_methods: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WriteGradeSacrificialObject {
    #[serde(default)]
    pub path_class_ref_hash: Option<String>,
    #[serde(default)]
    pub payload_hash: Option<String>,
    #[serde(default)]
    pub payload_byte_max: Option<usize>,
}

#[derive(Debug, Deserialize, Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WriteGradeReceiptBindings {
    #[serde(default)]
    pub endpoint_ref_hash: Option<String>,
    #[serde(default)]
    pub remote_root_ref_hash: Option<String>,
    #[serde(default)]
    pub credential_ref_hash: Option<String>,
    #[serde(default)]
    pub write_grade_registry_ref_hash: Option<String>,
    #[serde(default)]
    pub write_grade_registry_hash_boundary: Option<String>,
    #[serde(default)]
    pub w31_closeout_commit: Option<String>,
    #[serde(default)]
    pub w31_alignment_commit: Option<String>,
    #[serde(default)]
    pub w32_mock_proof_commit: Option<String>,
    #[serde(default, rename = "w33DesignCommit")]
    pub w33a_design_commit: Option<String>,
    #[serde(default, rename = "w33RegistryHardeningCommit")]
    pub w33b_registry_hardening_commit: Option<String>,
    #[serde(default, rename = "w33HashBoundaryCommit")]
    pub w33c_hash_boundary_commit: Option<String>,
    #[serde(default)]
    pub w34a_refused_command_commit: Option<String>,
    #[serde(default)]
    pub w34b0_approval_package_commit: Option<String>,
    #[serde(default)]
    pub w34b1_operator_approval_commit: Option<String>,
    #[serde(default)]
    pub w34b1_expired_operator_approval_commit: Option<String>,
    #[serde(default)]
    pub w34b1_r2_renewed_operator_approval_commit: Option<String>,
    #[serde(default)]
    pub w34b3_blocked_missing_token_commit: Option<String>,
    #[serde(default)]
    pub w34b3_r3_binding_mismatch_diagnostic_commit: Option<String>,
    #[serde(default)]
    pub w34b3_r4_no_write_closeout_commit: Option<String>,
    #[serde(default)]
    pub w35b_parent_propfind_fix_commit: Option<String>,
    #[serde(default)]
    pub operator_approval_artifact_hash: Option<String>,
    #[serde(default)]
    pub one_shot_token_hash: Option<String>,
    #[serde(default)]
    pub kill_switch_token_hash: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6WriteGradeReceipt {
    pub schema_version: String,
    pub receipt_identifier: String,
    pub runtime: R6RuntimeBinding,
    pub lineage: R6LineageCommitments,
    pub approval: R6ApprovalBinding,
    pub private_material_commitments: R6PrivateMaterialCommitments,
    pub ceremony_policy: R6CeremonyPolicy,
    pub lifecycle_policy: R6LifecyclePolicy,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6RuntimeBinding {
    pub approved_final_runtime_commit: String,
    pub required_embedded_build_git_sha: String,
    pub build_dirty_must_be_false: bool,
    pub build_profile: R6BuildProfile,
    pub e6_commit: String,
    pub e6_parent: String,
    pub e6_evidence_sha256: String,
    pub e6_runtime_stdout_sha256: String,
    pub implementation_commitments: R6ImplementationCommitments,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6ImplementationCommitments {
    pub gated_executor_commit: String,
    pub canonical_binding_fix_commit: String,
    pub parent_propfind_fix_commit: String,
    pub r5a_binding_fix_commit: String,
    pub w35d_implementation_commit: String,
    pub parent_propfind_fix_must_be_present: bool,
    pub r5a_binding_fix_must_be_present: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6LineageCommitments {
    pub w31_request_shape_commit: String,
    pub w31_closeout_commit: String,
    pub w32_mock_executor_commit: String,
    pub w33a_commit: String,
    pub w33b_commit: String,
    pub w33c_commit: String,
    pub w34a_commit: String,
    pub w34b_commit: String,
    pub gated_executor_commit: String,
    pub canonical_binding_fix_commit: String,
    pub parent_propfind_fix_commit: String,
    pub r5a_binding_fix_commit: String,
    pub w35d_implementation_commit: String,
    pub e6_commit: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6ApprovalBinding {
    pub approval_artifact_identifier: String,
    pub approval_artifact_commit: String,
    pub approval_schema_version: String,
    pub approval_core_hash: String,
    pub approval_mint_utc: String,
    pub approval_expiry_utc: String,
    pub constrained_descendant_authorization_descriptor: String,
    pub ceremony_policy_identifier: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6ApprovalCore {
    pub schema_version: String,
    pub approval_artifact_identifier: String,
    pub mint_utc: String,
    pub expiry_utc: String,
    pub constrained_descendant_authorization_descriptor: String,
    pub ceremony_policy_identifier: String,
    pub e6_commit: String,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6PrivateMaterialCommitments {
    pub one_shot_token_sha256: String,
    pub kill_switch_token_sha256: String,
    pub endpoint_ref_hash: String,
    pub remote_root_ref_hash: String,
    pub credential_ref_hash: String,
    pub deterministic_object_path_commitment: String,
    pub deterministic_payload_hash: String,
    pub maximum_payload_bytes: u32,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6CeremonyPolicy {
    pub policy_identifier: String,
    pub ordered_sequence: [R6CeremonyMethod; 4],
    pub attempt_ceilings: R6AttemptCeilings,
    pub total_request_ceiling: u32,
    pub expected_results: R6ExpectedResults,
    pub redirects_prohibited: bool,
    pub authority_changes_prohibited: bool,
    pub automatic_retries_prohibited: bool,
    pub cleanup_prohibited: bool,
    pub readiness_changes_prohibited: bool,
    pub forbidden_methods: Vec<R6ForbiddenMethod>,
    pub forbidden_write_classes: Vec<R6ForbiddenWriteClass>,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6AttemptCeilings {
    pub parent_propfind: u32,
    pub first_create_only_put: u32,
    pub second_create_only_put: u32,
    pub readback_get: u32,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6ExpectedResults {
    pub parent_propfind: R6ExactStatusExpectation,
    pub first_create_only_put: R6ExactStatusExpectation,
    pub second_create_only_put: R6ExactStatusExpectation,
    pub readback_get: R6ReadbackExpectation,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6ExactStatusExpectation {
    pub status_code: u16,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6ReadbackExpectation {
    pub accepted_status_family: R6StatusFamily,
    pub exact_payload_hash_match_required: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6LifecyclePolicy {
    pub receipt_mint_utc: String,
    pub receipt_expiry_utc: String,
    pub maximum_validity_seconds: u32,
    pub clock_skew_seconds: u32,
    pub must_be_unconsumed: bool,
    pub must_be_uninvoked: bool,
    pub consumed_marker_schema_version: String,
    pub consumed_marker_binding: R6ConsumedMarkerBinding,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct R6ConsumedMarkerBinding {
    pub receipt_identifier: String,
    pub receipt_core_hash: R6ReceiptCoreHashBinding,
    pub approved_runtime_commit: String,
    pub product_sync_ready_must_remain_false: bool,
    pub transport_ready_must_remain_false: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum R6BuildProfile {
    Debug,
    Release,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum R6CeremonyMethod {
    #[serde(rename = "PROPFIND")]
    Propfind,
    #[serde(rename = "PUT")]
    Put,
    #[serde(rename = "GET")]
    Get,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum R6ForbiddenMethod {
    #[serde(rename = "OPTIONS")]
    Options,
    #[serde(rename = "DELETE")]
    Delete,
    #[serde(rename = "MKCOL")]
    Mkcol,
    #[serde(rename = "PROPPATCH")]
    Proppatch,
    #[serde(rename = "MOVE")]
    Move,
    #[serde(rename = "COPY")]
    Copy,
    #[serde(rename = "LOCK")]
    Lock,
    #[serde(rename = "UNLOCK")]
    Unlock,
    #[serde(rename = "POST")]
    Post,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum R6ForbiddenWriteClass {
    Archive,
    Chat,
    FullBundle,
    FullBundleV3,
    Relay,
    Cas,
    Outbox,
    Ledger,
    UserData,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum R6StatusFamily {
    #[serde(rename = "2xx")]
    TwoXx,
}

#[derive(Debug, Deserialize, Serialize, Clone, Copy, PartialEq, Eq)]
pub enum R6ReceiptCoreHashBinding {
    #[serde(rename = "canonicalR6ReceiptCoreHash")]
    CanonicalR6ReceiptCoreHash,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RtFirstWriteMethodStatus {
    pub operation: &'static str,
    pub status_code: u16,
    pub status_family: &'static str,
    pub loopback_only: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RtFirstWriteResult {
    pub schema: &'static str,
    pub ok: bool,
    pub status: &'static str,
    pub reason: &'static str,
    pub command: &'static str,
    pub mock_only: bool,
    pub gate_satisfied: bool,
    pub network_attempted: bool,
    pub loopback_attempted: bool,
    pub write_grade_registry_ref_hash: Option<String>,
    pub create_only_behavior: &'static str,
    pub method_statuses: Vec<RtFirstWriteMethodStatus>,
    pub writes_webdav: bool,
    pub writes_cloud: bool,
    pub writes_relay: bool,
    pub writes_cas: bool,
    pub writes_files: bool,
    pub enqueues_relay: bool,
    pub full_bundle_v3_started: bool,
    pub mints_export_id: bool,
    pub burns_sequence: bool,
    pub product_sync_ready: bool,
    pub transport_ready: bool,
    pub raw_private_fields_logged: bool,
    pub blockers: Vec<&'static str>,
    pub warnings: Vec<&'static str>,
}

impl RtFirstWriteResult {
    fn blocked(reason: &'static str, blockers: Vec<&'static str>) -> Self {
        Self {
            schema: "h2o.studio.transport.first-write-result.v1",
            ok: false,
            status: "real-transport-w3-first-write-blocked",
            reason,
            command: "h2o_rt_first_write",
            mock_only: true,
            gate_satisfied: false,
            network_attempted: false,
            loopback_attempted: false,
            write_grade_registry_ref_hash: None,
            create_only_behavior: "not-attempted",
            method_statuses: vec![],
            writes_webdav: false,
            writes_cloud: false,
            writes_relay: false,
            writes_cas: false,
            writes_files: false,
            enqueues_relay: false,
            full_bundle_v3_started: false,
            mints_export_id: false,
            burns_sequence: false,
            product_sync_ready: false,
            transport_ready: false,
            raw_private_fields_logged: false,
            blockers,
            warnings: vec!["w3-4a-refused-by-default-no-live-write"],
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RtWriteGradeReadOnlyProbeResult {
    pub schema: &'static str,
    pub ok: bool,
    pub status: &'static str,
    pub reason: &'static str,
    pub command: &'static str,
    pub build_git_sha: &'static str,
    pub build_profile: &'static str,
    pub build_dirty: bool,
    pub parent_propfind_fix_present: bool,
    pub r5a_binding_fix_present: bool,
    pub normal_probe_registry_path_source: &'static str,
    pub write_grade_registry_path_source: &'static str,
    pub registry_selection_equivalent: bool,
    pub endpoint_material_equivalent: bool,
    pub remote_root_material_equivalent: bool,
    pub credential_material_equivalent: bool,
    pub write_grade_registry_eligible: bool,
    pub credential_material_present: bool,
    pub method_statuses: Vec<RtFirstWriteMethodStatus>,
    pub network_attempted: bool,
    pub write_grade_read_only_probe_passed: bool,
    pub likely_cause: &'static str,
    pub receipt_consumed: bool,
    pub consumed_marker_created: bool,
    pub writes_webdav: bool,
    pub writes_cloud: bool,
    pub writes_relay: bool,
    pub writes_cas: bool,
    pub writes_files: bool,
    pub product_sync_ready: bool,
    pub transport_ready: bool,
    pub raw_private_fields_logged: bool,
    pub blockers: Vec<&'static str>,
}

impl RtWriteGradeReadOnlyProbeResult {
    fn base(reason: &'static str, blockers: Vec<&'static str>) -> Self {
        Self {
            schema: "h2o.studio.transport.write-grade-read-only-probe-result.v1",
            ok: false,
            status: "real-transport-w3-write-grade-read-only-probe-blocked",
            reason,
            command: "h2o_rt_write_grade_read_only_probe",
            build_git_sha: BUILD_GIT_SHA,
            build_profile: BUILD_PROFILE,
            build_dirty: BUILD_DIRTY == "true",
            parent_propfind_fix_present: PARENT_PROPFIND_FIX_PRESENT == "true",
            r5a_binding_fix_present: R5A_BINDING_FIX_PRESENT == "true",
            normal_probe_registry_path_source: "invalid",
            write_grade_registry_path_source: "invalid",
            registry_selection_equivalent: false,
            endpoint_material_equivalent: false,
            remote_root_material_equivalent: false,
            credential_material_equivalent: false,
            write_grade_registry_eligible: false,
            credential_material_present: false,
            method_statuses: vec![],
            network_attempted: false,
            write_grade_read_only_probe_passed: false,
            likely_cause: "pre-network-registry-resolution-blocked",
            receipt_consumed: false,
            consumed_marker_created: false,
            writes_webdav: false,
            writes_cloud: false,
            writes_relay: false,
            writes_cas: false,
            writes_files: false,
            product_sync_ready: false,
            transport_ready: false,
            raw_private_fields_logged: false,
            blockers,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
enum ResolverFailure {
    MissingConfig,
    ConfigInvalid,
    RegistryHashMismatch,
    DescriptorHashMismatch,
    RawConfigRejected,
    LiveDescriptorPrivateFieldsMissing,
    LiveUrlInvalid,
    LiveNetworkFailed,
    LiveResponseTooLarge,
}

impl ResolverFailure {
    fn blocker(&self) -> &'static str {
        match self {
            Self::MissingConfig => "real-transport-w3-resolver-config-missing",
            Self::ConfigInvalid => "real-transport-w3-resolver-config-invalid",
            Self::RegistryHashMismatch => "real-transport-w3-resolver-registry-hash-mismatch",
            Self::DescriptorHashMismatch => "real-transport-w3-descriptor-hash-mismatch",
            Self::RawConfigRejected => "real-transport-w3-resolver-raw-config-rejected",
            Self::LiveDescriptorPrivateFieldsMissing => {
                "real-transport-w3-live-descriptor-private-fields-missing"
            }
            Self::LiveUrlInvalid => "real-transport-w3-live-url-invalid",
            Self::LiveNetworkFailed => "real-transport-w3-live-network-failed",
            Self::LiveResponseTooLarge => "real-transport-w3-live-response-too-large",
        }
    }
}

fn is_hash_ref(value: &Option<String>) -> bool {
    let Some(value) = value.as_deref() else {
        return false;
    };
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn sha256_ref(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("sha256:{:x}", digest)
}

#[derive(Clone, Debug)]
struct DescriptorRegistryPathInfo {
    path: PathBuf,
    source: &'static str,
}

fn app_local_descriptor_registry_file() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").filter(|value| !value.is_empty())?;
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("H2O Studio")
                .join("real-transport")
                .join(APP_LOCAL_DESCRIPTOR_REGISTRY_FILE_NAME),
        );
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA").filter(|value| !value.is_empty())?;
        return Some(
            PathBuf::from(appdata)
                .join("H2O Studio")
                .join("real-transport")
                .join(APP_LOCAL_DESCRIPTOR_REGISTRY_FILE_NAME),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(data_home) = std::env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty())
        {
            return Some(
                PathBuf::from(data_home)
                    .join("h2o-studio")
                    .join("real-transport")
                    .join(APP_LOCAL_DESCRIPTOR_REGISTRY_FILE_NAME),
            );
        }
        let home = std::env::var_os("HOME").filter(|value| !value.is_empty())?;
        Some(
            PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("h2o-studio")
                .join("real-transport")
                .join(APP_LOCAL_DESCRIPTOR_REGISTRY_FILE_NAME),
        )
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        None
    }
}

fn legacy_default_descriptor_registry_file() -> PathBuf {
    PathBuf::from(DEFAULT_DESCRIPTOR_REGISTRY_FILE)
}

fn env_descriptor_registry_path_info() -> Option<DescriptorRegistryPathInfo> {
    let path = std::env::var_os(DESCRIPTOR_REGISTRY_FILE_ENV)?;
    if path.is_empty() {
        return Some(DescriptorRegistryPathInfo {
            path: PathBuf::new(),
            source: "invalid",
        });
    }
    Some(DescriptorRegistryPathInfo {
        path: PathBuf::from(path),
        source: "env",
    })
}

fn descriptor_registry_path_for_probe(
    request: &RtCapabilityProbeRequest,
) -> Option<DescriptorRegistryPathInfo> {
    if let Some(info) = env_descriptor_registry_path_info() {
        return Some(info);
    }
    if let Some(app_local) = app_local_descriptor_registry_file() {
        if request.descriptor_registry_ref_hash.is_some() && app_local.exists() {
            return Some(DescriptorRegistryPathInfo {
                path: app_local,
                source: "app-local",
            });
        }
    }
    let legacy = legacy_default_descriptor_registry_file();
    if request.descriptor_registry_ref_hash.is_some() && legacy.exists() {
        return Some(DescriptorRegistryPathInfo {
            path: legacy,
            source: "default-private-legacy",
        });
    }
    None
}

fn descriptor_registry_path_for_setup_write() -> DescriptorRegistryPathInfo {
    if let Some(info) = env_descriptor_registry_path_info() {
        return info;
    }
    if let Some(path) = app_local_descriptor_registry_file() {
        return DescriptorRegistryPathInfo {
            path,
            source: "app-local",
        };
    }
    DescriptorRegistryPathInfo {
        path: legacy_default_descriptor_registry_file(),
        source: "default-private-legacy",
    }
}

fn descriptor_registry_path_for_setup_status() -> DescriptorRegistryPathInfo {
    if let Some(info) = env_descriptor_registry_path_info() {
        return info;
    }
    if let Some(path) = app_local_descriptor_registry_file() {
        if path.exists() {
            return DescriptorRegistryPathInfo {
                path,
                source: "app-local",
            };
        }
        let legacy = legacy_default_descriptor_registry_file();
        if legacy.exists() {
            return DescriptorRegistryPathInfo {
                path: legacy,
                source: "default-private-legacy",
            };
        }
        return DescriptorRegistryPathInfo {
            path,
            source: "app-local",
        };
    }
    DescriptorRegistryPathInfo {
        path: legacy_default_descriptor_registry_file(),
        source: "default-private-legacy",
    }
}

fn descriptor_registry_path_source_for_setup() -> &'static str {
    descriptor_registry_path_for_setup_status().source
}

fn registry_contains_raw_or_private(registry: &DescriptorRegistry) -> bool {
    registry.extra.iter().any(|(key, value)| {
        key_looks_raw_or_private(key) || value_looks_raw_or_private(&value.to_string())
    })
}

fn resolve_descriptor_registry(
    request: &RtCapabilityProbeRequest,
) -> Result<Option<DescriptorRegistry>, ResolverFailure> {
    if request.resolver_check != Some(true) {
        return Ok(None);
    }

    let Some(registry_file) = descriptor_registry_path_for_probe(request) else {
        return Err(ResolverFailure::MissingConfig);
    };
    let bytes = fs::read(&registry_file.path).map_err(|_| ResolverFailure::MissingConfig)?;
    if let Some(expected_hash) = &request.descriptor_registry_ref_hash {
        if !is_hash_ref(&Some(expected_hash.clone())) {
            return Err(ResolverFailure::RegistryHashMismatch);
        }
        if sha256_ref(&bytes) != *expected_hash {
            return Err(ResolverFailure::RegistryHashMismatch);
        }
    }
    let registry: DescriptorRegistry =
        serde_json::from_slice(&bytes).map_err(|_| ResolverFailure::ConfigInvalid)?;
    if registry.schema != "h2o.studio.transport.real-descriptor-registry.v1" {
        return Err(ResolverFailure::ConfigInvalid);
    }
    if registry.descriptor_mode.as_deref() != Some("hash-only-redacted") {
        return Err(ResolverFailure::ConfigInvalid);
    }
    if registry_contains_raw_or_private(&registry) {
        return Err(ResolverFailure::RawConfigRejected);
    }
    if Some(registry.endpoint_ref_hash.clone()) != request.endpoint_ref_hash
        || Some(registry.remote_root_ref_hash.clone()) != request.remote_root_ref_hash
        || Some(registry.credential_ref_hash.clone()) != request.credential_ref_hash
    {
        return Err(ResolverFailure::DescriptorHashMismatch);
    }

    Ok(Some(registry))
}

fn descriptor_ref_hash(kind: &str, label: &str) -> String {
    let mut descriptor = BTreeMap::new();
    descriptor.insert("kind", kind.to_string());
    descriptor.insert("label", label.trim().to_string());
    descriptor.insert(
        "schema",
        "h2o.studio.transport.real-descriptor-ref.v1".to_string(),
    );
    let bytes = serde_json::to_vec(&descriptor).expect("descriptor ref serialization");
    sha256_ref(&bytes)
}

fn trim_required(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn endpoint_is_reserved_invalid_domain(server_url: &str) -> bool {
    let normalized = server_url.to_ascii_lowercase();
    if normalized.contains("reserved-invalid-domain") || normalized.contains("private.invalid") {
        return true;
    }
    match reqwest::Url::parse(server_url) {
        Ok(url) => url
            .host_str()
            .map(|host| host.eq_ignore_ascii_case("invalid") || host.ends_with(".invalid"))
            .unwrap_or(true),
        Err(_) => true,
    }
}

fn endpoint_is_reachable_candidate(server_url: &str) -> bool {
    match reqwest::Url::parse(server_url) {
        Ok(url) => {
            matches!(url.scheme(), "http" | "https")
                && !endpoint_is_reserved_invalid_domain(server_url)
        }
        Err(_) => false,
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if i + 1 < bytes.len() {
            out.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if i + 2 < bytes.len() {
            out.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            out.push('=');
        }
        i += 3;
    }
    out
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let bytes = input.trim().as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity((bytes.len() / 4) * 3);
    for (index, chunk) in bytes.chunks(4).enumerate() {
        let final_chunk = index == (bytes.len() / 4).saturating_sub(1);
        let pad2 = chunk[2] == b'=';
        let pad3 = chunk[3] == b'=';
        if (pad2 || pad3) && !final_chunk {
            return None;
        }
        let a = base64_value(chunk[0])?;
        let b = base64_value(chunk[1])?;
        let c = if pad2 { 0 } else { base64_value(chunk[2])? };
        let d = if pad3 { 0 } else { base64_value(chunk[3])? };
        out.push((a << 2) | (b >> 4));
        if !pad2 {
            out.push(((b & 0x0f) << 4) | (c >> 2));
        }
        if !pad3 {
            out.push(((c & 0x03) << 6) | d);
        }
    }
    Some(out)
}

fn build_auth_header_private(identifier: &str, credential_secret: &str) -> String {
    let material = credential_secret.trim();
    let lower = material.to_ascii_lowercase();
    if lower.starts_with("basic ") || lower.starts_with("bearer ") {
        return material.to_string();
    }
    let pair = format!("{}:{}", identifier.trim(), material);
    format!("Basic {}", base64_encode(pair.as_bytes()))
}

fn credential_identifier_from_auth_header_private(auth_header_private: &str) -> Option<String> {
    let value = auth_header_private.trim();
    if value.len() < 6 || !value[..6].eq_ignore_ascii_case("basic ") {
        return None;
    }
    let decoded = base64_decode(&value[6..])?;
    let decoded = String::from_utf8(decoded).ok()?;
    let (identifier, _) = decoded.split_once(':')?;
    let identifier = identifier.trim();
    if identifier.is_empty() {
        None
    } else {
        Some(identifier.to_string())
    }
}

fn credential_secret_from_auth_header_private(
    auth_header_private: &str,
    expected_identifier: Option<&str>,
) -> Option<String> {
    let value = auth_header_private.trim();
    if value.len() >= 6 && value[..6].eq_ignore_ascii_case("basic ") {
        let decoded = base64_decode(&value[6..])?;
        let decoded = String::from_utf8(decoded).ok()?;
        let (identifier, secret) = decoded.split_once(':')?;
        if let Some(expected) = expected_identifier {
            if identifier.trim() != expected.trim() {
                return None;
            }
        }
        let secret = secret.trim();
        if secret.is_empty() {
            None
        } else {
            Some(secret.to_string())
        }
    } else if value.len() >= 7 && value[..7].eq_ignore_ascii_case("bearer ") {
        Some(value.to_string())
    } else {
        None
    }
}

fn write_private_registry_file(path: &Path, bytes: &[u8]) -> Result<(), ()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| ())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    fs::write(path, bytes).map_err(|_| ())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(unix)]
fn current_effective_user_id() -> u32 {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() }
}

#[cfg(unix)]
fn owner_is_current_user(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    metadata.uid() == current_effective_user_id()
}

#[cfg(not(unix))]
fn owner_is_current_user(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn file_has_private_permissions(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn file_has_private_permissions(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn parent_has_private_permissions(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o022 == 0
}

#[cfg(not(unix))]
fn parent_has_private_permissions(_metadata: &fs::Metadata) -> bool {
    false
}

fn write_grade_registry_source_candidate(source: &str) -> bool {
    matches!(source, "app-local" | "env")
}

fn write_grade_registry_ref_hash(registry: &DescriptorRegistry) -> Option<String> {
    if registry.descriptor_mode.as_deref() != Some("hash-only-redacted")
        || !is_hash_ref(&Some(registry.endpoint_ref_hash.clone()))
        || !is_hash_ref(&Some(registry.remote_root_ref_hash.clone()))
        || !is_hash_ref(&Some(registry.credential_ref_hash.clone()))
    {
        return None;
    }
    let mut canonical = BTreeMap::new();
    canonical.insert(
        "credentialRefHash".to_string(),
        registry.credential_ref_hash.clone(),
    );
    canonical.insert(
        "descriptorMode".to_string(),
        "hash-only-redacted".to_string(),
    );
    canonical.insert(
        "endpointRefHash".to_string(),
        registry.endpoint_ref_hash.clone(),
    );
    canonical.insert(
        "hashBoundary".to_string(),
        WRITE_GRADE_REGISTRY_HASH_BOUNDARY.to_string(),
    );
    canonical.insert(
        "remoteRootRefHash".to_string(),
        registry.remote_root_ref_hash.clone(),
    );
    canonical.insert(
        "schema".to_string(),
        WRITE_GRADE_REGISTRY_REF_SCHEMA.to_string(),
    );
    serde_json::to_vec(&canonical)
        .ok()
        .map(|bytes| sha256_ref(&bytes))
}

fn apply_registry_storage_status(
    result: &mut RtWebDavSetupStatusResult,
    path_info: &DescriptorRegistryPathInfo,
) {
    result.registry_path_source = path_info.source;
    if let Ok(metadata) = fs::metadata(&path_info.path) {
        result.registry_file_owner_current_user = owner_is_current_user(&metadata);
        result.registry_file_private_permissions = file_has_private_permissions(&metadata);
    }
    if let Some(parent) = path_info.path.parent() {
        if let Ok(metadata) = fs::metadata(parent) {
            result.registry_parent_owner_current_user = owner_is_current_user(&metadata);
            result.registry_parent_private_permissions = parent_has_private_permissions(&metadata);
        }
    }
    result.registry_owner_ok =
        result.registry_file_owner_current_user && result.registry_parent_owner_current_user;
    result.registry_permission_ok =
        result.registry_file_private_permissions && result.registry_parent_private_permissions;
    result.write_grade_registry_eligible = write_grade_registry_source_candidate(path_info.source)
        && result.registry_owner_ok
        && result.registry_permission_ok;
    if path_info.source == "default-private-legacy" {
        result
            .warnings
            .push("real-transport-webdav-registry-legacy-not-write-grade");
    }
}

fn status_from_registry_bytes(
    command: &'static str,
    bytes: &[u8],
    path_info: &DescriptorRegistryPathInfo,
) -> RtWebDavSetupStatusResult {
    let registry_hash = sha256_ref(bytes);
    let mut result = RtWebDavSetupStatusResult::base(
        false,
        "real-transport-webdav-setup-blocked",
        "real-transport-webdav-setup-registry-invalid",
        command,
        vec!["real-transport-webdav-setup-registry-invalid"],
    );
    apply_registry_storage_status(&mut result, path_info);
    result.descriptor_registry_ref_hash = Some(registry_hash);
    result.private_content_hash_available = true;
    let Ok(registry) = serde_json::from_slice::<DescriptorRegistry>(bytes) else {
        return result;
    };
    result.json_parses = true;
    result.write_grade_registry_ref_hash = write_grade_registry_ref_hash(&registry);
    result.endpoint_ref_hash = Some(registry.endpoint_ref_hash.clone());
    result.remote_root_ref_hash = Some(registry.remote_root_ref_hash.clone());
    result.credential_ref_hash = Some(registry.credential_ref_hash.clone());
    result.saved_server_url = registry
        .endpoint_url_private
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    result.saved_root_path = registry
        .remote_root_path_private
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    result.saved_credential_identifier = registry
        .auth_header_private
        .as_deref()
        .and_then(credential_identifier_from_auth_header_private);
    result.credential_material_present = registry
        .auth_header_private
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    let required_private_fields_present = is_hash_ref(&Some(registry.endpoint_ref_hash.clone()))
        && is_hash_ref(&Some(registry.remote_root_ref_hash.clone()))
        && is_hash_ref(&Some(registry.credential_ref_hash.clone()))
        && registry
            .endpoint_url_private
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        && registry
            .remote_root_path_private
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        && result.credential_material_present;
    result.required_private_fields_present = required_private_fields_present;
    result.endpoint_no_longer_reserved_invalid_domain = registry
        .endpoint_url_private
        .as_deref()
        .map(|value| !endpoint_is_reserved_invalid_domain(value))
        .unwrap_or(false);
    result.reachable_candidate = required_private_fields_present
        && registry
            .endpoint_url_private
            .as_deref()
            .map(endpoint_is_reachable_candidate)
            .unwrap_or(false);

    let mut blockers = Vec::new();
    if registry.schema != "h2o.studio.transport.real-descriptor-registry.v1" {
        blockers.push("real-transport-webdav-setup-registry-schema-invalid");
    }
    if registry.descriptor_mode.as_deref() != Some("hash-only-redacted") {
        blockers.push("real-transport-webdav-setup-descriptor-mode-invalid");
    }
    if registry_contains_raw_or_private(&registry) {
        blockers.push("real-transport-webdav-setup-extra-raw-config-rejected");
    }
    if !required_private_fields_present {
        blockers.push("real-transport-webdav-setup-required-private-fields-missing");
    }
    if !result.endpoint_no_longer_reserved_invalid_domain {
        blockers.push("real-transport-webdav-setup-reserved-invalid-domain");
    }
    if !result.reachable_candidate {
        blockers.push("real-transport-webdav-setup-not-reachable-candidate");
    }
    result.blockers = blockers;
    result.ok = result.blockers.is_empty();
    result.status = if result.ok {
        "real-transport-webdav-setup-ready"
    } else {
        "real-transport-webdav-setup-blocked"
    };
    result.reason = if result.ok {
        "real-transport-webdav-setup-ready"
    } else {
        result.blockers[0]
    };
    result
}

fn previous_auth_header_private(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let registry = serde_json::from_slice::<DescriptorRegistry>(&bytes).ok()?;
    registry
        .auth_header_private
        .filter(|value| !value.trim().is_empty())
}

fn previous_auth_header_private_for_setup(
    path_info: &DescriptorRegistryPathInfo,
) -> Option<String> {
    previous_auth_header_private(&path_info.path).or_else(|| {
        if path_info.source == "app-local" {
            previous_auth_header_private(&legacy_default_descriptor_registry_file())
        } else {
            None
        }
    })
}

pub fn prepare_webdav_setup(request: RtWebDavSetupRequest) -> RtWebDavSetupStatusResult {
    let command = "h2o_rt_prepare_webdav_setup";
    let mut blockers = Vec::new();
    let registry_path_info = descriptor_registry_path_for_setup_write();
    let server_url = trim_required(&request.server_url);
    let root_path = trim_required(&request.root_path);
    let credential_identifier = trim_required(&request.credential_identifier);
    let credential_secret = trim_required(&request.credential_secret);
    let endpoint_descriptor_label = trim_required(&request.endpoint_descriptor_label);
    let remote_root_descriptor_label = trim_required(&request.remote_root_descriptor_label);
    let credential_descriptor_label = trim_required(&request.credential_descriptor_label);

    if server_url.is_none() {
        blockers.push("real-transport-webdav-setup-server-url-required");
    }
    if root_path.is_none() {
        blockers.push("real-transport-webdav-setup-root-path-required");
    }
    let previous_auth_header = previous_auth_header_private_for_setup(&registry_path_info);
    if credential_identifier.is_none()
        || (credential_secret.is_none() && previous_auth_header.is_none())
    {
        blockers.push("real-transport-webdav-setup-credential-required");
    }
    if endpoint_descriptor_label.is_none()
        || remote_root_descriptor_label.is_none()
        || credential_descriptor_label.is_none()
    {
        blockers.push("real-transport-webdav-setup-descriptor-labels-required");
    }
    if request.confirm_non_production != Some(true) {
        blockers.push("real-transport-webdav-setup-non-production-confirmation-required");
    }
    if request.confirm_read_only_safe != Some(true) {
        blockers.push("real-transport-webdav-setup-readonly-confirmation-required");
    }
    if request.confirm_sacrificial_write_not_approved != Some(true) {
        blockers.push("real-transport-webdav-setup-no-sacrificial-write-confirmation-required");
    }
    if server_url
        .as_deref()
        .map(endpoint_is_reachable_candidate)
        .unwrap_or(false)
        == false
    {
        blockers.push("real-transport-webdav-setup-reachable-candidate-required");
    }
    for label in [
        endpoint_descriptor_label.as_deref(),
        remote_root_descriptor_label.as_deref(),
        credential_descriptor_label.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if value_looks_raw_or_private(label) {
            blockers.push("real-transport-webdav-setup-descriptor-label-raw-rejected");
            break;
        }
    }
    if !blockers.is_empty() {
        let mut result = RtWebDavSetupStatusResult::base(
            false,
            "real-transport-webdav-setup-blocked",
            blockers[0],
            command,
            blockers,
        );
        apply_registry_storage_status(&mut result, &registry_path_info);
        return result;
    }

    let server_url = server_url.expect("validated serverUrl");
    let root_path = root_path.expect("validated rootPath");
    let credential_identifier = credential_identifier.expect("validated credentialIdentifier");
    let endpoint_descriptor_label =
        endpoint_descriptor_label.expect("validated endpoint descriptor label");
    let remote_root_descriptor_label =
        remote_root_descriptor_label.expect("validated remote root descriptor label");
    let credential_descriptor_label =
        credential_descriptor_label.expect("validated credential descriptor label");
    let endpoint_ref_hash = descriptor_ref_hash("endpoint", &endpoint_descriptor_label);
    let remote_root_ref_hash = descriptor_ref_hash("remote-root", &remote_root_descriptor_label);
    let credential_ref_hash = descriptor_ref_hash("credential", &credential_descriptor_label);
    let credential_input_received_this_save = credential_secret.is_some();
    let auth_header_private = credential_secret
        .as_deref()
        .map(|secret| build_auth_header_private(&credential_identifier, secret))
        .or_else(|| previous_auth_header.clone())
        .expect("validated credential material");
    let credential_material_updated_this_save = credential_input_received_this_save
        && previous_auth_header.as_deref() != Some(auth_header_private.as_str());
    let registry = WritableDescriptorRegistry {
        schema: "h2o.studio.transport.real-descriptor-registry.v1",
        descriptor_mode: "hash-only-redacted",
        endpoint_ref_hash: &endpoint_ref_hash,
        remote_root_ref_hash: &remote_root_ref_hash,
        credential_ref_hash: &credential_ref_hash,
        endpoint_url_private: &server_url,
        remote_root_path_private: &root_path,
        auth_header_private: &auth_header_private,
    };
    let bytes = match serde_json::to_vec_pretty(&registry) {
        Ok(bytes) => bytes,
        Err(_) => {
            return RtWebDavSetupStatusResult::base(
                false,
                "real-transport-webdav-setup-blocked",
                "real-transport-webdav-setup-registry-serialize-failed",
                command,
                vec!["real-transport-webdav-setup-registry-serialize-failed"],
            )
        }
    };
    if write_private_registry_file(&registry_path_info.path, &bytes).is_err() {
        let mut result = RtWebDavSetupStatusResult::base(
            false,
            "real-transport-webdav-setup-blocked",
            "real-transport-webdav-setup-registry-write-failed",
            command,
            vec!["real-transport-webdav-setup-registry-write-failed"],
        );
        apply_registry_storage_status(&mut result, &registry_path_info);
        return result;
    }
    let mut result = status_from_registry_bytes(command, &bytes, &registry_path_info);
    result.credential_input_received_this_save = credential_input_received_this_save;
    result.credential_material_updated_this_save = credential_material_updated_this_save;
    result
}

pub fn webdav_setup_status() -> RtWebDavSetupStatusResult {
    let command = "h2o_rt_webdav_setup_status";
    let registry_path_info = descriptor_registry_path_for_setup_status();
    match fs::read(&registry_path_info.path) {
        Ok(bytes) => status_from_registry_bytes(command, &bytes, &registry_path_info),
        Err(_) => {
            let mut result = RtWebDavSetupStatusResult::base(
                false,
                "real-transport-webdav-setup-blocked",
                "real-transport-webdav-setup-registry-missing",
                command,
                vec!["real-transport-webdav-setup-registry-missing"],
            );
            apply_registry_storage_status(&mut result, &registry_path_info);
            result
        }
    }
}

pub fn webdav_setup_hydrate_form(
    request: RtWebDavSetupHydrateFormRequest,
) -> RtWebDavSetupHydrateFormResult {
    let command = "h2o_rt_webdav_setup_hydrate_form";
    if request.desktop_local_ui != Some(true) {
        return RtWebDavSetupHydrateFormResult::blocked(
            "real-transport-webdav-setup-hydrate-local-desktop-required",
            vec!["real-transport-webdav-setup-hydrate-local-desktop-required"],
        );
    }
    if request.remember_credential != Some(true) {
        return RtWebDavSetupHydrateFormResult::blocked(
            "real-transport-webdav-setup-hydrate-remember-required",
            vec!["real-transport-webdav-setup-hydrate-remember-required"],
        );
    }

    let path_info = descriptor_registry_path_for_setup_status();
    let bytes = match fs::read(&path_info.path) {
        Ok(bytes) => bytes,
        Err(_) => {
            let mut result = RtWebDavSetupHydrateFormResult::blocked(
                "real-transport-webdav-setup-hydrate-registry-missing",
                vec!["real-transport-webdav-setup-hydrate-registry-missing"],
            );
            result.registry_path_source = path_info.source;
            return result;
        }
    };
    let status = status_from_registry_bytes(command, &bytes, &path_info);
    if !status.write_grade_registry_eligible
        || !write_grade_registry_source_candidate(status.registry_path_source)
    {
        let mut result = RtWebDavSetupHydrateFormResult::blocked(
            "real-transport-webdav-setup-hydrate-write-grade-registry-required",
            vec!["real-transport-webdav-setup-hydrate-write-grade-registry-required"],
        );
        result.registry_path_source = status.registry_path_source;
        result.write_grade_registry_eligible = status.write_grade_registry_eligible;
        result.registry_owner_ok = status.registry_owner_ok;
        result.registry_permission_ok = status.registry_permission_ok;
        return result;
    }
    if !status.credential_material_present {
        let mut result = RtWebDavSetupHydrateFormResult::blocked(
            "real-transport-webdav-setup-hydrate-credential-missing",
            vec!["real-transport-webdav-setup-hydrate-credential-missing"],
        );
        result.registry_path_source = status.registry_path_source;
        result.write_grade_registry_eligible = status.write_grade_registry_eligible;
        result.registry_owner_ok = status.registry_owner_ok;
        result.registry_permission_ok = status.registry_permission_ok;
        return result;
    }

    let registry: DescriptorRegistry = match serde_json::from_slice(&bytes) {
        Ok(registry) => registry,
        Err(_) => {
            let mut result = RtWebDavSetupHydrateFormResult::blocked(
                "real-transport-webdav-setup-hydrate-registry-invalid",
                vec!["real-transport-webdav-setup-hydrate-registry-invalid"],
            );
            result.registry_path_source = status.registry_path_source;
            return result;
        }
    };
    let credential_secret = registry.auth_header_private.as_deref().and_then(|value| {
        credential_secret_from_auth_header_private(
            value,
            status.saved_credential_identifier.as_deref(),
        )
    });
    if credential_secret.is_none() {
        let mut result = RtWebDavSetupHydrateFormResult::blocked(
            "real-transport-webdav-setup-hydrate-credential-unavailable",
            vec!["real-transport-webdav-setup-hydrate-credential-unavailable"],
        );
        result.registry_path_source = status.registry_path_source;
        result.write_grade_registry_eligible = status.write_grade_registry_eligible;
        result.registry_owner_ok = status.registry_owner_ok;
        result.registry_permission_ok = status.registry_permission_ok;
        result.credential_material_present = status.credential_material_present;
        return result;
    }

    RtWebDavSetupHydrateFormResult {
        schema: "h2o.studio.transport.real-webdav-setup-hydrate-form.v1",
        ok: true,
        status: "real-transport-webdav-setup-hydrate-form-ready",
        reason: "real-transport-webdav-setup-hydrate-form-ready",
        command,
        registry_path_class: status.registry_path_class,
        registry_path_source: status.registry_path_source,
        write_grade_registry_eligible: status.write_grade_registry_eligible,
        registry_owner_ok: status.registry_owner_ok,
        registry_permission_ok: status.registry_permission_ok,
        saved_server_url: status.saved_server_url,
        saved_root_path: status.saved_root_path,
        saved_credential_identifier: status.saved_credential_identifier,
        remembered_credential_secret: credential_secret,
        credential_material_present: true,
        remember_credential_enabled: true,
        network_attempted: false,
        writes_webdav: false,
        writes_cloud: false,
        writes_relay: false,
        writes_cas: false,
        writes_files: false,
        enqueues_relay: false,
        full_bundle_v3_started: false,
        mints_export_id: false,
        burns_sequence: false,
        product_sync_ready: false,
        transport_ready: false,
        raw_private_fields_logged: false,
        blockers: vec![],
        warnings: vec!["local-desktop-ui-hydration-only-no-probe-no-write"],
    }
}

fn is_allowed_operation(value: &str) -> bool {
    matches!(
        value,
        "options"
            | "propfind-depth-0"
            | "propfind-depth-1"
            | "head-root"
            | "get-root"
            | "head-deterministic-nonexistent-child"
    )
}

fn key_looks_raw_or_private(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized.contains("url")
        || normalized.contains("endpoint")
        || normalized.contains("credential")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("path")
        || normalized.contains("listing")
        || normalized.contains("payload")
        || normalized.contains("caskey")
        || normalized.contains("cas_key")
}

fn value_looks_raw_or_private(value: &str) -> bool {
    let normalized = value.to_ascii_lowercase();
    normalized.contains("://")
        || normalized.contains("password")
        || normalized.contains("secret")
        || normalized.contains("credentialvalue")
        || normalized.contains("payloadbody")
        || normalized.contains("caskey")
        || normalized.contains("rawlisting")
}

fn has_forbidden_extra(request: &RtCapabilityProbeRequest) -> bool {
    request.extra.iter().any(|(key, value)| {
        key_looks_raw_or_private(key) || value_looks_raw_or_private(&value.to_string())
    }) || request
        .forbidden_evidence_tokens
        .as_ref()
        .map(|tokens| tokens.iter().any(|token| value_looks_raw_or_private(token)))
        .unwrap_or(false)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReadOnlyProbeOperation {
    Options,
    PropfindDepth0,
    PropfindDepth1,
    HeadRoot,
    GetRoot,
    HeadDeterministicNonexistentChild,
}

impl ReadOnlyProbeOperation {
    fn from_request(value: &str) -> Option<Self> {
        match value {
            "options" => Some(Self::Options),
            "propfind-depth-0" => Some(Self::PropfindDepth0),
            "propfind-depth-1" => Some(Self::PropfindDepth1),
            "head-root" => Some(Self::HeadRoot),
            "get-root" => Some(Self::GetRoot),
            "head-deterministic-nonexistent-child" => Some(Self::HeadDeterministicNonexistentChild),
            _ => None,
        }
    }

    fn method(self) -> &'static str {
        match self {
            Self::Options => "OPTIONS",
            Self::PropfindDepth0 | Self::PropfindDepth1 => "PROPFIND",
            Self::HeadRoot | Self::HeadDeterministicNonexistentChild => "HEAD",
            Self::GetRoot => "GET",
        }
    }

    fn redacted_label(self) -> &'static str {
        match self {
            Self::Options => "OPTIONS",
            Self::PropfindDepth0 => "PROPFIND Depth 0",
            Self::PropfindDepth1 => "PROPFIND Depth 1",
            Self::HeadRoot => "HEAD root",
            Self::GetRoot => "GET root",
            Self::HeadDeterministicNonexistentChild => "HEAD deterministic nonexistent child",
        }
    }

    fn depth(self) -> Option<&'static str> {
        match self {
            Self::PropfindDepth0 => Some("0"),
            Self::PropfindDepth1 => Some("1"),
            _ => None,
        }
    }

    fn sends_propfind_body(self) -> bool {
        matches!(self, Self::PropfindDepth0 | Self::PropfindDepth1)
    }

    fn propfind_content_type_class(self) -> &'static str {
        if self.sends_propfind_body() {
            "xml"
        } else {
            "none"
        }
    }

    fn accept_header_class(self) -> &'static str {
        if self.sends_propfind_body() {
            "xml"
        } else {
            "none"
        }
    }

    fn targets_nonexistent_child(self) -> bool {
        self == Self::HeadDeterministicNonexistentChild
    }
}

#[derive(Clone, Debug)]
struct ReadOnlyProbeHttpRequest {
    operation: ReadOnlyProbeOperation,
    endpoint_url_private: String,
    remote_root_path_private: String,
    auth_header_private: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct ReadOnlyProbeHttpResponse {
    status: u16,
    dav_header: Option<String>,
    allow_header: Option<String>,
    body: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
struct LiveReadOnlyProbeOutcome {
    network_attempted: bool,
    root_exists: Option<bool>,
    root_empty: Option<bool>,
    listing_hash: Option<String>,
    child_404_ok: Option<bool>,
    method_status_families: Vec<ReadOnlyMethodStatusFamily>,
    dav_class_summary_hash: Option<String>,
    allowed_methods_summary_hash: Option<String>,
}

trait ReadOnlyProbeClient {
    fn send(
        &self,
        request: ReadOnlyProbeHttpRequest,
    ) -> Result<ReadOnlyProbeHttpResponse, ResolverFailure>;
}

struct ReqwestReadOnlyProbeClient;

impl ReqwestReadOnlyProbeClient {
    fn build_target_url(
        endpoint_url_private: &str,
        remote_root_path_private: &str,
        child: bool,
    ) -> Result<reqwest::Url, ResolverFailure> {
        let mut url = reqwest::Url::parse(endpoint_url_private)
            .map_err(|_| ResolverFailure::LiveUrlInvalid)?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(ResolverFailure::LiveUrlInvalid);
        }
        url.set_query(None);
        url.set_fragment(None);

        let endpoint_segments = url
            .path_segments()
            .map(|segments| {
                segments
                    .filter(|segment| !segment.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let remote_root_segments = remote_root_path_private
            .split('/')
            .map(str::trim)
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();

        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| ResolverFailure::LiveUrlInvalid)?;
            segments.clear();
            for segment in endpoint_segments {
                segments.push(&segment);
            }
            for segment in remote_root_segments {
                segments.push(segment);
            }
            if child {
                segments.push(".h2o-readonly-probe-nonexistent");
            } else {
                segments.push("");
            }
        }
        Ok(url)
    }
}

impl ReadOnlyProbeClient for ReqwestReadOnlyProbeClient {
    fn send(
        &self,
        request: ReadOnlyProbeHttpRequest,
    ) -> Result<ReadOnlyProbeHttpResponse, ResolverFailure> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(READONLY_TIMEOUT_SECONDS))
            .build()
            .map_err(|_| ResolverFailure::LiveNetworkFailed)?;
        let url = Self::build_target_url(
            &request.endpoint_url_private,
            &request.remote_root_path_private,
            request.operation.targets_nonexistent_child(),
        )?;
        let method = reqwest::Method::from_bytes(request.operation.method().as_bytes())
            .map_err(|_| ResolverFailure::LiveNetworkFailed)?;
        let mut builder = client.request(method, url);
        if let Some(depth) = request.operation.depth() {
            builder = builder.header("Depth", depth);
        }
        if request.operation.sends_propfind_body() {
            builder = builder
                .header(reqwest::header::ACCEPT, WEBDAV_XML_ACCEPT)
                .header(reqwest::header::CONTENT_TYPE, WEBDAV_XML_CONTENT_TYPE)
                .header(reqwest::header::CACHE_CONTROL, "no-cache")
                .body(WEBDAV_PROPFIND_BODY.to_string());
        }
        if let Some(auth_header) = request.auth_header_private {
            builder = builder.header("Authorization", auth_header);
        }
        let mut response = builder
            .send()
            .map_err(|_| ResolverFailure::LiveNetworkFailed)?;
        let status = response.status().as_u16();
        let dav_header = response
            .headers()
            .get("DAV")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let allow_header = response
            .headers()
            .get("Allow")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let mut body = Vec::new();
        response
            .by_ref()
            .take((MAX_READONLY_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| ResolverFailure::LiveNetworkFailed)?;
        if body.len() > MAX_READONLY_RESPONSE_BYTES {
            return Err(ResolverFailure::LiveResponseTooLarge);
        }
        Ok(ReadOnlyProbeHttpResponse {
            status,
            dav_header,
            allow_header,
            body,
        })
    }
}

fn redacted_summary_hash(value: Option<&str>) -> Option<String> {
    value.map(|value| sha256_ref(value.as_bytes()))
}

fn status_family(status: u16) -> &'static str {
    match status {
        100..=199 => "1xx",
        200..=299 => "2xx",
        300..=399 => "3xx",
        400..=499 => "4xx",
        500..=599 => "5xx",
        _ => "other",
    }
}

fn redacted_request_shape(
    endpoint_url_private: &str,
    remote_root_path_private: &str,
    operation: ReadOnlyProbeOperation,
    auth_header_private: Option<&String>,
) -> Result<ReadOnlyRequestShape, ResolverFailure> {
    let target_url = ReqwestReadOnlyProbeClient::build_target_url(
        endpoint_url_private,
        remote_root_path_private,
        operation.targets_nonexistent_child(),
    )?;
    Ok(ReadOnlyRequestShape {
        target_shape: if remote_root_path_private.trim().trim_matches('/').is_empty() {
            "endpoint-only"
        } else {
            "endpoint-plus-folder"
        },
        trailing_slash: target_url.path().ends_with('/'),
        double_slash: target_url.path().contains("//"),
        auth_header_present: auth_header_private
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false),
        propfind_depth_header_present: operation.depth().is_some(),
        propfind_body_present: operation.sends_propfind_body(),
        propfind_content_type_class: operation.propfind_content_type_class(),
        accept_header_class: operation.accept_header_class(),
    })
}

fn run_live_readonly_probe<C: ReadOnlyProbeClient>(
    request: &RtCapabilityProbeRequest,
    registry: &DescriptorRegistry,
    client: &C,
) -> Result<LiveReadOnlyProbeOutcome, ResolverFailure> {
    let endpoint_url_private = registry
        .endpoint_url_private
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or(ResolverFailure::LiveDescriptorPrivateFieldsMissing)?;
    let remote_root_path_private = registry
        .remote_root_path_private
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or(ResolverFailure::LiveDescriptorPrivateFieldsMissing)?;
    let operations = request.requested_operations.as_deref().unwrap_or(&[]);
    let mut outcome = LiveReadOnlyProbeOutcome {
        network_attempted: true,
        ..Default::default()
    };

    for operation in operations
        .iter()
        .filter_map(|operation| ReadOnlyProbeOperation::from_request(operation))
    {
        let request_shape = redacted_request_shape(
            &endpoint_url_private,
            &remote_root_path_private,
            operation,
            registry.auth_header_private.as_ref(),
        )?;
        let response = client.send(ReadOnlyProbeHttpRequest {
            operation,
            endpoint_url_private: endpoint_url_private.clone(),
            remote_root_path_private: remote_root_path_private.clone(),
            auth_header_private: registry.auth_header_private.clone(),
        })?;
        let status_success = (200..300).contains(&response.status);
        outcome
            .method_status_families
            .push(ReadOnlyMethodStatusFamily {
                operation: operation.redacted_label(),
                status_code: response.status,
                status_family: status_family(response.status),
                request_shape,
            });
        if operation.targets_nonexistent_child() {
            outcome.child_404_ok = Some(response.status == 404);
        } else if matches!(
            operation,
            ReadOnlyProbeOperation::HeadRoot
                | ReadOnlyProbeOperation::GetRoot
                | ReadOnlyProbeOperation::PropfindDepth0
                | ReadOnlyProbeOperation::PropfindDepth1
        ) {
            if status_success {
                outcome.root_exists = Some(true);
            } else if outcome.root_exists != Some(true) {
                outcome.root_exists = Some(false);
            }
        }
        if matches!(
            operation,
            ReadOnlyProbeOperation::GetRoot
                | ReadOnlyProbeOperation::PropfindDepth0
                | ReadOnlyProbeOperation::PropfindDepth1
        ) && !response.body.is_empty()
        {
            outcome.listing_hash = Some(sha256_ref(&response.body));
            outcome.root_empty = Some(false);
        }
        outcome.dav_class_summary_hash = outcome
            .dav_class_summary_hash
            .or_else(|| redacted_summary_hash(response.dav_header.as_deref()));
        outcome.allowed_methods_summary_hash = outcome
            .allowed_methods_summary_hash
            .or_else(|| redacted_summary_hash(response.allow_header.as_deref()));
    }

    Ok(outcome)
}

fn evaluate_capability_probe_with_client<C: ReadOnlyProbeClient>(
    request: RtCapabilityProbeRequest,
    client: &C,
) -> RtCapabilityProbeResult {
    let mut blockers = Vec::new();
    let live_probe_requested = request.live_read_only_probe == Some(true);
    let expected_gate = if live_probe_requested {
        LIVE_READONLY_PROBE_GATE
    } else {
        READONLY_PROBE_GATE
    };

    if request.schema.as_deref() != Some(REQUEST_SCHEMA) {
        blockers.push("real-transport-w3-readonly-request-schema-required");
    }
    if request.gate.as_deref() != Some(expected_gate) {
        blockers.push("real-transport-w3-readonly-gate-required");
    }
    if live_probe_requested && request.resolver_check != Some(true) {
        blockers.push("real-transport-w3-live-resolver-required");
    }
    if request.diagnostic_only != Some(true)
        || request.read_only != Some(true)
        || request.dry_run != Some(true)
    {
        blockers.push("real-transport-w3-readonly-mode-required");
    }
    if !is_hash_ref(&request.endpoint_ref_hash)
        || !is_hash_ref(&request.remote_root_ref_hash)
        || !is_hash_ref(&request.credential_ref_hash)
    {
        blockers.push("real-transport-w3-readonly-target-refs-required");
    }
    if let Some(receipt_hash) = &request.capability_probe_receipt_hash {
        if !is_hash_ref(&Some(receipt_hash.clone())) {
            blockers.push("real-transport-w3-readonly-receipt-hash-invalid");
        }
    }
    if let Some(registry_hash) = &request.descriptor_registry_ref_hash {
        if !is_hash_ref(&Some(registry_hash.clone())) {
            blockers.push("real-transport-w3-resolver-registry-hash-mismatch");
        }
    }
    let operations = request.requested_operations.as_deref().unwrap_or(&[]);
    if operations.is_empty() || operations.iter().any(|op| !is_allowed_operation(op)) {
        blockers.push("real-transport-w3-readonly-operation-invalid");
    }
    if request.product_sync_ready == Some(true)
        || request.transport_ready == Some(true)
        || request.real_webdav_transport_available == Some(true)
    {
        blockers.push("real-transport-w3-readiness-claim-rejected");
    }
    if request.writes_webdav == Some(true)
        || request.writes_cloud == Some(true)
        || request.writes_relay == Some(true)
        || request.writes_cas == Some(true)
        || request.writes_files == Some(true)
        || request.enqueues_relay == Some(true)
        || request.full_bundle_v3_started == Some(true)
        || request.mints_export_id == Some(true)
        || request.burns_sequence == Some(true)
    {
        blockers.push("real-transport-w3-write-claim-rejected");
    }
    let raw_input_rejected = has_forbidden_extra(&request);
    if raw_input_rejected {
        blockers.push("real-transport-w3-raw-input-rejected");
    } else if !request.extra.is_empty() {
        blockers.push("real-transport-w3-unknown-field-rejected");
    }
    let registry = if blockers.is_empty() {
        match resolve_descriptor_registry(&request) {
            Ok(registry) => registry,
            Err(err) => {
                blockers.push(err.blocker());
                None
            }
        }
    } else {
        None
    };
    let resolver = registry.is_some();
    let live_probe = if blockers.is_empty() && live_probe_requested {
        match registry
            .as_ref()
            .ok_or(ResolverFailure::LiveDescriptorPrivateFieldsMissing)
            .and_then(|registry| run_live_readonly_probe(&request, registry, client))
        {
            Ok(outcome) => Some(outcome),
            Err(err) => {
                blockers.push(err.blocker());
                None
            }
        }
    } else {
        None
    };

    if !blockers.is_empty() {
        return RtCapabilityProbeResult::blocked(
            "read-only-capability-probe-blocked",
            blockers,
            raw_input_rejected,
        );
    }

    RtCapabilityProbeResult::ready(&request, resolver, live_probe)
}

pub fn evaluate_capability_probe(request: RtCapabilityProbeRequest) -> RtCapabilityProbeResult {
    evaluate_capability_probe_with_client(request, &ReqwestReadOnlyProbeClient)
}

fn token_hash_matches(raw: &Option<String>, expected: &Option<String>) -> bool {
    let Some(raw) = raw.as_deref() else {
        return false;
    };
    let Some(expected) = expected.as_deref() else {
        return false;
    };
    sha256_ref(raw.as_bytes()) == expected
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FirstWriteMode {
    LoopbackMock,
    LiveWebDav,
}

fn sorted_json_value(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(values) => {
            JsonValue::Array(values.into_iter().map(sorted_json_value).collect())
        }
        JsonValue::Object(map) => {
            let mut entries = map.into_iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            let mut sorted = serde_json::Map::new();
            for (key, value) in entries {
                sorted.insert(key, sorted_json_value(value));
            }
            JsonValue::Object(sorted)
        }
        value => value,
    }
}

fn without_null_json_values(value: JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(values) => {
            JsonValue::Array(values.into_iter().map(without_null_json_values).collect())
        }
        JsonValue::Object(map) => {
            let mut without_nulls = serde_json::Map::new();
            for (key, value) in map {
                if !value.is_null() {
                    without_nulls.insert(key, without_null_json_values(value));
                }
            }
            JsonValue::Object(without_nulls)
        }
        value => value,
    }
}

fn write_grade_receipt_core_hash(receipt: &WriteGradeReceipt) -> Option<String> {
    let value = serde_json::to_value(receipt).ok()?;
    let sorted = sorted_json_value(without_null_json_values(value));
    serde_json::to_vec(&sorted)
        .ok()
        .map(|bytes| sha256_ref(&bytes))
}

#[derive(Debug, Clone)]
struct DuplicateRejectingJson(JsonValue);

impl<'de> Deserialize<'de> for DuplicateRejectingJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct DuplicateRejectingVisitor;

        impl<'de> Visitor<'de> for DuplicateRejectingVisitor {
            type Value = DuplicateRejectingJson;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("strict JSON without duplicate keys or floating-point values")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(DuplicateRejectingJson(JsonValue::Bool(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(DuplicateRejectingJson(JsonValue::Number(value.into())))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(DuplicateRejectingJson(JsonValue::Number(value.into())))
            }

            fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Err(E::custom("floating-point JSON values are refused"))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
            where
                E: de::Error,
            {
                Ok(DuplicateRejectingJson(JsonValue::String(value.to_string())))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(DuplicateRejectingJson(JsonValue::String(value)))
            }

            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(DuplicateRejectingJson(JsonValue::Null))
            }

            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(DuplicateRejectingJson(JsonValue::Null))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<DuplicateRejectingJson>()? {
                    values.push(value.0);
                }
                Ok(DuplicateRejectingJson(JsonValue::Array(values)))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate JSON object key refused"));
                    }
                    let value = map.next_value::<DuplicateRejectingJson>()?;
                    values.insert(key, value.0);
                }
                Ok(DuplicateRejectingJson(JsonValue::Object(values)))
            }
        }

        deserializer.deserialize_any(DuplicateRejectingVisitor)
    }
}

fn parse_duplicate_safe_json(raw_json: &str) -> Result<JsonValue, &'static str> {
    let mut deserializer = serde_json::Deserializer::from_str(raw_json);
    let parsed = DuplicateRejectingJson::deserialize(&mut deserializer)
        .map_err(|_| "real-transport-r6-json-invalid-or-duplicate-key")?;
    deserializer
        .end()
        .map_err(|_| "real-transport-r6-json-invalid-or-duplicate-key")?;
    Ok(parsed.0)
}

fn parse_r6_receipt_for_execution(
    raw_json: &str,
    claimed_receipt_core_hash: &str,
) -> Result<R6WriteGradeReceipt, &'static str> {
    if R6_BURNED_RECEIPT_CORE_HASHES.contains(&claimed_receipt_core_hash) {
        return Err("real-transport-r6-burned-receipt-denied");
    }
    let value = parse_duplicate_safe_json(raw_json)?;
    let Some(object) = value.as_object() else {
        return Err("real-transport-r6-receipt-object-required");
    };
    let schema = object.get("schemaVersion").and_then(JsonValue::as_str);
    if schema.is_none() && object.contains_key("schema") {
        return Err("real-transport-r6-historical-receipt-refused");
    }
    if schema != Some(R6_RECEIPT_SCHEMA_VERSION) {
        return Err("real-transport-r6-schema-version-refused");
    }
    serde_json::from_value::<R6WriteGradeReceipt>(value)
        .map_err(|_| "real-transport-r6-strict-receipt-invalid")
}

#[allow(dead_code)]
fn parse_r6_approval_core(raw_json: &str) -> Result<R6ApprovalCore, &'static str> {
    let value = parse_duplicate_safe_json(raw_json)?;
    serde_json::from_value::<R6ApprovalCore>(value)
        .map_err(|_| "real-transport-r6-strict-approval-core-invalid")
}

fn contains_json_null(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => true,
        JsonValue::Array(values) => values.iter().any(contains_json_null),
        JsonValue::Object(values) => values.values().any(contains_json_null),
        _ => false,
    }
}

fn canonical_typed_json_bytes<T: Serialize>(value: &T) -> Option<Vec<u8>> {
    let value = serde_json::to_value(value).ok()?;
    if contains_json_null(&value) {
        return None;
    }
    serde_json::to_vec(&sorted_json_value(value)).ok()
}

fn domain_separated_hash(domain: &[u8], canonical_json: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(canonical_json);
    format!("sha256:{:x}", hasher.finalize())
}

fn r6_receipt_core_hash(receipt: &R6WriteGradeReceipt) -> Option<String> {
    canonical_typed_json_bytes(receipt)
        .map(|bytes| domain_separated_hash(R6_RECEIPT_HASH_DOMAIN, &bytes))
}

fn r6_approval_core_hash(approval: &R6ApprovalCore) -> Option<String> {
    canonical_typed_json_bytes(approval)
        .map(|bytes| domain_separated_hash(R6_APPROVAL_HASH_DOMAIN, &bytes))
}

fn r6_approval_core_from_receipt(receipt: &R6WriteGradeReceipt) -> R6ApprovalCore {
    R6ApprovalCore {
        schema_version: receipt.approval.approval_schema_version.clone(),
        approval_artifact_identifier: receipt.approval.approval_artifact_identifier.clone(),
        mint_utc: receipt.approval.approval_mint_utc.clone(),
        expiry_utc: receipt.approval.approval_expiry_utc.clone(),
        constrained_descendant_authorization_descriptor: receipt
            .approval
            .constrained_descendant_authorization_descriptor
            .clone(),
        ceremony_policy_identifier: receipt.approval.ceremony_policy_identifier.clone(),
        e6_commit: receipt.runtime.e6_commit.clone(),
    }
}

fn is_sha256_ref_str(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .map(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
        .unwrap_or(false)
}

fn is_commit_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_leap_year(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn parse_r6_utc_seconds(value: &str) -> Option<i64> {
    let parsed = parse_utc_seconds(value)?;
    let year = value[0..4].parse::<i32>().ok()?;
    let month = value[5..7].parse::<usize>().ok()?;
    let day = value[8..10].parse::<u32>().ok()?;
    let month_lengths = [
        31,
        if is_leap_year(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if month == 0 || month > month_lengths.len() || day == 0 || day > month_lengths[month - 1] {
        return None;
    }
    Some(parsed)
}

#[derive(Clone, Copy)]
struct R6ApprovalGateConfig<'a> {
    sealed: bool,
    approval_commit: &'a str,
    approval_artifact_hash: &'a str,
}

impl R6ApprovalGateConfig<'static> {
    fn production() -> Self {
        Self {
            sealed: R6_APPROVAL_GATE_SEALED,
            approval_commit: R6_APPROVAL_COMMIT,
            approval_artifact_hash: R6_APPROVAL_ARTIFACT_HASH,
        }
    }
}

#[derive(Clone, Copy)]
struct R6DispatchContext<'a> {
    now_utc: &'a str,
    approved_runtime_commit: &'a str,
    embedded_build_git_sha: &'a str,
    build_dirty: bool,
    build_profile: R6BuildProfile,
    computed_one_shot_token_hash: &'a str,
    computed_kill_switch_token_hash: &'a str,
    receipt_consumed: bool,
    receipt_invoked: bool,
    consumed_marker_exists: bool,
}

fn validate_r6_approval_gate(
    receipt: &R6WriteGradeReceipt,
    gate: R6ApprovalGateConfig<'_>,
) -> Result<(), &'static str> {
    if !gate.sealed || gate.approval_commit.is_empty() || gate.approval_artifact_hash.is_empty() {
        return Err("real-transport-r6-approval-gate-unsealed");
    }
    if matches!(
        receipt.approval.approval_artifact_commit.as_str(),
        W34B1_OPERATOR_APPROVAL_COMMIT | W34B1_R2_RENEWED_OPERATOR_APPROVAL_COMMIT
    ) {
        return Err("real-transport-r6-historical-approval-refused");
    }
    if receipt.approval.approval_artifact_commit != gate.approval_commit {
        return Err("real-transport-r6-approval-commit-mismatch");
    }
    if receipt.approval.approval_core_hash != gate.approval_artifact_hash {
        return Err("real-transport-r6-approval-hash-mismatch");
    }
    if receipt.approval.approval_schema_version != R6_APPROVAL_SCHEMA_VERSION
        || receipt
            .approval
            .constrained_descendant_authorization_descriptor
            != R6_DESCENDANT_AUTHORIZATION_DESCRIPTOR
        || receipt.approval.ceremony_policy_identifier != R6_CEREMONY_POLICY_IDENTIFIER
    {
        return Err("real-transport-r6-approval-binding-invalid");
    }
    let approval_core = r6_approval_core_from_receipt(receipt);
    if r6_approval_core_hash(&approval_core).as_deref()
        != Some(receipt.approval.approval_core_hash.as_str())
    {
        return Err("real-transport-r6-approval-core-hash-mismatch");
    }
    Ok(())
}

fn validate_r6_runtime_and_lineage(
    receipt: &R6WriteGradeReceipt,
    context: R6DispatchContext<'_>,
) -> Result<(), &'static str> {
    let runtime = &receipt.runtime;
    if !is_commit_sha(&runtime.approved_final_runtime_commit)
        || runtime.approved_final_runtime_commit != context.approved_runtime_commit
        || runtime.required_embedded_build_git_sha != context.embedded_build_git_sha
        || runtime.required_embedded_build_git_sha != runtime.approved_final_runtime_commit
    {
        return Err("real-transport-r6-runtime-binding-mismatch");
    }
    if !runtime.build_dirty_must_be_false || context.build_dirty {
        return Err("real-transport-r6-dirty-build-refused");
    }
    if runtime.build_profile != context.build_profile
        || runtime.e6_commit != R6_E6_COMMIT
        || runtime.e6_parent != R6_E6_PARENT_COMMIT
        || runtime.e6_evidence_sha256 != R6_E6_EVIDENCE_SHA256
        || runtime.e6_runtime_stdout_sha256 != R6_E6_RUNTIME_STDOUT_SHA256
    {
        return Err("real-transport-r6-e6-binding-mismatch");
    }
    let implementation = &runtime.implementation_commitments;
    if implementation.gated_executor_commit != R6_GATED_EXECUTOR_COMMIT
        || implementation.canonical_binding_fix_commit != R6_CANONICAL_BINDING_FIX_COMMIT
        || implementation.parent_propfind_fix_commit != W35B_PARENT_PROPFIND_FIX_COMMIT
        || implementation.r5a_binding_fix_commit != R5A_BINDING_FIX_PRESENT_COMMIT
        || implementation.w35d_implementation_commit != R6_W35D_IMPLEMENTATION_COMMIT
        || !implementation.parent_propfind_fix_must_be_present
        || !implementation.r5a_binding_fix_must_be_present
    {
        return Err("real-transport-r6-implementation-binding-mismatch");
    }
    let lineage = &receipt.lineage;
    let lineage_ok = lineage.w31_request_shape_commit == W31_ALIGNMENT_COMMIT
        && lineage.w31_closeout_commit == W31_CLOSEOUT_COMMIT
        && lineage.w32_mock_executor_commit == W32_MOCK_PROOF_COMMIT
        && lineage.w33a_commit == W33A_DESIGN_COMMIT
        && lineage.w33b_commit == W33B_STORAGE_COMMIT
        && lineage.w33c_commit == W33C_HASH_BOUNDARY_COMMIT
        && lineage.w34a_commit == W34A_REFUSED_COMMAND_COMMIT
        && lineage.w34b_commit == W34B0_APPROVAL_PACKAGE_COMMIT
        && lineage.gated_executor_commit == R6_GATED_EXECUTOR_COMMIT
        && lineage.canonical_binding_fix_commit == R6_CANONICAL_BINDING_FIX_COMMIT
        && lineage.parent_propfind_fix_commit == W35B_PARENT_PROPFIND_FIX_COMMIT
        && lineage.r5a_binding_fix_commit == R5A_BINDING_FIX_PRESENT_COMMIT
        && lineage.w35d_implementation_commit == R6_W35D_IMPLEMENTATION_COMMIT
        && lineage.e6_commit == R6_E6_COMMIT;
    if !lineage_ok {
        return Err("real-transport-r6-lineage-binding-mismatch");
    }
    Ok(())
}

fn validate_r6_private_commitments(
    receipt: &R6WriteGradeReceipt,
    context: R6DispatchContext<'_>,
) -> Result<(), &'static str> {
    let commitments = &receipt.private_material_commitments;
    for commitment in [
        &commitments.one_shot_token_sha256,
        &commitments.kill_switch_token_sha256,
        &commitments.endpoint_ref_hash,
        &commitments.remote_root_ref_hash,
        &commitments.credential_ref_hash,
        &commitments.deterministic_object_path_commitment,
        &commitments.deterministic_payload_hash,
    ] {
        if !is_sha256_ref_str(commitment) {
            return Err("real-transport-r6-private-commitment-invalid");
        }
    }
    if commitments.one_shot_token_sha256 != context.computed_one_shot_token_hash
        || commitments.kill_switch_token_sha256 != context.computed_kill_switch_token_hash
        || commitments.one_shot_token_sha256 == commitments.kill_switch_token_sha256
    {
        return Err("real-transport-r6-token-commitment-mismatch");
    }
    if commitments.maximum_payload_bytes != 256 {
        return Err("real-transport-r6-payload-ceiling-invalid");
    }
    Ok(())
}

fn validate_r6_ceremony_policy(receipt: &R6WriteGradeReceipt) -> Result<(), &'static str> {
    let policy = &receipt.ceremony_policy;
    if policy.policy_identifier != R6_CEREMONY_POLICY_IDENTIFIER
        || policy.ordered_sequence
            != [
                R6CeremonyMethod::Propfind,
                R6CeremonyMethod::Put,
                R6CeremonyMethod::Put,
                R6CeremonyMethod::Get,
            ]
        || policy.attempt_ceilings.parent_propfind != 1
        || policy.attempt_ceilings.first_create_only_put != 1
        || policy.attempt_ceilings.second_create_only_put != 1
        || policy.attempt_ceilings.readback_get != 1
        || policy.total_request_ceiling != 4
    {
        return Err("real-transport-r6-method-policy-invalid");
    }
    if policy.expected_results.parent_propfind.status_code != 207
        || policy.expected_results.first_create_only_put.status_code != 201
        || policy.expected_results.second_create_only_put.status_code != 412
        || policy.expected_results.readback_get.accepted_status_family != R6StatusFamily::TwoXx
        || !policy
            .expected_results
            .readback_get
            .exact_payload_hash_match_required
    {
        return Err("real-transport-r6-result-policy-invalid");
    }
    if !policy.redirects_prohibited
        || !policy.authority_changes_prohibited
        || !policy.automatic_retries_prohibited
        || !policy.cleanup_prohibited
        || !policy.readiness_changes_prohibited
    {
        return Err("real-transport-r6-fail-closed-policy-invalid");
    }
    if policy.forbidden_methods
        != [
            R6ForbiddenMethod::Options,
            R6ForbiddenMethod::Delete,
            R6ForbiddenMethod::Mkcol,
            R6ForbiddenMethod::Proppatch,
            R6ForbiddenMethod::Move,
            R6ForbiddenMethod::Copy,
            R6ForbiddenMethod::Lock,
            R6ForbiddenMethod::Unlock,
            R6ForbiddenMethod::Post,
        ]
        || policy.forbidden_write_classes
            != [
                R6ForbiddenWriteClass::Archive,
                R6ForbiddenWriteClass::Chat,
                R6ForbiddenWriteClass::FullBundle,
                R6ForbiddenWriteClass::FullBundleV3,
                R6ForbiddenWriteClass::Relay,
                R6ForbiddenWriteClass::Cas,
                R6ForbiddenWriteClass::Outbox,
                R6ForbiddenWriteClass::Ledger,
                R6ForbiddenWriteClass::UserData,
            ]
    {
        return Err("real-transport-r6-forbidden-policy-invalid");
    }
    Ok(())
}

fn validate_r6_lifecycle(
    receipt: &R6WriteGradeReceipt,
    receipt_core_hash: &str,
    context: R6DispatchContext<'_>,
) -> Result<(), &'static str> {
    let lifecycle = &receipt.lifecycle_policy;
    let now =
        parse_r6_utc_seconds(context.now_utc).ok_or("real-transport-r6-validation-time-invalid")?;
    let receipt_mint = parse_r6_utc_seconds(&lifecycle.receipt_mint_utc)
        .ok_or("real-transport-r6-receipt-time-invalid")?;
    let receipt_expiry = parse_r6_utc_seconds(&lifecycle.receipt_expiry_utc)
        .ok_or("real-transport-r6-receipt-time-invalid")?;
    let approval_mint = parse_r6_utc_seconds(&receipt.approval.approval_mint_utc)
        .ok_or("real-transport-r6-approval-time-invalid")?;
    let approval_expiry = parse_r6_utc_seconds(&receipt.approval.approval_expiry_utc)
        .ok_or("real-transport-r6-approval-time-invalid")?;
    if lifecycle.maximum_validity_seconds as i64 != R6_MAX_VALIDITY_SECONDS
        || lifecycle.clock_skew_seconds as i64 != R6_CLOCK_SKEW_SECONDS
        || receipt_expiry <= receipt_mint
        || receipt_expiry - receipt_mint > lifecycle.maximum_validity_seconds as i64
        || receipt_mint < approval_mint
        || receipt_expiry > approval_expiry
    {
        return Err("real-transport-r6-validity-window-invalid");
    }
    let skew = lifecycle.clock_skew_seconds as i64;
    if receipt_mint > now + skew || approval_mint > now + skew {
        return Err("real-transport-r6-future-mint-refused");
    }
    if now > receipt_expiry + skew || now > approval_expiry + skew {
        return Err("real-transport-r6-receipt-or-approval-expired");
    }
    if !lifecycle.must_be_unconsumed
        || !lifecycle.must_be_uninvoked
        || context.receipt_consumed
        || context.receipt_invoked
        || context.consumed_marker_exists
    {
        return Err("real-transport-r6-receipt-already-consumed-or-invoked");
    }
    let marker = &lifecycle.consumed_marker_binding;
    if lifecycle.consumed_marker_schema_version != R6_CONSUMED_MARKER_SCHEMA_VERSION
        || marker.receipt_identifier != receipt.receipt_identifier
        || marker.receipt_core_hash != R6ReceiptCoreHashBinding::CanonicalR6ReceiptCoreHash
        || marker.approved_runtime_commit != receipt.runtime.approved_final_runtime_commit
        || !marker.product_sync_ready_must_remain_false
        || !marker.transport_ready_must_remain_false
        || !is_sha256_ref_str(receipt_core_hash)
    {
        return Err("real-transport-r6-consumed-marker-policy-invalid");
    }
    Ok(())
}

fn dispatch_r6_execution_preflight_with_gate<T, F>(
    raw_receipt_json: &str,
    claimed_receipt_core_hash: &str,
    context: R6DispatchContext<'_>,
    gate: R6ApprovalGateConfig<'_>,
    after_all_preflight: F,
) -> Result<T, &'static str>
where
    F: FnOnce(&R6WriteGradeReceipt, &str) -> T,
{
    let receipt = parse_r6_receipt_for_execution(raw_receipt_json, claimed_receipt_core_hash)?;
    let computed_receipt_core_hash =
        r6_receipt_core_hash(&receipt).ok_or("real-transport-r6-receipt-core-hash-failed")?;
    if computed_receipt_core_hash != claimed_receipt_core_hash {
        return Err("real-transport-r6-receipt-core-hash-mismatch");
    }
    validate_r6_approval_gate(&receipt, gate)?;
    validate_r6_runtime_and_lineage(&receipt, context)?;
    validate_r6_private_commitments(&receipt, context)?;
    validate_r6_ceremony_policy(&receipt)?;
    validate_r6_lifecycle(&receipt, &computed_receipt_core_hash, context)?;
    Ok(after_all_preflight(&receipt, &computed_receipt_core_hash))
}

#[allow(dead_code)]
fn dispatch_r6_execution_preflight<T, F>(
    raw_receipt_json: &str,
    claimed_receipt_core_hash: &str,
    context: R6DispatchContext<'_>,
    after_all_preflight: F,
) -> Result<T, &'static str>
where
    F: FnOnce(&R6WriteGradeReceipt, &str) -> T,
{
    dispatch_r6_execution_preflight_with_gate(
        raw_receipt_json,
        claimed_receipt_core_hash,
        context,
        R6ApprovalGateConfig::production(),
        after_all_preflight,
    )
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - if month <= 2 { 1 } else { 0 };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) as i64)
}

fn parse_utc_seconds(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'Z'
    {
        return None;
    }
    let year = value[0..4].parse::<i32>().ok()?;
    let month = value[5..7].parse::<u32>().ok()?;
    let day = value[8..10].parse::<u32>().ok()?;
    let hour = value[11..13].parse::<i64>().ok()?;
    let minute = value[14..16].parse::<i64>().ok()?;
    let second = value[17..19].parse::<i64>().ok()?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(days_from_civil(year, month, day)? * 86_400 + hour * 3_600 + minute * 60 + second)
}

#[derive(Clone, Debug, Default)]
struct FirstWriteLoopbackResponse {
    status: u16,
    body: Vec<u8>,
    redirected: bool,
    timeout_after_send: bool,
    network_failed: bool,
}

trait FirstWriteLoopbackClient {
    fn propfind_absence(&self) -> FirstWriteLoopbackResponse;
    fn put_create_first(&self, payload: &[u8]) -> FirstWriteLoopbackResponse;
    fn put_create_second(&self, payload: &[u8]) -> FirstWriteLoopbackResponse;
    fn get_readback(&self) -> FirstWriteLoopbackResponse;
}

struct FirstWriteLiveTarget {
    endpoint_url_private: String,
    remote_root_path_private: String,
    auth_header_private: String,
    path_class_ref_hash: String,
}

trait FirstWriteLiveClient {
    fn propfind_absence(&self, target: &FirstWriteLiveTarget) -> FirstWriteLoopbackResponse;
    fn put_create_first(
        &self,
        target: &FirstWriteLiveTarget,
        payload: &[u8],
    ) -> FirstWriteLoopbackResponse;
    fn put_create_second(
        &self,
        target: &FirstWriteLiveTarget,
        payload: &[u8],
    ) -> FirstWriteLoopbackResponse;
    fn get_readback(&self, target: &FirstWriteLiveTarget) -> FirstWriteLoopbackResponse;
}

trait WriteGradeReadOnlyPropfindClient {
    fn propfind_parent_readiness(
        &self,
        target: &FirstWriteLiveTarget,
    ) -> FirstWriteLoopbackResponse;
}

enum FirstWriteLiveOperation {
    PropfindAbsence,
    PutCreateFirst,
    PutCreateSecond,
    GetReadback,
}

impl FirstWriteLiveOperation {
    fn method(&self) -> &'static str {
        match self {
            Self::PropfindAbsence => "PROPFIND",
            Self::PutCreateFirst | Self::PutCreateSecond => "PUT",
            Self::GetReadback => "GET",
        }
    }

    fn sends_propfind_body(&self) -> bool {
        matches!(self, Self::PropfindAbsence)
    }

    fn sends_create_only_payload(&self) -> bool {
        matches!(self, Self::PutCreateFirst | Self::PutCreateSecond)
    }
}

struct ReqwestFirstWriteLiveClient;

impl ReqwestFirstWriteLiveClient {
    fn build_parent_collection_url(
        target: &FirstWriteLiveTarget,
    ) -> Result<reqwest::Url, ResolverFailure> {
        ReqwestReadOnlyProbeClient::build_target_url(
            &target.endpoint_url_private,
            &target.remote_root_path_private,
            false,
        )
    }

    fn build_target_url(target: &FirstWriteLiveTarget) -> Result<reqwest::Url, ResolverFailure> {
        let mut url = Self::build_parent_collection_url(target)?;
        let hash_suffix = target
            .path_class_ref_hash
            .strip_prefix("sha256:")
            .unwrap_or(&target.path_class_ref_hash)
            .chars()
            .filter(|value| value.is_ascii_hexdigit())
            .take(16)
            .collect::<String>();
        if hash_suffix.len() != 16 {
            return Err(ResolverFailure::LiveUrlInvalid);
        }
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| ResolverFailure::LiveUrlInvalid)?;
            segments.pop_if_empty();
            segments.push(".h2o-w3-sacrificial-probe");
            segments.push(&format!("{hash_suffix}.sentinel"));
        }
        Ok(url)
    }

    fn send(
        &self,
        target: &FirstWriteLiveTarget,
        operation: FirstWriteLiveOperation,
        payload: Option<&[u8]>,
    ) -> FirstWriteLoopbackResponse {
        let url = match operation {
            FirstWriteLiveOperation::PropfindAbsence => Self::build_parent_collection_url(target),
            FirstWriteLiveOperation::PutCreateFirst
            | FirstWriteLiveOperation::PutCreateSecond
            | FirstWriteLiveOperation::GetReadback => Self::build_target_url(target),
        };
        let Ok(url) = url else {
            return FirstWriteLoopbackResponse {
                network_failed: true,
                ..Default::default()
            };
        };
        let Ok(client) = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(READONLY_TIMEOUT_SECONDS))
            .build()
        else {
            return FirstWriteLoopbackResponse {
                network_failed: true,
                ..Default::default()
            };
        };
        let Ok(method) = reqwest::Method::from_bytes(operation.method().as_bytes()) else {
            return FirstWriteLoopbackResponse {
                network_failed: true,
                ..Default::default()
            };
        };
        let mut builder = client
            .request(method, url)
            .header("Authorization", target.auth_header_private.clone())
            .header(reqwest::header::CACHE_CONTROL, "no-cache");
        if operation.sends_propfind_body() {
            builder = builder
                .header("Depth", "0")
                .header(reqwest::header::ACCEPT, WEBDAV_XML_ACCEPT)
                .header(reqwest::header::CONTENT_TYPE, WEBDAV_XML_CONTENT_TYPE)
                .body(WEBDAV_PROPFIND_BODY.to_string());
        } else if operation.sends_create_only_payload() {
            builder = builder
                .header(reqwest::header::IF_NONE_MATCH, "*")
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(payload.unwrap_or_default().to_vec());
        }
        let response = builder.send();
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                return FirstWriteLoopbackResponse {
                    timeout_after_send: operation.sends_create_only_payload() && error.is_timeout(),
                    network_failed: true,
                    ..Default::default()
                };
            }
        };
        let status = response.status();
        let redirected = status.is_redirection();
        let mut body = Vec::new();
        if matches!(operation, FirstWriteLiveOperation::GetReadback) {
            if response
                .by_ref()
                .take((MAX_READONLY_RESPONSE_BYTES + 1) as u64)
                .read_to_end(&mut body)
                .is_err()
                || body.len() > MAX_READONLY_RESPONSE_BYTES
            {
                return FirstWriteLoopbackResponse {
                    status: status.as_u16(),
                    redirected,
                    network_failed: true,
                    ..Default::default()
                };
            }
        }
        FirstWriteLoopbackResponse {
            status: status.as_u16(),
            body,
            redirected,
            ..Default::default()
        }
    }
}

impl WriteGradeReadOnlyPropfindClient for ReqwestFirstWriteLiveClient {
    fn propfind_parent_readiness(
        &self,
        target: &FirstWriteLiveTarget,
    ) -> FirstWriteLoopbackResponse {
        self.send(target, FirstWriteLiveOperation::PropfindAbsence, None)
    }
}

impl FirstWriteLiveClient for ReqwestFirstWriteLiveClient {
    fn propfind_absence(&self, target: &FirstWriteLiveTarget) -> FirstWriteLoopbackResponse {
        self.propfind_parent_readiness(target)
    }

    fn put_create_first(
        &self,
        target: &FirstWriteLiveTarget,
        payload: &[u8],
    ) -> FirstWriteLoopbackResponse {
        self.send(
            target,
            FirstWriteLiveOperation::PutCreateFirst,
            Some(payload),
        )
    }

    fn put_create_second(
        &self,
        target: &FirstWriteLiveTarget,
        payload: &[u8],
    ) -> FirstWriteLoopbackResponse {
        self.send(
            target,
            FirstWriteLiveOperation::PutCreateSecond,
            Some(payload),
        )
    }

    fn get_readback(&self, target: &FirstWriteLiveTarget) -> FirstWriteLoopbackResponse {
        self.send(target, FirstWriteLiveOperation::GetReadback, None)
    }
}

#[derive(Default)]
struct DefaultFirstWriteLoopbackClient;

impl FirstWriteLoopbackClient for DefaultFirstWriteLoopbackClient {
    fn propfind_absence(&self) -> FirstWriteLoopbackResponse {
        FirstWriteLoopbackResponse {
            status: 404,
            ..Default::default()
        }
    }

    fn put_create_first(&self, _payload: &[u8]) -> FirstWriteLoopbackResponse {
        FirstWriteLoopbackResponse {
            status: 201,
            ..Default::default()
        }
    }

    fn put_create_second(&self, _payload: &[u8]) -> FirstWriteLoopbackResponse {
        FirstWriteLoopbackResponse {
            status: 412,
            ..Default::default()
        }
    }

    fn get_readback(&self) -> FirstWriteLoopbackResponse {
        FirstWriteLoopbackResponse {
            status: 200,
            body: FIRST_WRITE_DETERMINISTIC_SENTINEL_PAYLOAD
                .as_bytes()
                .to_vec(),
            ..Default::default()
        }
    }
}

fn push_status(
    statuses: &mut Vec<RtFirstWriteMethodStatus>,
    operation: &'static str,
    response: &FirstWriteLoopbackResponse,
    loopback_only: bool,
) {
    statuses.push(RtFirstWriteMethodStatus {
        operation,
        status_code: response.status,
        status_family: status_family(response.status),
        loopback_only,
    });
}

fn first_write_response_blocker(response: &FirstWriteLoopbackResponse) -> Option<&'static str> {
    if response.timeout_after_send {
        return Some("real-transport-w3-first-write-remote-write-uncertain");
    }
    if response.network_failed {
        return Some("real-transport-w3-first-write-network-failed");
    }
    if response.redirected || (300..400).contains(&response.status) {
        return Some("real-transport-w3-first-write-redirect-refused");
    }
    if response.status == 401 || response.status == 403 {
        return Some("real-transport-w3-first-write-auth-refused");
    }
    None
}

fn validate_write_grade_receipt(
    request: &RtFirstWriteRequest,
    blockers: &mut Vec<&'static str>,
) -> Option<FirstWriteMode> {
    if request.schema.as_deref() != Some(FIRST_WRITE_REQUEST_SCHEMA) {
        blockers.push("real-transport-w3-first-write-request-schema-required");
    }
    let mode = if request.mock_only == Some(true) && request.loopback_mock == Some(true) {
        if request.gate.as_deref() != Some(FIRST_WRITE_GATE) {
            blockers.push("real-transport-w3-first-write-gate-required");
        }
        Some(FirstWriteMode::LoopbackMock)
    } else if request.live_webdav_invocation == Some(true)
        && request.mock_only == Some(false)
        && request.loopback_mock != Some(true)
    {
        if request.gate.as_deref() != Some(FIRST_WRITE_LIVE_GATE) {
            blockers.push("real-transport-w3-first-write-live-gate-required");
        }
        Some(FirstWriteMode::LiveWebDav)
    } else {
        blockers.push("real-transport-w3-first-write-loopback-mock-required");
        None
    };
    if request.product_sync_ready == Some(true)
        || request.transport_ready == Some(true)
        || request.writes_webdav == Some(true)
        || request.writes_cloud == Some(true)
        || request.writes_relay == Some(true)
        || request.writes_cas == Some(true)
        || request.writes_files == Some(true)
        || request.enqueues_relay == Some(true)
        || request.full_bundle_v3_started == Some(true)
        || request.mints_export_id == Some(true)
        || request.burns_sequence == Some(true)
    {
        blockers.push("real-transport-w3-first-write-readiness-or-write-claim-rejected");
    }
    if !request.extra.is_empty() {
        blockers.push("real-transport-w3-first-write-unknown-field-rejected");
    }

    let approval_hash = request.approval_artifact_hash.as_ref();
    if !is_hash_ref(&request.approval_artifact_hash) {
        blockers.push("real-transport-w3-write-grade-approval-missing");
    }

    let Some(receipt) = request.write_grade_receipt.as_ref() else {
        blockers.push("real-transport-w3-write-grade-receipt-missing");
        return mode;
    };
    if receipt.schema.as_deref() != Some(WRITE_GRADE_RECEIPT_SCHEMA) {
        blockers.push("real-transport-w3-write-grade-receipt-schema-invalid");
    }
    if receipt.canonicalization.as_deref() != Some(WRITE_GRADE_RECEIPT_CANONICALIZATION) {
        blockers.push("real-transport-w3-write-grade-receipt-canonicalization-invalid");
    }
    match receipt.receipt_grade.as_deref() {
        Some("write-grade") => {}
        Some("fixture") | Some("mock-grade") | Some("fixture/mock-grade") => {
            blockers.push("real-transport-w3-fixture-mock-grade-receipt-rejected");
        }
        _ => blockers.push("real-transport-w3-write-grade-receipt-grade-invalid"),
    }
    if receipt.operation_kind.as_deref() != Some(FIRST_WRITE_OPERATION_KIND) {
        blockers.push("real-transport-w3-first-write-operation-kind-invalid");
    }
    if receipt.payload_kind.as_deref() != Some(FIRST_WRITE_PAYLOAD_KIND) {
        blockers.push("real-transport-w3-first-write-payload-kind-invalid");
    }
    if receipt.payload_count != Some(1) || receipt.max_invocations != Some(1) {
        blockers.push("real-transport-w3-first-write-single-invocation-required");
    }
    let budget = receipt.request_budget.as_ref();
    if budget.and_then(|value| value.create_only_put_max) != Some(2)
        || budget.and_then(|value| value.readback_get_max) != Some(1)
        || budget.and_then(|value| value.other_methods) != Some(0)
    {
        blockers.push("real-transport-w3-first-write-request-budget-invalid");
    }
    let object = receipt.sacrificial_object.as_ref();
    if !is_hash_ref(&object.and_then(|value| value.path_class_ref_hash.clone())) {
        blockers.push("real-transport-w3-first-write-path-class-hash-required");
    }
    if object
        .and_then(|value| value.payload_byte_max)
        .unwrap_or(usize::MAX)
        > 256
        || request.payload_byte_max.unwrap_or(usize::MAX) > 256
    {
        blockers.push("real-transport-w3-first-write-payload-too-large");
    }

    let payload = request.payload.as_deref().unwrap_or("");
    if payload.is_empty() || payload.as_bytes().len() > 256 {
        blockers.push("real-transport-w3-first-write-payload-too-large");
    }
    let payload_hash = Some(sha256_ref(payload.as_bytes()));
    if request.payload_hash != payload_hash
        || object.and_then(|value| value.payload_hash.clone()) != payload_hash
    {
        blockers.push("real-transport-w3-first-write-payload-hash-mismatch");
    }

    let bindings = receipt.bindings.as_ref();
    if !is_hash_ref(&bindings.and_then(|value| value.endpoint_ref_hash.clone()))
        || !is_hash_ref(&bindings.and_then(|value| value.remote_root_ref_hash.clone()))
        || !is_hash_ref(&bindings.and_then(|value| value.credential_ref_hash.clone()))
    {
        blockers.push("real-transport-w3-first-write-descriptor-bindings-required");
    }
    if request.write_grade_registry_ref_hash
        != bindings.and_then(|value| value.write_grade_registry_ref_hash.clone())
        || !is_hash_ref(&request.write_grade_registry_ref_hash)
    {
        blockers.push("real-transport-w3-write-grade-registry-ref-hash-mismatch");
    }
    if bindings.and_then(|value| value.write_grade_registry_hash_boundary.as_deref())
        != Some(WRITE_GRADE_REGISTRY_HASH_BOUNDARY)
    {
        blockers.push("real-transport-w3-write-grade-registry-hash-boundary-mismatch");
    }
    if request.registry_path_source.as_deref() == Some("default-private-legacy")
        || request.registry_path_source.as_deref() == Some("invalid")
        || !matches!(
            request.registry_path_source.as_deref(),
            Some("app-local") | Some("env")
        )
    {
        blockers.push("real-transport-w3-write-grade-registry-source-refused");
    }
    if request.write_grade_registry_eligible != Some(true)
        || request.registry_owner_ok != Some(true)
        || request.registry_permission_ok != Some(true)
    {
        blockers.push("real-transport-w3-write-grade-registry-owner-permission-refused");
    }
    let legacy_approval_binding_ok = bindings
        .and_then(|value| value.w34b1_operator_approval_commit.as_deref())
        == Some(W34B1_OPERATOR_APPROVAL_COMMIT);
    let renewed_approval_binding_ok = bindings
        .and_then(|value| value.w34b1_r2_renewed_operator_approval_commit.as_deref())
        == Some(W34B1_R2_RENEWED_OPERATOR_APPROVAL_COMMIT)
        && bindings
            .and_then(|value| value.w34b1_expired_operator_approval_commit.as_deref())
            .map(|value| value == W34B1_OPERATOR_APPROVAL_COMMIT)
            .unwrap_or(true);
    let optional_missing_token_binding_ok = bindings
        .and_then(|value| value.w34b3_blocked_missing_token_commit.as_deref())
        .map(|value| value == W34B3B_MISSING_TOKEN_COMMIT)
        .unwrap_or(true);
    let optional_r3a_diagnostic_binding_ok = bindings
        .and_then(|value| value.w34b3_r3_binding_mismatch_diagnostic_commit.as_deref())
        .map(|value| value == W34B3_R3A_BINDING_MISMATCH_DIAGNOSTIC_COMMIT)
        .unwrap_or(true);
    let optional_r4_closeout_binding_ok = bindings
        .and_then(|value| value.w34b3_r4_no_write_closeout_commit.as_deref())
        .map(|value| value == W34B3_R4_NO_WRITE_CLOSEOUT_COMMIT)
        .unwrap_or(true);
    let optional_w35b_parent_propfind_binding_ok = bindings
        .and_then(|value| value.w35b_parent_propfind_fix_commit.as_deref())
        .map(|value| value == W35B_PARENT_PROPFIND_FIX_COMMIT)
        .unwrap_or(true);
    if bindings.and_then(|value| value.w31_closeout_commit.as_deref()) != Some(W31_CLOSEOUT_COMMIT)
        || bindings.and_then(|value| value.w31_alignment_commit.as_deref())
            != Some(W31_ALIGNMENT_COMMIT)
        || bindings.and_then(|value| value.w32_mock_proof_commit.as_deref())
            != Some(W32_MOCK_PROOF_COMMIT)
        || bindings.and_then(|value| value.w33a_design_commit.as_deref())
            != Some(W33A_DESIGN_COMMIT)
        || bindings.and_then(|value| value.w33b_registry_hardening_commit.as_deref())
            != Some(W33B_STORAGE_COMMIT)
        || bindings.and_then(|value| value.w33c_hash_boundary_commit.as_deref())
            != Some(W33C_HASH_BOUNDARY_COMMIT)
        || bindings.and_then(|value| value.w34a_refused_command_commit.as_deref())
            != Some(W34A_REFUSED_COMMAND_COMMIT)
        || bindings.and_then(|value| value.w34b0_approval_package_commit.as_deref())
            != Some(W34B0_APPROVAL_PACKAGE_COMMIT)
        || !(legacy_approval_binding_ok || renewed_approval_binding_ok)
        || !optional_missing_token_binding_ok
        || !optional_r3a_diagnostic_binding_ok
        || !optional_r4_closeout_binding_ok
        || !optional_w35b_parent_propfind_binding_ok
    {
        blockers.push("real-transport-w3-first-write-commit-binding-mismatch");
    }
    if bindings.and_then(|value| value.operator_approval_artifact_hash.clone())
        != approval_hash.cloned()
    {
        blockers.push("real-transport-w3-write-grade-approval-hash-mismatch");
    }
    if !token_hash_matches(&request.one_shot_token, &request.one_shot_token_hash)
        || bindings.and_then(|value| value.one_shot_token_hash.clone())
            != request.one_shot_token_hash
    {
        blockers.push("real-transport-w3-one-shot-token-missing-or-mismatch");
    }
    if !token_hash_matches(&request.kill_switch_token, &request.kill_switch_token_hash)
        || bindings.and_then(|value| value.kill_switch_token_hash.clone())
            != request.kill_switch_token_hash
    {
        blockers.push("real-transport-w3-kill-switch-token-missing-or-mismatch");
    }
    if request.kill_switch_enabled != Some(true) || request.kill_switch_fresh != Some(true) {
        blockers.push("real-transport-w3-kill-switch-disabled-or-stale");
    }

    let Some(invocation_utc) = request
        .invocation_utc
        .as_deref()
        .and_then(parse_utc_seconds)
    else {
        blockers.push("real-transport-w3-first-write-invocation-time-invalid");
        return mode;
    };
    let Some(mint_utc) = receipt.mint_utc.as_deref().and_then(parse_utc_seconds) else {
        blockers.push("real-transport-w3-write-grade-receipt-time-invalid");
        return mode;
    };
    let Some(expiry_utc) = receipt.expiry_utc.as_deref().and_then(parse_utc_seconds) else {
        blockers.push("real-transport-w3-write-grade-receipt-time-invalid");
        return mode;
    };
    if mint_utc > invocation_utc {
        blockers.push("real-transport-w3-write-grade-receipt-future-mint-refused");
    }
    if invocation_utc > expiry_utc {
        blockers.push("real-transport-w3-write-grade-receipt-expired");
    }
    if expiry_utc - mint_utc > WRITE_GRADE_MAX_RECEIPT_AGE_SECONDS {
        blockers.push("real-transport-w3-write-grade-receipt-expiry-window-too-large");
    }
    if invocation_utc - mint_utc > FIRST_WRITE_RECOMMENDED_AGE_SECONDS {
        blockers.push("real-transport-w3-first-write-receipt-age-exceeds-72h");
    }
    if mode == Some(FirstWriteMode::LiveWebDav) {
        if !is_hash_ref(&request.receipt_core_hash) {
            blockers.push("real-transport-w3-write-grade-receipt-core-hash-required");
        } else if write_grade_receipt_core_hash(receipt) != request.receipt_core_hash {
            blockers.push("real-transport-w3-write-grade-receipt-core-hash-mismatch");
        }
        let Some(approval_expiry_utc) = request
            .approval_expiry_utc
            .as_deref()
            .and_then(parse_utc_seconds)
        else {
            blockers.push("real-transport-w3-write-grade-approval-expiry-required");
            return mode;
        };
        if expiry_utc > approval_expiry_utc {
            blockers.push("real-transport-w3-write-grade-receipt-exceeds-approval-expiry");
        }
    }
    mode
}

pub(crate) struct ResolvedWriteGradeLiveRegistry {
    path_info: DescriptorRegistryPathInfo,
    status: RtWebDavSetupStatusResult,
    pub(crate) registry: DescriptorRegistry,
}

pub(crate) fn resolve_write_grade_live_registry(
    command: &'static str,
) -> Result<ResolvedWriteGradeLiveRegistry, &'static str> {
    let path_info = descriptor_registry_path_for_setup_status();
    let bytes =
        fs::read(&path_info.path).map_err(|_| "real-transport-w3-write-grade-registry-missing")?;
    let status = status_from_registry_bytes(command, &bytes, &path_info);
    if !write_grade_registry_source_candidate(status.registry_path_source) {
        return Err("real-transport-w3-write-grade-registry-source-refused");
    }
    if !status.write_grade_registry_eligible
        || !status.registry_owner_ok
        || !status.registry_permission_ok
    {
        return Err("real-transport-w3-write-grade-registry-owner-permission-refused");
    }
    if !status.credential_material_present {
        return Err("real-transport-w3-first-write-credential-material-missing");
    }
    let registry = serde_json::from_slice::<DescriptorRegistry>(&bytes)
        .map_err(|_| "real-transport-w3-write-grade-registry-invalid")?;
    if registry
        .endpoint_url_private
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
        || registry
            .remote_root_path_private
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        || registry
            .auth_header_private
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err("real-transport-w3-first-write-private-registry-fields-missing");
    }
    Ok(ResolvedWriteGradeLiveRegistry {
        path_info,
        status,
        registry,
    })
}

fn resolve_first_write_live_registry(
    request: &RtFirstWriteRequest,
) -> Result<DescriptorRegistry, &'static str> {
    let resolved = resolve_write_grade_live_registry("h2o_rt_first_write")?;
    if resolved.status.registry_path_source != request.registry_path_source.as_deref().unwrap_or("")
    {
        return Err("real-transport-w3-write-grade-registry-source-refused");
    }
    if resolved.status.write_grade_registry_ref_hash != request.write_grade_registry_ref_hash {
        return Err("real-transport-w3-write-grade-registry-ref-hash-mismatch");
    }
    let registry = resolved.registry;
    let Some(bindings) = request
        .write_grade_receipt
        .as_ref()
        .and_then(|receipt| receipt.bindings.as_ref())
    else {
        return Err("real-transport-w3-write-grade-receipt-missing");
    };
    if Some(registry.endpoint_ref_hash.clone()) != bindings.endpoint_ref_hash
        || Some(registry.remote_root_ref_hash.clone()) != bindings.remote_root_ref_hash
        || Some(registry.credential_ref_hash.clone()) != bindings.credential_ref_hash
    {
        return Err("real-transport-w3-first-write-descriptor-bindings-required");
    }
    Ok(registry)
}

struct WriteGradeReadOnlyRegistryParity {
    normal_probe_registry_path_source: &'static str,
    write_grade_registry_path_source: &'static str,
    registry_selection_equivalent: bool,
    endpoint_material_equivalent: bool,
    remote_root_material_equivalent: bool,
    credential_material_equivalent: bool,
    write_grade_registry_eligible: bool,
    credential_material_present: bool,
    target: FirstWriteLiveTarget,
}

fn resolve_write_grade_read_only_registry_parity(
) -> Result<WriteGradeReadOnlyRegistryParity, &'static str> {
    let normal_path_info = descriptor_registry_path_for_probe(&RtCapabilityProbeRequest {
        descriptor_registry_ref_hash: Some(sha256_ref(b"registry-selection-only")),
        ..Default::default()
    });
    let normal_registry = normal_path_info.as_ref().and_then(|path_info| {
        fs::read(&path_info.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<DescriptorRegistry>(&bytes).ok())
    });
    let resolved = resolve_write_grade_live_registry("h2o_rt_write_grade_read_only_probe")?;
    let registry_selection_equivalent = normal_path_info
        .as_ref()
        .map(|normal| normal.path == resolved.path_info.path)
        .unwrap_or(false);
    let endpoint_material_equivalent = normal_registry
        .as_ref()
        .map(|normal| normal.endpoint_url_private == resolved.registry.endpoint_url_private)
        .unwrap_or(false);
    let remote_root_material_equivalent = normal_registry
        .as_ref()
        .map(|normal| normal.remote_root_path_private == resolved.registry.remote_root_path_private)
        .unwrap_or(false);
    let credential_material_equivalent = normal_registry
        .as_ref()
        .map(|normal| normal.auth_header_private == resolved.registry.auth_header_private)
        .unwrap_or(false);

    Ok(WriteGradeReadOnlyRegistryParity {
        normal_probe_registry_path_source: normal_path_info
            .as_ref()
            .map(|info| info.source)
            .unwrap_or("invalid"),
        write_grade_registry_path_source: resolved.path_info.source,
        registry_selection_equivalent,
        endpoint_material_equivalent,
        remote_root_material_equivalent,
        credential_material_equivalent,
        write_grade_registry_eligible: resolved.status.write_grade_registry_eligible,
        credential_material_present: resolved.status.credential_material_present,
        target: FirstWriteLiveTarget {
            endpoint_url_private: resolved.registry.endpoint_url_private.unwrap_or_default(),
            remote_root_path_private: resolved
                .registry
                .remote_root_path_private
                .unwrap_or_default(),
            auth_header_private: resolved.registry.auth_header_private.unwrap_or_default(),
            path_class_ref_hash: String::new(),
        },
    })
}

fn evaluate_write_grade_read_only_probe_with_client<C: WriteGradeReadOnlyPropfindClient>(
    parity: Result<WriteGradeReadOnlyRegistryParity, &'static str>,
    client: &C,
) -> RtWriteGradeReadOnlyProbeResult {
    let parity = match parity {
        Ok(parity) => parity,
        Err(blocker) => return RtWriteGradeReadOnlyProbeResult::base(blocker, vec![blocker]),
    };
    let mut result = RtWriteGradeReadOnlyProbeResult::base(
        "real-transport-w3-write-grade-read-only-probe-not-run",
        vec![],
    );
    result.normal_probe_registry_path_source = parity.normal_probe_registry_path_source;
    result.write_grade_registry_path_source = parity.write_grade_registry_path_source;
    result.registry_selection_equivalent = parity.registry_selection_equivalent;
    result.endpoint_material_equivalent = parity.endpoint_material_equivalent;
    result.remote_root_material_equivalent = parity.remote_root_material_equivalent;
    result.credential_material_equivalent = parity.credential_material_equivalent;
    result.write_grade_registry_eligible = parity.write_grade_registry_eligible;
    result.credential_material_present = parity.credential_material_present;

    let response = client.propfind_parent_readiness(&parity.target);
    result.network_attempted = true;
    push_status(
        &mut result.method_statuses,
        "PROPFIND write-grade parent readiness diagnostic",
        &response,
        false,
    );
    if response.redirected {
        result.reason = "real-transport-w3-write-grade-read-only-probe-redirect-refused";
        result.likely_cause = "redirect-or-target-normalization";
        result.blockers.push(result.reason);
    } else if response.network_failed {
        result.reason = "real-transport-w3-write-grade-read-only-probe-network-failed";
        result.likely_cause = "network-failure-no-status";
        result.blockers.push(result.reason);
    } else if response.status == 207 {
        result.ok = true;
        result.status = "real-transport-w3-write-grade-read-only-probe-passed";
        result.reason = "real-transport-w3-write-grade-read-only-propfind-207";
        result.write_grade_read_only_probe_passed = true;
        result.likely_cause = "runtime-provenance-or-prior-stale-binary";
    } else if response.status == 401 {
        result.reason = "real-transport-w3-write-grade-read-only-probe-auth-refused";
        result.likely_cause = "app-local-credential-or-registry-material";
        result.blockers.push(result.reason);
    } else {
        result.reason = "real-transport-w3-write-grade-read-only-probe-unexpected-status";
        result.likely_cause = "unsupported-status-no-further-interpretation";
        result.blockers.push(result.reason);
    }
    result
}

pub fn evaluate_write_grade_read_only_probe() -> RtWriteGradeReadOnlyProbeResult {
    evaluate_write_grade_read_only_probe_with_client(
        resolve_write_grade_read_only_registry_parity(),
        &ReqwestFirstWriteLiveClient,
    )
}

fn first_write_consumed_marker_path(receipt_hash: &str) -> Option<PathBuf> {
    let path_info = descriptor_registry_path_for_setup_status();
    let parent = path_info.path.parent()?;
    let hash = receipt_hash.strip_prefix("sha256:")?;
    if hash.len() != 64 || !hash.chars().all(|value| value.is_ascii_hexdigit()) {
        return None;
    }
    Some(
        parent
            .join("first-write-consumed")
            .join(format!("{hash}.json")),
    )
}

fn write_first_write_apply_intent_marker(
    receipt_hash: &str,
    invocation_utc: &str,
) -> Result<(), &'static str> {
    let Some(path) = first_write_consumed_marker_path(receipt_hash) else {
        return Err("real-transport-w3-first-write-consumed-marker-path-invalid");
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|_| "real-transport-w3-first-write-consumed-marker-write-failed")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    let body = format!(
        "{{\"schema\":\"h2o.sync.real-transport.first-write-consumed-marker.v1\",\"receiptCoreHash\":\"{}\",\"invocationUtc\":\"{}\",\"networkAttempted\":false}}\n",
        receipt_hash, invocation_utc
    );
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "real-transport-w3-first-write-receipt-already-consumed")?;
    file.write_all(body.as_bytes())
        .map_err(|_| "real-transport-w3-first-write-consumed-marker-write-failed")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn evaluate_first_write_with_client<C: FirstWriteLoopbackClient>(
    request: Option<RtFirstWriteRequest>,
    client: &C,
) -> RtFirstWriteResult {
    let Some(request) = request else {
        return RtFirstWriteResult::blocked(
            "real-transport-w3-write-grade-approval-missing",
            vec!["real-transport-w3-write-grade-approval-missing"],
        );
    };

    let mut blockers = Vec::new();
    let mode = validate_write_grade_receipt(&request, &mut blockers);
    if mode != Some(FirstWriteMode::LoopbackMock) {
        blockers.push("real-transport-w3-first-write-loopback-mock-required");
    }
    if !blockers.is_empty() {
        return RtFirstWriteResult::blocked(blockers[0], blockers);
    }

    let payload = request.payload.as_deref().unwrap_or("").as_bytes().to_vec();
    let mut method_statuses = Vec::new();

    let propfind = client.propfind_absence();
    push_status(
        &mut method_statuses,
        "PROPFIND pre-write absence check",
        &propfind,
        true,
    );
    if let Some(blocker) = first_write_response_blocker(&propfind) {
        return RtFirstWriteResult {
            reason: blocker,
            blockers: vec![blocker],
            method_statuses,
            loopback_attempted: true,
            ..RtFirstWriteResult::blocked(blocker, vec![blocker])
        };
    }
    if propfind.status != 404 {
        let blocker = "real-transport-w3-first-write-target-exists";
        return RtFirstWriteResult {
            reason: blocker,
            blockers: vec![blocker],
            method_statuses,
            loopback_attempted: true,
            ..RtFirstWriteResult::blocked(blocker, vec![blocker])
        };
    }

    let first_put = client.put_create_first(&payload);
    push_status(&mut method_statuses, "PUT create-only #1", &first_put, true);
    if let Some(blocker) = first_write_response_blocker(&first_put) {
        return RtFirstWriteResult {
            reason: blocker,
            blockers: vec![blocker],
            method_statuses,
            loopback_attempted: true,
            ..RtFirstWriteResult::blocked(blocker, vec![blocker])
        };
    }
    if first_put.status != 201 {
        let blocker = "real-transport-w3-first-write-put1-unexpected-status";
        return RtFirstWriteResult {
            reason: blocker,
            blockers: vec![blocker],
            method_statuses,
            loopback_attempted: true,
            ..RtFirstWriteResult::blocked(blocker, vec![blocker])
        };
    }

    let second_put = client.put_create_second(&payload);
    push_status(
        &mut method_statuses,
        "PUT create-only #2",
        &second_put,
        true,
    );
    if let Some(blocker) = first_write_response_blocker(&second_put) {
        return RtFirstWriteResult {
            reason: blocker,
            blockers: vec![blocker],
            method_statuses,
            loopback_attempted: true,
            ..RtFirstWriteResult::blocked(blocker, vec![blocker])
        };
    }
    if (200..300).contains(&second_put.status) {
        let blocker = "real-transport-w3-first-write-create-only-not-enforced";
        return RtFirstWriteResult {
            reason: blocker,
            blockers: vec![blocker],
            method_statuses,
            loopback_attempted: true,
            ..RtFirstWriteResult::blocked(blocker, vec![blocker])
        };
    }
    if second_put.status != 412 {
        let blocker = "real-transport-w3-first-write-put2-unexpected-status";
        return RtFirstWriteResult {
            reason: blocker,
            blockers: vec![blocker],
            method_statuses,
            loopback_attempted: true,
            ..RtFirstWriteResult::blocked(blocker, vec![blocker])
        };
    }

    let readback = client.get_readback();
    push_status(&mut method_statuses, "GET read-back", &readback, true);
    if let Some(blocker) = first_write_response_blocker(&readback) {
        return RtFirstWriteResult {
            reason: blocker,
            blockers: vec![blocker],
            method_statuses,
            loopback_attempted: true,
            ..RtFirstWriteResult::blocked(blocker, vec![blocker])
        };
    }
    if readback.status != 200
        || sha256_ref(&readback.body) != request.payload_hash.clone().unwrap_or_default()
    {
        let blocker = "real-transport-w3-first-write-readback-hash-mismatch";
        return RtFirstWriteResult {
            reason: blocker,
            blockers: vec![blocker],
            method_statuses,
            loopback_attempted: true,
            ..RtFirstWriteResult::blocked(blocker, vec![blocker])
        };
    }

    RtFirstWriteResult {
        schema: "h2o.studio.transport.first-write-result.v1",
        ok: true,
        status: "real-transport-w3-first-write-loopback-passed",
        reason: "real-transport-w3-first-write-loopback-only-proof",
        command: "h2o_rt_first_write",
        mock_only: true,
        gate_satisfied: true,
        network_attempted: false,
        loopback_attempted: true,
        write_grade_registry_ref_hash: request.write_grade_registry_ref_hash,
        create_only_behavior: "loopback-201-then-412",
        method_statuses,
        writes_webdav: false,
        writes_cloud: false,
        writes_relay: false,
        writes_cas: false,
        writes_files: false,
        enqueues_relay: false,
        full_bundle_v3_started: false,
        mints_export_id: false,
        burns_sequence: false,
        product_sync_ready: false,
        transport_ready: false,
        raw_private_fields_logged: false,
        blockers: vec![],
        warnings: vec!["loopback-mock-only-no-real-webdav-write"],
    }
}

fn first_write_live_blocked(
    reason: &'static str,
    blockers: Vec<&'static str>,
    write_grade_registry_ref_hash: Option<String>,
    method_statuses: Vec<RtFirstWriteMethodStatus>,
    network_attempted: bool,
    writes_webdav: bool,
    create_only_behavior: &'static str,
) -> RtFirstWriteResult {
    RtFirstWriteResult {
        reason,
        blockers,
        write_grade_registry_ref_hash,
        method_statuses,
        network_attempted,
        mock_only: false,
        create_only_behavior,
        writes_webdav,
        warnings: vec!["live-first-write-failed-closed"],
        ..RtFirstWriteResult::blocked(reason, vec![reason])
    }
}

fn evaluate_first_write_live_with_client<C: FirstWriteLiveClient>(
    request: Option<RtFirstWriteRequest>,
    client: &C,
) -> RtFirstWriteResult {
    let Some(request) = request else {
        return RtFirstWriteResult::blocked(
            "real-transport-w3-write-grade-approval-missing",
            vec!["real-transport-w3-write-grade-approval-missing"],
        );
    };

    let mut blockers = Vec::new();
    let mode = validate_write_grade_receipt(&request, &mut blockers);
    if mode != Some(FirstWriteMode::LiveWebDav) {
        blockers.push("real-transport-w3-first-write-live-gate-required");
    }
    let registry = if blockers.is_empty() {
        match resolve_first_write_live_registry(&request) {
            Ok(registry) => Some(registry),
            Err(blocker) => {
                blockers.push(blocker);
                None
            }
        }
    } else {
        None
    };
    if !blockers.is_empty() {
        return RtFirstWriteResult::blocked(blockers[0], blockers);
    }

    let registry = registry.expect("registry checked when blockers are empty");
    let receipt = request
        .write_grade_receipt
        .as_ref()
        .expect("receipt checked when blockers are empty");
    let object = receipt
        .sacrificial_object
        .as_ref()
        .expect("object checked when blockers are empty");
    let payload = request
        .payload
        .as_deref()
        .expect("payload checked when blockers are empty")
        .as_bytes()
        .to_vec();
    let receipt_hash = request
        .receipt_core_hash
        .as_deref()
        .expect("receipt hash checked when blockers are empty");
    let invocation_utc = request
        .invocation_utc
        .as_deref()
        .expect("invocation time checked when blockers are empty");
    if let Err(blocker) = write_first_write_apply_intent_marker(receipt_hash, invocation_utc) {
        return RtFirstWriteResult::blocked(blocker, vec![blocker]);
    }

    let target = FirstWriteLiveTarget {
        endpoint_url_private: registry.endpoint_url_private.unwrap_or_default(),
        remote_root_path_private: registry.remote_root_path_private.unwrap_or_default(),
        auth_header_private: registry.auth_header_private.unwrap_or_default(),
        path_class_ref_hash: object.path_class_ref_hash.clone().unwrap_or_default(),
    };
    let mut method_statuses = Vec::new();

    let propfind = client.propfind_absence(&target);
    push_status(
        &mut method_statuses,
        "PROPFIND pre-write parent readiness check",
        &propfind,
        false,
    );
    if let Some(blocker) = first_write_response_blocker(&propfind) {
        return first_write_live_blocked(
            blocker,
            vec![blocker],
            request.write_grade_registry_ref_hash,
            method_statuses,
            true,
            false,
            "not-attempted",
        );
    }
    if !(200..300).contains(&propfind.status) {
        let blocker = "real-transport-w3-first-write-parent-not-ready";
        return first_write_live_blocked(
            blocker,
            vec![blocker],
            request.write_grade_registry_ref_hash,
            method_statuses,
            true,
            false,
            "not-attempted",
        );
    }

    let first_put = client.put_create_first(&target, &payload);
    push_status(
        &mut method_statuses,
        "PUT create-only #1",
        &first_put,
        false,
    );
    if let Some(blocker) = first_write_response_blocker(&first_put) {
        return first_write_live_blocked(
            blocker,
            vec![blocker],
            request.write_grade_registry_ref_hash,
            method_statuses,
            true,
            first_put.timeout_after_send,
            "not-attempted",
        );
    }
    if first_put.status != 201 {
        let blocker = "real-transport-w3-first-write-put1-unexpected-status";
        return first_write_live_blocked(
            blocker,
            vec![blocker],
            request.write_grade_registry_ref_hash,
            method_statuses,
            true,
            false,
            "not-attempted",
        );
    }

    let second_put = client.put_create_second(&target, &payload);
    push_status(
        &mut method_statuses,
        "PUT create-only #2",
        &second_put,
        false,
    );
    if let Some(blocker) = first_write_response_blocker(&second_put) {
        return first_write_live_blocked(
            blocker,
            vec![blocker],
            request.write_grade_registry_ref_hash,
            method_statuses,
            true,
            true,
            "live-put1-created",
        );
    }
    if (200..300).contains(&second_put.status) {
        let blocker = "real-transport-w3-first-write-create-only-not-enforced";
        return first_write_live_blocked(
            blocker,
            vec![blocker],
            request.write_grade_registry_ref_hash,
            method_statuses,
            true,
            true,
            "not-enforced",
        );
    }
    if second_put.status != 412 {
        let blocker = "real-transport-w3-first-write-put2-unexpected-status";
        return first_write_live_blocked(
            blocker,
            vec![blocker],
            request.write_grade_registry_ref_hash,
            method_statuses,
            true,
            true,
            "live-put1-created",
        );
    }

    let readback = client.get_readback(&target);
    push_status(&mut method_statuses, "GET read-back", &readback, false);
    if let Some(blocker) = first_write_response_blocker(&readback) {
        return first_write_live_blocked(
            blocker,
            vec![blocker],
            request.write_grade_registry_ref_hash,
            method_statuses,
            true,
            true,
            "live-201-then-412",
        );
    }
    if readback.status != 200
        || sha256_ref(&readback.body) != request.payload_hash.clone().unwrap_or_default()
    {
        let blocker = "real-transport-w3-first-write-readback-hash-mismatch";
        return first_write_live_blocked(
            blocker,
            vec![blocker],
            request.write_grade_registry_ref_hash,
            method_statuses,
            true,
            true,
            "live-201-then-412",
        );
    }

    RtFirstWriteResult {
        schema: "h2o.studio.transport.first-write-result.v1",
        ok: true,
        status: "real-transport-w3-first-write-live-passed",
        reason: "real-transport-w3-first-write-live-sacrificial-probe-complete",
        command: "h2o_rt_first_write",
        mock_only: false,
        gate_satisfied: true,
        network_attempted: true,
        loopback_attempted: false,
        write_grade_registry_ref_hash: request.write_grade_registry_ref_hash,
        create_only_behavior: "live-201-then-412",
        method_statuses,
        writes_webdav: true,
        writes_cloud: false,
        writes_relay: false,
        writes_cas: false,
        writes_files: false,
        enqueues_relay: false,
        full_bundle_v3_started: false,
        mints_export_id: false,
        burns_sequence: false,
        product_sync_ready: false,
        transport_ready: false,
        raw_private_fields_logged: false,
        blockers: vec![],
        warnings: vec!["live-sacrificial-webdav-write-only-no-cleanup-no-product-readiness"],
    }
}

pub fn evaluate_first_write(request: Option<RtFirstWriteRequest>) -> RtFirstWriteResult {
    if request
        .as_ref()
        .map(|request| request.live_webdav_invocation == Some(true))
        .unwrap_or(false)
    {
        evaluate_first_write_live_with_client(request, &ReqwestFirstWriteLiveClient)
    } else {
        evaluate_first_write_with_client(request, &DefaultFirstWriteLoopbackClient)
    }
}

#[tauri::command]
pub fn h2o_rt_capability_probe(
    request: RtCapabilityProbeRequest,
) -> Result<RtCapabilityProbeResult, String> {
    Ok(evaluate_capability_probe(request))
}

#[tauri::command]
pub fn h2o_rt_prepare_webdav_setup(
    request: RtWebDavSetupRequest,
) -> Result<RtWebDavSetupStatusResult, String> {
    Ok(prepare_webdav_setup(request))
}

#[tauri::command]
pub fn h2o_rt_webdav_setup_status() -> Result<RtWebDavSetupStatusResult, String> {
    Ok(webdav_setup_status())
}

#[tauri::command]
pub fn h2o_rt_webdav_setup_hydrate_form(
    request: RtWebDavSetupHydrateFormRequest,
) -> Result<RtWebDavSetupHydrateFormResult, String> {
    Ok(webdav_setup_hydrate_form(request))
}

#[tauri::command]
pub fn h2o_rt_write_grade_read_only_probe() -> Result<RtWriteGradeReadOnlyProbeResult, String> {
    Ok(evaluate_write_grade_read_only_probe())
}

#[tauri::command]
pub fn h2o_rt_first_write(
    request: Option<RtFirstWriteRequest>,
) -> Result<RtFirstWriteResult, String> {
    Ok(evaluate_first_write(request))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;

    fn h(d: char) -> String {
        format!("sha256:{}", d.to_string().repeat(64))
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static ENV_MUTEX: Mutex<()> = Mutex::new(());
        ENV_MUTEX.lock().expect("resolver env lock")
    }

    fn valid_request() -> RtCapabilityProbeRequest {
        RtCapabilityProbeRequest {
            schema: Some(REQUEST_SCHEMA.to_string()),
            gate: Some(READONLY_PROBE_GATE.to_string()),
            diagnostic_only: Some(true),
            read_only: Some(true),
            dry_run: Some(true),
            endpoint_ref_hash: Some(h('a')),
            remote_root_ref_hash: Some(h('b')),
            credential_ref_hash: Some(h('c')),
            capability_probe_receipt_hash: Some(h('d')),
            requested_operations: Some(vec![
                "options".to_string(),
                "propfind-depth-0".to_string(),
                "head-root".to_string(),
            ]),
            ..Default::default()
        }
    }

    fn registry_file(
        name: &str,
        endpoint: &str,
        remote_root: &str,
        credential: &str,
    ) -> (PathBuf, String) {
        let path = std::env::temp_dir().join(format!(
            "h2o-rt-resolver-{name}-{}.json",
            std::process::id()
        ));
        let bytes = serde_json::to_vec(&json!({
            "schema": "h2o.studio.transport.real-descriptor-registry.v1",
            "descriptorMode": "hash-only-redacted",
            "endpointRefHash": endpoint,
            "remoteRootRefHash": remote_root,
            "credentialRefHash": credential
        }))
        .expect("serialize test registry");
        fs::write(&path, &bytes).expect("write test registry");
        let registry_hash = sha256_ref(&bytes);
        (path, registry_hash)
    }

    fn registry_file_with_private(
        name: &str,
        endpoint: &str,
        remote_root: &str,
        credential: &str,
    ) -> (PathBuf, String) {
        let path = std::env::temp_dir().join(format!(
            "h2o-rt-live-probe-{name}-{}.json",
            std::process::id()
        ));
        let bytes = serde_json::to_vec(&json!({
            "schema": "h2o.studio.transport.real-descriptor-registry.v1",
            "descriptorMode": "hash-only-redacted",
            "endpointRefHash": endpoint,
            "remoteRootRefHash": remote_root,
            "credentialRefHash": credential,
            "endpointUrlPrivate": format!("{}://{}", "https", "private.invalid"),
            "remoteRootPathPrivate": "/redacted-root/",
            "authHeaderPrivate": "Bearer redacted"
        }))
        .expect("serialize private test registry");
        fs::write(&path, &bytes).expect("write private test registry");
        let registry_hash = sha256_ref(&bytes);
        (path, registry_hash)
    }

    #[derive(Default)]
    struct MockReadOnlyProbeClient;

    impl ReadOnlyProbeClient for MockReadOnlyProbeClient {
        fn send(
            &self,
            request: ReadOnlyProbeHttpRequest,
        ) -> Result<ReadOnlyProbeHttpResponse, ResolverFailure> {
            assert!(request.endpoint_url_private.contains("private.invalid"));
            assert_eq!(request.remote_root_path_private, "/redacted-root/");
            assert_eq!(
                request.auth_header_private.as_deref(),
                Some("Bearer redacted")
            );
            Ok(match request.operation {
                ReadOnlyProbeOperation::Options => ReadOnlyProbeHttpResponse {
                    status: 204,
                    allow_header: Some("OPTIONS, PROPFIND, HEAD, GET".to_string()),
                    ..Default::default()
                },
                ReadOnlyProbeOperation::PropfindDepth0 | ReadOnlyProbeOperation::PropfindDepth1 => {
                    ReadOnlyProbeHttpResponse {
                        status: 207,
                        dav_header: Some("1, 2".to_string()),
                        body: b"redacted-listing-summary".to_vec(),
                        ..Default::default()
                    }
                }
                ReadOnlyProbeOperation::HeadRoot | ReadOnlyProbeOperation::GetRoot => {
                    ReadOnlyProbeHttpResponse {
                        status: 200,
                        ..Default::default()
                    }
                }
                ReadOnlyProbeOperation::HeadDeterministicNonexistentChild => {
                    ReadOnlyProbeHttpResponse {
                        status: 404,
                        ..Default::default()
                    }
                }
            })
        }
    }

    #[derive(Clone)]
    struct MockFirstWriteLoopbackClient {
        propfind: FirstWriteLoopbackResponse,
        first_put: FirstWriteLoopbackResponse,
        second_put: FirstWriteLoopbackResponse,
        readback: FirstWriteLoopbackResponse,
    }

    impl Default for MockFirstWriteLoopbackClient {
        fn default() -> Self {
            Self {
                propfind: FirstWriteLoopbackResponse {
                    status: 404,
                    ..Default::default()
                },
                first_put: FirstWriteLoopbackResponse {
                    status: 201,
                    ..Default::default()
                },
                second_put: FirstWriteLoopbackResponse {
                    status: 412,
                    ..Default::default()
                },
                readback: FirstWriteLoopbackResponse {
                    status: 200,
                    body: FIRST_WRITE_DETERMINISTIC_SENTINEL_PAYLOAD
                        .as_bytes()
                        .to_vec(),
                    ..Default::default()
                },
            }
        }
    }

    impl FirstWriteLoopbackClient for MockFirstWriteLoopbackClient {
        fn propfind_absence(&self) -> FirstWriteLoopbackResponse {
            self.propfind.clone()
        }

        fn put_create_first(&self, _payload: &[u8]) -> FirstWriteLoopbackResponse {
            self.first_put.clone()
        }

        fn put_create_second(&self, _payload: &[u8]) -> FirstWriteLoopbackResponse {
            self.second_put.clone()
        }

        fn get_readback(&self) -> FirstWriteLoopbackResponse {
            self.readback.clone()
        }
    }

    struct MockWriteGradeReadOnlyPropfindClient {
        calls: Cell<usize>,
        response: FirstWriteLoopbackResponse,
    }

    impl WriteGradeReadOnlyPropfindClient for MockWriteGradeReadOnlyPropfindClient {
        fn propfind_parent_readiness(
            &self,
            target: &FirstWriteLiveTarget,
        ) -> FirstWriteLoopbackResponse {
            self.calls.set(self.calls.get() + 1);
            assert_eq!(
                target.endpoint_url_private,
                "https://private.invalid/webdav"
            );
            assert_eq!(target.remote_root_path_private, "/redacted-root/");
            assert_eq!(target.auth_header_private, "Basic private-test-material");
            assert!(target.path_class_ref_hash.is_empty());
            self.response.clone()
        }
    }

    fn write_grade_read_only_test_parity() -> WriteGradeReadOnlyRegistryParity {
        WriteGradeReadOnlyRegistryParity {
            normal_probe_registry_path_source: "app-local",
            write_grade_registry_path_source: "app-local",
            registry_selection_equivalent: true,
            endpoint_material_equivalent: true,
            remote_root_material_equivalent: true,
            credential_material_equivalent: true,
            write_grade_registry_eligible: true,
            credential_material_present: true,
            target: FirstWriteLiveTarget {
                endpoint_url_private: "https://private.invalid/webdav".to_string(),
                remote_root_path_private: "/redacted-root/".to_string(),
                auth_header_private: "Basic private-test-material".to_string(),
                path_class_ref_hash: String::new(),
            },
        }
    }

    fn live_request() -> RtCapabilityProbeRequest {
        let mut request = valid_request();
        request.gate = Some(LIVE_READONLY_PROBE_GATE.to_string());
        request.resolver_check = Some(true);
        request.live_read_only_probe = Some(true);
        request.requested_operations = Some(vec![
            "options".to_string(),
            "propfind-depth-0".to_string(),
            "head-root".to_string(),
            "head-deterministic-nonexistent-child".to_string(),
        ]);
        request
    }

    fn setup_request() -> RtWebDavSetupRequest {
        RtWebDavSetupRequest {
            server_url: Some(format!("{}://{}", "https", "nonproduction-webdav.local")),
            root_path: Some(format!("/{}/", "w3-readonly-root")),
            credential_identifier: Some("operator-test-identity".to_string()),
            credential_secret: Some("non-production-credential-material".to_string()),
            endpoint_descriptor_label: Some("non-production-webdav-endpoint".to_string()),
            remote_root_descriptor_label: Some("non-production-webdav-root".to_string()),
            credential_descriptor_label: Some("non-production-webdav-credential".to_string()),
            confirm_non_production: Some(true),
            confirm_read_only_safe: Some(true),
            confirm_sacrificial_write_not_approved: Some(true),
        }
    }

    fn first_write_request() -> RtFirstWriteRequest {
        let payload = FIRST_WRITE_DETERMINISTIC_SENTINEL_PAYLOAD.to_string();
        let payload_hash = sha256_ref(payload.as_bytes());
        let approval_hash = h('d');
        let one_shot_token = "loopback-one-shot-token".to_string();
        let kill_switch_token = "loopback-kill-switch-token".to_string();
        let one_shot_token_hash = sha256_ref(one_shot_token.as_bytes());
        let kill_switch_token_hash = sha256_ref(kill_switch_token.as_bytes());
        let write_grade_registry_ref_hash = h('e');
        RtFirstWriteRequest {
            schema: Some(FIRST_WRITE_REQUEST_SCHEMA.to_string()),
            gate: Some(FIRST_WRITE_GATE.to_string()),
            mock_only: Some(true),
            loopback_mock: Some(true),
            live_webdav_invocation: Some(false),
            invocation_utc: Some("2026-07-07T01:00:00Z".to_string()),
            receipt_core_hash: None,
            approval_expiry_utc: None,
            approval_artifact_hash: Some(approval_hash.clone()),
            one_shot_token: Some(one_shot_token),
            one_shot_token_hash: Some(one_shot_token_hash.clone()),
            kill_switch_token: Some(kill_switch_token),
            kill_switch_token_hash: Some(kill_switch_token_hash.clone()),
            kill_switch_enabled: Some(true),
            kill_switch_fresh: Some(true),
            write_grade_registry_ref_hash: Some(write_grade_registry_ref_hash.clone()),
            registry_path_source: Some("app-local".to_string()),
            write_grade_registry_eligible: Some(true),
            registry_owner_ok: Some(true),
            registry_permission_ok: Some(true),
            payload: Some(payload),
            payload_hash: Some(payload_hash.clone()),
            payload_byte_max: Some(256),
            write_grade_receipt: Some(WriteGradeReceipt {
                schema: Some(WRITE_GRADE_RECEIPT_SCHEMA.to_string()),
                canonicalization: Some(WRITE_GRADE_RECEIPT_CANONICALIZATION.to_string()),
                receipt_grade: Some("write-grade".to_string()),
                mint_utc: Some("2026-07-07T00:00:00Z".to_string()),
                expiry_utc: Some("2026-07-09T00:00:00Z".to_string()),
                operation_kind: Some(FIRST_WRITE_OPERATION_KIND.to_string()),
                payload_kind: Some(FIRST_WRITE_PAYLOAD_KIND.to_string()),
                payload_count: Some(1),
                max_invocations: Some(1),
                request_budget: Some(WriteGradeRequestBudget {
                    create_only_put_max: Some(2),
                    readback_get_max: Some(1),
                    other_methods: Some(0),
                }),
                sacrificial_object: Some(WriteGradeSacrificialObject {
                    path_class_ref_hash: Some(h('f')),
                    payload_hash: Some(payload_hash),
                    payload_byte_max: Some(256),
                }),
                bindings: Some(WriteGradeReceiptBindings {
                    endpoint_ref_hash: Some(h('a')),
                    remote_root_ref_hash: Some(h('b')),
                    credential_ref_hash: Some(h('c')),
                    write_grade_registry_ref_hash: Some(write_grade_registry_ref_hash),
                    write_grade_registry_hash_boundary: Some(
                        WRITE_GRADE_REGISTRY_HASH_BOUNDARY.to_string(),
                    ),
                    w31_closeout_commit: Some(W31_CLOSEOUT_COMMIT.to_string()),
                    w31_alignment_commit: Some(W31_ALIGNMENT_COMMIT.to_string()),
                    w32_mock_proof_commit: Some(W32_MOCK_PROOF_COMMIT.to_string()),
                    w33a_design_commit: Some(W33A_DESIGN_COMMIT.to_string()),
                    w33b_registry_hardening_commit: Some(W33B_STORAGE_COMMIT.to_string()),
                    w33c_hash_boundary_commit: Some(W33C_HASH_BOUNDARY_COMMIT.to_string()),
                    w34a_refused_command_commit: Some(W34A_REFUSED_COMMAND_COMMIT.to_string()),
                    w34b0_approval_package_commit: Some(W34B0_APPROVAL_PACKAGE_COMMIT.to_string()),
                    w34b1_operator_approval_commit: Some(
                        W34B1_OPERATOR_APPROVAL_COMMIT.to_string(),
                    ),
                    w34b1_expired_operator_approval_commit: None,
                    w34b1_r2_renewed_operator_approval_commit: None,
                    w34b3_blocked_missing_token_commit: None,
                    w34b3_r3_binding_mismatch_diagnostic_commit: None,
                    w34b3_r4_no_write_closeout_commit: None,
                    w35b_parent_propfind_fix_commit: None,
                    operator_approval_artifact_hash: Some(approval_hash),
                    one_shot_token_hash: Some(one_shot_token_hash),
                    kill_switch_token_hash: Some(kill_switch_token_hash),
                }),
            }),
            ..Default::default()
        }
    }

    fn live_first_write_request() -> RtFirstWriteRequest {
        let mut request = first_write_request();
        request.gate = Some(FIRST_WRITE_LIVE_GATE.to_string());
        request.mock_only = Some(false);
        request.loopback_mock = Some(false);
        request.live_webdav_invocation = Some(true);
        request.approval_expiry_utc = Some("2026-07-09T00:00:00Z".to_string());
        request.receipt_core_hash = request
            .write_grade_receipt
            .as_ref()
            .and_then(write_grade_receipt_core_hash);
        request
    }

    fn r6_fixture() -> R6WriteGradeReceipt {
        let approved_runtime_commit = h('9').replace("sha256:", "")[..40].to_string();
        let approval_commit = h('8').replace("sha256:", "")[..40].to_string();
        let receipt_identifier = "r6-s1-test-receipt".to_string();
        let mut receipt = R6WriteGradeReceipt {
            schema_version: R6_RECEIPT_SCHEMA_VERSION.to_string(),
            receipt_identifier: receipt_identifier.clone(),
            runtime: R6RuntimeBinding {
                approved_final_runtime_commit: approved_runtime_commit.clone(),
                required_embedded_build_git_sha: approved_runtime_commit.clone(),
                build_dirty_must_be_false: true,
                build_profile: R6BuildProfile::Debug,
                e6_commit: R6_E6_COMMIT.to_string(),
                e6_parent: R6_E6_PARENT_COMMIT.to_string(),
                e6_evidence_sha256: R6_E6_EVIDENCE_SHA256.to_string(),
                e6_runtime_stdout_sha256: R6_E6_RUNTIME_STDOUT_SHA256.to_string(),
                implementation_commitments: R6ImplementationCommitments {
                    gated_executor_commit: R6_GATED_EXECUTOR_COMMIT.to_string(),
                    canonical_binding_fix_commit: R6_CANONICAL_BINDING_FIX_COMMIT.to_string(),
                    parent_propfind_fix_commit: W35B_PARENT_PROPFIND_FIX_COMMIT.to_string(),
                    r5a_binding_fix_commit: R5A_BINDING_FIX_PRESENT_COMMIT.to_string(),
                    w35d_implementation_commit: R6_W35D_IMPLEMENTATION_COMMIT.to_string(),
                    parent_propfind_fix_must_be_present: true,
                    r5a_binding_fix_must_be_present: true,
                },
            },
            lineage: R6LineageCommitments {
                w31_request_shape_commit: W31_ALIGNMENT_COMMIT.to_string(),
                w31_closeout_commit: W31_CLOSEOUT_COMMIT.to_string(),
                w32_mock_executor_commit: W32_MOCK_PROOF_COMMIT.to_string(),
                w33a_commit: W33A_DESIGN_COMMIT.to_string(),
                w33b_commit: W33B_STORAGE_COMMIT.to_string(),
                w33c_commit: W33C_HASH_BOUNDARY_COMMIT.to_string(),
                w34a_commit: W34A_REFUSED_COMMAND_COMMIT.to_string(),
                w34b_commit: W34B0_APPROVAL_PACKAGE_COMMIT.to_string(),
                gated_executor_commit: R6_GATED_EXECUTOR_COMMIT.to_string(),
                canonical_binding_fix_commit: R6_CANONICAL_BINDING_FIX_COMMIT.to_string(),
                parent_propfind_fix_commit: W35B_PARENT_PROPFIND_FIX_COMMIT.to_string(),
                r5a_binding_fix_commit: R5A_BINDING_FIX_PRESENT_COMMIT.to_string(),
                w35d_implementation_commit: R6_W35D_IMPLEMENTATION_COMMIT.to_string(),
                e6_commit: R6_E6_COMMIT.to_string(),
            },
            approval: R6ApprovalBinding {
                approval_artifact_identifier: "r6-s1-test-approval".to_string(),
                approval_artifact_commit: approval_commit,
                approval_schema_version: R6_APPROVAL_SCHEMA_VERSION.to_string(),
                approval_core_hash: h('0'),
                approval_mint_utc: "2026-07-13T11:00:00Z".to_string(),
                approval_expiry_utc: "2026-07-13T23:00:00Z".to_string(),
                constrained_descendant_authorization_descriptor:
                    R6_DESCENDANT_AUTHORIZATION_DESCRIPTOR.to_string(),
                ceremony_policy_identifier: R6_CEREMONY_POLICY_IDENTIFIER.to_string(),
            },
            private_material_commitments: R6PrivateMaterialCommitments {
                one_shot_token_sha256: h('1'),
                kill_switch_token_sha256: h('2'),
                endpoint_ref_hash: h('3'),
                remote_root_ref_hash: h('4'),
                credential_ref_hash: h('5'),
                deterministic_object_path_commitment: h('6'),
                deterministic_payload_hash: h('7'),
                maximum_payload_bytes: 256,
            },
            ceremony_policy: R6CeremonyPolicy {
                policy_identifier: R6_CEREMONY_POLICY_IDENTIFIER.to_string(),
                ordered_sequence: [
                    R6CeremonyMethod::Propfind,
                    R6CeremonyMethod::Put,
                    R6CeremonyMethod::Put,
                    R6CeremonyMethod::Get,
                ],
                attempt_ceilings: R6AttemptCeilings {
                    parent_propfind: 1,
                    first_create_only_put: 1,
                    second_create_only_put: 1,
                    readback_get: 1,
                },
                total_request_ceiling: 4,
                expected_results: R6ExpectedResults {
                    parent_propfind: R6ExactStatusExpectation { status_code: 207 },
                    first_create_only_put: R6ExactStatusExpectation { status_code: 201 },
                    second_create_only_put: R6ExactStatusExpectation { status_code: 412 },
                    readback_get: R6ReadbackExpectation {
                        accepted_status_family: R6StatusFamily::TwoXx,
                        exact_payload_hash_match_required: true,
                    },
                },
                redirects_prohibited: true,
                authority_changes_prohibited: true,
                automatic_retries_prohibited: true,
                cleanup_prohibited: true,
                readiness_changes_prohibited: true,
                forbidden_methods: vec![
                    R6ForbiddenMethod::Options,
                    R6ForbiddenMethod::Delete,
                    R6ForbiddenMethod::Mkcol,
                    R6ForbiddenMethod::Proppatch,
                    R6ForbiddenMethod::Move,
                    R6ForbiddenMethod::Copy,
                    R6ForbiddenMethod::Lock,
                    R6ForbiddenMethod::Unlock,
                    R6ForbiddenMethod::Post,
                ],
                forbidden_write_classes: vec![
                    R6ForbiddenWriteClass::Archive,
                    R6ForbiddenWriteClass::Chat,
                    R6ForbiddenWriteClass::FullBundle,
                    R6ForbiddenWriteClass::FullBundleV3,
                    R6ForbiddenWriteClass::Relay,
                    R6ForbiddenWriteClass::Cas,
                    R6ForbiddenWriteClass::Outbox,
                    R6ForbiddenWriteClass::Ledger,
                    R6ForbiddenWriteClass::UserData,
                ],
            },
            lifecycle_policy: R6LifecyclePolicy {
                receipt_mint_utc: "2026-07-13T12:00:00Z".to_string(),
                receipt_expiry_utc: "2026-07-13T20:00:00Z".to_string(),
                maximum_validity_seconds: R6_MAX_VALIDITY_SECONDS as u32,
                clock_skew_seconds: R6_CLOCK_SKEW_SECONDS as u32,
                must_be_unconsumed: true,
                must_be_uninvoked: true,
                consumed_marker_schema_version: R6_CONSUMED_MARKER_SCHEMA_VERSION.to_string(),
                consumed_marker_binding: R6ConsumedMarkerBinding {
                    receipt_identifier,
                    receipt_core_hash: R6ReceiptCoreHashBinding::CanonicalR6ReceiptCoreHash,
                    approved_runtime_commit,
                    product_sync_ready_must_remain_false: true,
                    transport_ready_must_remain_false: true,
                },
            },
        };
        refresh_r6_approval_hash(&mut receipt);
        receipt
    }

    fn refresh_r6_approval_hash(receipt: &mut R6WriteGradeReceipt) {
        receipt.approval.approval_core_hash =
            r6_approval_core_hash(&r6_approval_core_from_receipt(receipt))
                .expect("R6 approval core hash");
    }

    fn r6_gate(receipt: &R6WriteGradeReceipt) -> R6ApprovalGateConfig<'_> {
        R6ApprovalGateConfig {
            sealed: true,
            approval_commit: &receipt.approval.approval_artifact_commit,
            approval_artifact_hash: &receipt.approval.approval_core_hash,
        }
    }

    fn r6_context(receipt: &R6WriteGradeReceipt) -> R6DispatchContext<'_> {
        R6DispatchContext {
            now_utc: "2026-07-13T13:00:00Z",
            approved_runtime_commit: &receipt.runtime.approved_final_runtime_commit,
            embedded_build_git_sha: &receipt.runtime.required_embedded_build_git_sha,
            build_dirty: false,
            build_profile: receipt.runtime.build_profile,
            computed_one_shot_token_hash: &receipt
                .private_material_commitments
                .one_shot_token_sha256,
            computed_kill_switch_token_hash: &receipt
                .private_material_commitments
                .kill_switch_token_sha256,
            receipt_consumed: false,
            receipt_invoked: false,
            consumed_marker_exists: false,
        }
    }

    fn dispatch_r6_fixture(receipt: &R6WriteGradeReceipt) -> Result<(), &'static str> {
        let raw = serde_json::to_string(receipt).expect("serialize R6 fixture");
        let hash = r6_receipt_core_hash(receipt).expect("hash R6 fixture");
        dispatch_r6_execution_preflight_with_gate(
            &raw,
            &hash,
            r6_context(receipt),
            r6_gate(receipt),
            |_receipt, _hash| (),
        )
    }

    fn reversed_json(value: &JsonValue) -> String {
        match value {
            JsonValue::Object(map) => {
                let members = map
                    .iter()
                    .rev()
                    .map(|(key, value)| {
                        format!(
                            "{}:{}",
                            serde_json::to_string(key).expect("serialize key"),
                            reversed_json(value)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(",");
                format!("{{{members}}}")
            }
            JsonValue::Array(values) => format!(
                "[{}]",
                values
                    .iter()
                    .map(reversed_json)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            value => serde_json::to_string(value).expect("serialize scalar"),
        }
    }

    fn variants_with_one_object_field_removed(value: &JsonValue) -> Vec<JsonValue> {
        let mut variants = Vec::new();
        match value {
            JsonValue::Object(map) => {
                for key in map.keys() {
                    let mut changed = map.clone();
                    changed.remove(key);
                    variants.push(JsonValue::Object(changed));
                }
                for (key, child) in map {
                    for changed_child in variants_with_one_object_field_removed(child) {
                        let mut changed = map.clone();
                        changed.insert(key.clone(), changed_child);
                        variants.push(JsonValue::Object(changed));
                    }
                }
            }
            JsonValue::Array(values) => {
                for (index, child) in values.iter().enumerate() {
                    for changed_child in variants_with_one_object_field_removed(child) {
                        let mut changed = values.clone();
                        changed[index] = changed_child;
                        variants.push(JsonValue::Array(changed));
                    }
                }
            }
            _ => {}
        }
        variants
    }

    fn variants_with_one_leaf_changed(value: &JsonValue) -> Vec<JsonValue> {
        let mut variants = Vec::new();
        match value {
            JsonValue::Object(map) => {
                for (key, child) in map {
                    for changed_child in variants_with_one_leaf_changed(child) {
                        let mut changed = map.clone();
                        changed.insert(key.clone(), changed_child);
                        variants.push(JsonValue::Object(changed));
                    }
                }
            }
            JsonValue::Array(values) => {
                for (index, child) in values.iter().enumerate() {
                    for changed_child in variants_with_one_leaf_changed(child) {
                        let mut changed = values.clone();
                        changed[index] = changed_child;
                        variants.push(JsonValue::Array(changed));
                    }
                }
            }
            JsonValue::String(value) => {
                variants.push(JsonValue::String(format!("{value}-changed")))
            }
            JsonValue::Bool(value) => variants.push(JsonValue::Bool(!value)),
            JsonValue::Number(value) => {
                if let Some(value) = value.as_u64() {
                    variants.push(JsonValue::Number((value + 1).into()));
                }
            }
            JsonValue::Null => {}
        }
        variants
    }

    #[test]
    fn r6_strict_schema_parses_valid_fixture_and_rejects_unknown_missing_null_and_float() {
        let receipt = r6_fixture();
        let raw = serde_json::to_string(&receipt).expect("serialize R6 fixture");
        let hash = r6_receipt_core_hash(&receipt).expect("R6 hash");
        assert_eq!(
            parse_r6_receipt_for_execution(&raw, &hash),
            Ok(receipt.clone())
        );

        let mut unknown_schema = serde_json::to_value(&receipt).expect("fixture value");
        unknown_schema["schemaVersion"] = json!("h2o.r6.write-grade-receipt.v2");
        assert_eq!(
            parse_r6_receipt_for_execution(&unknown_schema.to_string(), &h('a')),
            Err("real-transport-r6-schema-version-refused")
        );

        let mut unknown_top = serde_json::to_value(&receipt).expect("fixture value");
        unknown_top["unexpected"] = json!(true);
        assert_eq!(
            parse_r6_receipt_for_execution(&unknown_top.to_string(), &h('a')),
            Err("real-transport-r6-strict-receipt-invalid")
        );

        let mut unknown_nested = serde_json::to_value(&receipt).expect("fixture value");
        unknown_nested["runtime"]["unexpected"] = json!(true);
        assert_eq!(
            parse_r6_receipt_for_execution(&unknown_nested.to_string(), &h('a')),
            Err("real-transport-r6-strict-receipt-invalid")
        );

        let mut missing = serde_json::to_value(&receipt).expect("fixture value");
        missing.as_object_mut().expect("object").remove("approval");
        assert_eq!(
            parse_r6_receipt_for_execution(&missing.to_string(), &h('a')),
            Err("real-transport-r6-strict-receipt-invalid")
        );

        let mut null_required = serde_json::to_value(&receipt).expect("fixture value");
        null_required["receiptIdentifier"] = JsonValue::Null;
        assert_eq!(
            parse_r6_receipt_for_execution(&null_required.to_string(), &h('a')),
            Err("real-transport-r6-strict-receipt-invalid")
        );

        let floating = raw.replacen(
            "\"totalRequestCeiling\":4",
            "\"totalRequestCeiling\":4.0",
            1,
        );
        assert_eq!(
            parse_r6_receipt_for_execution(&floating, &h('a')),
            Err("real-transport-r6-json-invalid-or-duplicate-key")
        );
    }

    #[test]
    fn r6_duplicate_keys_are_rejected_at_top_level_and_nested_even_when_identical() {
        let receipt = r6_fixture();
        let raw = serde_json::to_string(&receipt).expect("serialize R6 fixture");
        let duplicate_top = raw.replacen(
            "{",
            "{\"schemaVersion\":\"h2o.r6.write-grade-receipt.v1\",",
            1,
        );
        assert_eq!(
            parse_r6_receipt_for_execution(&duplicate_top, &h('a')),
            Err("real-transport-r6-json-invalid-or-duplicate-key")
        );
        let duplicate_nested = raw.replacen(
            "\"buildProfile\":\"debug\"",
            "\"buildProfile\":\"debug\",\"buildProfile\":\"debug\"",
            1,
        );
        assert_eq!(
            parse_r6_receipt_for_execution(&duplicate_nested, &h('a')),
            Err("real-transport-r6-json-invalid-or-duplicate-key")
        );
    }

    #[test]
    fn r6_canonical_hash_is_typed_order_independent_and_domain_separated() {
        let receipt = r6_fixture();
        let compact = serde_json::to_string(&receipt).expect("compact receipt");
        let value = serde_json::to_value(&receipt).expect("receipt value");
        let reversed = reversed_json(&value);
        let compact_typed =
            parse_r6_receipt_for_execution(&compact, &h('a')).expect("compact receipt parses");
        let reversed_typed =
            parse_r6_receipt_for_execution(&reversed, &h('a')).expect("reversed receipt parses");
        let first = r6_receipt_core_hash(&compact_typed).expect("first hash");
        assert_eq!(first, r6_receipt_core_hash(&receipt).expect("repeat hash"));
        assert_eq!(
            first,
            r6_receipt_core_hash(&reversed_typed).expect("reversed hash")
        );

        let canonical = canonical_typed_json_bytes(&receipt).expect("canonical receipt");
        assert_ne!(
            first,
            domain_separated_hash(b"historical-receipt-domain\n", &canonical)
        );
        assert_ne!(
            first,
            domain_separated_hash(R6_APPROVAL_HASH_DOMAIN, &canonical)
        );
        assert_eq!(
            R6_RECEIPT_HASH_DOMAIN,
            b"h2o.r6.write-grade-receipt-core.v1\n"
        );
        assert_eq!(R6_APPROVAL_HASH_DOMAIN, b"h2o.r6.approval-core.v1\n");

        let approval = r6_approval_core_from_receipt(&receipt);
        let approval_hash = r6_approval_core_hash(&approval).expect("approval hash");
        assert_eq!(
            approval_hash,
            r6_approval_core_hash(&approval).expect("repeat approval hash")
        );
        let mut changed_approval = approval.clone();
        changed_approval.expiry_utc = "2026-07-13T22:59:59Z".to_string();
        assert_ne!(
            approval_hash,
            r6_approval_core_hash(&changed_approval).expect("changed approval hash")
        );
    }

    #[test]
    fn r6_s1_2_approval_core_is_seven_field_strict_order_independent_and_hash_sensitive() {
        let receipt = r6_fixture();
        let approval = r6_approval_core_from_receipt(&receipt);
        let value = serde_json::to_value(&approval).expect("approval core value");
        let object = value.as_object().expect("approval core object");
        let mut field_names = object.keys().map(String::as_str).collect::<Vec<_>>();
        field_names.sort_unstable();
        assert_eq!(
            field_names,
            [
                "approvalArtifactIdentifier",
                "ceremonyPolicyIdentifier",
                "constrainedDescendantAuthorizationDescriptor",
                "e6Commit",
                "expiryUtc",
                "mintUtc",
                "schemaVersion",
            ]
        );
        assert!(!object.contains_key("approvedFinalRuntimeCommit"));

        let baseline_hash = r6_approval_core_hash(&approval).expect("approval core hash");
        let reversed = reversed_json(&value);
        let reversed_approval =
            parse_r6_approval_core(&reversed).expect("reversed approval core parses");
        assert_eq!(
            r6_approval_core_hash(&reversed_approval).expect("reversed approval hash"),
            baseline_hash
        );

        let removed = variants_with_one_object_field_removed(&value);
        assert_eq!(removed.len(), 7);
        for variant in removed {
            assert_eq!(
                parse_r6_approval_core(&variant.to_string()),
                Err("real-transport-r6-strict-approval-core-invalid")
            );
        }

        let changed = variants_with_one_leaf_changed(&value);
        assert_eq!(changed.len(), 7);
        for variant in changed {
            let changed_approval =
                parse_r6_approval_core(&variant.to_string()).expect("changed approval core parses");
            assert_ne!(
                r6_approval_core_hash(&changed_approval).expect("changed approval hash"),
                baseline_hash,
                "every approval-core field must affect the canonical hash"
            );
        }

        let mut unknown = value.clone();
        unknown["approvedFinalRuntimeCommit"] =
            json!(receipt.runtime.approved_final_runtime_commit);
        assert_eq!(
            parse_r6_approval_core(&unknown.to_string()),
            Err("real-transport-r6-strict-approval-core-invalid")
        );
        let mut null_required = value.clone();
        null_required["e6Commit"] = JsonValue::Null;
        assert_eq!(
            parse_r6_approval_core(&null_required.to_string()),
            Err("real-transport-r6-strict-approval-core-invalid")
        );
        let raw = serde_json::to_string(&approval).expect("approval core JSON");
        let duplicate = raw.replacen("{", "{\"schemaVersion\":\"h2o.r6.approval.v1\",", 1);
        assert_eq!(
            parse_r6_approval_core(&duplicate),
            Err("real-transport-r6-json-invalid-or-duplicate-key")
        );
    }

    #[test]
    fn r6_s1_2_runtime_commit_is_decoupled_from_approval_hash_but_bound_by_receipt_and_runtime() {
        let receipt = r6_fixture();
        let approval_hash =
            r6_approval_core_hash(&r6_approval_core_from_receipt(&receipt)).expect("approval hash");
        let receipt_hash = r6_receipt_core_hash(&receipt).expect("receipt hash");

        let mut changed = receipt.clone();
        changed.runtime.approved_final_runtime_commit =
            "1111111111111111111111111111111111111111".to_string();
        assert_eq!(
            r6_approval_core_hash(&r6_approval_core_from_receipt(&changed))
                .expect("changed approval hash"),
            approval_hash
        );
        assert_ne!(
            r6_receipt_core_hash(&changed).expect("changed receipt hash"),
            receipt_hash
        );
        assert_eq!(
            validate_r6_runtime_and_lineage(&changed, r6_context(&receipt)),
            Err("real-transport-r6-runtime-binding-mismatch")
        );

        let mut value = serde_json::to_value(&receipt).expect("receipt value");
        value["runtime"]
            .as_object_mut()
            .expect("runtime object")
            .remove("approvedFinalRuntimeCommit");
        assert!(serde_json::from_value::<R6WriteGradeReceipt>(value).is_err());
    }

    #[test]
    fn every_r6_required_field_is_strict_and_every_leaf_affects_hash_or_validity() {
        let receipt = r6_fixture();
        let value = serde_json::to_value(&receipt).expect("receipt value");
        let removed = variants_with_one_object_field_removed(&value);
        assert!(
            removed.len() > 60,
            "required-field coverage unexpectedly small"
        );
        for variant in removed {
            assert!(
                serde_json::from_value::<R6WriteGradeReceipt>(variant).is_err(),
                "removing any required object field must fail"
            );
        }

        let baseline_hash = r6_receipt_core_hash(&receipt).expect("baseline hash");
        let changed = variants_with_one_leaf_changed(&value);
        assert!(changed.len() > 80, "leaf coverage unexpectedly small");
        for variant in changed {
            if let Ok(changed_receipt) = serde_json::from_value::<R6WriteGradeReceipt>(variant) {
                assert_ne!(
                    r6_receipt_core_hash(&changed_receipt).expect("changed hash"),
                    baseline_hash,
                    "every accepted leaf change must affect the receipt hash"
                );
            }
        }
    }

    #[test]
    fn r6_historical_and_downgrade_receipts_are_refused() {
        let historical = include_str!(
            "../../../../../release-evidence/2026-07-12/real-transport-w3-4b-2-r5-write-grade-receipt-core.json"
        );
        assert_eq!(
            parse_r6_receipt_for_execution(historical, &h('a')),
            Err("real-transport-r6-historical-receipt-refused")
        );
        let receipt = r6_fixture();
        let mut value = serde_json::to_value(&receipt).expect("receipt value");
        value
            .as_object_mut()
            .expect("object")
            .remove("schemaVersion");
        value["schema"] = json!(WRITE_GRADE_RECEIPT_SCHEMA);
        assert_eq!(
            parse_r6_receipt_for_execution(&value.to_string(), &h('a')),
            Err("real-transport-r6-historical-receipt-refused")
        );
    }

    #[test]
    fn r6_synthetic_unsealed_gate_rejects_before_any_callback() {
        let receipt = r6_fixture();
        let raw = serde_json::to_string(&receipt).expect("serialize receipt");
        let hash = r6_receipt_core_hash(&receipt).expect("receipt hash");
        let calls = Cell::new(0);
        let result = dispatch_r6_execution_preflight_with_gate(
            &raw,
            &hash,
            r6_context(&receipt),
            R6ApprovalGateConfig {
                sealed: false,
                approval_commit: "",
                approval_artifact_hash: "",
            },
            |_receipt, _hash| calls.set(calls.get() + 1),
        );
        assert_eq!(result, Err("real-transport-r6-approval-gate-unsealed"));
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn r6_historical_and_arbitrary_approvals_cannot_satisfy_gate() {
        for historical in [
            W34B1_OPERATOR_APPROVAL_COMMIT,
            W34B1_R2_RENEWED_OPERATOR_APPROVAL_COMMIT,
        ] {
            let mut receipt = r6_fixture();
            receipt.approval.approval_artifact_commit = historical.to_string();
            refresh_r6_approval_hash(&mut receipt);
            let gate = R6ApprovalGateConfig {
                sealed: true,
                approval_commit: historical,
                approval_artifact_hash: &receipt.approval.approval_core_hash,
            };
            assert_eq!(
                validate_r6_approval_gate(&receipt, gate),
                Err("real-transport-r6-historical-approval-refused")
            );
        }

        let receipt = r6_fixture();
        let gate = R6ApprovalGateConfig {
            sealed: true,
            approval_commit: "7777777777777777777777777777777777777777",
            approval_artifact_hash: &receipt.approval.approval_core_hash,
        };
        assert_eq!(
            validate_r6_approval_gate(&receipt, gate),
            Err("real-transport-r6-approval-commit-mismatch")
        );
        let wrong_approval_hash = h('f');
        let gate = R6ApprovalGateConfig {
            sealed: true,
            approval_commit: &receipt.approval.approval_artifact_commit,
            approval_artifact_hash: &wrong_approval_hash,
        };
        assert_eq!(
            validate_r6_approval_gate(&receipt, gate),
            Err("real-transport-r6-approval-hash-mismatch")
        );
    }

    #[test]
    fn r6_burned_r4_and_r5_hashes_are_denied_before_schema_or_callback() {
        let receipt = r6_fixture();
        let context = r6_context(&receipt);
        let gate = r6_gate(&receipt);
        let calls = Cell::new(0);
        for (raw, hash) in [
            (
                include_str!(
                    "../../../../../release-evidence/2026-07-12/real-transport-w3-4b-2-r4-write-grade-receipt-core.json"
                ),
                R6_R4_BURNED_RECEIPT_CORE_HASH,
            ),
            (
                include_str!(
                    "../../../../../release-evidence/2026-07-12/real-transport-w3-4b-2-r5-write-grade-receipt-core.json"
                ),
                R6_R5_BURNED_RECEIPT_CORE_HASH,
            ),
        ] {
            assert_eq!(
                dispatch_r6_execution_preflight_with_gate(raw, hash, context, gate, |_, _| {
                    calls.set(calls.get() + 1)
                }),
                Err("real-transport-r6-burned-receipt-denied")
            );
        }
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn r6_runtime_e6_build_token_and_policy_mismatches_fail_closed() {
        let mut receipt = r6_fixture();
        assert_eq!(dispatch_r6_fixture(&receipt), Ok(()));

        receipt.runtime.e6_commit = "0000000000000000000000000000000000000000".to_string();
        refresh_r6_approval_hash(&mut receipt);
        assert_eq!(
            dispatch_r6_fixture(&receipt),
            Err("real-transport-r6-e6-binding-mismatch")
        );

        let receipt = r6_fixture();
        let mut context = r6_context(&receipt);
        context.approved_runtime_commit = "0000000000000000000000000000000000000000";
        assert_eq!(
            dispatch_r6_execution_preflight_with_gate(
                &serde_json::to_string(&receipt).expect("serialize"),
                &r6_receipt_core_hash(&receipt).expect("hash"),
                context,
                r6_gate(&receipt),
                |_, _| (),
            ),
            Err("real-transport-r6-runtime-binding-mismatch")
        );

        let mut context = r6_context(&receipt);
        context.embedded_build_git_sha = "1111111111111111111111111111111111111111";
        assert_eq!(
            dispatch_r6_execution_preflight_with_gate(
                &serde_json::to_string(&receipt).expect("serialize"),
                &r6_receipt_core_hash(&receipt).expect("hash"),
                context,
                r6_gate(&receipt),
                |_, _| (),
            ),
            Err("real-transport-r6-runtime-binding-mismatch")
        );

        let mut context = r6_context(&receipt);
        context.build_dirty = true;
        assert_eq!(
            dispatch_r6_execution_preflight_with_gate(
                &serde_json::to_string(&receipt).expect("serialize"),
                &r6_receipt_core_hash(&receipt).expect("hash"),
                context,
                r6_gate(&receipt),
                |_, _| (),
            ),
            Err("real-transport-r6-dirty-build-refused")
        );

        let mut context = r6_context(&receipt);
        context.build_profile = R6BuildProfile::Release;
        assert_eq!(
            dispatch_r6_execution_preflight_with_gate(
                &serde_json::to_string(&receipt).expect("serialize"),
                &r6_receipt_core_hash(&receipt).expect("hash"),
                context,
                r6_gate(&receipt),
                |_, _| (),
            ),
            Err("real-transport-r6-e6-binding-mismatch")
        );

        let wrong_token_hash = h('f');
        let mut context = r6_context(&receipt);
        context.computed_one_shot_token_hash = &wrong_token_hash;
        assert_eq!(
            dispatch_r6_execution_preflight_with_gate(
                &serde_json::to_string(&receipt).expect("serialize"),
                &r6_receipt_core_hash(&receipt).expect("hash"),
                context,
                r6_gate(&receipt),
                |_, _| (),
            ),
            Err("real-transport-r6-token-commitment-mismatch")
        );

        let mut receipt = r6_fixture();
        receipt.ceremony_policy.ordered_sequence.swap(0, 1);
        assert_eq!(
            dispatch_r6_fixture(&receipt),
            Err("real-transport-r6-method-policy-invalid")
        );
        let mut receipt = r6_fixture();
        receipt.ceremony_policy.attempt_ceilings.readback_get = 2;
        assert_eq!(
            dispatch_r6_fixture(&receipt),
            Err("real-transport-r6-method-policy-invalid")
        );
        let mut receipt = r6_fixture();
        receipt.ceremony_policy.readiness_changes_prohibited = false;
        assert_eq!(
            dispatch_r6_fixture(&receipt),
            Err("real-transport-r6-fail-closed-policy-invalid")
        );

        let mut receipt = r6_fixture();
        receipt.runtime.approved_final_runtime_commit =
            "1111111111111111111111111111111111111111".to_string();
        assert_eq!(
            dispatch_r6_fixture(&receipt),
            Err("real-transport-r6-runtime-binding-mismatch")
        );
    }

    #[test]
    fn r6_forbidden_method_injection_is_rejected_by_typed_parser() {
        let receipt = r6_fixture();
        let raw = serde_json::to_string(&receipt).expect("serialize receipt");
        let injected = raw.replacen("\"PROPFIND\"", "\"OPTIONS\"", 1);
        assert_eq!(
            parse_r6_receipt_for_execution(&injected, &h('a')),
            Err("real-transport-r6-strict-receipt-invalid")
        );
    }

    #[test]
    fn r6_expiry_clock_skew_and_duplicate_invocation_are_fail_closed() {
        let receipt = r6_fixture();
        let raw = serde_json::to_string(&receipt).expect("serialize receipt");
        let hash = r6_receipt_core_hash(&receipt).expect("hash receipt");
        let gate = r6_gate(&receipt);

        let mut context = r6_context(&receipt);
        context.now_utc = "2026-07-13T20:02:00Z";
        assert_eq!(
            dispatch_r6_execution_preflight_with_gate(&raw, &hash, context, gate, |_, _| ()),
            Ok(())
        );
        context.now_utc = "2026-07-13T20:02:01Z";
        assert_eq!(
            dispatch_r6_execution_preflight_with_gate(&raw, &hash, context, gate, |_, _| ()),
            Err("real-transport-r6-receipt-or-approval-expired")
        );

        for state in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            let mut context = r6_context(&receipt);
            context.receipt_consumed = state.0;
            context.receipt_invoked = state.1;
            context.consumed_marker_exists = state.2;
            assert_eq!(
                dispatch_r6_execution_preflight_with_gate(&raw, &hash, context, gate, |_, _| ()),
                Err("real-transport-r6-receipt-already-consumed-or-invoked")
            );
        }

        let mut expired = r6_fixture();
        expired.approval.approval_expiry_utc = "2026-07-13T12:00:00Z".to_string();
        expired.lifecycle_policy.receipt_expiry_utc = "2026-07-13T12:00:00Z".to_string();
        expired.lifecycle_policy.receipt_mint_utc = "2026-07-13T11:30:00Z".to_string();
        refresh_r6_approval_hash(&mut expired);
        assert_eq!(
            dispatch_r6_fixture(&expired),
            Err("real-transport-r6-receipt-or-approval-expired")
        );
    }

    #[test]
    fn r6_all_pre_dispatch_failures_have_zero_after_preflight_calls() {
        let receipt = r6_fixture();
        let raw = serde_json::to_string(&receipt).expect("serialize receipt");
        let hash = r6_receipt_core_hash(&receipt).expect("receipt hash");
        let calls = Cell::new(0);
        let failures = [
            dispatch_r6_execution_preflight_with_gate(
                &raw,
                &h('f'),
                r6_context(&receipt),
                r6_gate(&receipt),
                |_, _| calls.set(calls.get() + 1),
            ),
            dispatch_r6_execution_preflight_with_gate(
                &raw,
                &hash,
                r6_context(&receipt),
                R6ApprovalGateConfig::production(),
                |_, _| calls.set(calls.get() + 1),
            ),
        ];
        assert!(failures.iter().all(Result::is_err));
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn existing_consumed_marker_remains_before_first_live_network_call() {
        let source = include_str!("real_transport_capability_probe.rs");
        let live_start = source
            .find("fn evaluate_first_write_live_with_client")
            .expect("live evaluator");
        let live = &source[live_start..];
        let marker = live
            .find("write_first_write_apply_intent_marker")
            .expect("marker call");
        let first_network = live
            .find("client.propfind_absence")
            .expect("first network client call");
        assert!(marker < first_network);
    }

    #[test]
    fn valid_probe_is_redacted_and_zero_write() {
        let result = evaluate_capability_probe(valid_request());
        assert!(result.ok);
        assert_eq!(
            result.status,
            "real-transport-readonly-capability-probe-ready"
        );
        assert!(!result.network_attempted);
        assert!(!result.real_webdav_transport_available);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
        assert!(!result.writes_webdav);
        assert!(!result.enqueues_relay);
        assert_eq!(result.create_only_behavior, "unknown");
        assert_eq!(result.etag_behavior, "unknown");
        assert_eq!(result.if_none_match_behavior, "unknown");
    }

    #[test]
    fn invalid_operation_blocks_without_write_flags() {
        let mut request = valid_request();
        request.requested_operations = Some(vec!["write-like-operation".to_string()]);
        let result = evaluate_capability_probe(request);
        assert!(!result.ok);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-readonly-operation-invalid"));
        assert!(!result.writes_webdav);
        assert!(!result.enqueues_relay);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
    }

    #[test]
    fn forbidden_method_names_are_not_accepted() {
        for method in [
            "PUT",
            "DELETE",
            "MKCOL",
            "PROPPATCH",
            "MOVE",
            "COPY",
            "LOCK",
            "UNLOCK",
            "POST",
        ] {
            let mut request = valid_request();
            request.requested_operations = Some(vec![method.to_string()]);
            let result = evaluate_capability_probe(request);
            assert!(!result.ok, "{method} must be rejected");
            assert!(!result.network_attempted);
            assert!(result
                .blockers
                .contains(&"real-transport-w3-readonly-operation-invalid"));
            assert!(!result.writes_webdav);
            assert!(!result.product_sync_ready);
            assert!(!result.transport_ready);
        }
    }

    #[test]
    fn raw_extra_input_blocks_without_echoing() {
        let mut request = valid_request();
        request.extra.insert(
            "endpointUrl".to_string(),
            JsonValue::String("redacted-marker://not-echoed".to_string()),
        );
        let result = evaluate_capability_probe(request);
        assert!(!result.ok);
        assert!(result.raw_input_rejected);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-raw-input-rejected"));
        let serialized = serde_json::to_string(&result).expect("serialize result");
        assert!(!serialized.contains("redacted-marker"));
    }

    #[test]
    fn resolver_missing_registry_fails_closed() {
        let _guard = env_lock();
        std::env::remove_var(DESCRIPTOR_REGISTRY_FILE_ENV);
        let mut request = valid_request();
        request.resolver_check = Some(true);
        let result = evaluate_capability_probe(request);
        assert!(!result.ok);
        assert!(!result.network_attempted);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-resolver-config-missing"));
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
    }

    #[test]
    fn resolver_descriptor_hash_mismatch_fails_closed() {
        let _guard = env_lock();
        let (registry_path, registry_hash) = registry_file("mismatch", &h('e'), &h('b'), &h('c'));
        std::env::set_var(DESCRIPTOR_REGISTRY_FILE_ENV, &registry_path);
        let mut request = valid_request();
        request.resolver_check = Some(true);
        request.descriptor_registry_ref_hash = Some(registry_hash);
        let result = evaluate_capability_probe(request);
        let _ = fs::remove_file(registry_path);
        std::env::remove_var(DESCRIPTOR_REGISTRY_FILE_ENV);
        assert!(!result.ok);
        assert!(!result.network_attempted);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-descriptor-hash-mismatch"));
        assert!(!result.writes_webdav);
    }

    #[test]
    fn resolver_ready_response_is_hash_only_and_no_network() {
        let _guard = env_lock();
        let request = valid_request();
        let endpoint = request.endpoint_ref_hash.clone().expect("endpoint hash");
        let remote_root = request
            .remote_root_ref_hash
            .clone()
            .expect("remote root hash");
        let credential = request
            .credential_ref_hash
            .clone()
            .expect("credential hash");
        let (registry_path, registry_hash) =
            registry_file("ready", &endpoint, &remote_root, &credential);
        std::env::set_var(DESCRIPTOR_REGISTRY_FILE_ENV, &registry_path);
        let mut request = request;
        request.resolver_check = Some(true);
        request.descriptor_registry_ref_hash = Some(registry_hash);
        let result = evaluate_capability_probe(request);
        let _ = fs::remove_file(registry_path);
        std::env::remove_var(DESCRIPTOR_REGISTRY_FILE_ENV);
        assert!(result.ok);
        assert!(result.resolver_available);
        assert!(result.endpoint_descriptor_resolved);
        assert!(result.remote_root_descriptor_resolved);
        assert!(result.credential_descriptor_resolved);
        assert!(!result.network_attempted);
        assert!(!result.writes_webdav);
        let serialized = serde_json::to_string(&result).expect("serialize result");
        assert!(!serialized.contains("://"));
        assert!(!serialized.contains("credentialValue"));
    }

    #[test]
    fn live_probe_requires_live_gate_before_network() {
        let _guard = env_lock();
        let mut request = valid_request();
        request.live_read_only_probe = Some(true);
        request.resolver_check = Some(true);
        std::env::remove_var(DESCRIPTOR_REGISTRY_FILE_ENV);
        let result = evaluate_capability_probe_with_client(request, &MockReadOnlyProbeClient);
        assert!(!result.ok);
        assert!(!result.network_attempted);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-readonly-gate-required"));
        assert!(!result.writes_webdav);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
    }

    #[test]
    fn live_probe_missing_registry_fails_closed_before_network() {
        let _guard = env_lock();
        std::env::remove_var(DESCRIPTOR_REGISTRY_FILE_ENV);
        let result =
            evaluate_capability_probe_with_client(live_request(), &MockReadOnlyProbeClient);
        assert!(!result.ok);
        assert!(!result.network_attempted);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-resolver-config-missing"));
        assert!(!result.writes_webdav);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
    }

    #[test]
    fn live_probe_descriptor_mismatch_fails_closed_before_network() {
        let _guard = env_lock();
        let (registry_path, registry_hash) =
            registry_file_with_private("live-mismatch", &h('e'), &h('b'), &h('c'));
        std::env::set_var(DESCRIPTOR_REGISTRY_FILE_ENV, &registry_path);
        let mut request = live_request();
        request.descriptor_registry_ref_hash = Some(registry_hash);
        let result = evaluate_capability_probe_with_client(request, &MockReadOnlyProbeClient);
        let _ = fs::remove_file(registry_path);
        std::env::remove_var(DESCRIPTOR_REGISTRY_FILE_ENV);
        assert!(!result.ok);
        assert!(!result.network_attempted);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-descriptor-hash-mismatch"));
        assert!(!result.writes_webdav);
    }

    #[test]
    fn live_probe_mock_response_is_redacted_hash_only_and_zero_write() {
        let _guard = env_lock();
        let request = live_request();
        let endpoint = request.endpoint_ref_hash.clone().expect("endpoint hash");
        let remote_root = request
            .remote_root_ref_hash
            .clone()
            .expect("remote root hash");
        let credential = request
            .credential_ref_hash
            .clone()
            .expect("credential hash");
        let (registry_path, registry_hash) =
            registry_file_with_private("live-ready", &endpoint, &remote_root, &credential);
        std::env::set_var(DESCRIPTOR_REGISTRY_FILE_ENV, &registry_path);
        let mut request = request;
        request.descriptor_registry_ref_hash = Some(registry_hash);
        let result = evaluate_capability_probe_with_client(request, &MockReadOnlyProbeClient);
        let _ = fs::remove_file(registry_path);
        std::env::remove_var(DESCRIPTOR_REGISTRY_FILE_ENV);
        assert!(result.ok);
        assert!(result.resolver_available);
        assert!(result.network_attempted);
        assert_eq!(result.root_exists, Some(true));
        assert_eq!(result.root_empty, Some(false));
        assert_eq!(result.child_404_ok, Some(true));
        assert_eq!(
            result.method_status_families,
            vec![
                ReadOnlyMethodStatusFamily {
                    operation: "OPTIONS",
                    status_code: 204,
                    status_family: "2xx",
                    request_shape: ReadOnlyRequestShape {
                        target_shape: "endpoint-plus-folder",
                        trailing_slash: true,
                        double_slash: false,
                        auth_header_present: true,
                        propfind_depth_header_present: false,
                        propfind_body_present: false,
                        propfind_content_type_class: "none",
                        accept_header_class: "none",
                    },
                },
                ReadOnlyMethodStatusFamily {
                    operation: "PROPFIND Depth 0",
                    status_code: 207,
                    status_family: "2xx",
                    request_shape: ReadOnlyRequestShape {
                        target_shape: "endpoint-plus-folder",
                        trailing_slash: true,
                        double_slash: false,
                        auth_header_present: true,
                        propfind_depth_header_present: true,
                        propfind_body_present: true,
                        propfind_content_type_class: "xml",
                        accept_header_class: "xml",
                    },
                },
                ReadOnlyMethodStatusFamily {
                    operation: "HEAD root",
                    status_code: 200,
                    status_family: "2xx",
                    request_shape: ReadOnlyRequestShape {
                        target_shape: "endpoint-plus-folder",
                        trailing_slash: true,
                        double_slash: false,
                        auth_header_present: true,
                        propfind_depth_header_present: false,
                        propfind_body_present: false,
                        propfind_content_type_class: "none",
                        accept_header_class: "none",
                    },
                },
                ReadOnlyMethodStatusFamily {
                    operation: "HEAD deterministic nonexistent child",
                    status_code: 404,
                    status_family: "4xx",
                    request_shape: ReadOnlyRequestShape {
                        target_shape: "endpoint-plus-folder",
                        trailing_slash: false,
                        double_slash: false,
                        auth_header_present: true,
                        propfind_depth_header_present: false,
                        propfind_body_present: false,
                        propfind_content_type_class: "none",
                        accept_header_class: "none",
                    },
                },
            ]
        );
        assert!(is_hash_ref(&result.listing_hash));
        assert!(is_hash_ref(&result.dav_class_summary_hash));
        assert!(is_hash_ref(&result.allowed_methods_summary_hash));
        assert!(!result.writes_webdav);
        assert!(!result.enqueues_relay);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
        let serialized = serde_json::to_string(&result).expect("serialize result");
        assert!(!serialized.contains("private.invalid"));
        assert!(!serialized.contains("redacted-root"));
        assert!(!serialized.contains("Bearer redacted"));
        assert!(!serialized.contains("redacted-listing-summary"));
    }

    #[test]
    fn webdav_setup_requires_confirmations_and_never_attempts_network() {
        let result = prepare_webdav_setup(RtWebDavSetupRequest::default());
        assert!(!result.ok);
        assert!(!result.network_attempted);
        assert!(!result.writes_webdav);
        assert!(!result.enqueues_relay);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
        assert!(result
            .blockers
            .contains(&"real-transport-webdav-setup-non-production-confirmation-required"));
        assert!(result
            .blockers
            .contains(&"real-transport-webdav-setup-readonly-confirmation-required"));
        assert!(result
            .blockers
            .contains(&"real-transport-webdav-setup-no-sacrificial-write-confirmation-required"));
    }

    #[test]
    fn webdav_setup_prepares_private_registry_and_returns_redacted_status() {
        let _guard = env_lock();
        let registry_path =
            std::env::temp_dir().join(format!("h2o-rt-webdav-setup-{}.json", std::process::id()));
        std::env::set_var(DESCRIPTOR_REGISTRY_FILE_ENV, &registry_path);
        let result = prepare_webdav_setup(setup_request());
        assert!(result.ok);
        assert_eq!(result.registry_path_source, "env");
        assert!(is_hash_ref(&result.descriptor_registry_ref_hash));
        assert!(is_hash_ref(&result.write_grade_registry_ref_hash));
        assert_eq!(
            result.write_grade_registry_hash_boundary,
            WRITE_GRADE_REGISTRY_HASH_BOUNDARY
        );
        assert!(result.private_content_hash_available);
        assert!(is_hash_ref(&result.endpoint_ref_hash));
        assert!(is_hash_ref(&result.remote_root_ref_hash));
        assert!(is_hash_ref(&result.credential_ref_hash));
        assert_eq!(
            result.saved_server_url.as_deref(),
            Some("https://nonproduction-webdav.local")
        );
        assert_eq!(
            result.saved_root_path.as_deref(),
            Some("/w3-readonly-root/")
        );
        assert_eq!(
            result.saved_credential_identifier.as_deref(),
            Some("operator-test-identity")
        );
        assert!(result.json_parses);
        assert!(result.required_private_fields_present);
        assert!(result.credential_material_present);
        assert!(result.credential_input_received_this_save);
        assert!(result.credential_material_updated_this_save);
        assert!(result.endpoint_no_longer_reserved_invalid_domain);
        assert!(result.reachable_candidate);
        assert!(!result.network_attempted);
        assert!(!result.real_webdav_transport_available);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
        assert!(!result.writes_webdav);
        let serialized = serde_json::to_string(&result).expect("serialize setup result");
        assert!(!serialized.contains("credential-material"));

        let repeated = prepare_webdav_setup(setup_request());
        assert!(repeated.ok);
        assert_eq!(repeated.registry_path_source, "env");
        assert!(repeated.credential_material_present);
        assert!(repeated.credential_input_received_this_save);
        assert!(!repeated.credential_material_updated_this_save);
        assert_eq!(
            repeated.descriptor_registry_ref_hash,
            result.descriptor_registry_ref_hash
        );
        assert_eq!(
            repeated.write_grade_registry_ref_hash,
            result.write_grade_registry_ref_hash
        );
        assert_eq!(repeated.credential_ref_hash, result.credential_ref_hash);

        let mut changed = setup_request();
        changed.credential_secret = Some("changed-non-production-credential-material".to_string());
        let changed_result = prepare_webdav_setup(changed);
        assert!(changed_result.ok);
        assert!(changed_result.credential_material_present);
        assert!(changed_result.credential_input_received_this_save);
        assert!(changed_result.credential_material_updated_this_save);
        assert_ne!(
            changed_result.descriptor_registry_ref_hash,
            result.descriptor_registry_ref_hash
        );
        assert_eq!(
            changed_result.write_grade_registry_ref_hash,
            result.write_grade_registry_ref_hash
        );
        assert_eq!(
            changed_result.credential_ref_hash,
            result.credential_ref_hash
        );

        let mut preserved = setup_request();
        preserved.credential_secret = None;
        let preserved_result = prepare_webdav_setup(preserved);
        assert!(preserved_result.ok);
        assert!(preserved_result.credential_material_present);
        assert!(!preserved_result.credential_input_received_this_save);
        assert!(!preserved_result.credential_material_updated_this_save);
        assert_eq!(
            preserved_result.descriptor_registry_ref_hash,
            changed_result.descriptor_registry_ref_hash
        );
        assert_eq!(
            preserved_result.write_grade_registry_ref_hash,
            changed_result.write_grade_registry_ref_hash
        );
        assert_eq!(
            preserved_result.credential_ref_hash,
            result.credential_ref_hash
        );

        let status = webdav_setup_status();
        let _ = fs::remove_file(registry_path);
        std::env::remove_var(DESCRIPTOR_REGISTRY_FILE_ENV);
        assert!(status.ok);
        assert_eq!(status.registry_path_source, "env");
        assert_eq!(
            status.saved_server_url.as_deref(),
            Some("https://nonproduction-webdav.local")
        );
        assert_eq!(
            status.saved_root_path.as_deref(),
            Some("/w3-readonly-root/")
        );
        assert_eq!(
            status.saved_credential_identifier.as_deref(),
            Some("operator-test-identity")
        );
        assert!(status.credential_material_present);
        assert!(!status.credential_input_received_this_save);
        assert!(!status.credential_material_updated_this_save);
        assert_eq!(
            status.descriptor_registry_ref_hash,
            changed_result.descriptor_registry_ref_hash
        );
        assert_eq!(
            status.write_grade_registry_ref_hash,
            changed_result.write_grade_registry_ref_hash
        );
        assert!(status.private_content_hash_available);
        assert!(!status.network_attempted);
        assert!(!status.writes_webdav);
        assert!(!status.product_sync_ready);
        assert!(!status.transport_ready);
    }

    #[test]
    fn webdav_hydrate_form_is_local_desktop_only_and_keeps_status_redacted() {
        let _guard = env_lock();
        let registry_path =
            std::env::temp_dir().join(format!("h2o-rt-webdav-hydrate-{}.json", std::process::id()));
        std::env::set_var(DESCRIPTOR_REGISTRY_FILE_ENV, &registry_path);
        let prepared = prepare_webdav_setup(setup_request());
        assert!(prepared.ok);

        let status = webdav_setup_status();
        let status_json = serde_json::to_string(&status).expect("serialize status");
        assert!(status.credential_material_present);
        assert!(!status_json.contains("credential-material"));
        assert!(!status_json.contains("credentialSecret"));
        assert!(!status_json.contains("rememberedCredentialSecret"));

        let browser_like = webdav_setup_hydrate_form(RtWebDavSetupHydrateFormRequest {
            remember_credential: Some(true),
            desktop_local_ui: Some(false),
        });
        assert!(!browser_like.ok);
        assert_eq!(
            browser_like.reason,
            "real-transport-webdav-setup-hydrate-local-desktop-required"
        );
        assert!(browser_like.remembered_credential_secret.is_none());

        let remember_unchecked = webdav_setup_hydrate_form(RtWebDavSetupHydrateFormRequest {
            remember_credential: Some(false),
            desktop_local_ui: Some(true),
        });
        assert!(!remember_unchecked.ok);
        assert_eq!(
            remember_unchecked.reason,
            "real-transport-webdav-setup-hydrate-remember-required"
        );
        assert!(remember_unchecked.remembered_credential_secret.is_none());

        let hydrated = webdav_setup_hydrate_form(RtWebDavSetupHydrateFormRequest {
            remember_credential: Some(true),
            desktop_local_ui: Some(true),
        });
        let _ = fs::remove_file(registry_path);
        std::env::remove_var(DESCRIPTOR_REGISTRY_FILE_ENV);
        assert!(hydrated.ok);
        assert_eq!(hydrated.registry_path_source, "env");
        assert!(hydrated.write_grade_registry_eligible);
        assert!(hydrated.credential_material_present);
        assert_eq!(
            hydrated.saved_server_url.as_deref(),
            Some("https://nonproduction-webdav.local")
        );
        assert_eq!(
            hydrated.saved_root_path.as_deref(),
            Some("/w3-readonly-root/")
        );
        assert_eq!(
            hydrated.saved_credential_identifier.as_deref(),
            Some("operator-test-identity")
        );
        assert_eq!(
            hydrated.remembered_credential_secret.as_deref(),
            Some("non-production-credential-material")
        );
        assert!(!hydrated.network_attempted);
        assert!(!hydrated.writes_webdav);
        assert!(!hydrated.product_sync_ready);
        assert!(!hydrated.transport_ready);
    }

    #[test]
    fn first_write_default_refuses_without_network_or_write_flags() {
        let result = evaluate_first_write(None);
        assert!(!result.ok);
        assert_eq!(result.command, "h2o_rt_first_write");
        assert_eq!(
            result.reason,
            "real-transport-w3-write-grade-approval-missing"
        );
        assert!(!result.network_attempted);
        assert!(!result.loopback_attempted);
        assert!(!result.writes_webdav);
        assert!(!result.enqueues_relay);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
    }

    #[test]
    fn first_write_rejects_fixture_grade_receipt() {
        let mut request = first_write_request();
        request
            .write_grade_receipt
            .as_mut()
            .expect("receipt")
            .receipt_grade = Some("fixture".to_string());
        let result = evaluate_first_write_with_client(
            Some(request),
            &MockFirstWriteLoopbackClient::default(),
        );
        assert!(!result.ok);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-fixture-mock-grade-receipt-rejected"));
        assert!(!result.network_attempted);
        assert!(!result.writes_webdav);
    }

    #[test]
    fn first_write_rejects_legacy_registry_source() {
        let mut request = first_write_request();
        request.registry_path_source = Some("default-private-legacy".to_string());
        request.write_grade_registry_eligible = Some(false);
        let result = evaluate_first_write_with_client(
            Some(request),
            &MockFirstWriteLoopbackClient::default(),
        );
        assert!(!result.ok);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-write-grade-registry-source-refused"));
        assert!(!result.network_attempted);
        assert!(!result.writes_webdav);
    }

    #[test]
    fn first_write_rejects_token_hash_mismatch() {
        let mut request = first_write_request();
        request.one_shot_token = Some("wrong-token".to_string());
        let result = evaluate_first_write_with_client(
            Some(request),
            &MockFirstWriteLoopbackClient::default(),
        );
        assert!(!result.ok);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-one-shot-token-missing-or-mismatch"));
        assert!(!result.network_attempted);
        assert!(!result.writes_webdav);
    }

    #[test]
    fn first_write_rejects_payload_too_large() {
        let mut request = first_write_request();
        request.payload = Some("x".repeat(257));
        let result = evaluate_first_write_with_client(
            Some(request),
            &MockFirstWriteLoopbackClient::default(),
        );
        assert!(!result.ok);
        assert!(result
            .blockers
            .contains(&"real-transport-w3-first-write-payload-too-large"));
        assert!(!result.network_attempted);
        assert!(!result.writes_webdav);
    }

    #[test]
    fn first_write_accepts_renewed_approval_commit_binding() {
        let mut request = first_write_request();
        let bindings = &mut request
            .write_grade_receipt
            .as_mut()
            .expect("receipt")
            .bindings
            .as_mut()
            .expect("bindings");
        bindings.w34b1_operator_approval_commit = None;
        bindings.w34b1_expired_operator_approval_commit =
            Some(W34B1_OPERATOR_APPROVAL_COMMIT.to_string());
        bindings.w34b1_r2_renewed_operator_approval_commit =
            Some(W34B1_R2_RENEWED_OPERATOR_APPROVAL_COMMIT.to_string());
        bindings.w34b3_blocked_missing_token_commit = Some(W34B3B_MISSING_TOKEN_COMMIT.to_string());
        bindings.w34b3_r3_binding_mismatch_diagnostic_commit =
            Some(W34B3_R3A_BINDING_MISMATCH_DIAGNOSTIC_COMMIT.to_string());

        let mut blockers = Vec::new();
        let mode = validate_write_grade_receipt(&request, &mut blockers);
        assert_eq!(mode, Some(FirstWriteMode::LoopbackMock));
        assert!(
            !blockers.contains(&"real-transport-w3-first-write-commit-binding-mismatch"),
            "{blockers:?}"
        );
    }

    #[test]
    fn first_write_r3_receipt_core_hash_matches_committed_core() {
        let receipt: WriteGradeReceipt = serde_json::from_str(include_str!(
            "../../../../../release-evidence/2026-07-12/real-transport-w3-4b-2-r3-write-grade-receipt-core.json"
        ))
        .expect("R3 receipt core parses");
        assert_eq!(
            write_grade_receipt_core_hash(&receipt).as_deref(),
            Some("sha256:b34cd56a9d5a16fe3dc5319b174522f2c7634ad17717405310c18cec0188e1cd")
        );
    }

    #[test]
    fn first_write_r4_receipt_core_hash_matches_committed_core() {
        let receipt: WriteGradeReceipt = serde_json::from_str(include_str!(
            "../../../../../release-evidence/2026-07-12/real-transport-w3-4b-2-r4-write-grade-receipt-core.json"
        ))
        .expect("R4 receipt core parses");
        assert_eq!(
            write_grade_receipt_core_hash(&receipt).as_deref(),
            Some("sha256:b18da77e97eb2ab339ea974db93b5fb51bd1a5b4a478d69fa2bc5d18084fd183")
        );
    }

    #[test]
    fn first_write_r5_receipt_core_and_commit_bindings_match_committed_core() {
        let receipt: WriteGradeReceipt = serde_json::from_str(include_str!(
            "../../../../../release-evidence/2026-07-12/real-transport-w3-4b-2-r5-write-grade-receipt-core.json"
        ))
        .expect("R5 receipt core parses");
        assert_eq!(
            write_grade_receipt_core_hash(&receipt).as_deref(),
            Some("sha256:b27b6eb6ed238c15d9b687a85d2d8b98e9db4434a7c6b1d30df26e96aaddca57")
        );

        let mut request = first_write_request();
        request.write_grade_receipt = Some(receipt);
        request.receipt_core_hash = Some(
            "sha256:b27b6eb6ed238c15d9b687a85d2d8b98e9db4434a7c6b1d30df26e96aaddca57".to_string(),
        );
        let mut blockers = Vec::new();
        validate_write_grade_receipt(&request, &mut blockers);
        assert!(
            !blockers.contains(&"real-transport-w3-first-write-commit-binding-mismatch"),
            "{blockers:?}"
        );
        assert!(
            !blockers.contains(&"real-transport-w3-write-grade-receipt-core-hash-mismatch"),
            "{blockers:?}"
        );
    }

    #[test]
    fn first_write_live_path_refuses_incomplete_ceremony_before_network() {
        let cases = [
            (
                {
                    let mut request = live_first_write_request();
                    request.approval_artifact_hash = None;
                    request
                },
                "real-transport-w3-write-grade-approval-missing",
            ),
            (
                {
                    let mut request = live_first_write_request();
                    request.one_shot_token = None;
                    request
                },
                "real-transport-w3-one-shot-token-missing-or-mismatch",
            ),
            (
                {
                    let mut request = live_first_write_request();
                    request.kill_switch_enabled = Some(false);
                    request
                },
                "real-transport-w3-kill-switch-disabled-or-stale",
            ),
            (
                {
                    let mut request = live_first_write_request();
                    request.registry_path_source = Some("default-private-legacy".to_string());
                    request.write_grade_registry_eligible = Some(false);
                    request
                },
                "real-transport-w3-write-grade-registry-source-refused",
            ),
            (
                {
                    let mut request = live_first_write_request();
                    request.receipt_core_hash = Some(h('0'));
                    request
                },
                "real-transport-w3-write-grade-receipt-core-hash-mismatch",
            ),
        ];
        for (request, blocker) in cases {
            let result = evaluate_first_write(Some(request));
            assert!(!result.ok, "{blocker}");
            assert!(result.blockers.contains(&blocker), "{blocker}");
            assert!(!result.network_attempted);
            assert!(!result.loopback_attempted);
            assert!(!result.writes_webdav);
            assert!(!result.product_sync_ready);
            assert!(!result.transport_ready);
        }
    }

    #[test]
    fn first_write_live_propfind_uses_parent_collection_not_object_path() {
        let target = FirstWriteLiveTarget {
            endpoint_url_private: format!("{}://example.invalid/webdav", "https"),
            remote_root_path_private: "/redacted-root/".to_string(),
            auth_header_private: "Basic redacted".to_string(),
            path_class_ref_hash: h('a'),
        };

        let parent = ReqwestFirstWriteLiveClient::build_parent_collection_url(&target)
            .expect("parent collection url");
        let object =
            ReqwestFirstWriteLiveClient::build_target_url(&target).expect("object target url");

        assert!(parent.path().ends_with('/'));
        assert!(!parent.path().contains(".h2o-w3-sacrificial-probe"));
        assert!(object.path().contains(".h2o-w3-sacrificial-probe"));
        assert!(object.path().ends_with(".sentinel"));
        assert_ne!(parent.path(), object.path());
    }

    #[test]
    fn write_grade_read_only_probe_uses_one_parent_propfind_and_redacts_private_material() {
        let client = MockWriteGradeReadOnlyPropfindClient {
            calls: Cell::new(0),
            response: FirstWriteLoopbackResponse {
                status: 207,
                ..Default::default()
            },
        };
        let result = evaluate_write_grade_read_only_probe_with_client(
            Ok(write_grade_read_only_test_parity()),
            &client,
        );

        assert_eq!(client.calls.get(), 1);
        assert!(result.ok);
        assert!(result.write_grade_read_only_probe_passed);
        assert_eq!(result.method_statuses.len(), 1);
        assert_eq!(
            result.method_statuses[0].operation,
            "PROPFIND write-grade parent readiness diagnostic"
        );
        assert_eq!(result.method_statuses[0].status_code, 207);
        assert_eq!(result.normal_probe_registry_path_source, "app-local");
        assert_eq!(result.write_grade_registry_path_source, "app-local");
        assert!(result.registry_selection_equivalent);
        assert!(result.endpoint_material_equivalent);
        assert!(result.remote_root_material_equivalent);
        assert!(result.credential_material_equivalent);
        assert!(!result.receipt_consumed);
        assert!(!result.consumed_marker_created);
        assert!(!result.writes_webdav);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
        assert!(!result.build_git_sha.is_empty());
        assert!(!result.build_profile.is_empty());
        assert!(result.parent_propfind_fix_present);
        assert!(result.r5a_binding_fix_present);

        let serialized = serde_json::to_string(&result).expect("serialize diagnostic result");
        for private_value in [
            "https://private.invalid/webdav",
            "/redacted-root/",
            "Basic private-test-material",
        ] {
            assert!(!serialized.contains(private_value));
        }
        for forbidden_field in [
            "endpointUrlPrivate",
            "remoteRootPathPrivate",
            "authHeaderPrivate",
            "receiptCoreHash",
            "oneShotToken",
            "killSwitchToken",
        ] {
            assert!(!serialized.contains(forbidden_field));
        }
    }

    #[test]
    fn write_grade_read_only_probe_refuses_legacy_registry_before_network() {
        assert!(!write_grade_registry_source_candidate(
            "default-private-legacy"
        ));
        let client = MockWriteGradeReadOnlyPropfindClient {
            calls: Cell::new(0),
            response: FirstWriteLoopbackResponse {
                status: 207,
                ..Default::default()
            },
        };
        let result = evaluate_write_grade_read_only_probe_with_client(
            Err("real-transport-w3-write-grade-registry-source-refused"),
            &client,
        );
        assert_eq!(client.calls.get(), 0);
        assert!(!result.network_attempted);
        assert!(!result.receipt_consumed);
        assert!(!result.consumed_marker_created);
        assert!(!result.writes_webdav);
    }

    #[test]
    fn first_write_loopback_proves_create_only_sequence_without_network() {
        let request = first_write_request();
        let result = evaluate_first_write_with_client(
            Some(request.clone()),
            &MockFirstWriteLoopbackClient::default(),
        );
        assert!(result.ok);
        assert!(result.mock_only);
        assert!(result.gate_satisfied);
        assert!(!result.network_attempted);
        assert!(result.loopback_attempted);
        assert_eq!(result.create_only_behavior, "loopback-201-then-412");
        assert_eq!(
            result.method_statuses,
            vec![
                RtFirstWriteMethodStatus {
                    operation: "PROPFIND pre-write absence check",
                    status_code: 404,
                    status_family: "4xx",
                    loopback_only: true,
                },
                RtFirstWriteMethodStatus {
                    operation: "PUT create-only #1",
                    status_code: 201,
                    status_family: "2xx",
                    loopback_only: true,
                },
                RtFirstWriteMethodStatus {
                    operation: "PUT create-only #2",
                    status_code: 412,
                    status_family: "4xx",
                    loopback_only: true,
                },
                RtFirstWriteMethodStatus {
                    operation: "GET read-back",
                    status_code: 200,
                    status_family: "2xx",
                    loopback_only: true,
                },
            ]
        );
        assert_eq!(
            result.write_grade_registry_ref_hash,
            request.write_grade_registry_ref_hash
        );
        assert!(!result.writes_webdav);
        assert!(!result.enqueues_relay);
        assert!(!result.mints_export_id);
        assert!(!result.burns_sequence);
        assert!(!result.product_sync_ready);
        assert!(!result.transport_ready);
    }

    #[test]
    fn first_write_loopback_rejects_existing_target_redirect_auth_timeout_and_readback_mismatch() {
        let cases = [
            (
                MockFirstWriteLoopbackClient {
                    propfind: FirstWriteLoopbackResponse {
                        status: 207,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                "real-transport-w3-first-write-target-exists",
            ),
            (
                MockFirstWriteLoopbackClient {
                    first_put: FirstWriteLoopbackResponse {
                        status: 302,
                        redirected: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                "real-transport-w3-first-write-redirect-refused",
            ),
            (
                MockFirstWriteLoopbackClient {
                    first_put: FirstWriteLoopbackResponse {
                        status: 401,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                "real-transport-w3-first-write-auth-refused",
            ),
            (
                MockFirstWriteLoopbackClient {
                    first_put: FirstWriteLoopbackResponse {
                        status: 0,
                        timeout_after_send: true,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                "real-transport-w3-first-write-remote-write-uncertain",
            ),
            (
                MockFirstWriteLoopbackClient {
                    second_put: FirstWriteLoopbackResponse {
                        status: 201,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                "real-transport-w3-first-write-create-only-not-enforced",
            ),
            (
                MockFirstWriteLoopbackClient {
                    readback: FirstWriteLoopbackResponse {
                        status: 200,
                        body: b"wrong-redacted-loopback-body".to_vec(),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                "real-transport-w3-first-write-readback-hash-mismatch",
            ),
        ];
        for (client, blocker) in cases {
            let result = evaluate_first_write_with_client(Some(first_write_request()), &client);
            assert!(!result.ok, "{blocker}");
            assert!(result.blockers.contains(&blocker), "{blocker}");
            assert!(!result.network_attempted);
            assert!(result.loopback_attempted);
            assert!(!result.writes_webdav);
            assert!(!result.product_sync_ready);
            assert!(!result.transport_ready);
        }
    }
}
