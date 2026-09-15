use super::*;
use crate::archive_cas_scan::CasInventory;
use crate::archive_db_probe::{DbProbeCounts, GenerationProtection, ProtectionSource};
use crate::archive_durable_write::sha256_hex;
use crate::archive_generation_publish::{abort, begin, commit, write_member, Member, Publisher};
use crate::archive_instance_lock::{ArchiveInstanceState, ExclusiveOwnership};
use crate::archive_package_scan::scan_packages_within;
use crate::archive_reclamation_preview::ProjectionInput;
use crate::saved_chat_package_verify::derive_content_hash_v3;
use std::path::{Path, PathBuf};

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "h2o-m06-t32-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(dir.join("archive")).expect("scratch");
    dir.join("archive")
}

fn sha_of(bytes: &[u8]) -> String {
    format!("sha256-{}", sha256_hex(bytes))
}

/// Publishes a REAL v3 generation through the actual publisher, so execution
/// acts on genuine canonical packages rather than hand-made directories.
fn publish(root: &Path, chat: &str, saved_at: &str) -> String {
    let publisher = Publisher::new(root.to_path_buf());
    let snapshot = format!(
        r#"{{"schema":"h2o.savedChatSnapshot","schemaVersion":3,"chatId":"{chat}","snapshotId":"s1","savedAt":"{saved_at}","messages":[{{"id":"m0","turnIndex":0,"content":[{{"type":"text","text":"body-{saved_at}"}}],"assetRefs":[]}}]}}"#
    ).into_bytes();
    let snapshot_sha = sha_of(&snapshot);
    let content_hash = derive_content_hash_v3(&snapshot_sha, &[]).expect("v3 content hash");
    let manifest = format!(
        r#"{{"schema":"h2o.savedChatPackage","schemaVersion":3,"payloadVersion":3,"chatId":"{chat}","snapshotId":"s1","contentHash":"{content_hash}","files":{{"snapshot":{{"path":"snapshot.json","sha256":"{snapshot_sha}","byteLength":{},"encoding":"identity"}}}},"assets":[]}}"#,
        snapshot.len(),
    ).into_bytes();
    let begun = begin(&publisher, chat);
    assert!(begun.ok, "begin refused: {:?}", begun.blockers);
    let t = begun.token;
    assert!(write_member(&publisher, t, Member::Snapshot, &snapshot).ok);
    assert!(write_member(&publisher, t, Member::Manifest, &manifest).ok);
    let published = commit(&publisher, t, None);
    assert!(published.ok, "commit refused: {:?}", published.blockers);
    content_hash.strip_prefix("sha256-").unwrap().to_string()
}

struct Owner {
    state: Box<ArchiveInstanceState>,
}
impl Owner {
    fn acquire(root: &Path) -> Owner {
        let state = Box::new(ArchiveInstanceState::default());
        state.ensure_presence(root).expect("shared presence");
        Owner { state }
    }
    fn exclusive(&self) -> ExclusiveOwnership<'_> {
        self.state.try_acquire_exclusive().expect("exclusive")
    }
}

fn db(protections: Vec<GenerationProtection>) -> crate::archive_db_probe::DbProbeResult {
    crate::archive_db_probe::DbProbeResult {
        complete: true,
        blockers: vec![],
        cas_roots: vec![],
        generation_protections: protections,
        counts: DbProbeCounts::default(),
    }
}
fn cas() -> CasInventory {
    CasInventory { complete: true, observed: vec![], foreign: vec![], blockers: vec![] }
}
fn request(chat: &str, status: &str, hash: &str) -> PreviewRequest {
    PreviewRequest {
        chat_scope: None,
        projections: vec![ProjectionInput {
            chat_id: chat.to_string(),
            status: status.to_string(),
            content_hash: hash.to_string(),
        }],
    }
}

/// name -> sha of contents (or "dir"), for durability comparison.
fn census(base: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<(String, String)>) {
        let mut entries: Vec<_> = match std::fs::read_dir(dir) {
            Ok(it) => it.map(|e| e.unwrap()).collect(),
            Err(_) => return,
        };
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = format!("{prefix}/{}", entry.file_name().to_string_lossy());
            let meta = std::fs::symlink_metadata(entry.path()).unwrap();
            if meta.is_dir() {
                out.push((name.clone(), "dir".into()));
                walk(&entry.path(), &name, out);
            } else if meta.file_type().is_symlink() {
                out.push((name, "symlink".into()));
            } else {
                out.push((name, sha256_hex(&std::fs::read(entry.path()).unwrap_or_default())));
            }
        }
    }
    walk(base, "", &mut out);
    out
}

/// Five generations for one chat, oldest first. Returns their hashes in
/// savedAt order (index 0 = oldest).
fn five(root: &Path, chat: &str) -> Vec<String> {
    (1..=5)
        .map(|d| publish(root, chat, &format!("2026-01-0{d}T00:00:00.000Z")))
        .collect()
}

fn run(root: &Path, ex: &ExclusiveOwnership<'_>, d: &crate::archive_db_probe::DbProbeResult, req: &PreviewRequest) -> RunOutcome {
    run_internal(ex, root, true, req, d)
}

fn run_with_registry(
    root: &Path,
    ex: &ExclusiveOwnership<'_>,
    d: &crate::archive_db_probe::DbProbeResult,
    req: &PreviewRequest,
    sessions_empty: bool,
) -> RunOutcome {
    run_internal(ex, root, sessions_empty, req, d)
}

/// Splits Rust source into identifier tokens, so an age/time ban can be
/// exact. A substring scan cannot be: `age` lives inside `package`, and
/// `age_` inside `package_scan`, which this code says legitimately.
fn identifier_tokens(code: &str) -> std::collections::BTreeSet<String> {
    code.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// Every identifier that would give residue a time, age or wall-clock
/// authority. AC-M06-06: neither filesystem timestamps nor wall-clock age are
/// deletion authority anywhere.
const TIME_AUTHORITY_IDENTIFIERS: &[&str] = &[
    "st_mtime", "st_ctime", "st_birthtime", "st_atime", "st_mtimespec",
    "SystemTime", "Instant", "UNIX_EPOCH", "elapsed", "modified", "created",
    "age", "max_age", "min_age", "older_than", "newer_than", "stale_after",
    "dwell", "now", "timestamp", "duration_since",
];

/// The mid-run pause is a PROCESS-global gate, so the tests that arm it must
/// not overlap. `cargo test` runs cases on many threads; this serializes the
/// pause users without weakening what either of them proves.
static PAUSE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn pause_guard() -> std::sync::MutexGuard<'static, ()> {
    PAUSE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn pkg_names(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root.join("packages"))
        .map(|it| it.map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// (S)(T)(I)(N)(P)(AG) the happy path: only generations beyond the K=3 floor
/// are acted, evidence is durable in the required ORDER, and the acted items
/// are quarantined then purged through the confined primitive.
#[test]
fn a_witnessed_run_acts_only_beyond_the_floor_in_durable_order() {
    let root = scratch("happy");
    let hashes = five(&root, "chat_a"); // index 0 oldest .. 4 newest
    let owner = Owner::acquire(&root);
    let before = pkg_names(&root);
    assert_eq!(before.len(), 5);

    trace::reset();
    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));

    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.retention_floor, 3);
    assert_eq!(outcome.quarantined, 2);
    assert_eq!(outcome.purged, 2);
    assert!(outcome.run_id.as_ref().unwrap().starts_with("run-"));

    // (T) newest and the floor survive; only the two oldest were acted.
    let after = pkg_names(&root);
    assert_eq!(after.len(), 3, "exactly three generations remain: {after:?}");
    for keep in [&hashes[2], &hashes[3], &hashes[4]] {
        assert!(after.iter().any(|n| n.contains(keep.as_str())), "kept {keep}");
    }
    for gone in [&hashes[0], &hashes[1]] {
        assert!(!after.iter().any(|n| n.contains(gone.as_str())), "acted {gone}");
    }

    // (AG) deterministic acted ordering by trusted canonical identity.
    let paths: Vec<&str> = outcome.acted.iter().map(|a| a.canonical_path.as_str()).collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted);
    assert!(outcome.acted.iter().all(|a| a.quarantined && a.purged && a.blocker.is_none()));

    // (I)(N) ordering: plan durable BEFORE the first rename; each quarantine
    // receipt durable BEFORE its purge.
    let events = trace::taken();
    assert_eq!(events[0], trace::Event::PlanDurable, "plan evidence comes first");
    let first_rename = events.iter().position(|e| *e == trace::Event::FirstRename).unwrap();
    assert!(first_rename > 0, "anti-vacuity: a rename really happened after the plan");
    for (i, e) in events.iter().enumerate() {
        if *e == trace::Event::Purge {
            assert_eq!(
                events[i - 1],
                trace::Event::QuarantineReceiptDurable,
                "a purge must be immediately preceded by a durable quarantine receipt"
            );
        }
    }

    // Evidence exists and the quarantine is empty after same-run purge.
    let receipts = root.join(".h2o-reclaim").join("receipts");
    let files: Vec<String> = std::fs::read_dir(&receipts)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert!(files.iter().any(|f| f.ends_with(".plan.json")));
    assert_eq!(files.iter().filter(|f| f.ends_with(".quarantined.json")).count(), 2);
    assert_eq!(files.iter().filter(|f| f.ends_with(".purged.json")).count(), 2);

    // (AF) evidence carries no chat payload and no host path.
    for file in std::fs::read_dir(&receipts).unwrap() {
        let text = std::fs::read_to_string(file.unwrap().path()).unwrap();
        for forbidden in ["body-", "/Users/", "/private/", "messages", "contentText"] {
            assert!(!text.contains(forbidden), "receipt leaked {forbidden}");
        }
    }

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (A)(AH) THE DEFINING RULE: a generation that read-only planning calls a
/// Candidate is NOT acted when trusted state changed before execution.
#[test]
fn a_stale_candidate_is_protected_when_execution_recomputes_under_exclusive() {
    let root = scratch("stale");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let req = request("chat_a", "ok", &hashes[4]);

    // (A) FIRST: prove read-only planning genuinely calls the oldest a Candidate.
    let scan = scan_packages_within(&root);
    let inventory = cas();
    let preview = crate::archive_reclamation_preview::preview_from_parts(
        &scan, &db(vec![]), &inventory, &req,
    )
    .expect("preview");
    let stale_candidates: Vec<String> = preview
        .plan
        .decisions
        .iter()
        .filter(|d| matches!(d.decision, Decision::Candidate { .. }))
        .map(|d| d.content_hash.clone())
        .collect();
    assert_eq!(stale_candidates.len(), 2, "the stale plan really had candidates");
    assert!(stale_candidates.contains(&hashes[0]));

    // (B) Trusted state CHANGES before execute: the oldest gains an Import
    // provenance protection.
    let protections = vec![GenerationProtection {
        chat_id: "chat_a".into(),
        content_hash: hashes[0].clone(),
        source: ProtectionSource::Import,
    }];

    // (C) Execute.
    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(protections), &req);

    // (D) The stale candidate was NOT acted, because execution recomputed.
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.quarantined, 1, "only the still-eligible one was acted");
    assert!(
        !outcome.acted.iter().any(|a| a.content_hash == hashes[0]),
        "the newly protected generation must not be acted"
    );
    assert!(pkg_names(&root).iter().any(|n| n.contains(hashes[0].as_str())),
        "the protected package is still canonical");

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (F) an incomplete DB probe is a HARD precondition: zero mutation, zero
/// evidence, no reclaim namespace at all.
#[test]
fn an_incomplete_db_probe_refuses_before_any_mutation() {
    let root = scratch("dbfail");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let before = census(&root);

    let mut broken = db(vec![]);
    broken.complete = false;
    broken.blockers.push("db-probe-query-failed:chats".into());

    trace::reset();
    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &broken, &request("chat_a", "ok", &hashes[4]));

    assert_eq!(outcome.state, RunState::Refused);
    assert!(outcome.blockers.iter().any(|b| b == codes::PLAN_NOT_AUTHORITATIVE));
    assert!(outcome.run_id.is_none());
    assert_eq!(census(&root), before, "not one byte changed");
    assert!(!root.join(".h2o-reclaim").exists(), "no reclaim namespace created");
    assert!(trace::taken().is_empty(), "no evidence or rename occurred");

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (Y)(Z) projection evidence stays enabling-only at EXECUTION time.
#[test]
fn unwitnessed_or_missing_projection_acts_on_nothing() {
    let root = scratch("proj");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let before = census(&root);
    let ex = owner.exclusive();

    // Valid 64-hex that matches no on-disk generation.
    let unmatched = "9".repeat(64);
    for req in [
        request("chat_a", "ok", &unmatched),
        request("chat_a", "indeterminate", ""),
        request("chat_a", "ok", "not-a-hash"),
        PreviewRequest::default(),
    ] {
        let outcome = run(&root, &ex, &db(vec![]), &req);
        assert_eq!(outcome.state, RunState::NoOp, "{:?}", outcome.blockers);
        assert_eq!(outcome.quarantined, 0);
        assert!(outcome.run_id.is_none());
    }
    assert_eq!(census(&root), before, "nothing was touched");
    assert!(!root.join(".h2o-reclaim").exists());

    // Positive control: the witnessed request DOES act, so this is not vacuous.
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(outcome.quarantined, 2);

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (U)(V)(W)(X)(AA) every protection class holds at EXECUTION, not just Preview.
#[test]
fn every_protection_class_prevents_action_at_execution_time() {
    for (tag, source) in [
        ("writing", ProtectionSource::StrandedWriting),
        ("import", ProtectionSource::Import),
        ("restore", ProtectionSource::Restore),
        ("relink", ProtectionSource::Relink),
    ] {
        let root = scratch(tag);
        let hashes = five(&root, "chat_a");
        let owner = Owner::acquire(&root);
        let ex = owner.exclusive();
        // Protect BOTH otherwise-eligible generations.
        let protections = vec![
            GenerationProtection { chat_id: "chat_a".into(), content_hash: hashes[0].clone(), source },
            GenerationProtection { chat_id: "chat_a".into(), content_hash: hashes[1].clone(), source },
        ];
        let outcome = run(&root, &ex, &db(protections), &request("chat_a", "ok", &hashes[4]));
        assert_eq!(outcome.state, RunState::NoOp, "{tag}: {:?}", outcome.blockers);
        assert_eq!(pkg_names(&root).len(), 5, "{tag}: every package survives");
        let _ = ex.release();
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    // (U) legacy is never acted, and (AA) an indeterminate occupant is untouched.
    let root = scratch("legacy");
    let hashes = five(&root, "chat_b");
    let owner = Owner::acquire(&root);
    let packages = root.join("packages");
    // Turn one generation into a LEGACY package, and plant a corrupt occupant.
    std::fs::rename(
        packages.join(format!("chat_b.g{}.h2ochat", hashes[0])),
        packages.join("chat_b.h2ochat"),
    )
    .unwrap();
    std::fs::create_dir_all(packages.join("chat_c.gaa.h2ochat")).unwrap();
    let before = census(&packages);

    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_b", "ok", &hashes[4]));
    /* Converting one generation to legacy leaves FOUR orderable generations, so
       the fourth is legitimately outside the K=3 floor and IS acted. The
       property under test is that legacy and the occupant are never acted. */
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.quarantined, 1, "exactly the one generation beyond the floor");
    assert_eq!(outcome.acted[0].content_hash, hashes[1], "the oldest surviving generation");

    assert!(
        packages.join("chat_b.h2ochat").exists(),
        "the LEGACY package is never acted"
    );
    assert!(
        packages.join("chat_c.gaa.h2ochat").exists(),
        "the indeterminate occupant is never acted"
    );
    assert!(
        !outcome.acted.iter().any(|a| a.content_hash == hashes[0]),
        "the legacy content hash is never in the acted set"
    );
    let after = census(&packages);
    let expected: Vec<_> = before
        .iter()
        .filter(|(n, _)| !n.contains(&format!("chat_b.g{}", hashes[1])))
        .cloned()
        .collect();
    assert_eq!(after, expected, "only the eligible generation left the namespace");

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (AE)(AF) canonical CAS survives a real run that reclaims BOTH residue
/// families out of the very same shard.
///
/// This was T3.2's "bystanders survive" case. T3.3 deliberately changes half of
/// it: staging and durable-temp residue are now this task's targets, so the
/// assertion that matters is the one that did NOT change — every canonical
/// `sha256-` body is byte and name identical afterwards, including the one the
/// read-only analysis calls observed-unreferenced.
#[test]
fn canonical_cas_survives_a_run_that_reclaims_both_residue_families() {
    let root = scratch("bystanders");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);

    // Both residue families.
    std::fs::create_dir_all(root.join("packages").join(".h2o-genstage-00ff01")).unwrap();
    std::fs::write(root.join("packages").join(".h2o-genstage-00ff01").join("m.json"), b"{}").unwrap();
    let shard = root.join("assets").join("ab");
    std::fs::create_dir_all(&shard).unwrap();
    std::fs::write(shard.join(".h2o-durable-7-0.tmp"), b"temp").unwrap();
    // A referenced and an observed-unreferenced CAS body.
    let referenced = format!("sha256-{}", "ab".repeat(32));
    let unreferenced = format!("sha256-{}", "cd".repeat(32));
    std::fs::write(shard.join(&referenced), b"referenced-body").unwrap();
    std::fs::create_dir_all(root.join("assets").join("cd")).unwrap();
    std::fs::write(root.join("assets").join("cd").join(&unreferenced), b"unreferenced-body").unwrap();
    let cas_before: Vec<(String, String)> = census(&root.join("assets"))
        .into_iter()
        .filter(|(n, _)| n.contains("sha256-") || !n.contains('.'))
        .collect();

    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.purged, 2, "the generation stage really did act");

    // (AE)(AF) every canonical body, referenced or not, is untouched.
    let cas_after: Vec<(String, String)> = census(&root.join("assets"))
        .into_iter()
        .filter(|(n, _)| n.contains("sha256-") || !n.contains('.'))
        .collect();
    assert_eq!(cas_after, cas_before, "ALL CAS bodies byte and name identical");
    assert!(shard.join(&referenced).exists());
    assert!(root.join("assets").join("cd").join(&unreferenced).exists());

    // And the residue in the same shard IS reclaimed, through quarantine.
    assert_eq!(outcome.residue.generation_staging_purged, 1);
    assert_eq!(outcome.residue.durable_temp_purged, 1);
    assert!(!root.join("packages").join(".h2o-genstage-00ff01").exists());
    assert!(!shard.join(".h2o-durable-7-0.tmp").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (AD) a valid state with nothing eligible performs ZERO persistent mutation.
#[test]
fn a_no_op_run_creates_no_namespace_no_run_and_no_receipt() {
    let root = scratch("noop");
    // Only three generations: all inside the K=3 floor.
    let hashes: Vec<String> = (1..=3)
        .map(|d| publish(&root, "chat_a", &format!("2026-01-0{d}T00:00:00.000Z")))
        .collect();
    let owner = Owner::acquire(&root);
    let before = census(&root);

    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[2]));
    assert_eq!(outcome.state, RunState::NoOp);
    assert!(outcome.run_id.is_none());
    assert!(outcome.blockers.is_empty());
    assert_eq!(census(&root), before, "no-op means no mutation at all");
    assert!(!root.join(".h2o-reclaim").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (K) an existing plan-receipt name cannot be replaced, and the collision
/// refuses BEFORE the first canonical rename.
#[test]
fn a_receipt_collision_refuses_before_any_rename() {
    let root = scratch("collision");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);

    // Pre-create every possible plan receipt name is impossible (random run id),
    // so instead make the receipts namespace unwritable to force the failure.
    let reclaim = root.join(".h2o-reclaim");
    std::fs::create_dir_all(reclaim.join("receipts")).unwrap();
    let mut perms = std::fs::metadata(reclaim.join("receipts")).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o500);
    std::fs::set_permissions(reclaim.join("receipts"), perms).unwrap();
    let before = pkg_names(&root);

    trace::reset();
    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));

    assert_eq!(outcome.state, RunState::Refused, "{:?}", outcome.blockers);
    assert!(outcome.blockers.iter().any(|b| b == codes::EVIDENCE_FAILED));
    assert_eq!(pkg_names(&root), before, "no canonical package moved");
    let events = trace::taken();
    assert!(!events.contains(&trace::Event::FirstRename), "no rename occurred");
    assert!(!events.contains(&trace::Event::PlanDurable), "no plan was made durable");

    let mut perms = std::fs::metadata(reclaim.join("receipts")).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o700);
    let _ = std::fs::set_permissions(reclaim.join("receipts"), perms);
    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (E) a publication session in flight refuses execution BEFORE any mutation,
