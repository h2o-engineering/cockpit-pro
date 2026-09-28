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

fn utc_digits(bytes: &[u8]) -> Option<u32> {
    if !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(
        bytes
            .iter()
            .fold(0, |value, digit| value * 10 + u32::from(*digit - b'0')),
    )
}

fn valid_utc_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[bytes.len() - 1] != b'Z'
        || (bytes.len() > 20 && (bytes[19] != b'.' || bytes.len() < 22))
        || (bytes.len() == 20 && bytes[19] != b'Z')
        || (bytes.len() > 20 && utc_digits(&bytes[20..bytes.len() - 1]).is_none())
    {
        return false;
    }
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        utc_digits(&bytes[0..4]),
        utc_digits(&bytes[5..7]),
        utc_digits(&bytes[8..10]),
        utc_digits(&bytes[11..13]),
        utc_digits(&bytes[14..16]),
        utc_digits(&bytes[17..19]),
    ) else {
        return false;
    };
    if !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
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
    day >= 1 && day <= days[(month - 1) as usize]
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
    if !valid_utc_timestamp(built_at_utc) {
        return Err("invalid UTC build timestamp stamp".into());
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

    #[test]
    fn utc_stamp_requires_real_gregorian_calendar_time() {
        for value in [
            "2026-02-28T23:59:59Z",
            "2024-02-29T00:00:00Z",
            "2026-01-01T00:00:00.123Z",
        ] {
            assert!(valid_utc_timestamp(value), "{value}");
        }
        for value in [
            "2026-02-29T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:60:00Z",
            "2026-01-01T00:00:60Z",
            "2026-01-01 00:00:00Z",
            "2026-01-01T00:00:00.Z",
        ] {
            assert!(!valid_utc_timestamp(value), "{value}");
        }
    }
}
