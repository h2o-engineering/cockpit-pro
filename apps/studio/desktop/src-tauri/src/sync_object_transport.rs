//! Round 2A single-object publish/pull state machine.
//!
//! Domain projection and local apply stay in JavaScript.  This module accepts
//! bounded canonical JSON text, recomputes all path identities, performs only
//! internally-derived WebDAV operations, and returns redacted transport facts.

use crate::sync_object_document::{
    canonical_head, canonical_value, is_lower_hex_64, object_key_hex, sha256_hex, valid_identity,
    SyncRevision, HEAD_SCHEMA, REVISION_SCHEMA,
};
use crate::webdav_transport_core::{
    derive_object_paths, ensure_remote_object_layout_detailed, exact_location_or_absent,
    require_strong_etag, DispatchFailure, Method, ReqwestWebDavTransport, WebDavRequest,
    WebDavResponse, WebDavTransport, MAX_REVISION_BYTES,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Manager, State};
use tauri_plugin_sql::DbInstances;

/* O1-B2.1: the native writer-generation gate this command consults. */
use crate::p01_generation_gate::GenerationObservation;

/* The revision/head document authority now lives in `sync_object_document`.
 * Re-exported here so the existing `sync_object_transport::SyncHead` path keeps
 * resolving exactly as before this move. */
pub use crate::sync_object_document::SyncHead;

const PROFILE_LOCK_FILE: &str = ".round2a-profile-runtime.lock";

#[derive(Debug)]
struct ProfileRuntimeSession {
    _file: File,
    lock_path: PathBuf,
    boot_id: String,
}

impl ProfileRuntimeSession {
    fn acquire_at(profile_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(profile_dir)
            .map_err(|_| "round2a-profile-runtime-lock-unavailable")?;
        let lock_path = profile_dir.join(PROFILE_LOCK_FILE);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&lock_path)
            .map_err(|_| "round2a-profile-runtime-lock-unavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "round2a-profile-runtime-lock-unavailable")?;
        }
        file.try_lock()
            .map_err(|_| "round2a-profile-runtime-busy")?;
        let mut entropy = [0_u8; 32];
        File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut entropy))
            .map_err(|_| "round2a-profile-runtime-entropy-unavailable")?;
        Ok(Self {
            _file: file,
            lock_path,
            boot_id: entropy.iter().map(|byte| format!("{byte:02x}")).collect(),
        })
    }
}

static PROFILE_RUNTIME_SESSION: OnceLock<Mutex<Option<Arc<ProfileRuntimeSession>>>> =
    OnceLock::new();

fn require_profile_runtime_session(
    app: &tauri::AppHandle,
) -> Result<Arc<ProfileRuntimeSession>, String> {
    let profile_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "round2a-profile-runtime-lock-unavailable")?;
    let slot = PROFILE_RUNTIME_SESSION.get_or_init(|| Mutex::new(None));
    let mut guard = slot
        .lock()
        .map_err(|_| "round2a-profile-runtime-lock-unavailable")?;
    if let Some(session) = guard.as_ref() {
        if session.lock_path != profile_dir.join(PROFILE_LOCK_FILE) {
            return Err("round2a-profile-runtime-busy".into());
        }
        return Ok(Arc::clone(session));
    }
    let session = Arc::new(ProfileRuntimeSession::acquire_at(&profile_dir)?);
    *guard = Some(Arc::clone(&session));
    Ok(session)
}

/*
 * The live session's boot identity, for authorities that must prove a request
 * came from the process holding the profile lock rather than a stale or
 * foreign one. Acquires the lock if it is not yet held, exactly as every other
 * caller does, so the identity returned is always a live one.
 */
