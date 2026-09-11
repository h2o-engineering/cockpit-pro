use super::*;
use crate::archive_db_probe::{DbProbeCounts, GenerationProtection};
use crate::archive_generation_order::UnorderableReason;
use crate::archive_cas_scan::CasInventory;
use crate::archive_package_scan::{
    ClassifiedOccupant, ConstructionFamily, IndeterminateReason, OccupantClass, VerifiedPackage,
};
use crate::saved_chat_generation_policy::LiveGenerationFamily;

fn hash(tag: u8) -> String {
    format!("{:02x}{}", tag, "0".repeat(62))
}

fn day(n: u32) -> String {
    format!("2026-01-{n:02}T00:00:00.000Z")
}

fn generation_in(
    chat: &str,
    tag: u8,
    saved_at: &str,
    construction_family: ConstructionFamily,
) -> ClassifiedOccupant {
    let h = hash(tag);
    ClassifiedOccupant {
        path: format!("archive/packages/{chat}.g{h}.h2ochat"),
        name: format!("{chat}.g{h}.h2ochat"),
        class: OccupantClass::VerifiedGeneration(VerifiedPackage {
            chat_id: chat.to_string(),
            snapshot_id: "snap-fixture".to_string(),
            content_hash: h,
            construction_family,
            snapshot_encoding: "identity".into(),
            snapshot_physical_sha256: String::new(),
            snapshot_physical_byte_length: 0,
            logical_snapshot_sha256: String::new(),
            logical_snapshot_byte_length: 0,
            order: OrderFact::Orderable {
                saved_at: saved_at.to_string(),
            },
            asset_shas: vec![],
            persistent_members: vec![],
        }),
    }
}

fn generation(chat: &str, tag: u8, saved_at: &str, v2: bool) -> ClassifiedOccupant {
    generation_in(
        chat,
        tag,
        saved_at,
        if v2 { ConstructionFamily::V2 } else { ConstructionFamily::V1 },
    )
}

fn unorderable(chat: &str, tag: u8) -> ClassifiedOccupant {
    let h = hash(tag);
    ClassifiedOccupant {
        path: format!("archive/packages/{chat}.g{h}.h2ochat"),
        name: format!("{chat}.g{h}.h2ochat"),
        class: OccupantClass::VerifiedGeneration(VerifiedPackage {
            chat_id: chat.to_string(),
            snapshot_id: "snap-fixture".to_string(),
            content_hash: h,
            construction_family: ConstructionFamily::V1,
            snapshot_encoding: "identity".into(),
            snapshot_physical_sha256: String::new(),
            snapshot_physical_byte_length: 0,
            logical_snapshot_sha256: String::new(),
            logical_snapshot_byte_length: 0,
            order: OrderFact::Unorderable {
                reason: UnorderableReason::SavedAtMissing,
            },
            asset_shas: vec![],
            persistent_members: vec![],
        }),
    }
}

fn legacy(chat: &str, tag: u8, saved_at: &str) -> ClassifiedOccupant {
    let h = hash(tag);
    ClassifiedOccupant {
        path: format!("archive/packages/{chat}.h2ochat"),
        name: format!("{chat}.h2ochat"),
        class: OccupantClass::LegacyPackage(VerifiedPackage {
            chat_id: chat.to_string(),
            snapshot_id: "snap-fixture".to_string(),
            content_hash: h,
            construction_family: ConstructionFamily::V1,
            snapshot_encoding: "identity".into(),
            snapshot_physical_sha256: String::new(),
            snapshot_physical_byte_length: 0,
            logical_snapshot_sha256: String::new(),
            logical_snapshot_byte_length: 0,
            order: OrderFact::Orderable {
                saved_at: saved_at.to_string(),
            },
            asset_shas: vec![],
            persistent_members: vec![],
        }),
    }
}

fn indeterminate(name: &str, reason: IndeterminateReason) -> ClassifiedOccupant {
    ClassifiedOccupant {
        path: format!("archive/packages/{name}"),
        name: name.to_string(),
        class: OccupantClass::Indeterminate {
            reason,
            verifier_blocker: None,
        },
    }
}

fn reserved(name: &str) -> ClassifiedOccupant {
    ClassifiedOccupant {
        path: format!("archive/packages/{name}"),
        name: name.to_string(),
        class: OccupantClass::ReservedInfrastructure,
    }
}

fn scan(occupants: Vec<ClassifiedOccupant>) -> PackageScan {
    PackageScan {
        complete: true,
        blockers: vec![],
        occupants,
    }
}

fn db(protections: Vec<GenerationProtection>, cas_roots: Vec<String>) -> DbProbeResult {
    DbProbeResult {
        complete: true,
        blockers: vec![],
        cas_roots,
        generation_protections: protections,
        counts: DbProbeCounts::default(),
    }
}

fn cas_inventory(observed: Vec<String>) -> CasInventory {
    CasInventory {
        complete: true,
        observed,
        foreign: vec![],
        blockers: vec![],
    }
}

fn empty_cas() -> CasInventory {
    cas_inventory(vec![])
}

fn verdicts(pairs: &[(&str, &str)]) -> BTreeMap<String, ProjectionVerdict> {
    pairs
        .iter()
        .map(|(chat, h)| {
            (
                chat.to_string(),
                ProjectionVerdict::Authoritative {
                    content_hash: h.to_string(),
                },
            )
        })
        .collect()
}

fn run(scan: &PackageScan, db: &DbProbeResult, projections: BTreeMap<String, ProjectionVerdict>) -> ReclamationPlan {
    run_with_cas(scan, db, projections, &empty_cas())
}

