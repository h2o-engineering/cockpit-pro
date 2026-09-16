//! Backup v1 T02 — load-bearing proof for the native local backup publisher
//! (`T02_TEST_CONTRACT`, contract §23).
//!
//! Evidence strengths, kept apart as the publisher's suite does:
//!   1. BEHAVIOURAL NEGATIVE CONTROL — the real code path is driven with input
//!      that must be refused (or accepted). Almost every test here.
//!   2. SOURCE TRIPWIRE — `include_str!` assertions that a load-bearing
//!      symbol or code is still present. Proves nothing about behaviour.
//!
//! Every test runs against a scratch root under `std::env::temp_dir()` and
//! the REAL v3 fixtures (identity + gzip) the rest of the Saved-Chat suite
//! trusts. No test touches the archive, the CAS or a database.

use super::*;
use crate::archive_durable_write::sha256_hex;
use crate::archive_generation_publish::generation_basename;
use crate::saved_chat_package_verify::tests::{permanent_v3_fixture, zero_asset_v3, OwnedPackage};
use std::path::{Path, PathBuf};

// ── Harness ────────────────────────────────────────────────────────────────

/// A fresh scratch BASE; the governed root beneath it is created only by
/// BEGIN (the tests that assert "nothing created" depend on this).
fn scratch_base(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "h2o-bkp-{tag}-{nanos}-{:?}",
        std::thread::current().id()
    ));
    std::fs::create_dir_all(&dir).expect("scratch base");
    dir
}

fn fresh_publisher(tag: &str) -> (BackupPublisher, PathBuf) {
    let base = scratch_base(tag);
    let root = crate::saved_chat_backup_root_policy::backup_root_from_base(&base);
    (BackupPublisher::new(root.clone()), root)
}

fn declaration(pairs: &[(&str, &str)]) -> EnumerationDeclaration {
    EnumerationDeclaration {
        at: "2026-09-16T17:05:02.001Z".to_string(),
        eligible: pairs
            .iter()
            .map(|(chat_id, snapshot_id)| EligiblePair {
                chat_id: chat_id.to_string(),
                snapshot_id: snapshot_id.to_string(),
            })
            .collect(),
        skipped: SkippedCounts::default(),
        enumerated_count: pairs.len() as u64,
        source: SourceDeclaration {
            app_build_stamp: Some("test-build".to_string()),
        },
    }
}

fn token_of(result: &BeginResult) -> u64 {
    result
        .token
        .as_deref()
        .expect("token")
        .parse::<u64>()
        .expect("decimal token")
}

fn begin_ok(publisher: &BackupPublisher, pairs: &[(&str, &str)]) -> (u64, BeginResult) {
    let result = begin(publisher, &declaration(pairs));
    assert!(result.ok, "begin refused: {}", result.status);
    assert_eq!(result.status, "created");
    (token_of(&result), result)
}

fn selector(kind: &str, name: Option<&str>) -> MemberSelector {
    MemberSelector {
        kind: kind.to_string(),
        name: name.map(str::to_string),
    }
}

/// Streams `bytes` as `chunk`-sized appends, closing on the last one with
/// the declared byte length.
fn stream(
    publisher: &BackupPublisher,
    token: u64,
    member: &MemberSelector,
    bytes: &[u8],
    chunk: usize,
) -> WriteResult {
    let chunks: Vec<&[u8]> = if bytes.is_empty() {
        vec![&[][..]]
    } else {
        bytes.chunks(chunk).collect()
    };
    let last = chunks.len() - 1;
    let mut out = None;
    for (index, part) in chunks.iter().enumerate() {
        let is_final = index == last;
        let result = write_member(
            publisher,
            token,
            member,
            is_final,
            if is_final {
                Some(bytes.len() as u64)
            } else {
                None
            },
            part,
        );
        if !result.ok {
            return result;
        }
        out = Some(result);
    }
    out.expect("at least one chunk")
}

fn asset_basename(package: &OwnedPackage, index: usize) -> String {
    package.assets[index]
        .path
        .strip_prefix("assets/")
        .expect("package-relative asset path")
        .to_string()
}

fn manifest_value(package: &OwnedPackage) -> serde_json::Value {
    serde_json::from_slice(&package.manifest).expect("manifest")
}

fn declared_content_hash(package: &OwnedPackage) -> String {
    manifest_value(package)["contentHash"]
        .as_str()
        .expect("contentHash")
        .to_string()
}

fn pair_of(package: &OwnedPackage) -> (String, String) {
    (
        package.chat_id.clone(),
        manifest_value(package)["snapshotId"]
            .as_str()
            .expect("snapshotId")
            .to_string(),
    )
}

/// Stages every member of `package` in the projection order the renderer
/// uses (assets during the build, then snapshot, then manifest).
fn stage_members(publisher: &BackupPublisher, token: u64, package: &OwnedPackage) {
    for (index, (_sha, body)) in package.asset_bodies.iter().enumerate() {
        let name = asset_basename(package, index);
        let result = stream(publisher, token, &selector("asset", Some(&name)), body, 7);
        assert!(result.ok, "asset write refused: {}", result.status);
    }
    let snapshot = package.snapshot.as_ref().expect("snapshot bytes");
    let result = stream(publisher, token, &selector("snapshot", None), snapshot, 100);
    assert!(result.ok, "snapshot write refused: {}", result.status);
    let result = stream(
        publisher,
        token,
        &selector("manifest", None),
        &package.manifest,
        64,
    );
    assert!(result.ok, "manifest write refused: {}", result.status);
}

fn publish_package(
    publisher: &BackupPublisher,
    token: u64,
    package: &OwnedPackage,
) -> PackageFinishResult {
    let (chat_id, snapshot_id) = pair_of(package);
    let opened = package_begin(publisher, token, &chat_id, &snapshot_id);
    assert!(opened.ok, "package_begin refused: {}", opened.status);
    stage_members(publisher, token, package);
    package_finish(publisher, token, &declared_content_hash(package))
}

fn expected_leaf(package: &OwnedPackage) -> String {
    let hex = crate::archive_durable_write::normalize_expected_sha(&declared_content_hash(package))
        .expect("fixture hash");
    generation_basename(&package.chat_id, &hex)
}

/// Content digest of a whole tree: sorted `(relative path, kind, sha256)`.
/// Symlinks are recorded by their target, never followed.
fn tree_digest(root: &Path) -> String {
    fn walk(root: &Path, dir: &Path, lines: &mut Vec<String>) {
        let mut entries: Vec<PathBuf> = match std::fs::read_dir(dir) {
            Ok(iter) => iter.map(|e| e.expect("entry").path()).collect(),
            Err(_) => return,
        };
        entries.sort();
        for path in entries {
            let rel = path
                .strip_prefix(root)
                .expect("under root")
                .to_string_lossy()
                .into_owned();
            let meta = std::fs::symlink_metadata(&path).expect("lstat");
            if meta.file_type().is_symlink() {
                let target = std::fs::read_link(&path).expect("readlink");
                lines.push(format!("{rel}\tsymlink\t{}", target.to_string_lossy()));
            } else if meta.is_dir() {
                lines.push(format!("{rel}\tdir"));
                walk(root, &path, lines);
            } else {
                let bytes = std::fs::read(&path).expect("read");
                lines.push(format!("{rel}\tfile\t{}", sha256_hex(&bytes)));
            }
        }
    }
    let mut lines = Vec::new();
    walk(root, root, &mut lines);
    sha256_hex(lines.join("\n").as_bytes())
}