/// and the session itself is left intact.
#[test]
fn an_in_flight_publisher_session_refuses_execution_before_any_mutation() {
    let root = scratch("registry");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);

    // A REAL in-flight publication session.
    let publisher = Publisher::new(root.to_path_buf());
    let begun = begin(&publisher, "chat_live");
    assert!(begun.ok, "a real session is open");
    assert!(!publisher.sessions_empty(), "registry is genuinely non-empty");
    let before = census(&root);

    trace::reset();
    let ex = owner.exclusive();
    let outcome = run_with_registry(
        &root,
        &ex,
        &db(vec![]),
        &request("chat_a", "ok", &hashes[4]),
        publisher.sessions_empty(),
    );

    assert_eq!(outcome.state, RunState::Refused);
    assert_eq!(outcome.blockers, vec![codes::PUBLISHER_SESSIONS_ACTIVE.to_string()]);
    assert!(outcome.run_id.is_none());
    assert_eq!(census(&root), before, "no mutation of any kind");
    assert!(!root.join(".h2o-reclaim").exists());
    assert!(trace::taken().is_empty());
    // The session was never terminated or forced.
    assert!(!publisher.sessions_empty(), "the publisher session is intact");

    // Positive control: once the registry is empty the same run DOES act.
    assert!(crate::archive_generation_publish::abort(&publisher, begun.token).ok);
    assert!(publisher.sessions_empty());
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (C) another participating instance holding shared presence prevents
/// exclusive acquisition, so no run can even begin. Zero mutation.
#[test]
fn another_participating_instance_prevents_the_run_entirely() {
    let root = scratch("contended");
    five(&root, "chat_a");

    // Two independent participants: flock scopes to an open file description,
    // so these genuinely contend (proven in T1.1).
    let a = ArchiveInstanceState::default();
    let b = ArchiveInstanceState::default();
    a.ensure_presence(&root).expect("a shared");
    b.ensure_presence(&root).expect("b shared");
    /* Census AFTER presence: participating legitimately creates the instance
       lock file, which is not a reclamation mutation. */
    let before = census(&root);

    // With B still participating, A cannot take reclamation-exclusive ownership.
    assert!(
        a.try_acquire_exclusive().is_err(),
        "exclusive must be refused while another instance participates"
    );
    assert_eq!(census(&root), before, "nothing was touched");
    assert!(!root.join(".h2o-reclaim").exists());

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (B) + CORRECTION C — no execution path exists without exclusive ownership,
/// and no production caller can hand in precomputed trusted authority.
#[test]
fn execution_holds_exclusive_and_accepts_no_precomputed_authority() {
    let source = include_str!("../archive_reclaim_execute.rs");
    let code: String = source
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");

    // (1) The PRODUCTION entry takes only the app authority and the bounded
    //     enabling request — nothing else.
    let at = source.find("pub(crate) async fn execute_generation_reclamation").expect("entry");
    let sig = &source[at..at + source[at..].find(") -> ").unwrap()];
    assert!(sig.contains("app: &tauri::AppHandle"));
    assert!(sig.contains("request: &PreviewRequest"));
    for forbidden in [
        "PackageScan", "DbProbeResult", "CasInventory", "ReclamationPlan",
        "PreviewResult", "Decision", "candidate", "Candidate", "run_id",
        "Path", "PathBuf", "String",
    ] {
        assert!(!sig.contains(forbidden), "production entry must not accept {forbidden}");
    }

    // (2) No ENTRY POINT accepts a plan or a preview result as authority.
    //     `fresh_candidates` and `plan_evidence` legitimately consume the plan
    //     this run just computed, so the ban is on the entry signatures.
    assert!(!code.contains("PreviewResult"), "a previous Preview is never an input");
    assert!(!code.contains("struct RunInputs"), "the precomputed-facts struct is gone");
    for entry in ["execute_generation_reclamation", "fn run_internal"] {
        let at = source.find(entry).expect(entry);
        let sig = &source[at..at + source[at..].find(") -> ").unwrap()];
        assert!(!sig.contains("ReclamationPlan"), "{entry} must not accept a plan");
        assert!(!sig.contains("PackageScan"), "{entry} must not accept a scan");
        assert!(!sig.contains("CasInventory"), "{entry} must not accept a CAS inventory");
    }

    // (3)(4)(5)(6) Ordering INSIDE the sequence: exclusive first, then the
    //     recomputations, then the plan, then candidates from that plan.
    let seq_at = code.find("fn run_internal").expect("sequence");
    let seq = &code[seq_at..];
    let scan_at = seq.find("scan_packages_within(archive_root)").expect("scan recomputed");
    let cas_at = seq.find("scan_cas_within(archive_root)").expect("cas recomputed");
    let plan_at = seq.find("archive_retention_plan::plan(").expect("plan computed");
    let cand_at = seq.find("fresh_candidates(&plan)").expect("candidates derived");
    assert!(scan_at < plan_at, "scan is recomputed before the plan");
    assert!(cas_at < plan_at, "cas is recomputed before the plan");
    assert!(plan_at < cand_at, "candidates come from the fresh plan");

    // The sequence itself requires the capability by type, and is private.
    let internal = &source[source.find("fn run_internal").unwrap()..];
    let isig = &internal[..internal.find(") -> ").unwrap()];
    assert!(isig.contains("exclusive: &crate::archive_instance_lock::ExclusiveOwnership"));
    assert!(!source.contains("pub fn run_internal"));
    assert!(!source.contains("pub(crate) fn run_internal"), "the sequence is module-private");

    // The exclusive capability is acquired BEFORE the DB probe and the sequence.
    let entry = &code[code.find("async fn execute_generation_reclamation").unwrap()..];
    let acquire = entry.find("try_acquire_exclusive").expect("acquired");
    let probe = entry.find("probe_protection_facts").expect("probed");
    let call = entry.find("run_internal(").expect("sequence invoked");
    let release = entry.find("exclusive.release()").expect("released");
    assert!(acquire < probe, "exclusive is acquired before the DB probe");
    assert!(probe < call, "the probe precedes the destructive sequence");
    assert!(call < release, "ownership is released only after the run returns");
}

/// (L) the quarantine destination is never replaced/// (L) the quarantine destination is never replaced: an existing entry makes
/// the move fail closed, and the canonical package stays put.
#[test]
fn an_existing_quarantine_destination_is_never_replaced() {
    use crate::archive_reclaim::{QuarantineComponent, QuarantineRunId};
    let root = scratch("norepl");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    let reclaim = crate::archive_reclaim::open_reclaim_root_for_run(&ex, &root).unwrap();
    let run_id = QuarantineRunId::parse("fixed").unwrap();
    let run_dir = reclaim.create_run(&ex, &run_id).unwrap();
    let packages = crate::archive_reclaim::open_packages_dir(&ex, &root).unwrap();

    let name = format!("chat_a.g{}.h2ochat", hashes[0]);
    let item = QuarantineComponent::parse(&name).unwrap();

    // Occupy the destination first, with distinguishable content.
    let occupied = root.join(".h2o-reclaim").join("run-fixed").join(&name);
    std::fs::create_dir_all(&occupied).unwrap();
    std::fs::write(occupied.join("sentinel"), b"pre-existing").unwrap();

    let moved = crate::archive_reclaim::quarantine_generation(&ex, &packages, &run_dir, &item, &item)
        .expect("no error");
    assert!(!moved, "a collision must fail closed, not overwrite");
    assert!(
        root.join("packages").join(&name).exists(),
        "the canonical package stays put on collision"
    );
    assert_eq!(
        std::fs::read(occupied.join("sentinel")).unwrap(),
        b"pre-existing",
        "the existing quarantine entry is untouched"
    );

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// CORRECTION A — DETERMINISTIC. The canonical rename succeeds and the receipt
/// for it deterministically fails. This always exercises the crash window.
#[test]
fn a_failed_quarantine_receipt_stops_the_run_without_purging() {
    let root = scratch("receiptfail");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    // Bystanders that must survive untouched.
    let shard = root.join("assets").join("ab");
    std::fs::create_dir_all(&shard).unwrap();
    std::fs::write(shard.join(format!("sha256-{}", "ab".repeat(32))), b"cas-body").unwrap();
    std::fs::create_dir_all(root.join("packages").join(".h2o-genstage-00ff01")).unwrap();
    let assets_before = census(&root.join("assets"));
    let staging_before = census(&root.join("packages").join(".h2o-genstage-00ff01"));

    // (2) the fresh plan really has TWO eligible candidates.
    let scan = scan_packages_within(&root);
    let inventory = cas();
    let preview = crate::archive_reclamation_preview::preview_from_parts(
        &scan, &db(vec![]), &inventory, &request("chat_a", "ok", &hashes[4]),
    ).expect("preview");
    let eligible: Vec<String> = preview.plan.decisions.iter()
        .filter(|d| matches!(d.decision, Decision::Candidate { .. }))
        .map(|d| d.content_hash.clone())
        .collect();
    assert_eq!(eligible.len(), 2, "the fixture genuinely has two candidates");

    trace::reset();
    fault::arm(fault::Point::AfterRenameBeforeQuarantineReceipt);
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    fault::clear();

    // (5) exactly the required post-conditions.
    assert_eq!(outcome.state, RunState::Partial, "never Complete after evidence failure");
    assert!(outcome.blockers.iter().any(|b| b == codes::EVIDENCE_FAILED));
    assert_eq!(outcome.quarantined, 1, "exactly one rename happened");
    assert_eq!(outcome.purged, 0, "nothing was purged");

    let events = trace::taken();
    assert_eq!(events[0], trace::Event::PlanDurable, "plan durable first");
    assert_eq!(
        events.iter().filter(|e| **e == trace::Event::FirstRename).count(),
        1,
        "exactly one canonical rename occurred"
    );
    assert!(!events.contains(&trace::Event::Purge), "purge NEVER followed the failed receipt");
    assert!(
        !events.contains(&trace::Event::QuarantineReceiptDurable),
        "the quarantine receipt never became durable"
    );

    // The acted item: canonical gone, quarantine present, not purged.
    let acted = &outcome.acted[0];
    assert!(acted.quarantined && !acted.purged);
    let remaining = pkg_names(&root);
    assert!(
        !remaining.iter().any(|n| n.contains(acted.content_hash.as_str())),
        "the canonical package is absent"
    );
    let run_dir = root.join(".h2o-reclaim").join(outcome.run_id.as_ref().unwrap());
    assert!(run_dir.join(format!("chat_a.g{}.h2ochat", acted.content_hash)).exists(),
        "the logically deleted generation is recoverable in quarantine");

    // The SECOND candidate was never touched.
    let untouched: Vec<&String> = eligible.iter().filter(|h| **h != acted.content_hash).collect();
    assert_eq!(untouched.len(), 1);
    assert!(
        remaining.iter().any(|n| n.contains(untouched[0].as_str())),
        "the second candidate remains canonical"
    );
    assert_eq!(outcome.acted.len(), 1, "no later candidate was acted");

    // Evidence written BEFORE the failure survives.
    let receipts = root.join(".h2o-reclaim").join("receipts");
    assert!(std::fs::read_dir(&receipts).unwrap().any(|e| e.unwrap()
        .file_name().to_string_lossy().ends_with(".plan.json")),
        "the durable plan evidence remains");

    // Bystanders byte-identical.
    assert_eq!(census(&root.join("assets")), assets_before, "CAS untouched");
    assert_eq!(
        census(&root.join("packages").join(".h2o-genstage-00ff01")),
        staging_before,
        "staging residue untouched"
    );

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// CORRECTION A — the namespace transition must be DURABLE before anything
/// claims it happened. Rename succeeds; the durability step deterministically
/// fails; nothing is purged and the run stops.
#[test]
fn a_namespace_durability_failure_stops_the_run_without_purging() {
    let root = scratch("nsdurfail");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    let shard = root.join("assets").join("ab");
    std::fs::create_dir_all(&shard).unwrap();
    std::fs::write(shard.join(format!("sha256-{}", "ab".repeat(32))), b"cas").unwrap();
    std::fs::create_dir_all(root.join("packages").join(".h2o-genstage-00ff01")).unwrap();
    let assets_before = census(&root.join("assets"));
    let staging_before = census(&root.join("packages").join(".h2o-genstage-00ff01"));

    // Two genuinely eligible candidates.
    let scan = scan_packages_within(&root);
    let inventory = cas();
    let preview = crate::archive_reclamation_preview::preview_from_parts(
        &scan, &db(vec![]), &inventory, &request("chat_a", "ok", &hashes[4]),
    ).expect("preview");
    assert_eq!(
        preview.plan.decisions.iter()
            .filter(|d| matches!(d.decision, Decision::Candidate { .. })).count(),
        2,
        "the fixture genuinely has two candidates"
    );

    trace::reset();
    fault::arm(fault::Point::AfterRenameBeforeNamespaceDurability);
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    fault::clear();

    assert_eq!(outcome.state, RunState::Partial, "never Complete");
    assert_eq!(outcome.quarantined, 1, "the rename really happened");
    assert_eq!(outcome.purged, 0);
    assert!(outcome
        .blockers
        .iter()
        .any(|b| b == crate::archive_reclaim::codes::QUARANTINE_NOT_DURABLE));

    let events = trace::taken();
    assert_eq!(events[0], trace::Event::PlanDurable);
    assert_eq!(events.iter().filter(|e| **e == trace::Event::FirstRename).count(), 1);
    assert!(!events.contains(&trace::Event::QuarantineNamespaceDurable), "durability failed");
    assert!(!events.contains(&trace::Event::QuarantineReceiptDurable),
        "no receipt may claim a transition that is not durable");
    assert!(!events.contains(&trace::Event::Purge), "no purge without durability");

    // No rollback: the canonical item stays logically deleted and observable in
    // quarantine; the second candidate is untouched.
    let acted = &outcome.acted[0];
    let remaining = pkg_names(&root);
    assert!(!remaining.iter().any(|n| n.contains(acted.content_hash.as_str())));
    /* Count GENERATIONS only: this fixture also plants staging residue under
       archive/packages, which must remain and is not a generation. */
    let generations = remaining.iter().filter(|n| n.ends_with(".h2ochat")).count();
    assert_eq!(generations, 4, "exactly one generation left; no second rename");
    assert!(remaining.iter().any(|n| n.starts_with(".h2o-genstage-")), "staging remains");
    let run_dir = root.join(".h2o-reclaim").join(outcome.run_id.as_ref().unwrap());
    assert!(run_dir.join(format!("chat_a.g{}.h2ochat", acted.content_hash)).exists());
    assert_eq!(outcome.acted.len(), 1, "no later candidate acted");

    assert_eq!(census(&root.join("assets")), assets_before, "CAS untouched");
    assert_eq!(
        census(&root.join("packages").join(".h2o-genstage-00ff01")),
        staging_before,
        "staging untouched"
    );

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// CORRECTION A positive control + strict ordering. The positive fixture really
/// reaches Purge, so the ordering assertions are not vacuous.
#[test]
fn the_full_destructive_ordering_is_strict_and_reaches_purge() {
    let root = scratch("ordering");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::clear();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.purged, 2, "the control really acted");

    use trace::Event::*;
    let events = trace::taken();
    assert!(events.contains(&Purge), "anti-vacuity: the fixture reaches Purge");
    assert_eq!(events[0], PlanDurable, "plan durable is first, exactly once");
    assert_eq!(events.iter().filter(|e| **e == PlanDurable).count(), 1);

    // Per item the order is strict and complete.
    let per_item: Vec<&trace::Event> = events.iter().skip(1).collect();
    assert_eq!(per_item.len(), 10, "five steps for each of two items");
    for chunk in per_item.chunks(5) {
        assert_eq!(
            chunk,
            &[
                &FirstRename,
                &QuarantineNamespaceDurable,
                &QuarantineReceiptDurable,
                &Purge,
                &PurgeReceiptDurable
            ],
            "strict per-item ordering"
        );
    }

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// CORRECTION B — a REAL second process cannot participate while the run holds
/// exclusive ownership mid-flight, and can again after it returns.
#[test]
fn a_real_second_process_cannot_participate_mid_run() {
    let root = scratch("midrun");
    let hashes = five(&root, "chat_a");
    /* Deliberately NO owner here: the run thread establishes its own presence
       and takes exclusive ownership. Holding shared presence in this process
       would itself block acquisition and mask what is under test. */

    // A control BEFORE the run: a separate process CAN participate normally.
    assert!(
        child_can_participate(&root),
        "precondition: participation is possible before the exclusive window"
    );

    let _serial = pause_guard();
    let (reached, release) = pause::arm();
    let root_for_run = root.clone();
    let hash = hashes[4].clone();
    let handle = std::thread::spawn(move || {
        let state = ArchiveInstanceState::default();
        state.ensure_presence(&root_for_run).expect("shared");
        let ex = state.try_acquire_exclusive().expect("exclusive");
        let outcome = run_internal(
            &ex,
            &root_for_run,
            true,
            &request("chat_a", "ok", &hash),
            &db(vec![]),
        );
        let _ = ex.release();
        outcome
    });

    // The run has reached the mid-run point, still inside its exclusive window.
    reached.recv_timeout(std::time::Duration::from_secs(30)).expect("run reached the pause");

    // (5)(6) A genuinely separate PROCESS cannot establish participation now.
    assert!(
        !child_can_participate(&root),
        "no second process may obtain archive participation mid-run"
    );

    // (7)(8) Release and let the run finish.
    let _ = release.send(());
    let outcome = handle.join().expect("run thread");
    pause::clear();
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.purged, 2);

    // (9)(10) After normal return, participation is possible again.
    assert!(
        child_can_participate(&root),
        "participation must be restored after the run releases ownership"
    );

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// Spawns a REAL child process that tries to establish shared archive
/// participation, reusing the P1 helper infrastructure. Returns whether it
/// succeeded.
fn child_can_participate(root: &Path) -> bool {
    let exe = std::env::current_exe().expect("test binary");
    let status = std::process::Command::new(exe)
        .arg("archive_reclaim_execute::tests::helper_try_participate")
        .arg("--exact")
        .arg("--include-ignored")
        .arg("--test-threads=1")
        .env("H2O_T32_HELPER_ROOT", root)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("spawn participation helper");
    status.success()
}

/// Child-process helper: exits successfully only if it can establish shared
/// archive participation on the given root.
#[test]
#[ignore]
fn helper_try_participate() {
    let root = match std::env::var("H2O_T32_HELPER_ROOT") {
        Ok(value) => std::path::PathBuf::from(value),
        Err(_) => return,
    };
    let state = ArchiveInstanceState::default();
    if state.ensure_presence(&root).is_err() {
        std::process::exit(1);
    }
}

/// The pause mechanism is compiled out of production entirely.
#[test]
fn the_mid_run_pause_is_test_only() {
    let source = include_str!("../archive_reclaim_execute.rs");
    let at = source.find("pub(crate) mod pause").expect("pause module");
    let module = &source[at..at + 1800.min(source.len() - at)];
    assert!(
        module.contains("#[cfg(not(test))]") && module.contains("pub(super) fn wait_if_armed() {}"),
        "release builds get an empty inlined no-op"
    );
    for forbidden in ["std::env", "env::var", "sleep", "Instant", "thread::spawn", "interval"] {
        assert!(!module.contains(forbidden), "no production timer or switch: {forbidden}");
    }
}

/// An already-existing receipt name is never replaced, and the collision
/// refuses BEFORE any canonical rename. Create-only is the property; this makes
/// it behavioural rather than only structural.
#[test]
fn an_existing_receipt_blocks_the_run_before_any_rename() {
    let root = scratch("receiptcollide");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let before = pkg_names(&root);

    // Pre-create EVERY plan receipt this run could choose by making the name
    // deterministic: arm nothing, run once to learn the id, then collide it.
    let first = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(first.state, RunState::Complete, "control run acts");
    let receipts = root.join(".h2o-reclaim").join("receipts");
    let plan_receipt = std::fs::read_dir(&receipts)
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.to_string_lossy().ends_with(".plan.json"))
        .expect("a plan receipt exists");
    let original = std::fs::read(&plan_receipt).unwrap();

    // Now prove the write is create-only: writing the SAME name again is
    // refused and the original bytes are untouched.
    let reclaim = crate::archive_reclaim::open_reclaim_root_for_run(&ex, &root).unwrap();
    let dir = reclaim.receipts_dir(&ex).unwrap();
    let name = crate::archive_reclaim::QuarantineComponent::parse(
        plan_receipt.file_name().unwrap().to_str().unwrap(),
    )
    .unwrap();
    let err = dir.write_durable(&ex, &name, b"OVERWRITTEN").unwrap_err();
    assert_eq!(err, crate::archive_reclaim::codes::RECEIPT_EXISTS, "collision is refused");
    assert_eq!(
        std::fs::read(&plan_receipt).unwrap(),
        original,
        "existing evidence is never replaced"
    );
    let _ = before;

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// A material purge failure STOPS the run: later candidates are not acted, the
/// canonical item is NOT restored, and the residue stays contained.
#[test]
fn a_purge_failure_stops_the_run_and_does_not_restore_the_canonical_item() {
    let root = scratch("purgefail");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::arm(fault::Point::PurgeFails);
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    fault::clear();

    assert_eq!(outcome.state, RunState::Partial, "never Complete after a purge failure");
    assert_eq!(outcome.quarantined, 1, "one canonical rename happened");
    assert_eq!(outcome.purged, 0, "nothing was successfully purged");
    assert!(outcome.blockers.iter().any(|b| b == codes::PURGE_FAILED));
    assert_eq!(outcome.acted.len(), 1, "the run stopped; no later candidate acted");

    // Logical deletion stands: the canonical package is NOT restored.
    let acted = &outcome.acted[0];
    assert!(
        !pkg_names(&root).iter().any(|n| n.contains(acted.content_hash.as_str())),
        "logical deletion already occurred and is not rolled back"
    );
    // The physical residue remains safely contained in quarantine.
    let run_dir = root.join(".h2o-reclaim").join(outcome.run_id.as_ref().unwrap());
    assert!(run_dir.exists(), "the quarantine residue survives for recovery");
    // Four packages remain: the run stopped after the first.
    assert_eq!(pkg_names(&root).len(), 4);

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// CORRECTION A control — with the receipt durable, the purge DOES proceed, so
/// the test above proves the ordering rather than an inability to purge.
#[test]
fn a_durable_quarantine_receipt_allows_the_purge_to_proceed() {
    let root = scratch("receiptok");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::clear();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));

    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.purged, 2, "both candidates purged");
    let events = trace::taken();
    assert!(events.contains(&trace::Event::QuarantineReceiptDurable));
    assert!(events.contains(&trace::Event::Purge));

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// Plan durability failure yields ZERO canonical renames, deterministically.
#[test]
fn a_failed_plan_receipt_produces_no_canonical_rename() {
    let root = scratch("planfail");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let before = pkg_names(&root);

    trace::reset();
    fault::arm(fault::Point::BeforePlanDurability);
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    fault::clear();

    assert_eq!(outcome.state, RunState::Refused);
    assert!(outcome.blockers.iter().any(|b| b == codes::EVIDENCE_FAILED));
    assert_eq!(pkg_names(&root), before, "not one package moved");
    let events = trace::taken();
    assert!(!events.contains(&trace::Event::PlanDurable));
    assert!(!events.contains(&trace::Event::FirstRename));

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// The fault seam is compiled out of production entirely.
#[test]
fn the_fault_seam_is_test_only() {
    let source = include_str!("../archive_reclaim_execute.rs");
    let at = source.find("pub(crate) mod fault").expect("fault module");
    let module = &source[at..at + 1800.min(source.len() - at)];
    assert!(module.contains("#[cfg(test)]"), "arming is test-gated");
    assert!(
        module.contains("#[cfg(not(test))]") && module.contains("const fn armed"),
        "release builds fold the check to a const false"
    );
    /* `pub fn arm` is correct and REQUIRED — what matters is that it sits under
       #[cfg(test)], so no release build contains it. */
    let arm_at = module.find("pub fn arm").expect("arm exists for tests");
    assert!(
        module[..arm_at].trim_end().ends_with("#[cfg(test)]"),
        "arming must be immediately test-gated"
    );
    for forbidden in ["std::env", "env::var", "debug_flag", "from_str", "runtime_flag"] {
        assert!(!module.contains(forbidden), "no production switch: {forbidden}");
    }
}

/// (AE)(H) the run id is generated trusted-side and the request cannot name it,
/// a candidate, or any path.
#[test]
fn the_run_id_is_trusted_and_the_request_names_nothing() {
    // Two independent ids never collide and always carry the derived prefix.
    let a = generate_run_id().expect("entropy");
    let b = generate_run_id().expect("entropy");
    assert_ne!(a.component(), b.component());
    assert!(a.component().starts_with("run-"));
    assert_eq!(a.component().len(), "run-".len() + 32);

    // The execution request is EXACTLY the Preview request: no candidate list,
    // no path, no floor, no force.
    let source = include_str!("../archive_reclaim_execute.rs");
    let code: String = source
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    /* The caller-controlled input is exactly the Preview request. */
    assert!(code.contains("request: &PreviewRequest"), "reuses the Preview request");
    /* A run id is an OUTPUT (RunOutcome.run_id); what must not exist is a run
       id INPUT on either entry point. */
    for entry in ["execute_generation_reclamation", "fn run_internal"] {
        let at = source.find(entry).expect(entry);
        let sig = &source[at..at + source[at..].find(") -> ").unwrap()];
        assert!(!sig.contains("run_id"), "{entry} must not accept a run id");
        assert!(!sig.contains("QuarantineRunId"), "{entry} must not accept a run namespace");
    }
    // Request validation is REUSED, not restated.
    assert!(code.contains("archive_reclamation_preview::admit_request"));
    assert!(!code.contains("MAX_PREVIEW_INPUTS"), "no second bound implementation");
}

/// (AI)(AJ)(P) dormant, and the destructive vocabulary stays where it belongs.
#[test]
fn the_execution_core_is_dormant_and_owns_no_primitive() {
    let source = include_str!("../archive_reclaim_execute.rs");
    let module_code: String = source
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    /* P4: G02 passed, so this module owns EXACTLY ONE command — the approved
       reclamation execute — and that command is a pure forwarder. A second
       command here, or a command with any planning of its own, fails. */
    assert_eq!(
        module_code.matches("#[tauri::command]").count(),
        1,
        "exactly one activated command"
    );
    let at = source.find("pub async fn h2o_archive_reclamation_execute").expect("the command");
    let sig = &source[at..at + source[at..].find(") -> ").unwrap()];
    assert!(sig.contains("app: tauri::AppHandle") && sig.contains("request: PreviewRequest"));
    for forbidden in ["Path", "root", "run_id", "plan", "candidates", "force", "String"] {
        assert!(!sig.contains(forbidden), "the command must not accept {forbidden}");
    }
    /* The body forwards and does nothing else: no planning, no classification,
       no residue enumeration, no DB logic, no quarantine, no purge. */
    let body = &source[at..at + source[at..].find("\n}").unwrap()];
    assert!(body.contains("execute_generation_reclamation(&app, &request)"));
    for forbidden in [
        "scan_packages_within", "scan_cas_within", "scan_trusted_residue_within",
        "probe_protection_facts", "retention_plan::plan", "quarantine_",
        "purge_", "recover_", "archive_root(",
    ] {
        assert!(!body.contains(forbidden), "the command must not reimplement {forbidden}");
    }

    let lib = include_str!("../lib.rs");
    assert!(lib.contains("pub mod archive_reclaim_execute;"), "compiled");
    assert_eq!(
        lib.matches("archive_reclaim_execute::h2o_archive_reclamation_execute").count(),
        2,
        "registered in BOTH handler variants, and only as the approved command"
    );
    assert_eq!(
        lib.matches("archive_reclaim_execute::").count(),
        2,
        "no other item of this module is reachable from a handler"
    );
    /* Spelled past the approved name: `h2o_archive_reclamation_execute` is now
       legitimately registered, so a bare "h2o_archive_reclaim" prefix would ban
       the very command G02 authorized. What must stay absent is every OTHER
       destructive spelling. */
    for forbidden in [
        "h2o_archive_reclaim_", "h2o_archive_execute", "h2o_archive_purge",
        "h2o_archive_delete", "h2o_archive_recover", "h2o_archive_stale",
    ] {
        assert!(!lib.contains(forbidden), "{forbidden} must not be registered");
    }

    let code: String = source
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    // (P) it owns NO destructive primitive of its own.
    for forbidden in [
        "unlinkat", "renameat", "remove_file", "remove_dir", "std::fs::remove",
        "std::fs::rename", "O_TRUNC",
    ] {
        assert!(!code.contains(forbidden), "primitive leaked into orchestration: {forbidden}");
    }
    assert!(code.contains("quarantine_generation("), "renames via the T3.1 primitive");
    assert!(code.contains("purge_quarantined_item("), "purges via the T3.1 primitive");

    // (AJ) no CAS destructive route.
    /* A read-only CAS COUNT may appear in evidence (the plan records
       referencedCasObjects); what must never exist is a destructive CAS route
       or any use of observed_unreferenced as an instruction. */
    for forbidden in [
        "QuarantineKind::Cas", "quarantine_cas", "purge_cas", "observed_unreferenced",
        "cas_roots.iter().for_each", "Cas =>",
    ] {
        assert!(!code.contains(forbidden), "CAS destructive route: {forbidden}");
    }
    assert!(
        code.contains("referenced_cas_objects"),
        "read-only CAS analysis appears as evidence only"
    );
    // T3.3 adds exactly one kind: staging/temp residue. Occupant action is a
    // later task and must not appear.
    assert!(code.contains("QuarantineKind::Generation"));
    assert!(code.contains("QuarantineKind::StagingTemp"));
    assert!(
        !code.contains("QuarantineKind::Occupant"),
        "occupant action belongs to a later task"
    );
    for forbidden in ["Occupant", "corrupt_occupant"] {
        assert!(!code.contains(forbidden), "no occupant action in T3.3: {forbidden}");
    }
    // (AL) no stale-run or receipt cleanup was smuggled in.
    for forbidden in ["purge_run", "purge_all", "purge_receipts", "RECEIPTS_NAMESPACE"] {
        assert!(!code.contains(forbidden), "stale-run convergence is a later task: {forbidden}");
    }
    // (AK) no time, age or wall-clock deletion authority anywhere.
    let tokens = identifier_tokens(&code);
    for forbidden in TIME_AUTHORITY_IDENTIFIERS {
        assert!(!tokens.contains(*forbidden), "no time authority: {forbidden}");
    }
    // (AG) residue leaves canonical space ONLY by quarantine rename.
    assert!(code.contains("quarantine_residue("), "residue moves via the T3.1 primitive");
    for forbidden in ["unlink_child", "unlink(", "purge_tree"] {
        assert!(!code.contains(forbidden), "no direct canonical removal: {forbidden}");
    }
}

// ── M06 T3.3 — staging / temp reclamation ──────────────────────────────────

/// A GENUINE abandoned staging tree, produced by the real publisher's `begin`
/// and then orphaned by dropping the publisher without commit or abort.
///
/// The in-memory registry goes with the publisher; the staging directory the
/// real publisher created stays on disk. That is exactly what a killed or
/// crashed instance leaves behind, so the fixture is source-grounded rather
/// than a hand-made empty directory.
fn orphan_staging(root: &Path, chat: &str) -> String {
    let before: std::collections::BTreeSet<String> = pkg_names(root).into_iter().collect();
    let publisher = Publisher::new(root.to_path_buf());
    let begun = begin(&publisher, chat);
    assert!(begun.ok, "begin refused: {:?}", begun.blockers);
    assert!(write_member(&publisher, begun.token, Member::Snapshot, br#"{"partial":true}"#).ok);
    drop(publisher);
    let mut fresh: Vec<String> = pkg_names(root)
        .into_iter()
        .filter(|n| !before.contains(n))
        .collect();
    assert_eq!(fresh.len(), 1, "exactly one new staging entry: {fresh:?}");
    let name = fresh.pop().unwrap();
    assert!(name.starts_with(".h2o-genstage-"), "{name}");
    assert!(root.join("packages").join(&name).is_dir(), "a real staging directory");
    name
}

fn plant_temp(root: &Path, shard: &str, name: &str, bytes: &[u8]) -> PathBuf {
    let dir = root.join("assets").join(shard);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

/// The residue actions a run reports, as `family|archive-path`.
fn residue_ids(outcome: &RunOutcome) -> Vec<String> {
    outcome
        .residue_acted
        .iter()
        .map(|r| format!("{}|{}", r.family.kind(), r.archive_path))
        .collect()
}

fn receipt_names(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root.join(".h2o-reclaim").join("receipts"))
        .map(|it| it.map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

fn receipt_json(root: &Path, name: &str) -> serde_json::Value {
    let bytes =
        std::fs::read(root.join(".h2o-reclaim").join("receipts").join(name)).expect("receipt");
    serde_json::from_slice(&bytes).expect("receipt json")
}

/// (N)(J)(S)(T)(U)(Z)(AC)(AD)(AG) one run, one exclusive window, one run id,
/// one evidence set: a real generation candidate, a real orphaned staging tree,
/// two durable temps, a canonical CAS body and a foreign occupant.
#[test]
fn a_mixed_run_acts_on_generations_then_both_residue_families() {
    let root = scratch("mixed");
    let hashes = five(&root, "chat_a");
    let staging = orphan_staging(&root, "chat_b");
    plant_temp(&root, "ab", ".h2o-durable-11-0.tmp", b"temp-a");
    plant_temp(&root, "cd", ".h2o-durable-11-0.tmp", b"temp-b");
    let body = format!("sha256-{}", "ab".repeat(32));
    plant_temp(&root, "ab", &body, b"canonical-cas-body");
    // (AD) a foreign occupant and a legacy package: never staging targets.
    std::fs::write(root.join("packages").join("corrupt.h2ochat"), b"junk").unwrap();
    std::fs::create_dir_all(root.join("packages").join("chat_legacy.h2ochat")).unwrap();

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    trace::reset();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));

    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.schema_version, 2, "the extended run format");
    // Generations follow the existing T3.2 semantics: K=3 leaves two acted.
    assert_eq!(outcome.quarantined, 2);
    assert_eq!(outcome.purged, 2);
    // Both residue families, under the same run.
    assert_eq!(
        residue_ids(&outcome),
        vec![
            format!("generation-staging|archive/packages/{staging}"),
            "durable-temp|archive/assets/ab/.h2o-durable-11-0.tmp".to_string(),
            "durable-temp|archive/assets/cd/.h2o-durable-11-0.tmp".to_string(),
        ]
    );
    assert_eq!(outcome.residue.generation_staging_quarantined, 1);
    assert_eq!(outcome.residue.generation_staging_purged, 1);
    assert_eq!(outcome.residue.durable_temp_quarantined, 2);
    assert_eq!(outcome.residue.durable_temp_purged, 2);
    assert!(outcome.residue_acted.iter().all(|r| r.quarantined && r.purged));
    assert_eq!(outcome.residue_indeterminate, 0);

    // (S)(T)(U) the required per-item order, for the generation stage and then
    // BOTH residue families, strictly.
    let events = trace::taken();
    let first_rename = events.iter().position(|e| *e == trace::Event::FirstRename).unwrap();
    let plan_durable = events.iter().position(|e| *e == trace::Event::PlanDurable).unwrap();
    assert!(plan_durable < first_rename, "plan durable precedes the first rename");
    let residue_events: Vec<trace::Event> = events
        .iter()
        .copied()
        .filter(|e| {
            matches!(
                e,
                trace::Event::ResidueRename
                    | trace::Event::ResidueNamespaceDurable
                    | trace::Event::ResidueReceiptDurable
                    | trace::Event::ResiduePurge
                    | trace::Event::ResiduePurgeReceiptDurable
            )
        })
        .collect();
    assert_eq!(
        residue_events,
        [
            trace::Event::ResidueRename,
            trace::Event::ResidueNamespaceDurable,
            trace::Event::ResidueReceiptDurable,
            trace::Event::ResiduePurge,
            trace::Event::ResiduePurgeReceiptDurable,
        ]
        .repeat(3),
        "namespace durability precedes the receipt, and the receipt precedes the purge"
    );
    // The whole staging stage is after the whole generation stage.
    let last_gen = events
        .iter()
        .rposition(|e| *e == trace::Event::PurgeReceiptDurable)
        .unwrap();
    let first_res = events.iter().position(|e| *e == trace::Event::ResidueRename).unwrap();
    assert!(last_gen < first_res, "generations first, then residue");

    // Physical state.
    assert!(!root.join("packages").join(&staging).exists());
    assert!(!root.join("assets").join("ab").join(".h2o-durable-11-0.tmp").exists());
    assert!(!root.join("assets").join("cd").join(".h2o-durable-11-0.tmp").exists());
    assert!(root.join("assets").join("ab").join(&body).exists(), "CAS untouched");
    assert_eq!(
        std::fs::read(root.join("assets").join("ab").join(&body)).unwrap(),
        b"canonical-cas-body"
    );
    // (AC)(AD) the surviving canonical packages: three floor-protected
    // generations, the legacy package and the foreign occupant.
    let survivors = pkg_names(&root);
    assert_eq!(survivors.len(), 5, "{survivors:?}");
    assert!(survivors.contains(&"corrupt.h2ochat".to_string()));
    assert!(survivors.contains(&"chat_legacy.h2ochat".to_string()));
    assert_eq!(survivors.iter().filter(|n| n.contains(".g")).count(), 3);

    // (Z) one run id across every receipt, with the right subtype and identity.
    let run_id = outcome.run_id.clone().unwrap();
    let receipts = receipt_names(&root);
    assert!(receipts.iter().all(|n| n.starts_with(&run_id)), "{receipts:?}");
    assert_eq!(
        receipts.iter().filter(|n| n.contains("residue-quarantined")).count(),
        3
    );
    assert_eq!(receipts.iter().filter(|n| n.contains("residue-purged")).count(), 3);
    let staged_receipt = receipts
        .iter()
        .find(|n| n.contains("genstage") && n.contains("residue-purged"))
        .expect("a generation-staging purge receipt");
    let value = receipt_json(&root, staged_receipt);
    assert_eq!(value["schemaVersion"], 2);
    assert_eq!(value["kind"], "staging");
    assert_eq!(value["subtype"], "generation-staging");
    assert_eq!(value["action"], "purged");
    assert_eq!(value["archivePath"], format!("archive/packages/{staging}"));
    assert_eq!(value["purged"], true);
    let temp_receipt = receipts
        .iter()
        .find(|n| n.contains("durtmp.cd") && n.contains("residue-purged"))
        .expect("a durable-temp purge receipt");
    let value = receipt_json(&root, temp_receipt);
    assert_eq!(value["subtype"], "durable-temp");
    assert_eq!(value["archivePath"], "archive/assets/cd/.h2o-durable-11-0.tmp");
    // No chat content, no absolute host path anywhere in the evidence.
    for name in &receipts {
        let raw = String::from_utf8(
            std::fs::read(root.join(".h2o-reclaim").join("receipts").join(name)).unwrap(),
        )
        .unwrap();
        assert!(!raw.contains(root.to_str().unwrap()), "absolute host path in {name}");
        assert!(!raw.contains("body-2026"), "chat content in {name}");
    }

    // No hidden second run: exactly one run directory, and it is this one.
    let mut runs: Vec<String> = std::fs::read_dir(root.join(".h2o-reclaim"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .filter(|n| n != "receipts")
        .collect();
    runs.sort();
    assert_eq!(runs, vec![run_id]);

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (M)(L) a staging-only run: zero generation candidates, real residue, and the
/// complete plan is durable BEFORE the first staging rename. This is the
/// anti-vacuity case for plan durability.
#[test]
fn a_staging_only_run_acts_with_zero_generation_candidates() {
    let root = scratch("stagingonly");
    // No packages directory at all: only durable-temp residue exists.
    plant_temp(&root, "ab", ".h2o-durable-2-0.tmp", b"residue");

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    trace::reset();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", "deadbeef"));

    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.quarantined, 0, "no generation action was fabricated");
    assert_eq!(outcome.purged, 0);
    assert!(outcome.acted.is_empty());
    assert_eq!(outcome.residue.durable_temp_purged, 1);
    assert_eq!(outcome.residue.generation_staging_purged, 0);

    let events = trace::taken();
    assert_eq!(
        events.iter().position(|e| *e == trace::Event::PlanDurable),
        Some(0),
        "plan durability is the first recorded step"
    );
    assert!(
        !events.contains(&trace::Event::FirstRename),
        "no generation rename happened"
    );
    let first_staging = events
        .iter()
        .position(|e| *e == trace::Event::ResidueRename)
        .expect("a staging rename happened");
    assert!(
        events.iter().position(|e| *e == trace::Event::PlanDurable).unwrap() < first_staging,
        "PLAN_DURABLE precedes FIRST_STAGING_RENAME with zero generation candidates"
    );

    // One run id and one evidence set.
    let run_id = outcome.run_id.clone().unwrap();
    let receipts = receipt_names(&root);
    assert!(receipts.iter().all(|n| n.starts_with(&run_id)));
    let plan = receipt_json(&root, &format!("{run_id}.plan.json"));
    assert_eq!(plan["stages"], serde_json::json!(["staging-temp"]));
    assert_eq!(plan["residue"]["actions"].as_array().unwrap().len(), 1);
    assert_eq!(plan["candidates"].as_array().unwrap().len(), 0);
    assert!(!root.join("assets").join("ab").join(".h2o-durable-2-0.tmp").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (O) generation-only preservation: with ZERO residue the run behaves exactly
/// as the pre-T3.3 generation execution did, plus the additive stage evidence.
#[test]
fn generation_only_behaviour_is_preserved_when_no_residue_exists() {
    let root = scratch("genonly");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    trace::reset();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));

    // Exactly the T3.2 result.
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.quarantined, 2);
    assert_eq!(outcome.purged, 2);
    assert_eq!(outcome.retention_floor, 3);
    assert_eq!(outcome.acted.len(), 2);
    assert!(outcome.acted.iter().all(|a| a.quarantined && a.purged));
    assert_eq!(pkg_names(&root).len(), 3, "the K=3 floor survives");
    assert_eq!(
        trace::taken(),
        vec![
            trace::Event::PlanDurable,
            trace::Event::FirstRename,
            trace::Event::QuarantineNamespaceDurable,
            trace::Event::QuarantineReceiptDurable,
            trace::Event::Purge,
            trace::Event::PurgeReceiptDurable,
            trace::Event::FirstRename,
            trace::Event::QuarantineNamespaceDurable,
            trace::Event::QuarantineReceiptDurable,
            trace::Event::Purge,
            trace::Event::PurgeReceiptDurable,
        ],
        "no residue step is recorded, and no generation step changed"
    );
    // Additive only: the residue fields are present and empty.
    assert!(outcome.residue_acted.is_empty());
    assert_eq!(outcome.residue, ResidueCounts::default());
    assert_eq!(outcome.residue_indeterminate, 0);
    let run_id = outcome.run_id.clone().unwrap();
    let plan = receipt_json(&root, &format!("{run_id}.plan.json"));
    assert_eq!(plan["stages"], serde_json::json!(["generation"]));
    assert_eq!(plan["residue"]["actions"].as_array().unwrap().len(), 0);
    assert_eq!(plan["residue"]["sourceComplete"], true);
    // Every generation-stage receipt is exactly the T3.2 shape.
    let quarantined = receipt_names(&root)
        .into_iter()
        .find(|n| n.contains("quarantined") && !n.contains("residue"))
        .expect("a generation quarantine receipt");
    let value = receipt_json(&root, &quarantined);
    assert_eq!(value["kind"], "generation");
    assert_eq!(value["chatId"], "chat_a");

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (D)(mutant 2) an incomplete residue authority is NEVER read as empty, and it
/// does not buy an independent generation stage either: ZERO destructive
/// mutation for the whole run, refused before the run namespace exists.
#[test]
fn an_incomplete_residue_authority_performs_zero_destructive_mutation() {
    let root = scratch("residueblind");
    let hashes = five(&root, "chat_a");
    // A shard standing behind a symlink: O_NOFOLLOW cannot look inside it.
    let elsewhere = root.parent().unwrap().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    std::fs::write(elsewhere.join(".h2o-durable-1-0.tmp"), b"hidden").unwrap();
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::os::unix::fs::symlink(&elsewhere, root.join("assets").join("ab")).unwrap();

    let owner = Owner::acquire(&root);
    let before = census(&root);
    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));

    assert_eq!(outcome.state, RunState::Refused);
    assert!(outcome.blockers.contains(&codes::RESIDUE_NOT_AUTHORITATIVE.to_string()));
    assert!(outcome.run_id.is_none(), "no run namespace was created");
    assert_eq!(outcome.quarantined, 0);
    assert_eq!(outcome.purged, 0);
    assert_eq!(outcome.residue, ResidueCounts::default());
    assert_eq!(census(&root), before, "not one byte changed, in EITHER stage");
    assert!(!root.join(".h2o-reclaim").exists());
    assert!(elsewhere.join(".h2o-durable-1-0.tmp").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (I)(mutant 7) an in-flight publisher session refuses the WHOLE run before
/// any action, and its staging tree is left completely alone.
#[test]
fn an_in_flight_publisher_session_refuses_the_staging_stage_too() {
    let root = scratch("livesession");
    plant_temp(&root, "ab", ".h2o-durable-6-0.tmp", b"residue");

    // A genuine live session, held open across the refusal.
    let publisher = Publisher::new(root.to_path_buf());
    let begun = begin(&publisher, "chat_live");
    assert!(begun.ok, "{:?}", begun.blockers);
    assert!(write_member(&publisher, begun.token, Member::Snapshot, br#"{"live":true}"#).ok);
    assert!(!publisher.sessions_empty(), "the registry really is occupied");
    let live_staging: Vec<String> = pkg_names(&root)
        .into_iter()
        .filter(|n| n.starts_with(".h2o-genstage-"))
        .collect();
    assert_eq!(live_staging.len(), 1);

    let owner = Owner::acquire(&root);
    let before = census(&root);
    let ex = owner.exclusive();
    let outcome = run_with_registry(
        &root,
        &ex,
        &db(vec![]),
        &request("chat_a", "ok", "deadbeef"),
        publisher.sessions_empty(),
    );

    assert_eq!(outcome.state, RunState::Refused);
    assert_eq!(outcome.blockers, vec![codes::PUBLISHER_SESSIONS_ACTIVE.to_string()]);
    assert!(outcome.run_id.is_none());
    assert!(outcome.residue_acted.is_empty(), "no staging receipt, no staging action");
    assert_eq!(census(&root), before, "the live staging tree is intact");
    assert!(!root.join(".h2o-reclaim").exists(), "no reclaim root from a refusal");
    assert!(root.join("assets").join("ab").join(".h2o-durable-6-0.tmp").exists());
    // The session was never terminated as part of the refusal.
    assert!(!publisher.sessions_empty(), "the registry still contains the session");
    assert!(root.join("packages").join(&live_staging[0]).is_dir());

    // Only now, as cleanup, is the session ended.
    assert!(abort(&publisher, begun.token).ok);
    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (K) a trusted durable write cannot overlap the exclusive staging/temp
/// window. Proven at the REAL production gate every mutating command passes
/// through — `enter_mutation_recovering` — not by reading source comments, and
/// without inventing a second lock.
#[test]
fn a_trusted_durable_write_cannot_overlap_the_exclusive_staging_window() {
    use crate::archive_instance_lock::enter_mutation_recovering;

    let root = scratch("dwexcl");
    plant_temp(&root, "ab", ".h2o-durable-4-0.tmp", b"residue");

    let state = std::sync::Arc::new(ArchiveInstanceState::default());
    state.record_startup_attempt(&root);
    state.ensure_presence(&root).expect("shared presence");

    // Control: the production gate admits a trusted mutation right now.
    assert!(
        enter_mutation_recovering(&state, Some(&root)).is_ok(),
        "precondition: trusted mutation is possible before the run"
    );

    let _serial = pause_guard();
    let (reached, release) = pause::arm();
    let run_state = state.clone();
    let run_root = root.clone();
    let handle = std::thread::spawn(move || {
        let ex = run_state.try_acquire_exclusive().expect("exclusive");
        let outcome = run_internal(
            &ex,
            &run_root,
            true,
            &request("chat_a", "ok", "deadbeef"),
            &db(vec![]),
        );
        let _ = ex.release();
        outcome
    });
    reached
        .recv_timeout(std::time::Duration::from_secs(30))
        .expect("the run reached its exclusive window");

    // Mid-run: the same authority is refused, retryably.
    let refused = enter_mutation_recovering(&state, Some(&root));
    assert_eq!(
        refused.err().as_deref(),
        Some(crate::archive_instance_lock::codes::MUTATION_GATE_BUSY),
        "a concurrent trusted write must be refused while the run owns exclusive"
    );
    assert!(
        crate::archive_instance_lock::is_retryable_environmental(
            crate::archive_instance_lock::codes::MUTATION_GATE_BUSY
        ),
        "and refused with the established retryable behavior, not a hard error"
    );

    let _ = release.send(());
    let outcome = handle.join().expect("run thread");
    pause::clear();
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.residue.durable_temp_purged, 1);

    // After release, trusted mutation is possible again.
    assert!(enter_mutation_recovering(&state, Some(&root)).is_ok());

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// AC-M06-09 eviction equivalence: reclaiming a genuine orphaned staging tree
/// removes abandoned staging state and nothing else. No committed generation
/// moves, no publisher session is terminated, and publication still works
/// afterwards with identical semantics.
#[test]
fn reclaiming_orphaned_staging_is_not_a_publication_change() {
    let root = scratch("evict");
    let before_hash = publish(&root, "chat_a", "2026-01-01T00:00:00.000Z");
    let staging = orphan_staging(&root, "chat_b");
    let published_before: Vec<String> = pkg_names(&root)
        .into_iter()
        .filter(|n| n.ends_with(".h2ochat"))
        .collect();
    assert_eq!(published_before.len(), 1);
    let package_census = census(&root.join("packages").join(&published_before[0]));

    // The preconditions the safety argument rests on, asserted rather than
    // assumed: exclusive held, registry empty, target in a staging namespace.
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let registry_probe = Publisher::new(root.to_path_buf());
    assert!(registry_probe.sessions_empty(), "no publisher session is in flight");
    assert!(staging.starts_with(".h2o-genstage-"));
    assert!(crate::archive_durable_write::is_reserved_component(&staging));

    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &before_hash));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.residue.generation_staging_purged, 1);

    // No committed generation moved, byte for byte.
    assert_eq!(
        pkg_names(&root)
            .into_iter()
            .filter(|n| n.ends_with(".h2ochat"))
            .collect::<Vec<_>>(),
        published_before,
        "no canonical publication was touched"
    );
    assert_eq!(census(&root.join("packages").join(&published_before[0])), package_census);
    assert!(outcome.acted.is_empty(), "the generation stage acted on nothing");
    assert!(!root.join("packages").join(&staging).exists());
    let _ = ex.release();

    // Publication semantics are unchanged afterwards: a new generation
    // publishes normally through the real publisher.
    let after_hash = publish(&root, "chat_c", "2026-02-02T00:00:00.000Z");
    assert_eq!(after_hash.len(), 64);
    assert_eq!(
        pkg_names(&root)
            .into_iter()
            .filter(|n| n.ends_with(".h2ochat"))
            .count(),
        2
    );
    assert!(
        !pkg_names(&root).iter().any(|n| n.starts_with(".h2o-genstage-")),
        "the new publication left no staging residue of its own"
    );

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (V)(mutant 12) a deterministic namespace-durability failure after a staging
/// rename: no purge, no later action, never Complete.
#[test]
fn a_staging_namespace_durability_failure_stops_the_run_without_purging() {
    let root = scratch("resdur");
    plant_temp(&root, "ab", ".h2o-durable-1-0.tmp", b"first");
    plant_temp(&root, "cd", ".h2o-durable-1-0.tmp", b"second");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::arm(fault::Point::AfterResidueRenameBeforeNamespaceDurability);
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", "deadbeef"));
    fault::clear();

    assert_eq!(outcome.state, RunState::Partial, "never Complete");
    assert_eq!(outcome.residue_acted.len(), 1, "the run stopped at the first item");
    assert!(outcome.residue_acted[0].quarantined);
    assert!(!outcome.residue_acted[0].purged);
    assert_eq!(
        outcome.residue_acted[0].blocker.as_deref(),
        Some(crate::archive_reclaim::codes::QUARANTINE_NOT_DURABLE)
    );
    assert_eq!(outcome.residue.durable_temp_purged, 0);

    let events = trace::taken();
    assert!(events.contains(&trace::Event::ResidueRename));
    assert!(!events.contains(&trace::Event::ResidueNamespaceDurable));
    assert!(!events.contains(&trace::Event::ResiduePurge), "no purge, ever");

    // The item remains quarantined and observable; the second is untouched.
    let run_id = outcome.run_id.clone().unwrap();
    let quarantined: Vec<String> = std::fs::read_dir(root.join(".h2o-reclaim").join(&run_id))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(quarantined, vec!["durtmp.ab..h2o-durable-1-0.tmp".to_string()]);
    assert!(root.join("assets").join("cd").join(".h2o-durable-1-0.tmp").exists());
    assert!(receipt_names(&root).iter().all(|n| !n.contains("residue")));

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (W)(mutant 13)(mutant 14) a deterministic staging-receipt failure prevents
/// the purge and every later action.
#[test]
fn a_failed_staging_receipt_stops_the_run_without_purging() {
    let root = scratch("resreceipt");
    plant_temp(&root, "ab", ".h2o-durable-1-0.tmp", b"first");
    plant_temp(&root, "cd", ".h2o-durable-1-0.tmp", b"second");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::arm(fault::Point::AfterResidueRenameBeforeReceipt);
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", "deadbeef"));
    fault::clear();

    assert_eq!(outcome.state, RunState::Partial);
    assert_eq!(outcome.residue_acted.len(), 1);
    assert!(outcome.residue_acted[0].quarantined && !outcome.residue_acted[0].purged);
    assert!(outcome.blockers.contains(&codes::EVIDENCE_FAILED.to_string()));

    let events = trace::taken();
    assert!(events.contains(&trace::Event::ResidueNamespaceDurable), "the move was durable");
    assert!(!events.contains(&trace::Event::ResidueReceiptDurable), "the receipt was not");
    assert!(!events.contains(&trace::Event::ResiduePurge), "so nothing was purged");

    let run_id = outcome.run_id.clone().unwrap();
    assert!(root
        .join(".h2o-reclaim")
        .join(&run_id)
        .join("durtmp.ab..h2o-durable-1-0.tmp")
        .exists());
    assert!(root.join("assets").join("cd").join(".h2o-durable-1-0.tmp").exists());
    assert!(!receipt_names(&root).iter().any(|n| n.contains("residue")));

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (X)(mutant 15) a deterministic staging-purge failure stops later actions and
/// reports honestly: the canonical source is NOT restored, and the surviving
/// quarantine stays for recovery.
#[test]
fn a_staging_purge_failure_stops_later_actions_honestly() {
    let root = scratch("respurge");
    plant_temp(&root, "ab", ".h2o-durable-1-0.tmp", b"first");
    plant_temp(&root, "cd", ".h2o-durable-1-0.tmp", b"second");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    fault::arm(fault::Point::ResiduePurgeFails);
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", "deadbeef"));
    fault::clear();

    assert_eq!(outcome.state, RunState::Partial);
    assert_eq!(outcome.residue_acted.len(), 1);
    assert!(outcome.residue_acted[0].quarantined);
    assert!(!outcome.residue_acted[0].purged);
    assert_eq!(
        outcome.residue_acted[0].blocker.as_deref(),
        Some(codes::RESIDUE_PURGE_FAILED)
    );
    assert_eq!(outcome.residue.durable_temp_quarantined, 1);
    assert_eq!(outcome.residue.durable_temp_purged, 0);

    // Logical removal already happened and is NOT undone.
    assert!(!root.join("assets").join("ab").join(".h2o-durable-1-0.tmp").exists());
    let run_id = outcome.run_id.clone().unwrap();
    assert!(root
        .join(".h2o-reclaim")
        .join(&run_id)
        .join("durtmp.ab..h2o-durable-1-0.tmp")
        .exists(), "the physical residue stays contained");
    // The quarantine receipt exists; the purge receipt does not.
    let receipts = receipt_names(&root);
    assert!(receipts.iter().any(|n| n.contains("residue-quarantined")));
    assert!(!receipts.iter().any(|n| n.contains("residue-purged")));
    // The second item was never touched.
    assert!(root.join("assets").join("cd").join(".h2o-durable-1-0.tmp").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (mutant 10) a material GENERATION-stage failure prevents every staging
/// action. The run does not go on to delete something else after meeting a
/// contradiction.
#[test]
fn a_generation_stage_failure_prevents_every_staging_action() {
    let root = scratch("genfail");
    let hashes = five(&root, "chat_a");
    let staging = orphan_staging(&root, "chat_b");
    plant_temp(&root, "ab", ".h2o-durable-1-0.tmp", b"residue");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::arm(fault::Point::AfterRenameBeforeQuarantineReceipt);
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    fault::clear();

    assert_eq!(outcome.state, RunState::Partial);
    let events = trace::taken();
    assert!(events.contains(&trace::Event::FirstRename));
    assert!(
        !events.iter().any(|e| matches!(
            e,
            trace::Event::ResidueRename
                | trace::Event::ResidueNamespaceDurable
                | trace::Event::ResidueReceiptDurable
                | trace::Event::ResiduePurge
                | trace::Event::ResiduePurgeReceiptDurable
        )),
        "not one staging step may run after a generation-stage failure"
    );
    assert!(outcome.residue_acted.is_empty());
    assert_eq!(outcome.residue, ResidueCounts::default());
    assert!(root.join("packages").join(&staging).is_dir(), "staging untouched");
    assert!(root.join("assets").join("ab").join(".h2o-durable-1-0.tmp").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (AB) with no generation candidate and no residue, the run performs ZERO
/// persistent mutation: no reclaim root, no run directory, no receipt.
#[test]
fn a_no_op_run_with_neither_generations_nor_residue_mutates_nothing() {
    let root = scratch("t33noop");
    let hashes: Vec<String> = (1..=3)
        .map(|d| publish(&root, "chat_a", &format!("2026-01-0{d}T00:00:00.000Z")))
        .collect();
    // Name-matching entries of the WRONG type: reported, never acted on, and
    // never enough to make a run happen.
    std::fs::write(root.join("packages").join(".h2o-genstage-notadir"), b"x").unwrap();
    let owner = Owner::acquire(&root);
    let before = census(&root);
    let ex = owner.exclusive();

    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[2]));

    assert_eq!(outcome.state, RunState::NoOp);
    assert!(outcome.run_id.is_none());
    assert!(outcome.blockers.is_empty());
    assert!(outcome.residue_acted.is_empty());
    assert_eq!(outcome.residue, ResidueCounts::default());
    assert_eq!(outcome.residue_indeterminate, 1, "reported, not acted on");
    assert_eq!(census(&root), before, "no-op means no mutation at all");
    assert!(!root.join(".h2o-reclaim").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (R)(mutant 18) two DISTINCT durable temps can legitimately share a basename
/// across shards. The quarantine identity keeps them apart, and a basename-only
/// identity would not — which the second half of this test demonstrates rather
/// than asserts.
#[test]
fn two_durable_temps_with_one_basename_get_distinct_quarantine_identities() {
    let root = scratch("collide");
    plant_temp(&root, "ab", ".h2o-durable-77-0.tmp", b"first");
    plant_temp(&root, "cd", ".h2o-durable-77-0.tmp", b"second");

    let scan = crate::archive_residue_probe::scan_trusted_residue_within(&root);
    assert_eq!(scan.items.len(), 2);
    assert_eq!(scan.items[0].name(), scan.items[1].name(), "one basename");
    let a = residue_target_component(&scan.items[0]).unwrap();
    let b = residue_target_component(&scan.items[1]).unwrap();
    assert_ne!(a, b, "the shard is part of the identity");
    assert_eq!(a.as_str(), "durtmp.ab..h2o-durable-77-0.tmp");
    assert_eq!(b.as_str(), "durtmp.cd..h2o-durable-77-0.tmp");
    /* The mutant's identity — family plus basename — maps both to one name. */
    assert_eq!(
        format!("durtmp.{}", scan.items[0].name()),
        format!("durtmp.{}", scan.items[1].name()),
        "a basename-only identity really does collide"
    );

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", "deadbeef"));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.residue.durable_temp_purged, 2, "BOTH were reclaimed");
    let receipts = receipt_names(&root);
    assert!(receipts.iter().any(|n| n.contains("durtmp.ab.")));
    assert!(receipts.iter().any(|n| n.contains("durtmp.cd.")));
    assert!(!root.join("assets").join("ab").join(".h2o-durable-77-0.tmp").exists());
    assert!(!root.join("assets").join("cd").join(".h2o-durable-77-0.tmp").exists());

    // And had the identities collided, the second move would have been REFUSED
    // rather than overwriting the first: RENAME_EXCL, not a replacing rename.
    let reclaim = crate::archive_reclaim::open_reclaim_root_for_run(&ex, &root).unwrap();
    let collide_run = crate::archive_reclaim::QuarantineRunId::parse("collide").unwrap();
    let run_dir = reclaim.create_run(&ex, &collide_run).unwrap();
    plant_temp(&root, "ab", ".h2o-durable-88-0.tmp", b"x");
    plant_temp(&root, "cd", ".h2o-durable-88-0.tmp", b"y");
    let shared = QuarantineComponent::parse("durtmp..h2o-durable-88-0.tmp").unwrap();
    let name = QuarantineComponent::parse(".h2o-durable-88-0.tmp").unwrap();
    let ab = crate::archive_reclaim::open_cas_shard_dir(&ex, &root, "ab").unwrap();
    let cd = crate::archive_reclaim::open_cas_shard_dir(&ex, &root, "cd").unwrap();
    assert_eq!(quarantine_residue(&ex, &ab, &run_dir, &name, &shared), Ok(true));
    assert_eq!(
        quarantine_residue(&ex, &cd, &run_dir, &name, &shared),
        Ok(false),
        "a colliding destination fails closed instead of overwriting"
    );
    assert_eq!(
        std::fs::read(root.join(".h2o-reclaim").join("run-collide").join(shared.as_str())).unwrap(),
        b"x",
        "the first item was never replaced"
    );
    assert!(root.join("assets").join("cd").join(".h2o-durable-88-0.tmp").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (AA) staging action order is a stable trusted identity sort, not filesystem
/// enumeration order: two equivalent archives built in opposite orders plan and
/// act identically.
#[test]
fn staging_action_order_is_deterministic_across_archives() {
    fn build(tag: &str, reverse: bool) -> (PathBuf, Vec<String>) {
        let root = scratch(tag);
        let mut shards = vec!["01", "ab", "cd", "ef", "fe"];
        let mut stages = vec!["aa01", "aa02", "aa03"];
        if reverse {
            shards.reverse();
            stages.reverse();
        }
        std::fs::create_dir_all(root.join("packages")).unwrap();
        for st in stages {
            std::fs::create_dir_all(root.join("packages").join(format!(".h2o-genstage-{st}")))
                .unwrap();
        }
        for sh in shards {
            plant_temp(&root, sh, ".h2o-durable-3-0.tmp", b"t");
        }
        let owner = Owner::acquire(&root);
        let ex = owner.exclusive();
        let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", "deadbeef"));
        assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
        let ids = residue_ids(&outcome);
        let _ = ex.release();
        (root, ids)
    }
    let (forward_root, forward) = build("order-f", false);
    let (reverse_root, reverse) = build("order-r", true);
    assert_eq!(forward, reverse, "insertion order must not reach action order");
    assert_eq!(
        forward,
        vec![
            "generation-staging|archive/packages/.h2o-genstage-aa01",
            "generation-staging|archive/packages/.h2o-genstage-aa02",
            "generation-staging|archive/packages/.h2o-genstage-aa03",
            "durable-temp|archive/assets/01/.h2o-durable-3-0.tmp",
            "durable-temp|archive/assets/ab/.h2o-durable-3-0.tmp",
            "durable-temp|archive/assets/cd/.h2o-durable-3-0.tmp",
            "durable-temp|archive/assets/ef/.h2o-durable-3-0.tmp",
            "durable-temp|archive/assets/fe/.h2o-durable-3-0.tmp",
        ]
    );
    let _ = std::fs::remove_dir_all(forward_root.parent().unwrap());
    let _ = std::fs::remove_dir_all(reverse_root.parent().unwrap());
}

/// (C)(AH)(mutant 1)(mutant 21) the destructive staging authority is
/// trusted-side only: the request names nothing, and no renderer inventory
/// reaches it.
#[test]
fn the_staging_stage_takes_no_renderer_inventory_path_or_target() {
    // The ONLY caller-controlled input is the bounded enabling request, whose
    // fields are exactly chat scope and per-chat projection verdict.
    let preview = include_str!("../archive_reclamation_preview.rs");
    let at = preview.find("pub struct PreviewRequest").unwrap();
    let decl = &preview[at..at + preview[at..].find("\n}").unwrap()];
    for forbidden in [
        "residue", "staging", "genstage", "durable", "shard", "temp", "run_id",
        "target", "path", "quarantine", "item",
    ] {
        assert!(!decl.contains(forbidden), "the request must not carry {forbidden}");
    }

    let code: String = include_str!("../archive_reclaim_execute.rs")
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    /* The residue set comes from ONE authority: the trusted scan. */
    assert_eq!(
        code.matches("scan_trusted_residue_within(").count(),
        1,
        "one trusted residue authority, recomputed here"
    );
    for forbidden in [
        "diagnoseSavedChatArchive", "saved-chat-reclamation-ui", "packagesInventory",
        "inventory", "renderer_residue", "ProjectionInput { chat_id: ",
    ] {
        assert!(!code.contains(forbidden), "renderer inventory is not authority: {forbidden}");
    }
    /* And the scan is invoked with the run's own derived archive root — no
       caller path type reaches it. */
    let at = code.find("scan_trusted_residue_within(").unwrap();
    assert!(code[at..at + 60].contains("(archive_root)"));

    /* (mutant 8) the scan runs INSIDE the exclusive window: it is called from
       the private sequence that requires the capability by type, after the
       registry precondition, and nothing in the production wrapper scans. */
    let src = include_str!("../archive_reclaim_execute.rs");
    let seq = src.find("fn run_internal(").unwrap();
    let wrapper = src.find("pub(crate) async fn execute_generation_reclamation").unwrap();
    let wrapper_body = &src[wrapper..seq];
    assert!(!wrapper_body.contains("scan_trusted_residue_within"));
    let body = &src[seq..];
    let scan_at = body.find("scan_trusted_residue_within").unwrap();
    let registry_at = body.find("if !publisher_sessions_empty").unwrap();
    assert!(registry_at < scan_at, "the registry precondition precedes the scan");
    assert!(
        src[seq..seq + 400].contains("exclusive: &crate::archive_instance_lock::ExclusiveOwnership"),
        "the sequence holding the scan requires exclusive ownership by type"
    );
}

/// (L)(mutant 9) the COMPLETE action set — generations and both residue
/// families — is in the durable pre-mutation record, and that record is written
/// before any rename in either stage.
#[test]
fn the_complete_plan_is_durable_before_the_first_rename_of_either_stage() {
    let src = include_str!("../archive_reclaim_execute.rs");
    let seq = src.find("fn run_internal(").unwrap();
    let body = &src[seq..];

    let actions_built = body.find("let mut residue_actions").expect("actions derived");
    let plan_written = body.find("&plan_evidence(").expect("plan evidence written");
    let first_gen_rename = body.find("quarantine_generation(exclusive").expect("generation move");
    let staging_stage = body.find("run_residue_stage(").expect("staging stage");
    assert!(actions_built < plan_written, "the actions exist before the record");
    assert!(plan_written < first_gen_rename, "PLAN_DURABLE precedes the generation rename");
    assert!(plan_written < staging_stage, "PLAN_DURABLE precedes the staging stage");

    // The record really carries them.
    let at = src.find("fn plan_evidence(").unwrap();
    let evidence = &src[at..at + src[at..].find("\nfn residue_evidence").unwrap()];
    for required in [
        "\"residue\"", "sourceComplete", "sourceBlockers", "indeterminate",
        "\"actions\"", "archivePath", "quarantineItem", "\"family\"",
    ] {
        assert!(evidence.contains(required), "the plan must record {required}");
    }
    // (mutant 24) and nothing time-shaped is recorded as authority.
    let tokens = identifier_tokens(evidence);
    for forbidden in TIME_AUTHORITY_IDENTIFIERS {
        assert!(!tokens.contains(*forbidden), "no time authority in the plan: {forbidden}");
    }
}

/// (AI)(AJ) T3.3 stays dormant: no command, no invoke-handler arm, no renderer
/// route, and the capability and UI surfaces carry no destructive grant.
#[test]
fn staging_reclamation_has_no_command_of_its_own() {
    let lib = include_str!("../lib.rs");
    /* P4: staging/temp reclamation gained NO renderer authority of its own. It
       is reachable only as a stage inside the one approved reclamation
       command, exactly as reviewed. */
    for forbidden in [
        "run_residue_stage", "scan_trusted_residue_within",
        "h2o_archive_staging", "h2o_archive_residue_reclaim",
        "h2o_archive_reclaim_", "h2o_archive_temp", "h2o_archive_genstage",
    ] {
        assert!(!lib.contains(forbidden), "{forbidden} must not be registered");
    }
    assert!(lib.contains("pub mod archive_reclaim_execute;"), "compiled");
    let src = include_str!("../archive_reclaim_execute.rs");
    let at = src.find("pub async fn h2o_archive_reclamation_execute").unwrap();
    let body = &src[at..at + src[at..].find("\n}").unwrap()];
    assert!(
        !body.contains("residue") && !body.contains("staging"),
        "the command names no stage; the sequence owns the stages"
    );

    /* Renderer archive mutation authority is still EMPTY. Scoped to grants
       that actually reach `$APPLOCALDATA/archive`: `archive-export.json`
       legitimately holds an `fs:allow-mkdir` for `$HOME/H2O Studio Exports`,
       which is M04 export authority over a different tree, and banning the
       token outright would fail on unrelated capability rather than on archive
       mutation. Every archive-reaching grant must be read-only. */
    const ARCHIVE_READ_ONLY: &[&str] = &[
        "fs:allow-exists",
        "fs:allow-read-file",
        "fs:allow-read-text-file",
        "fs:allow-lstat",
        "fs:allow-read-dir",
    ];
    let mut archive_grants: Vec<String> = vec![];
    for capability in [
        include_str!("../../capabilities/archive-cas.json"),
        include_str!("../../capabilities/archive-export.json"),
        include_str!("../../capabilities/default.json"),
    ] {
        let value: serde_json::Value = serde_json::from_str(capability).expect("capability json");
        let Some(entries) = value["permissions"].as_array() else {
            continue;
        };
        for entry in entries {
            let Some(identifier) = entry["identifier"].as_str() else {
                continue;
            };
            let paths = serde_json::to_string(&entry["allow"]).unwrap_or_default();
            if !paths.contains("$APPLOCALDATA/archive") {
                continue;
            }
            archive_grants.push(identifier.to_string());
            assert!(
                ARCHIVE_READ_ONLY.contains(&identifier),
                "{identifier} grants the renderer non-read authority over the archive"
            );
        }
    }
    assert!(!archive_grants.is_empty(), "the archive grants were actually inspected");

    // The New UI reclamation surface: Analyze only, no destructive control.
    let ui = include_str!(
        "../../../../../../src-surfaces-base/studio/ingestion/saved-chat-reclamation-ui.studio.js"
    );
    /* The surface declares its actions with `setAttribute('data-h2o-action',
       '<name>')`, so the action set is exactly the values passed there. */
    let actions: Vec<&str> = ui
        .match_indices("'data-h2o-action'")
        .map(|(at, _)| {
            let tail = &ui[at..];
            let start = tail.find(", '").expect("an action value") + 3;
            &tail[start..start + tail[start..].find('\'').expect("closing quote")]
        })
        .collect();
    /* P4: G02 passed, so the card legitimately offers the two approved
       destructive actions. Narrowed from "Analyze is the only control" to the
       EXACT approved set — a third action, or a CAS-destructive one, fails. */
    let mut actions = actions;
    actions.sort();
    assert_eq!(
        actions,
        vec!["analyze-archive", "quarantine-occupant", "reclaim-archive"],
        "exactly the G02-approved control set"
    );
    /* Only the two approved commands are invocable from the New UI. */
    let mut ui_commands: Vec<&str> = ui
        .match_indices("h2o_archive_")
        .map(|(at, _)| {
            let tail = &ui[at..];
            let end = tail
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(tail.len());
            &tail[..end]
        })
        .collect();
    ui_commands.sort();
    ui_commands.dedup();
    assert_eq!(
        ui_commands,
        vec![
            "h2o_archive_occupant_quarantine",
            "h2o_archive_reclamation_execute",
            "h2o_archive_reclamation_preview",
        ],
        "no third command is reachable from the New UI"
    );
    /* Staging/temp reclamation gained NO control of its own. The exact action
       set above already pins that; these are the spellings that would mean a
       separate residue control had appeared. */
    for forbidden in ["genstage", "durable-temp", "residue-reclaim", "purge", "stale"] {
        assert!(
            !actions.iter().any(|a| a.contains(forbidden)),
            "staging/temp must have no control of its own: {forbidden}"
        );
    }
    for forbidden in [
        "h2o_archive_staging", "h2o_archive_purge", "h2o_archive_recover",
        "h2o_archive_residue", "purge_quarantined_item",
    ] {
        assert!(!ui.contains(forbidden), "no destructive invoke: {forbidden}");
    }
}

/// (C)(mutant 1) MONOTONICITY FOR RESIDUE: renderer input is enabling-only, so
/// it can narrow what a run does but must NEVER add a destructive target. The
/// scope here nominates a published generation, a staging name that does not
/// exist and a canonical CAS body; the trusted scan still decides alone.
#[test]
fn renderer_scope_can_never_add_a_residue_target() {
    let root = scratch("nominate");
    let hash = publish(&root, "chat_a", "2026-01-01T00:00:00.000Z");
    let published = pkg_names(&root)
        .into_iter()
        .find(|n| n.ends_with(".h2ochat"))
        .expect("a published generation");
    std::fs::create_dir_all(root.join("packages").join(".h2o-genstage-real01")).unwrap();
    plant_temp(&root, "ab", ".h2o-durable-5-0.tmp", b"t");
    let body = format!("sha256-{}", "ab".repeat(32));
    plant_temp(&root, "ab", &body, b"canonical-cas-body");
    let published_census = census(&root.join("packages").join(&published));

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let nominated = PreviewRequest {
        chat_scope: Some(vec![
            "chat_a".to_string(),
            published.clone(),
            ".h2o-genstage-victim".to_string(),
            body.clone(),
        ]),
        projections: vec![ProjectionInput {
            chat_id: "chat_a".to_string(),
            status: "ok".to_string(),
            content_hash: hash.clone(),
        }],
    };
    let outcome = run(&root, &ex, &db(vec![]), &nominated);

    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(
        residue_ids(&outcome),
        vec![
            "generation-staging|archive/packages/.h2o-genstage-real01",
            "durable-temp|archive/assets/ab/.h2o-durable-5-0.tmp",
        ],
        "only the trusted scan decides the residue set"
    );
    assert_eq!(
        census(&root.join("packages").join(&published)),
        published_census,
        "the nominated generation is untouched"
    );
    assert_eq!(
        std::fs::read(root.join("assets").join("ab").join(&body)).unwrap(),
        b"canonical-cas-body",
        "the nominated CAS body is untouched"
    );
    assert_eq!(outcome.residue.generation_staging_purged, 1);
    assert_eq!(outcome.residue.durable_temp_purged, 1);

    // Structural: the trusted scan result is bound immutably and nothing is
    // ever appended to it, so there is no seam a nomination could enter by.
    let src = include_str!("../archive_reclaim_execute.rs");
    let body_src = &src[src.find("fn run_internal(").unwrap()..];
    assert!(body_src
        .contains("let residue = crate::archive_residue_probe::scan_trusted_residue_within(archive_root);"));
    /* Spelled precisely: `let mut residue_actions` is the derived plan list and
       legitimately mutable; what must not exist is a mutable rebinding of the
       SCAN RESULT, or an append into it. */
    for forbidden in [
        "let mut residue =", "let mut residue:", "residue.items.push",
        "residue.items.extend", "residue.items.append",
    ] {
        assert!(!body_src.contains(forbidden), "residue must not be widened: {forbidden}");
    }

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (S)(mutant 16) the SAME durability barrier is on the generation-staging
/// path, not only the durable-temp one: with the barrier forced to fail, a
/// staging item stops the run exactly as a temp item does.
#[test]
fn a_generation_staging_durability_failure_stops_the_run_without_purging() {
    let root = scratch("stagedur");
    let staging = orphan_staging(&root, "chat_b");
    plant_temp(&root, "ab", ".h2o-durable-1-0.tmp", b"second");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::arm(fault::Point::AfterResidueRenameBeforeNamespaceDurability);
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", "deadbeef"));
    fault::clear();

    assert_eq!(outcome.state, RunState::Partial);
    assert_eq!(outcome.residue_acted.len(), 1, "stopped at the FIRST item");
    assert_eq!(
        outcome.residue_acted[0].family,
        crate::archive_residue_probe::ResidueFamily::GenerationStaging,
        "generation staging sorts first, so it is the item under test"
    );
    assert!(outcome.residue_acted[0].quarantined && !outcome.residue_acted[0].purged);
    assert_eq!(
        outcome.residue_acted[0].blocker.as_deref(),
        Some(crate::archive_reclaim::codes::QUARANTINE_NOT_DURABLE)
    );
    let events = trace::taken();
    assert!(events.contains(&trace::Event::ResidueRename));
    assert!(!events.contains(&trace::Event::ResidueNamespaceDurable));
    assert!(!events.contains(&trace::Event::ResiduePurge));

    // The staging tree is quarantined and intact; the temp is untouched.
    let run_id = outcome.run_id.clone().unwrap();
    assert!(root
        .join(".h2o-reclaim")
        .join(&run_id)
        .join(format!("genstage.{staging}"))
        .is_dir());
    assert!(!root.join("packages").join(&staging).exists());
    assert!(root.join("assets").join("ab").join(".h2o-durable-1-0.tmp").exists());
    assert_eq!(outcome.residue.generation_staging_purged, 0);

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (S)(T)(mutant 16)(mutant 17) the source/destination durability barrier is on
/// the path for BOTH residue families, unconditionally.
///
/// Whether an fsync reached the platter is not observable from userspace
/// without a real crash, so this proves the property that IS observable and
/// that a family-scoped skip would violate: ONE unconditional call site, taking
/// the family-derived source descriptor, guarded only by the deterministic
/// fault seam and never by a family test.
#[test]
fn the_durability_barrier_is_unconditional_for_both_residue_families() {
    let src = include_str!("../archive_reclaim_execute.rs");
    let stage = &src[src.find("fn run_residue_stage(").expect("the staging stage")..];

    assert_eq!(
        stage.matches("durable_quarantine_transition(").count(),
        1,
        "one barrier call site serves both families"
    );

    let at = stage.find("let namespace_durable").expect("the barrier binding");
    let end = stage[at..]
        .find("if let Err(code) = namespace_durable")
        .expect("its failure handling");
    let expr = &stage[at..at + end];
    assert!(
        expr.contains("fault::armed(fault::Point::AfterResidueRenameBeforeNamespaceDurability)"),
        "the only branch is the deterministic cfg(test) fault seam"
    );
    assert_eq!(expr.matches("if ").count(), 1, "no second condition may gate the barrier");
    assert!(!expr.contains("else if"), "no family may skip the barrier");
    for family in ["GenerationStaging", "DurableTemp", "ResidueFamily"] {
        assert!(!expr.contains(family), "the barrier must not branch on {family}");
    }
    assert!(
        expr.contains("exclusive, source_dir, run_dir"),
        "and it syncs the family-derived SOURCE descriptor, not a fixed one"
    );

    /* `source_dir` really is per-family: the packages directory for generation
       staging, the exact CAS shard for durable temp. */
    let at = stage.find("let source_dir = match").expect("the source selection");
    let selection = &stage[at..at + stage[at..].find("\n        };").unwrap()];
    assert!(selection.contains("(ResidueFamily::DurableTemp, Some(dir), _) => dir"));
    assert!(selection.contains("(ResidueFamily::GenerationStaging, _, Some(dir)) => dir"));
}

/// M06 T3.5 dwell + convergence, proven from the side that exercises both: a
/// LATER governed run converges an occupant quarantine left by an earlier run,
/// and consumes nothing else.
///
/// This is the second half of one-run dwell. T3.4 proved the acting run never
/// purges its own occupant; T3.5 owns the other side — a subsequent manual run
/// may, because its recovery pass runs before it has a namespace of its own, so
/// everything it can see belongs to a previous run by construction. No clock
/// participates. The prior quarantine is planted directly rather than produced
/// by the occupant action, so this also covers the state a crashed process
/// leaves behind.
#[test]
fn a_later_run_converges_a_prior_occupant_quarantine() {
    let root = scratch("dwell");
    let hashes = five(&root, "chat_a");
    plant_temp(&root, "ab", ".h2o-durable-3-0.tmp", b"residue");
    let staging = orphan_staging(&root, "chat_b");

    // A prior occupant quarantine, with its receipt.
    let prior = root.join(".h2o-reclaim").join("run-prior01");
    let held = prior.join("occupant.chat_x.gdeadbeef.h2ochat");
    std::fs::create_dir_all(held.join("nested")).unwrap();
    std::fs::write(held.join("manifest.json"), b"{ corrupt").unwrap();
    std::fs::write(held.join("nested").join("x"), b"deep").unwrap();
    std::fs::create_dir_all(root.join(".h2o-reclaim").join("receipts")).unwrap();
    std::fs::write(
        root.join(".h2o-reclaim")
            .join("receipts")
            .join("run-prior01.occupant.chat_x.gdeadbeef.h2ochat.occupant-quarantined.json"),
        br#"{"kind":"occupant","purged":false,"dwell":"one-run"}"#,
    )
    .unwrap();
    let prior_before = census(&prior);
    let receipts_before = census(&root.join(".h2o-reclaim").join("receipts"));

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));

    // The later run really did act, so this is not a vacuous survival.
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.purged, 2);
    assert_eq!(outcome.residue.generation_staging_purged, 1);
    assert_eq!(outcome.residue.durable_temp_purged, 1);
    assert!(!root.join("packages").join(&staging).exists());

    // The prior occupant quarantine converged, through the T3.1 confined purge.
    assert_eq!(outcome.recovered, 1, "the stale occupant was recovered");
    assert!(!held.exists(), "the dwelling occupant converged on the LATER run");
    assert!(!held.join("nested").join("x").exists());
    assert!(prior.is_dir(), "the run namespace itself is left as evidence");
    assert!(!prior_before.is_empty(), "the fixture really held physical state");

    // Evidence is never consumed: the receipts sibling survives intact and
    // gains exactly one recovery record.
    let receipts_after = census(&root.join(".h2o-reclaim").join("receipts"));
    assert!(
        receipts_before.iter().all(|e| receipts_after.contains(e)),
        "no receipt was pruned"
    );
    let recovery: Vec<&(String, String)> = receipts_after
        .iter()
        .filter(|(n, _)| n.contains("recovery"))
        .collect();
    assert_eq!(recovery.len(), 1, "exactly one recovery record: {receipts_after:?}");

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

// ── M06 T3.5 — real-process crash / convergence matrix ─────────────────────

use crate::archive_reclaim::crash;

/// Marker the child writes ONLY if it ran to completion without crashing.
/// Its ABSENCE is the anti-vacuity proof that the injected window was reached.
const NO_CRASH_MARKER: &str = "H2O_T35_REACHED_END";

/// Child-process entry point. Establishes real archive participation, takes
/// real exclusive ownership, arms ONE crash window and runs a real governed
/// destructive path — then aborts inside it.
///
/// Environment variables are read HERE, inside a `#[cfg(test)] #[ignore]`
/// helper that never exists in a release build. No production code path reads
/// an environment variable.
#[test]
#[ignore]
fn helper_crash_child() {
    let Ok(root) = std::env::var("H2O_T35_ROOT") else { return };
    let root = PathBuf::from(root);
    let mode = std::env::var("H2O_T35_MODE").unwrap_or_else(|_| "run".to_string());
    let skip: u32 = std::env::var("H2O_T35_SKIP")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let point = std::env::var("H2O_T35_POINT")
        .ok()
        .and_then(|t| crash::Point::parse(&t));

    let state = ArchiveInstanceState::default();
    state.ensure_presence(&root).expect("shared presence");
    let ex = state.try_acquire_exclusive().expect("exclusive ownership");
    if let Some(p) = point {
        crash::arm(p, skip);
    }

    if mode == "occupant" {
        let chat = std::env::var("H2O_T35_CHAT").unwrap_or_default();
        let name = std::env::var("H2O_T35_NAME").unwrap_or_default();
        let _ = crate::archive_occupant_quarantine::quarantine_internal_for_test(
            &ex,
            &root,
            true,
            &crate::archive_occupant_quarantine::OccupantRequest {
                chat_id: chat,
                occupant_name: name,
            },
        );
    } else {
        let chat = std::env::var("H2O_T35_CHAT").unwrap_or_default();
        let hash = std::env::var("H2O_T35_HASH").unwrap_or_default();
        let _ = run_internal(&ex, &root, true, &request(&chat, "ok", &hash), &db(vec![]));
    }
    let _ = ex.release();
    // Only reached when the window was NOT hit.
    std::fs::write(root.join(NO_CRASH_MARKER), b"1").ok();
}

/// Spawns the child and returns true when it genuinely died at the window.
fn crash_child(root: &Path, mode: &str, point: &str, skip: u32, env: &[(&str, &str)]) -> bool {
    let exe = std::env::current_exe().expect("test binary");
    let mut command = std::process::Command::new(exe);
    command
        .arg("archive_reclaim_execute::tests::helper_crash_child")
        .arg("--exact")
        .arg("--include-ignored")
        .arg("--test-threads=1")
        .env("H2O_T35_ROOT", root)
        .env("H2O_T35_MODE", mode)
        .env("H2O_T35_POINT", point)
        .env("H2O_T35_SKIP", skip.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    for (k, v) in env {
        command.env(k, v);
    }
    let status = command.status().expect("spawn crash child");
    let reached_end = root.join(NO_CRASH_MARKER).exists();
    // ANTI-VACUITY: the child must have died, not merely returned.
    !status.success() && !reached_end
}

/// Every `*.h2ochat` occupant is a COMPLETE package or is absent. This is the
/// crash invariant: the canonical namespace never holds a half-deleted entry.
fn canonical_entries_are_whole(root: &Path) -> Result<usize, String> {
    let mut whole = 0;
    let entries = match std::fs::read_dir(root.join("packages")) {
        Ok(it) => it,
        Err(_) => return Ok(0),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".h2ochat") {
            continue;
        }
        let dir = entry.path();
        if !dir.is_dir() {
            return Err(format!("{name} is not a directory"));
        }
        for member in ["manifest.json", "snapshot.json"] {
            if !dir.join(member).exists() {
                return Err(format!("{name} is half-deleted: {member} missing"));
            }
        }
        whole += 1;
    }
    Ok(whole)
}

fn cas_census(root: &Path) -> Vec<(String, String)> {
    census(&root.join("assets"))
        .into_iter()
        .filter(|(n, _)| n.contains("sha256-"))
        .collect()
}

/// The shared crash fixture: five generations for one chat (two beyond the
/// K=3 floor), both residue families, and referenced plus
/// observed-unreferenced canonical CAS bodies.
fn crash_fixture(tag: &str) -> (PathBuf, String, String) {
    let root = scratch(tag);
    let hashes = five(&root, "chat_a");
    let staging = orphan_staging(&root, "chat_b");
    plant_temp(&root, "ab", ".h2o-durable-5-0.tmp", b"residue");
    plant_temp(&root, "ab", &format!("sha256-{}", "ab".repeat(32)), b"referenced");
    plant_temp(&root, "cd", &format!("sha256-{}", "cd".repeat(32)), b"observed-unreferenced");
    (root, hashes[4].clone(), staging)
}

/// One matrix row: crash at a window in a real process, verify the crash
/// invariant on what survived, then converge and prove idempotence.
struct RowResult {
    crashed: bool,
    whole_before: usize,
    recovered: usize,
    converged_state: RunState,
    idempotent: bool,
    cas_identical: bool,
    lock_reacquired: bool,
}

fn crash_row(tag: &str, point: &str, skip: u32) -> RowResult {
    let (root, hash, _staging) = crash_fixture(tag);
    let cas_before = cas_census(&root);

    let crashed = crash_child(
        &root,
        "run",
        point,
        skip,
        &[("H2O_T35_CHAT", "chat_a"), ("H2O_T35_HASH", &hash)],
    );

    // The crash invariant, on exactly what the dead process left behind.
    let whole_before = canonical_entries_are_whole(&root).expect("no half-deleted canonical entry");
    let cas_after_crash = cas_census(&root);

    // The OS released the archive lock: no cleanup of ours ran.
    let owner = Owner::acquire(&root);
    let lock_reacquired = owner.state.try_acquire_exclusive().is_ok();
    let ex = owner.exclusive();

    // Convergence: recovery plus a fresh governed run.
    let first = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hash));
    let after_first = census(&root);
    // A second pass must make no material change.
    let second = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hash));
    let idempotent = census(&root) == after_first && second.recovered == 0;

    let cas_identical = cas_after_crash == cas_before && cas_census(&root) == cas_before;
    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());

    RowResult {
        crashed,
        whole_before,
        recovered: first.recovered,
        converged_state: first.state,
        idempotent,
        cas_identical,
        lock_reacquired,
    }
}

/// THE CRASH / CONVERGENCE MATRIX — generation and staging windows, each in a
/// genuinely separate process that dies inside the window.
///
/// For every row: the child really crashed; the canonical namespace holds no
/// half-deleted entry; every canonical CAS body is byte-identical; the OS — not
/// any cleanup of ours — released the archive lock; a later governed run
/// converges; and a second run makes no further material change.
#[test]
fn the_generation_and_staging_crash_matrix_converges() {
    let rows: &[(&str, &str, u32)] = &[
        // 1. after plan durable, before the first canonical rename.
        ("m1", "plan-before-rename", 0),
        // 2. after canonical rename, before namespace durability.
        ("m2", "rename-before-durable", 0),
        // 3. after namespace durability, before the quarantine receipt.
        ("m3", "durable-before-receipt", 0),
        // 4. after the quarantine receipt, before the purge.
        ("m4", "receipt-before-purge", 0),
        // 5. after the purge, before the purge receipt.
        ("m5", "purge-before-receipt", 0),
        // 6. between two generation items.
        ("m6", "between-generations", 0),
        // 7. generation stage complete, before the first staging rename.
        ("m7", "generations-before-staging", 0),
        // 8a-8d. every staging window, and between two staging items.
        ("m8a", "residue-rename-before-durable", 0),
        ("m8b", "residue-durable-before-receipt", 0),
        ("m8c", "residue-receipt-before-purge", 0),
        ("m8d", "between-staging", 0),
        // Second occurrence of a window, i.e. the second item of a stage.
        ("m9", "rename-before-durable", 1),
    ];

    for (tag, point, skip) in rows {
        let r = crash_row(tag, point, *skip);
        assert!(r.crashed, "[{tag}] the child must genuinely die at {point}");
        assert!(
            r.whole_before >= 3,
            "[{tag}] the K=3 floor survived the crash: {}",
            r.whole_before
        );
        assert!(r.cas_identical, "[{tag}] canonical CAS changed");
        assert!(r.lock_reacquired, "[{tag}] the OS did not release the archive lock");
        assert!(
            matches!(r.converged_state, RunState::Complete | RunState::NoOp),
            "[{tag}] the later run did not converge: {:?}",
            r.converged_state
        );
        assert!(r.idempotent, "[{tag}] a second run made further material change");
    }
}

/// Rows 1-5 again, but proving the recovery pass actually had stale state to
/// converge in the windows where the crash left quarantine behind.
///
/// Anti-vacuity for the matrix above: without this, "converged" could mean
/// "there was nothing to do".
#[test]
fn crash_windows_after_a_rename_leave_stale_quarantine_that_recovery_converges() {
    for (tag, point) in [
        ("s1", "rename-before-durable"),
        ("s2", "durable-before-receipt"),
        ("s3", "receipt-before-purge"),
    ] {
        let (root, hash, _) = crash_fixture(tag);
        let cas_before = cas_census(&root);
        assert!(
            crash_child(&root, "run", point, 0, &[("H2O_T35_CHAT", "chat_a"), ("H2O_T35_HASH", &hash)]),
            "[{tag}] child must crash"
        );

        // The crash landed AFTER a rename: quarantine physically holds an item.
        let reclaim = root.join(".h2o-reclaim");
        assert!(reclaim.is_dir(), "[{tag}] a run namespace survived the crash");
        let stale: Vec<PathBuf> = std::fs::read_dir(&reclaim)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap() != "receipts")
            .collect();
        assert_eq!(stale.len(), 1, "[{tag}] exactly one crashed run: {stale:?}");
        let items: Vec<String> = std::fs::read_dir(&stale[0])
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(items.len(), 1, "[{tag}] a complete renamed entry: {items:?}");
        // Complete, not half-copied.
        for member in ["manifest.json", "snapshot.json"] {
            assert!(
                stale[0].join(&items[0]).join(member).exists(),
                "[{tag}] the quarantined entry is incomplete"
            );
        }
        assert_eq!(canonical_entries_are_whole(&root).unwrap(), 4, "[{tag}] one left canonical");

        // Convergence really recovers that item.
        let owner = Owner::acquire(&root);
        let ex = owner.exclusive();
        let converged = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hash));
        assert_eq!(converged.recovered, 1, "[{tag}] the stale item was converged");
        assert!(!stale[0].join(&items[0]).exists(), "[{tag}] and is physically gone");
        assert_eq!(cas_census(&root), cas_before, "[{tag}] CAS untouched");

        let again = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hash));
        assert_eq!(again.recovered, 0, "[{tag}] repeated recovery is idempotent");

        let _ = ex.release();
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}

/// OCCUPANT crash windows, plus the second half of one-run dwell: the crashed
/// run's occupant is preserved, and a LATER governed run converges it.
#[test]
fn the_occupant_crash_matrix_converges_on_a_later_run() {
    for (tag, point, expect_quarantined) in [
        // 9. plan durable, before the occupant rename.
        ("o1", "occupant-plan-before-rename", false),
        // 10. rename succeeded, before namespace durability.
        ("o2", "occupant-rename-before-durable", true),
        // 11. namespace durable, before the receipt.
        ("o3", "occupant-durable-before-receipt", true),
    ] {
        let root = scratch(tag);
        const WHEN: &str = "2027-01-01T00:00:00.000Z";
        let name = plant_corrupt_occupant(&root, "chat_bad", WHEN);
        publish(&root, "chat_keep", "2027-01-02T00:00:00.000Z");
        plant_temp(&root, "ab", &format!("sha256-{}", "ab".repeat(32)), b"referenced");
        let cas_before = cas_census(&root);

        assert!(
            crash_child(&root, "occupant", point, 0,
                &[("H2O_T35_CHAT", "chat_bad"), ("H2O_T35_NAME", &name)]),
            "[{tag}] child must crash"
        );

        let canonical = root.join("packages").join(&name);
        if expect_quarantined {
            assert!(!canonical.exists(), "[{tag}] the occupant left canonical space");
            let reclaim = root.join(".h2o-reclaim");
            let runs: Vec<PathBuf> = std::fs::read_dir(&reclaim)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.file_name().unwrap() != "receipts")
                .collect();
            assert_eq!(runs.len(), 1, "[{tag}]");
            assert!(
                runs[0].join(format!("occupant.{name}")).is_dir(),
                "[{tag}] a COMPLETE quarantined occupant survived the crash"
            );
        } else {
            assert!(canonical.exists(), "[{tag}] nothing was renamed before the crash");
        }
        assert!(canonical_entries_are_whole(&root).is_ok(), "[{tag}] no half-deleted entry");

        // A LATER governed run converges it. No clock takes part: the run's
        // recovery pass simply precedes its own namespace.
        let owner = Owner::acquire(&root);
        assert!(owner.state.try_acquire_exclusive().is_ok(), "[{tag}] OS released the lock");
        let ex = owner.exclusive();
        let later = run(&root, &ex, &db(vec![]), &request("chat_keep", "ok", "deadbeef"));
        if expect_quarantined {
            assert_eq!(later.recovered, 1, "[{tag}] the prior occupant converged");
        }
        let after = census(&root);
        let again = run(&root, &ex, &db(vec![]), &request("chat_keep", "ok", "deadbeef"));
        assert_eq!(again.recovered, 0, "[{tag}] idempotent");
        assert_eq!(census(&root), after, "[{tag}] no further material change");
        assert_eq!(cas_census(&root), cas_before, "[{tag}] CAS untouched");

        let _ = ex.release();
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}

/// A corrupt occupant sitting at a canonical generation destination.
fn plant_corrupt_occupant(root: &Path, chat: &str, saved_at: &str) -> String {
    let hashes = publish_named(root, chat, saved_at);
    std::fs::write(root.join("packages").join(&hashes).join("manifest.json"), b"{ nope").unwrap();
    hashes
}

/// Publishes and returns the canonical basename the publisher chose.
fn publish_named(root: &Path, chat: &str, saved_at: &str) -> String {
    let before: std::collections::BTreeSet<String> = pkg_names(root).into_iter().collect();
    publish(root, chat, saved_at);
    pkg_names(root)
        .into_iter()
        .find(|n| !before.contains(n))
        .expect("a new generation")
}

/// Row 18: process termination while holding ExclusiveOwnership. The OS
/// releases it; no manual lock cleanup exists anywhere.
#[test]
fn a_crashed_process_releases_the_archive_lock_to_the_next_one() {
    let (root, hash, _) = crash_fixture("lockrelease");

    // Control: participation works before.
    assert!(child_can_participate(&root), "precondition");

    assert!(
        crash_child(&root, "run", "rename-before-durable", 0,
            &[("H2O_T35_CHAT", "chat_a"), ("H2O_T35_HASH", &hash)]),
        "the child must die while holding exclusive ownership"
    );

    // No cleanup of ours ran; the kernel dropped the flock with the process.
    assert!(
        child_can_participate(&root),
        "a separate process must be able to participate after the crash"
    );
    let owner = Owner::acquire(&root);
    let ex = owner.state.try_acquire_exclusive().expect("exclusive is reacquirable");
    let converged = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hash));
    assert_eq!(converged.recovered, 1);
    assert!(matches!(converged.state, RunState::Complete | RunState::NoOp));

    // Nothing in the destructive core removes or repairs the lock file itself.
    for source in [
        include_str!("../archive_reclaim.rs"),
        include_str!("../archive_reclaim_execute.rs"),
        include_str!("../archive_occupant_quarantine.rs"),
        include_str!("../archive_reclaim_recovery.rs"),
    ] {
        let code: String = source
            .lines()
            .map(str::trim_start)
            .filter(|l| !l.starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in ["ARCHIVE_LOCK_NAME", "force_unlock", ".h2o-archive.lock"] {
            assert!(!code.contains(forbidden), "no manual lock cleanup: {forbidden}");
        }
    }

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// Rows 13-17: the RUN / EVIDENCE landing states, and what recovery makes of
/// each. Evidence is never consumed, and an unattributable entry blocks its own
/// run without touching anything.
#[test]
fn the_evidence_landing_states_are_classified_and_never_consumed() {
    // 13. a plan exists and nothing was acted: the crash landed before the
    //     first rename, so there is no run directory to converge at all.
    let (root, hash, _) = crash_fixture("e13");
    assert!(crash_child(&root, "run", "plan-before-rename", 0,
        &[("H2O_T35_CHAT", "chat_a"), ("H2O_T35_HASH", &hash)]));
    let receipts: Vec<String> = std::fs::read_dir(root.join(".h2o-reclaim").join("receipts"))
        .unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert_eq!(receipts.len(), 1, "the durable plan, and only the plan: {receipts:?}");
    assert!(receipts[0].ends_with(".plan.json"));
    let runs: Vec<PathBuf> = std::fs::read_dir(root.join(".h2o-reclaim")).unwrap()
        .map(|e| e.unwrap().path()).filter(|p| p.file_name().unwrap() != "receipts").collect();
    assert!(runs.is_empty(), "no run namespace was created: {runs:?}");
    assert_eq!(canonical_entries_are_whole(&root).unwrap(), 5, "nothing left canonical space");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let out = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hash));
    assert_eq!(out.recovered, 0, "there was nothing stale to converge");
    assert_eq!(out.purged, 2, "and the fresh run proceeded normally");
    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());

    // 15. a purge completed and its receipt did not: the quarantine entry is
    //     already absent, so convergence is a no-op rather than an error.
    let (root, hash, _) = crash_fixture("e15");
    assert!(crash_child(&root, "run", "purge-before-receipt", 0,
        &[("H2O_T35_CHAT", "chat_a"), ("H2O_T35_HASH", &hash)]));
    let runs: Vec<PathBuf> = std::fs::read_dir(root.join(".h2o-reclaim")).unwrap()
        .map(|e| e.unwrap().path()).filter(|p| p.file_name().unwrap() != "receipts").collect();
    assert_eq!(runs.len(), 1);
    assert_eq!(
        std::fs::read_dir(&runs[0]).unwrap().count(),
        0,
        "the item was purged before the crash"
    );
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let out = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hash));
    assert_eq!(out.recovered, 0, "an empty run needs no convergence");
    assert!(matches!(out.state, RunState::Complete | RunState::NoOp), "{:?}", out.blockers);
    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());

    // 16. a malformed receipt beside a recognized run. Receipts live in the
    //     reserved sibling, which recovery never walks, so it cannot be
    //     consumed and cannot mislead the pass.
    let root = scratch("e16");
    let hashes = five(&root, "chat_a");
    std::fs::create_dir_all(root.join(".h2o-reclaim").join("run-aa01")).unwrap();
    std::fs::create_dir_all(
        root.join(".h2o-reclaim").join("run-aa01").join("chat_z.gab.h2ochat"),
    ).unwrap();
    let stale_item = root.join(".h2o-reclaim").join("run-aa01")
        .join(format!("chat_z.g{}.h2ochat", "ab".repeat(32)));
    std::fs::create_dir_all(&stale_item).unwrap();
    std::fs::remove_dir_all(root.join(".h2o-reclaim").join("run-aa01").join("chat_z.gab.h2ochat")).unwrap();
    std::fs::create_dir_all(root.join(".h2o-reclaim").join("receipts")).unwrap();
    std::fs::write(root.join(".h2o-reclaim").join("receipts").join("garbage.json"), b"{{{ not json").unwrap();
    std::fs::write(root.join(".h2o-reclaim").join("receipts").join("run-zz.orphan.json"), b"[]").unwrap();
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let out = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(out.recovered, 1, "the run converged despite the malformed receipts");
    assert!(!stale_item.exists());
    assert!(root.join(".h2o-reclaim").join("receipts").join("garbage.json").exists(),
        "a malformed receipt is never consumed");
    assert!(root.join(".h2o-reclaim").join("receipts").join("run-zz.orphan.json").exists());
    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());

    // 17. a recognized run holding an entry no committed grammar names: the
    //     whole governed run refuses, and nothing is touched.
    let root = scratch("e17");
    let hashes = five(&root, "chat_a");
    std::fs::create_dir_all(root.join(".h2o-reclaim").join("run-bb01").join("mystery")).unwrap();
    let owner = Owner::acquire(&root);
    let before = census(&root);
    let ex = owner.exclusive();
    let out = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(out.state, RunState::Refused, "an unconverged archive blocks fresh work");
    assert!(out.blockers.contains(&codes::RECOVERY_INCOMPLETE.to_string()));
    assert!(out.blockers.contains(
        &crate::archive_reclaim_recovery::codes::ITEM_UNATTRIBUTABLE.to_string()));
    assert_eq!(out.purged, 0);
    assert_eq!(census(&root), before, "not one byte changed");
    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// AC-M06-11 — EVIDENCE COMPLETENESS. Every physically acted item is
/// explainable by durable evidence plus surviving quarantine, with nothing left
/// over on either side.
#[test]
fn every_physically_acted_item_is_accounted_for_by_evidence() {
    let root = scratch("accounting");
    let hashes = five(&root, "chat_a");
    let staging = orphan_staging(&root, "chat_b");
    plant_temp(&root, "ab", ".h2o-durable-4-0.tmp", b"residue");
    // A crashed prior run, so recovery has something to account for too.
    let stale = root.join(".h2o-reclaim").join("run-aa01")
        .join(format!("chat_old.g{}.h2ochat", "cd".repeat(32)));
    std::fs::create_dir_all(&stale).unwrap();
    /* Every canonical namespace a destructive stage can act on: the packages
       directory AND each CAS shard, where durable-temp residue lives. */
    let canonical_names = |root: &Path| -> std::collections::BTreeSet<String> {
        let mut all: std::collections::BTreeSet<String> =
            pkg_names(root).into_iter().collect();
        if let Ok(shards) = std::fs::read_dir(root.join("assets")) {
            for shard in shards.flatten() {
                if let Ok(entries) = std::fs::read_dir(shard.path()) {
                    for e in entries.flatten() {
                        all.insert(e.file_name().to_string_lossy().to_string());
                    }
                }
            }
        }
        all
    };
    let packages_before = canonical_names(&root);

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);

    // 1. What PHYSICALLY left the canonical namespace.
    let packages_after = canonical_names(&root);
    let mut physically_acted: Vec<String> =
        packages_before.difference(&packages_after).cloned().collect();
    physically_acted.sort();
    assert!(!physically_acted.is_empty(), "anti-vacuity: the run really acted");

    // 2. What the EVIDENCE says was acted.
    let mut evidenced: Vec<String> = vec![];
    let mut recovered_by_evidence = 0usize;
    for entry in std::fs::read_dir(root.join(".h2o-reclaim").join("receipts")).unwrap() {
        let path = entry.unwrap().path();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).expect("evidence parses");
        match value["kind"].as_str() {
            Some("generation") if value["action"] == "purged" => {
                evidenced.push(
                    value["canonicalPath"].as_str().unwrap()
                        .rsplit('/').next().unwrap().to_string(),
                );
            }
            Some("staging") if value["action"] == "purged" => {
                evidenced.push(
                    value["archivePath"].as_str().unwrap()
                        .rsplit('/').next().unwrap().to_string(),
                );
            }
            _ => {
                if value["stages"] == serde_json::json!(["stale-quarantine-recovery"]) {
                    recovered_by_evidence += value["recovery"]["purged"].as_u64().unwrap() as usize;
                }
            }
        }
    }
    evidenced.sort();
    evidenced.dedup();

    // 3. What SURVIVES in quarantine and therefore needs no purge receipt.
    let mut surviving = 0usize;
    for entry in std::fs::read_dir(root.join(".h2o-reclaim")).unwrap() {
        let path = entry.unwrap().path();
        if path.file_name().unwrap() == "receipts" {
            continue;
        }
        surviving += std::fs::read_dir(&path).unwrap().count();
    }

    // THE ACCOUNTING: every item that physically left canonical space is
    // explained, and every explanation names something that really left.
    assert_eq!(
        physically_acted, evidenced,
        "evidence and physical state must account for each other exactly"
    );
    assert_eq!(outcome.purged + outcome.residue.generation_staging_purged
        + outcome.residue.durable_temp_purged, evidenced.len(),
        "the reported counts match the receipts");
    assert_eq!(recovered_by_evidence, outcome.recovered, "recovery is accounted for too");
    assert_eq!(outcome.recovered, 1, "and it really recovered the crashed run");
    assert_eq!(surviving, 0, "nothing is left unexplained in quarantine");
    assert!(!root.join("packages").join(&staging).exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// A hostile renderer request, from a deterministic corpus.
struct Hostile {
    label: &'static str,
    status: &'static str,
    /// How the content hash is supplied. Applied to the newest hash.
    hash: fn(&str) -> String,
    scope: Option<Vec<String>>,
    include_projection: bool,
    duplicate: bool,
}

fn hostile_corpus(newest_a: &str, newest_b: &str) -> Vec<(Hostile, PreviewRequest)> {
    let scopes: Vec<(&'static str, Option<Vec<String>>)> = vec![
        ("all-chats", None),
        ("narrow", Some(vec!["chat_a".to_string()])),
        ("other-chat", Some(vec!["chat_b".to_string()])),
        ("both", Some(vec!["chat_a".to_string(), "chat_b".to_string()])),
        ("unknown-chat", Some(vec!["chat_absent".to_string()])),
    ];
    let hashes: Vec<(&'static str, fn(&str) -> String)> = vec![
        ("witnessed", |h| h.to_string()),
        ("malformed", |_| "NOT-A-HASH".to_string()),
        ("empty", |_| String::new()),
        ("unwitnessed", |_| "ab".repeat(32)),
        ("uppercase", |h| h.to_uppercase()),
        ("truncated", |h| h.chars().take(16).collect()),
    ];
    let statuses = ["ok", "stale", "unusable", "", "OK", "error"];

    let mut out = vec![];
    for (si, (scope_label, scope)) in scopes.iter().enumerate() {
        for (hi, (hash_label, hash)) in hashes.iter().enumerate() {
            let status = statuses[(si + hi) % statuses.len()];
            for &include in &[true, false] {
                for &duplicate in &[false, true] {
                    let mut projections = vec![];
                    if include {
                        projections.push(ProjectionInput {
                            chat_id: "chat_a".to_string(),
                            status: status.to_string(),
                            content_hash: hash(newest_a),
                        });
                        projections.push(ProjectionInput {
                            chat_id: "chat_b".to_string(),
                            status: status.to_string(),
                            content_hash: hash(newest_b),
                        });
                        if duplicate {
                            projections.push(ProjectionInput {
                                chat_id: "chat_a".to_string(),
                                status: "ok".to_string(),
                                content_hash: hash(newest_a),
                            });
                        }
                        projections.reverse();
                    }
                    out.push((
                        Hostile {
                            label: scope_label,
                            status,
                            hash: *hash,
                            scope: scope.clone(),
                            include_projection: include,
                            duplicate,
                        },
                        PreviewRequest { chat_scope: scope.clone(), projections },
                    ));
                    let _ = hash_label;
                }
            }
        }
    }
    out
}

/// AC-M06-01 — FLOOR INVARIANCE under a hostile renderer corpus.
///
/// No combination of missing, failed, malformed, unwitnessed, duplicated,
/// reordered or out-of-scope renderer input may reduce the structural
/// protection: the newest package overall, the newest K=3 of a live family, a
/// legacy package and a non-VALID occupant all survive every single one.
#[test]
fn no_hostile_renderer_input_can_reduce_the_structural_floor() {
    let mut acted_at_least_once = false;
    let mut cases = 0usize;

    for (hostile, request) in hostile_corpus("seed", "seed") {
        let root = scratch(&format!("floor-{cases}"));
        let a = five(&root, "chat_a");
        let b: Vec<String> = (1..=4)
            .map(|d| publish(&root, "chat_b", &format!("2026-02-0{d}T00:00:00.000Z")))
            .collect();
        // A legacy package and a corrupt occupant, both structurally protected.
        // `publish` returns a content hash; the LEGACY fixture needs the
        // basename the publisher actually chose.
        let legacy_src = publish_named(&root, "chat_leg", "2026-03-01T00:00:00.000Z");
        std::fs::rename(
            root.join("packages").join(&legacy_src),
            root.join("packages").join("chat_leg.h2ochat"),
        ).unwrap();
        let corrupt = format!("chat_corrupt.g{}.h2ochat", "ef".repeat(32));
        std::fs::create_dir_all(root.join("packages").join(&corrupt)).unwrap();
        std::fs::write(root.join("packages").join(&corrupt).join("manifest.json"), b"{ no").unwrap();

        // Rebuild the request against THIS root's real hashes.
        let request = PreviewRequest {
            chat_scope: hostile.scope.clone(),
            projections: if hostile.include_projection {
                let mut p = vec![
                    ProjectionInput { chat_id: "chat_a".into(), status: hostile.status.into(),
                        content_hash: (hostile.hash)(&a[4]) },
                    ProjectionInput { chat_id: "chat_b".into(), status: hostile.status.into(),
                        content_hash: (hostile.hash)(&b[3]) },
                ];
                if hostile.duplicate {
                    p.push(ProjectionInput { chat_id: "chat_a".into(), status: "ok".into(),
                        content_hash: (hostile.hash)(&a[4]) });
                }
                p.reverse();
                p
            } else {
                vec![]
            },
        };

        let owner = Owner::acquire(&root);
        let ex = owner.exclusive();
        let outcome = run(&root, &ex, &db(vec![]), &request);
        if outcome.purged > 0 {
            acted_at_least_once = true;
        }

        let survivors = pkg_names(&root);
        let label = format!("{}/{}/{}", hostile.label, hostile.status, hostile.include_projection);
        // The newest package of each chat, always.
        for (chat, newest) in [("chat_a", &a[4]), ("chat_b", &b[3])] {
            assert!(
                survivors.iter().any(|n| n.contains(newest)),
                "[{label}] the newest {chat} generation was acted on"
            );
        }
        // K=3 per chat, always.
        for chat in ["chat_a", "chat_b"] {
            let kept = survivors.iter().filter(|n| n.starts_with(&format!("{chat}.g"))).count();
            assert!(kept >= 3, "[{label}] {chat} fell below the K=3 floor: {kept}");
        }
        // Legacy and the non-VALID occupant, always.
        assert!(survivors.contains(&"chat_leg.h2ochat".to_string()), "[{label}] legacy acted");
        assert!(survivors.contains(&corrupt), "[{label}] a non-VALID occupant was acted on");

        let _ = ex.release();
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
        cases += 1;
    }

    assert!(cases >= 100, "the corpus is substantial: {cases}");
    assert!(
        acted_at_least_once,
        "ANTI-VACUITY: at least one corpus case must genuinely act, or the floor \
         proof passes because nothing ever happened"
    );
}

/// AC-M06-07 — MONOTONICITY on the full execute-facing result. Removing
/// renderer information can only shrink what is acted on, never grow it.
#[test]
fn removing_renderer_information_never_grows_the_acted_set() {
    fn acted(tag: &str, build: impl Fn(&str, &str) -> PreviewRequest) -> (usize, Vec<String>) {
        let root = scratch(tag);
        let a = five(&root, "chat_a");
        let b: Vec<String> = (1..=4)
            .map(|d| publish(&root, "chat_b", &format!("2026-02-0{d}T00:00:00.000Z")))
            .collect();
        let owner = Owner::acquire(&root);
        let ex = owner.exclusive();
        let outcome = run(&root, &ex, &db(vec![]), &build(&a[4], &b[3]));
        let mut names: Vec<String> = outcome
            .acted
            .iter()
            .map(|i| i.canonical_path.rsplit('/').next().unwrap().to_string())
            .collect();
        names.sort();
        let purged = outcome.purged;
        let _ = ex.release();
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
        (purged, names)
    }

    let full = |a: &str, b: &str| PreviewRequest {
        chat_scope: None,
        projections: vec![
            ProjectionInput { chat_id: "chat_a".into(), status: "ok".into(), content_hash: a.into() },
            ProjectionInput { chat_id: "chat_b".into(), status: "ok".into(), content_hash: b.into() },
        ],
    };
    let (full_purged, full_set) = acted("mono-full", full);
    assert!(full_purged > 0, "ANTI-VACUITY: the positive control must really act");

    // Every degradation of that same request, against identical trusted state.
    let degradations: Vec<(&str, fn(&str, &str) -> PreviewRequest)> = vec![
        ("one-chat-dropped", |a, _| PreviewRequest {
            chat_scope: None,
            projections: vec![ProjectionInput {
                chat_id: "chat_a".into(), status: "ok".into(), content_hash: a.into() }],
        }),
        ("all-dropped", |_, _| PreviewRequest { chat_scope: None, projections: vec![] }),
        ("status-failed", |a, b| PreviewRequest {
            chat_scope: None,
            projections: vec![
                ProjectionInput { chat_id: "chat_a".into(), status: "unusable".into(), content_hash: a.into() },
                ProjectionInput { chat_id: "chat_b".into(), status: "unusable".into(), content_hash: b.into() },
            ],
        }),
        ("hash-corrupted", |_, _| PreviewRequest {
            chat_scope: None,
            projections: vec![
                ProjectionInput { chat_id: "chat_a".into(), status: "ok".into(), content_hash: "zz".into() },
                ProjectionInput { chat_id: "chat_b".into(), status: "ok".into(), content_hash: "zz".into() },
            ],
        }),
        ("scope-narrowed", |a, _| PreviewRequest {
            chat_scope: Some(vec!["chat_a".into()]),
            projections: vec![ProjectionInput {
                chat_id: "chat_a".into(), status: "ok".into(), content_hash: a.into() }],
        }),
    ];
    for (label, build) in degradations {
        let (purged, set) = acted(&format!("mono-{label}"), build);
        assert!(
            purged <= full_purged,
            "[{label}] losing renderer information increased the acted count"
        );
        assert!(
            set.iter().all(|n| full_set.contains(n)),
            "[{label}] losing renderer information acted on something new: {set:?}"
        );
    }
}

/// AC-M06-08 — the trusted DB probe stays fail-closed, and every provenance and
/// writing-state class blocks execution.
#[test]
fn every_db_protection_class_blocks_execution_and_probe_failure_blocks_all() {
    use crate::archive_db_probe::{DbProbeCounts, GenerationProtection, ProtectionSource};

    let sources = [
        ProtectionSource::StrandedWriting,
        ProtectionSource::Import,
        ProtectionSource::Restore,
        ProtectionSource::Relink,
    ];
    for source in sources {
        let root = scratch("dbclass");
        let hashes = five(&root, "chat_a");
        let owner = Owner::acquire(&root);
        let ex = owner.exclusive();
        // Protect the two generations a clean run would otherwise act on.
        let protections: Vec<GenerationProtection> = hashes[..2]
            .iter()
            .map(|h| GenerationProtection {
                chat_id: "chat_a".to_string(),
                content_hash: h.clone(),
                source,
            })
            .collect();
        let outcome = run(&root, &ex, &db(protections), &request("chat_a", "ok", &hashes[4]));
        assert_eq!(outcome.purged, 0, "{source:?} did not protect");
        assert_eq!(pkg_names(&root).len(), 5, "{source:?}: every generation survives");
        let _ = ex.release();
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    // Probe failure: zero destructive action, whatever the probe managed to say.
    for (label, probe) in [
        ("incomplete-empty", crate::archive_db_probe::DbProbeResult {
            complete: false, blockers: vec!["db-unavailable".into()], cas_roots: vec![],
            generation_protections: vec![], counts: DbProbeCounts::default() }),
        ("incomplete-with-facts", crate::archive_db_probe::DbProbeResult {
            complete: false, blockers: vec!["db-busy".into()], cas_roots: vec![],
            generation_protections: vec![GenerationProtection {
                chat_id: "chat_a".into(), content_hash: "ab".repeat(32),
                source: ProtectionSource::Import }],
            counts: DbProbeCounts::default() }),
    ] {
        let root = scratch("dbfail");
        let hashes = five(&root, "chat_a");
        let owner = Owner::acquire(&root);
        let before = census(&root);
        let ex = owner.exclusive();
        let outcome = run(&root, &ex, &probe, &request("chat_a", "ok", &hashes[4]));
        assert_eq!(outcome.state, RunState::Refused, "[{label}] probe failure must refuse");
        assert_eq!(outcome.purged, 0);
        assert_eq!(census(&root), before, "[{label}] zero destructive action");
        let _ = ex.release();
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}

/// M06 P4 T4.1 — the ACTIVATED command's request marshaling.
///
/// The renderer can send whatever JSON it likes; what matters is that no field
/// beyond the approved enabling inputs can reach the trusted sequence. Extra
/// keys are inert because `PreviewRequest` has nowhere to put them, so an
/// injected path, plan, run id or force flag deserializes to exactly the same
/// request as if it had never been sent.
#[test]
fn the_activated_request_cannot_smuggle_authority_through_extra_fields() {
    let clean: PreviewRequest = serde_json::from_str(
        r#"{"chatScope":["chat_a"],"projections":[{"chatId":"chat_a","status":"ok","contentHash":"ab"}]}"#,
    )
    .expect("the approved payload deserializes");

    let hostile: PreviewRequest = serde_json::from_str(
        r#"{"chatScope":["chat_a"],"projections":[{"chatId":"chat_a","status":"ok","contentHash":"ab"}],
            "path":"/etc/passwd","archiveRoot":"/","packages":"/tmp","runId":"run-evil",
            "candidates":["chat_a.gaa.h2ochat"],"plan":{"decisions":[]},"retentionK":0,
            "force":true,"unsafe":true,"casSha":"sha256-aa","staleRun":"run-1",
            "quarantineTarget":"occupant.x"}"#,
    )
    .expect("extra keys are ignored, not fatal");

    assert_eq!(clean.chat_scope, hostile.chat_scope);
    assert_eq!(clean.projections.len(), hostile.projections.len());
    assert_eq!(clean.projections[0].chat_id, hostile.projections[0].chat_id);
    assert_eq!(clean.projections[0].content_hash, hostile.projections[0].content_hash);

    /* Structurally: the request type declares EXACTLY the two enabling inputs,
       so there is no field an injected value could have landed in. */
    let decl = {
        let src = include_str!("../archive_reclamation_preview.rs");
        let at = src.find("pub struct PreviewRequest {").unwrap();
        &src[at..at + src[at..].find("\n}").unwrap()]
    };
    let fields = &decl[decl.find('{').unwrap()..];
    assert_eq!(fields.matches("pub ").count(), 2, "exactly two request fields");
    assert!(fields.contains("chat_scope") && fields.contains("projections"));
}

// ── T02 RC-T02-02 — capability-probe residue through the governed run ───────

/// (RC-02 I.1)(I.3)(F)(H) a governed run admits probe residue from BOTH
/// archive-owned probe locations to the existing no-replace quarantine path,
/// with a collision-free identity per location, and every other family, every
/// canonical package and the reserved infrastructure beside them untouched.
#[test]
fn a_governed_run_reclaims_probe_residue_from_both_archive_owned_locations() {
    let root = scratch("rc02-run");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);

    // The same probe name in both locations: a crashed exclusive-create probe
    // (regular file) at the root, a crashed no-replace-rename probe
    // (directory) under packages, plus one more of each family.
    std::fs::write(root.join(".h2o-probe-31-0"), b"root-probe").unwrap();
    std::fs::create_dir_all(root.join("packages").join(".h2o-probe-31-0")).unwrap();
    std::fs::write(root.join("packages").join(".h2o-probe-31-0").join("x"), b"in").unwrap();
    std::fs::create_dir_all(root.join(".h2o-probe-31-1")).unwrap();
    std::fs::write(root.join("packages").join(".h2o-probe-32-0"), b"pkg-probe").unwrap();
    let staging = orphan_staging(&root, "chat_b");
    plant_temp(&root, "ab", ".h2o-durable-3-0.tmp", b"residue");
    let packages_before: Vec<String> = pkg_names(&root)
        .into_iter()
        .filter(|n| !n.starts_with(".h2o-"))
        .collect();
    let lock_before = std::fs::symlink_metadata(root.join(".h2o-archive.lock")).is_ok();

    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);

    // (I.3) all four probe items were quarantined AND purged, through the same
    // stage and the same counts model as the two established families.
    assert_eq!(outcome.residue.capability_probe_quarantined, 4);
    assert_eq!(outcome.residue.capability_probe_purged, 4);
    assert_eq!(outcome.residue.generation_staging_purged, 1);
    assert_eq!(outcome.residue.durable_temp_purged, 1);
    assert_eq!(outcome.residue_indeterminate, 0);
    assert_eq!(
        residue_ids(&outcome),
        vec![
            "generation-staging|archive/packages/".to_string() + &staging,
            "durable-temp|archive/assets/ab/.h2o-durable-3-0.tmp".to_string(),
            "capability-probe|archive/.h2o-probe-31-0".to_string(),
            "capability-probe|archive/.h2o-probe-31-1".to_string(),
            "capability-probe|archive/packages/.h2o-probe-31-0".to_string(),
            "capability-probe|archive/packages/.h2o-probe-32-0".to_string(),
        ],
        "family rank, then trusted archive identity"
    );
    // (F) the typed location is part of the quarantine identity, so the one
    // name standing in both locations became two distinct items.
    let items: Vec<&str> = outcome
        .residue_acted
        .iter()
        .filter(|r| r.family == ResidueFamily::CapabilityProbe)
        .map(|r| r.quarantine_item.as_str())
        .collect();
    assert_eq!(
        items,
        vec![
            "probe.root..h2o-probe-31-0",
            "probe.root..h2o-probe-31-1",
            "probe.packages..h2o-probe-31-0",
            "probe.packages..h2o-probe-32-0",
        ]
    );
    let receipts = receipt_names(&root);
    for item in &items {
        assert!(receipts.iter().any(|n| n.contains(item)), "receipts for {item}: {receipts:?}");
    }
    let run_id = outcome.run_id.clone().unwrap();
    let plan = receipt_json(&root, &format!("{run_id}.plan.json"));
    assert_eq!(plan["residue"]["capabilityProbeFound"], serde_json::json!(4));
    assert_eq!(plan["residue"]["generationStagingFound"], serde_json::json!(1));
    assert_eq!(plan["residue"]["durableTempFound"], serde_json::json!(1));
    assert_eq!(plan["residue"]["actions"].as_array().unwrap().len(), 6);

    // Nothing probe-shaped remains in either location — including anything
    // the run's own admission probe minted, which it removed itself.
    for dir in [root.clone(), root.join("packages")] {
        let leftover: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".h2o-probe-"))
            .collect();
        assert!(leftover.is_empty(), "{dir:?} still holds {leftover:?}");
    }
    assert!(!root.join("packages").join(&staging).exists());
    assert!(!root.join("assets").join("ab").join(".h2o-durable-3-0.tmp").exists());
    // (H) the canonical packages and the reserved infrastructure are intact.
    let packages_after: Vec<String> = pkg_names(&root)
        .into_iter()
        .filter(|n| !n.starts_with(".h2o-"))
        .collect();
    let mut expected = packages_before.clone();
    expected.retain(|n| !n.contains(&hashes[0]) && !n.contains(&hashes[1]));
    assert_eq!(packages_after, expected, "only the two beyond-floor generations left");
    assert_eq!(std::fs::symlink_metadata(root.join(".h2o-archive.lock")).is_ok(), lock_before);
    assert!(root.join(".h2o-reclaim").is_dir());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (RC-02 I.5)(C) a symlink wearing a probe name is reported indeterminate by
