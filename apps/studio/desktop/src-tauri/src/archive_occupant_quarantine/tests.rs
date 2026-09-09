use super::*;
use crate::archive_durable_write::sha256_hex;
use crate::archive_generation_publish::{
    abort, begin, commit, write_member, Member, PublishResult, Publisher,
};
use crate::archive_instance_lock::ArchiveInstanceState;
use crate::archive_package_scan::scan_packages_within;
use crate::saved_chat_package_verify::derive_content_hash_v3;
use std::path::{Path, PathBuf};

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "h2o-m06-t34-{tag}-{}-{}",
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

fn snapshot_for(chat: &str, saved_at: &str) -> Vec<u8> {
    format!(
        r#"{{"schema":"h2o.savedChatSnapshot","schemaVersion":3,"chatId":"{chat}","snapshotId":"s1","savedAt":"{saved_at}","messages":[{{"id":"m0","turnIndex":0,"content":[{{"type":"text","text":"body-{saved_at}"}}],"assetRefs":[]}}]}}"#
    )
    .into_bytes()
}

/// The canonical basename the real publisher WILL choose for this content.
/// Derived from the same bytes, so a fixture can occupy that exact destination.
fn generation_name(chat: &str, saved_at: &str) -> String {
    let snapshot_sha = sha_of(&snapshot_for(chat, saved_at));
    let content_hash = derive_content_hash_v3(&snapshot_sha, &[]).expect("v3 content hash");
    format!(
        "{chat}.g{}.h2ochat",
        content_hash.strip_prefix("sha256-").unwrap()
    )
}

/// Publishes through the REAL publisher and returns its result verbatim, so a
/// blocked publication is observable rather than asserted away.
fn try_publish(root: &Path, chat: &str, saved_at: &str) -> PublishResult {
    let publisher = Publisher::new(root.to_path_buf());
    let snapshot = snapshot_for(chat, saved_at);
    let snapshot_sha = sha_of(&snapshot);
    let content_hash = derive_content_hash_v3(&snapshot_sha, &[]).expect("v3 content hash");
    let manifest = format!(
        r#"{{"schema":"h2o.savedChatPackage","schemaVersion":3,"payloadVersion":3,"chatId":"{chat}","snapshotId":"s1","contentHash":"{content_hash}","files":{{"snapshot":{{"path":"snapshot.json","sha256":"{snapshot_sha}","byteLength":{},"encoding":"identity"}}}},"assets":[]}}"#,
        snapshot.len(),
    )
    .into_bytes();
    let begun = begin(&publisher, chat);
    assert!(begun.ok, "begin refused: {:?}", begun.blockers);
    let t = begun.token;
    assert!(write_member(&publisher, t, Member::Snapshot, &snapshot).ok);
    assert!(write_member(&publisher, t, Member::Manifest, &manifest).ok);
    commit(&publisher, t, None)
}