fn run_with_cas(
    scan: &PackageScan,
    db: &DbProbeResult,
    projections: BTreeMap<String, ProjectionVerdict>,
    cas: &CasInventory,
) -> ReclamationPlan {
    plan_for_live_family(&RetentionInputs {
        scan,
        db,
        projections,
        scope: None,
        cas,
    }, LiveGenerationFamily::V1V2)
}

fn run_for_family(
    scan: &PackageScan,
    db: &DbProbeResult,
    projections: BTreeMap<String, ProjectionVerdict>,
    live_family: LiveGenerationFamily,
) -> ReclamationPlan {
    let cas = empty_cas();
    plan_for_live_family(
        &RetentionInputs {
            scan,
            db,
            projections,
            scope: None,
            cas: &cas,
        },
        live_family,
    )
}

fn decision_for<'a>(plan: &'a ReclamationPlan, name: &str) -> &'a Decision {
    &plan
        .decisions
        .iter()
        .find(|d| d.name == name)
        .unwrap_or_else(|| panic!("{name} missing from plan"))
        .decision
}

fn candidates(plan: &ReclamationPlan) -> Vec<&str> {
    plan.decisions
        .iter()
        .filter(|d| matches!(d.decision, Decision::Candidate { .. }))
        .map(|d| d.name.as_str())
        .collect()
}

fn reasons_for(plan: &ReclamationPlan, name: &str) -> Vec<ProtectionReason> {
    match decision_for(plan, name) {
        Decision::Protected { reasons } => reasons.clone(),
        other => panic!("{name} expected protected, got {other:?}"),
    }
}

/// Five orderable same-family generations, newest first: tags 5,4,3,2,1.
fn five_generations(chat: &str) -> Vec<ClassifiedOccupant> {
    (1u8..=5)
        .map(|t| generation(chat, t, &day(t as u32), false))
        .collect()
}

/// (A)(C)(Z) the newest overall and the newest K=3 are protected; only what
/// falls outside every protection and carries positive evidence is a candidate.
#[test]
fn the_retention_floor_protects_the_newest_three_and_the_rest_need_positive_evidence() {
    let s = scan(five_generations("chat_a"));
    // The current projection is something else entirely, so the older ones are
    // positively content-obsolete.
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(5))]));

    assert!(plan.complete, "{:?}", plan.blockers);
    assert_eq!(plan.retention_floor, 3);
    assert_eq!(plan.schema, PLAN_SCHEMA);
    assert_eq!(plan.schema_version, PLAN_SCHEMA_VERSION);

    let name = |t: u8| format!("chat_a.g{}.h2ochat", hash(t));
    // Newest (tag 5) carries BOTH newest-overall and floor protection.
    let newest = reasons_for(&plan, &name(5));
    assert!(newest.contains(&ProtectionReason::NewestOverall));
    assert!(newest.contains(&ProtectionReason::RetentionFloor));
    // Ranks 1 and 2 are floor-protected only.
    for t in [4u8, 3] {
        let r = reasons_for(&plan, &name(t));
        assert!(r.contains(&ProtectionReason::RetentionFloor), "tag {t}");
        assert!(!r.contains(&ProtectionReason::NewestOverall), "tag {t}");
    }
    // Ranks 3 and 4 fall outside the floor and are candidates. The plan is
    // ordered by trusted archive-relative identity, NOT by recency, so tag 1
    // precedes tag 2 here.
    let expected = vec![name(1), name(2)];
    assert_eq!(
        candidates(&plan),
        expected.iter().map(|s| s.as_str()).collect::<Vec<_>>()
    );

    // (Z) every candidate carries explicit positive evidence.
    for d in &plan.decisions {
        if let Decision::Candidate { evidence } = &d.decision {
            assert!(evidence.content_obsolete);
            assert_eq!(evidence.current_projection_content_hash, hash(5));
            assert_eq!(evidence.retention_floor, 3);
            assert!(evidence.family_rank >= 3, "must be outside the floor");
            assert!(!evidence.saved_at.is_empty());
        }
    }
    assert_eq!(plan.totals.candidates, 2);
    assert_eq!(plan.totals.protected, 3);
}

/// (B) K is injectable for tests; K=1 works and K=0 is refused. Production is
/// bound to the approved constant.
#[test]
fn the_floor_honours_k_ge_1_and_refuses_k_zero() {
    assert_eq!(RETENTION_FLOOR_K, 3, "DP-M06-RETENTION-FLOOR default");
    let s = scan(five_generations("chat_a"));
    let d = db(vec![], vec![]);
    let empty = empty_cas();
    let inputs = RetentionInputs {
        scan: &s,
        db: &d,
        projections: verdicts(&[("chat_a", &hash(5))]),
        scope: None,
        cas: &empty,
    };

    let k1 = plan_with_floor_for_live_family(&inputs, 1, LiveGenerationFamily::V1V2)
        .expect("K=1 is valid");
    assert_eq!(k1.retention_floor, 1);
    // Only the newest survives the floor; it is also newest-overall.
    assert_eq!(k1.totals.candidates, 4);

    let k0 = plan_with_floor_for_live_family(&inputs, 0, LiveGenerationFamily::V1V2);
    assert_eq!(k0.err().as_deref(), Some(codes::INVALID_FLOOR));

    // Production path is the approved floor.
    assert_eq!(
        plan_for_live_family(&inputs, LiveGenerationFamily::V1V2).retention_floor,
        RETENTION_FLOOR_K
    );
}