fn entry_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(dir) {
        Ok(iter) => iter
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

fn failure(chat_id: &str, snapshot_id: &str, code: &str) -> FailureDeclaration {
    FailureDeclaration {
        chat_id: chat_id.to_string(),
        snapshot_id: snapshot_id.to_string(),
        code: code.to_string(),
        stage: "build".to_string(),
        detail: "fixture failure".to_string(),
    }
}

/// Resets the thread-local fence seam on drop, so a failing assertion never
/// leaks a forced failure into the next test on this thread.
struct FenceGuard;
impl FenceGuard {
    fn force(site: FenceSite) -> Self {
        FORCE_FENCE_FAILURE.with(|f| f.set(Some(site)));
        FenceGuard
    }
}
impl Drop for FenceGuard {
    fn drop(&mut self) {
        FORCE_FENCE_FAILURE.with(|f| f.set(None));
    }
}

fn read_manifest(root: &Path, leaf: &str) -> Vec<u8> {
    std::fs::read(root.join(leaf).join(BACKUP_MANIFEST_NAME)).expect("published manifest")
}

fn flipped(package: &OwnedPackage, member: &str) -> OwnedPackage {
    let mut out = OwnedPackage {
        manifest: package.manifest.clone(),
        snapshot: package.snapshot.clone(),
        markdown: package.markdown.clone(),
        html: package.html.clone(),
        assets: package.assets.clone(),
        asset_bodies: package.asset_bodies.clone(),
        unexpected: package.unexpected.clone(),
        chat_id: package.chat_id.clone(),
    };
    if member == "snapshot" {
        out.snapshot.as_mut().expect("snapshot")[10] ^= 0x01;
    } else {
        out.asset_bodies[0].1[3] ^= 0x01;
    }
    out
}

/// One complete two-package run (identity fixture + zero-asset fixture).
fn complete_run(tag: &str) -> (BackupPublisher, PathBuf, FinalizeResult) {
    let (publisher, root) = fresh_publisher(tag);
    let t06 = permanent_v3_fixture(false);
    let zero = zero_asset_v3();
    let (t06_chat, t06_snap) = pair_of(&t06);
    let (zero_chat, zero_snap) = pair_of(&zero);
    let (token, _) = begin_ok(
        &publisher,
        &[(&t06_chat, &t06_snap), (&zero_chat, &zero_snap)],
    );
    let first = publish_package(&publisher, token, &t06);
    assert!(
        first.ok,
        "t06 finish refused: {} {:?}",
        first.status, first.codes
    );
    let second = publish_package(&publisher, token, &zero);
    assert!(
        second.ok,
        "zero finish refused: {} {:?}",
        second.status, second.codes
    );
    let result = finalize(&publisher, token, &[]);
    (publisher, root, result)
}

// ── Grammars, timestamps, JSON ─────────────────────────────────────────────

#[test]
fn backup_id_and_final_leaf_grammars_are_exact() {
    assert!(is_backup_id("20260916T170512Z-3f9a1c2b7e8d4a05"));
    assert!(!is_backup_id("20260916T170512Z-3F9A1C2B7E8D4A05"));
    assert!(!is_backup_id("20260916T170512Z-3f9a1c2b7e8d4a0"));
    assert!(!is_backup_id("20260916T170512-3f9a1c2b7e8d4a05"));
    assert!(!is_backup_id("2026091T1705122Z-3f9a1c2b7e8d4a05"));
    assert_eq!(
        parse_final_leaf("20260916T170512Z-3f9a1c2b7e8d4a05.h2obackup"),
        Some(("20260916T170512Z-3f9a1c2b7e8d4a05".to_string(), false))
    );
    assert_eq!(
        parse_final_leaf("20260916T170512Z-3f9a1c2b7e8d4a05.partial.h2obackup"),
        Some(("20260916T170512Z-3f9a1c2b7e8d4a05".to_string(), true))
    );
    assert_eq!(
        parse_final_leaf(".h2o-backupstage-0123456789abcdef0123456789abcdef"),
        None
    );
    assert_eq!(parse_final_leaf("notes.txt"), None);
    assert_eq!(parse_final_leaf("x.h2obackup"), None);
    assert_eq!(
        final_leaf("20260916T170512Z-3f9a1c2b7e8d4a05", true),
        "20260916T170512Z-3f9a1c2b7e8d4a05.h2obackup"
    );
    assert_eq!(
        final_leaf("20260916T170512Z-3f9a1c2b7e8d4a05", false),
        "20260916T170512Z-3f9a1c2b7e8d4a05.partial.h2obackup"
    );
    for reserved in [
        ".h2o-backupstage-x",
        ".h2o-bkpkg-x",
        ".h2o-bkmanifest-x.tmp",
    ] {
        assert!(is_backup_reserved_name(reserved));
    }
    assert!(!is_backup_reserved_name(".h2o-genstage-x"));
    // The backup-owned prefixes stay OUT of the archive's shared reservation.
    for prefix in BACKUP_RESERVED_PREFIXES {
        assert!(!crate::archive_durable_write::RESERVED_COMPONENT_PREFIXES.contains(prefix));
    }
}

#[test]
fn asset_member_name_grammar_is_canonical() {
    let hex = "b6a38573d3cd8607b3cda428df2c4b2d05d976c58f55e47eeac8ffb0c34f780b";
    assert_eq!(
        parse_asset_member_name(&format!("sha256-{hex}.png")),
        Some(hex)
    );
    assert_eq!(
        parse_asset_member_name(&format!("sha256-{hex}.webp2")),
        Some(hex)
    );
    for bad in [
        format!("sha256-{hex}"),
        format!("sha256-{hex}."),
        format!("sha256-{hex}.PNG"),
        format!("sha256-{}.png", hex.to_ascii_uppercase()),
        format!("sha256-{}.png", &hex[..63]),
        format!("{hex}.png"),
        format!("sha256-{hex}.png/x"),
        format!("sha256-{hex}.{}", "a".repeat(17)),
        "../x.png".to_string(),
    ] {
        assert_eq!(parse_asset_member_name(&bad), None, "{bad}");
    }
    assert_eq!(
        resolve_member(&selector("snapshot", None))
            .unwrap()
            .relative,
        "snapshot.json"
    );
    assert_eq!(
        resolve_member(&selector("manifest", None))
            .unwrap()
            .relative,
        "manifest.json"
    );
    assert_eq!(
        resolve_member(&selector("snapshot", Some("evil.json"))),
        Err("backup-invalid-member-name")
    );
    assert_eq!(
        resolve_member(&selector("asset", None)),
        Err("backup-invalid-member-name")
    );
    assert_eq!(
        resolve_member(&selector("html", None)),
        Err("backup-invalid-member-name")
    );
    let asset = resolve_member(&selector("asset", Some(&format!("sha256-{hex}.png")))).unwrap();
    assert_eq!(asset.relative, format!("assets/sha256-{hex}.png"));
    assert_eq!(asset.bound_hex.as_deref(), Some(hex));
}

#[test]
fn windows_reserved_stems_are_refused_case_insensitively() {
    for name in [
        "CON",
        "con",
        "Prn",
        "AUX.g",
        "nul.x.y",
        "COM1",
        "lpt9.h2ochat",
        "com0",
    ] {
        assert!(has_windows_reserved_stem(name), "{name}");
    }
    for name in [
        "console",
        "COM10",
        "lpt",
        "t06-canonical-assets",
        "zero",
        "CONx",
    ] {
        assert!(!has_windows_reserved_stem(name), "{name}");
    }
}

#[test]
fn timestamps_are_utc_millisecond_iso_and_basic_forms() {
    assert_eq!(utc_basic_timestamp(0), "19700101T000000Z");
    assert_eq!(iso8601_millis(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(
        iso8601_millis(1_789_578_314_212),
        "2026-09-16T17:05:14.212Z"
    );
    assert_eq!(utc_basic_timestamp(1_789_578_314_212), "20260916T170514Z");
    assert_eq!(utc_basic_timestamp(951_868_799_999), "20000229T235959Z");
    assert_eq!(iso8601_millis(951_868_800_000), "2000-03-01T00:00:00.000Z");
}

#[test]
fn ordered_json_matches_json_stringify_with_two_space_indent() {
    let tree = Json::Obj(vec![
        ("b", Json::Num(1)),
        (
            "a",
            Json::Arr(vec![
                Json::Str("x\"y".to_string()),
                Json::Null,
                Json::Bool(true),
            ]),
        ),
        ("empty", Json::Arr(vec![])),
        ("obj", Json::Obj(vec![])),
    ]);
    assert_eq!(
        render_json(&tree, true),
        "{\n  \"b\": 1,\n  \"a\": [\n    \"x\\\"y\",\n    null,\n    true\n  ],\n  \"empty\": [],\n  \"obj\": {}\n}\n"
    );
    assert_eq!(
        render_json(&tree, false),
        "{\"b\":1,\"a\":[\"x\\\"y\",null,true],\"empty\":[],\"obj\":{}}"
    );
}

#[test]
fn set_digest_is_the_canonical_json_of_sorted_identity_triples() {
    let entries = vec![
        ("b".to_string(), "s1".to_string(), "sha256-bb".to_string()),
        ("a".to_string(), "s2".to_string(), "sha256-a2".to_string()),
        ("a".to_string(), "s1".to_string(), "sha256-a1".to_string()),
    ];
    let expected_pre_image = "{\"schema\":\"h2o.savedChatLocalBackup.v1\",\"entries\":[{\"chatId\":\"a\",\"snapshotId\":\"s1\",\"contentHash\":\"sha256-a1\"},{\"chatId\":\"a\",\"snapshotId\":\"s2\",\"contentHash\":\"sha256-a2\"},{\"chatId\":\"b\",\"snapshotId\":\"s1\",\"contentHash\":\"sha256-bb\"}]}";
    assert_eq!(
        set_digest(&entries),
        format!("sha256-{}", sha256_hex(expected_pre_image.as_bytes()))
    );
    // Order-independent input, diagnostics-independent identity.
    let mut reversed = entries.clone();
    reversed.reverse();
    assert_eq!(set_digest(&reversed), set_digest(&entries));
}

#[test]
fn strict_json_refuses_duplicate_keys_that_serde_json_would_collapse() {
    let bytes = br#"{"a":1,"b":{"c":2,"c":3}}"#;
    assert!(serde_json::from_slice::<serde_json::Value>(bytes).is_ok());
    assert!(serde_json::from_slice::<StrictJson>(bytes).is_err());
    let ok: StrictJson = serde_json::from_slice(br#"{"a":[1,"x",null,true,{"k":2}]}"#).unwrap();
    assert_eq!(
        ok.get("a").and_then(StrictJson::as_array).map(|a| a.len()),
        Some(5)
    );
}

#[test]
fn counts_identities_are_the_contract_identities() {
    let counts = Counts {
        enumerated: 57,
        eligible: 55,
        success: 55,
        failed: 0,
        skipped: SkippedCounts {
            deleted: 1,
            tombstoned: 0,
            linked_only: 12,
            no_snapshot: 1,
        },
    };
    assert!(counts.identities_hold());
    assert!(!Counts {
        enumerated: 56,
        ..counts
    }
    .identities_hold());
    assert!(!Counts {
        success: 54,
        ..counts
    }
    .identities_hold());
}

// ── A. root confinement ────────────────────────────────────────────────────

#[test]
fn a_symlink_standing_where_the_root_belongs_is_refused_and_nothing_is_created_through_it() {
    let base = scratch_base("root-symlink");
    let elsewhere = base.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let root = crate::saved_chat_backup_root_policy::backup_root_from_base(&base);
    std::os::unix::fs::symlink(&elsewhere, &root).unwrap();
    let publisher = BackupPublisher::new(root.clone());
    let result = begin(&publisher, &declaration(&[("zero", "s0")]));
    assert!(!result.ok);
    assert_eq!(result.status, "backup-path-redirect-refused");
    assert!(
        entry_names(&elsewhere).is_empty(),
        "nothing created through the link"
    );
    assert!(!publisher.session_present());
    assert_eq!(list(&publisher).status, "backup-path-redirect-refused");
    assert_eq!(
        verify(&publisher, "20260916T170512Z-3f9a1c2b7e8d4a05.h2obackup").codes,
        vec!["backup-path-redirect-refused".to_string()]
    );
}

#[test]
fn a_symlink_at_the_final_name_is_never_followed_and_the_run_fails_closed() {
    let (publisher, root) = fresh_publisher("final-symlink");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, begun) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    let elsewhere = root.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let leaf = final_leaf(begun.backup_id.as_deref().unwrap(), true);
    std::os::unix::fs::symlink(&elsewhere, root.join(&leaf)).unwrap();
    let result = finalize(&publisher, token, &[]);
    assert!(!result.ok);
    assert_eq!(result.status, "backup-destination-exists");
    assert!(!result.committed);
    assert!(std::fs::symlink_metadata(root.join(&leaf))
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(
        entry_names(&elsewhere).is_empty(),
        "nothing created through the link"
    );
    // FAILED removed its own staging; the link and the foreign dir remain.
    let mut remaining = vec!["elsewhere".to_string(), leaf.clone()];
    remaining.sort();
    assert_eq!(entry_names(&root), remaining);
    // A symlink shaped like a backup is `foreign` to LIST and unreadable to VERIFY.
    let listed = list(&publisher);
    assert_eq!(
        listed
            .entries
            .iter()
            .find(|e| e.leaf == leaf)
            .map(|e| e.kind.as_str()),
        Some("foreign")
    );
    let verified = verify(&publisher, &leaf);
    assert_eq!(verified.status, "unreadable");
    assert_eq!(
        verified.codes,
        vec!["backup-path-redirect-refused".to_string()]
    );
}

#[test]
fn a_symlink_at_the_package_leaf_inside_the_run_is_a_collision_never_a_target() {
    let (publisher, _root) = fresh_publisher("leaf-symlink");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    stage_members(&publisher, token, &zero);
    let run = publisher.run_staging_path_for_test(token).unwrap();
    let elsewhere = run.join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let leaf = expected_leaf(&zero);
    std::os::unix::fs::symlink(&elsewhere, run.join("packages").join(&leaf)).unwrap();
    let result = package_finish(&publisher, token, &declared_content_hash(&zero));
    assert_eq!(result.status, "backup-package-leaf-occupied");
    assert!(entry_names(&elsewhere).is_empty());
    assert!(std::fs::symlink_metadata(run.join("packages").join(&leaf))
        .unwrap()
        .file_type()
        .is_symlink());
    // The own stage was discarded; only the foreign link remains.
    assert_eq!(entry_names(&run.join("packages")), vec![leaf]);
}

// ── B. create-only ─────────────────────────────────────────────────────────

#[test]
fn an_occupant_at_the_final_leaf_is_refused_and_left_byte_identical() {
    let (publisher, root) = fresh_publisher("final-occupied");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, begun) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    let leaf = final_leaf(begun.backup_id.as_deref().unwrap(), true);
    let occupant = root.join(&leaf);
    std::fs::create_dir_all(occupant.join("packages")).unwrap();
    std::fs::write(occupant.join("keep.txt"), b"occupant").unwrap();
    let before = tree_digest(&occupant);
    let result = finalize(&publisher, token, &[]);
    assert_eq!(result.status, "backup-destination-exists");
    assert!(!result.committed);
    assert_eq!(tree_digest(&occupant), before);
    // Own staging removed, nothing else touched.
    assert_eq!(entry_names(&root), vec![leaf]);
    assert_eq!(publisher.state_for_test(token), Some(State::Failed));
}

#[test]
fn an_occupant_at_the_package_leaf_is_refused_and_left_byte_identical() {
    let (publisher, _root) = fresh_publisher("leaf-occupied");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    stage_members(&publisher, token, &zero);
    let run = publisher.run_staging_path_for_test(token).unwrap();
    let occupant = run.join("packages").join(expected_leaf(&zero));
    std::fs::create_dir_all(&occupant).unwrap();
    std::fs::write(occupant.join("manifest.json"), b"not ours").unwrap();
    let before = tree_digest(&occupant);
    let result = package_finish(&publisher, token, &declared_content_hash(&zero));
    assert_eq!(result.status, "backup-package-leaf-occupied");
    assert_eq!(tree_digest(&occupant), before);
    assert_eq!(publisher.state_for_test(token), Some(State::Staging));
}

// ── C. session isolation ───────────────────────────────────────────────────

#[test]
fn token_mismatch_second_begin_and_undrawn_transitions_are_refused() {
    let (publisher, _root) = fresh_publisher("sessions");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    let wrong = token.wrapping_add(1);
    assert_eq!(
        package_begin(&publisher, wrong, &chat, &snap).status,
        "backup-session-unknown"
    );
    assert_eq!(
        finalize(&publisher, wrong, &[]).status,
        "backup-session-unknown"
    );
    assert_eq!(abort(&publisher, wrong).status, "backup-session-unknown");
    // MAX_ACTIVE_BACKUP_SESSIONS = 1.
    let second = begin(&publisher, &declaration(&[(&chat, &snap)]));
    assert_eq!(second.status, "backup-session-busy");
    // Undrawn transitions from a LIVE state.
    assert_eq!(
        stream(&publisher, token, &selector("snapshot", None), b"x", 1).status,
        "backup-invalid-state"
    );
    assert_eq!(
        package_finish(&publisher, token, "sha256-00").status,
        "backup-invalid-state"
    );
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    assert_eq!(
        package_begin(&publisher, token, &chat, &snap).status,
        "backup-invalid-state"
    );
    assert_eq!(
        finalize(&publisher, token, &[]).status,
        "backup-invalid-state"
    );
    // An unknown pair and a finished pair.
    assert!(package_abort(&publisher, token).ok);
    assert_eq!(
        package_begin(&publisher, token, "other", "s0").status,
        "backup-entry-unknown"
    );
    assert!(publish_package(&publisher, token, &zero).ok);
    assert_eq!(
        package_begin(&publisher, token, &chat, &snap).status,
        "backup-entry-duplicate"
    );
    // A finished session accepts no further work but can be replaced.
    assert!(finalize(&publisher, token, &[]).ok);
    assert_eq!(
        package_begin(&publisher, token, &chat, &snap).status,
        "backup-invalid-state"
    );
    assert_eq!(
        finalize(&publisher, token, &[]).status,
        "backup-invalid-state"
    );
    let replaced = begin(&publisher, &declaration(&[(&chat, &snap)]));
    assert!(replaced.ok, "a PUBLISHED record never blocks the next run");
    assert_eq!(
        package_begin(&publisher, token, &chat, &snap).status,
        "backup-session-unknown"
    );
}

// ── D. member writes ───────────────────────────────────────────────────────

#[test]
fn member_write_admission_is_exact() {
    let (publisher, _root) = fresh_publisher("members");
    let t06 = permanent_v3_fixture(false);
    let (chat, snap) = pair_of(&t06);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    let too_large = vec![0u8; (CHUNK_CAP_BYTES + 1) as usize];
    assert_eq!(
        write_member(
            &publisher,
            token,
            &selector("snapshot", None),
            false,
            None,
            &too_large
        )
        .status,
        "backup-chunk-too-large"
    );
    assert_eq!(
        write_member(
            &publisher,
            token,
            &selector("asset", Some("../x.png")),
            true,
            None,
            b"x"
        )
        .status,
        "backup-invalid-member-name"
    );
    assert_eq!(
        write_member(
            &publisher,
            token,
            &selector("markdown", None),
            true,
            None,
            b"x"
        )
        .status,
        "backup-invalid-member-name"
    );
    // Incremental hash equals the whole-file hash across many chunks.
    let snapshot = t06.snapshot.clone().unwrap();
    let closed = stream(
        &publisher,
        token,
        &selector("snapshot", None),
        &snapshot,
        13,
    );
    assert!(closed.ok);
    assert_eq!(closed.member_bytes, Some(snapshot.len() as u64));
    assert_eq!(
        closed.member_sha256.as_deref(),
        Some(format!("sha256-{}", sha256_hex(&snapshot)).as_str())
    );
    // A member name may be opened once.
    assert_eq!(
        write_member(
            &publisher,
            token,
            &selector("snapshot", None),
            true,
            None,
            b"again"
        )
        .status,
        "backup-member-duplicate"
    );
    // One open member at a time.
    assert!(
        write_member(
            &publisher,
            token,
            &selector("manifest", None),
            false,
            None,
            b"{"
        )
        .ok
    );
    let name = asset_basename(&t06, 0);
    assert_eq!(
        write_member(
            &publisher,
            token,
            &selector("asset", Some(&name)),
            false,
            None,
            b"x"
        )
        .status,
        "backup-invalid-state"
    );
    assert!(
        write_member(
            &publisher,
            token,
            &selector("manifest", None),
            true,
            None,
            b"}"
        )
        .ok
    );
    assert_eq!(publisher.state_for_test(token), Some(State::PackageOpen));
}

#[test]
fn member_integrity_failures_discard_the_stage_and_keep_the_session_usable() {
    let (publisher, _root) = fresh_publisher("member-integrity");
    let t06 = permanent_v3_fixture(false);
    let (chat, snap) = pair_of(&t06);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    let run = publisher.run_staging_path_for_test(token).unwrap();
    let (asset_sha, asset_body) = t06.asset_bodies[0].clone();
    let good_name = asset_basename(&t06, 0);
    let wrong_name = format!("sha256-{}.png", "0".repeat(64));
    assert!(good_name.contains(asset_sha.strip_prefix("sha256-").unwrap()));

    // Asset hash/name mismatch.
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    let result = stream(
        &publisher,
        token,
        &selector("asset", Some(&wrong_name)),
        &asset_body,
        5,
    );
    assert_eq!(result.status, "backup-asset-hash-mismatch");
    assert!(result.codes.is_empty(), "own cleanup completed");
    assert_eq!(publisher.state_for_test(token), Some(State::Staging));
    assert!(
        entry_names(&run.join("packages")).is_empty(),
        "stage discarded"
    );
    // package_abort after a discarded stage is benign.
    let aborted = package_abort(&publisher, token);
    assert!(aborted.ok && !aborted.cleanup_incomplete);

    // Length mismatch.
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    let result = write_member(
        &publisher,
        token,
        &selector("asset", Some(&good_name)),
        true,
        Some(19),
        &asset_body,
    );
    assert_eq!(result.status, "backup-member-length-mismatch");
    assert!(entry_names(&run.join("packages")).is_empty());

    // Empty member.
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    let result = write_member(
        &publisher,
        token,
        &selector("snapshot", None),
        true,
        None,
        b"",
    );
    assert_eq!(result.status, "backup-member-empty");
    assert!(entry_names(&run.join("packages")).is_empty());

    // Content fence failure at close.
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    {
        let _guard = FenceGuard::force(FenceSite::MemberContent);
        let result = stream(
            &publisher,
            token,
            &selector("snapshot", None),
            t06.snapshot.as_ref().unwrap(),
            200,
        );
        assert_eq!(result.status, "backup-fence-failed");
    }
    assert!(entry_names(&run.join("packages")).is_empty());

    // The rebuild path: the same pair is begun again and publishes.
    let result = publish_package(&publisher, token, &t06);
    assert!(result.ok, "{} {:?}", result.status, result.codes);
    assert_eq!(
        entry_names(&run.join("packages")),
        vec![expected_leaf(&t06)]
    );
}

// ── E. verification gating ─────────────────────────────────────────────────

#[test]
fn the_identity_and_gzip_fixtures_verify_bind_and_promote_under_the_derived_leaf() {
    for gzip in [false, true] {
        let (publisher, _root) = fresh_publisher(if gzip {
            "verify-gzip"
        } else {
            "verify-identity"
        });
        let t06 = permanent_v3_fixture(gzip);
        let (chat, snap) = pair_of(&t06);
        let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
        assert!(package_begin(&publisher, token, &chat, &snap).ok);
        stage_members(&publisher, token, &t06);
        // NB-11: the package sits under its dot-prefixed stage name until the
        // trusted verifier has inspected it there.
        let run = publisher.run_staging_path_for_test(token).unwrap();
        let staged = entry_names(&run.join("packages"));
        assert_eq!(staged.len(), 1);
        assert!(
            staged[0].starts_with(PACKAGE_STAGING_PREFIX),
            "{}",
            staged[0]
        );
        let result = package_finish(&publisher, token, &declared_content_hash(&t06));
        assert!(result.ok, "{} {:?}", result.status, result.codes);
        assert_eq!(result.status, "verified");
        let entry = result.entry.expect("entry");
        assert_eq!(entry.chat_id, chat);
        assert_eq!(entry.snapshot_id, snap);
        assert_eq!(entry.content_hash, declared_content_hash(&t06));
        assert_eq!(entry.package_leaf, expected_leaf(&t06));
        assert_eq!(entry.construction_family, "v3");
        assert_eq!((entry.schema_version, entry.payload_version), (3, 3));
        assert_eq!(
            entry.snapshot.encoding,
            if gzip { "gzip" } else { "identity" }
        );
        assert_eq!(
            entry.snapshot.logical_sha256,
            "sha256-275b305bbd4d55874fe0508003fceedc5c41940139fb17376dd336e614b4fa3b"
        );
        assert_eq!(entry.snapshot.logical_byte_length, 1143);
        assert_eq!(
            entry.snapshot.physical_byte_length,
            if gzip { 497 } else { 1143 }
        );
        assert_eq!(
            entry.members,
            vec![
                "assets/sha256-b6a38573d3cd8607b3cda428df2c4b2d05d976c58f55e47eeac8ffb0c34f780b.png"
                    .to_string(),
                "manifest.json".to_string(),
                "snapshot.json".to_string(),
            ]
        );
        assert_eq!(
            entry.assets,
            vec![
                "sha256-b6a38573d3cd8607b3cda428df2c4b2d05d976c58f55e47eeac8ffb0c34f780b"
                    .to_string()
            ]
        );
        assert_eq!(entry.asset_source, "projection");
        assert!(entry.saved_at.is_some());
        // The leaf is derived from the RECOMPUTED hash, not the stage name.
        assert_eq!(
            entry_names(&run.join("packages")),
            vec![expected_leaf(&t06)]
        );
        assert_eq!(publisher.state_for_test(token), Some(State::Staging));
    }
}

#[test]
fn a_package_whose_bytes_disagree_with_its_manifest_is_never_promoted() {
    let (publisher, _root) = fresh_publisher("corrupt");
    let t06 = permanent_v3_fixture(false);
    let (chat, snap) = pair_of(&t06);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    let run = publisher.run_staging_path_for_test(token).unwrap();
    // Flipped snapshot byte: the verifier refuses at package_finish.
    let bad_snapshot = flipped(&t06, "snapshot");
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    stage_members(&publisher, token, &bad_snapshot);
    let result = package_finish(&publisher, token, &declared_content_hash(&bad_snapshot));
    assert_eq!(result.status, "backup-package-verification-failed");
    assert!(
        !result.codes.is_empty(),
        "verifier code carried as evidence"
    );
    assert!(
        entry_names(&run.join("packages")).is_empty(),
        "nothing promoted"
    );
    assert_eq!(publisher.state_for_test(token), Some(State::Staging));
    // Flipped asset byte: it can never even close under its canonical name.
    let bad_asset = flipped(&t06, "asset");
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    let name = asset_basename(&bad_asset, 0);
    let result = stream(
        &publisher,
        token,
        &selector("asset", Some(&name)),
        &bad_asset.asset_bodies[0].1,
        5,
    );
    assert_eq!(result.status, "backup-asset-hash-mismatch");
    assert!(entry_names(&run.join("packages")).is_empty());
    assert_eq!(publisher.state_for_test(token), Some(State::Staging));
    // A manifest whose declared asset was never streamed: verification fails.
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    let result = stream(
        &publisher,
        token,
        &selector("snapshot", None),
        t06.snapshot.as_ref().unwrap(),
        100,
    );
    assert!(result.ok);
    let result = stream(
        &publisher,
        token,
        &selector("manifest", None),
        &t06.manifest,
        100,
    );
    assert!(result.ok);
    let result = package_finish(&publisher, token, &declared_content_hash(&t06));
    assert_eq!(result.status, "backup-package-verification-failed");
    assert!(entry_names(&run.join("packages")).is_empty());
}

#[test]
fn package_finish_binds_the_expected_hash_in_both_representations_and_the_declared_pair() {
    let (publisher, _root) = fresh_publisher("binding");
    let t06 = permanent_v3_fixture(false);
    let (chat, snap) = pair_of(&t06);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap), ("t06-other", &snap)]);
    let run = publisher.run_staging_path_for_test(token).unwrap();
    let real = declared_content_hash(&t06);
    let bare = real.strip_prefix("sha256-").unwrap().to_string();
    let wrong_prefixed = format!("sha256-{}", "1".repeat(64));
    let wrong_bare = "2".repeat(64);
    for wrong in [wrong_prefixed.as_str(), wrong_bare.as_str()] {
        assert!(package_begin(&publisher, token, &chat, &snap).ok);
        stage_members(&publisher, token, &t06);
        let result = package_finish(&publisher, token, wrong);
        assert_eq!(result.status, "backup-package-identity-mismatch");
        assert!(
            entry_names(&run.join("packages")).is_empty(),
            "no promotion"
        );
    }
    // A malformed claim is a protocol error with no side effect.
    assert!(package_begin(&publisher, token, &chat, &snap).ok);
    stage_members(&publisher, token, &t06);
    assert_eq!(
        package_finish(&publisher, token, "sha256-zz").status,
        "backup-invalid-member-name"
    );
    assert_eq!(publisher.state_for_test(token), Some(State::PackageOpen));
    // The bare representation binds exactly like the prefixed one.
    let result = package_finish(&publisher, token, &bare.to_ascii_uppercase());
    assert!(result.ok, "{} {:?}", result.status, result.codes);
    // A pair declared at package_begin that differs from the verified identity.
    assert!(package_begin(&publisher, token, "t06-other", &snap).ok);
    stage_members(&publisher, token, &t06);
    let result = package_finish(&publisher, token, &real);
    assert_eq!(result.status, "backup-package-identity-mismatch");
    assert_eq!(
        entry_names(&run.join("packages")),
        vec![expected_leaf(&t06)]
    );
}