fn publish(root: &Path, chat: &str, saved_at: &str) -> String {
    let out = try_publish(root, chat, saved_at);
    assert!(out.ok, "commit refused: {:?}", out.blockers);
    generation_name(chat, saved_at)
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

fn request(chat: &str, name: &str) -> OccupantRequest {
    OccupantRequest {
        chat_id: chat.to_string(),
        occupant_name: name.to_string(),
    }
}

fn act(root: &Path, ex: &ExclusiveOwnership<'_>, req: &OccupantRequest) -> OccupantOutcome {
    quarantine_internal(ex, root, true, req)
}

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

fn pkg_names(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root.join("packages"))
        .map(|it| it.map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// The fresh trusted classification of one occupant, for fixture assertions.
fn classify(root: &Path, name: &str) -> crate::archive_package_scan::OccupantClass {
    scan_packages_within(root)
        .occupants
        .into_iter()
        .find(|o| o.name == name)
        .unwrap_or_else(|| panic!("occupant {name} not found"))
        .class
}

// ── Occupant fixtures, all built by damaging a REAL published generation ────

/// Publishes, then makes the manifest unparseable: CORRUPT.
fn plant_corrupt(root: &Path, chat: &str, saved_at: &str) -> String {
    let name = publish(root, chat, saved_at);
    std::fs::write(root.join("packages").join(&name).join("manifest.json"), b"{ not json").unwrap();
    name
}

/// Publishes, then removes a required member: PARTIAL.
fn plant_partial(root: &Path, chat: &str, saved_at: &str) -> String {
    let name = publish(root, chat, saved_at);
    std::fs::remove_file(root.join("packages").join(&name).join("snapshot.json")).unwrap();
    name
}

/// Publishes a VALID package and stores it under a different generation name,
/// so it verifies but its proven identity disagrees: IDENTITY MISMATCH.
fn plant_foreign(root: &Path, chat: &str, saved_at: &str, wrong: &str) -> String {
    let real = publish(root, chat, saved_at);
    std::fs::rename(
        root.join("packages").join(&real),
        root.join("packages").join(wrong),
    )
    .unwrap();
    wrong.to_string()
}

/// A symlink standing at a generation path: the verifier refuses to follow one.
fn plant_symlink(root: &Path, name: &str, target: &Path) -> String {
    std::fs::create_dir_all(root.join("packages")).unwrap();
    std::os::unix::fs::symlink(target, root.join("packages").join(name)).unwrap();
    name.to_string()
}

/// (L)(M)(N)(O) the four contract-named occupant states, established by the
/// CURRENT classifier rather than assumed, and each one eligible.
#[test]
fn the_four_contract_occupant_states_are_what_the_classifier_produces() {
    use crate::archive_package_scan::OccupantClass::*;

    let root = scratch("states");
    let corrupt = plant_corrupt(&root, "chat_c", "2026-01-01T00:00:00.000Z");
    let partial = plant_partial(&root, "chat_p", "2026-01-02T00:00:00.000Z");
    let foreign_name = format!("chat_f.g{}.h2ochat", "ab".repeat(32));
    let foreign = plant_foreign(&root, "chat_f", "2026-01-03T00:00:00.000Z", &foreign_name);
    let elsewhere = root.parent().unwrap().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let link = plant_symlink(&root, &format!("chat_u.g{}.h2ochat", "cd".repeat(32)), &elsewhere);

    let mut seen = vec![];
    for name in [&corrupt, &partial, &foreign, &link] {
        match classify(&root, name) {
            Indeterminate { reason, .. } => {
                assert!(eligible(&reason), "{name} must be eligible, got {reason:?}");
                seen.push(classification_of(&reason));
            }
            other => panic!("{name} classified as {other:?}"),
        }
    }
    assert_eq!(
        seen,
        vec!["corrupt", "partial", "identity-mismatch", "unreadable"],
        "the exact classifier reasons the contract's four states map onto"
    );

    /* And the two reasons that are NOT the governed remedy fail closed. */
    assert!(!eligible(&IndeterminateReason::NotAPackageName));
    assert!(!eligible(&IndeterminateReason::UnexpectedOutcome));

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (P)(R)(T)(W)(X)(Y)(Z)(AA)(AD) THE END-TO-END PROOF, and AC-M06-10.
///
/// A corrupt occupant genuinely blocks re-publication of that exact generation;
/// the governed action quarantines it; the same publication then succeeds and
/// verifies; and the occupant is still sitting in quarantine afterwards,
/// because occupant action dwells.
#[test]
fn quarantining_a_corrupt_occupant_unblocks_real_republication() {
    let root = scratch("unblock");
    const WHEN: &str = "2026-03-01T00:00:00.000Z";
    let name = plant_corrupt(&root, "chat_r", WHEN);
    assert_eq!(name, generation_name("chat_r", WHEN), "the occupant sits at the destination");
    let damaged = census(&root.join("packages").join(&name));

    // (23) BLOCKED FIRST — otherwise the whole proof is vacuous.
    let blocked = try_publish(&root, "chat_r", WHEN);
    assert!(!blocked.ok, "publication must be genuinely blocked first");
    assert!(!blocked.committed);
    assert!(
        matches!(
            blocked.outcome,
            crate::archive_generation_publish::Outcome::GenerationDestinationCorrupt
        ),
        "blocked by the create-only occupant path, got {:?}",
        blocked.outcome
    );
    assert_eq!(
        census(&root.join("packages").join(&name)),
        damaged,
        "the blocked attempt did not repair, replace or delete the occupant"
    );

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    trace::reset();
    let outcome = act(&root, &ex, &request("chat_r", &name));

    assert_eq!(outcome.state, OccupantState::Quarantined, "{:?}", outcome.blockers);
    assert!(outcome.blockers.is_empty());
    assert_eq!(outcome.classification.as_deref(), Some("corrupt"));
    assert_eq!(outcome.quarantine_item.as_deref(), Some(format!("occupant.{name}").as_str()));
    assert!(outcome.quarantined);
    assert!(!outcome.purged, "occupant action never purges");
    assert_eq!(outcome.dwell, "one-run");
    assert_eq!(outcome.stage, "occupant-quarantine");
    assert_eq!(outcome.schema_version, 2);

    // (T) the required order, and NO purge step exists to record.
    assert_eq!(
        trace::taken(),
        vec![
            trace::Event::PlanDurable,
            trace::Event::OccupantRename,
            trace::Event::QuarantineNamespaceDurable,
            trace::Event::QuarantineReceiptDurable,
        ]
    );

    // (W)(X) canonical gone, quarantine holds it INTACT, nothing purged.
    let run_id = outcome.run_id.clone().unwrap();
    let held = root.join(".h2o-reclaim").join(&run_id).join(format!("occupant.{name}"));
    assert!(!root.join("packages").join(&name).exists(), "canonical occupant is absent");
    assert!(held.is_dir(), "the occupant is physically present in quarantine");
    assert_eq!(census(&held), damaged, "byte-identical to what was moved");

    // (Y) the receipt says quarantined, and says so about dwell explicitly.
    let receipt: serde_json::Value = serde_json::from_slice(
        &std::fs::read(
            root.join(".h2o-reclaim")
                .join("receipts")
                .join(format!("{run_id}.occupant.{name}.occupant-quarantined.json")),
        )
        .expect("quarantine receipt"),
    )
    .unwrap();
    assert_eq!(receipt["kind"], "occupant");
    assert_eq!(receipt["action"], "quarantined");
    assert_eq!(receipt["quarantined"], true);
    assert_eq!(receipt["purged"], false);
    assert_eq!(receipt["dwell"], "one-run");
    assert_eq!(receipt["classification"], "corrupt");
    assert_eq!(receipt["chatId"], "chat_r");
    assert_eq!(receipt["archivePath"], format!("archive/packages/{name}"));
    // No purge receipt exists at all.
    let receipts: Vec<String> = std::fs::read_dir(root.join(".h2o-reclaim").join("receipts"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(receipts.len(), 2, "exactly the plan and the quarantine receipt: {receipts:?}");
    assert!(!receipts.iter().any(|n| n.contains("purge")));
    let _ = ex.release();

    // (Z)(AA) THE SAME publication now succeeds and verifies.
    let unblocked = try_publish(&root, "chat_r", WHEN);
    assert!(unblocked.ok, "republication must succeed: {:?}", unblocked.blockers);
    assert!(unblocked.committed);
    assert!(matches!(
        unblocked.outcome,
        crate::archive_generation_publish::Outcome::Created
    ));
    assert!(matches!(
        classify(&root, &name),
        crate::archive_package_scan::OccupantClass::VerifiedGeneration(_)
    ));
    assert_eq!(pkg_names(&root), vec![name.clone()]);

    // The quarantined occupant is untouched by that publication.
    assert!(held.is_dir());
    assert_eq!(census(&held), damaged);

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (E)(F) STALE DIAGNOSTICS ARE NOT AUTHORITY. The target really was eligible;
/// it is repaired before the action; the action recomputes and refuses.
#[test]
fn a_target_that_became_valid_before_the_action_is_refused() {
    let root = scratch("revalidate");
    const WHEN: &str = "2026-04-01T00:00:00.000Z";
    let name = plant_partial(&root, "chat_v", WHEN);

    // 1. the diagnostic that would have authorised the action.
    let stale = classify(&root, &name);
    assert!(
        matches!(
            stale,
            crate::archive_package_scan::OccupantClass::Indeterminate {
                reason: IndeterminateReason::Partial,
                ..
            }
        ),
        "the occupant genuinely WAS eligible: {stale:?}"
    );

    // 2. the world changes: the missing member comes back and it now verifies.
    std::fs::write(
        root.join("packages").join(&name).join("snapshot.json"),
        snapshot_for("chat_v", WHEN),
    )
    .unwrap();
    assert!(matches!(
        classify(&root, &name),
        crate::archive_package_scan::OccupantClass::VerifiedGeneration(_)
    ));
    let repaired = census(&root.join("packages").join(&name));

    // 3. the action recomputes under exclusive and refuses on the FRESH verdict.
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    trace::reset();
    let outcome = act(&root, &ex, &request("chat_v", &name));

    assert_eq!(outcome.state, OccupantState::Refused);
    assert_eq!(outcome.blockers, vec![codes::OCCUPANT_IS_VALID.to_string()]);
    assert!(outcome.run_id.is_none(), "no run namespace was created");
    assert!(!outcome.quarantined);
    assert!(trace::taken().is_empty(), "nothing at all happened");
    assert_eq!(
        census(&root.join("packages").join(&name)),
        repaired,
        "the valid package is byte and name identical"
    );
    assert!(!root.join(".h2o-reclaim").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (F)(G)(H)(I)(J) every refusal class, each proven with zero mutation.
#[test]
fn valid_legacy_reserved_foreign_and_mismatched_identities_are_all_refused() {
    let root = scratch("refusals");
    const WHEN: &str = "2026-05-01T00:00:00.000Z";
    let valid = publish(&root, "chat_ok", WHEN);
    // A legacy package, valid and damaged: NEITHER is ever reclaimable.
    let legacy_src = publish(&root, "chat_leg", "2026-05-02T00:00:00.000Z");
    std::fs::rename(
        root.join("packages").join(&legacy_src),
        root.join("packages").join("chat_leg.h2ochat"),
    )
    .unwrap();
    let broken_legacy = "chat_broken.h2ochat";
    std::fs::create_dir_all(root.join("packages").join(broken_legacy)).unwrap();
    std::fs::write(root.join("packages").join(broken_legacy).join("manifest.json"), b"{").unwrap();
    // Reserved infrastructure and residue, sitting in packages/.
    std::fs::create_dir_all(root.join("packages").join(".h2o-genstage-aa01")).unwrap();
    std::fs::write(root.join("packages").join(".h2o-durable-1-0.tmp"), b"t").unwrap();
    /* A reserved identity that PASSES admission and so really reaches the
       canonical parser: the reserved prefix carrying a package suffix. */
    std::fs::create_dir_all(root.join("packages").join(".h2o-genstage-aa02.h2ochat")).unwrap();
    // Foreign basenames.
    std::fs::write(root.join("packages").join("notes.txt"), b"x").unwrap();
    std::fs::create_dir_all(root.join("packages").join("random-dir")).unwrap();
    // A genuinely eligible occupant, for the mismatch case.
    let eligible_name = plant_corrupt(&root, "chat_bad", "2026-05-03T00:00:00.000Z");

    let owner = Owner::acquire(&root);
    let before = census(&root);
    let ex = owner.exclusive();

    for (chat, name, expected) in [
        // (F) it verifies now.
        ("chat_ok", valid.as_str(), codes::OCCUPANT_IS_VALID),
        // (G) grandfathered legacy, valid and broken alike: not generation-path.
        ("chat_leg", "chat_leg.h2ochat", codes::NOT_A_GENERATION_PATH),
        ("chat_broken", broken_legacy, codes::NOT_A_GENERATION_PATH),
        // (I) reserved infrastructure and T3.3's residue families.
        ("chat_ok", ".h2o-genstage-aa01", codes::REQUEST_NAME_INVALID),
        ("chat_ok", ".h2o-durable-1-0.tmp", codes::REQUEST_NAME_INVALID),
        ("chat_ok", ".h2o-reclaim", codes::REQUEST_NAME_INVALID),
        ("chat_ok", ".h2o-archive.lock", codes::REQUEST_NAME_INVALID),
        ("chat_ok", ".h2o-genstage-aa02.h2ochat", codes::OCCUPANT_IS_RESERVED),
        // (H) foreign basenames.
        ("chat_ok", "notes.txt", codes::REQUEST_NAME_INVALID),
        ("chat_ok", "random-dir", codes::REQUEST_NAME_INVALID),
        // (J) the basename is eligible, but for a different chat.
        ("chat_other", eligible_name.as_str(), codes::CHAT_IDENTITY_MISMATCH),
    ] {
        trace::reset();
        let outcome = act(&root, &ex, &request(chat, name));
        assert_eq!(
            outcome.state,
            OccupantState::Refused,
            "{chat}/{name} must be refused"
        );
        assert_eq!(outcome.blockers, vec![expected.to_string()], "{chat}/{name}");
        assert!(outcome.run_id.is_none(), "{chat}/{name} created a run");
        assert!(!outcome.quarantined);
        assert!(trace::taken().is_empty(), "{chat}/{name} did something");
    }

    assert_eq!(census(&root), before, "not one refusal mutated anything");
    assert!(!root.join(".h2o-reclaim").exists());

    // The eligible occupant IS actionable under its OWN identity, so none of
    // the refusals above was a broken fixture.
    let ok = act(&root, &ex, &request("chat_bad", &eligible_name));
    assert_eq!(ok.state, OccupantState::Quarantined, "{:?}", ok.blockers);

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (K) an absent target is a truthful not-found with zero persistent mutation.
#[test]
fn an_absent_occupant_is_a_zero_mutation_not_found() {
    let root = scratch("absent");
    publish(&root, "chat_a", "2026-06-01T00:00:00.000Z");
    let owner = Owner::acquire(&root);
    let before = census(&root);
    let ex = owner.exclusive();

    let gone = format!("chat_gone.g{}.h2ochat", "ab".repeat(32));
    trace::reset();
    let outcome = act(&root, &ex, &request("chat_gone", &gone));

    assert_eq!(outcome.state, OccupantState::NotFound);
    assert_eq!(outcome.blockers, vec![codes::OCCUPANT_NOT_FOUND.to_string()]);
    assert!(outcome.run_id.is_none());
    assert!(outcome.classification.is_none());
    assert!(!outcome.quarantined && !outcome.purged);
    assert!(trace::taken().is_empty());
    assert_eq!(census(&root), before, "zero persistent mutation");
    assert!(!root.join(".h2o-reclaim").exists(), "no run created for an absent target");

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (O) a symlink occupant is moved as an ENTRY and never dereferenced.
#[test]
fn a_symlinked_occupant_moves_as_an_entry_without_being_followed() {
    let root = scratch("symlink");
    let outside = root.parent().unwrap().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("precious"), b"must survive").unwrap();
    let before_outside = census(&outside);

    let name = format!("chat_s.g{}.h2ochat", "ef".repeat(32));
    plant_symlink(&root, &name, &outside);

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let outcome = act(&root, &ex, &request("chat_s", &name));

    assert_eq!(outcome.state, OccupantState::Quarantined, "{:?}", outcome.blockers);
    assert_eq!(outcome.classification.as_deref(), Some("unreadable"));
    let held = root
        .join(".h2o-reclaim")
        .join(outcome.run_id.clone().unwrap())
        .join(format!("occupant.{name}"));
    assert!(
        std::fs::symlink_metadata(&held).unwrap().file_type().is_symlink(),
        "the LINK moved, not what it pointed at"
    );
    assert!(!root.join("packages").join(&name).exists());
    assert_eq!(census(&outside), before_outside, "the target is byte-identical");
    assert!(outside.join("precious").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (AB) a genuine in-flight publisher session refuses the action outright, and
/// its staging tree is neither reclaimed nor terminated.
#[test]
fn an_in_flight_publisher_session_refuses_the_action_before_any_mutation() {
    let root = scratch("livesession");
    let name = plant_corrupt(&root, "chat_x", "2026-07-01T00:00:00.000Z");

    let publisher = Publisher::new(root.to_path_buf());
    let begun = begin(&publisher, "chat_live");
    assert!(begun.ok, "{:?}", begun.blockers);
    assert!(write_member(&publisher, begun.token, Member::Snapshot, br#"{"live":true}"#).ok);
    assert!(!publisher.sessions_empty(), "the registry really is occupied");

    let owner = Owner::acquire(&root);
    let before = census(&root);
    let ex = owner.exclusive();
    trace::reset();
    let outcome = quarantine_internal(&ex, &root, publisher.sessions_empty(), &request("chat_x", &name));

    assert_eq!(outcome.state, OccupantState::Refused);
    assert_eq!(outcome.blockers, vec![codes::PUBLISHER_SESSIONS_ACTIVE.to_string()]);
    assert!(outcome.run_id.is_none());
    assert!(trace::taken().is_empty());
    assert_eq!(census(&root), before, "zero occupant mutation");
    assert!(!root.join(".h2o-reclaim").exists());
    assert!(!publisher.sessions_empty(), "the session was not terminated");
    assert!(root.join("packages").join(&name).is_dir(), "the occupant is untouched");

    // Only now, as cleanup.
    assert!(abort(&publisher, begun.token).ok);
    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (AC) a competing participating instance prevents exclusive acquisition, so
/// the action cannot even begin.
#[test]
fn a_competing_participant_prevents_exclusive_acquisition() {
    let root = scratch("competing");
    let name = plant_corrupt(&root, "chat_x", "2026-07-02T00:00:00.000Z");

    let ours = ArchiveInstanceState::default();
    ours.ensure_presence(&root).expect("shared presence");
    let theirs = ArchiveInstanceState::default();
    theirs.ensure_presence(&root).expect("second participant");

    let before = census(&root);
    assert!(
        ours.try_acquire_exclusive().is_err(),
        "a second participating instance must prevent exclusive ownership"
    );
    assert_eq!(census(&root), before, "the failed acquisition mutated nothing");
    assert!(root.join("packages").join(&name).is_dir());

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (Q) a plan-durability failure produces ZERO rename.
#[test]
fn a_plan_durability_failure_produces_no_occupant_rename() {
    let root = scratch("planfail");
    let name = plant_corrupt(&root, "chat_x", "2026-08-01T00:00:00.000Z");
    let occupant = census(&root.join("packages").join(&name));
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::arm(fault::Point::BeforePlanDurability);
    let outcome = act(&root, &ex, &request("chat_x", &name));
    fault::clear();

    assert_eq!(outcome.state, OccupantState::Refused);
    assert!(outcome.blockers.contains(&codes::EVIDENCE_FAILED.to_string()));
    assert!(outcome.run_id.is_none(), "no run directory was created");
    assert!(!outcome.quarantined);
    assert!(trace::taken().is_empty(), "not even PlanDurable was recorded");
    assert_eq!(
        census(&root.join("packages").join(&name)),
        occupant,
        "the canonical occupant never moved"
    );
    assert!(!root.join(".h2o-reclaim").join("receipts").join("x").exists());

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (U) a namespace-durability failure after a successful rename never reports
/// success, never purges and never rolls back.
#[test]
fn a_namespace_durability_failure_never_reports_quarantined() {
    let root = scratch("nsfail");
    let name = plant_corrupt(&root, "chat_x", "2026-08-02T00:00:00.000Z");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::arm(fault::Point::AfterRenameBeforeNamespaceDurability);
    let outcome = act(&root, &ex, &request("chat_x", &name));
    fault::clear();

    assert_eq!(outcome.state, OccupantState::Partial, "never Quarantined");
    assert!(outcome.quarantined, "the rename is reported as it happened");
    assert!(!outcome.purged);
    assert!(outcome
        .blockers
        .contains(&crate::archive_reclaim::codes::QUARANTINE_NOT_DURABLE.to_string()));

    let events = trace::taken();
    assert!(events.contains(&trace::Event::OccupantRename));
    assert!(!events.contains(&trace::Event::QuarantineNamespaceDurable));
    assert!(!events.contains(&trace::Event::QuarantineReceiptDurable));

    // The item is observable in quarantine; nothing was purged or restored.
    let run_id = outcome.run_id.clone().unwrap();
    assert!(root
        .join(".h2o-reclaim")
        .join(&run_id)
        .join(format!("occupant.{name}"))
        .is_dir());
    assert!(!root.join("packages").join(&name).exists(), "no automatic rollback");
    let receipts: Vec<String> = std::fs::read_dir(root.join(".h2o-reclaim").join("receipts"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert!(
        !receipts.iter().any(|n| n.contains("occupant-quarantined")),
        "no receipt may claim a durable quarantine: {receipts:?}"
    );

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (V) a receipt failure after rename never purges and never rolls back.
#[test]
fn a_receipt_failure_never_purges_or_rolls_back() {
    let root = scratch("receiptfail");
    let name = plant_corrupt(&root, "chat_x", "2026-08-03T00:00:00.000Z");
    let damaged = census(&root.join("packages").join(&name));
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    trace::reset();
    fault::arm(fault::Point::AfterRenameBeforeReceipt);
    let outcome = act(&root, &ex, &request("chat_x", &name));
    fault::clear();

    assert_eq!(outcome.state, OccupantState::Partial);
    assert!(outcome.quarantined && !outcome.purged);
    assert!(outcome.blockers.contains(&codes::EVIDENCE_FAILED.to_string()));

    let events = trace::taken();
    assert!(events.contains(&trace::Event::QuarantineNamespaceDurable), "the move was durable");
    assert!(!events.contains(&trace::Event::QuarantineReceiptDurable), "the receipt was not");

    let run_id = outcome.run_id.clone().unwrap();
    let held = root.join(".h2o-reclaim").join(&run_id).join(format!("occupant.{name}"));
    assert!(held.is_dir(), "the item stays quarantined and recoverable");
    assert_eq!(census(&held), damaged, "byte-identical, not deleted");
    assert!(!root.join("packages").join(&name).exists(), "no unsafe rollback");

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (R)(S) the move is atomic and NON-REPLACING: an existing quarantine entry is
/// never overwritten, and the canonical occupant stays put when it is refused.
#[test]
fn the_occupant_move_is_atomic_and_never_replaces_a_quarantine_entry() {
    use crate::archive_reclaim::{open_packages_dir, open_reclaim_root_for_run, quarantine_occupant};

    let root = scratch("collision");
    let first = plant_corrupt(&root, "chat_one", "2026-08-04T00:00:00.000Z");
    let second = plant_corrupt(&root, "chat_two", "2026-08-05T00:00:00.000Z");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    let reclaim = open_reclaim_root_for_run(&ex, &root).unwrap();
    let run_id = QuarantineRunId::parse("aa01").unwrap();
    let run = reclaim.create_run(&ex, &run_id).unwrap();
    let packages = open_packages_dir(&ex, &root).unwrap();

    let dest = QuarantineComponent::parse("occupant.taken").unwrap();
    assert_eq!(
        quarantine_occupant(
            &ex,
            &packages,
            &run,
            &QuarantineComponent::parse(&first).unwrap(),
            &dest
        ),
        Ok(true)
    );
    let held = root.join(".h2o-reclaim").join("run-aa01").join("occupant.taken");
    let held_before = census(&held);
    assert!(held.is_dir() && !root.join("packages").join(&first).exists());

    // A DIFFERENT occupant cannot take that destination.
    let second_before = census(&root.join("packages").join(&second));
    assert_eq!(
        quarantine_occupant(
            &ex,
            &packages,
            &run,
            &QuarantineComponent::parse(&second).unwrap(),
            &dest
        ),
        Ok(false),
        "RENAME_EXCL refuses rather than replacing"
    );
    assert_eq!(census(&held), held_before, "the first item is untouched");
    assert_eq!(
        census(&root.join("packages").join(&second)),
        second_before,
        "and the second never left the canonical namespace"
    );

    /* The action maps that refusal to a collision blocker with NO fallback
       destination and no retry — whole-run collision cannot be reached
       end-to-end because the run directory name is 128 trusted random bits, so
       the propagation is pinned in source. */
    let src = include_str!("../archive_occupant_quarantine.rs");
    let at = src.find("match crate::archive_reclaim::quarantine_occupant(").unwrap();
    let arm = &src[at..at + src[at..].find("\n    }").unwrap()];
    assert!(arm.contains("Ok(false) => {"));
    assert!(arm.contains("QUARANTINE_COLLISION"));
    for forbidden in ["retry", "fallback", "else {", "loop", "for "] {
        assert!(!arm.contains(forbidden), "no alternate destination: {forbidden}");
    }

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (B) the identity is validated and BOUNDED, and an over-long identity is
/// refused rather than truncated. The length authority is the filesystem's own
/// NAME_MAX, read from the opened packages descriptor, exactly as the publisher
/// does — not a constant restated here.
#[test]
fn an_over_long_identity_is_refused_never_truncated() {
    // 176 + ".g" + 64 + ".h2ochat" = 250, which fits NAME_MAX and can really
    // exist; `occupant.` + 250 = 259, which cannot.
    let chat = "c".repeat(176);
    let root = scratch("toolong");
    let name = plant_corrupt(&root, &chat, "2026-08-06T00:00:00.000Z");
    assert_eq!(name.len(), 250);
    let occupant = census(&root.join("packages").join(&name));

    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    trace::reset();
    let outcome = act(&root, &ex, &request(&chat, &name));

    assert_eq!(outcome.state, OccupantState::Refused);
    assert_eq!(outcome.blockers, vec![codes::NAME_EXCEEDS_LIMIT.to_string()]);
    assert!(outcome.run_id.is_none());
    assert!(trace::taken().is_empty());
    assert_eq!(
        census(&root.join("packages").join(&name)),
        occupant,
        "refused, and nothing was renamed under a truncated name"
    );
    assert!(!root.join(".h2o-reclaim").exists());
    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());

    // Structural admission, before anything is opened.
    for (chat, name) in [
        ("", "a.gb.h2ochat"),
        ("   ", "a.gb.h2ochat"),
        ("..", "a.gb.h2ochat"),
        ("a/b", "a.gb.h2ochat"),
        ("a\\b", "a.gb.h2ochat"),
        ("a b", "a.gb.h2ochat"),
    ] {
        assert!(admit(&request(chat, name)).is_err(), "chat {chat:?} must be refused");
    }
    for name in [
        "", "   ", ".", "..", "a/b.h2ochat", "a\\b.h2ochat", "a b.h2ochat",
        "no-suffix", "chat.h2ochat.bak",
    ] {
        assert!(admit(&request("chat_a", name)).is_err(), "name {name:?} must be refused");
    }
    assert!(admit(&request("  chat_a  ", "  chat_a.gab.h2ochat  ")).is_ok(), "trimmed, not rejected");
}

/// (AF)(AG)(AH)(AI)(AJ) exactly one namespace entry changes. Valid generations,
/// a legacy package, an unrelated indeterminate occupant, both residue families
/// and every canonical CAS body — including an observed-unreferenced one — are
/// byte and name identical afterwards.
#[test]
fn only_the_targeted_occupant_changes_and_every_bystander_survives() {
    let root = scratch("bystanders");
    let target = plant_corrupt(&root, "chat_bad", "2026-09-01T00:00:00.000Z");
    publish(&root, "chat_good", "2026-09-02T00:00:00.000Z");
    publish(&root, "chat_good", "2026-09-03T00:00:00.000Z");
    let legacy_src = publish(&root, "chat_leg", "2026-09-04T00:00:00.000Z");
    std::fs::rename(
        root.join("packages").join(&legacy_src),
        root.join("packages").join("chat_leg.h2ochat"),
    )
    .unwrap();
    // An unrelated eligible occupant that was NOT named: must be untouched.
    let bystander = plant_partial(&root, "chat_other", "2026-09-05T00:00:00.000Z");
    // Both T3.3 residue families.
    std::fs::create_dir_all(root.join("packages").join(".h2o-genstage-bb01")).unwrap();
    std::fs::write(
        root.join("packages").join(".h2o-genstage-bb01").join("snapshot.json"),
        b"{}",
    )
    .unwrap();
    let shard = root.join("assets").join("ab");
    std::fs::create_dir_all(&shard).unwrap();
    std::fs::write(shard.join(".h2o-durable-9-0.tmp"), b"residue").unwrap();
    // Referenced, observed-unreferenced and foreign CAS content.
    std::fs::write(shard.join(format!("sha256-{}", "ab".repeat(32))), b"referenced").unwrap();
    std::fs::create_dir_all(root.join("assets").join("cd")).unwrap();
    std::fs::write(
        root.join("assets").join("cd").join(format!("sha256-{}", "cd".repeat(32))),
        b"observed-unreferenced",
    )
    .unwrap();
    std::fs::write(root.join("assets").join("cd").join("foreign.bin"), b"foreign").unwrap();

    let owner = Owner::acquire(&root);
    let assets_before = census(&root.join("assets"));
    let packages_before = census(&root.join("packages"));
    let ex = owner.exclusive();

    let outcome = act(&root, &ex, &request("chat_bad", &target));
    assert_eq!(outcome.state, OccupantState::Quarantined, "{:?}", outcome.blockers);

    // (AI)(AJ) every canonical CAS body and both residue families untouched.
    assert_eq!(census(&root.join("assets")), assets_before, "assets byte-identical");
    assert!(shard.join(".h2o-durable-9-0.tmp").exists());

    // (AF)(AG) exactly ONE packages entry disappeared: the named occupant.
    let packages_after = census(&root.join("packages"));
    let removed: Vec<&(String, String)> = packages_before
        .iter()
        .filter(|e| !packages_after.contains(e))
        .collect();
    assert!(
        removed.iter().all(|(n, _)| n.starts_with(&format!("/{target}"))),
        "only the target namespace entry changed: {removed:?}"
    );
    assert!(packages_after.iter().all(|e| packages_before.contains(e)), "nothing appeared");
    assert!(root.join("packages").join("chat_leg.h2ochat").is_dir());
    assert!(root.join("packages").join(&bystander).is_dir(), "the unnamed occupant survives");
    assert!(root.join("packages").join(".h2o-genstage-bb01").is_dir());
    /* `.g` is the generation infix, which the staging name does not carry:
       two valid generations plus the unnamed occupant. */
    assert_eq!(
        pkg_names(&root).iter().filter(|n| n.contains(".g")).count(),
        3,
        "two valid generations and the unnamed occupant remain"
    );

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// Identifier tokens, so a ban can be exact. A substring scan cannot be: `age`
/// lives inside `package`, which this module says constantly.
fn identifier_tokens(code: &str) -> std::collections::BTreeSet<String> {
    code.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

fn module_code() -> String {
    include_str!("../archive_occupant_quarantine.rs")
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// (A) the production request is IDENTITY shaped. No path type can express a
/// target, a destination, a run id or an override.
#[test]
fn the_production_request_carries_no_filesystem_path_or_override() {
    let src = include_str!("../archive_occupant_quarantine.rs");
    let at = src.find("pub struct OccupantRequest {").expect("the request");
    let decl = &src[at..at + src[at..].find("\n}").unwrap()];
    assert!(decl.contains("pub chat_id: String"));
    assert!(decl.contains("pub occupant_name: String"));
    /* Counted past the opening brace: `pub struct` carries a `pub ` of its own. */
    let fields = &decl[decl.find('{').unwrap()..];
    assert_eq!(fields.matches("pub ").count(), 2, "exactly two fields");
    for forbidden in [
        "PathBuf", "&Path", "path", "root", "destination", "quarantine",
        "run_id", "candidates", "retention", "k:", "force", "override",
        "sha", "cas", "target",
    ] {
        assert!(!decl.contains(forbidden), "the request must not carry {forbidden}");
    }

    // The production entry point takes the app handle and that request only.
    let at = src.find("pub(crate) fn execute_occupant_quarantine(").expect("entry point");
    let sig = &src[at..at + src[at..].find(") -> ").unwrap()];
    assert!(sig.contains("app: &tauri::AppHandle"));
    assert!(sig.contains("request: &OccupantRequest"));
    for forbidden in ["Path", "String", "scan:", "class", "PackageScan", "root:"] {
        assert!(!sig.contains(forbidden), "entry point must not accept {forbidden}");
    }

    /* (C) and the canonical source is re-derived through the EXISTING T2.1
       authorities — the scan and its name parser — never a second parser. */
    let code = module_code();
    assert_eq!(code.matches("scan_packages_within(").count(), 1, "one scan authority");
    assert_eq!(code.matches("name_shape(").count(), 1, "one name authority");
    /* The ban is on DECOMPOSITION, not on using the shared constant: `admit`
       legitimately filters on the canonical `PACKAGE_SUFFIX` before anything is
       opened. What must not exist is a second grammar that splits the basename
       into a chat id and a hash. */
    for forbidden in [
        "rfind(", "split_at(", "splitn(", "strip_suffix", "strip_prefix",
        "is_ascii_hexdigit", "verify_occupant", "sha256_hex",
        "normalize_expected_sha", ".h2ochat", "\".g\"",
    ] {
        assert!(!code.contains(forbidden), "no second parser or hash authority: {forbidden}");
    }
    /* Every canonical constant it does use is IMPORTED from the owning module. */
    assert!(code.contains("use crate::archive_package_scan::{"));
    assert!(code.contains("PACKAGE_SUFFIX,"), "the suffix constant is shared, not restated");
    // The scan is handed the run's OWN derived root, not a caller value.
    let at = code.find("scan_packages_within(").unwrap();
    assert!(code[at..at + 40].contains("(archive_root)"));
}

/// (D)(7) re-classification happens INSIDE the exclusive window, after the
/// registry precondition, and the production wrapper classifies nothing.
#[test]
fn re_classification_happens_under_exclusive_ownership() {
    let src = include_str!("../archive_occupant_quarantine.rs");
    let wrapper = src.find("pub(crate) fn execute_occupant_quarantine(").unwrap();
    let sequence = src.find("fn quarantine_internal(").unwrap();
    let wrapper_body = &src[wrapper..sequence];
    assert!(
        !wrapper_body.contains("scan_packages_within"),
        "nothing is classified before exclusive ownership is held"
    );
    assert!(wrapper_body.contains("try_acquire_exclusive()"));
    // Acquisition precedes the sampled registry, which precedes the sequence.
    let acquire = wrapper_body.find("try_acquire_exclusive()").unwrap();
    let sample = wrapper_body.find("sessions_empty()").unwrap();
    let call = wrapper_body.find("quarantine_internal(&exclusive").unwrap();
    assert!(acquire < sample && sample < call);

    let body = &src[sequence..];
    assert!(
        src[sequence..sequence + 400].contains("exclusive: &ExclusiveOwnership"),
        "the sequence requires the capability BY TYPE"
    );
    let registry = body.find("if !publisher_sessions_empty").unwrap();
    let scan = body.find("scan_packages_within(archive_root)").unwrap();
    let rename = body.find("quarantine_occupant(").unwrap();
    assert!(registry < scan, "the registry precondition precedes classification");
    assert!(scan < rename, "classification precedes the rename");

    // (15) PLAN_DURABLE precedes FIRST_OCCUPANT_RENAME, in source as well as
    // behaviour.
    let plan = body.find("&plan_evidence(").unwrap();
    assert!(plan < rename, "the plan record is written before the rename");
    // And the scan result is bound immutably: nothing can widen it.
    assert!(body.contains("let scan: PackageScan = crate::archive_package_scan::scan_packages_within"));
    for forbidden in ["let mut scan", "scan.occupants.push", "scan.occupants.extend"] {
        assert!(!body.contains(forbidden), "classification must not be widened: {forbidden}");
    }
}

/// (X)(AL)(AM) ONE-RUN DWELL, structurally. This module holds no purge
/// authority of any kind, and adds no stale-run behaviour.
#[test]
fn the_occupant_action_holds_no_purge_authority_at_all() {
    let code = module_code();
    for forbidden in [
        "purge_quarantined_item", "QuarantineTarget", "purge_run", "purge_all",
        "purge_receipts", "unlink", "remove_file", "remove_dir", "remove_dir_all",
        "std::fs::remove", "unlinkat", "read_entry_names", "PurgeOutcome",
        // No second rename or path-resolution subsystem either.
        "std::fs::rename", "renameat", "canonicalize", "read_link",
    ] {
        assert!(!code.contains(forbidden), "occupant action must not {forbidden}");
    }
    /* It cannot even NAME a purge target: `QuarantineTarget` is the only type
       the confined purge accepts, and it is absent above. */
    assert!(code.contains("quarantine_occupant("), "the move is the whole action");
    assert!(!code.contains("purged: true"), "nothing ever reports a purge");
    assert!(code.contains("purged: false"), "the receipt states dwell explicitly");

    // The successful tail ends at the receipt: no step follows it.
    let src = include_str!("../archive_occupant_quarantine.rs");
    let at = src.find("trace::record(trace::Event::QuarantineReceiptDurable);").unwrap();
    /* CODE only: the comment right below legitimately EXPLAINS that no purge
       follows, and banning that sentence would ban the explanation. */
    let tail: String = src[at..src[at..].find("\n}").unwrap() + at]
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let tail = tail.as_str();
    assert!(tail.contains("OccupantState::Quarantined"));
    for forbidden in ["purge", "unlink", "remove", "sweep", "reclaim_root", "create_run"] {
        assert!(!tail.contains(forbidden), "nothing may follow the receipt: {forbidden}");
    }
    /* The trace vocabulary itself has no purge event, so a purge step has no
       representation to record even if one were added by mistake. */
    let at = src.find("pub enum Event {").unwrap();
    let events = &src[at..at + src[at..].find("\n    }").unwrap()];
    assert!(!events.to_lowercase().contains("purge"));
}

/// (AK)(24) no timestamp, age or wall-clock authority anywhere — dwell is a
/// recorded FACT, not a computed expiry.
#[test]
fn dwell_uses_no_timestamp_or_age_authority() {
    let tokens = identifier_tokens(&module_code());
    for forbidden in [
        "st_mtime", "st_ctime", "st_birthtime", "st_atime", "SystemTime",
        "Instant", "UNIX_EPOCH", "elapsed", "modified", "created", "age",
        "max_age", "min_age", "older_than", "newer_than", "expires", "expiry",
        "now", "timestamp", "duration_since", "Duration",
    ] {
        assert!(!tokens.contains(forbidden), "no time authority: {forbidden}");
    }
    /* And no run-id ordering is read as time either. */
    let code = module_code();
    for forbidden in ["run_id <", "run_id >", "runs.sort", "oldest", "newest"] {
        assert!(!code.contains(forbidden), "run ids are not a clock: {forbidden}");
    }
    assert!(code.contains("OCCUPANT_DWELL"), "dwell is recorded as evidence");
}

/// (18) no CAS destructive route, and the read-only orphan analysis is not
/// consulted at all.
#[test]
fn the_occupant_action_has_no_cas_route() {
    let code = module_code();
    /* Exact identifier tokens: a bare "Cas" is a substring of serde's
       `camelCase` attribute, which this module uses legitimately. */
    let tokens = identifier_tokens(&code);
    for forbidden in [
        "QuarantineKind", "Cas", "CasObject", "Asset", "Sha", "CAS_DIR",
        "archive_cas_scan", "observed_unreferenced", "assets",
        "open_cas_shard_dir", "quarantine_residue", "quarantine_generation",
    ] {
        assert!(!tokens.contains(forbidden), "no CAS or cross-family route: {forbidden}");
    }
    assert!(!code.contains("sha256-"), "no CAS body identity is ever constructed");
    /* It moves through exactly one primitive, from exactly one source. */
    assert_eq!(code.matches("quarantine_occupant(").count(), 1);
    assert_eq!(code.matches("open_packages_dir(").count(), 1);
}

/// (AE) the run id is trusted-side and cannot be chosen by a caller.
#[test]
fn the_run_id_is_trusted_and_never_caller_supplied() {
    let code = module_code();
    assert!(
        code.contains("crate::archive_reclaim_execute::generate_run_id()"),
        "the existing trusted run-id authority is reused, not restated"
    );
    assert_eq!(code.matches("generate_run_id").count(), 1);
    /* The ban is on INPUT. `pub run_id: Option<String>` is the outcome's
       reporting field and must exist; what must not is a run id reaching the
       action from the request. */
    for forbidden in ["QuarantineRunId::parse(&request", "request.run", "request.occupant_run"] {
        assert!(!code.contains(forbidden), "a caller must not choose the run id: {forbidden}");
    }
    let src = include_str!("../archive_occupant_quarantine.rs");
    let at = src.find("pub struct OccupantRequest {").unwrap();
    let decl = &src[at..at + src[at..].find("\n}").unwrap()];
    assert!(!decl.contains("run"), "the request declares no run identity at all");
    // Two runs against equivalent archives get different namespaces.
    let mut ids = vec![];
    for tag in ["runid-a", "runid-b"] {
        let root = scratch(tag);
        let name = plant_corrupt(&root, "chat_x", "2026-10-01T00:00:00.000Z");
        let owner = Owner::acquire(&root);
        let ex = owner.exclusive();
        let outcome = act(&root, &ex, &request("chat_x", &name));
        assert_eq!(outcome.state, OccupantState::Quarantined);
        let id = outcome.run_id.clone().unwrap();
        assert!(id.starts_with("run-") && id.len() == 4 + 32, "{id}");
        ids.push(id);
        let _ = ex.release();
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
    assert_ne!(ids[0], ids[1], "run ids are drawn from the OS CSPRNG");
}

/// (14) the run-evidence schema stays at version 2, and the reasoning is
/// executable rather than asserted in prose.
#[test]
fn occupant_evidence_is_self_announcing_within_schema_v2() {
    let root = scratch("schema");
    let name = plant_corrupt(&root, "chat_x", "2026-11-01T00:00:00.000Z");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    let outcome = act(&root, &ex, &request("chat_x", &name));
    assert_eq!(outcome.state, OccupantState::Quarantined, "{:?}", outcome.blockers);
    let run_id = outcome.run_id.clone().unwrap();
    let read = |file: String| -> serde_json::Value {
        serde_json::from_slice(
            &std::fs::read(root.join(".h2o-reclaim").join("receipts").join(file)).expect("evidence"),
        )
        .unwrap()
    };

    let plan = read(format!("{run_id}.plan.json"));
    assert_eq!(plan["schema"], "h2o.m06.reclamationRun");
    assert_eq!(plan["schemaVersion"], 2);
    /* SELF-ANNOUNCING: the value sits in a field a conforming v2 reader must
       already branch on, so it either handles it or rejects the record. It can
       never mistake this for a familiar shape meaning "nothing happened". */
    assert_eq!(plan["stages"], serde_json::json!(["occupant-quarantine"]));
    assert_eq!(read(format!("{run_id}.occupant.{name}.occupant-quarantined.json"))["kind"], "occupant");
    /* NO v2 field is populated with a false value: the generation plan's fields
       are ABSENT rather than fabricated, because this action computes no
       retention plan at all. */
    for fabricated in ["retentionFloor", "sources", "candidates", "residue", "planComplete"] {
        assert!(plan.get(fabricated).is_none(), "{fabricated} must not be fabricated");
    }
    // What it does record: identity, the FRESH verdict, the intent, the dwell.
    let o = &plan["occupant"];
    assert_eq!(o["chatId"], "chat_x");
    assert_eq!(o["occupantName"], name.as_str());
    assert_eq!(o["archivePath"], format!("archive/packages/{name}"));
    assert_eq!(o["classification"], "corrupt");
    assert_eq!(o["action"], "quarantine");
    assert_eq!(o["dwell"], "one-run");
    assert_eq!(o["purgeInThisRun"], false);
    assert_eq!(o["quarantineItem"], format!("occupant.{name}"));
    assert_eq!(o["preconditions"]["publisherRegistryEmpty"], true);
    assert_eq!(o["preconditions"]["reclassifiedUnderExclusive"], true);
    // No chat content, no absolute host path.
    for file in std::fs::read_dir(root.join(".h2o-reclaim").join("receipts")).unwrap() {
        let raw = std::fs::read_to_string(file.unwrap().path()).unwrap();
        assert!(!raw.contains(root.to_str().unwrap()), "absolute host path in evidence");
        assert!(!raw.contains("body-2026"), "chat content in evidence");
        assert!(!raw.contains("snapshotId"), "package internals in evidence");
    }
    // The schema constant is shared, not restated.
    assert!(module_code().contains("archive_reclaim_execute::{RUN_SCHEMA, RUN_SCHEMA_VERSION}"));

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (AN)(AO)(22)(23) dormant and unregistered: no command, no handler arm, no
/// renderer route, and no renderer archive mutation authority.
#[test]
fn exactly_one_approved_occupant_command_is_registered() {
    let code = module_code();
    /* P4: G02 passed, so this module owns EXACTLY ONE command, and it forwards
       an IDENTITY and nothing else. */
    assert_eq!(
        code.matches("#[tauri::command]").count(),
        1,
        "exactly one activated command"
    );
    let src = include_str!("../archive_occupant_quarantine.rs");
    let at = src.find("pub async fn h2o_archive_occupant_quarantine").expect("the command");
    let sig = &src[at..at + src[at..].find(") -> ").unwrap()];
    assert!(sig.contains("app: tauri::AppHandle") && sig.contains("request: OccupantRequest"));
    for forbidden in ["Path", "root", "run_id", "String", "force", "classification"] {
        assert!(!sig.contains(forbidden), "the command must not accept {forbidden}");
    }
    /* A pure forwarder: it re-derives nothing and decides nothing. */
    let body = &src[at..at + src[at..].find("\n}").unwrap()];
    assert!(body.contains("execute_occupant_quarantine(&app, &request)"));
    for forbidden in [
        "scan_packages_within", "name_shape", "quarantine_occupant", "purge_",
        "archive_root(", "eligible(",
    ] {
        assert!(!body.contains(forbidden), "the command must not reimplement {forbidden}");
    }

    let lib = include_str!("../lib.rs");
    assert!(lib.contains("pub mod archive_occupant_quarantine;"), "compiled");
    assert_eq!(
        lib.matches("archive_occupant_quarantine::h2o_archive_occupant_quarantine").count(),
        2,
        "registered in BOTH handler variants, and only as the approved command"
    );
    assert_eq!(
        lib.matches("archive_occupant_quarantine::").count(),
        2,
        "no other item of this module is reachable from a handler"
    );
    /* Spelled past the approved name; every other destructive spelling stays
       absent, and the private sequence is never reachable directly. */
    for forbidden in [
        "h2o_archive_occupant_purge", "h2o_archive_quarantine",
        "h2o_archive_reclaim_", "h2o_archive_delete",
        "execute_occupant_quarantine", "quarantine_internal",
    ] {
        assert!(!lib.contains(forbidden), "{forbidden} must not be registered");
    }

    /* Renderer archive mutation authority is still EMPTY. Scoped to grants that
       actually reach `$APPLOCALDATA/archive`, since `archive-export.json`
       legitimately holds an `fs:allow-mkdir` over a different tree. */
    const ARCHIVE_READ_ONLY: &[&str] = &[
        "fs:allow-exists",
        "fs:allow-read-file",
        "fs:allow-read-text-file",
        "fs:allow-lstat",
        "fs:allow-read-dir",
    ];
    let mut inspected = 0;
    for capability in [
        include_str!("../../capabilities/archive-cas.json"),
        include_str!("../../capabilities/archive-export.json"),
        include_str!("../../capabilities/default.json"),
    ] {
        let value: serde_json::Value = serde_json::from_str(capability).expect("capability json");
        let Some(entries) = value["permissions"].as_array() else { continue };
        for entry in entries {
            let Some(identifier) = entry["identifier"].as_str() else { continue };
            if !serde_json::to_string(&entry["allow"])
                .unwrap_or_default()
                .contains("$APPLOCALDATA/archive")
            {
                continue;
            }
            inspected += 1;
            assert!(
                ARCHIVE_READ_ONLY.contains(&identifier),
                "{identifier} grants the renderer non-read authority over the archive"
            );
        }
    }
    assert!(inspected > 0, "the archive grants were actually inspected");

    // The New UI reclamation surface is still Analyze-only.
    let ui = include_str!(
        "../../../../../../src-surfaces-base/studio/ingestion/saved-chat-reclamation-ui.studio.js"
    );
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
    /* Spelled past the two approved names, which the exact set above already
       pins. What must stay absent from the New UI is every OTHER destructive
       route — raw purge, stale recovery and anything CAS-destructive. */
    for forbidden in [
        "h2o_archive_purge", "h2o_archive_delete", "h2o_archive_recover",
        "h2o_archive_stale", "h2o_archive_collect", "h2o_archive_cas_reclaim",
        "purge_quarantined_item", "purge_run", "purge_all",
    ] {
        assert!(!ui.contains(forbidden), "no destructive route in the UI: {forbidden}");
    }
}

/// (AP) the result honestly distinguishes every outcome class, and each one is
/// produced by a genuinely different path.
#[test]
fn the_result_distinguishes_every_outcome_class() {
    let root = scratch("honesty");
    let name = plant_corrupt(&root, "chat_x", "2026-12-01T00:00:00.000Z");
    let valid = publish(&root, "chat_ok", "2026-12-02T00:00:00.000Z");
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();

    // Pre-mutation refusal.
    let refused = act(&root, &ex, &request("chat_ok", &valid));
    assert_eq!(refused.state, OccupantState::Refused);
    assert!(refused.run_id.is_none() && !refused.quarantined);

    // Not found — distinct from a refusal.
    let missing = act(&root, &ex, &request("chat_z", &format!("chat_z.g{}.h2ochat", "11".repeat(32))));
    assert_eq!(missing.state, OccupantState::NotFound);
    assert!(missing.run_id.is_none() && missing.classification.is_none());

    // Post-rename partial — a rename really happened, and it says so.
    fault::arm(fault::Point::AfterRenameBeforeReceipt);
    let partial = act(&root, &ex, &request("chat_x", &name));
    fault::clear();
    assert_eq!(partial.state, OccupantState::Partial);
    assert!(partial.run_id.is_some() && partial.quarantined && !partial.purged);
    assert!(!partial.blockers.is_empty());

    // Success — the only state that claims a completed logical quarantine.
    let second = plant_corrupt(&root, "chat_y", "2026-12-03T00:00:00.000Z");
    let done = act(&root, &ex, &request("chat_y", &second));
    assert_eq!(done.state, OccupantState::Quarantined);
    assert!(done.run_id.is_some() && done.quarantined && !done.purged);
    assert!(done.blockers.is_empty(), "success carries no blocker");

    // All four are distinct, and none of them ever reports a purge.
    let states = [refused.state, missing.state, partial.state, done.state];
    for i in 0..states.len() {
        for j in (i + 1)..states.len() {
            assert_ne!(states[i], states[j]);
        }
    }
    for out in [&refused, &missing, &partial, &done] {
        assert!(!out.purged, "no outcome may report a purge");
        assert_eq!(out.dwell, "one-run");
        assert_eq!(out.stage, "occupant-quarantine");
    }

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// (18)(12) the namespace-durability barrier is on the path UNCONDITIONALLY.
///
/// Whether an fsync reached the platter is not observable from userspace
/// without a real crash, so this proves the property that IS observable and
/// that skipping the barrier would violate: exactly one call site, taking the
/// packages source and the run destination, guarded only by the deterministic
/// cfg(test) fault seam.
#[test]
fn the_namespace_durability_barrier_is_unconditional() {
    let src = include_str!("../archive_occupant_quarantine.rs");
    let code = module_code();
    assert_eq!(
        code.matches("durable_quarantine_transition(").count(),
        1,
        "one barrier call site"
    );
    let at = src.find("let namespace_durable = if fault::armed").expect("the barrier binding");
    let end = src[at..].find("if let Err(code) = namespace_durable").expect("its handling");
    let expr = &src[at..at + end];
    assert!(
        expr.contains("fault::Point::AfterRenameBeforeNamespaceDurability"),
        "the only branch is the deterministic fault seam"
    );
    assert_eq!(expr.matches("if ").count(), 1, "no second condition may gate the barrier");
    assert!(!expr.contains("else if"), "nothing may skip the barrier");
    assert!(
        expr.contains("exclusive, &packages, &run_dir"),
        "it syncs the canonical source and the quarantine destination"
    );

    // And the receipt only ever follows a durable namespace transition.
    let rename = src.find("quarantine_occupant(").unwrap();
    let barrier = src.find("let namespace_durable").unwrap();
    let receipt = src.find("let durable = if fault::armed").unwrap();
    assert!(rename < barrier && barrier < receipt, "rename → durable → receipt");
}

/// M06 P4 T4.1 — the ACTIVATED occupant command's request marshaling.
///
/// The renderer sends `{ chatId, occupantName }` and nothing else can land: an
/// injected path, run id, destination or forced classification deserializes to
/// exactly the identity-only request.
#[test]
fn the_activated_occupant_request_is_identity_only_over_the_wire() {
    let clean: OccupantRequest =
        serde_json::from_str(r#"{"chatId":"chat_a","occupantName":"chat_a.gab.h2ochat"}"#)
            .expect("the approved payload deserializes");
    let hostile: OccupantRequest = serde_json::from_str(
        r#"{"chatId":"chat_a","occupantName":"chat_a.gab.h2ochat",
            "path":"/etc/passwd","archiveRoot":"/","runId":"run-evil",
            "quarantineDestination":"occupant.x","classification":"corrupt",
            "force":true,"casSha":"sha256-aa"}"#,
    )
    .expect("extra keys are ignored, not fatal");
    assert_eq!(clean, hostile, "no injected field can reach the trusted sequence");
    assert_eq!(clean.chat_id, "chat_a");
    assert_eq!(clean.occupant_name, "chat_a.gab.h2ochat");

    /* And the wire spelling is the camelCase the New UI actually sends. */
    assert!(serde_json::from_str::<OccupantRequest>(
        r#"{"chat_id":"chat_a","occupant_name":"x.h2ochat"}"#
    )
    .is_err(), "snake_case is not the wire contract");
}

/// M06 P4 T4.1 — the remedy hint on the REAL pipeline.
///
/// The Preview contract tests use synthesized classifications; this one damages
/// genuinely published packages, runs the real `scan_packages_within` and the
/// real planner, and asserts the serialized envelope the renderer receives. It
/// is what proves the synthetic reasons match what the classifier actually
/// produces — and that the hint appears on exactly the rows T3.4 would accept.
#[test]
fn the_real_pipeline_hints_exactly_the_occupants_the_command_accepts() {
    let root = scratch("hint-e2e");
    // The four governed remedy states, each from a real published generation.
    let corrupt = plant_corrupt(&root, "chat_c", "2026-01-01T00:00:00.000Z");
    let partial = plant_partial(&root, "chat_p", "2026-01-02T00:00:00.000Z");
    let foreign_name = format!("chat_f.g{}.h2ochat", "ab".repeat(32));
    let mismatch = plant_foreign(&root, "chat_f", "2026-01-03T00:00:00.000Z", &foreign_name);
    let elsewhere = root.parent().unwrap().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).unwrap();
    let unreadable = plant_symlink(&root, &format!("chat_u.g{}.h2ochat", "cd".repeat(32)), &elsewhere);
    // And everything that must be offered nothing.
    let valid = publish(&root, "chat_ok", "2026-01-04T00:00:00.000Z");
    let legacy_src = publish(&root, "chat_leg", "2026-01-05T00:00:00.000Z");
    std::fs::rename(
        root.join("packages").join(&legacy_src),
        root.join("packages").join("chat_leg.h2ochat"),
    ).unwrap();
    let broken_legacy = "chat_broken.h2ochat";
    std::fs::create_dir_all(root.join("packages").join(broken_legacy)).unwrap();
    std::fs::write(root.join("packages").join(broken_legacy).join("manifest.json"), b"{").unwrap();
    std::fs::write(root.join("packages").join("notes.txt"), b"x").unwrap();
    std::fs::create_dir_all(root.join("packages").join(".h2o-genstage-aa01")).unwrap();

    // The REAL trusted pipeline, exactly as the Preview command runs it.
    let preview = crate::archive_reclamation_preview::preview_from_parts(
        &scan_packages_within(&root),
        &crate::archive_db_probe::DbProbeResult {
            complete: true, blockers: vec![], cas_roots: vec![],
            generation_protections: vec![],
            counts: crate::archive_db_probe::DbProbeCounts::default(),
        },
        &crate::archive_cas_scan::CasInventory {
            complete: true, observed: vec![], foreign: vec![], blockers: vec![],
        },
        &crate::archive_reclamation_preview::PreviewRequest {
            chat_scope: None,
            projections: vec![],
        },
    )
    .expect("an envelope");
    let value = serde_json::to_value(&preview).expect("serializes");
    let decisions = value["plan"]["decisions"].as_array().expect("decisions");

    let hint_of = |name: &str| -> Option<serde_json::Value> {
        decisions
            .iter()
            .find(|d| d["name"] == name)
            .unwrap_or_else(|| panic!("row {name} present"))
            .get("occupant_remedy")
            .cloned()
    };

    // HINTED: exactly the four governed states, with the parsed chat identity.
    for (name, chat) in [
        (&corrupt, "chat_c"),
        (&partial, "chat_p"),
        (&mismatch, "chat_f"),
        (&unreadable, "chat_u"),
    ] {
        let hint = hint_of(name).unwrap_or_else(|| panic!("{name} must be hinted"));
        assert_eq!(hint, serde_json::json!({ "chat_id": chat }), "{name}");
    }

    // NOT HINTED: everything else the archive holds.
    for name in [
        valid.as_str(), "chat_leg.h2ochat", broken_legacy, "notes.txt", ".h2o-genstage-aa01",
    ] {
        assert_eq!(hint_of(name), None, "{name} must NOT be hinted");
    }

    /* THE JOIN THAT MATTERS: the hint set and the set the destructive command
       actually accepts are the same set. Anything hinted is accepted; anything
       accepted is hinted. */
    let owner = Owner::acquire(&root);
    let ex = owner.exclusive();
    for row in decisions {
        let name = row["name"].as_str().unwrap();
        let hinted = row.get("occupant_remedy").is_some();
        let chat = row
            .get("occupant_remedy")
            .and_then(|h| h["chat_id"].as_str())
            .unwrap_or("chat_unknown");
        let outcome = quarantine_internal(&ex, &root, true, &request(chat, name));
        let accepted = outcome.state == OccupantState::Quarantined;
        assert_eq!(
            hinted, accepted,
            "[{name}] hint says {hinted} but the trusted command says {accepted} ({:?})",
            outcome.blockers
        );
        if accepted {
            /* Quarantined, never purged: one-run dwell is intact. */
            assert!(outcome.quarantined && !outcome.purged);
        }
    }

    let _ = ex.release();
    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// M10 P1 §21C — quarantine eligibility is unchanged by blocker presence.
///
/// Eligibility and classification are compile-enforced to depend on `reason`
/// alone (both helpers take only a reason), so this pins the two remaining
/// ways the field could leak into destructive authority: a differing verdict
/// across otherwise-identical classes, and the module naming the field at all.
#[test]
fn a_verifier_blocker_cannot_change_quarantine_eligibility() {
    use crate::archive_package_scan::OccupantClass;

    for reason in [
        IndeterminateReason::Corrupt,
        IndeterminateReason::Partial,
        IndeterminateReason::IdentityMismatch,
        IndeterminateReason::Unreadable,
        IndeterminateReason::NotAPackageName,
        IndeterminateReason::UnexpectedOutcome,
    ] {
        let bare = OccupantClass::Indeterminate {
            reason: reason.clone(),
            verifier_blocker: None,
        };
        let blocked = OccupantClass::Indeterminate {
            reason: reason.clone(),
            verifier_blocker: Some("generation-destination-corrupt"),
        };

        // The production branch selects on `reason` alone; both classes must
        // therefore reach the same arm and yield the same verdict.
        let verdict = |class: &OccupantClass| match class {
            OccupantClass::Indeterminate { reason, .. } if eligible(reason) => {
                Some(classification_of(reason))
            }
            OccupantClass::Indeterminate { .. } => None,
            other => panic!("unexpected class {other:?}"),
        };
        assert_eq!(
            verdict(&bare),
            verdict(&blocked),
            "{reason:?}: the diagnostic blocker must not reach quarantine authority"
        );
        assert_eq!(eligible(&reason), verdict(&bare).is_some());
    }

    /* And the governed remedy path never reads the field. */
    let occupant_src = include_str!("../archive_occupant_quarantine.rs");
    assert!(
        !occupant_src.contains("verifier_blocker"),
        "quarantine must not name the diagnostic blocker field"
    );
}