/// (D) verified-but-unorderable is protected, never ranked as oldest, and never
/// consumes a retained slot.
#[test]
fn an_unorderable_generation_is_protected_and_consumes_no_retained_slot() {
    let mut occupants = five_generations("chat_a");
    occupants.push(unorderable("chat_a", 60));
    let s = scan(occupants);
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(5))]));

    let r = reasons_for(&plan, &format!("chat_a.g{}.h2ochat", hash(60)));
    assert!(r.contains(&ProtectionReason::Unorderable));
    assert!(!r.contains(&ProtectionReason::RetentionFloor), "must not take a slot");
    // The floor still protects exactly the three newest ORDERABLE ones.
    assert_eq!(plan.totals.candidates, 2);
    // And it carries no synthetic time anywhere.
    let json = serde_json::to_string(&plan).unwrap();
    assert!(!json.contains("1970"));
}

/// (E) legacy is never a candidate and never consumes a retained slot.
#[test]
fn a_legacy_package_is_always_protected() {
    let mut occupants = five_generations("chat_a");
    occupants.push(legacy("chat_a", 70, &day(1)));
    let s = scan(occupants);
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(5))]));

    let r = reasons_for(&plan, "chat_a.h2ochat");
    assert!(r.contains(&ProtectionReason::Legacy));
    // Its presence did not displace a generation from the floor.
    assert_eq!(plan.totals.candidates, 2);
    assert!(!candidates(&plan).contains(&"chat_a.h2ochat"));
}

/// (F) indeterminate and reserved occupants are excluded, never candidates.
#[test]
fn indeterminate_and_reserved_occupants_are_never_candidates() {
    let mut occupants = five_generations("chat_a");
    for (name, reason) in [
        ("chat_x.gaa.h2ochat", IndeterminateReason::Corrupt),
        ("chat_y.gbb.h2ochat", IndeterminateReason::IdentityMismatch),
        ("stray.txt", IndeterminateReason::NotAPackageName),
        ("chat_z.gcc.h2ochat", IndeterminateReason::Unreadable),
    ] {
        occupants.push(indeterminate(name, reason));
    }
    occupants.push(reserved(".h2o-archive.lock"));
    occupants.push(reserved(".h2o-reclaim"));
    let s = scan(occupants);
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(5))]));

    for name in ["chat_x.gaa.h2ochat", "stray.txt", "chat_z.gcc.h2ochat"] {
        assert!(matches!(
            decision_for(&plan, name),
            Decision::Excluded { reason: ExclusionReason::Indeterminate }
        ), "{name}");
    }
    for name in [".h2o-archive.lock", ".h2o-reclaim"] {
        assert!(matches!(
            decision_for(&plan, name),
            Decision::Excluded { reason: ExclusionReason::ReservedInfrastructure }
        ), "{name}");
    }
    assert_eq!(plan.totals.candidates, 2, "only the real old generations");
    assert_eq!(plan.totals.excluded, 6);
}

/// (G)(H)(I)(J)(K) each trusted DB protection class rescues an otherwise
/// eligible generation, and multiple reasons accumulate.
#[test]
fn every_trusted_db_protection_class_rescues_an_eligible_generation() {
    let cases = [
        (ProtectionSource::StrandedWriting, ProtectionReason::StrandedWriting),
        (ProtectionSource::Import, ProtectionReason::ImportProvenance),
        (ProtectionSource::Restore, ProtectionReason::RestoreProvenance),
        (ProtectionSource::Relink, ProtectionReason::RelinkProvenance),
    ];
    for (source, expected) in cases {
        let s = scan(five_generations("chat_a"));
        // Protect tag 1 — otherwise the oldest candidate.
        let d = db(
            vec![GenerationProtection {
                chat_id: "chat_a".into(),
                content_hash: hash(1),
                source,
            }],
            vec![],
        );
        let plan = run(&s, &d, verdicts(&[("chat_a", &hash(5))]));
        let name = format!("chat_a.g{}.h2ochat", hash(1));
        assert!(reasons_for(&plan, &name).contains(&expected), "{source:?}");
        assert!(!candidates(&plan).contains(&name.as_str()), "{source:?}");
        assert_eq!(plan.totals.candidates, 1, "{source:?}");
    }

    // (K) several protections on ONE generation all survive, in any input order.
    let s = scan(five_generations("chat_a"));
    let mut protections = vec![
        GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(1), source: ProtectionSource::Import },
        GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(1), source: ProtectionSource::Relink },
        GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(1), source: ProtectionSource::StrandedWriting },
    ];
    let forward = run(&s, &db(protections.clone(), vec![]), verdicts(&[("chat_a", &hash(5))]));
    protections.reverse();
    let reverse = run(&s, &db(protections, vec![]), verdicts(&[("chat_a", &hash(5))]));
    let name = format!("chat_a.g{}.h2ochat", hash(1));
    let r = reasons_for(&forward, &name);
    assert_eq!(r.len(), 3, "every reason retained: {r:?}");
    assert_eq!(r, reasons_for(&reverse, &name), "reason order is deterministic");
}

/// (L) a generation whose hash EQUALS the authoritative projection is the
/// current one and is protected as such.
#[test]
fn the_generation_matching_the_current_projection_is_protected() {
    let s = scan(five_generations("chat_a"));
    // Make the OLDEST the current projection: it must stop being a candidate.
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(1))]));
    let name = format!("chat_a.g{}.h2ochat", hash(1));
    assert!(reasons_for(&plan, &name).contains(&ProtectionReason::CurrentProjection));
    assert_eq!(candidates(&plan), vec![format!("chat_a.g{}.h2ochat", hash(2))]);
}