// ── F. set scanner reuse (RC-T01-BACKUP-02) ────────────────────────────────

#[test]
fn finalize_fails_closed_on_a_foreign_entry_or_a_stage_leftover_under_packages() {
    let cases: [(&str, fn(&Path)); 3] = [
        ("foreign-file", |packages: &Path| {
            std::fs::write(packages.join("notes.txt"), b"foreign").unwrap()
        }),
        ("bkpkg-leftover", |packages: &Path| {
            std::fs::create_dir(
                packages.join(format!("{PACKAGE_STAGING_PREFIX}{}", "0".repeat(32))),
            )
            .unwrap()
        }),
        ("legacy-leaf", |packages: &Path| {
            std::fs::create_dir(packages.join("legacy.h2ochat")).unwrap()
        }),
    ];
    for (label, inject) in cases {
        let (publisher, root) = fresh_publisher(label);
        let zero = zero_asset_v3();
        let (chat, snap) = pair_of(&zero);
        let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
        assert!(publish_package(&publisher, token, &zero).ok);
        let run = publisher.run_staging_path_for_test(token).unwrap();
        inject(&run.join("packages"));
        let result = finalize(&publisher, token, &[]);
        assert!(!result.ok, "{label}");
        assert!(
            matches!(
                result.status.as_str(),
                "backup-set-foreign-entry" | "backup-set-package-unverified"
            ),
            "{label}: {}",
            result.status
        );
        assert!(!result.committed);
        assert!(
            result
                .codes
                .contains(&"backup-cleanup-incomplete".to_string()),
            "{label}: the foreign entry blocks own cleanup"
        );
        // No final leaf; the foreign entry is untouched inside the residue.
        assert!(
            entry_names(&root)
                .iter()
                .all(|n| n.starts_with(RUN_STAGING_PREFIX)),
            "{label}"
        );
        assert_eq!(
            entry_names(&run.join("packages")).len(),
            1,
            "{label}: only the foreign entry remains"
        );
        assert_eq!(publisher.state_for_test(token), Some(State::Failed));
    }
}

