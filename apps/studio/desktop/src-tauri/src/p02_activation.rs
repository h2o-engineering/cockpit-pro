/*
 * P02 V7 activation authority — production repository-root resolver and the
 * governed format-gate ceremony writer.
 *
 * Desktop owns this because Desktop already owns the governed local-folder
 * destination binding, its authorization validation and its atomic write
 * discipline (item11_delivery_destination). Reusing those avoids a second
 * path authority; Chrome verifies read-only against the same contract.
 *
 * Two surfaces, deliberately separated:
 *   - the RESOLVER is read-only and creates nothing, ever;
 *   - the CEREMONY WRITER performs only the frozen V7 state writes and is
 *     unreachable from any normal runtime path. It refuses unless an explicit
 *     governed campaign token, operator authorization and evidence of P01
 *     writer quiescence are all supplied together.
 *
 * V7 scope only. This module can create exactly one file, the format
 * authority; it never writes writers/, objects/, heads snapshots, revisions,
 * tips or any other V8 artifact.
 */

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::item11_delivery_destination::{
    authorization_root, load_binding, read_bounded, revalidate_binding, write_exact_temporary,
};

/*
 * ONE canonical P02 authority implementation, shared with the governed
 * baseline-supersession maintenance tool. Only AUTHORITY semantics move here -
 * the constants, the canonical document builder, the material projection, the
 * legacy-baseline observation and the digest. The delivery module's bounded
 * read and temp writer stay where they are: relocating them would change their
 * error identities for unrelated callers.
 */
use h2o_p02_authority_core as authority_core;
use h2o_p02_authority_core::sha256_hex;

/* Frozen child namespace; mirrors packages/core/sync-repository-root-v2.mjs. */
pub use authority_core::{
    P02_AUTHORITY_FILE, P02_AUTHORITY_TEMP_FILE, P02_BASELINE_SCHEMA, P02_CHILD_NAME,
    P02_LIBRARY_INFO_SCHEMA,
};

/* Frozen N.2 instantiation. These stay in the PARENT container, untouched. */
pub use authority_core::P02_LEGACY_BASELINE_ARTIFACTS;

/* Directory names that would mean a V8 publication already happened. */
const V8_FORBIDDEN_ENTRIES: [&str; 2] = ["objects", "writers"];

/*
 * The exact tokens the governed ceremony requires. They exist so no ordinary
 * runtime path - scheduler wake, alarm, page load, Publish, Receive, Apply,
 * mode toggle - can construct a valid activation request by accident.
 */
const GOVERNED_CAMPAIGN_TOKEN: &str = "P02_V7_FORMAT_GATE_ACTIVATION";
const OPERATOR_AUTHORIZATION_TOKEN: &str = "P02_V7_OPERATOR_AUTHORIZED_STATE_INTEGRITY_CEREMONY";

pub const ACTIVATION_NOT_AUTHORIZED: &str = "p02-v7-activation-not-authorized";
pub const ACTIVATION_P01_NOT_QUIESCED: &str = "p02-v7-p01-writer-not-quiesced";
pub const ACTIVATION_CONTAINER_MISMATCH: &str = "p02-v7-container-mismatch";
pub const ACTIVATION_AUTHORITY_DIVERGENT: &str = "p02-v7-authority-divergent";
pub const ACTIVATION_AUTHORITY_MALFORMED: &str = "p02-v7-authority-malformed";
pub const ACTIVATION_V8_ARTIFACT_PRESENT: &str = "p02-v7-v8-artifact-present";
pub const ACTIVATION_ROOT_UNAVAILABLE: &str = "p02-v7-repository-root-unavailable";
pub const ACTIVATION_TEMP_EXISTS: &str = "p02-v7-activation-temp-exists";
pub const ACTIVATION_WRITE_FAILED: &str = "p02-v7-activation-write-failed";
pub const ACTIVATION_VERIFICATION_FAILED: &str = "p02-v7-activation-verification-failed";
pub const ACTIVATION_REQUEST_INVALID: &str = "p02-v7-activation-request-invalid";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P02RepositoryTarget {
    pub container_path: String,
    pub container_path_sha256_hex: String,
    pub destination_folder_leaf_name: String,
    pub repository_root: String,
    pub authority_path: String,
    pub repository_root_exists: bool,
    pub authority_present: bool,
    pub legacy_scope_path: String,
}

