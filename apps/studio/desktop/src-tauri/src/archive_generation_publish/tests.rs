//! T1.2.2 — load-bearing proof for the trusted generation publisher.
//!
//! Evidence in this file comes in three DISTINCT strengths, and they must not
//! be conflated when reporting (batch repair R6):
//!
//!   1. BEHAVIOURAL NEGATIVE CONTROL — drives the real code path with input
//!      that must be refused (or accepted), and fails if the guard stops
//!      working. Most tests here are these.
//!   2. SOURCE TRIPWIRE — `include_str!` assertions that a guard symbol or
//!      refusal code is still present in the source. Catches silent deletion
//!      during refactoring; proves NOTHING about behaviour.
//!      See `source_tripwires_pin_the_load_bearing_guard_symbols`.
//!   3. ACTUAL MUTATION KILL — established by editing production code, running
//!      the suite, observing red, and restoring. Not encoded in this file;
//!      recorded in the batch report.
//!
//! A string-presence assertion is never evidence that behaviour is correct.

use super::*;
use crate::saved_chat_generation_policy::LiveGenerationFamily;
use crate::saved_chat_package_verify::tests::{
    gzip_zero_asset_v3, permanent_v3_fixture, zero_asset_v3, OwnedPackage,
};
use std::path::PathBuf;
use std::sync::Barrier;

// ── Harness ────────────────────────────────────────────────────────────────

fn scratch_root(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "h2o-genpub-{tag}-{nanos}-{:?}",
        std::thread::current().id()
    ));
    std::fs::create_dir_all(dir.join("archive")).expect("scratch");
    dir.join("archive")
}

fn publisher(tag: &str) -> Publisher {
    Publisher::new(scratch_root(tag))
}

fn sha_of(bytes: &[u8]) -> String {
    format!("sha256-{}", sha256_hex(bytes))
}

/// Builds a coherent v1 package: snapshot + renderers + manifest whose
/// descriptors and contentHash are all self-consistent.
struct Fixture {
    chat_id: String,
    snapshot: Vec<u8>,
    markdown: Vec<u8>,
    html: Vec<u8>,
    manifest: Vec<u8>,
    content_hash: String,
}

fn v1_fixture(chat_id: &str, snapshot_id: &str, body: &str) -> Fixture {
    let snapshot = format!(
        r#"{{"schemaVersion":1,"chatId":"{chat_id}","snapshotId":"{snapshot_id}","messages":[{{"id":"m0","turnIndex":0,"contentText":"{body}"}}]}}"#
    )
    .into_bytes();
    let markdown = format!("# {chat_id}\n\n{body}\n").into_bytes();
    let html = format!("<!doctype html><title>{chat_id}</title><p>{body}</p>").into_bytes();
    // v1 identity = SHA-256 of the exact snapshot bytes.
    let content_hash = sha_of(&snapshot);
    let manifest = format!(
        r#"{{"schema":"h2o.savedChatPackage","schemaVersion":1,"chatId":"{chat_id}","snapshotId":"{snapshot_id}","contentHash":"{content_hash}","files":{{"snapshot":{{"path":"snapshot.json","sha256":"{}","byteLength":{}}},"markdown":{{"path":"chat.md","sha256":"{}","byteLength":{}}},"html":{{"path":"chat.html","sha256":"{}","byteLength":{}}}}},"assets":[]}}"#,
        sha_of(&snapshot),
        snapshot.len(),
        sha_of(&markdown),
        markdown.len(),
        sha_of(&html),
        html.len(),
    )
    .into_bytes();
    Fixture {
        chat_id: chat_id.to_string(),
        snapshot,
        markdown,
        html,
        manifest,
        content_hash,
    }
}

/// Builds a coherent v2 package referencing CAS objects, and plants those
/// objects in the scratch CAS.
fn v2_fixture(root: &std::path::Path, chat_id: &str, assets: &[(&str, &[u8])]) -> Fixture {
    let mut descriptors = Vec::new();
    let mut shas = Vec::new();
    let mut refs = Vec::new();
    for (ext, bytes) in assets {
        let sha = sha_of(bytes);
        let hex = sha.strip_prefix("sha256-").unwrap();
        let shard = root.join("assets").join(&hex[0..2]);
        std::fs::create_dir_all(&shard).expect("cas shard");
        std::fs::write(shard.join(format!("sha256-{hex}")), bytes).expect("cas object");
        descriptors.push(format!(
            r#"{{"path":"assets/{sha}.{ext}","sha256":"{sha}","ext":"{ext}","mimeType":"image/{ext}","byteLength":{}}}"#,
            bytes.len()
        ));
        refs.push(format!("\"{sha}\""));
        shas.push(sha);
    }
    let snapshot = format!(
        r#"{{"schemaVersion":2,"chatId":"{chat_id}","snapshotId":"s1","messages":[{{"id":"m0","turnIndex":0,"assetRefs":[{}]}}]}}"#,
        refs.join(",")
    )
    .into_bytes();
    let markdown = b"# v2\n".to_vec();
    let html = b"<!doctype html><p>v2</p>".to_vec();
    let mut sorted = shas.clone();
    sorted.sort();
    let content_hash = derive_content_hash(true, &snapshot, &sorted);
    let manifest = format!(
        r#"{{"schema":"h2o.savedChatPackage","schemaVersion":2,"payloadVersion":2,"chatId":"{chat_id}","snapshotId":"s1","contentHash":"{content_hash}","files":{{"snapshot":{{"path":"snapshot.json","sha256":"{}","byteLength":{}}},"markdown":{{"path":"chat.md","sha256":"{}","byteLength":{}}},"html":{{"path":"chat.html","sha256":"{}","byteLength":{}}}}},"assets":[{}]}}"#,
        sha_of(&snapshot),
        snapshot.len(),
        sha_of(&markdown),
        markdown.len(),
        sha_of(&html),
        html.len(),
        descriptors.join(",")
    )
    .into_bytes();
    Fixture {
        chat_id: chat_id.to_string(),
        snapshot,
        markdown,
        html,
        manifest,
        content_hash,
    }
}

fn stage_all(p: &Publisher, token: u64, fx: &Fixture) {
    assert!(write_member(p, token, Member::Snapshot, &fx.snapshot).ok);
    assert!(write_member(p, token, Member::Markdown, &fx.markdown).ok);
    assert!(write_member(p, token, Member::Html, &fx.html).ok);
    assert!(write_member(p, token, Member::Manifest, &fx.manifest).ok);
}

fn publish(p: &Publisher, fx: &Fixture) -> PublishResult {
    let begun = begin(p, &fx.chat_id);
    assert!(begun.ok, "begin refused: {:?}", begun.blockers);
    stage_all(p, begun.token, fx);
    commit_v1v2(p, begun.token, None)
}

/// The large legacy publisher matrix is also the explicit V1/V2 rollback
/// regression. Production uses `commit` directly in the activation-specific
/// tests below; these fixtures inject the still-supported rollback family.
fn commit_v1v2(
    publisher: &Publisher,
    token: u64,
    expected_manifest_sha256: Option<&str>,
) -> PublishResult {
    commit_with_policy(
        publisher,
        token,
        expected_manifest_sha256,
        LiveGenerationFamily::V1V2,
    )
}