#[test]
fn finalize_scans_the_native_staging_run_path_and_the_manifest_is_not_an_occupant() {
    let (_publisher, root, result) = complete_run("scan-run-path");
    assert!(result.ok, "{} {:?}", result.status, result.codes);
    let leaf = result.backup_leaf.clone().unwrap();
    // `backup-manifest.json` sits at the run root, outside `packages/`.
    assert_eq!(
        entry_names(&root.join(&leaf)),
        vec![BACKUP_MANIFEST_NAME.to_string(), "packages".to_string()]
    );
    let scan = crate::archive_package_scan::scan_packages_within(&root.join(&leaf));
    assert!(scan.complete && scan.blockers.is_empty());
    assert_eq!(scan.occupants.len(), 2);
}

// ── G. declaration-before-creation (NB-05) and platform ────────────────────

#[test]
fn a_refused_declaration_creates_no_root_no_staging_and_no_session() {
    let (publisher, root) = fresh_publisher("declaration");
    let refusals = [
        (declaration(&[]), "backup-nothing-to-back-up"),
        (
            declaration(&[("zero", "s0"), ("zero", "s0")]),
            "backup-enumeration-inconsistent",
        ),
        (
            declaration(&[("zero", "s0"), ("zero", "s1")]),
            "backup-enumeration-inconsistent",
        ),
        (
            declaration(&[(".dot", "s0")]),
            "backup-enumeration-inconsistent",
        ),
        (
            declaration(&[("bad/chat", "s0")]),
            "backup-enumeration-inconsistent",
        ),
        (
            declaration(&[("zero", " s0")]),
            "backup-enumeration-inconsistent",
        ),
        (
            EnumerationDeclaration {
                enumerated_count: 5,
                ..declaration(&[("zero", "s0")])
            },
            "backup-enumeration-inconsistent",
        ),
        (
            EnumerationDeclaration {
                at: String::new(),
                ..declaration(&[("zero", "s0")])
            },
            "backup-enumeration-inconsistent",
        ),
    ];
    for (declared, code) in refusals {
        let result = begin(&publisher, &declared);
        assert_eq!(result.status, code);
        assert!(result.token.is_none() && result.backup_id.is_none());
        assert!(!root.exists(), "{code}: the root must not exist");
        assert!(!publisher.session_present(), "{code}");
    }
    // The non-macOS arm refuses before the declaration is even read.
    let result = begin_with_platform(&publisher, &declaration(&[("zero", "s0")]), None);
    assert_eq!(result.status, "backup-unsupported-platform");
    assert!(!root.exists());
    assert!(!publisher.session_present());
    // Only the creating step creates the root.
    let created = begin(&publisher, &declaration(&[("zero", "s0")]));
    assert!(created.ok);
    assert!(root.is_dir());
    let staging = created.staging_leaf.unwrap();
    assert!(
        staging.starts_with(RUN_STAGING_PREFIX) && staging.len() == RUN_STAGING_PREFIX.len() + 32
    );
    assert!(is_backup_id(created.backup_id.as_deref().unwrap()));
    assert_eq!(
        created.platform,
        Some(PlatformFact {
            supported: true,
            family: Some("macos"),
        })
    );
    assert_eq!(
        entry_names(&root.join(&staging)),
        vec!["packages".to_string()]
    );
}