pub use authority_core::P02LegacyArtifactObservation;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct P02ActivateRequest {
    pub governed_campaign: String,
    pub operator_authorization: String,
    pub p01_writer_quiesced: bool,
    pub activated_at: String,
    pub activated_by_writer_sync_peer_id: String,
    pub expected_container_path_sha256_hex: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P02ActivationReceipt {
    pub ok: bool,
    pub verdict: &'static str,
    pub repository_root: String,
    pub authority_path: String,
    pub authority_sha256_hex: String,
    pub authority_byte_length: usize,
    pub authority_canonical_bytes: String,
    pub legacy_baseline: Vec<P02LegacyArtifactObservation>,
    pub legacy_scope_path: String,
    pub v8_artifacts_present: bool,
    pub repository_entries: Vec<String>,
}

/* Read-only. Resolving must never create the child directory or any file. */
pub(crate) fn resolve_target_core(
    authorization_root: &Path,
) -> Result<P02RepositoryTarget, &'static str> {
    let binding = load_binding(authorization_root)?;
    let container = revalidate_binding(&binding)?;
    let repository_root = container.join(P02_CHILD_NAME);
    let authority_path = repository_root.join(P02_AUTHORITY_FILE);
    Ok(P02RepositoryTarget {
        container_path: container.to_string_lossy().into_owned(),
        container_path_sha256_hex: binding.canonical_path_sha256_hex.clone(),
        destination_folder_leaf_name: binding.destination_folder_leaf_name.clone(),
        repository_root: repository_root.to_string_lossy().into_owned(),
        authority_path: authority_path.to_string_lossy().into_owned(),
        repository_root_exists: repository_root.is_dir(),
        authority_present: authority_path.is_file(),
        legacy_scope_path: container.to_string_lossy().into_owned(),
    })
}

/*
 * Observe the frozen legacy artifacts in the PARENT container. Never writes.
 * The shared core owns the observation semantics; the reader and the error
 * identity stay this module's, so activation's failure codes are unchanged.
 */
pub(crate) fn observe_legacy_baseline(
    container: &Path,
) -> Result<Vec<P02LegacyArtifactObservation>, &'static str> {
    authority_core::observe_legacy_baseline_with(container, ACTIVATION_ROOT_UNAVAILABLE, |path| {
        read_bounded(path).map_err(|_| ACTIVATION_ROOT_UNAVAILABLE)
    })
}


pub(crate) use authority_core::canonical_library_info;

/* Compare only the material fields; provenance timestamps may differ. The
 * projection lives in the shared core so activation and supersession cannot
 * disagree about what "materially the same authority" means. */
fn material_signature(document: &str) -> Result<String, &'static str> {
    authority_core::material_signature(document, ACTIVATION_AUTHORITY_MALFORMED)
}

fn repository_entries(root: &Path) -> Vec<String> {
    let mut entries = match fs::read_dir(root) {
        Ok(iterator) => iterator
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        Err(_) => Vec::new(),
    };
    entries.sort();
    entries
}