pub(crate) fn live_session_boot_id(app: &tauri::AppHandle) -> Result<String, String> {
    Ok(require_profile_runtime_session(app)?.boot_id.clone())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSessionResponse {
    boot_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedHead {
    pub revision_id: String,
    pub revision_blob_sha256_hex: String,
    pub strong_etag: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishTransportRequest {
    pub object_id: String,
    pub object_key_hex: String,
    pub revision_id: String,
    pub payload_sha256_hex: String,
    pub revision_blob_text: String,
    pub revision_blob_sha256_hex: String,
    pub writer_sync_peer_id: String,
    pub source_updated_at_iso: String,
    pub expected_head: Option<ExpectedHead>,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PublishTransportResponse {
    pub ok: bool,
    pub verdict: String,
    pub conflict_class: Option<String>,
    pub created_revision: bool,
    pub revision_already_present_verified: bool,
    pub head_created: bool,
    pub head_updated: bool,
    pub unchanged_no_op: bool,
    pub revision_readback_verified: bool,
    pub head_readback_verified: bool,
    pub new_head_strong_etag: Option<String>,
    pub new_head_strong_etag_sha256_hex: Option<String>,
    pub remote_revision_id: Option<String>,
    pub remote_revision_blob_sha256_hex: Option<String>,
    pub error_code: Option<String>,
    pub http_status: Option<u16>,
    pub remote_side_effect_uncertain: bool,
}

impl PublishTransportResponse {
    fn failed(code: &str, conflict: Option<&str>) -> Self {
        Self::failed_with_details(code, conflict, None, false)
    }

    fn failed_with_http_status(
        code: &str,
        conflict: Option<&str>,
        http_status: Option<u16>,
    ) -> Self {
        Self::failed_with_details(code, conflict, http_status, false)
    }

    fn uncertain(code: &str, http_status: Option<u16>) -> Self {
        Self::failed_with_details(code, None, http_status, true)
    }

    fn failed_with_details(
        code: &str,
        conflict: Option<&str>,
        http_status: Option<u16>,
        remote_side_effect_uncertain: bool,
    ) -> Self {
        Self {
            verdict: "blocked".into(),
            conflict_class: conflict.map(str::to_string),
            error_code: Some(code.into()),
            http_status,
            remote_side_effect_uncertain,
            ..Self::default()
        }
    }
}

fn publish_conflict_class(code: &str) -> Option<&str> {
    matches!(
        code,
        "concurrent-writer"
            | "same-revision-divergent-hash"
            | "stale-head-etag"
            | "unexpected-remote-object"
            | "round2a-head-put-409"
            | "round2a-revision-blob-divergent"
            | "round2a-strong-etag-required"
    )
    .then_some(code)
}

fn publish_step_failure_response(failure: PublishStepFailure) -> PublishTransportResponse {
    PublishTransportResponse::failed_with_details(
        &failure.code,
        publish_conflict_class(&failure.code),
        failure.http_status,
        failure.remote_side_effect_uncertain,
    )
}

fn publish_get_failure_response(
    failure: GetFailure,
    remote_side_effect_uncertain: bool,
) -> PublishTransportResponse {
    PublishTransportResponse::failed_with_details(
        &failure.code,
        publish_conflict_class(&failure.code),
        failure.http_status,
        remote_side_effect_uncertain,
    )
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PullTransportRequest {
    pub object_id: String,
    pub object_key_hex: String,
    pub max_revision_bytes: usize,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PullTransportResponse {
    pub ok: bool,
    pub verdict: String,
    pub head_present: bool,
    pub head: Option<SyncHead>,
    pub head_canonical_text: Option<String>,
    pub head_strong_etag: Option<String>,
    pub revision_blob_text: Option<String>,
    pub transport_verified: bool,
    pub error_code: Option<String>,
    pub http_status: Option<u16>,
}

impl PullTransportResponse {
    fn failed(code: &str) -> Self {
        Self::failed_with_http_status(code, None)
    }

    fn failed_with_http_status(code: &str, http_status: Option<u16>) -> Self {
        Self {
            verdict: "blocked".into(),
            error_code: Some(code.into()),
            http_status,
            ..Self::default()
        }
    }
}

fn validate_publish(request: &PublishTransportRequest) -> Result<SyncRevision, String> {
    if !valid_identity(&request.object_id)
        || !valid_identity(&request.revision_id)
        || !valid_identity(&request.writer_sync_peer_id)
        || request.source_updated_at_iso.len() < 20
        || request.source_updated_at_iso.len() > 40
        || !request.source_updated_at_iso.ends_with('Z')
        || !is_lower_hex_64(&request.object_key_hex)
        || !is_lower_hex_64(&request.payload_sha256_hex)
        || !is_lower_hex_64(&request.revision_blob_sha256_hex)
        || request.revision_blob_text.as_bytes().len() > MAX_REVISION_BYTES
    {
        return Err("round2a-publish-request-invalid".into());
    }
    if object_key_hex(&request.object_id) != request.object_key_hex {
        return Err("round2a-object-key-mismatch".into());
    }
    if sha256_hex(request.revision_blob_text.as_bytes()) != request.revision_blob_sha256_hex {
        return Err("round2a-revision-blob-hash-mismatch".into());
    }
    let value: Value = serde_json::from_str(&request.revision_blob_text)
        .map_err(|_| "round2a-revision-blob-invalid")?;
    if canonical_value(&value)? != request.revision_blob_text {
        return Err("round2a-revision-blob-not-canonical".into());
    }
    let revision: SyncRevision =
        serde_json::from_value(value).map_err(|_| "round2a-revision-envelope-invalid")?;
    if revision.schema != REVISION_SCHEMA
        || revision.object_id != request.object_id
        || revision.object_key != request.object_key_hex
        || revision.revision_id != request.revision_id
        || revision.payload_sha256 != request.payload_sha256_hex
        || sha256_hex(canonical_value(&revision.payload)?.as_bytes()) != request.payload_sha256_hex
    {
        return Err("round2a-revision-envelope-mismatch".into());
    }
    if let Some(expected) = &request.expected_head {
        if !valid_identity(&expected.revision_id)
            || !is_lower_hex_64(&expected.revision_blob_sha256_hex)
            || !is_strong_etag_text(&expected.strong_etag)
        {
            return Err("round2a-publish-request-invalid".into());
        }
    }
    Ok(revision)
}

fn is_strong_etag_text(value: &str) -> bool {
    let opaque = value.get(1..value.len().saturating_sub(1)).unwrap_or("");
    value.len() > 2
        && value.starts_with('"')
        && value.ends_with('"')
        && !value.starts_with("W/")
        && opaque
            .bytes()
            .all(|byte| byte == b'!' || (b'#'..=b'~').contains(&byte))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GetFailure {
    code: String,
    http_status: Option<u16>,
}

impl GetFailure {
    fn new(code: &str, http_status: Option<u16>) -> Self {
        Self {
            code: code.into(),
            http_status,
        }
    }
}

fn get_response_detailed<T: WebDavTransport>(
    transport: &mut T,
    path: &str,
    max: usize,
) -> Result<Option<WebDavResponse>, GetFailure> {
    let mut request = WebDavRequest::new(Method::Get, path);
    request.max_response_bytes = max;
    let response = transport.execute(request).map_err(|error| match error {
        DispatchFailure::ResponseTooLarge => GetFailure::new("round2a-response-too-large", None),
        DispatchFailure::Redirect => GetFailure::new("round2a-get-redirect-refused", None),
        _ => GetFailure::new("round2a-get-failed", None),
    })?;
    match response.status {
        200 => Ok(Some(response)),
        404 => Ok(None),
        401 => Err(GetFailure::new(
            "round2a-get-authentication-required",
            Some(401),
        )),
        403 => Err(GetFailure::new("round2a-get-access-forbidden", Some(403))),
        405 => Err(GetFailure::new("round2a-get-method-not-allowed", Some(405))),
        status @ 300..=399 => Err(GetFailure::new(
            "round2a-get-redirect-refused",
            Some(status),
        )),
        status @ 400..=499 => Err(GetFailure::new("round2a-get-client-error", Some(status))),
        status @ 500..=599 => Err(GetFailure::new("round2a-get-server-error", Some(status))),
        status => Err(GetFailure::new("round2a-get-status-invalid", Some(status))),
    }
}

fn parse_head(
    response: WebDavResponse,
    object_id: &str,
    object_key: &str,
) -> Result<(SyncHead, String, Vec<u8>), String> {
    if response.body.len() > 64 * 1024 {
        return Err("round2a-head-too-large".into());
    }
    let etag = require_strong_etag(&response)?;
    let value: Value =
        serde_json::from_slice(&response.body).map_err(|_| "round2a-head-invalid")?;
    let canonical = canonical_value(&value)?;
    if canonical.as_bytes() != response.body {
        return Err("round2a-head-not-canonical".into());
    }
    let head: SyncHead = serde_json::from_value(value).map_err(|_| "round2a-head-invalid")?;
    if head.schema != HEAD_SCHEMA
        || head.object_id != object_id
        || head.object_key != object_key
        || !valid_identity(&head.revision_id)
        || !is_lower_hex_64(&head.payload_sha256)
        || !is_lower_hex_64(&head.revision_blob_sha256)
        || !valid_identity(&head.writer_sync_peer_id)
        || !head.source_updated_at_iso.ends_with('Z')
    {
        return Err("unexpected-remote-object".into());
    }
    Ok((head, etag, response.body))
}

fn exact_revision_detailed<T: WebDavTransport>(
    transport: &mut T,
    path: &str,
    intended: &[u8],
    hash: &str,
) -> Result<bool, GetFailure> {
    let Some(response) = get_response_detailed(transport, path, MAX_REVISION_BYTES)? else {
        return Ok(false);
    };
    if sha256_hex(&response.body) != hash || response.body != intended {
        return Err(GetFailure::new(
            "round2a-revision-blob-divergent",
            Some(200),
        ));
    }
    Ok(true)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PublishStepFailure {
    code: String,
    http_status: Option<u16>,
    remote_side_effect_uncertain: bool,
}

impl PublishStepFailure {
    fn terminal(code: &str, http_status: Option<u16>) -> Self {
        Self {
            code: code.into(),
            http_status,
            remote_side_effect_uncertain: false,
        }
    }

    fn uncertain(code: &str, http_status: Option<u16>) -> Self {
        Self {
            code: code.into(),
            http_status,
            remote_side_effect_uncertain: true,
        }
    }

    fn uncertain_get(failure: GetFailure) -> Self {
        Self::uncertain(&failure.code, failure.http_status)
    }
}

fn revision_proof_after_put<T: WebDavTransport>(
    transport: &mut T,
    path: &str,
    bytes: &[u8],
    hash: &str,
    created: bool,
) -> Result<(bool, bool), PublishStepFailure> {
    match exact_revision_detailed(transport, path, bytes, hash) {
        Ok(true) => Ok((created, !created)),
        Ok(false) => Err(PublishStepFailure::uncertain(
            "round2a-revision-readback-missing",
            Some(404),
        )),
        Err(failure) if failure.code == "round2a-revision-blob-divergent" => Err(
            PublishStepFailure::terminal(&failure.code, failure.http_status),
        ),
        Err(failure) => Err(PublishStepFailure::uncertain_get(failure)),
    }
}

fn publish_revision<T: WebDavTransport>(
    transport: &mut T,
    path: &str,
    bytes: &[u8],
    hash: &str,
) -> Result<(bool, bool), PublishStepFailure> {
    for attempt in 0..2 {
        let mut request = WebDavRequest::new(Method::Put, path);
        request.headers.insert("if-none-match".into(), "*".into());
        request.headers.insert(
            "content-type".into(),
            "application/json; charset=utf-8".into(),
        );
        request.body = bytes.to_vec();
        request.max_response_bytes = 64 * 1024;
        match transport.execute(request) {
            Ok(response) => match response.status {
                201 => return revision_proof_after_put(transport, path, bytes, hash, true),
                412 => return revision_proof_after_put(transport, path, bytes, hash, false),
                401 => {
                    return Err(PublishStepFailure::terminal(
                        "round2a-revision-put-authentication-required",
                        Some(401),
                    ))
                }
                403 => {
                    return Err(PublishStepFailure::terminal(
                        "round2a-revision-put-access-forbidden",
                        Some(403),
                    ))
                }
                405 => {
                    return Err(PublishStepFailure::terminal(
                        "round2a-revision-put-method-not-allowed",
                        Some(405),
                    ))
                }
                409 => {
                    return Err(PublishStepFailure::terminal(
                        "round2a-revision-put-409",
                        Some(409),
                    ))
                }
                423 => {
                    return Err(PublishStepFailure::terminal(
                        "round2a-revision-put-locked",
                        Some(423),
                    ))
                }
                status @ 300..=399 => {
                    return Err(PublishStepFailure::uncertain(
                        "round2a-revision-put-redirect-refused",
                        Some(status),
                    ))
                }
                status @ 500..=599 => {
                    return Err(PublishStepFailure::uncertain(
                        "round2a-revision-put-server-error",
                        Some(status),
                    ))
                }
                status @ 400..=499 => {
                    return Err(PublishStepFailure::terminal(
                        "round2a-revision-put-failed",
                        Some(status),
                    ))
                }
                status => {
                    return Err(PublishStepFailure::uncertain(
                        "round2a-revision-put-failed",
                        Some(status),
                    ))
                }
            },
            Err(dispatch) => match exact_revision_detailed(transport, path, bytes, hash) {
                Ok(true) => return Ok((true, false)),
                Ok(false) if attempt == 0 => continue,
                Ok(false) => {
                    let code = match dispatch {
                        DispatchFailure::SideEffectUncertain => {
                            "round2a-revision-timeout-unresolved"
                        }
                        DispatchFailure::ResponseTooLarge => "round2a-response-too-large",
                        DispatchFailure::Redirect => "round2a-revision-put-redirect-refused",
                        DispatchFailure::Rejected => "round2a-revision-put-failed",
                    };
                    return Err(PublishStepFailure::uncertain(code, None));
                }
                Err(failure) if failure.code == "round2a-revision-blob-divergent" => {
                    return Err(PublishStepFailure::terminal(
                        &failure.code,
                        failure.http_status,
                    ))
                }
                Err(failure) => {
                    return Err(PublishStepFailure::uncertain_get(failure));
                }
            },
        }
    }
    Err(PublishStepFailure::uncertain(
        "round2a-revision-timeout-unresolved",
        None,
    ))
}

fn read_head_detailed<T: WebDavTransport>(
    transport: &mut T,
    path: &str,
    object_id: &str,
    object_key: &str,
) -> Result<Option<(SyncHead, String, Vec<u8>)>, GetFailure> {
    get_response_detailed(transport, path, 64 * 1024)?
        .map(|response| {
            parse_head(response, object_id, object_key)
                .map_err(|code| GetFailure::new(&code, Some(200)))
        })
        .transpose()
}

fn put_head<T: WebDavTransport>(
    transport: &mut T,
    path: &str,
    bytes: &[u8],
    observed_etag: Option<&str>,
) -> Result<WebDavResponse, PublishStepFailure> {
    let mut request = WebDavRequest::new(Method::Put, path);
    match observed_etag {
        Some(etag) if is_strong_etag_text(etag) => {
            request.headers.insert("if-match".into(), etag.into());
        }
        Some(_) => {
            return Err(PublishStepFailure::terminal(
                "round2a-strong-etag-required",
                None,
            ))
        }
        None => {
            request.headers.insert("if-none-match".into(), "*".into());
        }
    }
    request.headers.insert(
        "content-type".into(),
        "application/json; charset=utf-8".into(),
    );
    request.body = bytes.to_vec();
    request.max_response_bytes = 64 * 1024;
    transport.execute(request).map_err(|error| {
        let code = match error {
            DispatchFailure::SideEffectUncertain => "round2a-head-put-uncertain",
            DispatchFailure::ResponseTooLarge => "round2a-response-too-large",
            DispatchFailure::Redirect => "round2a-head-put-redirect-refused",
            DispatchFailure::Rejected => "round2a-head-put-failed",
        };
        PublishStepFailure::uncertain(code, None)
    })
}

pub fn publish_with_transport<T: WebDavTransport>(
    transport: &mut T,
    request: PublishTransportRequest,
) -> PublishTransportResponse {
    if let Err(code) = validate_publish(&request) {
        return PublishTransportResponse::failed(&code, None);
    }
    let paths =
        match derive_object_paths(&request.object_key_hex, &request.revision_blob_sha256_hex) {
            Ok(paths) => paths,
            Err(code) => return PublishTransportResponse::failed(&code, None),
        };
    if let Err(failure) = ensure_remote_object_layout_detailed(transport, &request.object_key_hex) {
        return PublishTransportResponse::failed_with_details(
            &failure.code,
            None,
            failure.http_status,
            failure.remote_side_effect_uncertain,
        );
    }
    let current = match read_head_detailed(
        transport,
        &paths.head,
        &request.object_id,
        &request.object_key_hex,
    ) {
        Ok(current) => current,
        Err(failure) => return publish_get_failure_response(failure, false),
    };
    if let Some((head, _, _)) = &current {
        if head.revision_blob_sha256 == request.revision_blob_sha256_hex {
            return match exact_revision_detailed(
                transport,
                &paths.revision,
                request.revision_blob_text.as_bytes(),
                &request.revision_blob_sha256_hex,
            ) {
                Ok(true) => PublishTransportResponse {
                    ok: true,
                    verdict: "unchanged-no-op".into(),
                    unchanged_no_op: true,
                    revision_readback_verified: true,
                    remote_revision_id: Some(head.revision_id.clone()),
                    remote_revision_blob_sha256_hex: Some(head.revision_blob_sha256.clone()),
                    ..PublishTransportResponse::default()
                },
                Ok(false) => {
                    PublishTransportResponse::failed("round2a-revision-readback-missing", None)
                }
                Err(failure) => publish_get_failure_response(failure, false),
            };
        }
        if head.revision_id == request.revision_id {
            return PublishTransportResponse::failed(
                "same-revision-divergent-hash",
                Some("same-revision-divergent-hash"),
            );
        }
    }
    match (&request.expected_head, &current) {
        (Some(expected), Some((head, etag, _)))
            if expected.revision_id == head.revision_id
                && expected.revision_blob_sha256_hex == head.revision_blob_sha256
                && expected.strong_etag == *etag => {}
        (None, None) => {}
        (None, Some(_)) => {
            return PublishTransportResponse::failed("concurrent-writer", Some("concurrent-writer"))
        }
        _ => return PublishTransportResponse::failed("stale-head-etag", Some("stale-head-etag")),
    }
    let (created_revision, already_present) = match publish_revision(
        transport,
        &paths.revision,
        request.revision_blob_text.as_bytes(),
        &request.revision_blob_sha256_hex,
    ) {
        Ok(outcome) => outcome,
        Err(failure) => return publish_step_failure_response(failure),
    };
    let head = SyncHead {
        schema: HEAD_SCHEMA.into(),
        object_id: request.object_id.clone(),
        object_key: request.object_key_hex.clone(),
        revision_id: request.revision_id.clone(),
        payload_sha256: request.payload_sha256_hex.clone(),
        revision_blob_sha256: request.revision_blob_sha256_hex.clone(),
        writer_sync_peer_id: request.writer_sync_peer_id,
        previous_revision_id: current
            .as_ref()
            .map(|(head, _, _)| head.revision_id.clone()),
        source_updated_at_iso: request.source_updated_at_iso,
    };
    let head_text = match canonical_head(&head) {
        Ok(text) => text,
        Err(code) => return PublishTransportResponse::failed(&code, None),
    };
    let observed_etag = current.as_ref().map(|(_, etag, _)| etag.as_str());
    let put = match put_head(transport, &paths.head, head_text.as_bytes(), observed_etag) {
        Ok(response) => response,
        Err(failure) if failure.remote_side_effect_uncertain => {
            match read_head_detailed(
                transport,
                &paths.head,
                &request.object_id,
                &request.object_key_hex,
            ) {
                Ok(Some((remote, etag, bytes)))
                    if remote == head && bytes == head_text.as_bytes() =>
                {
                    return success_publish_response(
                        &head,
                        etag,
                        created_revision,
                        already_present,
                        current.is_none(),
                        current.is_some(),
                    );
                }
                Ok(Some(_)) => {
                    return PublishTransportResponse::failed(
                        "stale-head-etag",
                        Some("stale-head-etag"),
                    )
                }
                Ok(None) => return publish_step_failure_response(failure),
                Err(read_failure) => {
                    return publish_get_failure_response(read_failure, true);
                }
            }
        }
        Err(failure) => return publish_step_failure_response(failure),
    };
    match put.status {
        201 => {
            if let Err(code) = exact_location_or_absent(&put) {
                return PublishTransportResponse::uncertain(&code, Some(201));
            }
        }
        204 if current.is_some() => {}
        412 => {
            return match read_head_detailed(
                transport,
                &paths.head,
                &request.object_id,
                &request.object_key_hex,
            ) {
                Ok(Some((remote, etag, bytes)))
                    if remote == head && bytes == head_text.as_bytes() =>
                {
                    success_publish_response(
                        &head,
                        etag,
                        created_revision,
                        already_present,
                        current.is_none(),
                        current.is_some(),
                    )
                }
                Ok(_) => {
                    PublishTransportResponse::failed("stale-head-etag", Some("stale-head-etag"))
                }
                Err(failure) => publish_get_failure_response(failure, true),
            };
        }
        409 => {
            return PublishTransportResponse::failed_with_http_status(
                "round2a-head-put-409",
                Some("round2a-head-put-409"),
                Some(409),
            )
        }
        401 => {
            return PublishTransportResponse::failed_with_http_status(
                "round2a-head-put-authentication-required",
                None,
                Some(401),
            )
        }
        403 => {
            return PublishTransportResponse::failed_with_http_status(
                "round2a-head-put-access-forbidden",
                None,
                Some(403),
            )
        }
        405 => {
            return PublishTransportResponse::failed_with_http_status(
                "round2a-head-put-method-not-allowed",
                None,
                Some(405),
            )
        }
        423 => {
            return PublishTransportResponse::failed_with_http_status(
                "round2a-head-put-locked",
                None,
                Some(423),
            )
        }
        status @ 300..=399 => {
            return PublishTransportResponse::uncertain(
                "round2a-head-put-redirect-refused",
                Some(status),
            )
        }
        status @ 500..=599 => {
            return PublishTransportResponse::uncertain(
                "round2a-head-put-server-error",
                Some(status),
            )
        }
        status @ 400..=499 => {
            return PublishTransportResponse::failed_with_http_status(
                "round2a-head-put-failed",
                None,
                Some(status),
            )
        }
        status => {
            return PublishTransportResponse::uncertain("round2a-head-put-failed", Some(status))
        }
    }
    match read_head_detailed(
        transport,
        &paths.head,
        &request.object_id,
        &request.object_key_hex,
    ) {
        Ok(Some((remote, etag, bytes))) if remote == head && bytes == head_text.as_bytes() => {
            success_publish_response(
                &head,
                etag,
                created_revision,
                already_present,
                current.is_none(),
                current.is_some(),
            )
        }
        Ok(Some(_)) => PublishTransportResponse::failed("stale-head-etag", Some("stale-head-etag")),
        Ok(None) => {
            PublishTransportResponse::uncertain("round2a-head-readback-mismatch", Some(404))
        }
        Err(failure) => publish_get_failure_response(failure, true),
    }
}

fn success_publish_response(
    head: &SyncHead,
    etag: String,
    created_revision: bool,
    already_present: bool,
    head_created: bool,
    head_updated: bool,
) -> PublishTransportResponse {
    PublishTransportResponse {
        ok: true,
        verdict: "published".into(),
        created_revision,
        revision_already_present_verified: already_present,
        head_created,
        head_updated,
        revision_readback_verified: true,
        head_readback_verified: true,
        new_head_strong_etag_sha256_hex: Some(sha256_hex(etag.as_bytes())),
        new_head_strong_etag: Some(etag),
        remote_revision_id: Some(head.revision_id.clone()),
        remote_revision_blob_sha256_hex: Some(head.revision_blob_sha256.clone()),
        ..PublishTransportResponse::default()
    }
}

pub fn pull_with_transport<T: WebDavTransport>(
    transport: &mut T,
    request: PullTransportRequest,
) -> PullTransportResponse {
    if !valid_identity(&request.object_id)
        || object_key_hex(&request.object_id) != request.object_key_hex
        || request.max_revision_bytes == 0
        || request.max_revision_bytes > MAX_REVISION_BYTES
    {
        return PullTransportResponse::failed("round2a-pull-request-invalid");
    }
    let placeholder = "0".repeat(64);
    let paths = match derive_object_paths(&request.object_key_hex, &placeholder) {
        Ok(paths) => paths,
        Err(code) => return PullTransportResponse::failed(&code),
    };
    let Some((head, etag, head_bytes)) = (match read_head_detailed(
        transport,
        &paths.head,
        &request.object_id,
        &request.object_key_hex,
    ) {
        Ok(head) => head,
        Err(failure) => {
            return PullTransportResponse::failed_with_http_status(
                &failure.code,
                failure.http_status,
            )
        }
    }) else {
        return PullTransportResponse {
            ok: true,
            verdict: "head-absent".into(),
            ..PullTransportResponse::default()
        };
    };
    let revision_path =
        match derive_object_paths(&request.object_key_hex, &head.revision_blob_sha256) {
            Ok(paths) => paths.revision,
            Err(code) => return PullTransportResponse::failed(&code),
        };
    let Some(revision) =
        (match get_response_detailed(transport, &revision_path, request.max_revision_bytes) {
            Ok(revision) => revision,
            Err(failure) => {
                return PullTransportResponse::failed_with_http_status(
                    &failure.code,
                    failure.http_status,
                )
            }
        })
    else {
        return PullTransportResponse::failed("round2a-revision-readback-missing");
    };
    let Ok(head_canonical_text) = String::from_utf8(head_bytes) else {
        return PullTransportResponse::failed("round2a-head-invalid");
    };
    if sha256_hex(&revision.body) != head.revision_blob_sha256 {
        return PullTransportResponse::failed("round2a-revision-blob-divergent");
    }
    let Ok(text) = String::from_utf8(revision.body) else {
        return PullTransportResponse::failed("round2a-revision-blob-invalid");
    };
    PullTransportResponse {
        ok: true,
        verdict: "transport-verified".into(),
        head_present: true,
        head: Some(head),
        head_canonical_text: Some(head_canonical_text),
        head_strong_etag: Some(etag),
        revision_blob_text: Some(text),
        transport_verified: true,
        error_code: None,
        http_status: None,
    }
}

fn production_transport(command: &'static str) -> Result<ReqwestWebDavTransport, String> {
    let resolved =
        crate::real_transport_capability_probe::resolve_write_grade_live_registry(command)
            .map_err(str::to_string)?;
    let endpoint = resolved
        .registry
        .endpoint_url_private
        .ok_or_else(|| "round2a-descriptor-endpoint-missing".to_string())?;
    let root = resolved
        .registry
        .remote_root_path_private
        .ok_or_else(|| "round2a-descriptor-namespace-missing".to_string())?;
    let credential = resolved
        .registry
        .auth_header_private
        .ok_or_else(|| "round2a-descriptor-credential-missing".to_string())?;
    ReqwestWebDavTransport::new(&endpoint, &root, credential)
}

#[tauri::command]
pub fn h2o_sync_object_runtime_session(
    app: tauri::AppHandle,
) -> Result<RuntimeSessionResponse, String> {
    let session = require_profile_runtime_session(&app)?;
    Ok(RuntimeSessionResponse {
        boot_id: session.boot_id.clone(),
    })
}

/*
 * O1-B2.1 - the writer-generation gate, on this side of the boundary.
 *
 * A Tauri command is reachable from anything running in the webview, so the JS
 * gate inside `publishObject` refuses only for callers that go through the JS.
 * This command writes the revision blob and the head document to the real
 * destination, which makes it a P01 mutation path in its own right - and the
 * accepted T19 contract binds paths, not layers: every P01 path that can
 * MUTATE must consult the generation and refuse when the answer is p02.
 *
 * The refusal is a `blocked` response rather than an `Err`, because that is the
 * shape every other refusal in this command already takes. Gating changes what
 * the answer IS, never what it looks like.
 */
fn generation_refusal(observation: &GenerationObservation) -> Option<PublishTransportResponse> {
    match crate::p01_generation_gate::permits_p01_mutation(observation) {
        Ok(()) => None,
        Err(code) => Some(PublishTransportResponse::failed(code, None)),
    }
}

/*
 * Publish under an observed generation.
 *
 * Split out from the command so a test can hold the transport and prove a
 * denied generation never reaches it. "Refused" and "wrote nothing" are two
 * separate claims, and only the second one is the point of a standdown.
 */
pub(crate) fn publish_under_generation<T: WebDavTransport>(
    observation: &GenerationObservation,
    transport: &mut T,
    request: PublishTransportRequest,
) -> PublishTransportResponse {
    match generation_refusal(observation) {
        Some(refusal) => refusal,
        None => publish_with_transport(transport, request),
    }
}

#[tauri::command]
pub async fn h2o_sync_object_publish_transport(
    app: tauri::AppHandle,
    db_instances: State<'_, DbInstances>,
    request: PublishTransportRequest,
) -> Result<PublishTransportResponse, String> {
    /*
     * Every path returns `Ok`. The JS caller has always received a response
     * object and reads `verdict`/`error_code` from it; turning a refusal into a
     * rejected promise would be a new contract for it to learn.
     *
     * The profile-session check stays FIRST and unchanged, so its precedence is
     * exactly what it was. Observing the generation before that would do a
     * database read on behalf of a caller not yet known to hold the lock.
     */
    if let Err(code) = require_profile_runtime_session(&app) {
        return Ok(PublishTransportResponse::failed(&code, None));
    }
    let observation = crate::p01_generation_gate::observe_generation(&db_instances).await;
    /* Refuse before a transport exists at all: a stood-down P01 has no business
     * resolving the credential registry, let alone opening a connection. */
    if let Some(refusal) = generation_refusal(&observation) {
        return Ok(refusal);
    }
    Ok(
        match production_transport("h2o_sync_object_publish_transport") {
            /* Checked again at the publish itself, against the same observation,
             * so the refusal is structurally inseparable from the write rather
             * than a guard someone can later reorder away from it. */
            Ok(mut transport) => publish_under_generation(&observation, &mut transport, request),
            Err(code) => PublishTransportResponse::failed(&code, None),
        },
    )
}

#[tauri::command]
pub fn h2o_sync_object_pull_transport(
    app: tauri::AppHandle,
    request: PullTransportRequest,
) -> PullTransportResponse {
    if let Err(code) = require_profile_runtime_session(&app) {
        return PullTransportResponse::failed(&code);
    }
    match production_transport("h2o_sync_object_pull_transport") {
        Ok(mut transport) => pull_with_transport(&mut transport, request),
        Err(code) => PullTransportResponse::failed(&code),
    }
}

/// Process-local guard complements the single-statement SQLite acquisition.
/// It prevents two commands in one Desktop process from racing to adopt a
/// pending operation while the durable row provides restart recovery.
#[derive(Default)]
pub struct LocalOperationGate(Mutex<BTreeSet<(String, String)>>);

impl LocalOperationGate {
    pub fn try_acquire(&self, peer: &str, object: &str) -> bool {
        self.0
            .lock()
            .expect("local operation gate poisoned")
            .insert((peer.into(), object.into()))
    }

    pub fn release(&self, peer: &str, object: &str) {
        self.0
            .lock()
            .expect("local operation gate poisoned")
            .remove(&(peer.into(), object.into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::webdav_transport_core::{Method, SafeDispatchCategory};
    use std::collections::BTreeMap;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Clone)]
    struct Entry {
        collection: bool,
        body: Vec<u8>,
        etag: Option<String>,
    }

    struct Fake {
        entries: BTreeMap<String, Entry>,
        requests: Vec<WebDavRequest>,
        next_put_status: Option<u16>,
        next_propfind_status: Option<u16>,
        next_propfind_failure: Option<DispatchFailure>,
        next_propfind_category: Option<SafeDispatchCategory>,
        next_get_status: Option<u16>,
        next_get_failure: Option<DispatchFailure>,
        weak_head_etag: bool,
        timeout_after_put: bool,
        doubled_location: bool,
    }

    impl Default for Fake {
        fn default() -> Self {
            Self {
                entries: BTreeMap::new(),
                requests: Vec::new(),
                next_put_status: None,
                next_propfind_status: None,
                next_propfind_failure: None,
                next_propfind_category: None,
                next_get_status: None,
                next_get_failure: None,
                weak_head_etag: false,
                timeout_after_put: false,
                doubled_location: false,
            }
        }
    }

    impl Fake {
        fn multistatus(path: &str) -> Vec<u8> {
            format!("<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\"><D:response><D:href>/dav/{path}/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>").into_bytes()
        }

        fn put_count(&self) -> usize {
            self.requests
                .iter()
                .filter(|request| request.method == Method::Put)
                .count()
        }
    }

    impl WebDavTransport for Fake {
        fn execute(&mut self, request: WebDavRequest) -> Result<WebDavResponse, DispatchFailure> {
            self.requests.push(request.clone());
            let path = request.relative_path.clone();
            let mut response = WebDavResponse {
                expected_href: format!("/dav/{path}/"),
                expected_url: format!("https://example.test/dav/{path}/"),
                ..WebDavResponse::default()
            };
            match request.method {
                Method::Propfind => {
                    if let Some(failure) = self.next_propfind_failure.take() {
                        return Err(failure);
                    }
                    if let Some(status) = self.next_propfind_status.take() {
                        response.status = status;
                        response.body = b"PRIVATE LAYOUT BODY MUST NOT ESCAPE".to_vec();
                        response
                            .headers
                            .insert("authorization".into(), vec!["PRIVATE".into()]);
                    } else if self
                        .entries
                        .get(&path)
                        .is_some_and(|entry| entry.collection)
                    {
                        response.status = 207;
                        response.body = Self::multistatus(&path);
                    } else {
                        response.status = 404;
                    }
                }
                Method::Mkcol => {
                    self.entries.insert(
                        path,
                        Entry {
                            collection: true,
                            body: vec![],
                            etag: None,
                        },
                    );
                    response.status = 201;
                }
                Method::Get => {
                    if let Some(failure) = self.next_get_failure.take() {
                        return Err(failure);
                    }
                    if let Some(status) = self.next_get_status.take() {
                        response.status = status;
                        response.body = b"PRIVATE RESPONSE BODY MUST NOT ESCAPE".to_vec();
                        response
                            .headers
                            .insert("authorization".into(), vec!["PRIVATE".into()]);
                    } else {
                        match self.entries.get(&path) {
                            Some(entry) if !entry.collection => {
                                response.status = 200;
                                response.body = entry.body.clone();
                                if let Some(etag) = &entry.etag {
                                    response.headers.insert(
                                        "etag".into(),
                                        vec![
                                            if self.weak_head_etag && path.ends_with("head.json") {
                                                format!("W/{etag}")
                                            } else {
                                                etag.clone()
                                            },
                                        ],
                                    );
                                }
                            }
                            _ => response.status = 404,
                        }
                    }
                }
                Method::Put => {
                    let exists = self.entries.get(&path).cloned();
                    if request
                        .headers
                        .get("if-none-match")
                        .is_some_and(|value| value == "*")
                        && exists.is_some()
                    {
                        response.status = 412;
                        return Ok(response);
                    }
                    if let Some(expected) = request.headers.get("if-match") {
                        if exists.as_ref().and_then(|entry| entry.etag.as_ref()) != Some(expected) {
                            response.status = 412;
                            return Ok(response);
                        }
                    }
                    let etag = format!("\"{}\"", &sha256_hex(&request.body)[..16]);
                    self.entries.insert(
                        path.clone(),
                        Entry {
                            collection: false,
                            body: request.body,
                            etag: Some(etag),
                        },
                    );
                    response.status = if let Some(status) = self.next_put_status.take() {
                        response.body = b"PRIVATE PUT RESPONSE MUST NOT ESCAPE".to_vec();
                        response
                            .headers
                            .insert("authorization".into(), vec!["PRIVATE".into()]);
                        status
                    } else if exists.is_some() {
                        204
                    } else {
                        201
                    };
                    if self.doubled_location && path.ends_with("head.json") {
                        response
                            .headers
                            .insert("location".into(), vec![format!("/dav//{path}")]);
                    }
                    if self.timeout_after_put {
                        self.timeout_after_put = false;
                        return Err(DispatchFailure::SideEffectUncertain);
                    }
                }
            }
            Ok(response)
        }

        fn safe_dispatch_category(&self) -> Option<SafeDispatchCategory> {
            self.next_propfind_category
        }
    }

    fn canonical(value: Value) -> String {
        canonical_value(&value).unwrap()
    }

    fn publish_request(revision: &str, payload_text: &str) -> PublishTransportRequest {
        let object_id = "synthetic-chat-1".to_string();
        let object_key = object_key_hex(&object_id);
        let payload: Value = serde_json::from_str(payload_text).unwrap();
        let payload_sha = sha256_hex(canonical(payload.clone()).as_bytes());
        let envelope = canonical(serde_json::json!({
            "schema": REVISION_SCHEMA,
            "objectId": object_id,
            "objectKey": object_key,
            "revisionId": revision,
            "payloadSha256": payload_sha,
            "payload": payload
        }));
        PublishTransportRequest {
            object_id,
            object_key_hex: object_key,
            revision_id: revision.into(),
            payload_sha256_hex: payload_sha,
            revision_blob_sha256_hex: sha256_hex(envelope.as_bytes()),
            revision_blob_text: envelope,
            writer_sync_peer_id: "peer-a".into(),
            source_updated_at_iso: "2026-07-21T10:00:00Z".into(),
            expected_head: None,
        }
    }

    fn pull_request() -> PullTransportRequest {
        let object_id = "synthetic-chat-1".to_string();
        PullTransportRequest {
            object_key_hex: object_key_hex(&object_id),
            object_id,
            max_revision_bytes: MAX_REVISION_BYTES,
        }
    }

    #[test]
    fn revision_create_readback_and_head_read_precede_revision_put() {
        let mut fake = Fake::default();
        let request = publish_request("snapshot-1", "{\"chat\":1}");
        let result = publish_with_transport(&mut fake, request);
        assert!(result.ok, "{:?}", result.error_code);
        assert!(
            result.created_revision
                && result.revision_readback_verified
                && result.head_readback_verified
        );
        let first_get = fake
            .requests
            .iter()
            .position(|request| request.method == Method::Get)
            .unwrap();
        let first_put = fake
            .requests
            .iter()
            .position(|request| request.method == Method::Put)
            .unwrap();
        assert!(first_get < first_put);
    }

    #[test]
    fn unchanged_publish_verifies_revision_and_performs_zero_puts() {
        let mut fake = Fake::default();
        let request = publish_request("snapshot-1", "{\"chat\":1}");
        assert!(publish_with_transport(&mut fake, request.clone()).ok);
        fake.requests.clear();
        let result = publish_with_transport(&mut fake, request);
        assert!(result.ok && result.unchanged_no_op);
        assert_eq!(fake.put_count(), 0);
    }

    #[test]
    fn revision_412_requires_exact_existing_bytes() {
        let mut fake = Fake::default();
        let request = publish_request("snapshot-1", "{\"chat\":1}");
        let paths = derive_object_paths(&request.object_key_hex, &request.revision_blob_sha256_hex)
            .unwrap();
        fake.entries.insert(
            paths.revision.clone(),
            Entry {
                collection: false,
                body: request.revision_blob_text.as_bytes().to_vec(),
                etag: Some("\"r\"".into()),
            },
        );
        let result = publish_with_transport(&mut fake, request);
        assert!(result.ok && result.revision_already_present_verified);
    }

    #[test]
    fn revision_409_is_hard_stop() {
        let mut fake = Fake::default();
        fake.next_put_status = Some(409);
        let result =
            publish_with_transport(&mut fake, publish_request("snapshot-1", "{\"chat\":1}"));
        assert_eq!(
            result.error_code.as_deref(),
            Some("round2a-revision-put-409")
        );
        assert_eq!(result.http_status, Some(409));
        assert!(!result.remote_side_effect_uncertain);
        assert_eq!(result.conflict_class, None);
    }

    #[test]
    fn publish_head_get_failures_are_terminal_statused_and_not_conflicts() {
        for (status, code) in [
            (401, "round2a-get-authentication-required"),
            (403, "round2a-get-access-forbidden"),
            (405, "round2a-get-method-not-allowed"),
            (409, "round2a-get-client-error"),
            (503, "round2a-get-server-error"),
            (204, "round2a-get-status-invalid"),
            (302, "round2a-get-redirect-refused"),
        ] {
            let mut fake = Fake {
                next_get_status: Some(status),
                ..Fake::default()
            };
            let result =
                publish_with_transport(&mut fake, publish_request("snapshot-1", "{\"chat\":1}"));
            assert_eq!(result.error_code.as_deref(), Some(code));
            assert_eq!(result.http_status, Some(status));
            assert_eq!(result.conflict_class, None);
            assert!(!result.remote_side_effect_uncertain);
            assert_eq!(fake.put_count(), 0);
            let serialized = serde_json::to_string(&result).unwrap();
            assert!(!serialized.contains("PRIVATE RESPONSE BODY"));
            assert!(!serialized.contains("authorization"));
            assert!(!serialized.contains("example.test"));
        }
    }

    #[test]
    fn revision_put_statuses_preserve_terminal_or_uncertain_disposition() {
        for (status, code, uncertain) in [
            (401, "round2a-revision-put-authentication-required", false),
            (403, "round2a-revision-put-access-forbidden", false),
            (405, "round2a-revision-put-method-not-allowed", false),
            (423, "round2a-revision-put-locked", false),
            (302, "round2a-revision-put-redirect-refused", true),
            (503, "round2a-revision-put-server-error", true),
            (200, "round2a-revision-put-failed", true),
        ] {
            let mut fake = Fake {
                next_put_status: Some(status),
                ..Fake::default()
            };
            let result =
                publish_with_transport(&mut fake, publish_request("snapshot-1", "{\"chat\":1}"));
            assert_eq!(result.error_code.as_deref(), Some(code));
            assert_eq!(result.http_status, Some(status));
            assert_eq!(result.conflict_class, None);
            assert_eq!(result.remote_side_effect_uncertain, uncertain);
            assert_eq!(fake.put_count(), 1);
            let serialized = serde_json::to_string(&result).unwrap();
            assert!(!serialized.contains("PRIVATE PUT RESPONSE"));
            assert!(!serialized.contains("authorization"));
        }
    }

    #[test]
    fn head_put_statuses_preserve_terminal_or_uncertain_disposition() {
        for (status, code, conflict, uncertain) in [
            (401, "round2a-head-put-authentication-required", None, false),
            (403, "round2a-head-put-access-forbidden", None, false),
            (405, "round2a-head-put-method-not-allowed", None, false),
            (
                409,
                "round2a-head-put-409",
                Some("round2a-head-put-409"),
                false,
            ),
            (423, "round2a-head-put-locked", None, false),
            (302, "round2a-head-put-redirect-refused", None, true),
            (503, "round2a-head-put-server-error", None, true),
            (204, "round2a-head-put-failed", None, true),
        ] {
            let request = publish_request("snapshot-1", "{\"chat\":1}");
            let paths =
                derive_object_paths(&request.object_key_hex, &request.revision_blob_sha256_hex)
                    .unwrap();
            let mut fake = Fake {
                next_put_status: Some(status),
                ..Fake::default()
            };
            fake.entries.insert(
                paths.revision,
                Entry {
                    collection: false,
                    body: request.revision_blob_text.as_bytes().to_vec(),
                    etag: Some("\"revision\"".into()),
                },
            );
            let result = publish_with_transport(&mut fake, request);
            assert_eq!(result.error_code.as_deref(), Some(code));
            assert_eq!(result.http_status, Some(status));
            assert_eq!(result.conflict_class.as_deref(), conflict);
            assert_eq!(result.remote_side_effect_uncertain, uncertain);
            assert_eq!(fake.put_count(), 2);
            let serialized = serde_json::to_string(&result).unwrap();
            assert!(!serialized.contains("PRIVATE PUT RESPONSE"));
            assert!(!serialized.contains("authorization"));
        }
    }

    #[test]
    fn timeout_after_revision_commit_reconciles_exactly() {
        let mut fake = Fake::default();
        fake.timeout_after_put = true;
        let result =
            publish_with_transport(&mut fake, publish_request("snapshot-1", "{\"chat\":1}"));
        assert!(result.ok && result.revision_readback_verified);
    }

    #[test]
    fn timeout_after_head_commit_reconciles_exactly() {
        let request = publish_request("snapshot-1", "{\"chat\":1}");
        let paths = derive_object_paths(&request.object_key_hex, &request.revision_blob_sha256_hex)
            .unwrap();
        let mut fake = Fake {
            timeout_after_put: true,
            ..Fake::default()
        };
        fake.entries.insert(
            paths.revision,
            Entry {
                collection: false,
                body: request.revision_blob_text.as_bytes().to_vec(),
                etag: Some("\"revision\"".into()),
            },
        );
        let result = publish_with_transport(&mut fake, request);
        assert!(result.ok && result.head_created && result.head_readback_verified);
        assert!(!result.remote_side_effect_uncertain);
    }

    #[test]
    fn weak_head_etag_is_rejected() {
        let mut fake = Fake::default();
        let request = publish_request("snapshot-1", "{\"chat\":1}");
        assert!(publish_with_transport(&mut fake, request.clone()).ok);
        fake.weak_head_etag = true;
        let result = publish_with_transport(&mut fake, request);
        assert_eq!(
            result.error_code.as_deref(),
            Some("round2a-strong-etag-required")
        );
    }

    #[test]
    fn head_update_uses_observed_strong_if_match_and_readback() {
        let mut fake = Fake::default();
        let first = publish_request("snapshot-1", "{\"chat\":1}");
        let first_result = publish_with_transport(&mut fake, first.clone());
        let mut second = publish_request("snapshot-2", "{\"chat\":2}");
        second.expected_head = Some(ExpectedHead {
            revision_id: "snapshot-1".into(),
            revision_blob_sha256_hex: first.revision_blob_sha256_hex,
            strong_etag: first_result.new_head_strong_etag.unwrap(),
        });
        let result = publish_with_transport(&mut fake, second);
        assert!(result.ok && result.head_updated && result.head_readback_verified);
        assert!(fake
            .requests
            .iter()
            .any(|request| request.relative_path.ends_with("head.json")
                && request.headers.contains_key("if-match")));
    }

    #[test]
    fn stale_expected_head_conflicts_before_mutating_put() {
        let mut fake = Fake::default();
        let first = publish_request("snapshot-1", "{\"chat\":1}");
        assert!(publish_with_transport(&mut fake, first).ok);
        fake.requests.clear();
        let mut second = publish_request("snapshot-2", "{\"chat\":2}");
        second.expected_head = Some(ExpectedHead {
            revision_id: "old".into(),
            revision_blob_sha256_hex: "a".repeat(64),
            strong_etag: "\"old\"".into(),
        });
        let result = publish_with_transport(&mut fake, second);
        assert_eq!(result.conflict_class.as_deref(), Some("stale-head-etag"));
        assert_eq!(fake.put_count(), 0);
    }

    #[test]
    fn http_201_head_compatibility_rejects_doubled_location() {
        let mut fake = Fake::default();
        fake.doubled_location = true;
        let result =
            publish_with_transport(&mut fake, publish_request("snapshot-1", "{\"chat\":1}"));
        assert_eq!(
            result.error_code.as_deref(),
            Some("round2a-head-location-invalid")
        );
    }

    #[test]
    fn pull_verifies_path_hash_and_returns_safe_head() {
        let mut fake = Fake::default();
        let request = publish_request("snapshot-1", "{\"chat\":1}");
        assert!(publish_with_transport(&mut fake, request.clone()).ok);
        let pulled = pull_with_transport(
            &mut fake,
            PullTransportRequest {
                object_id: request.object_id,
                object_key_hex: request.object_key_hex,
                max_revision_bytes: MAX_REVISION_BYTES,
            },
        );
        assert!(pulled.ok && pulled.transport_verified && pulled.head_present);
        let head_canonical_text = pulled.head_canonical_text.clone().unwrap();
        assert_eq!(
            head_canonical_text.as_bytes(),
            fake.entries
                .values()
                .find(|entry| {
                    !entry.collection
                        && serde_json::from_slice::<Value>(&entry.body)
                            .ok()
                            .and_then(|value| value.get("schema").cloned())
                            == Some(Value::String(HEAD_SCHEMA.into()))
                })
                .unwrap()
                .body
                .as_slice()
        );
        assert_eq!(pulled.head.unwrap().revision_id, "snapshot-1");
    }

    #[test]
    fn pull_head_absence_is_a_successful_read_only_noop() {
        let mut fake = Fake::default();
        let result = pull_with_transport(&mut fake, pull_request());
        assert!(result.ok);
        assert_eq!(result.verdict, "head-absent");
        assert!(!result.head_present);
        assert_eq!(result.head_canonical_text, None);
        assert_eq!(result.error_code, None);
        assert_eq!(result.http_status, None);
        assert_eq!(fake.requests.len(), 1);
        assert_eq!(fake.requests[0].method, Method::Get);
        assert_eq!(fake.put_count(), 0);
    }

    #[test]
    fn pull_rejects_noncanonical_head_without_exposing_head_text() {
        let mut fake = Fake::default();
        let request = publish_request("snapshot-1", "{\"chat\":1}");
        assert!(publish_with_transport(&mut fake, request).ok);
        let head_entry = fake
            .entries
            .iter_mut()
            .find(|(_, entry)| {
                !entry.collection
                    && serde_json::from_slice::<Value>(&entry.body)
                        .ok()
                        .and_then(|value| value.get("schema").cloned())
                        == Some(Value::String(HEAD_SCHEMA.into()))
            })
            .unwrap()
            .1;
        head_entry.body.push(b'\n');

        let result = pull_with_transport(&mut fake, pull_request());
        assert!(!result.ok);
        assert_eq!(
            result.error_code.as_deref(),
            Some("round2a-head-not-canonical")
        );
        assert_eq!(result.head_canonical_text, None);
    }

    #[test]
    fn publish_layout_failure_preserves_only_safe_status_and_stops_before_put() {
        for (status, code) in [
            (401, "round2a-layout-authentication-required"),
            (403, "round2a-layout-access-forbidden"),
            (405, "round2a-layout-method-not-allowed"),
            (409, "round2a-layout-parent-conflict"),
            (423, "round2a-layout-locked"),
            (503, "round2a-layout-server-error"),
        ] {
            let mut fake = Fake {
                next_propfind_status: Some(status),
                ..Fake::default()
            };
            let result =
                publish_with_transport(&mut fake, publish_request("snapshot-1", "{\"chat\":1}"));
            assert!(!result.ok);
            assert_eq!(result.error_code.as_deref(), Some(code));
            assert_eq!(result.conflict_class, None);
            assert_eq!(result.http_status, Some(status));
            assert_eq!(fake.put_count(), 0);
            assert_eq!(fake.requests.len(), 1);
            assert_eq!(fake.requests[0].method, Method::Propfind);
            let serialized = serde_json::to_string(&result).unwrap();
            assert!(!serialized.contains("PRIVATE LAYOUT BODY"));
            assert!(!serialized.contains("authorization"));
            assert!(!serialized.contains("example.test"));
        }
    }

    #[test]
    fn publish_layout_redirect_is_safe_and_stops_before_put() {
        let mut fake = Fake {
            next_propfind_failure: Some(DispatchFailure::Redirect),
            ..Fake::default()
        };
        let result =
            publish_with_transport(&mut fake, publish_request("snapshot-1", "{\"chat\":1}"));
        assert_eq!(
            result.error_code.as_deref(),
            Some("round2a-layout-redirect-refused")
        );
        assert_eq!(result.conflict_class, None);
        assert_eq!(result.http_status, None);
        assert_eq!(fake.put_count(), 0);
        assert_eq!(fake.requests.len(), 1);
    }

    #[test]
    fn publish_layout_dispatch_categories_are_safe_and_stop_before_put() {
        for (category, code) in [
            (
                SafeDispatchCategory::Connect,
                "round2a-layout-connect-failed",
            ),
            (SafeDispatchCategory::Timeout, "round2a-layout-timeout"),
            (
                SafeDispatchCategory::Request,
                "round2a-layout-request-failed",
            ),
            (
                SafeDispatchCategory::ResponseRead,
                "round2a-layout-response-read-failed",
            ),
        ] {
            let mut fake = Fake {
                next_propfind_failure: Some(DispatchFailure::Rejected),
                next_propfind_category: Some(category),
                ..Fake::default()
            };
            let result =
                publish_with_transport(&mut fake, publish_request("snapshot-1", "{\"chat\":1}"));
            assert_eq!(result.error_code.as_deref(), Some(code));
            assert_eq!(result.conflict_class, None);
            assert_eq!(result.http_status, None);
            assert!(!result.remote_side_effect_uncertain);
            assert_eq!(fake.put_count(), 0);
            assert_eq!(fake.requests.len(), 1);
            assert_eq!(fake.requests[0].method, Method::Propfind);
            assert!(!serde_json::to_string(&result)
                .unwrap()
                .contains("example.test"));
        }
    }

    #[test]
    fn pull_get_statuses_are_safely_classified_without_response_disclosure() {
        for (status, code) in [
            (401, "round2a-get-authentication-required"),
            (403, "round2a-get-access-forbidden"),
            (405, "round2a-get-method-not-allowed"),
            (409, "round2a-get-client-error"),
            (503, "round2a-get-server-error"),
            (204, "round2a-get-status-invalid"),
            (302, "round2a-get-redirect-refused"),
        ] {
            let mut fake = Fake {
                next_get_status: Some(status),
                ..Fake::default()
            };
            let result = pull_with_transport(&mut fake, pull_request());
            assert!(!result.ok);
            assert_eq!(result.error_code.as_deref(), Some(code));
            assert_eq!(result.http_status, Some(status));
            let serialized = serde_json::to_string(&result).unwrap();
            assert!(!serialized.contains("PRIVATE RESPONSE BODY"));
            assert!(!serialized.contains("https://example.test"));
            assert!(!serialized.contains("authorization"));
            assert_eq!(fake.put_count(), 0);
        }
    }

    #[test]
    fn pull_transport_redirect_is_classified_without_inventing_a_status() {
        let mut fake = Fake {
            next_get_failure: Some(DispatchFailure::Redirect),
            ..Fake::default()
        };
        let result = pull_with_transport(&mut fake, pull_request());
        assert_eq!(
            result.error_code.as_deref(),
            Some("round2a-get-redirect-refused")
        );
        assert_eq!(result.http_status, None);
        assert_eq!(fake.put_count(), 0);
    }

    #[test]
    fn concurrent_local_operation_acquisition_has_one_winner() {
        let gate = Arc::new(LocalOperationGate::default());
        let barrier = Arc::new(Barrier::new(8));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let gate = gate.clone();
            let barrier = barrier.clone();
            handles.push(thread::spawn(move || {
                barrier.wait();
                gate.try_acquire("peer-a", "chat-a")
            }));
        }
        let winners = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
    }

    #[test]
    fn profile_runtime_session_is_exclusive_and_drop_releases_lock() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let profile = std::env::temp_dir().join(format!(
            "h2o-round2a-profile-lock-{}-{unique}",
            std::process::id()
        ));
        let first = ProfileRuntimeSession::acquire_at(&profile).expect("first profile session");
        assert_eq!(first.boot_id.len(), 64);
        assert!(first
            .boot_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        assert_eq!(
            ProfileRuntimeSession::acquire_at(&profile).unwrap_err(),
            "round2a-profile-runtime-busy"
        );
        drop(first);
        let second = ProfileRuntimeSession::acquire_at(&profile).expect("lock released on drop");
        assert_ne!(second.boot_id, "0".repeat(64));
        drop(second);
        let _ = std::fs::remove_file(profile.join(PROFILE_LOCK_FILE));
        let _ = std::fs::remove_dir(profile);
    }

    /* ------------------------------------------------------------------
     * O1-B2.1 - native writer-generation gate on the publish command.
     *
     * The JS gate inside `publishObject` is a refusal only for callers that go
     * through the JS. This command is a registered Tauri command, so it is
     * reachable from anything in the webview; these pin that reaching it
     * directly cannot publish once P01 has stood down.
     * --------------------------------------------------------------- */

    fn sample_publish() -> PublishTransportRequest {
        publish_request("snapshot-1", "{\"chat\":1}")
    }

    fn denied_observations() -> Vec<GenerationObservation> {
        vec![
            GenerationObservation::Recorded("p02".into()),
            GenerationObservation::Malformed,
            GenerationObservation::Unobserved,
        ]
    }

    /// 1. A proven absence is the pre-standdown world. The gated path must
    /// produce the same publication, over the same requests, as the ungated one
    /// did before this gate existed.
    #[test]
    fn absent_generation_publishes_exactly_as_before() {
        let mut gated = Fake::default();
        let gated_result = publish_under_generation(
            &GenerationObservation::AbsentObserved,
            &mut gated,
            sample_publish(),
        );
        let mut ungated = Fake::default();
        let ungated_result = publish_with_transport(&mut ungated, sample_publish());

        assert!(gated_result.ok, "{:?}", gated_result.error_code);
        assert_eq!(gated_result.verdict, ungated_result.verdict);
        assert_eq!(gated_result.error_code, ungated_result.error_code);
        assert_eq!(gated_result.created_revision, ungated_result.created_revision);
        assert_eq!(
            gated_result.revision_readback_verified,
            ungated_result.revision_readback_verified
        );
        assert_eq!(
            gated_result.head_readback_verified,
            ungated_result.head_readback_verified
        );
        assert_eq!(gated.put_count(), ungated.put_count());
        assert_eq!(
            gated
                .requests
                .iter()
                .map(|request| (request.method, request.relative_path.clone()))
                .collect::<Vec<_>>(),
            ungated
                .requests
                .iter()
                .map(|request| (request.method, request.relative_path.clone()))
                .collect::<Vec<_>>(),
            "the gate must not change which requests a permitted publish makes"
        );
    }

    /// 2. An explicit p01 record is the same permission, stated rather than
    /// implied, and must publish identically.
    #[test]
    fn explicit_p01_generation_publishes() {
        let mut fake = Fake::default();
        let result = publish_under_generation(
            &GenerationObservation::Recorded("p01".into()),
            &mut fake,
            sample_publish(),
        );
        assert!(result.ok, "{:?}", result.error_code);
        assert!(fake.put_count() > 0, "a permitted publish must actually write");
    }

    /// 3. After the standdown P01 must not write - and "refused" is only half
    /// the claim. The transport must never be touched at all.
    #[test]
    fn p02_generation_refuses_before_any_webdav_request() {
        let mut fake = Fake::default();
        let result = publish_under_generation(
            &GenerationObservation::Recorded("p02".into()),
            &mut fake,
            sample_publish(),
        );
        assert!(!result.ok);
        assert_eq!(result.verdict, "blocked");
        assert_eq!(result.error_code.as_deref(), Some("p01-writer-stood-down"));
        assert!(
            fake.requests.is_empty(),
            "a stood-down P01 must not reach the transport at all"
        );
    }

    /// 4. An unreadable store is not an empty store. Ignorance fails closed.
    #[test]
    fn unobserved_generation_refuses_and_writes_nothing() {
        let mut fake = Fake::default();
        let result =
            publish_under_generation(&GenerationObservation::Unobserved, &mut fake, sample_publish());
        assert!(!result.ok);
        assert_eq!(result.error_code.as_deref(), Some("generation-unobserved"));
        assert!(fake.requests.is_empty());
    }

    /// 5. A record we cannot parse is a record somebody wrote.
    #[test]
    fn malformed_generation_refuses_and_writes_nothing() {
        let mut fake = Fake::default();
        let result =
            publish_under_generation(&GenerationObservation::Malformed, &mut fake, sample_publish());
        assert!(!result.ok);
        assert_eq!(
            result.error_code.as_deref(),
            Some("generation-record-malformed")
        );
        assert!(fake.requests.is_empty());
    }

    /// 10. Stated once over every denied observation, so a future observation
    /// state cannot be added without having to land here.
    #[test]
    fn no_denied_generation_ever_reaches_the_transport() {
        for observation in denied_observations() {
            let mut fake = Fake::default();
            let result = publish_under_generation(&observation, &mut fake, sample_publish());
            assert!(!result.ok, "{observation:?} was permitted");
            assert_eq!(result.verdict, "blocked", "{observation:?}");
            assert!(
                fake.requests.is_empty(),
                "{observation:?} reached the transport"
            );
            assert_eq!(fake.put_count(), 0, "{observation:?} wrote");
        }
    }

    /// 6 + 9. A direct invoke cannot bypass the standdown: the command observes
    /// the generation before a transport exists, and the profile-session check
    /// it already had is still there and still first.
    #[test]
    fn the_command_gates_before_it_builds_a_transport() {
        let source = include_str!("sync_object_transport.rs");
        let production = &source[..source.find("#[cfg(test)]").expect("test module")];
        let start = production
            .find("pub async fn h2o_sync_object_publish_transport")
            .expect("publish command");
        let body = &production[start..];
        let body = &body[..body.find("#[tauri::command]").unwrap_or(body.len())];

        let session = body
            .find("require_profile_runtime_session")
            .expect("profile-session check must remain load-bearing");
        let observe = body
            .find("observe_generation")
            .expect("the generation must be observed");
        let refusal = body
            .find("generation_refusal")
            .expect("the refusal must be applied");
        let transport = body
            .find("production_transport")
            .expect("a transport is built");
        let publish = body
            .find("publish_under_generation")
            .expect("the publish goes through the gated helper");

        assert!(session < observe, "profile session stays first");
        assert!(
            observe < transport && refusal < transport,
            "the generation must be observed before any transport exists"
        );
        assert!(refusal < publish, "the refusal must precede the publish");
    }

    /// 7. Native defence in depth is an addition, not a replacement: the JS gate
    /// on this same path is still there and still precedes the invoke.
    #[test]
    fn the_js_publish_object_gate_remains() {
        let js = include_str!(
            "../../../../../src-surfaces-base/studio/sync/sync-object-runtime.tauri.js"
        );
        let gate = js
            .find("var generation = await generationPermitsP01Mutation();")
            .expect("the JS gate must still be consulted");
        let invoke = js
            .find("'h2o_sync_object_publish_transport'")
            .expect("the JS must still invoke the transport command");
        assert!(gate < invoke, "the JS gate must precede the invoke");
    }

    /// 8. The P02 command family must NOT carry this gate. Gating it would make
    /// the standdown refuse the very writer it exists to install.
    #[test]
    fn the_p02_command_family_is_not_generation_gated() {
        for (name, source) in [
            ("p02_activation.rs", include_str!("p02_activation.rs")),
            (
                "p02_publication_authority.rs",
                include_str!("p02_publication_authority.rs"),
            ),
            ("p02_writer_storage.rs", include_str!("p02_writer_storage.rs")),
        ] {
            assert!(
                !source.contains("require_p01_mutation_permitted"),
                "{name} must not consult the P01 generation gate"
            );
            assert!(
                !source.contains("p01_generation_gate"),
                "{name} must not depend on the P01 generation gate"
            );
        }
    }

    /// The read path is untouched. A standdown stops P01 from WRITING; refusing
    /// to read would strand the data rather than transfer it.
    #[test]
    fn the_pull_command_is_not_generation_gated() {
        let source = include_str!("sync_object_transport.rs");
        let production = &source[..source.find("#[cfg(test)]").expect("test module")];
        let start = production
            .find("pub fn h2o_sync_object_pull_transport")
            .expect("pull command");
        let body = &production[start..];
        let body = &body[..body.find("\n}\n").map(|at| at + 2).unwrap_or(body.len())];
        assert!(!body.contains("generation_refusal"));
        assert!(!body.contains("observe_generation"));
    }
}