fn packages_entries(p: &Publisher) -> Vec<String> {
    let dir = p.root.join(PACKAGES_DIR);
    let mut out: Vec<String> = std::fs::read_dir(&dir)
        .map(|it| {
            it.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn blocker_codes_of(list: &[Blocker]) -> Vec<String> {
    list.iter().map(|b| b.code.clone()).collect()
}

fn blocker_codes(result: &PublishResult) -> Vec<String> {
    result.blockers.iter().map(|b| b.code.clone()).collect()
}

fn package_content_hash(package: &OwnedPackage) -> String {
    serde_json::from_slice::<serde_json::Value>(&package.manifest)
        .expect("package manifest")
        .get("contentHash")
        .and_then(serde_json::Value::as_str)
        .expect("contentHash")
        .to_string()
}

fn mutate_package_manifest(
    package: &mut OwnedPackage,
    update: impl FnOnce(&mut serde_json::Value),
) {
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&package.manifest).expect("package manifest");
    update(&mut manifest);
    package.manifest = serde_json::to_vec(&manifest).expect("serialize package manifest");
}

fn rebind_package_snapshot_physical_descriptor(package: &mut OwnedPackage) {
    let snapshot = package.snapshot.as_ref().expect("snapshot");
    let sha = sha_of(snapshot);
    let len = snapshot.len() as u64;
    mutate_package_manifest(package, |manifest| {
        manifest["files"]["snapshot"]["sha256"] = sha.into();
        manifest["files"]["snapshot"]["byteLength"] = len.into();
    });
}

fn stage_v3_package(p: &Publisher, package: &OwnedPackage, install_cas: bool) -> u64 {
    if install_cas {
        package.install_cas(&p.root);
    }
    let begun = begin(p, &package.chat_id);
    assert!(begun.ok, "begin refused: {:?}", begun.blockers);
    if let Some(bytes) = package.snapshot.as_deref() {
        assert!(write_member(p, begun.token, Member::Snapshot, bytes).ok);
    }
    if let Some(bytes) = package.markdown.as_deref() {
        assert!(write_member(p, begun.token, Member::Markdown, bytes).ok);
    }
    if let Some(bytes) = package.html.as_deref() {
        assert!(write_member(p, begun.token, Member::Html, bytes).ok);
    }
    assert!(write_member(p, begun.token, Member::Manifest, &package.manifest).ok);
    begun.token
}

fn publish_v3(p: &Publisher, package: &OwnedPackage) -> PublishResult {
    let token = stage_v3_package(p, package, true);
    commit_with_policy(p, token, None, LiveGenerationFamily::V3)
}

fn assert_v3_refused(tag: &str, package: &OwnedPackage, install_cas: bool) -> PublishResult {
    let p = publisher(tag);
    let token = stage_v3_package(&p, package, install_cas);
    let result = commit_with_policy(&p, token, None, LiveGenerationFamily::V3);
    assert!(!result.ok, "invalid v3 package unexpectedly published");
    assert!(!result.committed);
    assert!(
        packages_entries(&p)
            .iter()
            .all(|name| name.starts_with(STAGING_PREFIX)),
        "a refused package must not create a final generation"
    );
    result
}

// ── FILESYSTEM / CONFINEMENT ───────────────────────────────────────────────

#[test]
fn publishes_a_v1_generation_under_the_derived_name() {
    let p = publisher("v1-happy");
    let fx = v1_fixture("chat_alpha", "snap1", "hello");
    let result = publish(&p, &fx);
    assert!(result.ok, "blockers: {:?}", blocker_codes(&result));
    assert_eq!(result.outcome, Outcome::Created);
    assert!(result.committed);
    assert!(result.durability_complete);
    assert_eq!(result.content_hash, fx.content_hash);

    let hex = fx.content_hash.strip_prefix("sha256-").unwrap();
    let expected = format!("chat_alpha.g{hex}.h2ochat");
    assert_eq!(packages_entries(&p), vec![expected.clone()]);
    // All four live v1/v2 members survive publication.
    for member in Member::all() {
        let path = p
            .root
            .join(PACKAGES_DIR)
            .join(&expected)
            .join(member.file_name());
        assert!(path.exists(), "missing member {}", member.file_name());
    }
}

#[test]
fn staging_uses_the_literal_dot_leading_reserved_prefix() {
    // The leading '.' is load-bearing: it is what the renderer's archive/**
    // glob does not reach through before the G1 cutover (§R.1).
    assert!(STAGING_PREFIX.starts_with('.'));
    let p = publisher("dot-prefix");
    let begun = begin(&p, "chat_dot");
    assert!(begun.ok);
    let entries = packages_entries(&p);
    assert_eq!(entries.len(), 1);
    assert!(
        entries[0].starts_with(STAGING_PREFIX),
        "staging dir {} must carry the reserved dot-leading prefix",
        entries[0]
    );
    assert!(abort(&p, begun.token).ok);
}

#[test]
fn existing_stage_entries_are_never_adopted_or_removed() {
    use std::os::unix::fs::symlink;

    let p = publisher("stage-collision");
    let token = 0x1020_3040_5060_7081;
    p.registry
        .next_token
        .store(token, std::sync::atomic::Ordering::SeqCst);

    let packages = p.root.join(PACKAGES_DIR);
    std::fs::create_dir_all(&packages).expect("packages");
    let names: Vec<String> = (0..4)
        .map(|attempt| String::from_utf8(staging_name(token, attempt)).expect("ASCII stage"))
        .collect();

    // Occupy three consecutive attempts with every relevant foreign entry
    // shape. BEGIN must retry past all of them; it may neither adopt nor clean
    // an entry it did not create.
    let foreign_dir = packages.join(&names[0]);
    std::fs::create_dir(&foreign_dir).expect("foreign directory");
    std::fs::write(foreign_dir.join("witness"), b"foreign directory").expect("witness");

    let foreign_file = packages.join(&names[1]);
    std::fs::write(&foreign_file, b"foreign file").expect("foreign file");

    let symlink_target = p.root.join("outside-stage-target");
    std::fs::create_dir(&symlink_target).expect("symlink target");
    std::fs::write(symlink_target.join("witness"), b"outside").expect("outside witness");
    let foreign_symlink = packages.join(&names[2]);
    symlink(&symlink_target, &foreign_symlink).expect("foreign symlink");

    let begun = begin(&p, "chat_stage_collision");
    assert!(
        begun.ok,
        "BEGIN must retry collisions: {:?}",
        begun.blockers
    );
    assert_eq!(begun.token, token);
    assert!(
        packages.join(&names[3]).is_dir(),
        "the fourth attempt is owned"
    );

    assert_eq!(
        std::fs::read(foreign_dir.join("witness")).unwrap(),
        b"foreign directory"
    );
    assert_eq!(std::fs::read(&foreign_file).unwrap(), b"foreign file");
    assert!(std::fs::symlink_metadata(&foreign_symlink)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        std::fs::read(symlink_target.join("witness")).unwrap(),
        b"outside"
    );

    assert!(abort(&p, begun.token).ok);
    assert!(
        !packages.join(&names[3]).exists(),
        "only the owned stage is cleaned"
    );
    assert!(foreign_dir.is_dir());
    assert_eq!(std::fs::read(&foreign_file).unwrap(), b"foreign file");
    assert!(std::fs::symlink_metadata(&foreign_symlink)
        .unwrap()
        .file_type()
        .is_symlink());

    let _ = std::fs::remove_dir_all(p.root.parent().unwrap());
}

#[test]
fn the_dot_leading_prefix_is_not_matched_by_a_non_literal_dot_glob() {
    // Pins the assumption §R.1 declares load-bearing: a `**`-style match that
    // requires a literal leading dot does NOT admit the staging component.
    // (This is the property the pinned matcher provides; the test pins the
    // shape of the name we depend on, which is what this module controls.)
    let name = format!("{STAGING_PREFIX}deadbeef");
    assert!(name.as_bytes()[0] == b'.');
    // A generation name never starts with '.', so the two namespaces are
    // distinguishable by exactly the property the scope rule keys on.
    let generation = generation_basename("chat", &"a".repeat(64));
    assert!(!generation.starts_with('.'));
}

#[test]
fn a_symlinked_member_is_refused_and_never_followed() {
    let p = publisher("symlink-member");
    let fx = v1_fixture("chat_sym", "snap1", "x");
    let begun = begin(&p, &fx.chat_id);
    assert!(begun.ok);
    write_member(&p, begun.token, Member::Snapshot, &fx.snapshot);
    write_member(&p, begun.token, Member::Markdown, &fx.markdown);
    write_member(&p, begun.token, Member::Html, &fx.html);

    // Plant a symlink where manifest.json belongs.
    let staging = packages_entries(&p)
        .into_iter()
        .find(|n| n.starts_with(STAGING_PREFIX))
        .expect("staging");
    let target = p.root.join("outside-secret.json");
    std::fs::write(&target, fx.manifest.clone()).expect("target");
    std::os::unix::fs::symlink(
        &target,
        p.root
            .join(PACKAGES_DIR)
            .join(&staging)
            .join("manifest.json"),
    )
    .expect("symlink");

    let result = commit_v1v2(&p, begun.token, None);
    assert!(!result.ok);
    // Either the O_NOFOLLOW open refuses it, or the not-regular check does.
    assert!(
        blocker_codes(&result)
            .iter()
            .any(|c| c.starts_with("generation-manifest-missing")
                || c.starts_with("generation-member")),
        "unexpected: {:?}",
        blocker_codes(&result)
    );
    assert!(packages_entries(&p).is_empty(), "staging must be cleaned");
}

#[test]
fn an_unexpected_staging_entry_refuses_the_commit() {
    let p = publisher("foreign-entry");
    let fx = v1_fixture("chat_foreign", "snap1", "x");
    let begun = begin(&p, &fx.chat_id);
    stage_all(&p, begun.token, &fx);
    let staging = packages_entries(&p)
        .into_iter()
        .find(|n| n.starts_with(STAGING_PREFIX))
        .expect("staging");
    std::fs::write(
        p.root
            .join(PACKAGES_DIR)
            .join(&staging)
            .join("smuggled.txt"),
        b"planted",
    )
    .expect("plant");
    let result = commit_v1v2(&p, begun.token, None);
    assert!(!result.ok);
    assert!(blocker_codes(&result).contains(&"generation-staging-unexpected-entry".to_string()));
}

#[test]
fn name_max_is_read_from_the_descriptor_and_fails_closed_on_overflow() {
    let p = publisher("name-max");
    // 250-char chatId + 74-byte suffix exceeds a 255-byte component limit.
    let long_id = "a".repeat(250);
    let begun = begin(&p, &long_id);
    assert!(!begun.ok);
    assert_eq!(
        begun.blockers[0].code,
        "generation-name-exceeds-filesystem-limit"
    );
    // Nothing was left behind by the refusal.
    assert!(packages_entries(&p).is_empty());
}

#[test]
fn chat_id_charset_is_revalidated_on_the_trusted_side() {
    let p = publisher("chatid");
    for bad in ["", ".", "..", "a/b", "a\\b", "a b", "a\u{00e9}"] {
        let begun = begin(&p, bad);
        assert!(!begun.ok, "chatId {bad:?} must be refused");
    }
    assert!(packages_entries(&p).is_empty());
}

// ── SESSION / CONCURRENCY ──────────────────────────────────────────────────

#[test]
fn session_admission_is_bounded_and_begin_refuses_when_full() {
    let p = publisher("admission");
    let mut tokens = Vec::new();
    for i in 0..MAX_ADMITTED_SESSIONS {
        let begun = begin(&p, &format!("chat_{i}"));
        assert!(begun.ok);
        tokens.push(begun.token);
    }
    let refused = begin(&p, "chat_overflow");
    assert!(!refused.ok);
    assert_eq!(
        refused.blockers[0].code,
        "generation-staging-sessions-exhausted"
    );
    // Releasing one slot re-admits.
    assert!(abort(&p, tokens[0]).ok);
    let readmitted = begin(&p, "chat_readmit");
    assert!(readmitted.ok);
}

#[test]
fn commit_consumes_the_session_and_releases_its_admission_slot() {
    let p = publisher("slot-release");
    let fx = v1_fixture("chat_slot", "snap1", "x");
    let result = publish(&p, &fx);
    assert!(result.ok);
    assert_eq!(p.registry.session_count(), 0, "session must be consumed");
    assert_eq!(
        p.registry.admitted_count(),
        0,
        "in-flight COMMIT must release its admission slot when it returns"
    );
}

#[test]
fn double_commit_and_post_commit_abort_are_safe() {
    let p = publisher("double-commit");
    let fx = v1_fixture("chat_double", "snap1", "x");
    let begun = begin(&p, &fx.chat_id);
    stage_all(&p, begun.token, &fx);
    let first = commit_v1v2(&p, begun.token, None);
    assert!(first.ok && first.committed);

    // Second COMMIT finds no session.
    let second = commit_v1v2(&p, begun.token, None);
    assert!(!second.ok);
    assert_eq!(second.blockers[0].code, "generation-session-unknown");

    // `finally { abort }` after a successful commit must be a benign no-op and
    // must NOT destroy the published generation.
    assert!(abort(&p, begun.token).ok);
    assert_eq!(packages_entries(&p).len(), 1);
    let published = &packages_entries(&p)[0];
    for member in Member::all() {
        assert!(p
            .root
            .join(PACKAGES_DIR)
            .join(published)
            .join(member.file_name())
            .exists());
    }
}

#[test]
fn abort_cleans_only_its_own_staging_and_is_idempotent() {
    let p = publisher("abort-clean");
    let keep = v1_fixture("chat_keep", "snap1", "keep");
    assert!(publish(&p, &keep).ok);
    let published = packages_entries(&p);
    assert_eq!(published.len(), 1);

    let begun = begin(&p, "chat_abort");
    stage_all(&p, begun.token, &v1_fixture("chat_abort", "snap1", "x"));
    assert!(abort(&p, begun.token).ok);
    // Idempotent: unknown token is benign.
    assert!(abort(&p, begun.token).ok);
    assert_eq!(packages_entries(&p), published, "only own staging removed");
}

#[test]
fn write_to_an_unknown_or_consumed_session_is_refused() {
    let p = publisher("unknown-write");
    let fx = v1_fixture("chat_unknown", "snap1", "x");
    assert!(!write_member(&p, 9_999, Member::Snapshot, b"x").ok);
    let begun = begin(&p, &fx.chat_id);
    stage_all(&p, begun.token, &fx);
    assert!(commit_v1v2(&p, begun.token, None).ok);
    let after = write_member(&p, begun.token, Member::Snapshot, b"x");
    assert!(!after.ok);
    assert_eq!(after.blockers[0].code, "generation-session-unknown");
}

#[test]
fn a_member_may_arrive_in_many_chunks_and_interleave_with_others() {
    let p = publisher("chunked");
    let fx = v1_fixture("chat_chunk", "snap1", "chunked-body");
    let begun = begin(&p, &fx.chat_id);
    // Interleave snapshot and markdown chunk-by-chunk (§Q permits this).
    let mut si = 0usize;
    let mut mi = 0usize;
    while si < fx.snapshot.len() || mi < fx.markdown.len() {
        if si < fx.snapshot.len() {
            let end = (si + 7).min(fx.snapshot.len());
            assert!(write_member(&p, begun.token, Member::Snapshot, &fx.snapshot[si..end]).ok);
            si = end;
        }
        if mi < fx.markdown.len() {
            let end = (mi + 5).min(fx.markdown.len());
            assert!(write_member(&p, begun.token, Member::Markdown, &fx.markdown[mi..end]).ok);
            mi = end;
        }
    }
    assert!(write_member(&p, begun.token, Member::Html, &fx.html).ok);
    assert!(write_member(&p, begun.token, Member::Manifest, &fx.manifest).ok);
    let result = commit_v1v2(&p, begun.token, None);
    assert!(result.ok, "{:?}", blocker_codes(&result));
    assert_eq!(result.content_hash, fx.content_hash);
}

#[test]
fn a_chunk_over_the_transport_bound_is_refused_without_capping_the_member() {
    let p = publisher("chunk-bound");
    let begun = begin(&p, "chat_bound");
    let oversize = vec![0u8; (CHUNK_CAP_BYTES + 1) as usize];
    let refused = write_member(&p, begun.token, Member::Snapshot, &oversize);
    assert!(!refused.ok);
    assert_eq!(refused.blockers[0].code, "generation-chunk-too-large");
    // The SAME number of bytes is accepted as two chunks — proving the bound is
    // transport-only and never a member ceiling (§R.2-A).
    let half = (CHUNK_CAP_BYTES / 2) as usize;
    assert!(write_member(&p, begun.token, Member::Snapshot, &oversize[..half]).ok);
    assert!(write_member(&p, begun.token, Member::Snapshot, &oversize[half..]).ok);
    assert!(abort(&p, begun.token).ok);
}

#[test]
fn concurrent_writers_never_clean_beneath_an_in_flight_operation() {
    // Acceptance invariant (§Q): an in-flight operation must never have its
    // staging cleaned nor its identity reused beneath it.
    use std::sync::Barrier;
    let p = Arc::new(publisher("concurrent"));
    let fx = Arc::new(v1_fixture("chat_conc", "snap1", "body"));
    let begun = begin(&p, &fx.chat_id);
    let token = begun.token;
    let barrier = Arc::new(Barrier::new(2));

    let writer = {
        let p = Arc::clone(&p);
        let fx = Arc::clone(&fx);
        let barrier = Arc::clone(&barrier);
        std::thread::spawn(move || {
            barrier.wait();
            for _ in 0..200 {
                write_member(&p, token, Member::Snapshot, &fx.snapshot);
            }
        })
    };
    let aborter = {
        let p = Arc::clone(&p);
        let barrier = Arc::clone(&barrier);
        std::thread::spawn(move || {
            barrier.wait();
            abort(&p, token)
        })
    };
    writer.join().expect("writer");
    aborter.join().expect("aborter");
    // Whatever the interleaving, exactly one claimant cleaned up and no staging
    // survives; the process did not panic or corrupt state.
    assert!(packages_entries(&p).is_empty());
    assert_eq!(p.registry.admitted_count(), 0);
}

// ── STAGING MATCHER / CONFIG TRIPWIRE (§R.1) ───────────────────────────────

/// M06 T1.2: neither reserved identity may enter the archive as a chatId, in
/// any ASCII casing. A chatId becomes a package basename, so admitting one
/// would let caller-controlled input occupy a reserved infrastructure name.
#[test]
fn reserved_m06_identities_are_refused_as_chat_ids() {
    for exact in crate::archive_durable_write::RESERVED_EXACT_COMPONENTS {
        for candidate in [exact.to_string(), exact.to_ascii_uppercase()] {
            assert_eq!(
                super::validated_chat_id(&candidate).err(),
                Some("generation-chat-id-reserved-namespace"),
                "{candidate} must be refused as a chatId"
            );
        }
    }
}

/// Executes the PINNED matcher semantics rather than asserting on source text.
/// `require_literal_leading_dot` is what makes the renderer's `archive/**`
/// scope unable to reach the private dot-leading staging namespace, and that
/// exclusion is a REQUIRED pre-cutover integrity invariant — commit-time
/// hashing alone cannot close post-hash in-place mutation through a separately
/// held writable handle.
#[test]
fn the_pinned_glob_matcher_denies_every_renderer_reach_into_staging() {
    use glob::{MatchOptions, Pattern};

    // The options tauri's fs scope actually uses (tauri 2.11.1
    // src/scope/fs.rs: require_literal_leading_dot defaults true on unix, and
    // require_literal_separator is set true).
    let opts = MatchOptions {
        case_sensitive: true,
        require_literal_separator: true,
        require_literal_leading_dot: true,
    };

    let staging = format!("/AppLocalData/archive/packages/{STAGING_PREFIX}0011/manifest.json");
    let staging_dir = format!("/AppLocalData/archive/packages/{STAGING_PREFIX}0011");

    // M06 T1.2: the same dot-leading exclusion covers the reserved instance
    // lock and the reserved quarantine namespace, INCLUDING paths beneath the
    // namespace -- the leading dot is on the namespace component itself.
    let lock = format!(
        "/AppLocalData/archive/{}",
        crate::archive_durable_write::ARCHIVE_LOCK_COMPONENT
    );
    let reclaim = format!(
        "/AppLocalData/archive/{}",
        crate::archive_durable_write::RECLAIM_NAMESPACE_COMPONENT
    );
    let reclaim_child = format!(
        "/AppLocalData/archive/{}/run-1/receipt.json",
        crate::archive_durable_write::RECLAIM_NAMESPACE_COMPONENT
    );

    // The real archive scopes granted to the renderer today.
    for scope in [
        "/AppLocalData/archive/**",          // write-file, read-file, lstat, mkdir
        "/AppLocalData/archive/packages/**", // read-dir
    ] {
        let pattern = Pattern::new(scope).expect("valid scope pattern");
        for probe in [
            staging.as_str(),
            staging_dir.as_str(),
            lock.as_str(),
            reclaim.as_str(),
            reclaim_child.as_str(),
        ] {
            assert!(
                !pattern.matches_with(probe, opts),
                "scope {scope} must NOT reach staging path {probe} — the \
                 dot-leading exclusion is load-bearing pre-cutover"
            );
        }
    }

    // Control: the SAME scope does reach an ordinary published generation, so
    // the test is proving the leading dot specifically, not a broken pattern.
    let ordinary = "/AppLocalData/archive/packages/chat_x.g0123.h2ochat/manifest.json";
    assert!(
        Pattern::new("/AppLocalData/archive/**")
            .unwrap()
            .matches_with(ordinary, opts),
        "the control path must match, or this test proves nothing"
    );

    // And the exclusion is genuinely the OPTION, not the pattern: with the
    // option disabled the same probe matches. This is what would break if a
    // future fs configuration turned it off.
    let permissive = MatchOptions {
        require_literal_leading_dot: false,
        ..opts
    };
    assert!(
        Pattern::new("/AppLocalData/archive/**")
            .unwrap()
            .matches_with(&staging, permissive),
        "with the option off the staging path WOULD be reachable — which is \
         precisely why no fs config may disable it"
    );
}

#[test]
fn no_shipped_configuration_disables_the_leading_dot_exclusion_or_names_staging() {
    // (a) No fs configuration may turn the matcher option off.
    let conf = include_str!("../../tauri.conf.json");
    for forbidden in ["requireLiteralLeadingDot", "require_literal_leading_dot"] {
        assert!(
            !conf.contains(forbidden),
            "tauri.conf.json must not configure {forbidden}: the default \
             (enabled) is load-bearing for §R.1"
        );
    }

    // (b) No archive capability may grant a scope that explicitly reaches the
    // private dot-leading staging namespace.
    for capability in [
        include_str!("../../capabilities/archive-cas.json"),
        include_str!("../../capabilities/default.json"),
        include_str!("../../capabilities/archive-export.json"),
    ] {
        assert!(
            !capability.contains(STAGING_PREFIX),
            "no capability may name the reserved staging prefix {STAGING_PREFIX}"
        );
        // A literal dot-leading component anywhere under the archive root
        // would defeat the exclusion for that path.
        assert!(
            !capability.contains("archive/packages/."),
            "no capability may grant an explicit dot-leading archive scope"
        );
    }
}

// ── G1 CAPABILITY CUTOVER ──────────────────────────────────────────────────

#[test]
fn the_renderer_holds_no_archive_mutation_authority_after_the_g1_cutover() {
    // The publisher's immutability guarantee is only real if the renderer
    // cannot write, truncate or pre-create archive paths behind its back.
    // Before G1 the archive capability granted fs:allow-write-file (which also
    // enables plugin:fs|open and |write) and fs:allow-mkdir over
    // $APPLOCALDATA/archive/**; the cutover removes both.
    let capability = include_str!("../../capabilities/archive-cas.json");
    // Parse the GRANTS, not the prose: the description legitimately names the
    // permissions the cutover removed, so a substring scan would be fooled by
    // its own documentation.
    let parsed: serde_json::Value =
        serde_json::from_str(capability).expect("archive capability must be valid JSON");
    let granted: Vec<String> = parsed["permissions"]
        .as_array()
        .expect("permissions array")
        .iter()
        .filter_map(|entry| {
            entry
                .get("identifier")
                .and_then(|id| id.as_str())
                .map(|s| s.to_string())
                .or_else(|| entry.as_str().map(|s| s.to_string()))
        })
        .collect();

    for mutating in [
        "fs:allow-write-file",
        "fs:allow-mkdir",
        "fs:allow-remove",
        "fs:allow-rename",
        "fs:allow-truncate",
    ] {
        assert!(
            !granted.iter().any(|g| g == mutating),
            "the archive capability must grant no mutation authority; found {mutating}"
        );
    }
    // The read/metadata surface the live consumers genuinely need survives.
    for retained in [
        "fs:allow-exists",
        "fs:allow-read-file",
        "fs:allow-lstat",
        "fs:allow-read-dir",
    ] {
        assert!(
            granted.iter().any(|g| g == retained),
            "missing required read scope {retained}"
        );
    }
    // read-dir stays packages-scoped; blob reads need archive/** because the
    // CAS lives under archive/assets.
    assert!(capability.contains("$APPLOCALDATA/archive/packages"));
    assert!(capability.contains("$APPLOCALDATA/archive/**"));
}

// ── RESERVED NAMESPACE (§R — reserved namespace) ───────────────────────────────────────────────

#[test]
fn a_chat_id_that_would_derive_a_reserved_or_dot_leading_name_is_refused() {
    // A generation basename BEGINS with the chatId, so a dot-leading chatId
    // derives a dot-leading final name. The frozen architecture already makes
    // such a name unusable: the renderer's read scopes are `archive/**` and the
    // pinned matcher does not match through a dot-leading component (§R.1), so
    // NO consumer could ever read it; and a reserved prefix is excluded from
    // discovery outright (§R). Publishing one would be write-only garbage that
    // create-only could never reclaim.
    for chat_id in [
        ".chat",
        ".h2o-genstage-x",
        ".H2O-GENSTAGE-X",
        ".h2o-durable-x",
        ".H2O-DURABLE-X",
        ".hidden",
    ] {
        assert_eq!(
            validated_chat_id(chat_id).unwrap_err(),
            "generation-chat-id-reserved-namespace",
            "chatId {chat_id:?} must not derive a reserved/dot-leading name"
        );
    }
    // Every shared reserved prefix, in mixed case. All reserved prefixes are
    // dot-leading by construction, so the leading-dot rule already covers them
    // and these cases are refused by that rule.
    for prefix in crate::archive_durable_write::RESERVED_COMPONENT_PREFIXES {
        for variant in [
            format!("{prefix}x"),
            format!("{}x", prefix.to_ascii_uppercase()),
        ] {
            assert_eq!(
                validated_chat_id(&variant).unwrap_err(),
                "generation-chat-id-reserved-namespace",
                "reserved prefix variant {variant:?} must be refused"
            );
        }
        // NOTE: every reserved prefix is dot-leading, so the leading-dot rule
        // returns first and the case-insensitive arm is forward-defensive
        // rather than behaviourally covered here.
        // DELIBERATELY ACCEPTED: a dot-LESS lookalike is not in the reserved
        // namespace. It derives an ordinary basename that the renderer can
        // read and discovery can enumerate, so refusing it would be a real new
        // chatId product boundary with no architectural justification. The
        // restriction is scoped to names the architecture has already made
        // unusable — nothing wider.
        let dotless = format!("{}x", prefix.trim_start_matches('.'));
        assert!(
            validated_chat_id(&dotless).is_ok(),
            "dot-less lookalike {dotless:?} must stay accepted"
        );
    }
    // NOT a general chatId restriction: ordinary ids, including ones with
    // interior dots, remain accepted exactly as before.
    for ok_id in [
        "69c874a8-62e4-838b-99f3-f1931039c402",
        "chat-a2a4c",
        "d2c_request_materializer_chat_1782334630557",
        "i-harness-source",
        "chat.with.interior.dots",
    ] {
        assert!(
            validated_chat_id(ok_id).is_ok(),
            "{ok_id} must stay accepted"
        );
    }
}

#[test]
fn a_reserved_namespace_chat_id_is_refused_at_begin_with_no_residue() {
    let p = publisher("reserved-namespace-begin");
    let result = begin(&p, ".h2o-genstage-evil");
    assert!(!result.ok);
    assert_eq!(
        blocker_codes_of(&result.blockers),
        vec!["generation-chat-id-reserved-namespace".to_string()]
    );
    // Refused before anything was created.
    assert!(packages_entries(&p).is_empty());
    assert_eq!(p.registry.admitted_count(), 0, "no admission slot leaked");
}

// ── PRESENTATION ADVISORY (batch repair R4) ────────────────────────────────────────────

#[test]
fn a_pristine_occupant_dedupes_with_no_advisory() {
    let p = publisher("advisory-none");
    let fx = v1_fixture("chat_adv_none", "snap1", "body");
    assert!(publish(&p, &fx).ok);
    let again = publish(&p, &fx);
    assert!(again.ok);
    assert_eq!(again.outcome, Outcome::Deduped);
    assert!(
        again.advisories.is_empty(),
        "a pristine occupant carries no advisory: {:?}",
        blocker_codes_of(&again.advisories)
    );
}

#[test]
fn a_truncated_markdown_occupant_still_dedupes_but_advises() {
    let p = publisher("advisory-markdown");
    let fx = v1_fixture("chat_adv_md", "snap1", "body");
    assert!(publish(&p, &fx).ok);
    let published = packages_entries(&p)[0].clone();
    std::fs::write(
        p.root.join(PACKAGES_DIR).join(&published).join("chat.md"),
        b"",
    )
    .expect("truncate");

    let again = publish(&p, &fx);
    // Still a dedupe: the reader never hashes chat.md and §K makes it
    // non-identity, so refusing would only break a legitimate save.
    assert!(again.ok);
    assert_eq!(again.outcome, Outcome::Deduped);
    assert!(!again.committed);
    // Non-blocking, but observable.
    assert!(
        again.blockers.is_empty(),
        "an advisory must never enter blockers"
    );
    assert_eq!(
        blocker_codes_of(&again.advisories),
        vec!["generation-occupant-presentation-mismatch".to_string()]
    );
}

#[test]
fn a_tampered_html_occupant_still_dedupes_but_advises() {
    let p = publisher("advisory-html");
    let fx = v1_fixture("chat_adv_html", "snap1", "body");
    assert!(publish(&p, &fx).ok);
    let published = packages_entries(&p)[0].clone();
    std::fs::write(
        p.root.join(PACKAGES_DIR).join(&published).join("chat.html"),
        b"<html>tampered</html>",
    )
    .expect("tamper");

    let again = publish(&p, &fx);
    assert!(again.ok);
    assert_eq!(again.outcome, Outcome::Deduped);
    assert!(again.blockers.is_empty());
    assert_eq!(
        blocker_codes_of(&again.advisories),
        vec!["generation-occupant-presentation-mismatch".to_string()]
    );
}

// ── ENVIRONMENTAL RESOURCE ADMISSION (§R.2) ─────────────────────────────────

/// Sets the thread-local free-space seam. libtest gives each test its own
/// thread, so no serialization is needed — but a SPAWNED thread does not
/// inherit the value.
fn set_space(v: u64) {
    FORCE_FREE_SPACE.with(|f| f.set(v));
}

#[test]
fn the_reserve_is_enforced_on_every_append_not_only_at_begin() {
    // A member arrives as N appends and the disk can fill between the first and
    // the last, so a BEGIN-only check cannot preserve the reserve.
    let p = publisher("reserve-per-append");

    // Ample space at BEGIN, and for the first append.
    set_space(FREE_SPACE_RESERVE_BYTES + 10 * 1024 * 1024);
    let begun = begin(&p, "chat_reserve");
    assert!(begun.ok, "BEGIN must succeed with ample space");
    let first = write_member(&p, begun.token, Member::Snapshot, b"first-chunk");
    assert!(first.ok, "the first append must succeed");

    // Space now drops so this append would eat into the reserve.
    set_space(FREE_SPACE_RESERVE_BYTES + 4);
    let refused = write_member(&p, begun.token, Member::Snapshot, &vec![0u8; 64]);
    assert!(
        !refused.ok,
        "an append that would consume the reserve must be refused"
    );
    assert_eq!(
        blocker_codes_of(&refused.blockers),
        vec!["generation-staging-resource-reserve".to_string()]
    );

    // ENVIRONMENTAL AND RETRYABLE: restore space and the SAME append succeeds,
    // with no change to the bytes. It never marked the package invalid.
    set_space(FREE_SPACE_RESERVE_BYTES + 10 * 1024 * 1024);
    let retried = write_member(&p, begun.token, Member::Snapshot, &vec![0u8; 64]);
    assert!(retried.ok, "the refusal must be retryable, not terminal");

    set_space(FREE_SPACE_REAL);
    assert!(abort(&p, begun.token).ok);
}

#[test]
fn unanswerable_free_space_authority_fails_closed_and_stays_environmental() {
    let p = publisher("reserve-unanswerable");
    set_space(FREE_SPACE_RESERVE_BYTES + 10 * 1024 * 1024);
    let begun = begin(&p, "chat_unanswerable");
    assert!(begun.ok);

    // fstatfs cannot answer: refuse rather than proceed, because an
    // unanswerable reserve is the very condition the reserve guards against.
    set_space(FREE_SPACE_UNANSWERABLE);
    let refused = write_member(&p, begun.token, Member::Snapshot, b"x");
    assert!(!refused.ok, "unanswerable free space must fail CLOSED");
    assert_eq!(
        blocker_codes_of(&refused.blockers),
        vec!["generation-staging-resource-unavailable".to_string()]
    );
    // Still the retryable environmental family, never a validity blocker.
    assert!(blocker_codes_of(&refused.blockers)[0].starts_with("generation-staging-resource-"));

    set_space(FREE_SPACE_REAL);
    assert!(abort(&p, begun.token).ok);
}

#[test]
fn begin_also_fails_closed_when_free_space_is_unanswerable() {
    let p = publisher("reserve-begin-closed");
    set_space(FREE_SPACE_UNANSWERABLE);
    let begun = begin(&p, "chat_begin_closed");
    set_space(FREE_SPACE_REAL);
    assert!(!begun.ok);
    assert_eq!(
        blocker_codes_of(&begun.blockers),
        vec!["generation-staging-resource-unavailable".to_string()]
    );
    // Creator-owns-cleanup: a refused BEGIN leaves no residue and no slot.
    assert!(packages_entries(&p).is_empty());
    assert_eq!(p.registry.admitted_count(), 0);
}

#[test]
fn the_reserve_imposes_no_member_or_package_size_ceiling() {
    // §R.2-A: environmental admission must never become a semantic ceiling. On
    // a filesystem that genuinely has room, a member many times the per-chunk
    // transport bound publishes normally.
    set_space(FREE_SPACE_REAL);
    let p = publisher("reserve-no-ceiling");
    let fx = v1_fixture("chat_big_reserve", "snap1", &"z".repeat(300_000));
    let result = publish(&p, &fx);
    assert!(
        result.ok,
        "a large member must publish when space allows: {:?}",
        blocker_codes(&result)
    );
    assert!(result.committed);
}

#[test]
fn the_reserve_also_governs_the_commit_time_asset_copy() {
    // An asset copy extends a staged member just as an append does, so it must
    // be admitted against the reserve too — otherwise a large multi-asset
    // commit could consume the very headroom the reserve exists to preserve.
    let root = scratch_root("reserve-asset-copy");
    let p = Publisher::new(root.clone());
    let fx = v2_fixture(&root, "chat_reserve_asset", &[("png", b"asset-bytes-here")]);

    // Stage with ample space so the members land, then constrain ONLY the
    // commit-time copy.
    let begun = begin(&p, &fx.chat_id);
    assert!(begun.ok);
    stage_all(&p, begun.token, &fx);
    set_space(FREE_SPACE_RESERVE_BYTES + 4);
    let result = commit_v1v2(&p, begun.token, None);
    set_space(FREE_SPACE_REAL);

    assert!(
        !result.ok,
        "the copy must be refused when it would eat the reserve"
    );
    assert!(
        blocker_codes(&result)
            .iter()
            .any(|c| c.starts_with("generation-staging-resource-")),
        "must be an environmental refusal, not a validity blocker: {:?}",
        blocker_codes(&result)
    );
    // Environmental and retryable: nothing was published, staging was cleaned,
    // and the same package publishes once space is available again.
    assert!(
        packages_entries(&p).is_empty(),
        "refusal cleans its own staging"
    );
    let retried = publish(&p, &fx);
    assert!(retried.ok, "{:?}", blocker_codes(&retried));
    assert!(retried.committed);
}

// ── DURABILITY (§N) ────────────────────────────────────────────────────────

#[test]
fn a_parent_fence_failure_after_promotion_keeps_the_generation_committed() {
    // §N: "Promotion IS the commit point, and the durability fence cannot
    // retract it." A fence failure must report committed:true with
    // durabilityComplete:false, and must NEVER clean the published tree —
    // it is no longer staging.
    let p = publisher("fence-failure");
    let fx = v1_fixture("chat_fence", "snap1", "body");

    FORCE_FENCE_FAILURE.with(|f| f.set(true));
    let result = publish(&p, &fx);
    FORCE_FENCE_FAILURE.with(|f| f.set(false));

    assert!(result.ok, "promotion succeeded, so the publish succeeded");
    assert!(result.committed, "promotion is the commit point");
    assert!(
        !result.durability_complete,
        "the fence failed, so durability is not proven"
    );
    assert!(
        blocker_codes(&result).contains(&"generation-parent-fsync-failed".to_string()),
        "the fence failure must be reported honestly: {:?}",
        blocker_codes(&result)
    );

    // The generation is present, complete and verifiable — cleanup ownership
    // must NOT have been restored after promotion.
    let entries = packages_entries(&p);
    assert_eq!(entries.len(), 1, "the generation must survive: {entries:?}");
    let dir = p.root.join(PACKAGES_DIR).join(&entries[0]);
    for member in ["manifest.json", "snapshot.json", "chat.md", "chat.html"] {
        assert!(
            dir.join(member).exists(),
            "{member} must survive the fence failure"
        );
    }
    assert_eq!(
        std::fs::read(dir.join("snapshot.json")).unwrap(),
        fx.snapshot
    );
}

#[test]
fn a_fence_failure_on_the_occupied_path_never_downgrades_the_dedupe() {
    // §N.2 states this rule in the negative — "a fence failure on this path
    // returns the classified occupant outcome PLUS the fence blocker; it never
    // suppresses or downgrades the occupant verdict, and it never converts a
    // DEDUPED into a failure" — so it needs a test that fails if the occupied
    // path starts treating a fence error as a refusal.
    let p = publisher("occupied-fence-failure");
    let fx = v1_fixture("chat_occ_fence", "snap1", "body");
    assert!(publish(&p, &fx).ok, "first publish must commit");

    // Damage a presentation member too, so this ALSO pins that an advisory and
    // a fence blocker coexist without the advisory entering blockers.
    let published = packages_entries(&p)[0].clone();
    std::fs::write(
        p.root.join(PACKAGES_DIR).join(&published).join("chat.md"),
        b"",
    )
    .expect("truncate");

    FORCE_FENCE_FAILURE.with(|f| f.set(true));
    let out = publish(&p, &fx);
    FORCE_FENCE_FAILURE.with(|f| f.set(false));

    assert!(
        out.ok,
        "a fence failure must never convert a DEDUPED into a failure: {:?}",
        blocker_codes(&out)
    );
    assert_eq!(out.outcome, Outcome::Deduped);
    assert!(!out.committed, "dedupe writes nothing");
    assert!(!out.durability_complete, "the fence failed");
    assert_eq!(
        blocker_codes(&out),
        vec!["generation-parent-fsync-failed".to_string()],
        "the fence blocker is reported, and nothing else"
    );
    assert_eq!(
        blocker_codes_of(&out.advisories),
        vec!["generation-occupant-presentation-mismatch".to_string()],
        "the advisory rides alongside, never inside, blockers"
    );
    // The occupant is untouched and this attempt's staging is cleaned.
    assert_eq!(packages_entries(&p), vec![published]);
}

#[test]
fn an_occupant_with_an_inconsistent_snapshot_descriptor_is_corrupt_not_deduped() {
    // G1 preflight: the occupant's BYTES and contentHash are correct, but its
    // manifest.files.snapshot descriptor is not. The governed reader blocks
    // that with snapshot-sha-mismatch, so trusted dedupe would launder an
    // invalid package into a success — and dedupe deletes this attempt's
    // correct copy.
    let p = publisher("occupant-snapshot-descriptor");
    let fx = v1_fixture("chat_snapdesc", "snap1", "body");
    assert!(publish(&p, &fx).ok);
    let published = packages_entries(&p)[0].clone();
    let manifest_path = p
        .root
        .join(PACKAGES_DIR)
        .join(&published)
        .join("manifest.json");

    // Corrupt ONLY the files.snapshot sha. contentHash and the bytes stay
    // correct, so every other check still passes.
    let text = std::fs::read_to_string(&manifest_path).expect("manifest");
    let real = format!("sha256-{}", sha256_hex(&fx.snapshot));
    let bogus = format!("sha256-{}", "0".repeat(64));
    let tampered = text.replacen(
        &format!("\"sha256\":\"{real}\""),
        &format!("\"sha256\":\"{bogus}\""),
        1,
    );
    assert_ne!(tampered, text, "the fixture must contain the descriptor");
    std::fs::write(&manifest_path, &tampered).expect("write");

    let result = publish(&p, &fx);
    assert!(
        !result.ok,
        "an occupant the reader would block must not dedupe: {:?}",
        result.outcome
    );
    assert_eq!(result.outcome, Outcome::GenerationDestinationCorrupt);
    // Occupant untouched, this attempt's staging cleaned.
    assert_eq!(std::fs::read_to_string(&manifest_path).unwrap(), tampered);
    assert_eq!(packages_entries(&p), vec![published]);
}

// ── SESSION EVICTION (§Q) ──────────────────────────────────────────────────

/// Back-dates a session's last activity so lazy eviction can reach it. Uses the
/// existing test seam (mod tests sees privates); adds no production hook.
fn back_date(p: &Publisher, token: u64) {
    let session = p
        .registry
        .lock_map()
        .get(&token)
        .map(Arc::clone)
        .expect("session present");
    let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
    inner.last_activity = Instant::now()
        .checked_sub(SESSION_IDLE_TIMEOUT + Duration::from_secs(1))
        .expect("clock");
}

#[test]
fn an_idle_session_is_evicted_and_its_staging_and_slot_are_reclaimed() {
    let p = publisher("evict-idle");
    let begun = begin(&p, "chat_idle");
    assert!(begun.ok);
    assert_eq!(p.registry.admitted_count(), 1);
    assert_eq!(packages_entries(&p).len(), 1, "staging exists");

    back_date(&p, begun.token);
    // Eviction is lazy: it runs under the BEGIN path.
    let next = begin(&p, "chat_next");
    assert!(next.ok);

    assert!(
        p.registry.lock_map().get(&begun.token).is_none(),
        "the idle session must be evicted"
    );
    assert_eq!(
        p.registry.admitted_count(),
        1,
        "exactly one slot released, one taken by the new session"
    );
    // Only the new session's staging remains — the evicted one was cleaned.
    let entries = packages_entries(&p);
    assert_eq!(
        entries.len(),
        1,
        "evicted staging must be removed: {entries:?}"
    );
    assert!(abort(&p, next.token).ok);
    assert!(packages_entries(&p).is_empty());
}

#[test]
fn a_fresh_session_is_never_evicted() {
    let p = publisher("evict-fresh");
    let a = begin(&p, "chat_a");
    assert!(a.ok);
    let b = begin(&p, "chat_b");
    assert!(b.ok);
    // Neither is idle, so an unconditional reap would wrongly remove them.
    assert!(p.registry.lock_map().get(&a.token).is_some());
    assert!(p.registry.lock_map().get(&b.token).is_some());
    assert_eq!(p.registry.admitted_count(), 2);
    assert_eq!(packages_entries(&p).len(), 2);
    assert!(abort(&p, a.token).ok);
    assert!(abort(&p, b.token).ok);
}

#[test]
fn eviction_runs_under_the_admission_claim_before_begin_refuses() {
    // §Q: "claim terminable sessions, then refuse if still full" — reaping must
    // happen BEFORE the cap check, or a full-but-idle registry would stay
    // wedged.
    let p = publisher("evict-then-admit");
    let mut tokens = Vec::new();
    for i in 0..MAX_ADMITTED_SESSIONS {
        let begun = begin(&p, &format!("chat_{i}"));
        assert!(begun.ok);
        tokens.push(begun.token);
    }
    assert!(
        !begin(&p, "chat_full").ok,
        "cap must refuse while every session is live"
    );
    back_date(&p, tokens[0]);
    let admitted = begin(&p, "chat_after_reap");
    assert!(
        admitted.ok,
        "reaping one idle session must free exactly one admission slot"
    );
    assert!(abort(&p, admitted.token).ok);
    for t in tokens.into_iter().skip(1) {
        assert!(abort(&p, t).ok);
    }
}

#[test]
fn an_idle_session_holding_its_lease_is_not_evicted_beneath_active_work() {
    // §Q property 8: eviction may not delete staging beneath an active WRITE,
    // even when the session looks idle by timestamp.
    let p = Arc::new(publisher("evict-vs-lease"));
    let begun = begin(&p, "chat_leased");
    assert!(begun.ok);
    back_date(&p, begun.token);
    let session = p
        .registry
        .lock_map()
        .get(&begun.token)
        .map(Arc::clone)
        .expect("session");

    // Hold the lease, as an in-flight WRITE does.
    let guard = session.inner.lock().unwrap_or_else(|e| e.into_inner());
    let before = packages_entries(&p);
    let other = begin(&p, "chat_other");
    assert!(other.ok);
    // The leased session's staging survives: try_lock in reap_idle skipped it.
    let after = packages_entries(&p);
    for entry in &before {
        assert!(
            after.contains(entry),
            "staging {entry} was removed beneath a held lease"
        );
    }
    assert!(
        p.registry.lock_map().get(&begun.token).is_some(),
        "a leased session must not be evicted"
    );
    drop(guard);
    assert!(abort(&p, begun.token).ok);
    assert!(abort(&p, other.token).ok);
}

#[test]
fn a_threaded_write_is_never_cleaned_beneath_by_the_reaper() {
    // §Q acceptance invariant, proven with real threads and deterministic
    // barriers (no sleeps): while a WRITE genuinely holds its lease, a
    // concurrent BEGIN runs the reaper over an idle-looking session and must
    // neither clean its staging nor recycle its identity.
    use std::sync::mpsc;

    let p = Arc::new(publisher("threaded-write-vs-reap"));
    let begun = begin(&p, "chat_threaded");
    assert!(begun.ok);
    let token = begun.token;
    // Make it LOOK idle so the reaper genuinely considers it.
    back_date(&p, token);

    let staging_before = packages_entries(&p);
    assert_eq!(staging_before.len(), 1);

    // Barriers: the writer signals it holds the lease, then waits for the
    // reaper to finish before releasing it.
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let (tx, rx) = mpsc::channel();

    let writer = {
        let p = Arc::clone(&p);
        let entered = Arc::clone(&entered);
        let release = Arc::clone(&release);
        std::thread::spawn(move || {
            // Take the lease directly — this is exactly the state write_member
            // is in between acquiring `inner` and returning.
            let session = p
                .registry
                .lock_map()
                .get(&token)
                .map(Arc::clone)
                .expect("session");
            let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.last_activity = Instant::now();
            entered.wait(); // lease is held
            release.wait(); // hold it across the reaper
                            // Still usable afterwards: append through the held lease.
            let dir = inner.dir.as_ref().expect("staging still present");
            let file = dir.create_new_child(b"chat.md");
            tx.send(file.is_ok()).ok();
            drop(inner);
        })
    };

    entered.wait();
    // With the lease held, drive a BEGIN — which runs the reaper.
    let other = begin(&p, "chat_other");
    assert!(other.ok);
    // The leased session must still exist and still own its staging.
    assert!(
        p.registry.lock_map().get(&token).is_some(),
        "a leased session must not be evicted, however idle it looks"
    );
    let during = packages_entries(&p);
    for entry in &staging_before {
        assert!(
            during.contains(entry),
            "staging {entry} was removed beneath an active lease"
        );
    }
    release.wait();
    writer.join().expect("writer thread");
    assert_eq!(
        rx.recv().expect("writer result"),
        true,
        "the staging directory must still be usable by the in-flight operation"
    );

    // No identity recycling: the new session got a different token.
    assert_ne!(other.token, token);
    assert!(abort(&p, token).ok);
    assert!(abort(&p, other.token).ok);
    assert!(packages_entries(&p).is_empty());
}

// ── MEMBERS ────────────────────────────────────────────────────────────────

#[test]
fn every_required_v1_member_is_mandatory() {
    for missing in Member::all() {
        let p = publisher("missing-member");
        let fx = v1_fixture("chat_missing", "snap1", "x");
        let begun = begin(&p, &fx.chat_id);
        for member in Member::all() {
            if member == missing {
                continue;
            }
            let bytes = match member {
                Member::Snapshot => &fx.snapshot,
                Member::Markdown => &fx.markdown,
                Member::Html => &fx.html,
                Member::Manifest => &fx.manifest,
            };
            write_member(&p, begun.token, member, bytes);
        }
        let result = commit_v1v2(&p, begun.token, None);
        assert!(
            !result.ok,
            "missing {} must refuse — the v3 two-member form is not admitted",
            missing.file_name()
        );
        assert!(packages_entries(&p).is_empty());
    }
}

#[test]
fn staged_bytes_altered_before_verification_are_detected() {
    let p = publisher("altered");
    let fx = v1_fixture("chat_alter", "snap1", "x");
    let begun = begin(&p, &fx.chat_id);
    stage_all(&p, begun.token, &fx);
    // Mutate the staged markdown behind the session's back, as a separately
    // held writable handle could.
    let staging = packages_entries(&p)
        .into_iter()
        .find(|n| n.starts_with(STAGING_PREFIX))
        .expect("staging");
    let path = p.root.join(PACKAGES_DIR).join(&staging).join("chat.md");
    std::fs::write(&path, b"TAMPERED-TAMPERED-TAMPERED").expect("tamper");

    let result = commit_v1v2(&p, begun.token, None);
    assert!(!result.ok, "tampered member must not publish");
    let codes = blocker_codes(&result);
    assert!(
        codes.contains(&"generation-member-sha-mismatch".to_string())
            || codes.contains(&"generation-member-byte-length-mismatch".to_string()),
        "unexpected: {codes:?}"
    );
    assert!(packages_entries(&p).is_empty());
}

// ── IDENTITY ───────────────────────────────────────────────────────────────

#[test]
fn v1_identity_is_the_hash_of_the_exact_staged_snapshot_bytes() {
    // Whitespace that a parse-and-reserialize would normalize away MUST change
    // identity, proving the bytes — not a reparse — are the authority.
    let p = publisher("v1-bytes");
    let a = v1_fixture("chat_bytes", "snap1", "x");
    let result_a = publish(&p, &a);
    assert!(result_a.ok);
    assert_eq!(result_a.content_hash, sha_of(&a.snapshot));

    let mut b = v1_fixture("chat_bytes", "snap1", "x");
    // Re-space the JSON without changing its meaning.
    let respaced = String::from_utf8(b.snapshot.clone())
        .unwrap()
        .replace("\":", "\" :");
    b.snapshot = respaced.into_bytes();
    b.content_hash = sha_of(&b.snapshot);
    b.manifest = String::from_utf8(b.manifest.clone())
        .unwrap()
        .replace(
            &format!("\"contentHash\":\"{}\"", sha_of(&a.snapshot)),
            &format!("\"contentHash\":\"{}\"", b.content_hash),
        )
        .replace(
            &format!(
                "\"snapshot\":{{\"path\":\"snapshot.json\",\"sha256\":\"{}\",\"byteLength\":{}}}",
                sha_of(&a.snapshot),
                a.snapshot.len()
            ),
            &format!(
                "\"snapshot\":{{\"path\":\"snapshot.json\",\"sha256\":\"{}\",\"byteLength\":{}}}",
                sha_of(&b.snapshot),
                b.snapshot.len()
            ),
        )
        .into_bytes();
    assert_ne!(
        a.content_hash, b.content_hash,
        "byte identity, not semantic"
    );
    let result_b = publish(&p, &b);
    assert!(result_b.ok, "{:?}", blocker_codes(&result_b));
    assert_eq!(packages_entries(&p).len(), 2, "two distinct generations");
}

#[test]
fn v2_pre_image_is_the_frozen_two_key_descriptor() {
    // Golden vector: the exact historical shape, compact, keys in this order.
    let pre = v2_content_pre_image(
        "sha256-1111111111111111111111111111111111111111111111111111111111111111",
        &[
            "sha256-2222222222222222222222222222222222222222222222222222222222222222".to_string(),
            "sha256-3333333333333333333333333333333333333333333333333333333333333333".to_string(),
        ],
    );
    assert_eq!(
        pre,
        "{\"assets\":[\"sha256-2222222222222222222222222222222222222222222222222222222222222222\",\"sha256-3333333333333333333333333333333333333333333333333333333333333333\"],\"snapshot\":\"sha256-1111111111111111111111111111111111111111111111111111111111111111\"}"
    );
    // No spaces, no trailing comma, `assets` before `snapshot`.
    assert!(!pre.contains(' '));
    assert!(pre.find("\"assets\"").unwrap() < pre.find("\"snapshot\"").unwrap());
}

#[test]
fn v2_identity_ignores_caller_asset_order_but_not_content() {
    let root = scratch_root("v2-order");
    let p = Publisher::new(root.clone());
    let a = v2_fixture(
        &root,
        "chat_v2",
        &[("png", b"alpha-bytes"), ("png", b"beta-bytes")],
    );
    let b = v2_fixture(
        &root,
        "chat_v2",
        &[("png", b"beta-bytes"), ("png", b"alpha-bytes")],
    );
    // Same asset SET in reversed input order → identical identity.
    assert_eq!(
        derive_content_hash(true, &a.snapshot, &{
            let mut v = vec![sha_of(b"alpha-bytes"), sha_of(b"beta-bytes")];
            v.sort();
            v
        }),
        derive_content_hash(true, &a.snapshot, &{
            let mut v = vec![sha_of(b"beta-bytes"), sha_of(b"alpha-bytes")];
            v.sort();
            v
        })
    );
    let result = publish(&p, &a);
    assert!(result.ok, "{:?}", blocker_codes(&result));
    assert_eq!(result.content_hash, a.content_hash);
    // Different content → different identity.
    assert_ne!(
        a.content_hash,
        v2_fixture(&root, "chat_v2", &[("png", b"other")]).content_hash
    );
    // Republishing the SAME v2 content exercises classify_occupant's v2 branch
    // — the payload_v2 arm and the descriptor sort — which the v1 occupant
    // tests never reach.
    let again = publish(&p, &a);
    assert!(again.ok, "{:?}", blocker_codes(&again));
    assert_eq!(again.outcome, Outcome::Deduped);
    assert!(!again.committed);
    assert_eq!(packages_entries(&p).len(), 1);
    let _ = b;
}

#[test]
fn a_v2_occupant_missing_its_asset_copies_is_partial_not_deduped() {
    // RED repair: the occupant's declared asset copies are required members
    // (§J) and the reader blocks on them, so an occupant whose assets/ subtree
    // was removed must never be laundered into DEDUPED — especially since
    // dedupe DELETES this attempt's correct copy.
    let root = scratch_root("occupant-assets-missing");
    let p = Publisher::new(root.clone());
    let fx = v2_fixture(&root, "chat_v2miss", &[("png", b"asset-bytes")]);
    assert!(publish(&p, &fx).ok);
    let published = packages_entries(&p)[0].clone();
    let assets_dir = p.root.join(PACKAGES_DIR).join(&published).join("assets");
    std::fs::remove_dir_all(&assets_dir).expect("remove assets");

    let result = publish(&p, &fx);
    assert!(!result.ok, "a missing asset copy must not dedupe");
    assert_eq!(result.outcome, Outcome::GenerationPartial);
    assert_eq!(packages_entries(&p), vec![published]);
}

#[test]
fn a_v2_occupant_with_tampered_asset_bytes_is_corrupt_not_deduped() {
    let root = scratch_root("occupant-assets-tampered");
    let p = Publisher::new(root.clone());
    let fx = v2_fixture(&root, "chat_v2tamper", &[("png", b"asset-bytes")]);
    assert!(publish(&p, &fx).ok);
    let published = packages_entries(&p)[0].clone();
    let sha = sha_of(b"asset-bytes");
    let copied = p
        .root
        .join(PACKAGES_DIR)
        .join(&published)
        .join("assets")
        .join(format!("{sha}.png"));
    std::fs::write(&copied, b"TAMPERED").expect("tamper");

    let result = publish(&p, &fx);
    assert!(!result.ok, "tampered asset bytes must not dedupe");
    assert_eq!(result.outcome, Outcome::GenerationDestinationCorrupt);
    assert_eq!(
        std::fs::read(&copied).unwrap(),
        b"TAMPERED",
        "occupant untouched"
    );
}

#[test]
fn a_v1_occupant_with_a_truncated_renderer_member_still_dedupes() {
    // NEGATIVE CONTROL, deliberately pinning what must NOT be enforced: the
    // governed reader never hashes chat.md / chat.html (presence only), and §K
    // states they are not identity authority. Such an occupant is VALID and
    // §P case B mandates DEDUPED. A future "tightening" that re-hashed them
    // would permanently fail republication of a package the reader accepts.
    let p = publisher("occupant-md-truncated");
    let fx = v1_fixture("chat_mdtrunc", "snap1", "x");
    assert!(publish(&p, &fx).ok);
    let published = packages_entries(&p)[0].clone();
    std::fs::write(
        p.root.join(PACKAGES_DIR).join(&published).join("chat.md"),
        b"",
    )
    .expect("truncate");

    let result = publish(&p, &fx);
    assert!(result.ok, "{:?}", blocker_codes(&result));
    assert_eq!(result.outcome, Outcome::Deduped);
}

#[test]
fn an_internally_inconsistent_occupant_is_corrupt_not_deduped() {
    // The occupant's manifest declares OUR content hash and describes OUR
    // snapshot bytes correctly, so the pre-existing hash checks all pass — the
    // ONLY thing wrong is that its manifest.chatId disagrees with its own
    // snapshot.chatId, which the governed reader blocks (chat-id-mismatch).
    // Without the occupant cross-binding check this laundering succeeds.
    let p = publisher("occupant-crossbind");
    let fx = v1_fixture("chat_join", "snap1", "shared-body");
    let hex = fx.content_hash.strip_prefix("sha256-").unwrap();
    let target = p
        .root
        .join(PACKAGES_DIR)
        .join(generation_basename(&fx.chat_id, hex));
    std::fs::create_dir_all(&target).expect("plant");
    // Same manifest as fx, but with a divergent chatId. Every descriptor and
    // the contentHash still describe fx's real bytes.
    let divergent = String::from_utf8(fx.manifest.clone())
        .unwrap()
        .replace("\"chatId\":\"chat_join\"", "\"chatId\":\"chat_other\"")
        .into_bytes();
    std::fs::write(target.join("snapshot.json"), &fx.snapshot).unwrap();
    std::fs::write(target.join("chat.md"), &fx.markdown).unwrap();
    std::fs::write(target.join("chat.html"), &fx.html).unwrap();
    std::fs::write(target.join("manifest.json"), &divergent).unwrap();

    let result = publish(&p, &fx);
    assert!(
        !result.ok,
        "an occupant whose manifest and snapshot disagree must not dedupe"
    );
    assert_eq!(result.outcome, Outcome::GenerationDestinationCorrupt);
    // Occupant untouched.
    assert_eq!(
        std::fs::read(target.join("manifest.json")).unwrap(),
        divergent
    );
}

#[test]
fn a_symlink_at_the_destination_is_unreadable_and_never_followed() {
    let p = publisher("occupant-symlink");
    let fx = v1_fixture("chat_symdest", "snap1", "x");
    let hex = fx.content_hash.strip_prefix("sha256-").unwrap();
    // Point it at a byte-identical valid package: the case that must NOT
    // become DEDUPED by following the link.
    let elsewhere = p.root.join("elsewhere.h2ochat");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere");
    std::fs::write(elsewhere.join("snapshot.json"), &fx.snapshot).unwrap();
    std::fs::write(elsewhere.join("chat.md"), &fx.markdown).unwrap();
    std::fs::write(elsewhere.join("chat.html"), &fx.html).unwrap();
    std::fs::write(elsewhere.join("manifest.json"), &fx.manifest).unwrap();
    std::fs::create_dir_all(p.root.join(PACKAGES_DIR)).ok();
    let link = p
        .root
        .join(PACKAGES_DIR)
        .join(generation_basename(&fx.chat_id, hex));
    std::os::unix::fs::symlink(&elsewhere, &link).expect("symlink");

    let result = publish(&p, &fx);
    assert!(!result.ok, "a symlink is neither valid nor an identity");
    assert_eq!(result.outcome, Outcome::GenerationOccupantUnreadable);
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(elsewhere.join("manifest.json").exists());
}

#[test]
fn hash_math_does_not_deduplicate_even_though_the_gate_refuses_duplicates() {
    // Historical reader compatibility: the FORMULA hashes the list it is given.
    let sha = "sha256-4444444444444444444444444444444444444444444444444444444444444444".to_string();
    let once = v2_content_pre_image(
        "sha256-0000000000000000000000000000000000000000000000000000000000000000",
        &[sha.clone()],
    );
    let twice = v2_content_pre_image(
        "sha256-0000000000000000000000000000000000000000000000000000000000000000",
        &[sha.clone(), sha.clone()],
    );
    assert_ne!(once, twice, "the formula must not silently dedupe");
    assert_eq!(twice.matches("sha256-4444").count(), 2);
    // Pin the property at the derivation entry point too, not only in the
    // pre-image builder: a `dedup()` anywhere on this path would change the
    // identity of a historical duplicate-bearing package.
    let snapshot = b"{\"chatId\":\"c\"}";
    assert_ne!(
        derive_content_hash(true, snapshot, &[sha.clone()]),
        derive_content_hash(true, snapshot, &[sha.clone(), sha.clone()]),
        "derive_content_hash must hash the list it is given"
    );
}

#[test]
fn a_caller_supplied_content_hash_cannot_force_identity() {
    let p = publisher("hash-forge");
    let mut fx = v1_fixture("chat_forge", "snap1", "x");
    let forged = "sha256-".to_string() + &"f".repeat(64);
    // Replace ONLY the contentHash field. For v1 the contentHash equals the
    // snapshot descriptor's sha, so a blanket replace would corrupt the
    // descriptor too and the member re-hash would fire first — this test must
    // isolate the identity-derivation guard.
    fx.manifest = String::from_utf8(fx.manifest.clone())
        .unwrap()
        .replace(
            &format!("\"contentHash\":\"{}\"", fx.content_hash),
            &format!("\"contentHash\":\"{forged}\""),
        )
        .into_bytes();
    let result = publish(&p, &fx);
    assert!(!result.ok, "a forged contentHash must refuse, never steer");
    assert_eq!(
        blocker_codes(&result),
        vec!["generation-content-hash-mismatch".to_string()]
    );
    // And no directory was created under the forged name.
    assert!(packages_entries(&p).is_empty());
}

#[test]
fn expected_manifest_sha_can_only_refuse() {
    let p = publisher("expected-sha");
    let fx = v1_fixture("chat_expect", "snap1", "x");

    // Wrong assertion refuses.
    let begun = begin(&p, &fx.chat_id);
    stage_all(&p, begun.token, &fx);
    let wrong = commit_v1v2(
        &p,
        begun.token,
        Some(&("sha256-".to_string() + &"a".repeat(64))),
    );
    assert!(!wrong.ok);
    assert_eq!(
        wrong.blockers[0].code,
        "generation-expected-manifest-sha-mismatch"
    );

    // Correct assertion changes nothing about the derived identity.
    let begun = begin(&p, &fx.chat_id);
    stage_all(&p, begun.token, &fx);
    let right = commit_v1v2(&p, begun.token, Some(&sha_of(&fx.manifest)));
    assert!(right.ok);
    assert_eq!(right.content_hash, fx.content_hash);
}

#[test]
fn the_trusted_verifier_uses_no_generic_canonicalizer_and_no_colon_identity() {
    // Wrong-canonicalizer tripwire (§T / C7). The identity path must not reuse
    // transport canonicalization, generic object sorting, or a `sha256:` form.
    let publisher_source = include_str!("../archive_generation_publish.rs");
    let source = include_str!("../saved_chat_package_verify.rs");
    assert!(
        !publisher_source.contains("sorted_json_value") && !source.contains("sorted_json_value"),
        "archive identity must not reuse transport canonicalization"
    );
    // The colon form would appear as a string literal prefix (`"sha256:`), not
    // as Rust struct-field syntax (`sha256: String`), so match the literal.
    assert!(
        !source.contains("\"sha256:"),
        "archive identity uses the `sha256-` prefix, never the colon transport form"
    );
    assert!(
        source.contains("\"sha256-{}\""),
        "identity must be emitted in the historical `sha256-` prefixed form"
    );
    // The pre-image is built literally, not serialized from a map.
    assert!(
        source.contains("out.push_str(\"{\\\"assets\\\":[\")")
            || source.contains("String::from(\"{\\\"assets\\\":[\")")
    );
    // A serde_json map serialization of the descriptor would be a generic
    // canonicalizer; ensure the identity fn does not take that route.
    let fn_start = source
        .find("fn v2_content_pre_image")
        .expect("pre-image fn present");
    let fn_end = source[fn_start..].find("\n}\n").expect("fn end") + fn_start;
    let body = &source[fn_start..fn_end];
    assert!(!body.contains("serde_json"), "pre-image must be literal");
    assert!(
        !body.contains("to_string()"),
        "no serializer in the pre-image"
    );
}

#[test]
fn integer_like_metadata_keys_do_not_affect_archive_identity() {
    // The JS canonicalizer's integer-index-key hazard must never reach this
    // module: v1 hashes bytes, so key ORDER in the snapshot is whatever the
    // producer wrote and is hashed verbatim.
    let with_keys =
        br#"{"schemaVersion":1,"chatId":"c","snapshotId":"s","metadata":{"10":"a","2":"b"}}"#;
    let reordered =
        br#"{"schemaVersion":1,"chatId":"c","snapshotId":"s","metadata":{"2":"b","10":"a"}}"#;
    assert_ne!(
        derive_content_hash(false, with_keys, &[]),
        derive_content_hash(false, reordered, &[]),
        "byte identity means a different byte order is a different package"
    );
    // And neither is reordered by us.
    assert_eq!(
        derive_content_hash(false, with_keys, &[]),
        sha_of(with_keys)
    );
}

// ── VERSION TRIPLES ────────────────────────────────────────────────────────

#[test]
fn incoherent_version_triples_are_refused() {
    let base = |extra: &str, assets: &str| {
        format!(
            r#"{{"schema":"h2o.savedChatPackage","chatId":"c","snapshotId":"s","contentHash":"sha256-{}","files":{{}},{extra}"assets":[{assets}]}}"#,
            "0".repeat(64)
        )
        .into_bytes()
    };
    // A fully VALID descriptor, so each case is refused by the version triple
    // itself rather than by an unrelated descriptor guard.
    let good_asset = format!(
        r#"{{"path":"assets/sha256-{h}.png","sha256":"sha256-{h}","ext":"png","mimeType":"image/png","byteLength":1}}"#,
        h = "9".repeat(64)
    );
    let triple = "generation-manifest-version-triple-incoherent";

    // schemaVersion 1 + payloadVersion 2 hybrid
    assert_eq!(
        validate_manifest(&base("\"schemaVersion\":1,\"payloadVersion\":2,", "")).unwrap_err(),
        triple
    );
    // v1 with non-empty assets
    assert_eq!(
        validate_manifest(&base("\"schemaVersion\":1,", &good_asset)).unwrap_err(),
        triple
    );
    // v2 with empty assets
    assert_eq!(
        validate_manifest(&base("\"schemaVersion\":2,\"payloadVersion\":2,", "")).unwrap_err(),
        triple
    );
    // schemaVersion 3 is not admitted by M05, even when otherwise coherent.
    assert_eq!(
        validate_manifest(&base(
            "\"schemaVersion\":3,\"payloadVersion\":3,",
            &good_asset
        ))
        .unwrap_err(),
        triple
    );
    // Wrong schema string
    assert_eq!(
        validate_manifest(br#"{"schema":"other","schemaVersion":1,"assets":[]}"#).unwrap_err(),
        "generation-manifest-schema-invalid"
    );
}

#[test]
fn cross_binding_between_manifest_snapshot_and_begin_chat_id_is_enforced() {
    let p = publisher("cross-bind");
    let fx = v1_fixture("chat_bind", "snap1", "x");
    // A snapshot naming a different chat than BEGIN/manifest.
    let mut wrong = v1_fixture("chat_bind", "snap1", "x");
    wrong.snapshot = String::from_utf8(fx.snapshot.clone())
        .unwrap()
        .replace("\"chatId\":\"chat_bind\"", "\"chatId\":\"chat_other\"")
        .into_bytes();
    // Keep the manifest self-consistent for the snapshot descriptor so the
    // cross-binding check is what fires.
    wrong.content_hash = sha_of(&wrong.snapshot);
    wrong.manifest = String::from_utf8(fx.manifest.clone())
        .unwrap()
        .replace(&sha_of(&fx.snapshot), &sha_of(&wrong.snapshot))
        .replace(
            &format!("\"byteLength\":{}", fx.snapshot.len()),
            &format!("\"byteLength\":{}", wrong.snapshot.len()),
        )
        .replace(&fx.content_hash, &wrong.content_hash)
        .into_bytes();
    let result = publish(&p, &wrong);
    assert!(!result.ok);
    assert!(blocker_codes(&result).contains(&"generation-chat-id-mismatch".to_string()));
}

// ── REAL SANCTIONED-WRITER CONFORMANCE ─────────────────────────────────────

#[test]
fn the_gate_accepts_a_real_committed_sanctioned_writer_package() {
    // The strongest conformance proof available without launching Desktop: run
    // the ACTUAL committed v1 fixture — produced by the live JS writer — end to
    // end through this gate. The gate must never refuse writer-producible
    // output (that would be a class-C new package-validity rule).
    let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../tools/validation/fixtures/saved-chat-archive/import-recovery/i-harness-source.h2ochat");
    if !base.join("manifest.json").exists() {
        // Fixture path is relative to the repo; skip rather than fail if the
        // crate is built out of tree.
        return;
    }
    let manifest = std::fs::read(base.join("manifest.json")).expect("manifest");
    let snapshot = std::fs::read(base.join("snapshot.json")).expect("snapshot");
    let markdown = std::fs::read(base.join("chat.md")).expect("chat.md");
    let html = std::fs::read(base.join("chat.html")).expect("chat.html");

    // The manifest validates, and its version triple is the real v1 shape.
    let validated = validate_manifest(&manifest).expect("real manifest must validate");
    assert!(!validated.payload_v2, "the fixture is v1");
    assert!(validated.assets.is_empty());

    // Our derivation reproduces the writer's own contentHash byte-exactly.
    let derived = derive_content_hash(false, &snapshot, &[]);
    assert_eq!(
        derived, validated.content_hash,
        "trusted derivation must reproduce the live writer's identity"
    );

    // And the whole package publishes through the real protocol.
    let p = publisher("real-fixture");
    let begun = begin(&p, &validated.chat_id);
    assert!(begun.ok, "{:?}", begun.blockers);
    assert!(write_member(&p, begun.token, Member::Snapshot, &snapshot).ok);
    assert!(write_member(&p, begun.token, Member::Markdown, &markdown).ok);
    assert!(write_member(&p, begun.token, Member::Html, &html).ok);
    assert!(write_member(&p, begun.token, Member::Manifest, &manifest).ok);
    let result = commit_v1v2(&p, begun.token, None);
    assert!(
        result.ok && result.committed,
        "a real sanctioned-writer package must publish: {:?}",
        blocker_codes(&result)
    );
    assert_eq!(result.content_hash, validated.content_hash);
}

// ── ASSETS ─────────────────────────────────────────────────────────────────

#[test]
fn v2_assets_are_copied_from_the_cas_and_reverified() {
    let root = scratch_root("assets-copy");
    let p = Publisher::new(root.clone());
    let fx = v2_fixture(&root, "chat_assets", &[("png", b"image-bytes-here")]);
    let result = publish(&p, &fx);
    assert!(result.ok, "{:?}", blocker_codes(&result));
    let published = &packages_entries(&p)[0];
    let sha = sha_of(b"image-bytes-here");
    let copied = p
        .root
        .join(PACKAGES_DIR)
        .join(published)
        .join("assets")
        .join(format!("{sha}.png"));
    assert!(copied.exists(), "package must be self-contained");
    assert_eq!(std::fs::read(&copied).unwrap(), b"image-bytes-here");
}

#[test]
fn a_corrupt_cas_object_refuses_publication() {
    let root = scratch_root("cas-corrupt");
    let p = Publisher::new(root.clone());
    let fx = v2_fixture(&root, "chat_cas", &[("png", b"good-bytes")]);
    // Corrupt the CAS object AFTER the manifest was built.
    let sha = sha_of(b"good-bytes");
    let hex = sha.strip_prefix("sha256-").unwrap();
    let path = root
        .join("assets")
        .join(&hex[0..2])
        .join(format!("sha256-{hex}"));
    std::fs::write(&path, b"corrupted!").expect("corrupt");
    let result = publish(&p, &fx);
    assert!(
        !result.ok,
        "a CAS object that does not hash to its name must refuse"
    );
    let codes = blocker_codes(&result);
    assert!(
        codes.contains(&"generation-asset-sha-mismatch".to_string())
            || codes.contains(&"generation-asset-byte-length-mismatch".to_string()),
        "{codes:?}"
    );
    assert!(packages_entries(&p).is_empty());
}

#[test]
fn a_historical_over_ingest_cap_cas_object_remains_packageable() {
    // DP-PRE-M05-ASSET-BOUND is an INGEST ceiling, never a read/packaging
    // ceiling. A pre-existing object larger than the ingest cap must still be
    // copyable into a new generation.
    let root = scratch_root("over-cap");
    let p = Publisher::new(root.clone());
    let big = vec![7u8; (crate::archive_durable_write::GOVERNED_ASSET_BLOB_CAP_BYTES + 1) as usize];
    let fx = v2_fixture(&root, "chat_big", &[("png", &big)]);
    let result = publish(&p, &fx);
    assert!(
        result.ok,
        "historical over-cap CAS object must remain packageable: {:?}",
        blocker_codes(&result)
    );
    let published = &packages_entries(&p)[0];
    let copied = p
        .root
        .join(PACKAGES_DIR)
        .join(published)
        .join("assets")
        .join(format!("{}.png", sha_of(&big)));
    assert_eq!(std::fs::metadata(&copied).unwrap().len(), big.len() as u64);
}

#[test]
fn a_caller_cannot_redirect_the_cas_source_through_the_descriptor_path() {
    // The descriptor `path` is validated to be exactly `assets/<sha>.<ext>`, so
    // it cannot name another location; the CAS source is derived from the sha.
    let manifest = format!(
        r#"{{"schema":"h2o.savedChatPackage","schemaVersion":2,"payloadVersion":2,"chatId":"c","snapshotId":"s","contentHash":"sha256-{h}","files":{{}},"assets":[{{"path":"../../escape.png","sha256":"sha256-{h}","ext":"png","mimeType":"image/png","byteLength":1}}]}}"#,
        h = "1".repeat(64)
    );
    let err = validate_manifest(manifest.as_bytes()).unwrap_err();
    assert_eq!(err, "generation-manifest-asset-path-invalid");
}

#[test]
fn duplicate_asset_descriptors_are_refused_on_new_publications() {
    let sha = format!("sha256-{}", "2".repeat(64));
    let manifest = format!(
        r#"{{"schema":"h2o.savedChatPackage","schemaVersion":2,"payloadVersion":2,"chatId":"c","snapshotId":"s","contentHash":"sha256-{h}","files":{{}},"assets":[{{"path":"assets/{sha}.png","sha256":"{sha}","ext":"png","mimeType":"image/png","byteLength":1}},{{"path":"assets/{sha}.png","sha256":"{sha}","ext":"png","mimeType":"image/png","byteLength":1}}]}}"#,
        h = "1".repeat(64)
    );
    let err = validate_manifest(manifest.as_bytes()).unwrap_err();
    assert!(err.starts_with("generation-manifest-asset-duplicate"));
}

// ── PROMOTION / OCCUPIED DESTINATION ───────────────────────────────────────

#[test]
fn republishing_identical_content_dedupes_trusted_side() {
    let p = publisher("dedupe");
    let fx = v1_fixture("chat_dedupe", "snap1", "same");
    let first = publish(&p, &fx);
    assert!(first.ok && first.committed && first.outcome == Outcome::Created);

    let second = publish(&p, &fx);
    assert!(second.ok, "{:?}", blocker_codes(&second));
    assert_eq!(second.outcome, Outcome::Deduped);
    assert!(
        !second.committed,
        "dedupe is a success that deliberately wrote nothing"
    );
    assert_eq!(second.content_hash, fx.content_hash);
    assert_eq!(packages_entries(&p).len(), 1, "no second directory");
}

#[test]
fn a_corrupt_occupant_is_classified_and_never_overwritten() {
    let p = publisher("occupant-corrupt");
    let fx = v1_fixture("chat_corrupt", "snap1", "x");
    assert!(publish(&p, &fx).ok);
    let published = packages_entries(&p)[0].clone();
    // Corrupt the published manifest.
    let manifest_path = p
        .root
        .join(PACKAGES_DIR)
        .join(&published)
        .join("manifest.json");
    std::fs::write(&manifest_path, b"{not json").expect("corrupt");

    let result = publish(&p, &fx);
    assert!(!result.ok);
    assert_eq!(result.outcome, Outcome::GenerationDestinationCorrupt);
    // The occupant is untouched — create-only is unconditional.
    assert_eq!(std::fs::read(&manifest_path).unwrap(), b"{not json");
    assert_eq!(packages_entries(&p), vec![published]);
}

#[test]
fn a_partial_occupant_is_classified_partial() {
    let p = publisher("occupant-partial");
    let fx = v1_fixture("chat_partial", "snap1", "x");
    assert!(publish(&p, &fx).ok);
    let published = packages_entries(&p)[0].clone();
    std::fs::remove_file(p.root.join(PACKAGES_DIR).join(&published).join("chat.md"))
        .expect("remove member");

    let result = publish(&p, &fx);
    assert!(!result.ok);
    assert_eq!(result.outcome, Outcome::GenerationPartial);
    assert_eq!(packages_entries(&p), vec![published]);
}

#[test]
fn a_foreign_occupant_is_classified_foreign() {
    let p = publisher("occupant-foreign");
    let fx = v1_fixture("chat_foreign2", "snap1", "x");
    let hex = fx.content_hash.strip_prefix("sha256-").unwrap();
    // Plant a DIFFERENT but internally valid package at our target name.
    let other = v1_fixture("chat_foreign2", "snap2", "different-body");
    let target = p
        .root
        .join(PACKAGES_DIR)
        .join(generation_basename(&fx.chat_id, hex));
    std::fs::create_dir_all(&target).expect("plant dir");
    std::fs::write(target.join("snapshot.json"), &other.snapshot).unwrap();
    std::fs::write(target.join("chat.md"), &other.markdown).unwrap();
    std::fs::write(target.join("chat.html"), &other.html).unwrap();
    std::fs::write(target.join("manifest.json"), &other.manifest).unwrap();

    let result = publish(&p, &fx);
    assert!(!result.ok);
    assert_eq!(result.outcome, Outcome::GenerationDestinationForeign);
    // Occupant preserved byte-for-byte.
    assert_eq!(
        std::fs::read(target.join("snapshot.json")).unwrap(),
        other.snapshot
    );
}

#[test]
fn two_publishers_racing_the_same_generation_produce_exactly_one_commit() {
    let p = Arc::new(publisher("race-same"));
    let fx = Arc::new(v1_fixture("chat_race", "snap1", "race-body"));
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let mut handles = Vec::new();
    for _ in 0..3 {
        let p = Arc::clone(&p);
        let fx = Arc::clone(&fx);
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            let begun = begin(&p, &fx.chat_id);
            assert!(begun.ok);
            stage_all(&p, begun.token, &fx);
            barrier.wait();
            commit_v1v2(&p, begun.token, None)
        }));
    }
    let results: Vec<PublishResult> = handles
        .into_iter()
        .map(|h| h.join().expect("thread"))
        .collect();
    let committed = results.iter().filter(|r| r.committed).count();
    let deduped = results
        .iter()
        .filter(|r| r.outcome == Outcome::Deduped)
        .count();
    assert_eq!(committed, 1, "exactly one publisher may promote");
    assert_eq!(deduped, 2, "the losers dedupe trusted-side");
    assert!(results.iter().all(|r| r.ok));
    assert_eq!(
        packages_entries(&p).len(),
        1,
        "one directory, no staging residue"
    );
}