pub(crate) fn activate_core(
    authorization_root: &Path,
    request: &P02ActivateRequest,
) -> Result<P02ActivationReceipt, &'static str> {
    /* Governed gate first: nothing is read or written before it passes. */
    if request.governed_campaign != GOVERNED_CAMPAIGN_TOKEN
        || request.operator_authorization != OPERATOR_AUTHORIZATION_TOKEN
    {
        return Err(ACTIVATION_NOT_AUTHORIZED);
    }
    if !request.p01_writer_quiesced {
        return Err(ACTIVATION_P01_NOT_QUIESCED);
    }
    if request.activated_at.is_empty()
        || request.activated_by_writer_sync_peer_id.is_empty()
        || request.expected_container_path_sha256_hex.len() != 64
    {
        return Err(ACTIVATION_REQUEST_INVALID);
    }

    let target = resolve_target_core(authorization_root)?;
    if target.container_path_sha256_hex != request.expected_container_path_sha256_hex {
        return Err(ACTIVATION_CONTAINER_MISMATCH);
    }
    let container = PathBuf::from(&target.container_path);
    let repository_root = PathBuf::from(&target.repository_root);
    let authority_path = PathBuf::from(&target.authority_path);

    /* Baseline is captured from live pre-state, never baked in. */
    let baseline = observe_legacy_baseline(&container)?;
    let canonical = canonical_library_info(
        &request.activated_at,
        &request.activated_by_writer_sync_peer_id,
        &baseline,
    );

    /* A repository that already published V8 artifacts is not activatable. */
    let existing_entries = repository_entries(&repository_root);
    let v8_present = existing_entries
        .iter()
        .any(|entry| V8_FORBIDDEN_ENTRIES.contains(&entry.as_str()));
    if v8_present {
        return Err(ACTIVATION_V8_ARTIFACT_PRESENT);
    }

    /* Replay is safe only when the present authority materially matches. */
    if authority_path.is_file() {
        let existing = read_bounded(&authority_path).map_err(|_| ACTIVATION_AUTHORITY_MALFORMED)?;
        let existing_text =
            String::from_utf8(existing).map_err(|_| ACTIVATION_AUTHORITY_MALFORMED)?;
        if material_signature(&existing_text)? != material_signature(&canonical)? {
            return Err(ACTIVATION_AUTHORITY_DIVERGENT);
        }
        return Ok(P02ActivationReceipt {
            ok: true,
            verdict: "activation-verified-replay",
            repository_root: target.repository_root,
            authority_path: target.authority_path,
            authority_sha256_hex: sha256_hex(existing_text.as_bytes()),
            authority_byte_length: existing_text.len(),
            authority_canonical_bytes: existing_text,
            legacy_baseline: baseline,
            legacy_scope_path: target.legacy_scope_path,
            v8_artifacts_present: false,
            repository_entries: existing_entries,
        });
    }

    /* Single atomic creation: temp write, promote, final read-back verify. */
    fs::create_dir_all(&repository_root).map_err(|_| ACTIVATION_ROOT_UNAVAILABLE)?;
    let temporary_path = repository_root.join(P02_AUTHORITY_TEMP_FILE);
    if temporary_path.exists() {
        return Err(ACTIVATION_TEMP_EXISTS);
    }
    write_exact_temporary(&temporary_path, canonical.as_bytes())
        .map_err(|_| ACTIVATION_WRITE_FAILED)?;
    fs::rename(&temporary_path, &authority_path).map_err(|_| {
        let _ = fs::remove_file(&temporary_path);
        ACTIVATION_WRITE_FAILED
    })?;
    let written = read_bounded(&authority_path).map_err(|_| ACTIVATION_VERIFICATION_FAILED)?;
    if written != canonical.as_bytes() {
        return Err(ACTIVATION_VERIFICATION_FAILED);
    }

    let entries = repository_entries(&repository_root);
    if entries
        .iter()
        .any(|entry| V8_FORBIDDEN_ENTRIES.contains(&entry.as_str()))
    {
        return Err(ACTIVATION_V8_ARTIFACT_PRESENT);
    }
    Ok(P02ActivationReceipt {
        ok: true,
        verdict: "activation-created",
        repository_root: target.repository_root,
        authority_path: target.authority_path,
        authority_sha256_hex: sha256_hex(canonical.as_bytes()),
        authority_byte_length: canonical.len(),
        authority_canonical_bytes: canonical,
        legacy_baseline: baseline,
        legacy_scope_path: target.legacy_scope_path,
        v8_artifacts_present: false,
        repository_entries: entries,
    })
}

#[tauri::command]
pub fn h2o_p02_resolve_repository_root(
    app: tauri::AppHandle,
) -> Result<P02RepositoryTarget, String> {
    resolve_target_core(&authorization_root(&app)?).map_err(str::to_string)
}