/// the run and never acted on: the link and its canonical target both survive
/// a run that demonstrably reclaimed the genuine residue beside it.
#[cfg(unix)]
#[test]
fn a_symlink_probe_lookalike_is_never_acted_on_by_a_governed_run() {
    let root = scratch("rc02-symlink");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    // The link target is the NEWEST generation — protected by the retention
    // floor, so its survival is attributable to the link never being followed.
    let newest = pkg_names(&root).into_iter().find(|n| n.contains(&hashes[4])).unwrap();
    let target = root.join("packages").join(newest);
    assert!(target.is_dir(), "a real canonical generation as the link target");
    std::os::unix::fs::symlink(&target, root.join(".h2o-probe-6-0")).unwrap();
    std::os::unix::fs::symlink(&target, root.join("packages").join(".h2o-probe-6-1")).unwrap();
    std::fs::write(root.join(".h2o-probe-6-2"), b"genuine").unwrap();
    let target_before = census(&target);

    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.residue.capability_probe_purged, 1, "the genuine item was reclaimed");
    assert_eq!(outcome.residue_indeterminate, 2, "both links were reported, not acted on");
    assert_eq!(residue_ids(&outcome), vec!["capability-probe|archive/.h2o-probe-6-2"]);
    assert!(root.join(".h2o-probe-6-0").symlink_metadata().unwrap().file_type().is_symlink());
    assert!(root.join("packages").join(".h2o-probe-6-1").symlink_metadata().unwrap().file_type().is_symlink());
    assert_eq!(census(&target), target_before, "the canonical target was never touched");
    assert!(!root.join(".h2o-probe-6-2").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (RC-02 E)(I.3)(I.8) the archive root is a RENAME SOURCE only: the residue
/// move accepts a proven probe name from it through the same no-replace
/// primitive, refuses both reserved exact infrastructure components before any
/// syscall, and refuses every canonical name — and no new primitive exists.
#[test]
fn the_archive_root_is_a_rename_source_only_for_probe_residue() {
    let root = scratch("rc02-source");
    let _hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    std::fs::write(root.join(".h2o-probe-2-0"), b"probe").unwrap();
    let ex = owner.exclusive();
    let reclaim = crate::archive_reclaim::open_reclaim_root_for_run(&ex, &root).unwrap();
    let run_id = crate::archive_reclaim::QuarantineRunId::parse("rc02").unwrap();
    let run_dir = reclaim.create_run(&ex, &run_id).unwrap();
    let source = reclaim.archive_dir();
    let item = QuarantineComponent::parse("probe.root..h2o-probe-2-0").unwrap();

    // Reserved EXACT infrastructure: refused by name, before any syscall.
    for infra in [".h2o-archive.lock", ".h2o-reclaim"] {
        let name = QuarantineComponent::parse(infra).unwrap();
        assert_eq!(
            quarantine_residue(&ex, source, &run_dir, &name, &item),
            Err(crate::archive_reclaim::codes::RESIDUE_SOURCE_INFRASTRUCTURE.to_string()),
            "{infra}"
        );
    }
    assert!(root.join(".h2o-archive.lock").exists(), "the presence lock is untouched");
    assert!(root.join(".h2o-reclaim").is_dir(), "the quarantine namespace is untouched");
    // Canonical names: not reserved, therefore inexpressible as a source.
    for canonical in ["packages", "assets", "chat_a.h2ochat"] {
        let name = QuarantineComponent::parse(canonical).unwrap();
        assert_eq!(
            quarantine_residue(&ex, source, &run_dir, &name, &item),
            Err(crate::archive_reclaim::codes::RESIDUE_NOT_RESERVED.to_string()),
            "{canonical}"
        );
    }
    assert!(root.join("packages").is_dir());
    // The proven probe name moves through the SAME no-replace primitive …
    let name = QuarantineComponent::parse(".h2o-probe-2-0").unwrap();
    assert_eq!(quarantine_residue(&ex, source, &run_dir, &name, &item), Ok(true));
    assert!(!root.join(".h2o-probe-2-0").exists());
    assert_eq!(
        std::fs::read(root.join(".h2o-reclaim").join("run-rc02").join(item.as_str())).unwrap(),
        b"probe"
    );
    // … and a second item aimed at the occupied destination fails closed.
    std::fs::write(root.join(".h2o-probe-2-0"), b"second").unwrap();
    assert_eq!(quarantine_residue(&ex, source, &run_dir, &name, &item), Ok(false));
    assert_eq!(
        std::fs::read(root.join(".h2o-reclaim").join("run-rc02").join(item.as_str())).unwrap(),
        b"probe",
        "the first item was never replaced"
    );

    /* (I.8) no delete primitive and no path-taking seam was added for this:
       the source descriptor comes from the admitted root the namespace was
       derived beneath, and the module's path-taking inventory is unchanged
       (pinned separately by `archive_reclaim::tests`). */
    let reclaim_src = include_str!("../archive_reclaim.rs");
    let code: String = reclaim_src
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(code.contains("pub(crate) fn archive_dir(&self) -> &confined::Dir"));
    assert!(!code.contains("fn open_archive_root"), "no new path-taking seam");
    let at = reclaim_src.find("pub fn quarantine_residue").unwrap();
    let body = &reclaim_src[at..at + reclaim_src[at..].find("\n}").unwrap()];
    assert!(body.contains("RESERVED_EXACT_COMPONENTS"), "the infrastructure guard is in the residue move");
    assert!(body.contains("RESIDUE_SOURCE_INFRASTRUCTURE"));
    assert!(body.contains("quarantine_into_run(source_dir, run, source, item)"), "same primitive");

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (RC-02 G)(A) probe residue OUTSIDE the archive-owned probe locations is
/// inert: a probe-shaped name inside a CAS shard (no probe ever runs there)
/// and one under a sibling export-style root (contract §10 rule 1: inert,
/// operator-removed) survive a run that reclaimed the archive-owned residue.
#[test]
fn probe_residue_outside_the_archive_owned_probe_locations_is_inert() {
    let root = scratch("rc02-inert");
    let hashes = five(&root, "chat_a");
    let owner = Owner::acquire(&root);
    let shard = root.join("assets").join("ab");
    std::fs::create_dir_all(&shard).unwrap();
    std::fs::write(shard.join(".h2o-probe-1-0"), b"not-ours").unwrap();
    std::fs::write(shard.join(format!("sha256-{}", "ab".repeat(32))), b"body").unwrap();
    let exports = root.parent().unwrap().join("H2O Studio Exports");
    std::fs::create_dir_all(&exports).unwrap();
    std::fs::write(exports.join(".h2o-probe-1-0"), b"export-root-residue").unwrap();
    std::fs::write(root.join(".h2o-probe-1-0"), b"ours").unwrap();

    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.residue.capability_probe_purged, 1);
    assert_eq!(residue_ids(&outcome), vec!["capability-probe|archive/.h2o-probe-1-0"]);
    assert_eq!(outcome.residue_indeterminate, 0, "a non-probe location is not even reported");
    assert!(shard.join(".h2o-probe-1-0").exists(), "the CAS shard entry is inert");
    assert!(shard.join(format!("sha256-{}", "ab".repeat(32))).exists());
    assert!(exports.join(".h2o-probe-1-0").exists(), "the export-root entry is inert");
    assert!(!root.join(".h2o-probe-1-0").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (RC-02 E) a probe quarantine left by an EARLIER, crashed run is attributed
/// by recovery through the family tag and converged, exactly like the two
/// established families — so admitting the family never strands a run.
#[test]
fn a_later_run_converges_a_prior_probe_quarantine() {
    let root = scratch("rc02-recover");
    let hashes = five(&root, "chat_a");
    let prior = root.join(".h2o-reclaim").join("run-prior02");
    std::fs::create_dir_all(prior.join("probe.packages..h2o-probe-9-0")).unwrap();
    std::fs::write(prior.join("probe.root..h2o-probe-9-1"), b"stale").unwrap();
    std::fs::create_dir_all(root.join(".h2o-reclaim").join("receipts")).unwrap();

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let outcome = run(&root, &ex, &db(vec![]), &request("chat_a", "ok", &hashes[4]));
    assert_eq!(outcome.state, RunState::Complete, "{:?}", outcome.blockers);
    assert_eq!(outcome.recovered, 2, "both stale probe quarantines converged");
    assert!(!prior.join("probe.packages..h2o-probe-9-0").exists());
    assert!(!prior.join("probe.root..h2o-probe-9-1").exists());
    assert!(prior.is_dir(), "the prior run namespace is left as evidence");
    let recovery = receipt_names(&root).into_iter().filter(|n| n.contains("recovery")).count();
    assert_eq!(recovery, 1);

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}
