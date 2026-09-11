/*
 * P02 canonical authority core.
 *
 * ONE implementation of the P02 `library.info.json` authority semantics, shared
 * by the Desktop activation path (`p02_activation.rs`) and by the governed
 * one-shot baseline-supersession maintenance tool. Activation and supersession
 * write the SAME document shape, compare it the SAME way, and observe the SAME
 * legacy baseline; a second copy of any of that is exactly how the two could
 * drift into producing authorities that disagree.
 *
 * This crate owns AUTHORITY semantics only. Filesystem primitives that already
 * belong to other Desktop modules are deliberately not moved here: relocating
 * them would change their error identities for unrelated callers, which the
 * refactor contract forbids. The bounded read/write below exist for the
 * standalone tool, which has no Tauri module graph to borrow from.
 */

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

/* Frozen child namespace; mirrors packages/core/sync-repository-root-v2.mjs. */
pub const P02_CHILD_NAME: &str = "h2o-object-sync";
pub const P02_AUTHORITY_FILE: &str = "library.info.json";
pub const P02_AUTHORITY_TEMP_FILE: &str = ".library.info.json.tmp";
pub const P02_LIBRARY_INFO_SCHEMA: &str = "h2o.studio.syncLibraryInfo.p02.v1";
pub const P02_BASELINE_SCHEMA: &str = "h2o.studio.syncLegacyBaseline.p02.v1";
pub const P02_FORMAT_VERSION: u32 = 2;
pub const P02_MINIMUM_COMPATIBLE_PROTOCOL_VERSION: u32 = 2;
pub const P02_INITIAL_LAYOUT_EPOCH: u32 = 1;

/* The frozen N.2 legacy compatibility artifacts, in the parent container. */
pub const P02_LEGACY_BASELINE_ARTIFACTS: [&str; 2] =
    ["h2o-local-publication.v1.json", "round2-item9-delivery.json"];

/*
 * Content-addressed predecessor history. An authority that is superseded is
 * never edited and never discarded: its exact bytes are preserved under a name
 * derived from their own hash, so the archive location IS the proof of what was
 * archived.
 */
pub const P02_AUTHORITY_HISTORY_DIR: &str = "authority-history";

pub fn authority_history_file_name(predecessor_sha256_hex: &str) -> String {
    format!("library.info.{predecessor_sha256_hex}.json")
}

/*
 * Retirement evidence, content-addressed by the authority whose supersession
 * authorized it. It lives beside the predecessor archive - inside the
 * repository's own history directory, never in the PARENT container that the
 * legacy baseline scan reads - so it cannot be mistaken for a baseline artifact
 * or a transport leaf.
 *
 * It serves two purposes. It cryptographically binds the exact bytes that were
 * removed, and its presence is the proof that THIS tool already passed its
 * destructive step: recovery after an interruption is decided by evidence, not
 * by assuming that an absent file must have been our doing.
 */
pub const RETIREMENT_RECORD_SCHEMA: &str = "h2o.studio.syncBaselineRetirementRecord.p02.v1";

pub fn retirement_record_file_name(predecessor_sha256_hex: &str) -> String {
    format!("retirement.{predecessor_sha256_hex}.json")
}

pub fn canonical_retirement_record(
    predecessor_sha256_hex: &str,
    retired_artifact: &str,
    retired_sha256_hex: &str,
    retired_byte_length: usize,
    retired_at: &str,
    retired_by: &str,
) -> String {
    format!(
        concat!(
            "{{\"predecessorAuthoritySha256\":{},\"retiredArtifact\":{},",
            "\"retiredAt\":{},\"retiredByWriterSyncPeerId\":{},",
            "\"retiredByteLength\":{},\"retiredSha256\":{},\"schema\":{}}}"
        ),
        json_string(predecessor_sha256_hex),
        json_string(retired_artifact),
        json_string(retired_at),
        json_string(retired_by),
        retired_byte_length,
        json_string(retired_sha256_hex),
        json_string(RETIREMENT_RECORD_SCHEMA),
    )
}