#[tauri::command]
pub fn h2o_p02_activate_format_gate(
    app: tauri::AppHandle,
    request: P02ActivateRequest,
) -> Result<P02ActivationReceipt, String> {
    activate_core(&authorization_root(&app)?, &request).map_err(str::to_string)
}

/*
 * O1-R3 B2 - read-only observation of the activation authority document.
 *
 * The steady driver's format-gate port needs the CONTENT of library.info.json,
 * not merely whether the file exists, and no production Desktop path could
 * reach it: the generic P02 storage allowlist covers objects/ and writers/
 * only, and this document sits at the repository root. The activation ceremony
 * already returns these bytes, but that is a governed MUTATING ceremony, and
 * making a steady pass replay an activation just to read a file would put
 * activation tokens in the hands of every steady request. So this observes,
 * and does nothing else.
 *
 * It returns BYTES and does not interpret them. The gate's meaning belongs to
 * one implementation - the shared JS evaluateFormatGate that P02 publication
 * already consults - and a second Rust reading of the same document would be a
 * second answer to the same question.
 */
pub const LIBRARY_AUTHORITY_SCHEMA: &str = "h2o.studio.syncLibraryAuthority.p02.v1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P02LibraryAuthorityObservation {
    pub schema: &'static str,
    pub present: bool,
    /* Absent and unreadable are different facts and stay different: a reader
     * that conflated them would let an I/O failure look like an un-activated
     * repository, which is exactly the state that permits initialization. */
    pub readable: bool,
    pub repository_root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_bytes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256_hex: Option<String>,
}

pub(crate) fn read_library_authority_core(repository_root: &Path) -> P02LibraryAuthorityObservation {
    let path = repository_root.join(P02_AUTHORITY_FILE);
    let observation = |present, readable, bytes: Option<String>| P02LibraryAuthorityObservation {
        schema: LIBRARY_AUTHORITY_SCHEMA,
        present,
        readable,
        repository_root: repository_root.to_string_lossy().to_string(),
        sha256_hex: bytes.as_ref().map(|text| sha256_hex(text.as_bytes())),
        canonical_bytes: bytes,
    };
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => match read_bounded(&path) {
            Ok(raw) => match String::from_utf8(raw) {
                Ok(text) => observation(true, true, Some(text)),
                Err(_) => observation(true, false, None),
            },
            Err(_) => observation(true, false, None),
        },
        /* A symlink or a directory in the authority's place is not an authority. */
        Ok(_) => observation(true, false, None),
        Err(error) if error.kind() == ErrorKind::NotFound => observation(false, true, None),
        Err(_) => observation(true, false, None),
    }
}