/// (M)(N)(O) renderer evidence is enabling-only: missing, failed or malformed
/// verdicts can only protect, and can never grow the candidate set.
#[test]
fn renderer_evidence_is_enabling_only_and_monotonic() {
    let s = scan(five_generations("chat_a"));
    let d = db(vec![], vec![]);

    // (M) no verdict at all for the chat.
    let missing = run(&s, &d, BTreeMap::new());
    assert!(missing.candidates_are_empty());
    assert!(reasons_for(&missing, &format!("chat_a.g{}.h2ochat", hash(1)))
        .contains(&ProtectionReason::ProjectionUnavailable));

    // (N) failed / malformed verdicts, built through the real renderer rule.
    for (status, hash_text) in [
        ("indeterminate", ""),
        ("undefined-no-snapshot", ""),
        ("failed", "deadbeef"),
        ("ok", ""),          // ok WITHOUT a hash is not authoritative
        ("ok", "not-a-hash"), // ok with a malformed hash is not authoritative
        ("", ""),
    ] {
        let verdict = ProjectionVerdict::from_renderer(status, hash_text);
        assert_eq!(verdict, ProjectionVerdict::Unavailable, "{status:?}/{hash_text:?}");
        let mut map = BTreeMap::new();
        map.insert("chat_a".to_string(), verdict);
        let plan = run(&s, &d, map);
        assert!(plan.candidates_are_empty(), "{status:?} must not create candidates");
    }

    // (O) monotonicity: less-informed ⊆ more-informed, for the same trusted state.
    let informed = run(&s, &d, verdicts(&[("chat_a", &hash(5))]));
    let informed_set: std::collections::BTreeSet<&str> = candidates(&informed).into_iter().collect();
    for less in [BTreeMap::new(), {
        let mut m = BTreeMap::new();
        m.insert("chat_a".to_string(), ProjectionVerdict::Unavailable);
        m
    }] {
        let plan = run(&s, &d, less);
        let set: std::collections::BTreeSet<&str> = candidates(&plan).into_iter().collect();
        assert!(
            set.is_subset(&informed_set),
            "removing renderer information must never grow the candidate set"
        );
        assert!(set.is_empty());
    }
    assert_eq!(informed_set.len(), 2, "the informed case really does have candidates");
}

/// (P) format/family difference alone is never content-obsolescence. A v2
/// generation older than v1 ones is not a candidate on format grounds; only the
/// projection comparison can make it one, and the family floor applies per
/// family.
#[test]
fn family_difference_alone_never_creates_a_candidate() {
    // Two families for one chat: v1 tags 1..3, v2 tags 4..5.
    let occupants = vec![
        generation("chat_a", 1, &day(1), false),
        generation("chat_a", 2, &day(2), false),
        generation("chat_a", 3, &day(3), false),
        generation("chat_a", 4, &day(4), true),
        generation("chat_a", 5, &day(5), true),
    ];
    let s = scan(occupants);
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(5))]));

    // The v2 family has only 2 members, so BOTH sit inside its own K=3 floor.
    for t in [4u8, 5] {
        let r = reasons_for(&plan, &format!("chat_a.g{}.h2ochat", hash(t)));
        assert!(r.contains(&ProtectionReason::RetentionFloor), "v2 tag {t}");
    }
    // The v1 family also has 3 members, all inside its floor.
    for t in [1u8, 2, 3] {
        let r = reasons_for(&plan, &format!("chat_a.g{}.h2ochat", hash(t)));
        assert!(r.contains(&ProtectionReason::RetentionFloor), "v1 tag {t}");
    }
    assert_eq!(plan.totals.candidates, 0, "no candidate arises from family difference");

    // Pin the absence of any version/format-based candidate rule in the source.
    let code: String = include_str!("../archive_retention_plan.rs")
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    // FormatStale is now a PROTECTION reason (Correction B), so banning the
    // token would ban the safety rule itself. Ban the real hazard: deciding
    // obsolescence by comparing versions.
    for forbidden in [
        "schema_version >", "schema_version <", "payload_version >", "payload_version <",
        "content_obsolete: entry.construction_family", "family_is_obsolete",
    ] {
        assert!(!code.contains(forbidden), "version comparison must not decide obsolescence: {forbidden}");
    }
    // FormatStale must only ever be inserted as a protection.
    assert!(code.contains("reasons.insert(ProtectionReason::FormatStale)"));
}

/// (R)(S) incomplete trusted inputs block authoritative candidates, and the
/// blockers stay visible rather than hiding behind an empty list.
#[test]
fn incomplete_trusted_inputs_block_authoritative_candidates() {
    let base = five_generations("chat_a");
    let v = verdicts(&[("chat_a", &hash(5))]);

    // (R) incomplete package scan.
    let mut s = scan(base.clone());
    s.complete = false;
    s.blockers.push("package-scan-packages-unreadable".into());
    let plan = run(&s, &db(vec![], vec![]), v.clone());
    assert!(!plan.complete);
    assert!(plan.blockers.contains(&codes::SCAN_INCOMPLETE.to_string()));
    assert!(plan.candidates_are_empty(), "an incomplete scan yields no candidates");

    // (S) incomplete DB probe.
    let s = scan(base);
    let mut d = db(vec![], vec![]);
    d.complete = false;
    d.blockers.push("db-probe-query-failed:chats".into());
    let plan = run(&s, &d, v);
    assert!(!plan.complete);
    assert!(plan.blockers.contains(&codes::DB_INCOMPLETE.to_string()));
    assert!(plan.candidates_are_empty(), "an incomplete probe yields no candidates");
    assert!(plan.totals.candidates == 0 && !plan.blockers.is_empty());
}