// ── H. cancellation and eviction (NB-06) ───────────────────────────────────

#[test]
fn abort_removes_own_staging_and_later_commands_report_cancelled_then_unknown() {
    let (publisher, root) = fresh_publisher("abort");
    let zero = zero_asset_v3();
    let t06 = permanent_v3_fixture(false);
    let (chat, snap) = pair_of(&zero);
    let (t06_chat, t06_snap) = pair_of(&t06);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap), (&t06_chat, &t06_snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    // Abort from PACKAGE_OPEN with a half-written member and a published leaf.
    assert!(package_begin(&publisher, token, &t06_chat, &t06_snap).ok);
    assert!(
        write_member(
            &publisher,
            token,
            &selector("snapshot", None),
            false,
            None,
            b"partial"
        )
        .ok
    );
    let aborted = abort(&publisher, token);
    assert!(aborted.ok && aborted.status == "aborted" && !aborted.cleanup_incomplete);
    assert!(
        entry_names(&root).is_empty(),
        "own staging removed: {:?}",
        entry_names(&root)
    );
    assert_eq!(publisher.state_for_test(token), Some(State::Aborted));
    for status in [
        package_begin(&publisher, token, &chat, &snap).status,
        stream(&publisher, token, &selector("snapshot", None), b"x", 1).status,
        package_finish(&publisher, token, "sha256-00").status,
        finalize(&publisher, token, &[]).status,
        package_abort(&publisher, token).status,
        abort(&publisher, token).status,
    ] {
        assert_eq!(status, "backup-cancelled");
    }
    // The next BEGIN evicts the record; the old token is then unknown.
    let next = begin(&publisher, &declaration(&[(&chat, &snap)]));
    assert!(next.ok);
    assert_eq!(
        package_begin(&publisher, token, &chat, &snap).status,
        "backup-session-unknown"
    );
}

#[test]
fn a_foreign_entry_inside_the_own_tree_stops_that_subtree_and_is_reported() {
    let (publisher, root) = fresh_publisher("abort-foreign");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, begun) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    let run = root.join(begun.staging_leaf.as_deref().unwrap());
    let foreign = run
        .join("packages")
        .join(expected_leaf(&zero))
        .join("foreign.bin");
    std::fs::write(&foreign, b"not ours").unwrap();
    let aborted = abort(&publisher, token);
    assert!(aborted.ok);
    assert!(aborted.cleanup_incomplete);
    assert_eq!(std::fs::read(&foreign).unwrap(), b"not ours");
    // Everything of our own around it is gone; the containing dirs remain
    // because they are not empty.
    assert_eq!(
        entry_names(&run.join("packages").join(expected_leaf(&zero))),
        vec!["foreign.bin".to_string()]
    );
    assert_eq!(entry_names(&run), vec!["packages".to_string()]);
    // LIST classifies the leftover as residue and never removes it.
    let listed = list(&publisher);
    assert_eq!(listed.residue_count, 1);
    assert_eq!(
        listed.codes,
        vec!["backup-staging-residue-detected".to_string()]
    );
    assert!(list(&publisher).root_present);
    assert!(std::fs::read(&foreign).is_ok());
}

#[test]
fn idle_sessions_are_evicted_lazily_with_own_cleanup() {
    // Observed by its own token: evicted, then unknown.
    let (publisher, root) = fresh_publisher("idle-own");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, begun) = begin_ok(&publisher, &[(&chat, &snap)]);
    let staging = root.join(begun.staging_leaf.as_deref().unwrap());
    assert!(staging.is_dir());
    publisher.age_session_for_test(token, SESSION_IDLE_TIMEOUT);
    assert_eq!(
        package_begin(&publisher, token, &chat, &snap).status,
        "backup-session-evicted"
    );
    assert!(
        !staging.exists(),
        "the evicting path removed the own staging"
    );
    assert_eq!(
        package_begin(&publisher, token, &chat, &snap).status,
        "backup-session-unknown"
    );
    assert!(!publisher.session_present());

    // Observed by the next BEGIN: evicted and replaced.
    let (publisher, root) = fresh_publisher("idle-begin");
    let (token, begun) = begin_ok(&publisher, &[(&chat, &snap)]);
    let staging = root.join(begun.staging_leaf.as_deref().unwrap());
    publisher.age_session_for_test(token, SESSION_IDLE_TIMEOUT);
    let next = begin(&publisher, &declaration(&[(&chat, &snap)]));
    assert!(next.ok, "{}", next.status);
    assert!(!staging.exists());
    assert_eq!(
        package_begin(&publisher, token, &chat, &snap).status,
        "backup-session-unknown"
    );
    assert_eq!(entry_names(&root), vec![next.staging_leaf.unwrap()]);
}

// ── I. manifest bound (NB-07) ──────────────────────────────────────────────

#[test]
fn an_oversized_manifest_is_refused_before_any_temp_file_exists() {
    let (publisher, _root) = fresh_publisher("manifest-bound");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    let run = publisher.run_staging_path_for_test(token).unwrap();
    MANIFEST_MAX_OVERRIDE.with(|f| f.set(Some(64)));
    let result = finalize(&publisher, token, &[]);
    MANIFEST_MAX_OVERRIDE.with(|f| f.set(None));
    assert_eq!(result.status, "backup-manifest-too-large");
    assert!(!result.committed);
    assert_eq!(
        entry_names(&run),
        vec!["packages".to_string()],
        "no temp file created"
    );
    // A refusal before SET_FINALIZING leaves the session usable.
    assert_eq!(publisher.state_for_test(token), Some(State::Staging));
    let result = finalize(&publisher, token, &[]);
    assert!(result.ok, "{}", result.status);
    assert_eq!(BACKUP_MANIFEST_MAX_BYTES, BACKUP_MANIFEST_READ_CAP_BYTES);
    assert_eq!(BACKUP_MANIFEST_MAX_BYTES, 256 * 1024 * 1024);
}

// ── J. durability ──────────────────────────────────────────────────────────

