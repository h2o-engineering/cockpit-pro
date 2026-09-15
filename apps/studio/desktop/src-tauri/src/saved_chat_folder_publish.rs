//! M09 P0.1 — create-only staging and final publication for saved-chat folders.
//!
//! For staging, the renderer supplies a governed final leaf and bounded random
//! token; native code derives the staging leaf and creates it exclusively. For
//! publication, the renderer may name only that governed staged/final LEAF
//! pair. Both operations resolve the immutable governed export root themselves and
//! reuse the archive durable writer's descriptor-relative primitives. This is
//! not a general filesystem, mkdir or rename API.
//!
//! T02 (frozen contract §6 class G, §11.1 class D4): the publication is ONE
//! create-only directory rename — `renameatx_np(RENAME_EXCL)` on macOS,
//! `renameat2(RENAME_NOREPLACE)` on Linux, a handle-bound `ReplaceIfExists =
//! FALSE` rename of the retained staging directory handle on Windows — and the
//! staged directory object is re-identified under the final name afterwards
//! (class H′). The export folder stays the verified-on-consume class: no
//! member fence and no namespace fence are issued here (OQ-2, MB-07), and
//! `published` means exactly the namespace commit.

use serde::Serialize;
use std::io;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

const FINAL_SUFFIX: &str = ".h2ochat";
const TEMP_SUFFIX_PREFIX: &str = ".tmp-";
const STAGE_TOKEN_HEX_LENGTH: usize = 32;
const STAGE_RESULT_SCHEMA: &str = "h2o.savedChatFolderStage.v1";
const RESULT_SCHEMA: &str = "h2o.savedChatFolderPublish.v1";

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatFolderStageRequest {
    final_name: String,
    token: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatFolderStageResult {
    schema: &'static str,
    ok: bool,
    status: &'static str,
    owned: bool,
    staged_name: Option<String>,
}

impl SavedChatFolderStageResult {
    fn created(staged_name: String) -> Self {
        Self {
            schema: STAGE_RESULT_SCHEMA,
            ok: true,
            status: "created",
            owned: true,
            staged_name: Some(staged_name),
        }
    }

    fn refused(status: &'static str) -> Self {
        Self {
            schema: STAGE_RESULT_SCHEMA,
            ok: false,
            status,
            owned: false,
            staged_name: None,
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatFolderPublishRequest {
    staged_name: String,
    final_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedChatFolderPublishResult {
    schema: &'static str,
    ok: bool,
    status: &'static str,
    staging_removed: bool,
}

impl SavedChatFolderPublishResult {
    fn published() -> Self {
        Self {
            schema: RESULT_SCHEMA,
            ok: true,
            status: "published",
            staging_removed: true,
        }
    }

    fn refused(status: &'static str) -> Self {
        Self {
            schema: RESULT_SCHEMA,
            ok: false,
            status,
            staging_removed: false,
        }
    }
}

/// Governed ASCII leaf admission (contract §12): trimmed, no separators, no
/// drive prefix, no `..`, ASCII `[A-Za-z0-9._ -]`, no leading `.` (a
/// dot-leading stage is unreachable to the renderer's own member writes on
/// Unix and behaves differently on Windows), and no Windows reserved device
/// stem (whole stem or the segment before the first `.`) on ANY platform.
/// Nothing is normalized, case-folded or trimmed to fit.
fn is_safe_ascii_leaf(name: &str) -> bool {
    if name.is_empty()
        || name != name.trim()
        || name.starts_with('.')
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || Path::new(name).is_absolute()
    {
        return false;
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    if crate::archive_durable_write::has_reserved_device_stem(name) {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b'-' | b' '))
}

/// Explicit NAME_MAX admission on the admitted export root (contract §12).
fn name_fits(
    dir: &crate::archive_durable_write::confined::Dir,
    name: &str,
) -> Result<(), &'static str> {
    match dir.name_max() {
        Ok(limit) if name.len() as u64 <= limit => Ok(()),
        Ok(_) => Err("name-exceeds-filesystem-limit"),
        Err(_) => Err("name-limit-indeterminate"),
    }
}

fn final_name_is_governed(final_name: &str) -> bool {
    if !is_safe_ascii_leaf(final_name) {
        return false;
    }
    let Some(final_stem) = final_name.strip_suffix(FINAL_SUFFIX) else {
        return false;
    };
    !final_stem.is_empty()
}

fn token_is_governed(token: &str) -> bool {
    token.len() == STAGE_TOKEN_HEX_LENGTH
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn staging_name(final_name: &str, token: &str) -> Option<String> {
    if !final_name_is_governed(final_name) || !token_is_governed(token) {
        return None;
    }
    Some(format!("{final_name}{TEMP_SUFFIX_PREFIX}{token}"))
}

fn names_are_governed(staged_name: &str, final_name: &str) -> bool {
    if !is_safe_ascii_leaf(staged_name) {
        return false;
    }
    let prefix = format!("{final_name}{TEMP_SUFFIX_PREFIX}");
    let Some(token) = staged_name.strip_prefix(&prefix) else {
        return false;
    };
    staging_name(final_name, token).as_deref() == Some(staged_name)
}

fn staged_is_directory(stat: &crate::archive_durable_write::confined::EntryStat) -> bool {
    stat.is_directory()
}

fn create_stage_within_root_with<F>(
    root: &Path,
    final_name: &str,
    token: &str,
    create: F,
) -> SavedChatFolderStageResult
where
    F: FnOnce(&crate::archive_durable_write::confined::Dir, &[u8]) -> io::Result<()>,
{
    let Some(staged_name) = staging_name(final_name, token) else {
        return SavedChatFolderStageResult::refused("invalid-name");
    };
    let dir = match crate::archive_durable_write::confined::Dir::open_existing_nofollow(root) {
        Ok(dir) => dir,
        Err(err) if err.kind() == io::ErrorKind::Unsupported => {
            return SavedChatFolderStageResult::refused("unsupported-platform")
        }
        Err(_) => return SavedChatFolderStageResult::refused("create-failed"),
    };
    if let Err(status) = name_fits(&dir, &staged_name) {
        return SavedChatFolderStageResult::refused(status);
    }
    // Class O: exclusive creation must be proven on this root before staging.
    // A root this process cannot write is a permission condition, reported
    // with the accepted infrastructure code, never as a capability verdict.
    if let Err(refusal) = crate::archive_filesystem_capability::require(
        &dir,
        &[crate::archive_filesystem_capability::Capability::Exclusive],
    ) {
        return SavedChatFolderStageResult::refused(if refusal.is_root_not_writable() {
            "create-failed"
        } else {
            "capability-unproven"
        });
    }
    match create(&dir, staged_name.as_bytes()) {
        Ok(()) => SavedChatFolderStageResult::created(staged_name),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            SavedChatFolderStageResult::refused("stage-exists")
        }
        Err(err) if err.kind() == io::ErrorKind::Unsupported => {
            SavedChatFolderStageResult::refused("unsupported-platform")
        }
        Err(_) => SavedChatFolderStageResult::refused("create-failed"),
    }
}

pub fn create_saved_chat_folder_stage_within_root(
    root: &Path,
    final_name: &str,
    token: &str,
) -> SavedChatFolderStageResult {
    create_stage_within_root_with(root, final_name, token, |dir, staged_name| {
        dir.mkdir_child_exclusive(staged_name)
    })
}

fn publish_within_root_with<F>(
    root: &Path,
    staged_name: &str,
    final_name: &str,
    promote: F,
) -> SavedChatFolderPublishResult
where
    F: FnOnce(
        &crate::archive_durable_write::confined::Dir,
        &crate::archive_durable_write::confined::Dir,
        &[u8],
        &[u8],
    ) -> io::Result<bool>,
{
    if !names_are_governed(staged_name, final_name) {
        return SavedChatFolderPublishResult::refused("invalid-name");
    }
    let dir = match crate::archive_durable_write::confined::Dir::open_existing_nofollow(root) {
        Ok(dir) => dir,
        Err(err) if err.kind() == io::ErrorKind::Unsupported => {
            return SavedChatFolderPublishResult::refused("unsupported-platform")
        }
        Err(_) => return SavedChatFolderPublishResult::refused("publish-failed"),
    };
    if let Err(status) = name_fits(&dir, final_name) {
        return SavedChatFolderPublishResult::refused(status);
    }
    let staged = match dir.stat_child_nofollow(staged_name.as_bytes()) {
        Ok(Some(stat)) => stat,
        Ok(None) => return SavedChatFolderPublishResult::refused("staged-missing"),
        Err(_) => return SavedChatFolderPublishResult::refused("publish-failed"),
    };
    if !staged_is_directory(&staged) {
        return SavedChatFolderPublishResult::refused("staged-not-directory");
    }
    // Class O: the no-replace directory rename must be proven on this root.
    // A root this process cannot write is a permission condition, reported
    // with the accepted infrastructure code, never as a capability verdict.
    if let Err(refusal) = crate::archive_filesystem_capability::require(
        &dir,
        &[crate::archive_filesystem_capability::Capability::NoReplaceRename],
    ) {
        return SavedChatFolderPublishResult::refused(if refusal.is_root_not_writable() {
            "publish-failed"
        } else {
            "capability-unproven"
        });
    }
    // Retain the staged directory object across the rename: it is the rename
    // source on Windows and the class H′ witness everywhere.
    let staged_dir = match dir.open_child_nofollow(staged_name.as_bytes()) {
        Ok(staged_dir) => staged_dir,
        Err(_) => return SavedChatFolderPublishResult::refused("staged-not-directory"),
    };
    let owned = match staged_dir.identity() {
        Ok(identity) => identity,
        Err(_) => return SavedChatFolderPublishResult::refused("publish-failed"),
    };
    match promote(
        &dir,
        &staged_dir,
        staged_name.as_bytes(),
        final_name.as_bytes(),
    ) {
        Ok(false) => SavedChatFolderPublishResult::refused("destination-exists"),
        Ok(true) => {
            drop(staged_dir);
            // Class H′: the directory object now under the final name must be
            // the staged object that was admitted above; a foreign object is
            // left for the portable verifier and never reported `published`.
            match dir.stat_child_nofollow(final_name.as_bytes()) {
                Ok(Some(st)) if st.is_directory() && st.identity() == owned => {
                    SavedChatFolderPublishResult::published()
                }
                _ => SavedChatFolderPublishResult::refused("publication-identity-mismatch"),
            }
        }
        Err(err) if err.kind() == io::ErrorKind::Unsupported => {
            SavedChatFolderPublishResult::refused("unsupported-platform")
        }
        Err(err) if crate::archive_durable_write::confined::is_capability_absent(&err) => {
            SavedChatFolderPublishResult::refused("capability-unproven")
        }
        Err(_) => SavedChatFolderPublishResult::refused("publish-failed"),
    }
}

pub fn publish_saved_chat_folder_within_root(
    root: &Path,
    staged_name: &str,
    final_name: &str,
) -> SavedChatFolderPublishResult {
    publish_within_root_with(
        root,
        staged_name,
        final_name,
        |dir, staged_dir, from, to| dir.promote_dir_exclusive(staged_dir, from, to),
    )
}

#[tauri::command]
pub fn h2o_create_saved_chat_folder_stage(
    app: tauri::AppHandle,
    request: SavedChatFolderStageRequest,
) -> SavedChatFolderStageResult {
    let roots = match crate::saved_chat_export_root_policy::production_roots(&app) {
        Ok(roots) => roots,
        Err(status) => return SavedChatFolderStageResult::refused(status),
    };
    create_saved_chat_folder_stage_within_root(
        &roots.final_root,
        &request.final_name,
        &request.token,
    )
}

#[tauri::command]
pub fn h2o_publish_saved_chat_folder_create_only(
    app: tauri::AppHandle,
    request: SavedChatFolderPublishRequest,
) -> SavedChatFolderPublishResult {
    let roots = match crate::saved_chat_export_root_policy::production_roots(&app) {
        Ok(roots) => roots,
        Err(status) => return SavedChatFolderPublishResult::refused(status),
    };
    publish_saved_chat_folder_within_root(
        &roots.final_root,
        &request.staged_name,
        &request.final_name,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    const TOKEN_A: &str = "00112233445566778899aabbccddeeff";
    const TOKEN_B: &str = "ffeeddccbbaa99887766554433221100";

    fn scratch_root(name: &str) -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "h2o-saved-chat-folder-publish-{name}-{}-{counter}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("scratch root");
        root
    }

    fn names() -> (&'static str, &'static str) {
        (
            "round-trip.h2ochat.tmp-00112233445566778899aabbccddeeff",
            "round-trip.h2ochat",
        )
    }

    /// T02 (contract §12): export leaves refuse a leading `.` and every
    /// Windows reserved device stem on every platform, and never widen the
    /// admitted charset.
    #[test]
    fn export_leaves_refuse_leading_dots_and_reserved_device_stems() {
        for refused in [
            ".hidden.h2ochat",
            "CON.h2ochat",
            "nul.h2ochat",
            "COM1.h2ochat",
            "lpt9.h2ochat",
            "AUX.notes.h2ochat",
            "PRN.h2ochat",
        ] {
            assert!(
                !final_name_is_governed(refused),
                "{refused} must be refused"
            );
            assert_eq!(
                create_saved_chat_folder_stage_within_root(
                    &scratch_root("name-policy"),
                    refused,
                    TOKEN_A
                )
                .status,
                "invalid-name"
            );
        }
        for admitted in [
            "console.h2ochat",
            "com10.h2ochat",
            "chat.CON.h2ochat",
            "a b.h2ochat",
        ] {
            assert!(
                final_name_is_governed(admitted),
                "{admitted} must be admitted"
            );
        }
    }

    /// T02 (class H′): when the object under the final name after the rename
    /// is NOT the staged directory object, publication reports a distinct
    /// non-success and leaves the foreign occupant untouched.
    #[test]
    fn a_foreign_object_under_the_final_name_is_reported_as_identity_mismatch_and_left_untouched() {
        let root = scratch_root("identity-mismatch");
        let (staged, final_name) = names();
        fs::create_dir(root.join(staged)).unwrap();
        fs::write(root.join(staged).join("payload"), b"our-staged-bytes").unwrap();
        let foreign = root.join(final_name);
        let result =
            publish_within_root_with(&root, staged, final_name, |_dir, _staged_dir, _from, to| {
                // A rename that (illegitimately) leaves a DIFFERENT directory
                // under the final name: create-only insertion of a foreign tree.
                let path = root.join(std::str::from_utf8(to).unwrap());
                fs::create_dir(&path)?;
                fs::write(path.join("foreign"), b"foreign-bytes")?;
                Ok(true)
            });
        assert_eq!(result.status, "publication-identity-mismatch");
        assert!(!result.ok);
        assert!(!result.staging_removed);
        assert_eq!(fs::read(foreign.join("foreign")).unwrap(), b"foreign-bytes");
        assert_eq!(
            fs::read(root.join(staged).join("payload")).unwrap(),
            b"our-staged-bytes"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn absent_stage_is_created_exclusively_as_an_empty_real_directory() {
        let root = scratch_root("stage-absent");

        let result =
            create_saved_chat_folder_stage_within_root(&root, "round-trip.h2ochat", TOKEN_A);

        assert_eq!(result.status, "created");
        assert!(result.ok);
        assert!(result.owned);
        let staged_name = result.staged_name.expect("owned stage name");
        let metadata = fs::symlink_metadata(root.join(&staged_name)).unwrap();
        assert!(metadata.is_dir());
        assert!(!metadata.file_type().is_symlink());
        assert!(fs::read_dir(root.join(staged_name))
            .unwrap()
            .next()
            .is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_stage_directory_is_not_adopted_or_changed() {
        let root = scratch_root("stage-directory-collision");
        let staged_name = staging_name("round-trip.h2ochat", TOKEN_A).unwrap();
        fs::create_dir(root.join(&staged_name)).unwrap();
        fs::write(
            root.join(&staged_name).join("foreign.txt"),
            b"foreign-owner-bytes",
        )
        .unwrap();

        let result =
            create_saved_chat_folder_stage_within_root(&root, "round-trip.h2ochat", TOKEN_A);

        assert_eq!(result.status, "stage-exists");
        assert!(!result.ok);
        assert!(!result.owned);
        assert_eq!(result.staged_name, None);
        assert_eq!(
            fs::read(root.join(staged_name).join("foreign.txt")).unwrap(),
            b"foreign-owner-bytes"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_stage_file_and_symlink_are_not_followed_replaced_or_removed() {
        use std::os::unix::fs::symlink;

        let root = scratch_root("stage-type-collision");
        let staged_name = staging_name("round-trip.h2ochat", TOKEN_A).unwrap();
        fs::write(root.join(&staged_name), b"foreign-file-bytes").unwrap();
        let file_result =
            create_saved_chat_folder_stage_within_root(&root, "round-trip.h2ochat", TOKEN_A);
        assert_eq!(file_result.status, "stage-exists");
        assert!(!file_result.owned);
        assert_eq!(
            fs::read(root.join(&staged_name)).unwrap(),
            b"foreign-file-bytes"
        );

        fs::remove_file(root.join(&staged_name)).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("outside/foreign.txt"), b"symlink-target-bytes").unwrap();
        symlink(root.join("outside"), root.join(&staged_name)).unwrap();
        let symlink_result =
            create_saved_chat_folder_stage_within_root(&root, "round-trip.h2ochat", TOKEN_A);
        assert_eq!(symlink_result.status, "stage-exists");
        assert!(!symlink_result.owned);
        assert!(fs::symlink_metadata(root.join(&staged_name))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read(root.join("outside/foreign.txt")).unwrap(),
            b"symlink-target-bytes"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn two_creators_can_never_both_own_the_same_stage() {
        let root = scratch_root("stage-two-creators");

        let first =
            create_saved_chat_folder_stage_within_root(&root, "round-trip.h2ochat", TOKEN_A);
        let second =
            create_saved_chat_folder_stage_within_root(&root, "round-trip.h2ochat", TOKEN_A);

        assert!(first.ok && first.owned);
        assert_eq!(second.status, "stage-exists");
        assert!(!second.ok && !second.owned);
        assert_eq!(second.staged_name, None);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stage_creation_rejects_unsafe_final_names_and_invalid_tokens() {
        let root = scratch_root("stage-confinement");
        for (final_name, token) in [
            ("../x.h2ochat", TOKEN_A),
            ("a/b.h2ochat", TOKEN_A),
            ("a\\b.h2ochat", TOKEN_A),
            ("/absolute.h2ochat", TOKEN_A),
            ("C:\\drive.h2ochat", TOKEN_A),
            ("round-trip.zip", TOKEN_A),
            ("round-trip.h2ochat", ""),
            ("round-trip.h2ochat", "a"),
            ("round-trip.h2ochat", "00112233445566778899aabbccddeeff00"),
            ("round-trip.h2ochat", "00112233445566778899AABBCCDDEEFF"),
            ("round-trip.h2ochat", "00112233445566778899aabbccddeefg"),
        ] {
            let result = create_saved_chat_folder_stage_within_root(&root, final_name, token);
            assert_eq!(
                result.status, "invalid-name",
                "unexpected admission: {final_name} / {token}"
            );
            assert!(!result.owned);
        }
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn non_collision_stage_creation_error_fails_closed_without_fallback() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch_root("stage-fail-closed");
        fs::write(root.join("foreign-marker"), b"foreign-marker-bytes").unwrap();
        let original_mode = fs::metadata(&root).unwrap().permissions().mode();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();

        let result =
            create_saved_chat_folder_stage_within_root(&root, "round-trip.h2ochat", TOKEN_B);

        fs::set_permissions(&root, fs::Permissions::from_mode(original_mode)).unwrap();
        assert_eq!(result.status, "create-failed");
        assert!(!result.ok && !result.owned);
        assert_eq!(result.staged_name, None);
        assert!(!root
            .join(staging_name("round-trip.h2ochat", TOKEN_B).unwrap())
            .exists());
        assert_eq!(
            fs::read(root.join("foreign-marker")).unwrap(),
            b"foreign-marker-bytes"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn absent_destination_publishes_complete_folder_and_removes_staging_name() {
        let root = scratch_root("absent");
        let (staged, final_name) = names();
        fs::create_dir(root.join(staged)).unwrap();
        fs::write(root.join(staged).join("manifest.json"), b"manifest-bytes").unwrap();
        fs::create_dir(root.join(staged).join("assets")).unwrap();
        fs::write(root.join(staged).join("assets/member"), b"asset-bytes").unwrap();

        let result = publish_saved_chat_folder_within_root(&root, staged, final_name);

        assert_eq!(result.status, "published");
        assert!(result.ok);
        assert!(result.staging_removed);
        assert_eq!(
            fs::read(root.join(final_name).join("manifest.json")).unwrap(),
            b"manifest-bytes"
        );
        assert_eq!(
            fs::read(root.join(final_name).join("assets/member")).unwrap(),
            b"asset-bytes"
        );
        assert!(!root.join(staged).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_destination_is_never_replaced_and_winner_bytes_survive() {
        let root = scratch_root("occupied");
        let (staged, final_name) = names();
        fs::create_dir(root.join(staged)).unwrap();
        fs::write(root.join(staged).join("payload"), b"our-staged-bytes").unwrap();
        fs::create_dir(root.join(final_name)).unwrap();
        fs::write(root.join(final_name).join("payload"), b"winner-bytes").unwrap();

        let result = publish_saved_chat_folder_within_root(&root, staged, final_name);

        assert_eq!(result.status, "destination-exists");
        assert!(!result.ok);
        assert_eq!(
            fs::read(root.join(final_name).join("payload")).unwrap(),
            b"winner-bytes"
        );
        assert_eq!(
            fs::read(root.join(staged).join("payload")).unwrap(),
            b"our-staged-bytes"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn race_point_winner_after_advisory_absence_survives_unchanged() {
        let root = scratch_root("race-winner");
        let (staged, final_name) = names();
        fs::create_dir(root.join(staged)).unwrap();
        fs::write(root.join(staged).join("payload"), b"our-staged-bytes").unwrap();
        assert!(
            !root.join(final_name).exists(),
            "advisory check sees absent"
        );
        fs::create_dir(root.join(final_name)).unwrap();
        fs::write(root.join(final_name).join("payload"), b"race-winner-bytes").unwrap();

        let result = publish_saved_chat_folder_within_root(&root, staged, final_name);

        assert_eq!(result.status, "destination-exists");
        assert_eq!(
            fs::read(root.join(final_name).join("payload")).unwrap(),
            b"race-winner-bytes"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn path_confinement_rejects_unsafe_or_unrelated_names() {
        let root = scratch_root("confinement");
        for (staged, final_name) in [
            ("../x", "round-trip.h2ochat"),
            ("a/b", "round-trip.h2ochat"),
            ("a\\b", "round-trip.h2ochat"),
            ("round-trip.h2ochat.tmp-abc", "/absolute.h2ochat"),
            ("round-trip.h2ochat.tmp-abc", "C:\\drive.h2ochat"),
            ("round-trip.h2ochat.tmp-abc", "round-trip.zip"),
            (
                "other.h2ochat.tmp-00112233445566778899aabbccddeeff",
                "round-trip.h2ochat",
            ),
            ("round-trip.h2ochat.tmp-", "round-trip.h2ochat"),
            ("round-trip.h2ochat.tmp-ABC", "round-trip.h2ochat"),
        ] {
            assert_eq!(
                publish_saved_chat_folder_within_root(&root, staged, final_name).status,
                "invalid-name",
                "unexpected admission: {staged} -> {final_name}"
            );
        }
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn staged_symlink_and_non_directory_are_rejected() {
        use std::os::unix::fs::symlink;

        let root = scratch_root("staged-type");
        let (staged, final_name) = names();
        fs::write(root.join(staged), b"not-a-directory").unwrap();
        assert_eq!(
            publish_saved_chat_folder_within_root(&root, staged, final_name).status,
            "staged-not-directory"
        );
        fs::remove_file(root.join(staged)).unwrap();
        fs::create_dir(root.join("elsewhere")).unwrap();
        symlink(root.join("elsewhere"), root.join(staged)).unwrap();
        assert_eq!(
            publish_saved_chat_folder_within_root(&root, staged, final_name).status,
            "staged-not-directory"
        );
        assert!(!root.join(final_name).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn non_collision_publication_error_fails_closed_without_fallback() {
        use std::os::unix::fs::PermissionsExt;

        let root = scratch_root("fail-closed");
        let (staged, final_name) = names();
        fs::create_dir(root.join(staged)).unwrap();
        fs::write(root.join(staged).join("payload"), b"our-staged-bytes").unwrap();
        let original_mode = fs::metadata(&root).unwrap().permissions().mode();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();

        let result = publish_saved_chat_folder_within_root(&root, staged, final_name);

        fs::set_permissions(&root, fs::Permissions::from_mode(original_mode)).unwrap();
        assert_eq!(result.status, "publish-failed");
        assert!(!result.ok);
        assert!(!root.join(final_name).exists());
        assert_eq!(
            fs::read(root.join(staged).join("payload")).unwrap(),
            b"our-staged-bytes"
        );
        let _ = fs::remove_dir_all(root);
    }
}