/// (T)(U) read-only CAS analysis unions every reference root, and any
/// indeterminate package makes it incomplete. It never names anything
/// collectible.
#[test]
fn cas_analysis_unions_all_roots_and_fails_closed_on_missing_evidence() {
    let a = "aa".repeat(32);
    let b = "bb".repeat(32);
    let c = "cc".repeat(32);

    let mut package = generation("chat_a", 1, &day(1), true);
    if let OccupantClass::VerifiedGeneration(p) = &mut package.class {
        p.asset_shas = vec![a.clone(), b.clone()];
    }
    let s = scan(vec![package]);
    let d = db(vec![], vec![b.clone(), c.clone()]);
    let plan = run(&s, &d, verdicts(&[("chat_a", &hash(1))]));

    // (T) union of package manifest refs and both DB root tables, deduped.
    assert!(plan.cas.complete);
    let mut expected = vec![a.clone(), b.clone(), c.clone()];
    expected.sort();
    assert_eq!(plan.cas.referenced, expected);
    assert_eq!(plan.totals.referenced_cas_objects, 3);

    // (U) an indeterminate occupant could hide references we cannot see.
    let mut occupants = vec![];
    let mut package = generation("chat_a", 1, &day(1), true);
    if let OccupantClass::VerifiedGeneration(p) = &mut package.class {
        p.asset_shas = vec![a.clone()];
    }
    occupants.push(package);
    occupants.push(indeterminate("broken.h2ochat", IndeterminateReason::Corrupt));
    let s = scan(occupants);
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(1))]));
    assert!(!plan.cas.complete, "hidden references make analysis incomplete");
    assert!(plan
        .cas
        .incomplete_reasons
        .contains(&codes::CAS_REFERENCES_INCOMPLETE.to_string()));

    // No unreferenced / collectible / deletion vocabulary exists anywhere.
    let json = serde_json::to_string(&plan).unwrap();
    // `observed_unreferenced` is the accepted ANALYTICAL term and must be
    // present; what must never appear is anything implying removal authority.
    for forbidden in ["collectible", "deletable", "safeToDelete", "reclaimCandidate", "deleteCandidate"] {
        assert!(!json.contains(forbidden), "CAS analysis must not imply removal: {forbidden}");
    }
    assert!(serde_json::to_string(&plan.cas).unwrap().contains("observed_unreferenced"));
}

/// (V) chat scope narrows output but cannot strip a protection from a
/// generation still inside the scope.
#[test]
fn chat_scope_narrows_output_without_weakening_protection() {
    let mut occupants = five_generations("chat_a");
    occupants.extend(five_generations("chat_b"));
    let s = scan(occupants);
    let d = db(
        vec![GenerationProtection {
            chat_id: "chat_a".into(),
            content_hash: hash(1),
            source: ProtectionSource::Import,
        }],
        vec![],
    );
    let empty = empty_cas();
    let all = plan(&RetentionInputs {
        scan: &s,
        db: &d,
        projections: verdicts(&[("chat_a", &hash(5)), ("chat_b", &hash(5))]),
        scope: None,
        cas: &empty,
    });
    let scoped = plan(&RetentionInputs {
        scan: &s,
        db: &d,
        projections: verdicts(&[("chat_a", &hash(5)), ("chat_b", &hash(5))]),
        scope: Some(["chat_a".to_string()].into_iter().collect()),
        cas: &empty,
    });

    assert_eq!(all.totals.chats_in_scope, 2);
    assert_eq!(scoped.totals.chats_in_scope, 1);
    // chat_b vanished from analysis but was NOT made a candidate.
    for d in &scoped.decisions {
        if d.chat_id == "chat_b" {
            assert!(matches!(
                d.decision,
                Decision::Excluded { reason: ExclusionReason::OutOfScope }
            ));
        }
    }
    // The in-scope protection still applies.
    let name = format!("chat_a.g{}.h2ochat", hash(1));
    assert!(reasons_for(&scoped, &name).contains(&ProtectionReason::ImportProvenance));
    // Scoping never grew the candidate set.
    let all_set: std::collections::BTreeSet<&str> = candidates(&all).into_iter().collect();
    let scoped_set: std::collections::BTreeSet<&str> = candidates(&scoped).into_iter().collect();
    assert!(scoped_set.is_subset(&all_set));
}

/// CORRECTION A — a syntactically valid projection hash that no verified
/// on-disk generation carries has NO trusted witness. This is the ordinary
/// state "a current projection exists but has not been materialized yet", and
/// generation pruning must not begin in it.
#[test]
fn an_unwitnessed_projection_hash_cannot_enable_any_candidate() {
    let s = scan(five_generations("chat_a")); // 5 orderable, otherwise eligible
    let d = db(vec![], vec![]);

    // status=ok, syntactically valid 64-hex, matching NO on-disk generation.
    let unmatched = hash(99);
    assert_eq!(
        ProjectionVerdict::from_renderer("ok", &unmatched),
        ProjectionVerdict::Authoritative { content_hash: unmatched.clone() },
        "the renderer-level rule alone would accept this"
    );
    let plan = run(&s, &d, verdicts(&[("chat_a", &unmatched)]));

    assert!(plan.complete, "{:?}", plan.blockers);
    assert_eq!(plan.totals.candidates, 0, "an unwitnessed claim prunes nothing");
    for t in 1u8..=5 {
        let r = reasons_for(&plan, &format!("chat_a.g{}.h2ochat", hash(t)));
        assert!(
            r.contains(&ProtectionReason::ProjectionUnwitnessed),
            "tag {t} must be protected by the missing witness, got {r:?}"
        );
    }

    // POSITIVE CONTROL: same archive, projection hash now matches a VERIFIED
    // on-disk generation. Normal floor / content-obsolete logic proceeds.
    let witnessed = run(&s, &d, verdicts(&[("chat_a", &hash(5))]));
    assert_eq!(witnessed.totals.candidates, 2, "the control must actually prune");
    for d in &witnessed.decisions {
        if let Decision::Protected { reasons } = &d.decision {
            assert!(!reasons.contains(&ProtectionReason::ProjectionUnwitnessed));
        }
    }

    // Monotonic: the unwitnessed set is a subset of the witnessed set.
    let a: std::collections::BTreeSet<&str> = candidates(&plan).into_iter().collect();
    let b: std::collections::BTreeSet<&str> = candidates(&witnessed).into_iter().collect();
    assert!(a.is_subset(&b) && a.is_empty());
}