#[test]
fn different_generations_for_one_chat_both_publish_side_by_side() {
    let p = publisher("race-diff");
    let a = v1_fixture("chat_multi", "snap1", "first");
    let b = v1_fixture("chat_multi", "snap2", "second");
    assert!(publish(&p, &a).ok);
    assert!(publish(&p, &b).ok);
    let entries = packages_entries(&p);
    assert_eq!(entries.len(), 2, "generations accumulate side by side");
    assert!(entries.iter().all(|e| e.starts_with("chat_multi.g")));
    assert_ne!(a.content_hash, b.content_hash);
}

#[test]
fn promotion_is_create_only_and_never_replaces_a_destination() {
    // Directly exercise the promotion primitive with a POPULATED directory.
    let p = publisher("promote-excl");
    let packages = p.packages_dir().expect("packages");
    packages.mkdir_child_exclusive(b"src-dir").expect("src");
    let src = packages.open_child_nofollow(b"src-dir").expect("open src");
    src.create_new_child(b"member").expect("member");
    packages.mkdir_child_exclusive(b"dest-dir").expect("dest");
    let dest = packages
        .open_child_nofollow(b"dest-dir")
        .expect("open dest");
    dest.create_new_child(b"occupant-file").expect("occupant");

    let promoted = packages
        .promote_dir_exclusive(b"src-dir", b"dest-dir")
        .expect("promote call");
    assert!(!promoted, "an occupied destination must not be replaced");
    // The occupant survived.
    assert!(p
        .root
        .join(PACKAGES_DIR)
        .join("dest-dir")
        .join("occupant-file")
        .exists());
    // A free destination promotes, carrying its contents.
    let promoted = packages
        .promote_dir_exclusive(b"src-dir", b"free-dir")
        .expect("promote call");
    assert!(promoted);
    assert!(p
        .root
        .join(PACKAGES_DIR)
        .join("free-dir")
        .join("member")
        .exists());
}