#[tauri::command]
pub fn h2o_p02_read_library_authority(
    app: tauri::AppHandle,
) -> Result<P02LibraryAuthorityObservation, String> {
    /* No path parameter: the repository is the binding's, exactly as it is for
     * every other governed P02 command. */
    let target = resolve_target_core(&authorization_root(&app)?).map_err(str::to_string)?;
    Ok(read_library_authority_core(&PathBuf::from(
        &target.repository_root,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::item11_delivery_destination::{
        binding_from_directory, persist_binding, ConfiguredPathMode,
    };
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /* Removes its temp tree when the test ends, so runs leave no litter. */
    struct Fixture {
        base: PathBuf,
        authority: PathBuf,
        container: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    /* Disposable fixture: a temp container plus its authorization binding. */
    fn fixture(label: &str) -> Fixture {
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        /* Unique per run and cleared first: a leftover directory from an
         * earlier run would otherwise make an "empty container" non-empty. */
        let base = std::env::temp_dir().join(format!(
            "p02-v7-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);
        let authority = base.join("authority");
        let container = base.join("container");
        fs::create_dir_all(&authority).unwrap();
        fs::create_dir_all(&container).unwrap();
        let binding = binding_from_directory(&container, ConfiguredPathMode::Absolute).unwrap();
        persist_binding(&authority, &binding).unwrap();
        Fixture { base, authority, container }
    }

    fn request(container_hash: &str) -> P02ActivateRequest {
        P02ActivateRequest {
            governed_campaign: GOVERNED_CAMPAIGN_TOKEN.to_string(),
            operator_authorization: OPERATOR_AUTHORIZATION_TOKEN.to_string(),
            p01_writer_quiesced: true,
            activated_at: "2026-08-25T00:00:00.000Z".to_string(),
            activated_by_writer_sync_peer_id: "studio-desktop:tauri:sqlite:peer-1".to_string(),
            expected_container_path_sha256_hex: container_hash.to_string(),
        }
    }

    fn container_hash(authority: &Path) -> String {
        resolve_target_core(authority).unwrap().container_path_sha256_hex
    }

    /* Cross-language contract vector: identical to the shared JS builder. */
    #[test]
    fn canonical_library_info_matches_the_shared_js_bytes() {
        let baseline = vec![
            P02LegacyArtifactObservation {
                path: "round2-item9-delivery.json".to_string(),
                present: true,
                sha256: Some("a".repeat(64)),
            },
            P02LegacyArtifactObservation {
                path: "h2o-local-publication.v1.json".to_string(),
                present: false,
                sha256: None,
            },
        ];
        let canonical = canonical_library_info(
            "2026-08-25T00:00:00.000Z",
            "studio-desktop:tauri:sqlite:peer-1",
            &baseline,
        );
        let expected = concat!(
            "{\"activatedAt\":\"2026-08-25T00:00:00.000Z\",",
            "\"activatedByWriterSyncPeerId\":\"studio-desktop:tauri:sqlite:peer-1\",",
            "\"formatVersion\":2,\"layoutEpoch\":1,\"legacyBaselineReceipt\":{\"artifacts\":[",
            "{\"path\":\"h2o-local-publication.v1.json\",\"present\":false,\"sha256\":null},",
            "{\"path\":\"round2-item9-delivery.json\",\"present\":true,\"sha256\":\"",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}],",
            "\"capturedAt\":\"2026-08-25T00:00:00.000Z\",",
            "\"schema\":\"h2o.studio.syncLegacyBaseline.p02.v1\"},",
            "\"minimumCompatibleProtocolVersion\":2,",
            "\"schema\":\"h2o.studio.syncLibraryInfo.p02.v1\"}"
        );
        assert_eq!(canonical, expected);
    }

    /* L: resolving creates nothing at all. */
    #[test]
    fn resolver_is_read_only_and_creates_nothing() {
        let fx = fixture("resolver");
        let target = resolve_target_core(&fx.authority).unwrap();
        assert!(target.repository_root.ends_with("h2o-object-sync"));
        assert!(!target.repository_root_exists);
        assert!(!target.authority_present);
        assert!(!fx.container.join(P02_CHILD_NAME).exists());
        assert_eq!(fs::read_dir(&fx.container).unwrap().count(), 0);
    }

    /* A: genuinely empty container activates and creates exactly one file. */
    #[test]
    fn empty_container_activates_with_a_single_authority_file() {
        let fx = fixture("empty");
        let receipt = activate_core(&fx.authority, &request(&container_hash(&fx.authority))).unwrap();
        assert_eq!(receipt.verdict, "activation-created");
        assert!(!receipt.v8_artifacts_present);
        assert_eq!(receipt.repository_entries, vec![P02_AUTHORITY_FILE.to_string()]);
        assert!(receipt.legacy_baseline.iter().all(|item| !item.present));
        let root = fx.container.join(P02_CHILD_NAME);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }

    /* B: legacy artifacts are fingerprinted from live pre-state, untouched. */
    #[test]
    fn legacy_artifacts_are_fingerprinted_and_never_modified() {
        let fx = fixture("legacy");
        fs::write(fx.container.join("round2-item9-delivery.json"), b"legacy-delivery").unwrap();
        let before = fs::read(fx.container.join("round2-item9-delivery.json")).unwrap();
        let receipt = activate_core(&fx.authority, &request(&container_hash(&fx.authority))).unwrap();
        let entry = receipt
            .legacy_baseline
            .iter()
            .find(|item| item.path == "round2-item9-delivery.json")
            .unwrap();
        assert!(entry.present);
        assert_eq!(entry.sha256.as_deref().unwrap(), sha256_hex(b"legacy-delivery"));
        let absent = receipt
            .legacy_baseline
            .iter()
            .find(|item| item.path == "h2o-local-publication.v1.json")
            .unwrap();
        assert!(!absent.present && absent.sha256.is_none());
        /* Untouched, and never copied into the child repository. */
        assert_eq!(fs::read(fx.container.join("round2-item9-delivery.json")).unwrap(), before);
        assert!(!fx
            .container
            .join(P02_CHILD_NAME)
            .join("round2-item9-delivery.json")
            .exists());
    }

    /* C: unknown parent content never blocks and is never touched. */
    #[test]
    fn unknown_container_content_is_left_alone() {
        let fx = fixture("unknown");
        fs::write(fx.container.join("someone-elses-file.txt"), b"not ours").unwrap();
        activate_core(&fx.authority, &request(&container_hash(&fx.authority))).unwrap();
        assert_eq!(
            fs::read(fx.container.join("someone-elses-file.txt")).unwrap(),
            b"not ours"
        );
    }

    /* D: a malformed pre-existing authority fails closed and is not repaired. */
    #[test]
    fn malformed_existing_authority_fails_closed() {
        let fx = fixture("malformed");
        let root = fx.container.join(P02_CHILD_NAME);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(P02_AUTHORITY_FILE), b"{not json").unwrap();
        assert_eq!(
            activate_core(&fx.authority, &request(&container_hash(&fx.authority))).unwrap_err(),
            ACTIVATION_AUTHORITY_MALFORMED
        );
        assert_eq!(fs::read(root.join(P02_AUTHORITY_FILE)).unwrap(), b"{not json");
    }

    /* E: identical replay verifies without rewriting. */
    #[test]
    fn identical_replay_is_verified_without_rewriting() {
        let fx = fixture("replay");
        let hash = container_hash(&fx.authority);
        let first = activate_core(&fx.authority, &request(&hash)).unwrap();
        let path = fx.container.join(P02_CHILD_NAME).join(P02_AUTHORITY_FILE);
        let written = fs::metadata(&path).unwrap().modified().unwrap();
        let second = activate_core(&fx.authority, &request(&hash)).unwrap();
        assert_eq!(second.verdict, "activation-verified-replay");
        assert_eq!(second.authority_sha256_hex, first.authority_sha256_hex);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), written);
    }

    /* F: a materially different existing authority is never overwritten. */
    #[test]
    fn divergent_existing_authority_is_never_overwritten() {
        let fx = fixture("divergent");
        let root = fx.container.join(P02_CHILD_NAME);
        fs::create_dir_all(&root).unwrap();
        let foreign = concat!(
            "{\"activatedAt\":\"2020-01-01T00:00:00.000Z\",",
            "\"activatedByWriterSyncPeerId\":\"other\",\"formatVersion\":9,\"layoutEpoch\":7,",
            "\"legacyBaselineReceipt\":{\"artifacts\":[],\"capturedAt\":\"x\",\"schema\":\"other\"},",
            "\"minimumCompatibleProtocolVersion\":9,\"schema\":\"other\"}"
        );
        fs::write(root.join(P02_AUTHORITY_FILE), foreign).unwrap();
        assert_eq!(
            activate_core(&fx.authority, &request(&container_hash(&fx.authority))).unwrap_err(),
            ACTIVATION_AUTHORITY_DIVERGENT
        );
        assert_eq!(
            fs::read_to_string(root.join(P02_AUTHORITY_FILE)).unwrap(),
            foreign
        );
    }

    /* G: a legacy artifact changed after capture yields a different receipt. */
    #[test]
    fn changed_legacy_artifact_changes_the_baseline_and_diverges() {
        let fx = fixture("drift");
        let hash = container_hash(&fx.authority);
        fs::write(fx.container.join("round2-item9-delivery.json"), b"first").unwrap();
        activate_core(&fx.authority, &request(&hash)).unwrap();
        fs::write(fx.container.join("round2-item9-delivery.json"), b"changed").unwrap();
        assert_eq!(
            activate_core(&fx.authority, &request(&hash)).unwrap_err(),
            ACTIVATION_AUTHORITY_DIVERGENT
        );
    }

    /* H: activation refuses unless P01 quiescence evidence is supplied. */
    #[test]
    fn activation_requires_p01_quiescence_evidence() {
        let fx = fixture("quiesce");
        let mut req = request(&container_hash(&fx.authority));
        req.p01_writer_quiesced = false;
        assert_eq!(
            activate_core(&fx.authority, &req).unwrap_err(),
            ACTIVATION_P01_NOT_QUIESCED
        );
    }

    /* I: no canonical folder authority means no resolution and no write. */
    #[test]
    fn missing_folder_authority_fails_closed() {
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let empty = std::env::temp_dir().join(format!(
            "p02-v7-noauth-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&empty);
        fs::create_dir_all(&empty).unwrap();
        assert!(resolve_target_core(&empty).is_err());
        assert!(activate_core(&empty, &request(&"0".repeat(64))).is_err());
        let _ = fs::remove_dir_all(&empty);
    }

    /* J: V7 creates zero V8 artifacts, and refuses if any already exist. */
    #[test]
    fn v7_creates_no_v8_artifacts_and_refuses_when_present() {
        let fx = fixture("v8");
        let receipt = activate_core(&fx.authority, &request(&container_hash(&fx.authority))).unwrap();
        for forbidden in V8_FORBIDDEN_ENTRIES {
            assert!(!receipt.repository_entries.contains(&forbidden.to_string()));
            assert!(!fx.container.join(P02_CHILD_NAME).join(forbidden).exists());
        }
        fs::create_dir_all(fx.container.join(P02_CHILD_NAME).join("writers")).unwrap();
        assert_eq!(
            activate_core(&fx.authority, &request(&container_hash(&fx.authority))).unwrap_err(),
            ACTIVATION_V8_ARTIFACT_PRESENT
        );
    }

    /* K: re-reading after activation yields the same bytes and classification. */
    #[test]
    fn reread_after_activation_is_stable() {
        let fx = fixture("reread");
        let receipt = activate_core(&fx.authority, &request(&container_hash(&fx.authority))).unwrap();
        let path = fx.container.join(P02_CHILD_NAME).join(P02_AUTHORITY_FILE);
        let reread = fs::read_to_string(&path).unwrap();
        assert_eq!(reread, receipt.authority_canonical_bytes);
        assert_eq!(sha256_hex(reread.as_bytes()), receipt.authority_sha256_hex);
        let target = resolve_target_core(&fx.authority).unwrap();
        assert!(target.authority_present && target.repository_root_exists);
    }

    /* The governed gate: ordinary callers cannot activate. */
    #[test]
    fn ungoverned_requests_are_refused_before_any_read() {
        let fx = fixture("ungoverned");
        let hash = container_hash(&fx.authority);
        for (campaign, operator) in [
            ("", OPERATOR_AUTHORIZATION_TOKEN),
            (GOVERNED_CAMPAIGN_TOKEN, ""),
            ("auto", "wake"),
        ] {
            let mut req = request(&hash);
            req.governed_campaign = campaign.to_string();
            req.operator_authorization = operator.to_string();
            assert_eq!(
                activate_core(&fx.authority, &req).unwrap_err(),
                ACTIVATION_NOT_AUTHORIZED
            );
        }
        assert!(!fx.container.join(P02_CHILD_NAME).exists());
    }

    /* Container identity must match what the caller expected. */
    #[test]
    fn container_hash_mismatch_refuses() {
        let fx = fixture("mismatch");
        assert_eq!(
            activate_core(&fx.authority, &request(&"b".repeat(64))).unwrap_err(),
            ACTIVATION_CONTAINER_MISMATCH
        );
        assert!(!fx.container.join(P02_CHILD_NAME).exists());
    }
}