#[test]
fn a_fence_failure_before_the_commit_point_fails_the_run_and_after_it_is_reported_honestly() {
    // Before step 11: FAILED, no leaf, own staging removed.
    for site in [
        FenceSite::ManifestContent,
        FenceSite::RunAfterManifest,
        FenceSite::RunAfterScan,
    ] {
        let (publisher, root) = fresh_publisher("fence-before");
        let zero = zero_asset_v3();
        let (chat, snap) = pair_of(&zero);
        let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
        assert!(publish_package(&publisher, token, &zero).ok);
        let result = {
            let _guard = FenceGuard::force(site);
            finalize(&publisher, token, &[])
        };
        assert_eq!(result.status, "backup-fence-failed", "{site:?}");
        assert!(!result.committed && !result.durability_complete, "{site:?}");
        assert!(
            entry_names(&root).is_empty(),
            "{site:?}: {:?}",
            entry_names(&root)
        );
        assert_eq!(publisher.state_for_test(token), Some(State::Failed));
    }
    // After step 11: committed, durability incomplete, the leaf exists.
    let (publisher, root) = fresh_publisher("fence-after");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    let result = {
        let _guard = FenceGuard::force(FenceSite::Root);
        finalize(&publisher, token, &[])
    };
    assert!(result.ok);
    assert_eq!(result.status, "published");
    assert!(result.committed);
    assert!(!result.durability_complete);
    assert_eq!(result.codes, vec!["backup-fence-failed".to_string()]);
    let leaf = result.backup_leaf.unwrap();
    assert_eq!(entry_names(&root), vec![leaf.clone()]);
    assert_eq!(verify(&publisher, &leaf).status, "valid-complete");
    assert_eq!(publisher.state_for_test(token), Some(State::Published));
    // Per-package fences: a stage fence failure discards the stage; a
    // packages-dir fence failure after promotion removes the own leaf.
    let (publisher, _root) = fresh_publisher("fence-package");
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    let run = publisher.run_staging_path_for_test(token).unwrap();
    for site in [FenceSite::PackageStage, FenceSite::PackagesDir] {
        assert!(package_begin(&publisher, token, &chat, &snap).ok);
        stage_members(&publisher, token, &zero);
        let result = {
            let _guard = FenceGuard::force(site);
            package_finish(&publisher, token, &declared_content_hash(&zero))
        };
        assert_eq!(result.status, "backup-fence-failed", "{site:?}");
        assert!(entry_names(&run.join("packages")).is_empty(), "{site:?}");
        assert_eq!(publisher.state_for_test(token), Some(State::Staging));
    }
    assert!(publish_package(&publisher, token, &zero).ok);
}

#[test]
fn a_pending_abort_is_observed_at_a_finalize_step_boundary_before_the_commit_point() {
    // (a) The flag is already raised when FINALIZE arrives (a concurrent
    // abort waiting for the lease): FINALIZE returns cancelled with no side
    // effect and the abort command owns the cleanup.
    let (publisher, root) = fresh_publisher("pending-abort-entry");
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    publisher.request_abort_for_test(token);
    let result = finalize(&publisher, token, &[]);
    assert_eq!(result.status, "backup-cancelled");
    assert!(!result.committed);
    assert_eq!(publisher.state_for_test(token), Some(State::Staging));
    let aborted = abort(&publisher, token);
    assert!(aborted.ok && !aborted.cleanup_incomplete);
    assert!(entry_names(&root).is_empty());
    assert_eq!(publisher.state_for_test(token), Some(State::Aborted));

    // (b) The flag is raised mid-run: every checkpoint before the commit
    // point yields FAILED / cancelled with own cleanup and no leaf.
    for checkpoint in 1..=4u32 {
        let (publisher, root) = fresh_publisher("pending-abort-mid");
        let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
        assert!(publish_package(&publisher, token, &zero).ok);
        FORCE_ABORT_AT_CHECKPOINT.with(|f| f.set(Some(checkpoint)));
        let result = finalize(&publisher, token, &[]);
        FORCE_ABORT_AT_CHECKPOINT.with(|f| f.set(None));
        assert_eq!(result.status, "backup-cancelled", "checkpoint {checkpoint}");
        assert!(!result.committed, "checkpoint {checkpoint}");
        assert!(
            entry_names(&root).is_empty(),
            "checkpoint {checkpoint}: {:?}",
            entry_names(&root)
        );
        assert_eq!(publisher.state_for_test(token), Some(State::Failed));
        // The abort command itself then finds nothing left to do.
        let aborted = abort(&publisher, token);
        assert!(aborted.ok && !aborted.cleanup_incomplete);
    }
    // (c) A checkpoint that is never reached changes nothing.
    let (publisher, _root) = fresh_publisher("pending-abort-none");
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    FORCE_ABORT_AT_CHECKPOINT.with(|f| f.set(Some(5)));
    let result = finalize(&publisher, token, &[]);
    FORCE_ABORT_AT_CHECKPOINT.with(|f| f.set(None));
    assert!(result.ok, "{}", result.status);
    assert!(result.committed && result.durability_complete);
}

// ── K. retry / new identity, complete vs partial ───────────────────────────

#[test]
fn two_runs_on_one_root_publish_two_distinct_leaves_and_the_first_is_untouched() {
    let (publisher, root, first) = complete_run("two-runs");
    assert!(first.ok);
    let first_leaf = first.backup_leaf.clone().unwrap();
    let before = tree_digest(&root.join(&first_leaf));
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    let second = finalize(&publisher, token, &[]);
    assert!(second.ok, "{}", second.status);
    let second_leaf = second.backup_leaf.unwrap();
    assert_ne!(first_leaf, second_leaf);
    assert_ne!(first.backup_id, second.backup_id);
    assert_eq!(tree_digest(&root.join(&first_leaf)), before);
    let mut expected = vec![first_leaf, second_leaf];
    expected.sort();
    assert_eq!(entry_names(&root), expected);
    assert!(first.durability_complete && second.durability_complete);
    assert!(first.full_fsync && second.full_fsync);
}

#[test]
fn a_run_with_failures_publishes_an_explicit_partial_object_and_zero_success_publishes_nothing() {
    let (publisher, root) = fresh_publisher("partial");
    let zero = zero_asset_v3();
    let t06 = permanent_v3_fixture(false);
    let (chat, snap) = pair_of(&zero);
    let (t06_chat, t06_snap) = pair_of(&t06);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap), (&t06_chat, &t06_snap)]);
    assert!(publish_package(&publisher, token, &zero).ok);
    // The declared failure set must be exactly the unpublished remainder.
    assert_eq!(
        finalize(&publisher, token, &[]).status,
        "backup-manifest-inconsistent"
    );
    assert_eq!(
        finalize(&publisher, token, &[failure(&chat, &snap, "x")]).status,
        "backup-manifest-inconsistent"
    );
    assert_eq!(
        finalize(&publisher, token, &[failure("nobody", "s0", "x")]).status,
        "backup-entry-unknown"
    );
    assert_eq!(publisher.state_for_test(token), Some(State::Staging));
    let result = finalize(
        &publisher,
        token,
        &[failure(
            &t06_chat,
            &t06_snap,
            "backup-projection-bound-exceeded",
        )],
    );
    assert!(result.ok, "{}", result.status);
    assert_eq!(result.status, "published-partial");
    assert_eq!(result.complete, Some(false));
    let leaf = result.backup_leaf.clone().unwrap();
    assert!(leaf.ends_with(FINAL_PARTIAL_SUFFIX));
    let counts = result.counts.unwrap();
    assert_eq!(
        (
            counts.enumerated,
            counts.eligible,
            counts.success,
            counts.failed
        ),
        (2, 2, 1, 1)
    );
    let manifest: serde_json::Value = serde_json::from_slice(&read_manifest(&root, &leaf)).unwrap();
    assert_eq!(manifest["complete"], false);
    assert_eq!(manifest["failures"].as_array().unwrap().len(), 1);
    assert_eq!(
        manifest["failures"][0]["code"],
        "backup-projection-bound-exceeded"
    );
    assert_eq!(manifest["failures"][0]["declaredBy"], "renderer");
    let verified = verify(&publisher, &leaf);
    assert_eq!(verified.status, "valid-incomplete", "{:?}", verified.codes);
    assert_eq!(verified.complete, Some(false));

    // Zero success: refused, no leaf, and abort cleans the own tree.
    let (publisher, root) = fresh_publisher("zero-success");
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    let result = finalize(&publisher, token, &[failure(&chat, &snap, "x")]);
    assert_eq!(result.status, "backup-no-package-succeeded");
    assert!(entry_names(&root)
        .iter()
        .all(|n| n.starts_with(RUN_STAGING_PREFIX)));
    assert!(abort(&publisher, token).ok);
    assert!(entry_names(&root).is_empty());
}

// ── L. the manifest ────────────────────────────────────────────────────────