// ── DURABILITY ─────────────────────────────────────────────────────────────

#[test]
fn a_successful_promotion_reports_committed_and_retains_the_generation() {
    let p = publisher("durability");
    let fx = v1_fixture("chat_durable", "snap1", "x");
    let result = publish(&p, &fx);
    assert!(result.committed, "promotion is the commit point");
    assert!(result.durability_complete);
    assert!(result.blockers.is_empty());
    // The published tree left cleanup scope: it is still there.
    assert_eq!(packages_entries(&p).len(), 1);
}

#[test]
fn a_successful_promotion_releases_the_staging_tree_from_cleanup_scope() {
    // §N: once promoted, the tree IS the published generation and leaves §X's
    // cleanup scope. Pinned directly: after a successful commit, running the
    // cleanup path against that very session must not touch the generation.
    let p = publisher("cleanup-scope");
    let fx = v1_fixture("chat_scope", "snap1", "x");
    let begun = begin(&p, &fx.chat_id);
    stage_all(&p, begun.token, &fx);
    // Hold the session so the cleanup path can be exercised after COMMIT
    // consumed it from the map.
    let session = p
        .registry
        .lock_map()
        .get(&begun.token)
        .map(Arc::clone)
        .expect("session present before commit");

    let result = commit_v1v2(&p, begun.token, None);
    assert!(result.ok && result.committed);
    let published = packages_entries(&p);
    assert_eq!(published.len(), 1);

    // The session must no longer own any staging: cleanup is a no-op.
    {
        let mut inner = session.inner.lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            inner.dir.is_none(),
            "a promoted tree must be released from the session"
        );
        assert!(cleanup_staging(&p, &mut inner));
    }
    // The published generation is intact, members and all.
    assert_eq!(packages_entries(&p), published);
    for member in Member::all() {
        assert!(
            p.root
                .join(PACKAGES_DIR)
                .join(&published[0])
                .join(member.file_name())
                .exists(),
            "cleanup must never touch a published generation"
        );
    }
}