pub const CORE_READ_FAILED: &str = "p02-authority-core-read-failed";
pub const CORE_WRITE_FAILED: &str = "p02-authority-core-write-failed";
pub const CORE_TEMP_EXISTS: &str = "p02-authority-core-temp-exists";
pub const CORE_AUTHORITY_MALFORMED: &str = "p02-authority-core-authority-malformed";

/* Same bound the Desktop delivery reader applies to a single authority file. */
pub const MAX_AUTHORITY_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P02LegacyArtifactObservation {
    pub path: String,
    pub present: bool,
    pub sha256: Option<String>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

pub fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn artifacts_fragment(baseline: &[P02LegacyArtifactObservation]) -> String {
    let mut sorted: Vec<&P02LegacyArtifactObservation> = baseline.iter().collect();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    sorted
        .iter()
        .map(|item| {
            format!(
                "{{\"path\":{},\"present\":{},\"sha256\":{}}}",
                json_string(&item.path),
                if item.present { "true" } else { "false" },
                match &item.sha256 {
                    Some(value) => json_string(value),
                    None => "null".to_string(),
                }
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

/*
 * Canonical bytes, sorted keys, byte-identical to the shared JS builder in
 * packages/core/sync-repository-root-v2.mjs. Cross-language agreement is what
 * lets Chrome verify the authority Desktop wrote.
 */
pub fn canonical_library_info(
    activated_at: &str,
    activated_by: &str,
    baseline: &[P02LegacyArtifactObservation],
) -> String {
    format!(
        concat!(
            "{{\"activatedAt\":{},\"activatedByWriterSyncPeerId\":{},",
            "\"formatVersion\":{},\"layoutEpoch\":{},",
            "\"legacyBaselineReceipt\":{{\"artifacts\":[{}],\"capturedAt\":{},\"schema\":{}}},",
            "\"minimumCompatibleProtocolVersion\":{},\"schema\":{}}}"
        ),
        json_string(activated_at),
        json_string(activated_by),
        P02_FORMAT_VERSION,
        P02_INITIAL_LAYOUT_EPOCH,
        artifacts_fragment(baseline),
        json_string(activated_at),
        json_string(P02_BASELINE_SCHEMA),
        P02_MINIMUM_COMPATIBLE_PROTOCOL_VERSION,
        json_string(P02_LIBRARY_INFO_SCHEMA),
    )
}

/*
 * The successor. Identical to `canonical_library_info` except that the receipt
 * additionally carries `supersedes`, the additive lineage field.
 *
 * `supersedes` is placed INSIDE legacyBaselineReceipt deliberately. The format
 * gate's `parseLibraryInfo` allow-lists TOP-LEVEL keys and rejects any it does
 * not know (`unknown-key:<key>`), but it does not recurse into the receipt; the
 * baseline observer's `parseReceipt` validates the artifacts array and ignores
 * unknown receipt keys; and both material comparators - Rust
 * `material_signature` and JS `compareExistingAuthority` - project only the
 * receipt's `schema` and `artifacts`. A top-level field would be refused by
 * every existing reader. Key order stays sorted: supersedes < schema is false,
 * so it is emitted between `schema` and the closing brace.
 */
pub fn canonical_library_info_superseded(
    activated_at: &str,
    activated_by: &str,
    baseline: &[P02LegacyArtifactObservation],
    predecessor_sha256_hex: &str,
    superseded_at: &str,
    generation: u32,
) -> String {
    format!(
        concat!(
            "{{\"activatedAt\":{},\"activatedByWriterSyncPeerId\":{},",
            "\"formatVersion\":{},\"layoutEpoch\":{},",
            "\"legacyBaselineReceipt\":{{\"artifacts\":[{}],\"capturedAt\":{},\"schema\":{},",
            "\"supersedes\":{{\"generation\":{},\"predecessorAuthoritySha256\":{},",
            "\"predecessorHistoryPath\":{},\"supersededAt\":{}}}}},",
            "\"minimumCompatibleProtocolVersion\":{},\"schema\":{}}}"
        ),
        json_string(activated_at),
        json_string(activated_by),
        P02_FORMAT_VERSION,
        P02_INITIAL_LAYOUT_EPOCH,
        artifacts_fragment(baseline),
        json_string(activated_at),
        json_string(P02_BASELINE_SCHEMA),
        generation,
        json_string(predecessor_sha256_hex),
        json_string(&format!(
            "{P02_AUTHORITY_HISTORY_DIR}/{}",
            authority_history_file_name(predecessor_sha256_hex)
        )),
        json_string(superseded_at),
        P02_MINIMUM_COMPATIBLE_PROTOCOL_VERSION,
        json_string(P02_LIBRARY_INFO_SCHEMA),
    )
}

/*
 * Compare only the material fields; provenance timestamps may differ. Note the
 * receipt projection is exactly `schema` + `artifacts`, so the additive
 * `supersedes` lineage never participates in divergence - the same projection
 * the JS `compareExistingAuthority` performs.
 */
pub fn material_signature(document: &str, malformed: &'static str) -> Result<String, &'static str> {
    let parsed: serde_json::Value = serde_json::from_str(document).map_err(|_| malformed)?;
    let object = parsed.as_object().ok_or(malformed)?;
    for key in [
        "schema",
        "formatVersion",
        "minimumCompatibleProtocolVersion",
        "layoutEpoch",
        "legacyBaselineReceipt",
    ] {
        if !object.contains_key(key) {
            return Err(malformed);
        }
    }
    let receipt = object
        .get("legacyBaselineReceipt")
        .and_then(|value| value.as_object())
        .ok_or(malformed)?;
    Ok(format!(
        "{}|{}|{}|{}|{}|{}",
        object.get("schema").unwrap(),
        object.get("formatVersion").unwrap(),
        object.get("minimumCompatibleProtocolVersion").unwrap(),
        object.get("layoutEpoch").unwrap(),
        receipt.get("schema").ok_or(malformed)?,
        receipt.get("artifacts").ok_or(malformed)?,
    ))
}

/*
 * Observe the frozen legacy artifacts in the PARENT container. Never writes.
 *
 * The reader is injected so each caller keeps its OWN error identity: the
 * Desktop activation path still reports its activation codes, and the
 * standalone tool reports the core codes. The observation SEMANTICS - which
 * artifacts, present/absent, hash on present only, a non-file entry is a hard
 * failure - are shared, which is the point.
 */
pub fn observe_legacy_baseline_with<R>(
    container: &Path,
    unavailable: &'static str,
    mut read_artifact: R,
) -> Result<Vec<P02LegacyArtifactObservation>, &'static str>
where
    R: FnMut(&Path) -> Result<Vec<u8>, &'static str>,
{
    let mut observed = Vec::new();
    for name in P02_LEGACY_BASELINE_ARTIFACTS {
        let path = container.join(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                let bytes = read_artifact(&path).map_err(|_| unavailable)?;
                observed.push(P02LegacyArtifactObservation {
                    path: name.to_string(),
                    present: true,
                    sha256: Some(sha256_hex(&bytes)),
                });
            }
            Ok(_) => return Err(unavailable),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                observed.push(P02LegacyArtifactObservation {
                    path: name.to_string(),
                    present: false,
                    sha256: None,
                });
            }
            Err(_) => return Err(unavailable),
        }
    }
    Ok(observed)
}

/* Bounded, symlink-refusing read for the standalone tool. */
pub fn read_bounded(path: &Path) -> Result<Vec<u8>, &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| CORE_READ_FAILED)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CORE_READ_FAILED);
    }
    if metadata.len() as usize > MAX_AUTHORITY_BYTES {
        return Err(CORE_READ_FAILED);
    }
    let mut file = fs::File::open(path).map_err(|_| CORE_READ_FAILED)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes).map_err(|_| CORE_READ_FAILED)?;
    Ok(bytes)
}

/* create_new: an existing temp is an unexplained state, never an overwrite. */
pub fn write_exact_new(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| match error.kind() {
            ErrorKind::AlreadyExists => CORE_TEMP_EXISTS,
            _ => CORE_WRITE_FAILED,
        })?;
    if file.write_all(bytes).is_err() || file.sync_all().is_err() {
        let _ = fs::remove_file(path);
        return Err(CORE_WRITE_FAILED);
    }
    Ok(())
}
