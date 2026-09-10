use std::env;
use std::path::Path;
use std::process::Command;

fn git_output(repo: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_success(repo: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn valid_checkpoint(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        })
        && value.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
}

fn governed_build_identity(profile: &str, git_sha: &str) -> (String, String, bool) {
    let governed = env::var("H2O_STUDIO_BUILD_GOVERNED").as_deref() == Ok("true");
    let checkpoint = env::var("H2O_STUDIO_BUILD_CHECKPOINT").unwrap_or_default();
    let supplied_source_commit = env::var("H2O_STUDIO_BUILD_SOURCE_COMMIT").unwrap_or_default();
    let built_at = env::var("H2O_STUDIO_BUILD_TIMESTAMP").unwrap_or_default();

    if profile == "release" && !governed {
        panic!("governed Desktop release build requires H2O_STUDIO_BUILD_CHECKPOINT via tauri-build.mjs");
    }
    if !governed {
        return ("UNSTAMPED".to_string(), "development".to_string(), false);
    }
    if !valid_checkpoint(&checkpoint) {
        panic!("invalid or missing H2O_STUDIO_BUILD_CHECKPOINT");
    }
    if supplied_source_commit != git_sha {
        panic!("governed Desktop build source commit does not equal exact Git HEAD");
    }
    if built_at.is_empty() || !built_at.contains('T') || !built_at.ends_with('Z') {
        panic!("governed Desktop build requires an ISO-8601 H2O_STUDIO_BUILD_TIMESTAMP");
    }
    (checkpoint, built_at, true)
}

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let repo = Path::new(&manifest_dir);
    let git_sha = git_output(repo, &["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let git_dirty = git_output(repo, &["status", "--porcelain", "--untracked-files=all"])
        .map(|status| !status.is_empty())
        .unwrap_or(true);
    let profile = env::var("PROFILE").unwrap_or_else(|_| "unknown".into());
    let (checkpoint, built_at, governed) = governed_build_identity(&profile, &git_sha);
    let parent_propfind_fix_present = git_success(
        repo,
        &[
            "merge-base",
            "--is-ancestor",
            "305ff023ad12f14b6a9b505dab4123cf44c7cfba",
            "HEAD",
        ],
    );
    let r5a_binding_fix_present = git_success(
        repo,
        &[
            "merge-base",
            "--is-ancestor",
            "a0695eac1b3f11d7617a4a080c54d0b82663d478",
            "HEAD",
        ],
    );

    println!("cargo:rustc-env=H2O_BUILD_GIT_SHA={git_sha}");
    println!("cargo:rustc-env=H2O_BUILD_PROFILE={profile}");
    println!("cargo:rustc-env=H2O_BUILD_DIRTY={git_dirty}");
    println!("cargo:rustc-env=H2O_PARENT_PROPFIND_FIX_PRESENT={parent_propfind_fix_present}");
    println!("cargo:rustc-env=H2O_R5A_BINDING_FIX_PRESENT={r5a_binding_fix_present}");
    println!("cargo:rustc-env=H2O_STUDIO_BUILD_CHECKPOINT={checkpoint}");
    println!("cargo:rustc-env=H2O_STUDIO_BUILD_SOURCE_COMMIT={git_sha}");
    println!("cargo:rustc-env=H2O_STUDIO_BUILD_TIMESTAMP={built_at}");
    println!("cargo:rustc-env=H2O_STUDIO_BUILD_GOVERNED={governed}");
    println!("cargo:rerun-if-env-changed=H2O_STUDIO_BUILD_CHECKPOINT");
    println!("cargo:rerun-if-env-changed=H2O_STUDIO_BUILD_SOURCE_COMMIT");
    println!("cargo:rerun-if-env-changed=H2O_STUDIO_BUILD_TIMESTAMP");
    println!("cargo:rerun-if-env-changed=H2O_STUDIO_BUILD_GOVERNED");

    tauri_build::build()
}