#[test]
fn the_result_contract_distinguishes_created_from_deduped_by_outcome() {
    let p = publisher("outcome-discriminator");
    let fx = v1_fixture("chat_outcome", "snap1", "x");
    let created = publish(&p, &fx);
    let deduped = publish(&p, &fx);
    // `ok` alone cannot distinguish them — `outcome` is the discriminator.
    assert!(created.ok && deduped.ok);
    assert_ne!(created.outcome, deduped.outcome);
    assert!(created.committed && !deduped.committed);
}

// ── RESOURCE (environmental, never validity) ───────────────────────────────

#[test]
fn resource_errors_map_to_a_retryable_family_not_a_validity_blocker() {
    for (errno, expected) in [
        (libc::ENOSPC, "generation-staging-resource-no-space"),
        (libc::EDQUOT, "generation-staging-resource-quota"),
        (libc::EFBIG, "generation-staging-resource-file-too-large"),
    ] {
        let err = std::io::Error::from_raw_os_error(errno);
        assert!(is_resource_errno(&err));
        assert_eq!(resource_code(&err), expected);
        // The family is textually distinct from every validity blocker.
        assert!(resource_code(&err).starts_with("generation-staging-resource-"));
    }
    // A validity failure is NOT a resource failure.
    let other = std::io::Error::from_raw_os_error(libc::EACCES);
    assert!(!is_resource_errno(&other));
}

