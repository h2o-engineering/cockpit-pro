use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::sync::OnceLock;

const IDENTITY_SCHEMA: &str = "h2o.studio.desktop-build-identity.v1";
const PACKAGED_IDENTITY_SCHEMA: &str = "h2o.studio.release-evidence.packaged-build-identity.v1";
const UNSTAMPED_CHECKPOINT: &str = "UNSTAMPED";
const HASH_UNAVAILABLE: &str = "runtime-executable-hash-unavailable";

static EXECUTABLE_SHA256: OnceLock<Result<String, String>> = OnceLock::new();

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBuildIdentity {
    schema: &'static str,
    checkpoint: &'static str,
    source_commit: &'static str,
    built_at: &'static str,
    app_version: &'static str,
    architecture: &'static str,
    governed: bool,
    executable_sha256: Option<String>,
    executable_sha256_error: Option<String>,
}

// Separate from DesktopBuildIdentity and its registered Tauri command: this
// strict readback is only used by the dedicated packaged-executable CLI mode.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagedBuildIdentity {
    schema: &'static str,
    component_id: &'static str,
    component_version: &'static str,
    source_commit: &'static str,
    checkpoint: &'static str,
    built_at_utc: &'static str,
    target_os: &'static str,
    architecture: &'static str,
    profile: &'static str,
    governed: bool,
    source_dirty: bool,
    executable_sha256: String,
}

fn stamped_bool(value: &str, name: &str) -> Result<bool, String> {
    match value {
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err(format!("invalid {name} stamp")),
    }
}

pub fn packaged_release_evidence_identity() -> Result<PackagedBuildIdentity, String> {
    let source_commit = env!("H2O_STUDIO_BUILD_SOURCE_COMMIT");
    let checkpoint = env!("H2O_STUDIO_BUILD_CHECKPOINT");
    let built_at_utc = env!("H2O_STUDIO_BUILD_TIMESTAMP");
    let component_version = env!("CARGO_PKG_VERSION");
    let profile = env!("H2O_BUILD_PROFILE");
    let governed = stamped_bool(env!("H2O_STUDIO_BUILD_GOVERNED"), "governed")?;
    let source_dirty = stamped_bool(env!("H2O_BUILD_DIRTY"), "dirty")?;

    if source_commit.len() != 40
        || !source_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        || source_commit != env!("H2O_BUILD_GIT_SHA")
    {
        return Err("missing or inconsistent source commit stamp".into());
    }
    if checkpoint.is_empty() || checkpoint == UNSTAMPED_CHECKPOINT {
        return Err("missing governed checkpoint stamp".into());
    }
    if built_at_utc.is_empty() || !built_at_utc.contains('T') || !built_at_utc.ends_with('Z') {
        return Err("missing UTC build timestamp stamp".into());
    }
    if component_version.is_empty() || profile.is_empty() || profile == "unknown" {
        return Err("missing version or profile stamp".into());
    }
    let executable_sha256 = executable_hash_result()?;

    Ok(PackagedBuildIdentity {
        schema: PACKAGED_IDENTITY_SCHEMA,
        component_id: "studio-desktop",
        component_version,
        source_commit,
        checkpoint,
        built_at_utc,
        target_os: std::env::consts::OS,
        architecture: runtime_architecture(),
        profile,
        governed,
        source_dirty,
        executable_sha256,
    })
}

fn runtime_architecture() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        other => other,
    }
}

fn hash_running_executable() -> Result<String, String> {
    let executable = std::env::current_exe().map_err(|_| HASH_UNAVAILABLE.to_string())?;
    let mut file = File::open(executable).map_err(|_| HASH_UNAVAILABLE.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| HASH_UNAVAILABLE.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn executable_hash_result() -> Result<String, String> {
    EXECUTABLE_SHA256
        .get_or_init(hash_running_executable)
        .clone()
}

#[tauri::command]
pub fn h2o_studio_desktop_build_identity() -> DesktopBuildIdentity {
    let checkpoint = env!("H2O_STUDIO_BUILD_CHECKPOINT");
    let governed =
        env!("H2O_STUDIO_BUILD_GOVERNED") == "true" && checkpoint != UNSTAMPED_CHECKPOINT;
    let (executable_sha256, executable_sha256_error) = match executable_hash_result() {
        Ok(hash) => (Some(hash), None),
        Err(code) => (None, Some(code)),
    };

    DesktopBuildIdentity {
        schema: IDENTITY_SCHEMA,
        checkpoint,
        source_commit: env!("H2O_STUDIO_BUILD_SOURCE_COMMIT"),
        built_at: env!("H2O_STUDIO_BUILD_TIMESTAMP"),
        app_version: env!("CARGO_PKG_VERSION"),
        architecture: runtime_architecture(),
        governed,
        executable_sha256,
        executable_sha256_error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_identity_has_one_complete_binary_backed_authority() {
        let identity = h2o_studio_desktop_build_identity();
        assert_eq!(identity.schema, IDENTITY_SCHEMA);
        assert!(!identity.checkpoint.is_empty());
        assert_eq!(identity.source_commit.len(), 40);
        assert!(!identity.built_at.is_empty());
        assert!(!identity.app_version.is_empty());
        assert!(!identity.architecture.is_empty());
        assert!(identity.executable_sha256.is_some());
        assert!(identity.executable_sha256_error.is_none());
    }
}