/// CORRECTION A — a legacy package does not witness a projection: legacy is
/// never a generation.
#[test]
fn a_legacy_package_cannot_witness_a_projection() {
    let s = scan(vec![
        legacy("chat_a", 70, &day(1)),
        generation("chat_a", 1, &day(1), false),
        generation("chat_a", 2, &day(2), false),
        generation("chat_a", 3, &day(3), false),
        generation("chat_a", 4, &day(4), false),
        generation("chat_a", 5, &day(5), false),
    ]);
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(70))]));
    assert_eq!(plan.totals.candidates, 0, "a legacy hash is not a witness");
    assert!(reasons_for(&plan, &format!("chat_a.g{}.h2ochat", hash(1)))
        .contains(&ProtectionReason::ProjectionUnwitnessed));
}

/// CORRECTION B — NON-VACUOUS: K+2 valid generations in a non-live family, all
/// otherwise candidate-eligible, and NONE may become a candidate. The count
/// exceeds the floor deliberately, so the floor cannot mask a missing
/// format-stale protection.
#[test]
fn k_plus_two_valid_non_live_family_generations_are_all_format_stale_protected() {
    const N: u8 = (RETENTION_FLOOR_K as u8) + 2; // 5 > K
    let stale = ConstructionFamily::V3; // non-live under the V1/V2 rollback policy

    // Build K+2 generations and force them out of the live-writer set.
    let occupants: Vec<ClassifiedOccupant> = (1..=N)
        .map(|t| generation_in("chat_a", t, &day(t as u32), stale))
        .collect();
    let s = scan(occupants);
    // Witnessed projection on the newest, so every older one is content-obsolete
    // and outside the floor — the only thing that can save them is FormatStale.
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(N))]));

    assert!(plan.complete);
    assert!(N as usize > RETENTION_FLOOR_K, "fixture must exceed the floor");
    assert!(
        !stale.is_live_writer_family_for(LiveGenerationFamily::V1V2),
        "fixture family must be non-live under the exercised rollback policy"
    );
    assert_eq!(plan.totals.candidates, 0, "format-stale must protect all K+2 of them");
    for t in 1..=N {
        assert!(
            reasons_for(&plan, &format!("chat_a.g{}.h2ochat", hash(t)))
                .contains(&ProtectionReason::FormatStale),
            "tag {t} must be format-stale protected"
        );
    }
    // Non-vacuity: these WOULD have pruned in the live family.
    let live: Vec<ClassifiedOccupant> = (1..=N)
        .map(|t| generation_in("chat_a", t, &day(t as u32), ConstructionFamily::V1))
        .collect();
    let control = run(&scan(live), &db(vec![], vec![]), verdicts(&[("chat_a", &hash(N))]));
    assert_eq!(control.totals.candidates, 2, "the same shape prunes when live");

    // The RULE itself is proven regardless: candidacy requires the live family.
    let code: String = include_str!("../archive_retention_plan.rs")
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(code.contains("is_live_writer_family_for(live_family)"));
}

/// CORRECTION B — live-family control: with K+2 live-family generations, older
/// positively eligible ones DO become candidates, so the test above is not
/// passing merely because nothing is ever a candidate.
#[test]
fn k_plus_two_live_family_generations_prune_normally() {
    const N: u8 = (RETENTION_FLOOR_K as u8) + 2;
    let occupants: Vec<ClassifiedOccupant> = (1..=N)
        .map(|t| generation_in("chat_a", t, &day(t as u32), ConstructionFamily::V1))
        .collect();
    let s = scan(occupants);
    let plan = run(&s, &db(vec![], vec![]), verdicts(&[("chat_a", &hash(N))]));
    assert_eq!(
        plan.totals.candidates,
        (N as usize) - RETENTION_FLOOR_K,
        "everything beyond the floor prunes in the live family"
    );
    for d in &plan.decisions {
        if let Decision::Protected { reasons } = &d.decision {
            assert!(!reasons.contains(&ProtectionReason::FormatStale));
        }
    }
}