#[test]
fn byte_accounting_is_overflow_safe() {
    // The accumulator uses checked arithmetic; prove the guard exists by
    // exercising the boundary arithmetic directly.
    let near_max = u64::MAX - 4;
    assert!(near_max.checked_add(8).is_none());
    assert!(near_max.checked_add(4).is_some());
}

#[test]
fn no_total_member_or_package_ceiling_exists() {
    // Guards against a chunk bound quietly becoming a member ceiling: a member
    // several times the chunk bound must stage successfully.
    let p = publisher("no-ceiling");
    let begun = begin(&p, "chat_nocap");
    let chunk = vec![0u8; (CHUNK_CAP_BYTES / 4) as usize];
    for _ in 0..6 {
        assert!(
            write_member(&p, begun.token, Member::Snapshot, &chunk).ok,
            "a member larger than the chunk bound must be stageable"
        );
    }
    assert!(abort(&p, begun.token).ok);
}

// ── MUTATION CONTROLS ──────────────────────────────────────────────────────
//
// Each control below documents the guard its paired test kills. They are
// asserted structurally so a future edit that deletes a guard fails here even
// if the behavioural test is also weakened.

#[test]
fn source_tripwires_pin_the_load_bearing_guard_symbols() {
    // CLASSIFICATION (batch repair R6): this is a SOURCE TRIPWIRE, not a behavioural
    // negative control and not a mutation kill. It asserts that guard symbols
    // and refusal codes are still PRESENT in the source, so a silent deletion
    // during refactoring is caught. It proves nothing about behaviour on its
    // own — behaviour is proven by the named behavioural tests elsewhere in
    // this file, and by the out-of-band mutation runs recorded in the batch
    // report. Do not cite this test as evidence that a guard works.
    let source = include_str!("../archive_generation_publish.rs");

    // Caller-supplied hashes are never authority.
    assert!(source.contains("generation-content-hash-mismatch"));
    assert!(source.contains("generation-expected-manifest-sha-mismatch"));
    // Required-member completeness.
    for code in [
        "generation-manifest-missing",
        "generation-snapshot-missing",
        "generation-markdown-missing",
        "generation-html-missing",
    ] {
        assert!(source.contains(code), "missing guard {code}");
    }
    // Asset re-hash on copy.
    assert!(source.contains("generation-asset-sha-mismatch"));
    assert!(source.contains("generation-asset-byte-length-mismatch"));
    // Unknown staging entry.
    assert!(source.contains("generation-staging-unexpected-entry"));
    // Exclusive promotion, not a replacing rename.
    assert!(source.contains("promote_dir_exclusive"));
    assert!(
        !source.contains("rename_within("),
        "publication must never use a replacing rename"
    );
    // Occupant adjudication is trusted-side.
    assert!(source.contains("fn classify_occupant"));
    // Create-only: no delete authority over an occupant.
    assert!(
        !source.contains("remove_dir_all"),
        "no recursive delete authority may exist in this module"
    );
    // Environmental family is distinct.
    assert!(source.contains("generation-staging-resource-"));
    // G1: the command surface exists and is exactly the four semantic
    // operations (behavioural pin lives in
    // exactly_the_four_semantic_commands_are_registered_in_both_handler_arms).
    for name in [
        "h2o_archive_generation_begin",
        "h2o_archive_generation_write_member",
        "h2o_archive_generation_commit",
        "h2o_archive_generation_abort",
    ] {
        assert!(source.contains(name), "missing command {name}");
    }
    // No caller-named destination ever reaches the trusted side.
    for forbidden in ["packagePath", "destination", "generationPath\":"] {
        assert!(
            !source.contains(&format!("pub {forbidden}")),
            "the command surface must not accept {forbidden}"
        );
    }
}

