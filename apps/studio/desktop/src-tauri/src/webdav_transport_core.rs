//! Narrow production WebDAV transport substrate for accepted P01 object sync
//! plus the inactive P02 Z4 conditional-request seam.
//!
//! The public surface is deliberately transport-injected.  Only four methods
//! exist (PROPFIND, MKCOL, GET, PUT), every target is an internally-derived
//! relative path, redirects are disabled, and response bodies are bounded.

/* The object-key/hash authority now lives in `sync_object_document`. Re-exported
 * here so the existing `webdav_transport_core::{sha256_hex, object_key_hex,
 * is_lower_hex_64}` paths keep resolving exactly as before this move, and so
 * this module's own `is_lower_hex_64` use needs no second import. */
pub use crate::sync_object_document::{is_lower_hex_64, object_key_hex, sha256_hex};

use crate::sync_contract_v2::{
    validate_contract_document_v2, writer_key_hex_v2, ContractDocumentV2, ContractKindV2,
    ContractPolicyV2,
};
use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;
use reqwest::blocking::Client;
use std::collections::BTreeMap;
use std::io::Read;
use std::time::Duration;

pub const MAX_REVISION_BYTES: usize = 5 * 1024 * 1024;
const PROPFIND_BODY: &[u8] = b"<?xml version=\"1.0\" encoding=\"utf-8\"?><D:propfind xmlns:D=\"DAV:\"><D:prop><D:resourcetype/></D:prop></D:propfind>";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Method {
    Propfind,
    Mkcol,
    Get,
    Put,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Self::Propfind => "PROPFIND",
            Self::Mkcol => "MKCOL",
            Self::Get => "GET",
            Self::Put => "PUT",
        }
    }

    fn mutates(self) -> bool {
        matches!(self, Self::Mkcol | Self::Put)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebDavRequest {
    pub method: Method,
    pub relative_path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub max_response_bytes: usize,
}

impl WebDavRequest {
    pub fn new(method: Method, relative_path: impl Into<String>) -> Self {
        Self {
            method,
            relative_path: relative_path.into(),
            headers: BTreeMap::new(),
            body: Vec::new(),
            max_response_bytes: MAX_REVISION_BYTES,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WebDavResponse {
    pub status: u16,
    pub headers: BTreeMap<String, Vec<String>>,
    pub body: Vec<u8>,
    /// Exact absolute-path href derived from the requested URL, never server input.
    pub expected_href: String,
    /// Exact target URL derived by the adapter, never server input.
    pub expected_url: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DispatchFailure {
    Rejected,
    Redirect,
    SideEffectUncertain,
    ResponseTooLarge,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SafeDispatchCategory {
    Connect,
    Timeout,
    Request,
    ResponseRead,
}

pub trait WebDavTransport {
    fn execute(&mut self, request: WebDavRequest) -> Result<WebDavResponse, DispatchFailure>;

    /// Returns only a closed, non-sensitive category for the most recent
    /// dispatch failure. Implementors that cannot classify structurally retain
    /// the generic error path.
    fn safe_dispatch_category(&self) -> Option<SafeDispatchCategory> {
        None
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LayoutFailure {
    pub code: String,
    pub http_status: Option<u16>,
    pub remote_side_effect_uncertain: bool,
}

impl LayoutFailure {
    fn new(code: &str, http_status: Option<u16>) -> Self {
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
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObjectPaths {
    pub collections: [String; 4],
    pub revision: String,
    pub head: String,
}

pub fn derive_object_paths(
    object_key: &str,
    revision_blob_sha256: &str,
) -> Result<ObjectPaths, String> {
    if !is_lower_hex_64(object_key) || !is_lower_hex_64(revision_blob_sha256) {
        return Err("round2a-identifier-invalid".into());
    }
    let object = format!("round2a/objects/{object_key}");
    let revisions = format!("{object}/revisions");
    Ok(ObjectPaths {
        collections: [
            "round2a".into(),
            "round2a/objects".into(),
            object.clone(),
            revisions.clone(),
        ],
        revision: format!("{revisions}/{revision_blob_sha256}.json"),
        head: format!("{object}/head.json"),
    })
}

pub fn single_header(response: &WebDavResponse, name: &str) -> Result<Option<String>, String> {
    let Some(values) = response.headers.get(&name.to_ascii_lowercase()) else {
        return Ok(None);
    };
    if values.len() != 1 || values[0].contains('\n') || values[0].contains('\r') {
        return Err("round2a-strong-etag-required".into());
    }
    Ok(Some(values[0].clone()))
}

pub fn require_strong_etag(response: &WebDavResponse) -> Result<String, String> {
    let value = single_header(response, "etag")?
        .ok_or_else(|| "round2a-strong-etag-required".to_string())?;
    if !is_strong_etag_text(&value) {
        return Err("round2a-strong-etag-required".into());
    }
    Ok(value)
}

fn is_strong_etag_text(value: &str) -> bool {
    let opaque = value.get(1..value.len().saturating_sub(1)).unwrap_or("");
    !value.starts_with("W/")
        && value.len() >= 2
        && value.starts_with('"')
        && value.ends_with('"')
        && !opaque.is_empty()
        && opaque
            .bytes()
            .all(|byte| byte == b'!' || (b'#'..=b'~').contains(&byte))
}

fn propfind_request(path: &str) -> WebDavRequest {
    let mut request = WebDavRequest::new(Method::Propfind, path);
    request.headers.insert("depth".into(), "0".into());
    request.headers.insert(
        "content-type".into(),
        "application/xml; charset=utf-8".into(),
    );
    request.body = PROPFIND_BODY.to_vec();
    request.max_response_bytes = 64 * 1024;
    request
}

fn same_collection_path(left: &str, right: &str) -> bool {
    left == right || left.strip_suffix('/') == Some(right) || right.strip_suffix('/') == Some(left)
}

fn href_is_exact(href: &str, response: &WebDavResponse) -> bool {
    if href.trim() != href
        || href.contains('\\')
        || href.contains('%')
        || href
            .split(['/', '?', '#'])
            .any(|part| part == "." || part == "..")
    {
        return false;
    }
    let Ok(expected) = reqwest::Url::parse(&response.expected_url) else {
        return false;
    };
    if expected.query().is_some()
        || expected.fragment().is_some()
        || !expected.username().is_empty()
        || expected.password().is_some()
        || expected.path().contains("//")
        || expected.path() != response.expected_href
    {
        return false;
    }
    let candidate = match reqwest::Url::parse(href) {
        Ok(url) => url,
        Err(_) => match expected.join(href) {
            Ok(url) => url,
            Err(_) => return false,
        },
    };
    if candidate.scheme() != expected.scheme()
        || candidate.host_str() != expected.host_str()
        || candidate.port_or_known_default() != expected.port_or_known_default()
        || !candidate.username().is_empty()
        || candidate.password().is_some()
        || candidate.query().is_some()
        || candidate.fragment().is_some()
        || candidate.path().contains("//")
        || candidate.path().contains('%')
    {
        return false;
    }
    same_collection_path(candidate.path(), &response.expected_href)
}

fn dav_name(reader: &NsReader<&[u8]>, name: quick_xml::name::QName<'_>, local: &[u8]) -> bool {
    let (namespace, resolved) = reader.resolver().resolve_element(name);
    matches!(namespace, ResolveResult::Bound(value) if value.as_ref() == b"DAV:")
        && resolved.as_ref() == local
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DavElement {
    Multistatus,
    Response,
    Href,
    Propstat,
    Prop,
    Resourcetype,
    Collection,
    Status,
    Other,
}

fn dav_element(reader: &NsReader<&[u8]>, name: quick_xml::name::QName<'_>) -> DavElement {
    for (local, element) in [
        (b"multistatus".as_slice(), DavElement::Multistatus),
        (b"response".as_slice(), DavElement::Response),
        (b"href".as_slice(), DavElement::Href),
        (b"propstat".as_slice(), DavElement::Propstat),
        (b"prop".as_slice(), DavElement::Prop),
        (b"resourcetype".as_slice(), DavElement::Resourcetype),
        (b"collection".as_slice(), DavElement::Collection),
        (b"status".as_slice(), DavElement::Status),
    ] {
        if dav_name(reader, name, local) {
            return element;
        }
    }
    DavElement::Other
}

fn status_is_success(status: &str) -> bool {
    let mut parts = status.split_ascii_whitespace();
    let protocol = parts.next();
    let code = parts.next();
    matches!(protocol, Some("HTTP/1.0" | "HTTP/1.1"))
        && code.is_some_and(|value| {
            value.len() == 3
                && value.bytes().all(|byte| byte.is_ascii_digit())
                && value
                    .parse::<u16>()
                    .is_ok_and(|status| (200..300).contains(&status))
        })
}

fn exact_collection_from_multistatus(response: &WebDavResponse) -> Result<bool, String> {
    if response.status == 404 {
        return Ok(false);
    }
    if response.status != 207
        || response.body.is_empty()
        || response.expected_href.is_empty()
        || response.body.len() > 64 * 1024
    {
        return Err("round2a-layout-propfind-invalid".into());
    }
    let mut reader = NsReader::from_reader(response.body.as_slice());
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut stack = Vec::new();
    let mut root_seen = false;
    let mut root_closed = false;
    let mut responses = 0_u32;
    let mut href_count = 0_u32;
    let mut href = String::new();
    let mut response_href_completed = false;
    let mut response_propstat_started = false;
    let mut propstat_active = false;
    let mut propstat_prop_count = 0_u32;
    let mut propstat_prop_completed = false;
    let mut propstat_status_count = 0_u32;
    let mut propstat_status = String::new();
    let mut propstat_resourcetype_count = 0_u32;
    let mut propstat_collection_count = 0_u32;
    let mut required_propstats = 0_u32;
    let mut successful_collections = 0_u32;

    let invalid = || "round2a-layout-propfind-invalid".to_string();

    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) => {
                let element = dav_element(&reader, event.name());
                let parent = stack.last().copied();
                if stack.is_empty() {
                    if root_seen || root_closed || element != DavElement::Multistatus {
                        return Err(invalid());
                    }
                    root_seen = true;
                } else {
                    match element {
                        DavElement::Multistatus => return Err(invalid()),
                        DavElement::Response => {
                            if parent != Some(DavElement::Multistatus) {
                                return Err(invalid());
                            }
                            responses += 1;
                            response_href_completed = false;
                            response_propstat_started = false;
                        }
                        DavElement::Href => {
                            if parent != Some(DavElement::Response) || response_propstat_started {
                                return Err(invalid());
                            }
                            href_count += 1;
                        }
                        DavElement::Propstat => {
                            if parent != Some(DavElement::Response)
                                || !response_href_completed
                                || propstat_active
                            {
                                return Err(invalid());
                            }
                            response_propstat_started = true;
                            propstat_active = true;
                            propstat_prop_count = 0;
                            propstat_prop_completed = false;
                            propstat_status_count = 0;
                            propstat_status.clear();
                            propstat_resourcetype_count = 0;
                            propstat_collection_count = 0;
                        }
                        DavElement::Prop => {
                            if parent != Some(DavElement::Propstat) || !propstat_active {
                                return Err(invalid());
                            }
                            propstat_prop_count += 1;
                            if propstat_prop_count != 1 {
                                return Err(invalid());
                            }
                        }
                        DavElement::Resourcetype => {
                            if parent != Some(DavElement::Prop) {
                                return Err(invalid());
                            }
                            propstat_resourcetype_count += 1;
                        }
                        DavElement::Collection => {
                            if parent != Some(DavElement::Resourcetype) {
                                return Err(invalid());
                            }
                            propstat_collection_count += 1;
                        }
                        DavElement::Status => {
                            if parent != Some(DavElement::Propstat)
                                || !propstat_active
                                || !propstat_prop_completed
                            {
                                return Err(invalid());
                            }
                            propstat_status_count += 1;
                            if propstat_status_count != 1 {
                                return Err(invalid());
                            }
                        }
                        DavElement::Other => {
                            if !stack.contains(&DavElement::Prop) {
                                return Err(invalid());
                            }
                        }
                    }
                }
                stack.push(element);
            }
            Ok(Event::Empty(event)) => {
                let element = dav_element(&reader, event.name());
                let parent = stack.last().copied();
                match element {
                    DavElement::Resourcetype if parent == Some(DavElement::Prop) => {
                        propstat_resourcetype_count += 1;
                    }
                    DavElement::Collection if parent == Some(DavElement::Resourcetype) => {
                        propstat_collection_count += 1;
                    }
                    DavElement::Other if stack.contains(&DavElement::Prop) => {}
                    _ => return Err(invalid()),
                }
            }
            Ok(Event::Text(event)) => match stack.last() {
                Some(DavElement::Href) => {
                    href.push_str(event.decode().map_err(|_| invalid())?.as_ref())
                }
                Some(DavElement::Status) => {
                    propstat_status.push_str(event.decode().map_err(|_| invalid())?.as_ref())
                }
                Some(DavElement::Other) if stack.contains(&DavElement::Prop) => {}
                _ => return Err(invalid()),
            },
            Ok(Event::End(event)) => {
                let element = dav_element(&reader, event.name());
                if stack.last().copied() != Some(element) {
                    return Err(invalid());
                }
                match element {
                    DavElement::Href => response_href_completed = true,
                    DavElement::Prop => propstat_prop_completed = true,
                    DavElement::Propstat => {
                        if !propstat_active
                            || propstat_prop_count != 1
                            || !propstat_prop_completed
                            || propstat_status_count != 1
                        {
                            return Err(invalid());
                        }
                        if propstat_resourcetype_count > 0 {
                            if propstat_resourcetype_count != 1
                                || propstat_collection_count != 1
                                || !status_is_success(&propstat_status)
                            {
                                return Err(invalid());
                            }
                            required_propstats += 1;
                            successful_collections += 1;
                        }
                        propstat_active = false;
                    }
                    DavElement::Response => {
                        if !response_href_completed || propstat_active {
                            return Err(invalid());
                        }
                    }
                    DavElement::Multistatus => root_closed = true,
                    _ => {}
                }
                stack.pop();
            }
            Ok(Event::Eof) => break,
            Ok(Event::CData(_) | Event::DocType(_) | Event::PI(_)) => return Err(invalid()),
            Err(_) => return Err(invalid()),
            _ => {}
        }
        buffer.clear();
    }
    if !root_seen
        || !root_closed
        || !stack.is_empty()
        || responses != 1
        || href_count != 1
        || !href_is_exact(&href, response)
        || propstat_active
        || required_propstats != 1
        || successful_collections != 1
    {
        return Err("round2a-layout-propfind-invalid".into());
    }
    Ok(true)
}

fn propfind_dispatch_failure(
    error: DispatchFailure,
    category: Option<SafeDispatchCategory>,
) -> LayoutFailure {
    match error {
        DispatchFailure::Redirect => LayoutFailure::new("round2a-layout-redirect-refused", None),
        DispatchFailure::ResponseTooLarge => {
            LayoutFailure::new("round2a-layout-response-too-large", None)
        }
        DispatchFailure::Rejected | DispatchFailure::SideEffectUncertain => {
            let code = match category {
                Some(SafeDispatchCategory::Connect) => "round2a-layout-connect-failed",
                Some(SafeDispatchCategory::Timeout) => "round2a-layout-timeout",
                Some(SafeDispatchCategory::Request) => "round2a-layout-request-failed",
                Some(SafeDispatchCategory::ResponseRead) => "round2a-layout-response-read-failed",
                None => "round2a-layout-propfind-failed",
            };
            LayoutFailure::new(code, None)
        }
    }
}

fn exact_collection_from_propfind(response: WebDavResponse) -> Result<bool, LayoutFailure> {
    let status = response.status;
    match status {
        207 | 404 => exact_collection_from_multistatus(&response)
            .map_err(|code| LayoutFailure::new(&code, Some(status))),
        401 => Err(LayoutFailure::new(
            "round2a-layout-authentication-required",
            Some(status),
        )),
        403 => Err(LayoutFailure::new(
            "round2a-layout-access-forbidden",
            Some(status),
        )),
        405 => Err(LayoutFailure::new(
            "round2a-layout-method-not-allowed",
            Some(status),
        )),
        409 => Err(LayoutFailure::new(
            "round2a-layout-parent-conflict",
            Some(status),
        )),
        423 => Err(LayoutFailure::new("round2a-layout-locked", Some(status))),
        300..=399 => Err(LayoutFailure::new(
            "round2a-layout-redirect-refused",
            Some(status),
        )),
        500..=599 => Err(LayoutFailure::new(
            "round2a-layout-server-error",
            Some(status),
        )),
        _ => Err(LayoutFailure::new(
            "round2a-layout-propfind-failed",
            Some(status),
        )),
    }
}

fn execute_collection_propfind<T: WebDavTransport>(
    transport: &mut T,
    path: &str,
) -> Result<bool, LayoutFailure> {
    let response = match transport.execute(propfind_request(path)) {
        Ok(response) => response,
        Err(error) => {
            return Err(propfind_dispatch_failure(
                error,
                transport.safe_dispatch_category(),
            ))
        }
    };
    exact_collection_from_propfind(response)
}

pub fn ensure_remote_object_layout_detailed<T: WebDavTransport>(
    transport: &mut T,
    object_key: &str,
) -> Result<(), LayoutFailure> {
    let paths = derive_object_paths(object_key, &"0".repeat(64))
        .map_err(|code| LayoutFailure::new(&code, None))?;
    for path in paths.collections {
        if execute_collection_propfind(transport, &path)? {
            continue;
        }
        let created = transport
            .execute(WebDavRequest::new(Method::Mkcol, &path))
            .map_err(|error| match error {
                DispatchFailure::Redirect => {
                    LayoutFailure::uncertain("round2a-layout-create-redirect-refused", None)
                }
                DispatchFailure::ResponseTooLarge => {
                    LayoutFailure::uncertain("round2a-layout-create-response-too-large", None)
                }
                DispatchFailure::Rejected | DispatchFailure::SideEffectUncertain => {
                    LayoutFailure::uncertain("round2a-layout-create-uncertain", None)
                }
            })?;
        match created.status {
            201 => {}
            405 => {
                if !execute_collection_propfind(transport, &path)? {
                    return Err(LayoutFailure::new(
                        "round2a-layout-collection-not-proven",
                        Some(405),
                    ));
                }
            }
            409 => {
                return Err(LayoutFailure::new(
                    "round2a-layout-parent-missing",
                    Some(409),
                ))
            }
            401 => {
                return Err(LayoutFailure::new(
                    "round2a-layout-create-authentication-required",
                    Some(401),
                ))
            }
            403 => {
                return Err(LayoutFailure::new(
                    "round2a-layout-create-access-forbidden",
                    Some(403),
                ))
            }
            423 => {
                return Err(LayoutFailure::new(
                    "round2a-layout-create-locked",
                    Some(423),
                ))
            }
            status @ 300..=399 => {
                return Err(LayoutFailure::uncertain(
                    "round2a-layout-create-redirect-refused",
                    Some(status),
                ))
            }
            status @ 500..=599 => {
                return Err(LayoutFailure::new(
                    "round2a-layout-create-server-error",
                    Some(status),
                ))
            }
            status => {
                return Err(LayoutFailure::new(
                    "round2a-layout-create-failed",
                    Some(status),
                ))
            }
        }
    }
    Ok(())
}

pub fn ensure_remote_object_layout<T: WebDavTransport>(
    transport: &mut T,
    object_key: &str,
) -> Result<(), String> {
    ensure_remote_object_layout_detailed(transport, object_key).map_err(|failure| failure.code)
}

pub fn exact_location_or_absent(response: &WebDavResponse) -> Result<(), String> {
    let Some(location) = single_header(response, "location")? else {
        return Ok(());
    };
    if location.contains("//") && !location.starts_with("https://") {
        return Err("round2a-head-location-invalid".into());
    }
    if location != response.expected_url && location != response.expected_href {
        return Err("round2a-head-location-invalid".into());
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConditionalPutPrecondition {
    CreateIfAbsent,
    MatchStrongEtag(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConditionalPutSuccess {
    pub http_status: u16,
    pub strong_etag: String,
}

pub fn derive_p02_revision_path(
    object_key: &str,
    revision_blob_sha256: &str,
) -> Result<String, String> {
    if !is_lower_hex_64(object_key) || !is_lower_hex_64(revision_blob_sha256) {
        return Err("p02-z4-path-identity-invalid".into());
    }
    Ok(format!(
        "objects/{object_key}/revisions/{revision_blob_sha256}.json"
    ))
}

pub fn derive_p02_heads_snapshot_path(
    writer_key: &str,
    heads_snapshot_sha256: &str,
) -> Result<String, String> {
    if !is_lower_hex_64(writer_key) || !is_lower_hex_64(heads_snapshot_sha256) {
        return Err("p02-z4-path-identity-invalid".into());
    }
    Ok(format!(
        "writers/{writer_key}/heads/{heads_snapshot_sha256}.json"
    ))
}

pub fn derive_p02_writer_state_path(writer_key: &str) -> Result<String, String> {
    if !is_lower_hex_64(writer_key) {
        return Err("p02-z4-path-identity-invalid".into());
    }
    Ok(format!("writers/{writer_key}/state.json"))
}

pub fn conditional_put_request(
    relative_path: &str,
    body: &[u8],
    precondition: ConditionalPutPrecondition,
) -> Result<WebDavRequest, String> {
    validate_relative_path(relative_path)
        .map_err(|_| "p02-z4-conditional-put-path-invalid".to_string())?;
    if body.is_empty() || body.len() > MAX_REVISION_BYTES {
        return Err("p02-z4-conditional-put-body-invalid".into());
    }
    let mut request = WebDavRequest::new(Method::Put, relative_path);
    request.headers.insert(
        "content-type".into(),
        "application/json; charset=utf-8".into(),
    );
    match precondition {
        ConditionalPutPrecondition::CreateIfAbsent => {
            request.headers.insert("if-none-match".into(), "*".into());
        }
        ConditionalPutPrecondition::MatchStrongEtag(etag) => {
            if !is_strong_etag_text(&etag) {
                return Err("p02-z4-conditional-put-etag-invalid".into());
            }
            request.headers.insert("if-match".into(), etag);
        }
    }
    request.body = body.to_vec();
    request.max_response_bytes = 64 * 1024;
    Ok(request)
}

pub fn execute_conditional_put<T: WebDavTransport>(
    transport: &mut T,
    relative_path: &str,
    body: &[u8],
    precondition: ConditionalPutPrecondition,
) -> Result<ConditionalPutSuccess, LayoutFailure> {
    let update = matches!(
        &precondition,
        ConditionalPutPrecondition::MatchStrongEtag(_)
    );
    let request = conditional_put_request(relative_path, body, precondition)
        .map_err(|code| LayoutFailure::new(&code, None))?;
    let response = transport.execute(request).map_err(|error| match error {
        DispatchFailure::Redirect => {
            LayoutFailure::uncertain("p02-z4-conditional-put-redirect-refused", None)
        }
        DispatchFailure::ResponseTooLarge => {
            LayoutFailure::uncertain("p02-z4-conditional-put-response-too-large", None)
        }
        DispatchFailure::Rejected | DispatchFailure::SideEffectUncertain => {
            LayoutFailure::uncertain("p02-z4-conditional-put-side-effect-uncertain", None)
        }
    })?;
    let status = response.status;
    match status {
        200 | 201 | 204 => {
            exact_location_or_absent(&response).map_err(|_| {
                LayoutFailure::uncertain("p02-z4-conditional-put-location-invalid", Some(status))
            })?;
            let strong_etag = require_strong_etag(&response).map_err(|_| {
                LayoutFailure::uncertain(
                    "p02-z4-conditional-put-strong-etag-required",
                    Some(status),
                )
            })?;
            Ok(ConditionalPutSuccess {
                http_status: status,
                strong_etag,
            })
        }
        412 if update => Err(LayoutFailure::new(
            "p02-z4-pointer-stale-precondition",
            Some(status),
        )),
        412 => Err(LayoutFailure::new(
            "p02-z4-create-precondition-failed",
            Some(status),
        )),
        428 => Err(LayoutFailure::new(
            "p02-z4-conditional-put-precondition-required",
            Some(status),
        )),
        401 => Err(LayoutFailure::new(
            "p02-z4-conditional-put-authentication-required",
            Some(status),
        )),
        403 => Err(LayoutFailure::new(
            "p02-z4-conditional-put-access-forbidden",
            Some(status),
        )),
        409 => Err(LayoutFailure::new(
            "p02-z4-conditional-put-parent-conflict",
            Some(status),
        )),
        300..=399 => Err(LayoutFailure::uncertain(
            "p02-z4-conditional-put-redirect-refused",
            Some(status),
        )),
        500..=599 => Err(LayoutFailure::uncertain(
            "p02-z4-conditional-put-server-uncertain",
            Some(status),
        )),
        _ => Err(LayoutFailure::new(
            "p02-z4-conditional-put-failed",
            Some(status),
        )),
    }
}

/// Inactive P02 Z4 writer-pointer request primitive. `None` means the caller
/// proved the pointer absent and therefore emits `If-None-Match: *`; updates
/// require the previously read representation-strong ETag. A stale or
/// uncertain result is returned fail-closed for caller-driven re-read.
pub fn execute_p02_writer_state_put<T: WebDavTransport>(
    transport: &mut T,
    writer_key: &str,
    pointer_bytes: &[u8],
    expected_previous_strong_etag: Option<String>,
) -> Result<ConditionalPutSuccess, LayoutFailure> {
    let validated = validate_contract_document_v2(
        ContractKindV2::WriterState,
        pointer_bytes,
        None,
        ContractPolicyV2::default(),
    )
    .map_err(|error| LayoutFailure::new(error.as_str(), None))?;
    let ContractDocumentV2::WriterState(pointer) = validated.document else {
        unreachable!("writer-state validation returns the writer-state variant")
    };
    if writer_key_hex_v2(&pointer.writer_sync_peer_id) != writer_key {
        return Err(LayoutFailure::new("p02-z4-writer-identity-mismatch", None));
    }
    let state_path =
        derive_p02_writer_state_path(writer_key).map_err(|code| LayoutFailure::new(&code, None))?;
    let precondition = expected_previous_strong_etag.map_or(
        ConditionalPutPrecondition::CreateIfAbsent,
        ConditionalPutPrecondition::MatchStrongEtag,
    );
    execute_conditional_put(transport, &state_path, pointer_bytes, precondition)
}

fn is_p02_relative_path(path: &str) -> bool {
    let parts = path.split('/').collect::<Vec<_>>();
    match parts.as_slice() {
        ["objects"] | ["writers"] => true,
        ["objects", object_key] => is_lower_hex_64(object_key),
        ["objects", object_key, "revisions"] => is_lower_hex_64(object_key),
        ["objects", object_key, "revisions", file] => {
            is_lower_hex_64(object_key) && file.strip_suffix(".json").is_some_and(is_lower_hex_64)
        }
        ["writers", writer_key] => is_lower_hex_64(writer_key),
        ["writers", writer_key, "heads"] => is_lower_hex_64(writer_key),
        ["writers", writer_key, "heads", file] => {
            is_lower_hex_64(writer_key) && file.strip_suffix(".json").is_some_and(is_lower_hex_64)
        }
        ["writers", writer_key, "state.json"] => is_lower_hex_64(writer_key),
        _ => false,
    }
}

fn validate_relative_path(path: &str) -> Result<(), DispatchFailure> {
    let is_round2a_path = path == "round2a" || path.starts_with("round2a/");
    let is_p02_path = is_p02_relative_path(path);
    if path.is_empty()
        || path.starts_with('/')
        || path.ends_with('/')
        || path.contains("//")
        || path.contains('\\')
        || path.contains('%')
        || path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || (!is_round2a_path && !is_p02_path)
    {
        return Err(DispatchFailure::Rejected);
    }
    Ok(())
}

pub struct ReqwestWebDavTransport {
    client: Client,
    namespace: reqwest::Url,
    authorization_private: String,
    last_safe_dispatch_category: Option<SafeDispatchCategory>,
}

impl ReqwestWebDavTransport {
    pub fn new(
        endpoint_private: &str,
        remote_root_private: &str,
        authorization_private: String,
    ) -> Result<Self, String> {
        if authorization_private.trim().is_empty() {
            return Err("round2a-descriptor-credential-missing".into());
        }
        let mut endpoint = reqwest::Url::parse(endpoint_private)
            .map_err(|_| "round2a-descriptor-endpoint-invalid")?;
        if endpoint.scheme() != "https"
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            return Err("round2a-descriptor-endpoint-invalid".into());
        }
        if !endpoint.path().ends_with('/') {
            endpoint.set_path(&format!("{}/", endpoint.path()));
        }
        let root = remote_root_private.trim().trim_matches('/');
        if root.is_empty()
            || root.contains("//")
            || root.contains('%')
            || root.split('/').any(|part| part == "." || part == "..")
        {
            return Err("round2a-descriptor-namespace-invalid".into());
        }
        let namespace = endpoint
            .join(&format!("{root}/"))
            .map_err(|_| "round2a-descriptor-namespace-invalid")?;
        if endpoint.scheme() != namespace.scheme()
            || endpoint.host_str() != namespace.host_str()
            || endpoint.port_or_known_default() != namespace.port_or_known_default()
            || !namespace.path().starts_with(endpoint.path())
        {
            return Err("round2a-descriptor-namespace-invalid".into());
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "round2a-http-client-build-failed")?;
        Ok(Self {
            client,
            namespace,
            authorization_private,
            last_safe_dispatch_category: None,
        })
    }
}

impl WebDavTransport for ReqwestWebDavTransport {
    fn execute(&mut self, request: WebDavRequest) -> Result<WebDavResponse, DispatchFailure> {
        self.last_safe_dispatch_category = None;
        validate_relative_path(&request.relative_path)?;
        if request.max_response_bytes > MAX_REVISION_BYTES + 64 * 1024 {
            return Err(DispatchFailure::Rejected);
        }
        let url = self
            .namespace
            .join(&request.relative_path)
            .map_err(|_| DispatchFailure::Rejected)?;
        if url.scheme() != self.namespace.scheme()
            || url.host_str() != self.namespace.host_str()
            || url.port_or_known_default() != self.namespace.port_or_known_default()
            || !url.path().starts_with(self.namespace.path())
        {
            return Err(DispatchFailure::Rejected);
        }
        let method = reqwest::Method::from_bytes(request.method.as_str().as_bytes())
            .map_err(|_| DispatchFailure::Rejected)?;
        let mut builder = self
            .client
            .request(method, url.clone())
            .header("Authorization", &self.authorization_private);
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        if !request.body.is_empty() {
            builder = builder.body(request.body);
        }
        let response = match builder.send() {
            Ok(response) => response,
            Err(error) => {
                self.last_safe_dispatch_category = if error.is_timeout() {
                    Some(SafeDispatchCategory::Timeout)
                } else if error.is_connect() {
                    // Reqwest does not expose stable public DNS/TCP/TLS
                    // subcategories. Never parse private error text.
                    Some(SafeDispatchCategory::Connect)
                } else if error.is_request() || error.is_builder() {
                    Some(SafeDispatchCategory::Request)
                } else {
                    None
                };
                return Err(if request.method.mutates() {
                    DispatchFailure::SideEffectUncertain
                } else {
                    DispatchFailure::Rejected
                });
            }
        };
        if response.status().is_redirection() {
            return Err(DispatchFailure::Redirect);
        }
        let status = response.status().as_u16();
        let mut headers = BTreeMap::new();
        for name in ["etag", "location"] {
            let values = response
                .headers()
                .get_all(name)
                .iter()
                .map(|value| value.to_str().map(str::to_string))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| {
                    self.last_safe_dispatch_category = Some(SafeDispatchCategory::ResponseRead);
                    DispatchFailure::Rejected
                })?;
            if !values.is_empty() {
                headers.insert(name.to_string(), values);
            }
        }
        let mut body = Vec::new();
        response
            .take((request.max_response_bytes + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| {
                self.last_safe_dispatch_category = Some(SafeDispatchCategory::ResponseRead);
                DispatchFailure::Rejected
            })?;
        if body.len() > request.max_response_bytes {
            return Err(DispatchFailure::ResponseTooLarge);
        }
        let expected_href = url.path().to_string();
        let expected_url = url.to_string();
        Ok(WebDavResponse {
            status,
            headers,
            body,
            expected_href,
            expected_url,
        })
    }

    fn safe_dispatch_category(&self) -> Option<SafeDispatchCategory> {
        self.last_safe_dispatch_category
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Default)]
    struct Scripted {
        responses: VecDeque<Result<WebDavResponse, DispatchFailure>>,
        requests: Vec<WebDavRequest>,
        safe_dispatch_category: Option<SafeDispatchCategory>,
    }

    impl WebDavTransport for Scripted {
        fn execute(&mut self, request: WebDavRequest) -> Result<WebDavResponse, DispatchFailure> {
            self.requests.push(request);
            self.responses.pop_front().expect("scripted response")
        }

        fn safe_dispatch_category(&self) -> Option<SafeDispatchCategory> {
            self.safe_dispatch_category
        }
    }

    fn response(status: u16, path: &str) -> WebDavResponse {
        WebDavResponse {
            status,
            expected_href: format!("/dav/{path}/"),
            expected_url: format!("https://example.test/dav/{path}/"),
            ..WebDavResponse::default()
        }
    }

    fn p02_pointer_fixture() -> (String, Vec<u8>) {
        let writer_sync_peer_id = "p02-z4-writer";
        let writer_key = writer_key_hex_v2(writer_sync_peer_id);
        let pointer = format!(
            "{{\"currentHeadsSnapshotSha256\":\"{}\",\"schema\":\"h2o.studio.syncWriterState.v2\",\"writerSyncPeerId\":\"{}\"}}",
            "d".repeat(64),
            writer_sync_peer_id
        )
        .into_bytes();
        (writer_key, pointer)
    }

    fn collection(path: &str) -> WebDavResponse {
        let mut result = response(207, path);
        result.body = format!("<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\"><D:response><D:href>/dav/{path}/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>").into_bytes();
        result
    }

    fn collection_with(path: &str, href: &str, propstats: &str) -> WebDavResponse {
        let mut result = response(207, path);
        result.body = format!("<?xml version=\"1.0\"?><D:multistatus xmlns:D=\"DAV:\"><D:response><D:href>{href}</D:href>{propstats}</D:response></D:multistatus>").into_bytes();
        result
    }

    fn collection_propstat(status: &str) -> String {
        format!("<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 {status}</D:status></D:propstat>")
    }

    #[test]
    fn deterministic_paths_are_contained_and_hash_only() {
        let key = "a".repeat(64);
        let blob = "b".repeat(64);
        let paths = derive_object_paths(&key, &blob).unwrap();
        assert_eq!(
            paths.revision,
            format!("round2a/objects/{key}/revisions/{blob}.json")
        );
        assert_eq!(paths.head, format!("round2a/objects/{key}/head.json"));
        assert!(!paths.revision.contains(':'));
    }

    #[test]
    fn production_relative_path_validator_preserves_p01_and_rejects_unsafe_paths() {
        for path in [
            "round2a",
            "round2a/objects",
            "round2a/objects/abc/revisions/def.json",
        ] {
            assert_eq!(validate_relative_path(path), Ok(()), "accepted: {path}");
        }
        for path in [
            "",
            "round2ax",
            "/round2a",
            "round2a/",
            "round2a//objects",
            "round2a\\objects",
            "round2a/%2e",
            "round2a/../objects",
            "round2a/./objects",
            "other/round2a",
        ] {
            assert_eq!(
                validate_relative_path(path),
                Err(DispatchFailure::Rejected),
                "rejected: {path}"
            );
        }
    }

    #[test]
    fn initial_layout_root_propfind_crosses_production_path_validation_before_any_mutation() {
        struct ProductionPathValidatingScripted {
            responses: VecDeque<Result<WebDavResponse, DispatchFailure>>,
            requests: Vec<WebDavRequest>,
        }

        impl WebDavTransport for ProductionPathValidatingScripted {
            fn execute(
                &mut self,
                request: WebDavRequest,
            ) -> Result<WebDavResponse, DispatchFailure> {
                validate_relative_path(&request.relative_path)?;
                self.requests.push(request);
                self.responses.pop_front().expect("scripted response")
            }
        }

        let key = "a".repeat(64);
        let mut transport = ProductionPathValidatingScripted {
            responses: VecDeque::from([Ok(response(401, "round2a"))]),
            requests: Vec::new(),
        };
        let failure =
            ensure_remote_object_layout_detailed(&mut transport, &key).expect_err("401 blocks");
        assert_eq!(failure.code, "round2a-layout-authentication-required");
        assert_eq!(failure.http_status, Some(401));
        assert_eq!(transport.requests.len(), 1);
        assert_eq!(transport.requests[0].method, Method::Propfind);
        assert_eq!(transport.requests[0].relative_path, "round2a");
        assert!(!transport
            .requests
            .iter()
            .any(|request| matches!(request.method, Method::Mkcol | Method::Put)));
    }

    #[test]
    fn layout_sequences_propfind_then_mkcol() {
        let key = "a".repeat(64);
        let paths = derive_object_paths(&key, &"b".repeat(64)).unwrap();
        let mut fake = Scripted::default();
        for path in &paths.collections {
            fake.responses.push_back(Ok(response(404, path)));
            fake.responses.push_back(Ok(response(201, path)));
        }
        ensure_remote_object_layout(&mut fake, &key).unwrap();
        assert_eq!(fake.requests.len(), 8);
        for pair in fake.requests.chunks(2) {
            assert_eq!(pair[0].method, Method::Propfind);
            assert_eq!(pair[1].method, Method::Mkcol);
        }
    }

    #[test]
    fn layout_405_requires_collection_proof() {
        let key = "a".repeat(64);
        let paths = derive_object_paths(&key, &"b".repeat(64)).unwrap();
        let mut fake = Scripted::default();
        fake.responses
            .push_back(Ok(response(404, &paths.collections[0])));
        fake.responses
            .push_back(Ok(response(405, &paths.collections[0])));
        fake.responses
            .push_back(Ok(collection(&paths.collections[0])));
        for path in paths.collections.iter().skip(1) {
            fake.responses.push_back(Ok(collection(path)));
        }
        ensure_remote_object_layout(&mut fake, &key).unwrap();
        assert_eq!(fake.requests[2].method, Method::Propfind);
    }

    #[test]
    fn layout_409_is_parent_missing() {
        let key = "a".repeat(64);
        let mut fake = Scripted::default();
        fake.responses.push_back(Ok(response(404, "round2a")));
        fake.responses.push_back(Ok(response(409, "round2a")));
        assert_eq!(
            ensure_remote_object_layout(&mut fake, &key).unwrap_err(),
            "round2a-layout-parent-missing"
        );
    }

    #[test]
    fn layout_propfind_statuses_are_safely_classified() {
        let key = "a".repeat(64);
        for (status, code) in [
            (200, "round2a-layout-propfind-failed"),
            (204, "round2a-layout-propfind-failed"),
            (301, "round2a-layout-redirect-refused"),
            (302, "round2a-layout-redirect-refused"),
            (307, "round2a-layout-redirect-refused"),
            (308, "round2a-layout-redirect-refused"),
            (401, "round2a-layout-authentication-required"),
            (403, "round2a-layout-access-forbidden"),
            (405, "round2a-layout-method-not-allowed"),
            (409, "round2a-layout-parent-conflict"),
            (423, "round2a-layout-locked"),
            (503, "round2a-layout-server-error"),
        ] {
            let mut fake = Scripted::default();
            let mut private = response(status, "round2a");
            private.body = b"PRIVATE BODY MUST NOT ESCAPE".to_vec();
            private
                .headers
                .insert("authorization".into(), vec!["PRIVATE".into()]);
            fake.responses.push_back(Ok(private));
            let failure = ensure_remote_object_layout_detailed(&mut fake, &key).unwrap_err();
            assert_eq!(failure.code, code);
            assert_eq!(failure.http_status, Some(status));
            assert!(!format!("{failure:?}").contains("PRIVATE"));
            assert_eq!(fake.requests.len(), 1);
            assert_eq!(fake.requests[0].method, Method::Propfind);
        }
    }

    #[test]
    fn layout_propfind_dispatch_failures_are_redacted() {
        let key = "a".repeat(64);
        for (dispatch, category, code) in [
            (
                DispatchFailure::Redirect,
                None,
                "round2a-layout-redirect-refused",
            ),
            (
                DispatchFailure::ResponseTooLarge,
                None,
                "round2a-layout-response-too-large",
            ),
            (
                DispatchFailure::Rejected,
                Some(SafeDispatchCategory::Connect),
                "round2a-layout-connect-failed",
            ),
            (
                DispatchFailure::Rejected,
                Some(SafeDispatchCategory::Timeout),
                "round2a-layout-timeout",
            ),
            (
                DispatchFailure::Rejected,
                Some(SafeDispatchCategory::Request),
                "round2a-layout-request-failed",
            ),
            (
                DispatchFailure::Rejected,
                Some(SafeDispatchCategory::ResponseRead),
                "round2a-layout-response-read-failed",
            ),
            (
                DispatchFailure::Rejected,
                None,
                "round2a-layout-propfind-failed",
            ),
        ] {
            let mut fake = Scripted {
                safe_dispatch_category: category,
                ..Scripted::default()
            };
            fake.responses.push_back(Err(dispatch));
            let failure = ensure_remote_object_layout_detailed(&mut fake, &key).unwrap_err();
            assert_eq!(failure.code, code);
            assert_eq!(failure.http_status, None);
            assert!(!failure.remote_side_effect_uncertain);
            assert_eq!(fake.requests.len(), 1);
            assert_eq!(fake.requests[0].method, Method::Propfind);
        }
    }

    #[test]
    fn malformed_propfind_body_reports_only_safe_status() {
        let key = "a".repeat(64);
        let mut fake = Scripted::default();
        let mut malformed = response(207, "round2a");
        malformed.body = b"<D:multistatus xmlns:D=\"DAV:\">PRIVATE MALFORMED BODY".to_vec();
        fake.responses.push_back(Ok(malformed));
        let failure = ensure_remote_object_layout_detailed(&mut fake, &key).unwrap_err();
        assert_eq!(failure.code, "round2a-layout-propfind-invalid");
        assert_eq!(failure.http_status, Some(207));
        assert!(!format!("{failure:?}").contains("PRIVATE"));
        assert_eq!(fake.requests.len(), 1);
        assert_eq!(fake.requests[0].method, Method::Propfind);
    }

    #[test]
    fn later_propfind_failure_can_follow_only_empty_collection_creation() {
        let key = "a".repeat(64);
        let mut fake = Scripted::default();
        fake.responses.push_back(Ok(response(404, "round2a")));
        fake.responses.push_back(Ok(response(201, "round2a")));
        fake.responses.push_back(Err(DispatchFailure::Rejected));
        let failure = ensure_remote_object_layout_detailed(&mut fake, &key).unwrap_err();
        assert_eq!(failure.code, "round2a-layout-propfind-failed");
        assert_eq!(
            fake.requests
                .iter()
                .map(|request| request.method)
                .collect::<Vec<_>>(),
            vec![Method::Propfind, Method::Mkcol, Method::Propfind]
        );
        assert!(!fake
            .requests
            .iter()
            .any(|request| request.method == Method::Put));
    }

    #[test]
    fn layout_mkcol_statuses_are_classified_and_replay_safe() {
        let key = "a".repeat(64);
        for (status, code, uncertain) in [
            (204, "round2a-layout-create-failed", false),
            (301, "round2a-layout-create-redirect-refused", true),
            (401, "round2a-layout-create-authentication-required", false),
            (403, "round2a-layout-create-access-forbidden", false),
            (409, "round2a-layout-parent-missing", false),
            (423, "round2a-layout-create-locked", false),
            (503, "round2a-layout-create-server-error", false),
        ] {
            let mut fake = Scripted::default();
            fake.responses.push_back(Ok(response(404, "round2a")));
            fake.responses.push_back(Ok(response(status, "round2a")));
            let failure = ensure_remote_object_layout_detailed(&mut fake, &key).unwrap_err();
            assert_eq!(failure.code, code);
            assert_eq!(failure.http_status, Some(status));
            assert_eq!(failure.remote_side_effect_uncertain, uncertain);
            assert_eq!(
                fake.requests
                    .iter()
                    .map(|request| request.method)
                    .collect::<Vec<_>>(),
                vec![Method::Propfind, Method::Mkcol]
            );
            assert!(!fake
                .requests
                .iter()
                .any(|request| request.method == Method::Put));
        }
    }

    #[test]
    fn layout_mkcol_dispatch_failures_remain_restart_recoverable() {
        let key = "a".repeat(64);
        for (dispatch, code) in [
            (
                DispatchFailure::Redirect,
                "round2a-layout-create-redirect-refused",
            ),
            (
                DispatchFailure::ResponseTooLarge,
                "round2a-layout-create-response-too-large",
            ),
            (
                DispatchFailure::SideEffectUncertain,
                "round2a-layout-create-uncertain",
            ),
            (DispatchFailure::Rejected, "round2a-layout-create-uncertain"),
        ] {
            let mut fake = Scripted::default();
            fake.responses.push_back(Ok(response(404, "round2a")));
            fake.responses.push_back(Err(dispatch));
            let failure = ensure_remote_object_layout_detailed(&mut fake, &key).unwrap_err();
            assert_eq!(failure.code, code);
            assert_eq!(failure.http_status, None);
            assert!(failure.remote_side_effect_uncertain);
            assert_eq!(fake.requests[1].method, Method::Mkcol);
        }
    }

    #[test]
    fn foreign_or_non_collection_propfind_is_rejected() {
        let key = "a".repeat(64);
        let propstat = collection_propstat("200 OK");
        for href in [
            "https://foreign.example/dav/round2a/",
            "https://user@example.test/dav/round2a/",
            "https://example.test:444/dav/round2a/",
            "https://example.test/dav/round2a/?query=1",
            "https://example.test/dav/round2a/#fragment",
            "https://example.test/dav//round2a/",
            "https://example.test/dav/%72ound2a/",
        ] {
            let mut fake = Scripted::default();
            fake.responses
                .push_back(Ok(collection_with("round2a", href, &propstat)));
            assert_eq!(
                ensure_remote_object_layout(&mut fake, &key).unwrap_err(),
                "round2a-layout-propfind-invalid"
            );
            assert_eq!(fake.requests.len(), 1);
        }
        let mut resource = collection("round2a");
        resource.body = String::from_utf8(resource.body)
            .unwrap()
            .replace("<D:collection/>", "")
            .into_bytes();
        assert!(exact_collection_from_multistatus(&resource).is_err());
    }

    #[test]
    fn exact_absolute_and_relative_collection_hrefs_are_accepted() {
        let key = "a".repeat(64);
        let paths = derive_object_paths(&key, &"b".repeat(64)).unwrap();
        for first_href in ["https://example.test/dav/round2a/", "/dav/round2a/"] {
            let mut fake = Scripted::default();
            fake.responses.push_back(Ok(collection_with(
                "round2a",
                first_href,
                &collection_propstat("200 OK"),
            )));
            for path in paths.collections.iter().skip(1) {
                fake.responses.push_back(Ok(collection(path)));
            }
            ensure_remote_object_layout(&mut fake, &key).unwrap();
            assert_eq!(fake.requests.len(), 4);
        }
    }

    #[test]
    fn collection_and_status_must_share_one_successful_propstat() {
        let key = "a".repeat(64);
        let failing_collection = collection_propstat("404 Not Found");
        let unrelated_success = "<D:propstat><D:prop><D:displayname>round2a</D:displayname></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>";
        let conflicting = format!(
            "{}{}",
            collection_propstat("200 OK"),
            collection_propstat("404 Not Found")
        );
        for propstats in [
            format!("{failing_collection}{unrelated_success}"),
            conflicting,
        ] {
            let mut fake = Scripted::default();
            fake.responses
                .push_back(Ok(collection_with("round2a", "/dav/round2a/", &propstats)));
            assert_eq!(
                ensure_remote_object_layout(&mut fake, &key).unwrap_err(),
                "round2a-layout-propfind-invalid"
            );
            assert_eq!(fake.requests.len(), 1);
        }
    }

    #[test]
    fn malformed_dav_structure_cannot_prove_a_collection() {
        let key = "a".repeat(64);
        let invalid_documents = [
            // A propstat status cannot be nested inside prop.
            r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/round2a/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype><D:status>HTTP/1.1 200 OK</D:status></D:prop></D:propstat></D:response></D:multistatus>"#,
            // Nor can it be nested inside resourcetype.
            r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/round2a/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><D:status>HTTP/1.1 200 OK</D:status></D:resourcetype></D:prop></D:propstat></D:response></D:multistatus>"#,
            // multistatus must be the document element.
            r#"<D:wrapper xmlns:D="DAV:"><D:multistatus><D:response><D:href>/dav/round2a/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus></D:wrapper>"#,
            // response cannot stand outside multistatus.
            r#"<D:response xmlns:D="DAV:"><D:href>/dav/round2a/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"#,
            // propstat must be a direct child of response.
            r#"<D:multistatus xmlns:D="DAV:"><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:multistatus>"#,
            // A response-level status cannot substitute for propstat status.
            r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/round2a/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:response></D:multistatus>"#,
            // An incomplete required hierarchy cannot be accepted at EOF.
            r#"<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/round2a/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/>"#,
        ];

        for document in invalid_documents {
            let mut fake = Scripted::default();
            let mut proof = response(207, "round2a");
            proof.body = document.as_bytes().to_vec();
            fake.responses.push_back(Ok(proof));
            assert_eq!(
                ensure_remote_object_layout(&mut fake, &key).unwrap_err(),
                "round2a-layout-propfind-invalid"
            );
            assert_eq!(fake.requests.len(), 1);
        }
    }

    #[test]
    fn direct_child_propstat_status_after_prop_is_accepted() {
        let key = "a".repeat(64);
        let paths = derive_object_paths(&key, &"b".repeat(64)).unwrap();
        let mut fake = Scripted::default();
        for path in &paths.collections {
            fake.responses.push_back(Ok(collection(path)));
        }
        ensure_remote_object_layout(&mut fake, &key).unwrap();
        assert_eq!(fake.requests.len(), 4);
    }

    #[test]
    fn strong_etag_rejects_weak_missing_malformed_and_ambiguous() {
        let base = response(200, "round2a/x/head.json");
        assert_eq!(
            require_strong_etag(&base).unwrap_err(),
            "round2a-strong-etag-required"
        );
        for value in ["W/\"weak\"", "bad", "\"\""] {
            let mut candidate = base.clone();
            candidate.headers.insert("etag".into(), vec![value.into()]);
            assert!(require_strong_etag(&candidate).is_err());
        }
        let mut ambiguous = base;
        ambiguous
            .headers
            .insert("etag".into(), vec!["\"a\"".into(), "\"b\"".into()]);
        assert!(require_strong_etag(&ambiguous).is_err());
    }

    #[test]
    fn doubled_slash_location_is_rejected() {
        let mut candidate = response(201, "round2a/x/head.json");
        candidate
            .headers
            .insert("location".into(), vec!["/dav//round2a/x/head.json".into()]);
        assert!(exact_location_or_absent(&candidate).is_err());
    }

    #[test]
    fn p02_z4_paths_match_the_frozen_content_addressed_layout() {
        let object_key = "a".repeat(64);
        let revision_hash = "b".repeat(64);
        let writer_key = "c".repeat(64);
        let snapshot_hash = "d".repeat(64);
        assert_eq!(
            derive_p02_revision_path(&object_key, &revision_hash).unwrap(),
            format!("objects/{object_key}/revisions/{revision_hash}.json")
        );
        assert_eq!(
            derive_p02_heads_snapshot_path(&writer_key, &snapshot_hash).unwrap(),
            format!("writers/{writer_key}/heads/{snapshot_hash}.json")
        );
        assert_eq!(
            derive_p02_writer_state_path(&writer_key).unwrap(),
            format!("writers/{writer_key}/state.json")
        );
        assert_eq!(
            validate_relative_path(&format!("writers/{writer_key}/state.json")),
            Ok(())
        );
        assert_eq!(
            validate_relative_path(&format!(
                "objects/{object_key}/revisions/{revision_hash}.json"
            )),
            Ok(())
        );
        assert_eq!(
            validate_relative_path("writers/not-a-writer-key/state.json"),
            Err(DispatchFailure::Rejected)
        );
        assert_eq!(
            validate_relative_path(&format!("writers/{writer_key}/unexpected.json")),
            Err(DispatchFailure::Rejected)
        );
    }

    #[test]
    fn p02_z4_conditional_put_requests_emit_exact_precondition_headers() {
        let writer_key = "c".repeat(64);
        let state_path = derive_p02_writer_state_path(&writer_key).unwrap();
        let create = conditional_put_request(
            &state_path,
            br#"{"state":"create"}"#,
            ConditionalPutPrecondition::CreateIfAbsent,
        )
        .unwrap();
        assert_eq!(create.method, Method::Put);
        assert_eq!(
            create.headers.get("if-none-match").map(String::as_str),
            Some("*")
        );
        assert!(!create.headers.contains_key("if-match"));

        let update = conditional_put_request(
            &state_path,
            br#"{"state":"update"}"#,
            ConditionalPutPrecondition::MatchStrongEtag("\"prior-etag\"".into()),
        )
        .unwrap();
        assert_eq!(
            update.headers.get("if-match").map(String::as_str),
            Some("\"prior-etag\"")
        );
        assert!(!update.headers.contains_key("if-none-match"));
        assert!(conditional_put_request(
            &state_path,
            b"x",
            ConditionalPutPrecondition::MatchStrongEtag("W/\"weak\"".into())
        )
        .is_err());
    }

    #[test]
    fn p02_z4_conditional_put_requires_strong_response_etag() {
        let (writer_key, pointer) = p02_pointer_fixture();
        let state_path = derive_p02_writer_state_path(&writer_key).unwrap();
        let mut success = response(204, &state_path);
        success
            .headers
            .insert("etag".into(), vec!["\"new-strong-etag\"".into()]);
        let mut transport = Scripted::default();
        transport.responses.push_back(Ok(success));
        let result = execute_p02_writer_state_put(
            &mut transport,
            &writer_key,
            &pointer,
            Some("\"prior-etag\"".into()),
        )
        .unwrap();
        assert_eq!(result.http_status, 204);
        assert_eq!(result.strong_etag, "\"new-strong-etag\"");
        assert_eq!(
            transport.requests[0]
                .headers
                .get("if-match")
                .map(String::as_str),
            Some("\"prior-etag\"")
        );

        let mut missing_etag = Scripted::default();
        missing_etag
            .responses
            .push_back(Ok(response(204, &state_path)));
        let failure = execute_conditional_put(
            &mut missing_etag,
            &state_path,
            b"x",
            ConditionalPutPrecondition::CreateIfAbsent,
        )
        .unwrap_err();
        assert_eq!(failure.code, "p02-z4-conditional-put-strong-etag-required");
        assert!(failure.remote_side_effect_uncertain);
    }

    #[test]
    fn p02_z4_stale_pointer_precondition_fails_closed() {
        let (writer_key, pointer) = p02_pointer_fixture();
        let state_path = derive_p02_writer_state_path(&writer_key).unwrap();
        let mut stale = Scripted::default();
        stale.responses.push_back(Ok(response(412, &state_path)));
        let failure = execute_p02_writer_state_put(
            &mut stale,
            &writer_key,
            &pointer,
            Some("\"stale-etag\"".into()),
        )
        .unwrap_err();
        assert_eq!(failure.code, "p02-z4-pointer-stale-precondition");
        assert_eq!(failure.http_status, Some(412));
        assert!(!failure.remote_side_effect_uncertain);
        assert_eq!(stale.requests.len(), 1);
        assert_eq!(
            stale.requests[0]
                .headers
                .get("if-match")
                .map(String::as_str),
            Some("\"stale-etag\"")
        );

        let mut exists = Scripted::default();
        exists.responses.push_back(Ok(response(412, &state_path)));
        let create_failure =
            execute_p02_writer_state_put(&mut exists, &writer_key, &pointer, None).unwrap_err();
        assert_eq!(create_failure.code, "p02-z4-create-precondition-failed");

        let mut never_dispatched = Scripted::default();
        assert_eq!(
            execute_p02_writer_state_put(
                &mut never_dispatched,
                &writer_key,
                br#"{"schema":"not-a-pointer"}"#,
                None,
            )
            .unwrap_err()
            .code,
            "p02-z1-schema-invalid"
        );
        assert!(never_dispatched.requests.is_empty());
        assert_eq!(
            execute_p02_writer_state_put(&mut never_dispatched, &"e".repeat(64), &pointer, None,)
                .unwrap_err()
                .code,
            "p02-z4-writer-identity-mismatch"
        );
        assert!(never_dispatched.requests.is_empty());
    }

    #[test]
    fn p02_z4_uncertain_conditional_put_never_claims_failure_was_no_write() {
        let writer_key = "c".repeat(64);
        let state_path = derive_p02_writer_state_path(&writer_key).unwrap();
        for dispatch in [
            DispatchFailure::SideEffectUncertain,
            DispatchFailure::Rejected,
            DispatchFailure::Redirect,
            DispatchFailure::ResponseTooLarge,
        ] {
            let mut transport = Scripted::default();
            transport.responses.push_back(Err(dispatch));
            let failure = execute_conditional_put(
                &mut transport,
                &state_path,
                b"x",
                ConditionalPutPrecondition::CreateIfAbsent,
            )
            .unwrap_err();
            assert!(failure.remote_side_effect_uncertain);
        }
    }
}