#[test]
fn active_family_policy_reclassifies_without_making_old_formats_destructive() {
    const N: u8 = (RETENTION_FLOOR_K as u8) + 2;
    let d = db(vec![], vec![]);

    for (family, live_policy, rollback_policy) in [
        (
            ConstructionFamily::V3,
            LiveGenerationFamily::V3,
            LiveGenerationFamily::V1V2,
        ),
        (
            ConstructionFamily::V1,
            LiveGenerationFamily::V1V2,
            LiveGenerationFamily::V3,
        ),
        (
            ConstructionFamily::V2,
            LiveGenerationFamily::V1V2,
            LiveGenerationFamily::V3,
        ),
    ] {
        let occupants: Vec<_> = (1..=N)
            .map(|tag| generation_in("chat_policy", tag, &day(tag as u32), family))
            .collect();
        let s = scan(occupants);
        let projection = verdicts(&[("chat_policy", &hash(N))]);

        let active = run_for_family(&s, &d, projection.clone(), live_policy);
        assert_eq!(
            active.totals.candidates,
            N as usize - RETENTION_FLOOR_K,
            "the active family must retain ordinary content-stale candidacy"
        );
        assert!(active
            .decisions
            .iter()
            .all(|decision| match &decision.decision {
                Decision::Protected { reasons } =>
                    !reasons.contains(&ProtectionReason::FormatStale),
                Decision::Candidate { .. } | Decision::Excluded { .. } => true,
            }));

        let rolled_back = run_for_family(&s, &d, projection, rollback_policy);
        assert_eq!(rolled_back.totals.candidates, 0);
        for decision in &rolled_back.decisions {
            let Decision::Protected { reasons } = &decision.decision else {
                panic!("non-live family must be protected: {decision:?}");
            };
            assert!(reasons.contains(&ProtectionReason::FormatStale));
        }
        assert!(
            s.occupants.iter().all(|occupant| match &occupant.class {
                OccupantClass::VerifiedGeneration(package) => package.construction_family == family,
                _ => false,
            }),
            "policy changes classification, never verified construction family"
        );
    }
}

#[test]
fn production_plan_is_exactly_the_shared_v3_policy_mapping() {
    assert_eq!(
        crate::saved_chat_generation_policy::production_live_generation_family(),
        LiveGenerationFamily::V3
    );
    let s = scan(vec![
        generation_in("chat_prod", 1, &day(1), ConstructionFamily::V1),
        generation_in("chat_prod", 2, &day(2), ConstructionFamily::V2),
        generation_in("chat_prod", 3, &day(3), ConstructionFamily::V3),
    ]);
    let d = db(vec![], vec![]);
    let projections = verdicts(&[("chat_prod", &hash(3))]);
    let cas = empty_cas();
    let inputs = RetentionInputs {
        scan: &s,
        db: &d,
        projections: projections.clone(),
        scope: None,
        cas: &cas,
    };
    assert_eq!(
        plan(&inputs),
        run_for_family(&s, &d, projections, LiveGenerationFamily::V3),
        "Preview and Execute both call plan, whose production result must be the shared build policy"
    );
}

/// CORRECTION C — read-only orphan ANALYSIS: observed minus referenced.
#[test]
fn orphan_analysis_reports_observed_unreferenced_only_when_authoritative() {
    let from_manifest = "aa".repeat(32);
    let from_assets = "bb".repeat(32);
    let from_turn_assets = "cc".repeat(32);
    let unreferenced = "dd".repeat(32);

    let mut package = generation("chat_a", 1, &day(1), true);
    if let OccupantClass::VerifiedGeneration(p) = &mut package.class {
        p.asset_shas = vec![from_manifest.clone()];
    }
    let s = scan(vec![package]);
    let d = db(vec![], vec![from_assets.clone(), from_turn_assets.clone()]);
    let inventory = cas_inventory(vec![
        unreferenced.clone(),
        from_manifest.clone(),
        from_assets.clone(),
        from_turn_assets.clone(),
        // a duplicate observation must dedupe
        from_manifest.clone(),
    ]);

    let plan = run_with_cas(&s, &d, verdicts(&[("chat_a", &hash(1))]), &inventory);
    assert!(plan.cas.complete, "{:?}", plan.cas.incomplete_reasons);
    assert_eq!(plan.cas.observed.len(), 4, "deduped observation");
    assert_eq!(
        plan.cas.observed_unreferenced,
        vec![unreferenced.clone()],
        "exactly one observed body is unreferenced"
    );
    // Each root source really did protect its object.
    for root in [&from_manifest, &from_assets, &from_turn_assets] {
        assert!(plan.cas.referenced.contains(root));
        assert!(!plan.cas.observed_unreferenced.contains(root));
    }

    // Incomplete CAS inventory => not an authoritative orphan conclusion.
    let mut broken = inventory.clone();
    broken.complete = false;
    broken.blockers.push("cas-scan-shard-unreadable".into());
    let plan = run_with_cas(&s, &d, verdicts(&[("chat_a", &hash(1))]), &broken);
    assert!(!plan.cas.complete);
    assert!(plan
        .cas
        .incomplete_reasons
        .contains(&codes::CAS_INVENTORY_INCOMPLETE.to_string()));

    // Incomplete DB probe => likewise.
    let mut d2 = d.clone();
    d2.complete = false;
    let plan = run_with_cas(&s, &d2, verdicts(&[("chat_a", &hash(1))]), &inventory);
    assert!(!plan.cas.complete);

    // An indeterminate package could hide manifest references => likewise.
    let s2 = scan(vec![indeterminate("broken.h2ochat", IndeterminateReason::Corrupt)]);
    let plan = run_with_cas(&s2, &d, BTreeMap::new(), &inventory);
    assert!(!plan.cas.complete);
    assert!(plan
        .cas
        .incomplete_reasons
        .contains(&codes::CAS_REFERENCES_INCOMPLETE.to_string()));
}