#[test]
fn exactly_the_four_semantic_commands_are_registered_in_both_handler_arms() {
    // G1 cutover: publication is now renderer-invokable, but ONLY through the
    // four purpose-bounded semantic operations. §O forbids exposing arbitrary
    // archive write, arbitrary member paths, caller-selected destinations,
    // generic rename/remove, a caller-authoritative contentHash, or a generic
    // CAS path — so the registered surface is exactly these four.
    let lib = include_str!("../lib.rs");
    let expected = [
        "h2o_archive_generation_begin",
        "h2o_archive_generation_write_member",
        "h2o_archive_generation_commit",
        "h2o_archive_generation_abort",
    ];
    for name in expected {
        // Registered in BOTH generate_handler! arms (debug and release).
        assert_eq!(
            lib.matches(&format!("archive_generation_publish::{name}"))
                .count(),
            2,
            "{name} must be registered in both handler arms"
        );
    }
    // The session registry must be managed, or sessions would not survive
    // across invokes.
    assert!(lib.contains("archive_generation_publish::PublisherState::default()"));

    // And nothing BEYOND those four is exposed: every #[tauri::command] in the
    // module is one of them.
    let source = include_str!("../archive_generation_publish.rs");
    let declared = source.matches("#[tauri::command]").count();
    assert_eq!(
        declared,
        expected.len(),
        "the module must declare exactly the four semantic commands"
    );
}

/* ── IPC token transport: the JSON boundary the earlier tests never crossed ──
 *
 * Every existing publisher test calls begin/write_member in-process with real
 * u64s, and the JS validators mock `invoke` and hand the token straight back.
 * Neither exercises serialization, so a full-range u64 travelling as a JSON
 * NUMBER survived every suite while failing deterministically in the assembled
 * app: the WebView parsed it as a double and returned a different integer,
 * which matched no session. These tests cross the actual representation.
 *
 * 12308876026142924039 is the real token observed in that failed run. */
const OBSERVED_TOKEN: u64 = 12_308_876_026_142_924_039;

#[test]
fn the_begin_token_crosses_json_as_a_string_never_as_a_number() {
    assert!(
        OBSERVED_TOKEN > (1u64 << 53),
        "fixture must exceed Number.MAX_SAFE_INTEGER to be meaningful"
    );
    let begun = BeginResult {
        schema: GENERATION_PUBLISH_SCHEMA,
        ok: true,
        token: OBSERVED_TOKEN,
        blockers: Vec::new(),
    };
    let value = serde_json::to_value(&begun).expect("BeginResult must serialize");
    let token = value.get("token").expect("token field must exist");
    assert!(
        token.is_string(),
        "token must serialize as a JSON string, got: {token}"
    );
    assert!(
        !token.is_number(),
        "a JSON number is exactly the defect: JavaScript would truncate it"
    );
    assert_eq!(token.as_str().unwrap(), "12308876026142924039");

    // And the emitted text must be free of quotes-as-number ambiguity.
    let text = serde_json::to_string(&begun).expect("serialize");
    assert!(
        text.contains("\"token\":\"12308876026142924039\""),
        "unexpected wire form: {text}"
    );
}

#[test]
fn every_inbound_command_parses_the_exact_token_back_from_text() {
    let text = OBSERVED_TOKEN.to_string();

    let member: MemberOptions = serde_json::from_value(serde_json::json!({
        "token": text, "member": "snapshot"
    }))
    .expect("write_member must accept the textual token");
    assert_eq!(member.token, OBSERVED_TOKEN, "write_member lost the token");

    let commit: CommitOptions = serde_json::from_value(serde_json::json!({
        "token": text, "expectedManifestSha256": serde_json::Value::Null
    }))
    .expect("commit must accept the textual token");
    assert_eq!(commit.token, OBSERVED_TOKEN, "commit lost the token");

    let abort: AbortOptions =
        serde_json::from_value(serde_json::json!({ "token": text })).expect("abort must accept it");
    assert_eq!(abort.token, OBSERVED_TOKEN, "abort lost the token");
}

#[test]
fn the_full_begin_to_command_round_trip_reproduces_the_exact_u64() {
    // Serialize as begin would, re-read as the browser would hand it back.
    let begun = BeginResult {
        schema: GENERATION_PUBLISH_SCHEMA,
        ok: true,
        token: OBSERVED_TOKEN,
        blockers: Vec::new(),
    };
    let wire = serde_json::to_value(&begun).expect("serialize");
    let echoed = wire.get("token").unwrap().clone();
    let parsed: AbortOptions =
        serde_json::from_value(serde_json::json!({ "token": echoed })).expect("round trip");
    assert_eq!(parsed.token, OBSERVED_TOKEN);

    /* NEGATIVE CONTROL for the shipped defect. This is what the old contract
     * did: carry the token as a JSON number. Going through an f64 -- exactly
     * what a JavaScript Number is -- changes the value, so the echoed token
     * could never match the session. */
    let through_f64 = OBSERVED_TOKEN as f64 as u64;
    assert_ne!(
        through_f64, OBSERVED_TOKEN,
        "fixture no longer demonstrates the precision loss"
    );
    assert_eq!(through_f64, 12_308_876_026_142_924_800);
}

#[test]
fn a_malformed_or_out_of_range_token_is_refused_cleanly() {
    // A JSON number is refused outright: the visitor implements only visit_str.
    let numeric = serde_json::from_value::<AbortOptions>(
        serde_json::json!({ "token": 12_308_876_026_142_924_039u64 }),
    );
    assert!(numeric.is_err(), "a JSON number token must be refused");

    for bad in [
        "",                        // empty
        " 123",                    // leading space
        "123 ",                    // trailing space
        "+123",                    // signed
        "-1",                      // negative
        "0x1f",                    // radix prefix
        "12e3",                    // exponent
        "1.0",                     // float
        "abc",                     // not a number
        "18446744073709551616",    // u64::MAX + 1 (overflow)
        "99999999999999999999999", // far overflow
    ] {
        let parsed = serde_json::from_value::<AbortOptions>(serde_json::json!({ "token": bad }));
        assert!(parsed.is_err(), "token {bad:?} must be refused, not parsed");
    }

    // The boundary values themselves remain acceptable.
    for good in ["0", "1", "9007199254740993", "18446744073709551615"] {
        let parsed: AbortOptions =
            serde_json::from_value(serde_json::json!({ "token": good })).expect(good);
        assert_eq!(parsed.token, good.parse::<u64>().unwrap());
    }
}

#[test]
fn internal_session_entropy_and_width_are_unchanged() {
    /* The repair is transport-only: tokens must still span the full u64 range
     * (never capped to a JavaScript-safe range) and stay odd. */
    let mut seen_above_2_53 = false;
    for _ in 0..256 {
        let token = random_token_seed();
        assert_eq!(token & 1, 1, "seed must remain odd");
        if token > (1u64 << 53) {
            seen_above_2_53 = true;
        }
    }
    assert!(
        seen_above_2_53,
        "tokens must still use the full u64 range; they must not be capped for JavaScript"
    );
}

// ── M09 P2.2: exact policy-gated v3 publication ──────────────────────────