#[test]
fn the_published_manifest_has_the_frozen_shape_key_order_and_digests() {
    let (_publisher, root, result) = complete_run("manifest-shape");
    assert!(result.ok, "{} {:?}", result.status, result.codes);
    let leaf = result.backup_leaf.clone().unwrap();
    let bytes = read_manifest(&root, &leaf);
    assert_eq!(
        result.manifest_sha256.as_deref(),
        Some(format!("sha256-{}", sha256_hex(&bytes)).as_str())
    );
    assert!(bytes.ends_with(b"\n") && !bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
    assert!(bytes.starts_with(
        b"{\n  \"schema\": \"h2o.savedChatLocalBackup.v1\",\n  \"schemaVersion\": 1,\n"
    ));
    let strict: StrictJson = serde_json::from_slice(&bytes).expect("no duplicate keys");
    let keys = |node: &StrictJson| -> Vec<String> {
        match node {
            StrictJson::Object(fields) => fields.iter().map(|(k, _)| k.clone()).collect(),
            _ => Vec::new(),
        }
    };
    assert_eq!(
        keys(&strict),
        [
            "schema",
            "schemaVersion",
            "backupId",
            "createdAt",
            "complete",
            "consistency",
            "source",
            "enumeration",
            "entries",
            "failures",
            "setDigest",
            "verification",
        ]
    );
    assert_eq!(
        keys(strict.get("source").unwrap()),
        [
            "appBuildStamp",
            "liveGenerationFamily",
            "platform",
            "hostRootMode"
        ]
    );
    assert_eq!(keys(strict.get("enumeration").unwrap()), ["at", "counts"]);
    let counts = strict.get("enumeration").unwrap().get("counts").unwrap();
    assert_eq!(
        keys(counts),
        ["enumerated", "eligible", "success", "failed", "skipped"]
    );
    assert_eq!(
        keys(counts.get("skipped").unwrap()),
        ["deleted", "tombstoned", "linkedOnly", "noSnapshot"]
    );
    let entries = strict.get("entries").unwrap().as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        keys(&entries[0]),
        [
            "chatId",
            "snapshotId",
            "contentHash",
            "packageLeaf",
            "constructionFamily",
            "schemaVersion",
            "payloadVersion",
            "snapshot",
            "members",
            "assets",
            "assetSource",
            "savedAt",
        ]
    );
    assert_eq!(
        keys(entries[0].get("snapshot").unwrap()),
        [
            "encoding",
            "physicalSha256",
            "physicalByteLength",
            "logicalSha256",
            "logicalByteLength"
        ]
    );
    assert_eq!(
        keys(strict.get("verification").unwrap()),
        [
            "packageScanComplete",
            "occupantCount",
            "verifiedCount",
            "crossCheck",
            "fullFsync"
        ]
    );
    // Entry order: chatId byte order ("t06-…" < "zero").
    assert_eq!(
        entries[0].get("chatId").unwrap().as_str(),
        Some("t06-canonical-assets")
    );
    assert_eq!(entries[1].get("chatId").unwrap().as_str(), Some("zero"));
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        value["consistency"],
        "per-entry-guarded-enumeration-time-set"
    );
    assert_eq!(value["source"]["liveGenerationFamily"], "v3");
    assert_eq!(value["source"]["platform"], "macos");
    assert_eq!(value["source"]["hostRootMode"], "home");
    assert_eq!(value["source"]["appBuildStamp"], "test-build");
    assert_eq!(value["enumeration"]["at"], "2026-09-16T17:05:02.001Z");
    assert_eq!(value["backupId"].as_str(), Some(result.backup_id.as_str()));
    assert_eq!(
        iso8601_millis(0).len(),
        value["createdAt"].as_str().unwrap().len()
    );
    assert_eq!(value["verification"]["fullFsync"], true);
    assert_eq!(value["verification"]["occupantCount"], 2);
    assert_eq!(value["setDigest"].as_str(), result.set_digest.as_deref());
    // setDigest recomputed independently from the entries.
    let triples: Vec<(String, String, String)> = entries
        .iter()
        .map(|e| {
            (
                e.get("chatId").unwrap().as_str().unwrap().to_string(),
                e.get("snapshotId").unwrap().as_str().unwrap().to_string(),
                e.get("contentHash").unwrap().as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(set_digest(&triples), result.set_digest.clone().unwrap());
    // Two backups of identical content share a setDigest.
    let (_, _, again) = complete_run("manifest-shape-again");
    assert_eq!(again.set_digest, Some(set_digest(&triples)));
    assert_ne!(again.backup_id, result.backup_id);
    let parsed = parse_manifest(&bytes).expect("round trip");
    assert_eq!(parsed.entries.len(), 2);
    assert!(manifest_consistency(&parsed, false, &result.backup_id).is_ok());
    assert!(root
        .join(&leaf)
        .join("packages")
        .join(expected_leaf(&zero_asset_v3()))
        .is_dir());
}

// ── M. Verify Backup ───────────────────────────────────────────────────────

#[test]
fn verify_backup_reports_every_status_class_and_writes_nothing() {
    let (publisher, root, result) = complete_run("verify");
    let leaf = result.backup_leaf.clone().unwrap();
    let before = tree_digest(&root);
    let valid = verify(&publisher, &leaf);
    assert_eq!(valid.status, "valid-complete", "{:?}", valid.codes);
    assert!(valid.codes.is_empty());
    assert_eq!(valid.backup_id.as_deref(), Some(result.backup_id.as_str()));
    assert_eq!(valid.complete, Some(true));
    assert_eq!(valid.entries_verified, 2);
    assert_eq!(valid.occupants_seen, 2);
    assert_eq!(valid.set_digest, result.set_digest);
    assert_eq!(tree_digest(&root), before, "verify performs zero writes");

    // unsupported: a leaf outside the final grammar (residue / foreign).
    for foreign in [
        format!("{RUN_STAGING_PREFIX}{}", "a".repeat(32)),
        "notes.txt".to_string(),
        "../x".to_string(),
    ] {
        let out = verify(&publisher, &foreign);
        assert_eq!(out.status, "unsupported");
        assert_eq!(out.codes, vec!["backup-not-a-backup-leaf".to_string()]);
    }
    // unreadable: an absent leaf, an absent root.
    let absent = verify(&publisher, "20260916T170512Z-3f9a1c2b7e8d4a05.h2obackup");
    assert_eq!(absent.status, "unreadable");
    assert_eq!(absent.codes, vec!["backup-not-a-backup-leaf".to_string()]);
    let (empty, _) = fresh_publisher("verify-no-root");
    let out = verify(&empty, &leaf);
    assert_eq!(
        (out.status.as_str(), out.codes.clone()),
        ("unreadable", vec!["backup-root-absent".to_string()])
    );
    assert_eq!(list(&empty).status, "backup-root-absent");
    assert_eq!(tree_digest(&root), before);
}

#[test]
fn verify_backup_classifies_every_malformed_and_unsupported_manifest_condition() {
    let (publisher, root, result) = complete_run("verify-malformed");
    let leaf = result.backup_leaf.clone().unwrap();
    let manifest_path = root.join(&leaf).join(BACKUP_MANIFEST_NAME);
    let pristine = std::fs::read(&manifest_path).unwrap();
    let text = String::from_utf8(pristine.clone()).unwrap();
    let mutate = |from: &str, to: &str| {
        assert!(text.contains(from), "{from}");
        std::fs::write(&manifest_path, text.replacen(from, to, 1)).unwrap();
    };
    let expect = |status: &str, code: &str| {
        let out = verify(&publisher, &leaf);
        assert_eq!(
            (out.status.as_str(), out.codes.as_slice()),
            (status, &[code.to_string()][..])
        );
    };
    mutate("\"schemaVersion\": 1,", "\"schemaVersion\": 2,");
    expect("unsupported", "backup-manifest-invalid");
    mutate("h2o.savedChatLocalBackup.v1", "h2o.somethingElse.v9");
    expect("unsupported", "backup-manifest-invalid");
    std::fs::write(&manifest_path, b"{ not json").unwrap();
    expect("malformed", "backup-manifest-invalid");
    std::fs::write(
        &manifest_path,
        text.replacen(
            "\"complete\": true,",
            "\"complete\": true,\n  \"complete\": true,",
            1,
        ),
    )
    .unwrap();
    expect("malformed", "backup-manifest-invalid");
    mutate("\"complete\": true,", "\"complete\": false,");
    expect("malformed", "backup-manifest-inconsistent");
    mutate("\"success\": 2,", "\"success\": 3,");
    expect("malformed", "backup-manifest-inconsistent");
    // setDigest tampered.
    let digest = result.set_digest.clone().unwrap();
    mutate(&digest, &format!("sha256-{}", "0".repeat(64)));
    expect("malformed", "backup-set-digest-mismatch");
    // An entry's declared facts disagree with the verified occupant.
    mutate("\"encoding\": \"identity\"", "\"encoding\": \"gzip\"");
    expect("malformed", "backup-set-cross-check-failed");
    std::fs::write(&manifest_path, &pristine).unwrap();
    assert_eq!(verify(&publisher, &leaf).status, "valid-complete");
    // Leaf / marker disagreement (§10).
    let partial_leaf = format!("{}{FINAL_PARTIAL_SUFFIX}", result.backup_id);
    std::fs::rename(root.join(&leaf), root.join(&partial_leaf)).unwrap();
    let out = verify(&publisher, &partial_leaf);
    assert_eq!(
        (out.status.as_str(), out.codes.clone()),
        (
            "malformed",
            vec!["backup-manifest-inconsistent".to_string()]
        )
    );
    std::fs::rename(root.join(&partial_leaf), root.join(&leaf)).unwrap();
    // A manifest whose backupId names another backup.
    let other_leaf = format!("20260101T000000Z-{}{FINAL_COMPLETE_SUFFIX}", "f".repeat(16));
    std::fs::rename(root.join(&leaf), root.join(&other_leaf)).unwrap();
    let out = verify(&publisher, &other_leaf);
    assert_eq!(out.codes, vec!["backup-manifest-inconsistent".to_string()]);
    std::fs::rename(root.join(&other_leaf), root.join(&leaf)).unwrap();
    // Missing manifest; then restored.
    std::fs::remove_file(&manifest_path).unwrap();
    expect("malformed", "backup-manifest-invalid");
    std::fs::write(&manifest_path, &pristine).unwrap();
    assert_eq!(verify(&publisher, &leaf).status, "valid-complete");
}

#[test]
fn verify_backup_re_verifies_every_package_from_stored_bytes() {
    let (publisher, root, result) = complete_run("verify-packages");
    let leaf = result.backup_leaf.clone().unwrap();
    let packages = root.join(&leaf).join("packages");
    let zero_leaf = expected_leaf(&zero_asset_v3());
    // A foreign entry beside the packages.
    std::fs::write(packages.join("stray.txt"), b"x").unwrap();
    let out = verify(&publisher, &leaf);
    assert_eq!(
        (out.status.as_str(), out.codes.clone()),
        ("malformed", vec!["backup-set-foreign-entry".to_string()])
    );
    std::fs::remove_file(packages.join("stray.txt")).unwrap();
    // A package whose stored bytes no longer match its manifest.
    let snapshot_path = packages.join(&zero_leaf).join("snapshot.json");
    let good = std::fs::read(&snapshot_path).unwrap();
    let mut bad = good.clone();
    bad[5] ^= 0x01;
    std::fs::write(&snapshot_path, &bad).unwrap();
    let out = verify(&publisher, &leaf);
    assert_eq!(
        (out.status.as_str(), out.codes.clone()),
        (
            "malformed",
            vec!["backup-set-package-unverified".to_string()]
        )
    );
    std::fs::write(&snapshot_path, &good).unwrap();
    // A package removed: the manifest names an occupant that is not there.
    let moved = root.join("moved-aside");
    std::fs::rename(packages.join(&zero_leaf), &moved).unwrap();
    let out = verify(&publisher, &leaf);
    assert_eq!(
        (out.status.as_str(), out.codes.clone()),
        (
            "malformed",
            vec!["backup-set-cross-check-failed".to_string()]
        )
    );
    assert_eq!(out.occupants_seen, 1);
    std::fs::rename(&moved, packages.join(&zero_leaf)).unwrap();
    // A symlink standing where a package belongs is unreadable to the verifier.
    std::fs::rename(packages.join(&zero_leaf), &moved).unwrap();
    std::os::unix::fs::symlink(&moved, packages.join(&zero_leaf)).unwrap();
    let out = verify(&publisher, &leaf);
    assert_eq!(out.codes, vec!["backup-set-package-unverified".to_string()]);
    std::fs::remove_file(packages.join(&zero_leaf)).unwrap();
    std::fs::rename(&moved, packages.join(&zero_leaf)).unwrap();
    assert_eq!(verify(&publisher, &leaf).status, "valid-complete");
}

// ── N. LIST ────────────────────────────────────────────────────────────────

#[test]
fn list_classifies_by_shape_only_and_never_removes_residue() {
    let (publisher, root, result) = complete_run("list");
    let complete_leaf = result.backup_leaf.clone().unwrap();
    let partial_leaf = format!("20260101T000000Z-{}{FINAL_PARTIAL_SUFFIX}", "a".repeat(16));
    std::fs::create_dir(root.join(&partial_leaf)).unwrap();
    let residue = format!("{RUN_STAGING_PREFIX}{}", "b".repeat(32));
    std::fs::create_dir_all(root.join(&residue).join("packages")).unwrap();
    let residue_file = format!(
        "{MANIFEST_STAGING_PREFIX}{}{MANIFEST_STAGING_SUFFIX}",
        "c".repeat(32)
    );
    std::fs::write(root.join(&residue_file), b"stale").unwrap();
    std::fs::write(root.join("notes.txt"), b"foreign").unwrap();
    let file_shaped = "20260101T000000Z-0000000000000000.h2obackup";
    std::fs::write(root.join(file_shaped), b"a file, not a backup").unwrap();
    let before = tree_digest(&root);
    let listed = list(&publisher);
    assert!(listed.ok && listed.root_present);
    assert_eq!(listed.status, "listed");
    assert_eq!(listed.root_display_path, root.to_string_lossy());
    let kinds: Vec<(String, String)> = listed
        .entries
        .iter()
        .map(|e| (e.leaf.clone(), e.kind.clone()))
        .collect();
    let mut expected = vec![
        (complete_leaf.clone(), "backup".to_string()),
        (partial_leaf.clone(), "backup-partial".to_string()),
        (residue.clone(), "staging-residue".to_string()),
        (residue_file.clone(), "staging-residue".to_string()),
        ("notes.txt".to_string(), "foreign".to_string()),
        (file_shaped.to_string(), "foreign".to_string()),
    ];
    expected.sort();
    assert_eq!(kinds, expected);
    let complete_entry = listed
        .entries
        .iter()
        .find(|e| e.leaf == complete_leaf)
        .unwrap();
    assert_eq!(
        complete_entry.backup_id.as_deref(),
        Some(result.backup_id.as_str())
    );
    assert_eq!(complete_entry.manifest_present, Some(true));
    let partial_entry = listed
        .entries
        .iter()
        .find(|e| e.leaf == partial_leaf)
        .unwrap();
    assert_eq!(partial_entry.manifest_present, Some(false));
    assert_eq!(listed.residue_count, 2);
    assert_eq!(
        listed.codes,
        vec!["backup-staging-residue-detected".to_string()]
    );
    // Residue is never removed: not by LIST, not by the next BEGIN.
    assert_eq!(tree_digest(&root), before);
    let zero = zero_asset_v3();
    let (chat, snap) = pair_of(&zero);
    let (token, _) = begin_ok(&publisher, &[(&chat, &snap)]);
    assert!(abort(&publisher, token).ok);
    assert_eq!(tree_digest(&root), before);
}

// ── O. platform, registration and composition tripwires ────────────────────

#[test]
fn the_platform_arm_is_compile_time_and_macos_is_the_only_supported_family() {
    assert_eq!(PLATFORM_FAMILY, Some("macos"));
    assert!(cfg!(target_os = "macos"));
    assert_eq!(MAX_ACTIVE_BACKUP_SESSIONS, 1);
    assert_eq!(
        SESSION_IDLE_TIMEOUT,
        crate::archive_generation_publish::SESSION_IDLE_TIMEOUT
    );
    assert_eq!(
        CHUNK_CAP_BYTES,
        crate::archive_generation_publish::CHUNK_CAP_BYTES
    );
}

#[test]
fn commands_are_registered_in_both_handler_arms_and_the_state_is_managed_once() {
    let lib = include_str!("../lib.rs");
    for command in [
        "h2o_saved_chat_backup_begin",
        "h2o_saved_chat_backup_package_begin",
        "h2o_saved_chat_backup_write_member",
        "h2o_saved_chat_backup_package_finish",
        "h2o_saved_chat_backup_package_abort",
        "h2o_saved_chat_backup_finalize",
        "h2o_saved_chat_backup_abort",
        "h2o_saved_chat_backup_list",
        "h2o_saved_chat_backup_verify",
    ] {
        assert_eq!(
            lib.matches(&format!("saved_chat_local_backup::{command}"))
                .count(),
            2,
            "{command} is registered in BOTH invoke-handler variants"
        );
    }
    assert_eq!(
        lib.matches(".manage(saved_chat_local_backup::BackupState::default())")
            .count(),
        1
    );
    assert!(lib.contains("pub mod saved_chat_local_backup;"));
    assert!(lib.contains("pub mod saved_chat_backup_root_policy;"));
}

#[test]
fn source_tripwires_pin_composition_and_the_source_non_mutation_rule() {
    let source = include_str!("../saved_chat_local_backup.rs");
    let code: String = source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    // Composed authorities (§12), consumed as they exist on main.
    for required in [
        "verify_occupant_all_supported(packages, &stage_name)",
        "crate::archive_package_scan::scan_packages_within(&run_path)",
        "scan_packages_within(&publisher.root.join(leaf))",
        "generation_basename(&chat_id, &recomputed_hex)",
        "normalize_expected_sha(expected_content_hash)",
        "normalize_expected_sha(&verified.content_hash)",
        "validated_chat_id(&pair.chat_id)",
        "promote_dir_exclusive(&stage_name, leaf.as_bytes())",
        "promote_dir_exclusive(&run_name, leaf.as_bytes())",
        "promote_exclusive(&temp_name, BACKUP_MANIFEST_NAME.as_bytes())",
        "confined::Dir::open_root(&publisher.root)",
        "confined::Dir::open_existing_nofollow(&publisher.root)",
        "libc::fstat(fd, &mut st)",
        "sync_file_contents(file)",
        "random_token_seed()",
        "ipc_token::deserialize",
    ] {
        assert!(code.contains(required), "must compose {required}");
    }
    // The single direct syscall is the read-only fstat (§12): no mutating
    // syscall wrapper, no pathname-based std::fs mutation, no archive/CAS/DB.
    for forbidden in [
        "libc::open(",
        "libc::openat(",
        "libc::rename",
        "libc::unlink",
        "libc::mkdir",
        "libc::link",
        "libc::symlink",
        "libc::fsync",
        "std::fs::remove",
        "std::fs::rename",
        "std::fs::create_dir",
        "std::fs::write",
        "std::fs::File::create",
        "rename_within",
        "archive_root(",
        "app_local_data_dir",
        "archive_instance_lock",
        "archive_reclaim",
        "archive_occupant_quarantine",
        "archive_cas_scan",
        "archive_transport_handoff",
        "sqlx",
        "plugin:sql",
        "plugin:fs",
        "h2o_archive_",
        "RESERVED_COMPONENT_PREFIXES",
        "std::env::var",
    ] {
        assert!(!code.contains(forbidden), "must not reference {forbidden}");
    }
    // The read-only paths hold no write primitive in scope (also proven
    // behaviourally above through the tree digest).
    let verify_start = code.find("pub fn verify(").unwrap();
    let verify_end = code[verify_start..]
        .find("pub struct BackupState(")
        .unwrap()
        + verify_start;
    let list_start = code.find("pub fn list(").unwrap();
    let list_end = code[list_start..]
        .find("fn read_manifest_bounded(")
        .unwrap()
        + list_start;
    for (label, body) in [
        ("verify", &code[verify_start..verify_end]),
        ("list", &code[list_start..list_end]),
    ] {
        for forbidden in [
            "create_new_child",
            "mkdir_child",
            "promote_",
            "unlink_child",
            "write_all",
            ".sync()",
        ] {
            assert!(!body.contains(forbidden), "{label} must not {forbidden}");
        }
    }
}