/// (Q) permuting every input order yields an identical plan.
#[test]
fn the_plan_is_byte_identical_under_input_permutation() {
    let mut occupants = five_generations("chat_a");
    occupants.push(legacy("chat_b", 70, &day(2)));
    occupants.push(unorderable("chat_a", 60));
    occupants.push(indeterminate("broken.h2ochat", IndeterminateReason::Corrupt));
    occupants.push(reserved(".h2o-reclaim"));

    let protections = vec![
        GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(2), source: ProtectionSource::Restore },
        GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(1), source: ProtectionSource::Import },
    ];
    let roots = vec!["dd".repeat(32), "cc".repeat(32)];
    let v = verdicts(&[("chat_a", &hash(5)), ("chat_b", &hash(98))]);

    let forward = serde_json::to_string(&run(
        &scan(occupants.clone()),
        &db(protections.clone(), roots.clone()),
        v.clone(),
    ))
    .unwrap();

    let mut reversed = occupants;
    reversed.reverse();
    let mut rev_protections = protections;
    rev_protections.reverse();
    let mut rev_roots = roots;
    rev_roots.reverse();
    let backward =
        serde_json::to_string(&run(&scan(reversed), &db(rev_protections, rev_roots), v)).unwrap();

    assert_eq!(forward, backward, "input order must not affect the plan");
}

/// (Y) an empty but complete archive is a complete empty plan, not a blocker.
#[test]
fn an_empty_complete_archive_yields_a_complete_empty_plan() {
    let plan = run(&scan(vec![]), &db(vec![], vec![]), BTreeMap::new());
    assert!(plan.complete);
    assert!(plan.blockers.is_empty());
    assert!(plan.decisions.is_empty());
    assert_eq!(plan.totals.occupants, 0);
    assert_eq!(plan.totals.candidates, 0);
    assert!(plan.cas.complete);
    assert!(plan.cas.referenced.is_empty());
}

/// (W)(X) no destructive surface and no second authority.
#[test]
fn the_engine_has_no_destructive_surface_and_no_second_authority() {
    let code: String = include_str!("../archive_retention_plan.rs")
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(code.contains("pub fn plan_with_floor"), "scanned the real module");

    // (W) no command, no capability, no mutation, no I/O.
    for forbidden in [
        "#[tauri::command]", "tauri::State", "AppHandle", "invoke",
        "remove_file", "remove_dir", "std::fs", "unlinkat", "renameat", "rename(",
        "sqlx", "INSERT", "UPDATE", "DELETE", "receipt", "execute",
    ] {
        assert!(!code.contains(forbidden), "destructive/IO surface leaked: {forbidden}");
    }
    // (X) no second hashing, projection, verification or ordering authority.
    for forbidden in [
        "Sha256", "Digest::", "sha256_hex", "verify_occupant", "validate_manifest",
        "OffsetDateTime", "Rfc3339", "parse_instant", "refcount",
    ] {
        assert!(!code.contains(forbidden), "second authority leaked: {forbidden}");
    }
    // Ordering is delegated, not reimplemented.
    assert!(code.contains("archive_generation_order::order"));
    // No time authority of any kind.
    for forbidden in ["mtime", "ctime", "birthtime", "SystemTime", "Instant::now", "elapsed", "generatedAt"] {
        assert!(!code.contains(forbidden), "time authority leaked: {forbidden}");
    }
    // No automation.
    for forbidden in ["thread::spawn", "interval", "timer", "schedule", "on_publish"] {
        assert!(!code.contains(forbidden), "automation leaked: {forbidden}");
    }
}

impl ReclamationPlan {
    fn candidates_are_empty(&self) -> bool {
        !self
            .decisions
            .iter()
            .any(|d| matches!(d.decision, Decision::Candidate { .. }))
    }
}

/// M10 P1 §21B — the additive `verifier_blocker` is DIAGNOSTIC ONLY: the
/// destructive retention decision is identical whether or not a canonical
/// verifier blocker is present.
///
/// Compared as whole plans, so no field of the destructive output — candidacy,
/// exclusion, protection, the floor, the remedy hint or the CAS reference
/// evidence — can differ on the strength of a diagnostic string.
#[test]
fn a_verifier_blocker_cannot_change_any_retention_decision() {
    let with_blocker = |name: &str, reason: IndeterminateReason| ClassifiedOccupant {
        path: format!("archive/packages/{name}"),
        name: name.to_string(),
        class: OccupantClass::Indeterminate {
            reason,
            verifier_blocker: Some("generation-destination-corrupt"),
        },
    };

    let damaged = [
        ("chat_x.gaa.h2ochat", IndeterminateReason::Corrupt),
        ("chat_y.gbb.h2ochat", IndeterminateReason::IdentityMismatch),
        ("stray.txt", IndeterminateReason::NotAPackageName),
        ("chat_z.gcc.h2ochat", IndeterminateReason::Unreadable),
        ("chat_w.gdd.h2ochat", IndeterminateReason::Partial),
        ("chat_v.gee.h2ochat", IndeterminateReason::UnexpectedOutcome),
    ];

    let mut bare = five_generations("chat_a");
    let mut blocked = five_generations("chat_a");
    for (name, reason) in damaged {
        bare.push(indeterminate(name, reason.clone()));
        blocked.push(with_blocker(name, reason));
    }
    bare.push(reserved(".h2o-archive.lock"));
    blocked.push(reserved(".h2o-archive.lock"));

    let projections = verdicts(&[("chat_a", &hash(5))]);
    let probe = db(vec![], vec![]);
    let bare_plan = run(&scan(bare), &probe, projections.clone());
    let blocked_plan = run(&scan(blocked), &probe, projections);

    assert_eq!(
        bare_plan, blocked_plan,
        "the destructive plan must not observe the diagnostic blocker at all"
    );

    /* And the decision source never reads the field. */
    let plan_src = include_str!("../archive_retention_plan.rs");
    assert!(
        !plan_src.contains("verifier_blocker"),
        "retention must not name the diagnostic blocker field"
    );
}