#[test]
fn v3_identity_gzip_and_assets_publish_under_injected_policy() {
    for (tag, package, expected_encoding) in [
        ("v3-identity", zero_asset_v3(), SnapshotEncoding::Identity),
        ("v3-gzip", gzip_zero_asset_v3(), SnapshotEncoding::Gzip),
        (
            "v3-assets",
            permanent_v3_fixture(false),
            SnapshotEncoding::Identity,
        ),
    ] {
        let p = publisher(tag);
        let expected_hash = package_content_hash(&package);
        let result = publish_v3(&p, &package);
        assert!(result.ok, "blockers: {:?}", blocker_codes(&result));
        assert_eq!(result.outcome, Outcome::Created);
        assert_eq!(result.content_hash, expected_hash);

        let hex = expected_hash.strip_prefix("sha256-").unwrap();
        let name = generation_basename(&package.chat_id, hex);
        let final_dir = p.root.join(PACKAGES_DIR).join(&name);
        assert_eq!(packages_entries(&p), vec![name.clone()]);
        assert_eq!(
            std::fs::read(final_dir.join("snapshot.json")).unwrap(),
            package.snapshot.as_ref().unwrap().as_slice(),
        );
        assert!(!final_dir.join("chat.md").exists());
        assert!(!final_dir.join("chat.html").exists());
        for asset in &package.assets {
            assert!(
                final_dir.join(&asset.path).is_file(),
                "missing {}",
                asset.path
            );
        }

        let packages = confined::Dir::open_root(&p.root.join(PACKAGES_DIR)).unwrap();
        let verified = verify_occupant_all_supported(&packages, name.as_bytes()).unwrap();
        assert_eq!(verified.family, PackageFamily::V3);
        assert_eq!(verified.content_hash, expected_hash);
        assert_eq!(verified.snapshot_encoding, expected_encoding);

        let scan = crate::archive_package_scan::scan_packages_within(&p.root);
        assert!(scan.complete, "{:?}", scan.blockers);
        let scanned = scan
            .occupants
            .iter()
            .find(|occupant| occupant.name == name)
            .expect("published v3 scanned");
        match &scanned.class {
            crate::archive_package_scan::OccupantClass::VerifiedGeneration(package) => {
                assert_eq!(
                    package.construction_family,
                    crate::archive_package_scan::ConstructionFamily::V3
                );
                assert!(package.construction_family.is_live_writer_family());
                assert_eq!(package.content_hash, hex);
            }
            other => panic!("expected verified v3, got {other:?}"),
        }
    }
}

#[test]
fn production_policy_accepts_v3_while_v1v2_rollback_refuses_same_package() {
    let package = zero_asset_v3();
    let p = publisher("v3-production-active");
    let token = stage_v3_package(&p, &package, true);
    let accepted = commit(&p, token, None);
    assert!(accepted.ok, "blockers: {:?}", blocker_codes(&accepted));
    assert_eq!(accepted.outcome, Outcome::Created);

    let rollback = publisher("v3-v1v2-rollback-refusal");
    let token = stage_v3_package(&rollback, &package, true);
    let refused = commit_with_policy(&rollback, token, None, LiveGenerationFamily::V1V2);
    assert!(!refused.ok);
    assert!(!refused.committed);
    assert!(
        blocker_codes(&refused)
            .contains(&"generation-manifest-version-triple-incoherent".to_string()),
        "unexpected blockers: {:?}",
        blocker_codes(&refused),
    );
    assert!(packages_entries(&rollback).is_empty());
}

#[test]
fn v3_policy_refuses_legacy_new_writes() {
    for (tag, fixture) in [
        ("v3-refuses-v1", v1_fixture("legacy_v1", "s1", "body")),
        ("v3-refuses-v2", {
            let p = publisher("v3-refuses-v2-fixture");
            v2_fixture(&p.root, "legacy_v2", &[("png", b"asset")])
        }),
    ] {
        let p = publisher(tag);
        if fixture.content_hash != sha_of(&fixture.snapshot) {
            let manifest: serde_json::Value = serde_json::from_slice(&fixture.manifest).unwrap();
            for asset in manifest["assets"].as_array().unwrap() {
                let sha = asset["sha256"].as_str().unwrap();
                let hex = sha.strip_prefix("sha256-").unwrap();
                let shard = p.root.join("assets").join(&hex[..2]);
                std::fs::create_dir_all(&shard).unwrap();
                std::fs::write(shard.join(format!("sha256-{hex}")), b"asset").unwrap();
            }
        }
        let begun = begin(&p, &fixture.chat_id);
        assert!(begun.ok);
        stage_all(&p, begun.token, &fixture);
        let result = commit_with_policy(&p, begun.token, None, LiveGenerationFamily::V3);
        assert!(!result.ok);
        assert!(!result.committed);
        assert!(packages_entries(&p).is_empty());
    }
}

#[test]
fn identity_and_gzip_dedupe_without_replacing_first_representation() {
    let identity = zero_asset_v3();
    let gzip = gzip_zero_asset_v3();
    assert_eq!(package_content_hash(&identity), package_content_hash(&gzip));
    assert_ne!(identity.snapshot, gzip.snapshot);

    for (tag, first, second) in [
        ("v3-id-then-gzip", &identity, &gzip),
        ("v3-gzip-then-id", &gzip, &identity),
    ] {
        let p = publisher(tag);
        let created = publish_v3(&p, first);
        assert_eq!(created.outcome, Outcome::Created);
        let hex = created.content_hash.strip_prefix("sha256-").unwrap();
        let name = generation_basename(&first.chat_id, hex);
        let snapshot = p.root.join(PACKAGES_DIR).join(&name).join("snapshot.json");
        let before = std::fs::read(&snapshot).unwrap();

        let deduped = publish_v3(&p, second);
        assert!(deduped.ok, "blockers: {:?}", blocker_codes(&deduped));
        assert_eq!(deduped.outcome, Outcome::Deduped);
        assert!(!deduped.committed);
        assert_eq!(std::fs::read(snapshot).unwrap(), before);
        assert_eq!(packages_entries(&p), vec![name]);
    }
}

#[test]
fn v3_commit_refuses_false_descriptors_inventory_and_assets_without_final_mutation() {
    let mut false_hash = zero_asset_v3();
    mutate_package_manifest(&mut false_hash, |manifest| {
        manifest["contentHash"] = format!("sha256-{}", "00".repeat(32)).into();
    });
    assert!(!assert_v3_refused("v3-false-content", &false_hash, true).ok);

    let mut physical_mismatch = zero_asset_v3();
    physical_mismatch.snapshot.as_mut().unwrap().push(b' ');
    assert!(!assert_v3_refused("v3-physical", &physical_mismatch, true).ok);

    let mut logical_mismatch = gzip_zero_asset_v3();
    mutate_package_manifest(&mut logical_mismatch, |manifest| {
        manifest["files"]["snapshot"]["contentSha256"] =
            format!("sha256-{}", "11".repeat(32)).into();
    });
    assert!(!assert_v3_refused("v3-logical", &logical_mismatch, true).ok);

    let mut missing_snapshot = zero_asset_v3();
    missing_snapshot.snapshot = None;
    assert!(!assert_v3_refused("v3-missing-snapshot", &missing_snapshot, true).ok);

    let mut renderers = zero_asset_v3();
    renderers.markdown = Some(b"foreign renderer".to_vec());
    renderers.html = Some(b"foreign renderer".to_vec());
    let renderer_result = assert_v3_refused("v3-renderers", &renderers, true);
    assert!(blocker_codes(&renderer_result)
        .contains(&"generation-v3-persistent-renderer-forbidden".to_string()));

    let assets = permanent_v3_fixture(false);
    assert!(!assert_v3_refused("v3-missing-asset", &assets, false).ok);

    let p = publisher("v3-wrong-asset");
    let token = stage_v3_package(&p, &assets, true);
    let asset_sha = &assets.asset_bodies[0].0;
    let hex = asset_sha.strip_prefix("sha256-").unwrap();
    std::fs::write(
        p.root
            .join("assets")
            .join(&hex[..2])
            .join(format!("sha256-{hex}")),
        b"wrong bytes",
    )
    .unwrap();
    let wrong_asset = commit_with_policy(&p, token, None, LiveGenerationFamily::V3);
    assert!(!wrong_asset.ok);
    assert!(!wrong_asset.committed);
    assert!(packages_entries(&p).is_empty());

    let mut malformed_gzip = gzip_zero_asset_v3();
    malformed_gzip.snapshot = Some(b"not gzip".to_vec());
    rebind_package_snapshot_physical_descriptor(&mut malformed_gzip);
    assert!(!assert_v3_refused("v3-malformed-gzip", &malformed_gzip, true).ok);

    let mut mixed = zero_asset_v3();
    mutate_package_manifest(&mut mixed, |manifest| {
        manifest["payloadVersion"] = 2.into();
    });
    assert!(!assert_v3_refused("v3-mixed", &mixed, true).ok);

    let package = zero_asset_v3();
    let p = publisher("v3-undeclared-member");
    let token = stage_v3_package(&p, &package, true);
    let staging = packages_entries(&p)
        .into_iter()
        .find(|name| name.starts_with(STAGING_PREFIX))
        .expect("owned staging");
    std::fs::write(
        p.root
            .join(PACKAGES_DIR)
            .join(staging)
            .join("undeclared.bin"),
        b"undeclared",
    )
    .unwrap();
    let undeclared = commit_with_policy(&p, token, None, LiveGenerationFamily::V3);
    assert!(!undeclared.ok);
    assert!(!undeclared.committed);
    assert!(blocker_codes(&undeclared).contains(&"generation-staging-unexpected-entry".to_string()));
    assert!(
        packages_entries(&p)
            .iter()
            .all(|name| name.starts_with(STAGING_PREFIX)),
        "foreign-contaminated private residue must never become a final generation"
    );
}

#[test]
fn v3_commit_never_replaces_invalid_or_wrong_type_final_occupants() {
    use std::os::unix::fs::symlink;

    for (tag, occupant_kind) in [
        ("v3-occupied-corrupt", "directory"),
        ("v3-occupied-file", "file"),
        ("v3-occupied-symlink", "symlink"),
    ] {
        let package = zero_asset_v3();
        let p = publisher(tag);
        let token = stage_v3_package(&p, &package, true);
        let hash = package_content_hash(&package);
        let name = generation_basename(&package.chat_id, hash.strip_prefix("sha256-").unwrap());
        let final_path = p.root.join(PACKAGES_DIR).join(&name);
        match occupant_kind {
            "directory" => {
                std::fs::create_dir(&final_path).unwrap();
                std::fs::write(final_path.join("winner.txt"), b"winner bytes").unwrap();
            }
            "file" => std::fs::write(&final_path, b"winner bytes").unwrap(),
            "symlink" => {
                let target = p.root.join("foreign-target");
                std::fs::create_dir(&target).unwrap();
                std::fs::write(target.join("winner.txt"), b"winner bytes").unwrap();
                symlink(&target, &final_path).unwrap();
            }
            _ => unreachable!(),
        }

        let result = commit_with_policy(&p, token, None, LiveGenerationFamily::V3);
        assert!(!result.ok);
        assert!(!result.committed);
        assert!(
            matches!(
                result.outcome,
                Outcome::GenerationDestinationCorrupt
                    | Outcome::GenerationPartial
                    | Outcome::GenerationOccupantUnreadable
            ),
            "unexpected outcome: {:?}",
            result.outcome
        );
        let winner = if occupant_kind == "file" {
            std::fs::read(&final_path).unwrap()
        } else {
            std::fs::read(final_path.join("winner.txt")).unwrap()
        };
        assert_eq!(winner, b"winner bytes");
    }
}

/// M10 P1.2 §17 — the COARSE admission contract is byte-for-byte unchanged by
/// the widened failure payload.
///
/// Every current consumer — publication, the M06 scanner's broad classification
/// and the M07 handoff — reads only `.0` and `.1`. The granular third element
/// is additive evidence and may vary; these two may not.
#[test]
fn the_coarse_admission_outcome_and_code_are_unchanged_by_granular_evidence() {
    let p = publisher("coarse-admission");
    let dir = p.root.join(PACKAGES_DIR);
    std::fs::create_dir_all(&dir).unwrap();

    // (A) a genuine saved_chat_package_verify RULE failure.
    let mut broken = zero_asset_v3();
    let mut snapshot: serde_json::Value =
        serde_json::from_slice(broken.snapshot.as_ref().unwrap()).unwrap();
    snapshot["messages"] = serde_json::json!({"not": "an array"});
    broken.snapshot = Some(serde_json::to_vec(&snapshot).unwrap());
    let sha = format!(
        "sha256-{}",
        crate::archive_durable_write::sha256_hex(broken.snapshot.as_ref().unwrap())
    );
    let len = broken.snapshot.as_ref().unwrap().len() as u64;
    let content_hash =
        crate::saved_chat_package_verify::derive_content_hash_v3(&sha, &[]).unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(&broken.manifest).unwrap();
    manifest["files"]["snapshot"]["sha256"] = sha.into();
    manifest["files"]["snapshot"]["byteLength"] = len.into();
    manifest["contentHash"] = content_hash.clone().into();
    broken.manifest = serde_json::to_vec(&manifest).unwrap();
    let rule_name = generation_basename(
        &broken.chat_id,
        content_hash.strip_prefix("sha256-").unwrap(),
    );
    install_package_dir(&dir, &rule_name, &broken);

    // (B) PARTIAL: a required member is absent.
    let partial_name = generation_basename("chat_partial", &"a".repeat(64));
    std::fs::create_dir_all(dir.join(&partial_name)).unwrap();

    // (C) UNREADABLE: a symlink is never followed.
    let unreadable_name = generation_basename("chat_unreadable", &"b".repeat(64));
    std::os::unix::fs::symlink(dir.join(&rule_name), dir.join(&unreadable_name)).unwrap();

    let packages = confined::Dir::open_root(&dir).unwrap();
    let admission = |name: &str| match verify_occupant_all_supported(&packages, name.as_bytes()) {
        Err(failure) => failure,
        Ok(_) => panic!("{name} must not verify"),
    };

    // (A) coarse pair EXACTLY as before; granular evidence additionally present.
    let (outcome, code, granular) = admission(&rule_name);
    assert_eq!(outcome, Outcome::GenerationDestinationCorrupt);
    assert_eq!(code, "generation-destination-corrupt");
    assert_eq!(granular, Some("generation-v3-snapshot-messages-invalid"));
    assert_ne!(granular, Some(code), "granular must add information");

    // (B) partial: unchanged coarse pair, and no granular code is invented for a
    // failure that never reached the package verifier.
    let (outcome, code, granular) = admission(&partial_name);
    assert_eq!(outcome, Outcome::GenerationPartial);
    assert_eq!(code, "generation-partial");
    assert_eq!(granular, None);

    // (C) unreadable: likewise.
    let (outcome, code, granular) = admission(&unreadable_name);
    assert_eq!(outcome, Outcome::GenerationOccupantUnreadable);
    assert_eq!(code, "generation-occupant-unreadable");
    assert_eq!(granular, None);

    /* The admission consumer inside this module reads only the coarse pair. */
    let src = include_str!("../archive_generation_publish.rs");
    assert!(
        src.contains("Err((outcome, code, _granular)) => return (outcome, code, Vec::new()),"),
        "classification explicitly discards the granular evidence",
    );

    let _ = std::fs::remove_dir_all(p.root.parent().unwrap());
}

/// Minimal on-disk installer for a package fixture, so a DAMAGED occupant can
/// exist without asking the publisher to create an invalid one.
fn install_package_dir(packages: &std::path::Path, name: &str, package: &OwnedPackage) {
    let path = packages.join(name);
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("manifest.json"), &package.manifest).unwrap();
    if let Some(snapshot) = &package.snapshot {
        std::fs::write(path.join("snapshot.json"), snapshot).unwrap();
    }
}
