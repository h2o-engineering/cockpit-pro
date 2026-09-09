use super::*;
use crate::archive_cas_scan::CasInventory;
use crate::archive_db_probe::{DbProbeCounts, DbProbeResult, GenerationProtection, ProtectionSource};
use crate::archive_generation_order::UnorderableReason;
use crate::archive_package_scan::{
    ClassifiedOccupant, ConstructionFamily, IndeterminateReason, OccupantClass, OrderFact,
    PackageScan, VerifiedPackage,
};
use crate::archive_retention_plan::{Decision, ProtectionReason, RETENTION_FLOOR_K};

fn hash(tag: u8) -> String {
    format!("{:02x}{}", tag, "0".repeat(62))
}
fn day(n: u32) -> String {
    format!("2026-01-{n:02}T00:00:00.000Z")
}

fn gen_in(chat: &str, tag: u8, family: ConstructionFamily) -> ClassifiedOccupant {
    let h = hash(tag);
    ClassifiedOccupant {
        path: format!("archive/packages/{chat}.g{h}.h2ochat"),
        name: format!("{chat}.g{h}.h2ochat"),
        class: OccupantClass::VerifiedGeneration(VerifiedPackage {
            chat_id: chat.to_string(),
            snapshot_id: "snap-fixture".to_string(),
            content_hash: h,
            construction_family: family,
            snapshot_encoding: "identity".into(),
            snapshot_physical_sha256: String::new(),
            snapshot_physical_byte_length: 0,
            logical_snapshot_sha256: String::new(),
            logical_snapshot_byte_length: 0,
            order: OrderFact::Orderable { saved_at: day(tag as u32) },
            asset_shas: vec![],
            persistent_members: vec![],
        }),
    }
}
fn gen(chat: &str, tag: u8) -> ClassifiedOccupant {
    gen_in(chat, tag, ConstructionFamily::V3)
}

fn five(chat: &str) -> Vec<ClassifiedOccupant> {
    (1u8..=5).map(|t| gen(chat, t)).collect()
}

fn scan(occupants: Vec<ClassifiedOccupant>) -> PackageScan {
    PackageScan { complete: true, blockers: vec![], occupants }
}
fn db(protections: Vec<GenerationProtection>, roots: Vec<String>) -> DbProbeResult {
    DbProbeResult {
        complete: true,
        blockers: vec![],
        cas_roots: roots,
        generation_protections: protections,
        counts: DbProbeCounts::default(),
    }
}
fn cas(observed: Vec<String>) -> CasInventory {
    CasInventory { complete: true, observed, foreign: vec![], blockers: vec![] }
}

fn request(pairs: &[(&str, &str, &str)]) -> PreviewRequest {
    PreviewRequest {
        chat_scope: None,
        projections: pairs
            .iter()
            .map(|(chat, status, h)| ProjectionInput {
                chat_id: chat.to_string(),
                status: status.to_string(),
                content_hash: h.to_string(),
            })
            .collect(),
    }
}

fn run(s: &PackageScan, d: &DbProbeResult, c: &CasInventory, r: &PreviewRequest) -> PreviewResult {
    preview_from_parts(s, d, c, r).expect("preview envelope")
}

fn candidates(p: &PreviewResult) -> Vec<&str> {
    p.plan
        .decisions
        .iter()
        .filter(|d| matches!(d.decision, Decision::Candidate { .. }))
        .map(|d| d.name.as_str())
        .collect()
}

fn reasons(p: &PreviewResult, name: &str) -> Vec<ProtectionReason> {
    match &p.plan.decisions.iter().find(|d| d.name == name).expect("decision").decision {
        Decision::Protected { reasons } => reasons.clone(),
        other => panic!("{name}: expected protected, got {other:?}"),
    }
}

/// (D)(S)(L) happy path: the Preview carries T2.2's result exactly, under a
/// stable schema identity, with K=3 preserved.
#[test]
fn a_witnessed_preview_carries_the_engine_result_exactly() {
    let s = scan(five("chat_a"));
    let d = db(vec![], vec![]);
    let c = cas(vec![]);
    let p = run(&s, &d, &c, &request(&[("chat_a", "ok", &hash(5))]));

    assert_eq!(p.schema, PREVIEW_SCHEMA);
    assert_eq!(p.schema_version, PREVIEW_SCHEMA_VERSION);
    assert_eq!(p.schema, "h2o.m06.reclamationPreview");
    assert_eq!(p.plan.retention_floor, RETENTION_FLOOR_K);
    assert_eq!(p.plan.retention_floor, 3);
    assert!(p.plan.complete, "{:?}", p.plan.blockers);
    assert!(p.sources.package_scan_complete && p.sources.db_probe_complete);

    // Newest three protected; the two beyond the floor are candidates.
    assert_eq!(candidates(&p).len(), 2);
    assert!(reasons(&p, &format!("chat_a.g{}.h2ochat", hash(5)))
        .contains(&ProtectionReason::NewestOverall));
    assert!(reasons(&p, &format!("chat_a.g{}.h2ochat", hash(3)))
        .contains(&ProtectionReason::RetentionFloor));
}

/// (E)(F)(R) the witness rule survives the command layer, and renderer evidence
/// is enabling-only: less information can never mean more candidates.
#[test]
fn projection_evidence_stays_enabling_only_through_the_command() {
    let s = scan(five("chat_a"));
    let d = db(vec![], vec![]);
    let c = cas(vec![]);

    let witnessed = run(&s, &d, &c, &request(&[("chat_a", "ok", &hash(5))]));
    let informed: std::collections::BTreeSet<&str> = candidates(&witnessed).into_iter().collect();
    assert_eq!(informed.len(), 2, "the informed control must actually prune");

    // (E) status=ok, valid 64-hex, matching NO on-disk generation.
    let unwitnessed = run(&s, &d, &c, &request(&[("chat_a", "ok", &hash(99))]));
    assert!(candidates(&unwitnessed).is_empty(), "an unwitnessed hash prunes nothing");
    assert!(reasons(&unwitnessed, &format!("chat_a.g{}.h2ochat", hash(1)))
        .contains(&ProtectionReason::ProjectionUnwitnessed));

    // (F) missing / failed / malformed verdicts.
    for req in [
        PreviewRequest::default(),
        request(&[("chat_a", "indeterminate", "")]),
        request(&[("chat_a", "ok", "")]),
        request(&[("chat_a", "ok", "not-a-hash")]),
        request(&[("chat_a", "failed", &hash(5))]),
    ] {
        let p = run(&s, &d, &c, &req);
        let set: std::collections::BTreeSet<&str> = candidates(&p).into_iter().collect();
        assert!(set.is_empty(), "{req:?} must not create candidates");
        // (R) monotonic: less-informed is a subset of more-informed.
        assert!(set.is_subset(&informed));
    }
}

/// (B) the request is bounded, and an over-bound payload is REFUSED rather than
/// truncated. Duplicates are refused so no payload ordering can change results.
#[test]
fn the_request_is_bounded_and_refuses_rather_than_truncating() {
    let s = scan(five("chat_a"));
    let d = db(vec![], vec![]);
    let c = cas(vec![]);

    // At the bound: accepted.
    let at_bound = PreviewRequest {
        chat_scope: None,
        projections: (0..MAX_PREVIEW_INPUTS)
            .map(|i| ProjectionInput {
                chat_id: format!("chat_{i}"),
                status: "indeterminate".into(),
                content_hash: String::new(),
            })
            .collect(),
    };
    assert!(preview_from_parts(&s, &d, &c, &at_bound).is_ok());

    // One over: refused, and NOT silently truncated.
    let over = PreviewRequest {
        chat_scope: None,
        projections: (0..MAX_PREVIEW_INPUTS + 1)
            .map(|i| ProjectionInput {
                chat_id: format!("chat_{i}"),
                status: "indeterminate".into(),
                content_hash: String::new(),
            })
            .collect(),
    };
    assert_eq!(
        preview_from_parts(&s, &d, &c, &over).err().as_deref(),
        Some(codes::REQUEST_TOO_LARGE)
    );

    // An over-bound SCOPE is equally refused.
    let over_scope = PreviewRequest {
        chat_scope: Some((0..MAX_PREVIEW_INPUTS + 1).map(|i| format!("c{i}")).collect()),
        projections: vec![],
    };
    assert_eq!(
        preview_from_parts(&s, &d, &c, &over_scope).err().as_deref(),
        Some(codes::REQUEST_TOO_LARGE)
    );

    // Duplicates and empty identities are refused, not order-dependently merged.
    let dup = request(&[("chat_a", "ok", &hash(5)), ("chat_a", "indeterminate", "")]);
    assert_eq!(
        preview_from_parts(&s, &d, &c, &dup).err().as_deref(),
        Some(codes::DUPLICATE_CHAT)
    );
    let dup_scope = PreviewRequest {
        chat_scope: Some(vec!["chat_a".into(), "chat_a".into()]),
        projections: vec![],
    };
    assert_eq!(
        preview_from_parts(&s, &d, &c, &dup_scope).err().as_deref(),
        Some(codes::DUPLICATE_CHAT)
    );
    let empty = request(&[("   ", "ok", &hash(5))]);
    assert_eq!(
        preview_from_parts(&s, &d, &c, &empty).err().as_deref(),
        Some(codes::EMPTY_CHAT_ID)
    );
}

/// (C) the request type cannot express a filesystem path, a floor, or a
/// destructive flag. Structural, so it cannot regress silently.
#[test]
fn the_request_contract_admits_no_path_floor_or_force() {
    let source = include_str!("../archive_reclamation_preview.rs");
    let start = source.find("pub struct PreviewRequest").expect("request type");
    let end = source[start..].find("\n}").unwrap() + start;
    let contract = &source[start..end];
    assert!(contract.contains("chat_scope") && contract.contains("projections"));
    for forbidden in [
        "path", "root", "dir", "target", "db", "database", "retention", "floor",
        "k:", "force", "confirm", "delete", "reclaim", "execute", "destructive",
        "classification", "candidate",
    ] {
        assert!(
            !contract.to_ascii_lowercase().contains(forbidden),
            "the request must not carry {forbidden}"
        );
    }
}

/// (G)(H)(I)(Q) each trusted source fails closed independently, is reported
/// separately, and is never converted into authoritative emptiness.
#[test]
fn incomplete_trusted_sources_fail_closed_and_stay_visible() {
    let base = five("chat_a");
    let req = request(&[("chat_a", "ok", &hash(5))]);

    // (G) package scan incomplete.
    let mut s = scan(base.clone());
    s.complete = false;
    s.blockers.push("package-scan-packages-unreadable".into());
    let p = run(&s, &db(vec![], vec![]), &cas(vec![]), &req);
    assert!(!p.sources.package_scan_complete);
    assert!(!p.plan.complete);
    assert!(candidates(&p).is_empty(), "no authoritative candidates");
    assert!(!p.plan.blockers.is_empty(), "blockers must remain visible");
    assert!(p.sources.package_scan_blockers.contains(&"package-scan-packages-unreadable".to_string()));

    // (H) DB probe incomplete.
    let mut d = db(vec![], vec![]);
    d.complete = false;
    d.blockers.push("db-probe-query-failed:chats".into());
    let p = run(&scan(base.clone()), &d, &cas(vec![]), &req);
    assert!(!p.sources.db_probe_complete);
    assert!(!p.plan.complete);
    assert!(candidates(&p).is_empty());

    // (I) CAS inventory incomplete — CAS analysis is non-authoritative, but the
    // GENERATION plan is untouched, exactly as T2.2 defines.
    let mut c = cas(vec!["dd".repeat(32)]);
    c.complete = false;
    c.blockers.push("cas-scan-shard-unreadable".into());
    let p = run(&scan(base), &db(vec![], vec![]), &c, &req);
    assert!(!p.sources.cas_inventory_complete);
    assert!(!p.plan.cas.complete, "CAS analysis is not authoritative");
    assert!(p.plan.complete, "the generation plan must NOT be erased by CAS incompleteness");
    assert_eq!(candidates(&p).len(), 2, "generation candidates survive");
}

/// (J)(K) every protection semantic survives the command layer intact.
#[test]
fn the_preview_carries_every_protection_reason() {
    let mut occupants = five("chat_a");
    // Legacy.
    occupants.push(ClassifiedOccupant {
        path: "archive/packages/chat_a.h2ochat".into(),
        name: "chat_a.h2ochat".into(),
        class: OccupantClass::LegacyPackage(VerifiedPackage {
            chat_id: "chat_a".into(),
            snapshot_id: "snap-fixture".to_string(),
            content_hash: hash(70),
            construction_family: ConstructionFamily::V1,
            snapshot_encoding: "identity".into(),
            snapshot_physical_sha256: String::new(),
            snapshot_physical_byte_length: 0,
            logical_snapshot_sha256: String::new(),
            logical_snapshot_byte_length: 0,
            order: OrderFact::Orderable { saved_at: day(1) },
            asset_shas: vec![],
            persistent_members: vec![],
        }),
    });
    // Unorderable.
    occupants.push(ClassifiedOccupant {
        path: format!("archive/packages/chat_a.g{}.h2ochat", hash(60)),
        name: format!("chat_a.g{}.h2ochat", hash(60)),
        class: OccupantClass::VerifiedGeneration(VerifiedPackage {
            chat_id: "chat_a".into(),
            snapshot_id: "snap-fixture".to_string(),
            content_hash: hash(60),
            construction_family: ConstructionFamily::V1,
            snapshot_encoding: "identity".into(),
            snapshot_physical_sha256: String::new(),
            snapshot_physical_byte_length: 0,
            logical_snapshot_sha256: String::new(),
            logical_snapshot_byte_length: 0,
            order: OrderFact::Unorderable { reason: UnorderableReason::SavedAtMissing },
            asset_shas: vec![],
            persistent_members: vec![],
        }),
    });
    // Format-stale (non-live family).
    occupants.push(gen_in("chat_a", 61, ConstructionFamily::V1));
    // Indeterminate.
    occupants.push(ClassifiedOccupant {
        path: "archive/packages/broken.h2ochat".into(),
        name: "broken.h2ochat".into(),
        class: OccupantClass::Indeterminate {
            reason: IndeterminateReason::Corrupt,
            verifier_blocker: None,
        },
    });

    // All four trusted DB protection classes, on the two otherwise-candidate ones.
    let d = db(
        vec![
            GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(1), source: ProtectionSource::StrandedWriting },
            GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(1), source: ProtectionSource::Import },
            GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(2), source: ProtectionSource::Restore },
            GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(2), source: ProtectionSource::Relink },
        ],
        vec![],
    );
    let p = run(&scan(occupants), &d, &cas(vec![]), &request(&[("chat_a", "ok", &hash(5))]));

    assert!(reasons(&p, "chat_a.h2ochat").contains(&ProtectionReason::Legacy));
    assert!(reasons(&p, &format!("chat_a.g{}.h2ochat", hash(60)))
        .contains(&ProtectionReason::Unorderable));
    assert!(reasons(&p, &format!("chat_a.g{}.h2ochat", hash(61)))
        .contains(&ProtectionReason::FormatStale));
    let r1 = reasons(&p, &format!("chat_a.g{}.h2ochat", hash(1)));
    assert!(r1.contains(&ProtectionReason::StrandedWriting) && r1.contains(&ProtectionReason::ImportProvenance));
    let r2 = reasons(&p, &format!("chat_a.g{}.h2ochat", hash(2)));
    assert!(r2.contains(&ProtectionReason::RestoreProvenance) && r2.contains(&ProtectionReason::RelinkProvenance));
    assert!(matches!(
        p.plan.decisions.iter().find(|d| d.name == "broken.h2ochat").unwrap().decision,
        Decision::Excluded { .. }
    ));
    assert!(candidates(&p).is_empty(), "everything is protected here");
}

/// (M)(N) determinism and idempotence — the foundation G2's gate builds on.
#[test]
fn repeated_previews_over_identical_state_are_byte_identical() {
    let mut occupants = five("chat_a");
    occupants.extend(five("chat_b"));
    occupants.push(gen_in("chat_a", 61, ConstructionFamily::V3));
    let s = scan(occupants.clone());
    let d = db(
        vec![GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(1), source: ProtectionSource::Import }],
        vec!["cc".repeat(32), "bb".repeat(32)],
    );
    let c = cas(vec!["dd".repeat(32), "bb".repeat(32)]);
    let req = request(&[("chat_a", "ok", &hash(5)), ("chat_b", "ok", &hash(5))]);

    // (N) idempotence: two calls, same state.
    let first = serde_json::to_string(&run(&s, &d, &c, &req)).unwrap();
    let second = serde_json::to_string(&run(&s, &d, &c, &req)).unwrap();
    assert_eq!(first, second, "Preview must be idempotent");

    // (M) determinism: reversed occupant, protection, root and request order.
    let mut rev_occ = occupants;
    rev_occ.reverse();
    let mut rev_roots = vec!["cc".repeat(32), "bb".repeat(32)];
    rev_roots.reverse();
    let rev_req = request(&[("chat_b", "ok", &hash(5)), ("chat_a", "ok", &hash(5))]);
    let permuted = serde_json::to_string(&run(
        &scan(rev_occ),
        &db(
            vec![GenerationProtection { chat_id: "chat_a".into(), content_hash: hash(1), source: ProtectionSource::Import }],
            rev_roots,
        ),
        &cas(vec!["bb".repeat(32), "dd".repeat(32)]),
        &rev_req,
    ))
    .unwrap();
    assert_eq!(first, permuted, "input order must not change the Preview");

    // No volatile authority anywhere in the envelope.
    for volatile in ["generatedAt", "generated_at", "timestamp", "uuid", "nonce", "20 26-"] {
        assert!(!first.contains(volatile), "volatile field leaked: {volatile}");
    }
}

/// (P) a complete empty archive is a complete deterministic empty plan.
#[test]
fn an_empty_archive_previews_as_complete_and_empty() {
    let p = run(&scan(vec![]), &db(vec![], vec![]), &cas(vec![]), &PreviewRequest::default());
    assert!(p.plan.complete && p.plan.blockers.is_empty());
    assert!(p.plan.decisions.is_empty());
    assert_eq!(p.plan.totals.candidates, 0);
    assert!(p.plan.cas.complete);
    assert!(p.sources.package_scan_complete && p.sources.db_probe_complete && p.sources.cas_inventory_complete);
}

/// (A)(V)(U) registration, and the absence of every destructive surface.
#[test]
fn only_a_read_only_preview_command_is_registered() {
    let lib = include_str!("../lib.rs");
    // (A) registered in BOTH invoke-handler arms.
    assert_eq!(
        lib.matches("archive_reclamation_preview::h2o_archive_reclamation_preview").count(),
        2,
        "Preview must be registered in every invoke-handler arm"
    );
    // No destructive M06 command is registered anywhere.
    for forbidden in [
        "h2o_archive_reclaim", "h2o_archive_execute", "h2o_archive_delete",
        "h2o_archive_purge", "h2o_archive_quarantine", "h2o_archive_prune",
        "h2o_archive_cas_collect", "h2o_archive_receipt",
    ] {
        assert!(!lib.contains(forbidden), "{forbidden} must not exist");
    }

    // (V)(U) the command module owns no destructive or persisting authority.
    let code: String = include_str!("../archive_reclamation_preview.rs")
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(code.contains("pub async fn h2o_archive_reclamation_preview"));
    for forbidden in [
        "remove_file", "remove_dir", "unlinkat", "renameat", "std::fs::rename",
        "create_dir", "File::create", "write(", "std::fs::write", "OpenOptions",
        "quarantine", "purge", "prune", "receipt", "Receipt",
        "SqliteConnection", "connect", "migration", "INSERT", "UPDATE", "DELETE",
        "SystemTime", "Instant::now", "mtime", "uuid", "random",
    ] {
        assert!(!code.contains(forbidden), "forbidden surface in the command: {forbidden}");
    }
    // (12) no authority is reimplemented here.
    for forbidden in ["Sha256", "Digest::", "sha256_hex", "verify_occupant", "validate_manifest", "OffsetDateTime", "read_entry_names"] {
        assert!(!code.contains(forbidden), "second authority leaked: {forbidden}");
    }
    // It orchestrates the committed authorities instead.
    for required in [
        "archive_package_scan::scan_packages_within",
        "archive_cas_scan::scan_cas_within",
        "archive_db_probe::probe_protection_facts",
        "archive_retention_plan",
    ] {
        assert!(code.contains(required), "must reuse {required}");
    }
    // One canonical root authority feeds both scans.
    assert_eq!(code.matches("archive_durable_write::archive_root").count(), 1);
}

// ── M06 P4 T4.1 — the trusted occupant-remedy display contract ─────────────

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

/// The serialized hint for one occupant name, straight out of the Preview
/// envelope the renderer actually receives.
fn remedy_hint(occupants: Vec<ClassifiedOccupant>, name: &str) -> Option<serde_json::Value> {
    let preview = preview_from_parts(
        &scan(occupants),
        &db(vec![], vec![]),
        &cas(vec![]),
        &request(&[]),
    )
    .expect("an envelope");
    let value = serde_json::to_value(&preview).expect("serializes");
    let row = value["plan"]["decisions"]
        .as_array()
        .expect("decisions")
        .iter()
        .find(|d| d["name"] == name)
        .unwrap_or_else(|| panic!("row {name} is present"))
        .clone();
    row.get("occupant_remedy").cloned()
}

/// (1)(2)(3)(4) every governed remedy state on a GENERATION path carries the
/// hint, with the chat identity the canonical parser proved.
#[test]
fn every_governed_remedy_state_on_a_generation_path_carries_the_hint() {
    let name = format!("chat_a.g{}.h2ochat", hash(9));
    for reason in [
        IndeterminateReason::Corrupt,
        IndeterminateReason::Partial,
        IndeterminateReason::Unreadable,
        IndeterminateReason::IdentityMismatch,
    ] {
        let hint = remedy_hint(vec![indeterminate(&name, reason.clone())], &name)
            .unwrap_or_else(|| panic!("{reason:?} must carry the hint"));
        assert_eq!(
            hint,
            serde_json::json!({ "chat_id": "chat_a" }),
            "{reason:?} must carry ONLY the trusted chat identity"
        );
    }
}

/// (5)(6)(7)(9) every other state is offered nothing, and the field is OMITTED
/// rather than sent as null — so no other row's payload changed at all.
#[test]
fn no_other_occupant_state_receives_the_remedy_hint() {
    let cases: Vec<(&str, ClassifiedOccupant)> = vec![
        // (5) a damaged LEGACY package classifies identically to a damaged
        //     generation, and must still be offered nothing.
        ("legacy-corrupt", indeterminate("chat_leg.h2ochat", IndeterminateReason::Corrupt)),
        ("legacy-partial", indeterminate("chat_leg.h2ochat", IndeterminateReason::Partial)),
        ("legacy-unreadable", indeterminate("chat_leg.h2ochat", IndeterminateReason::Unreadable)),
        // (6) a foreign name.
        ("foreign", indeterminate("notes.txt", IndeterminateReason::NotAPackageName)),
        ("foreign-dir", indeterminate("random-dir", IndeterminateReason::NotAPackageName)),
        // (9) a state this scan does not model: fail closed.
        (
            "unexpected",
            indeterminate(&format!("chat_a.g{}.h2ochat", hash(9)), IndeterminateReason::UnexpectedOutcome),
        ),
        // NotAPackageName can never legitimately pair with a generation name,
        // but if it ever did the reason alone must still refuse it.
        (
            "generation-not-a-package-name",
            indeterminate(&format!("chat_a.g{}.h2ochat", hash(9)), IndeterminateReason::NotAPackageName),
        ),
        // (7) reserved infrastructure and residue.
        ("reserved", reserved(".h2o-genstage-aa01")),
        ("residue-temp", reserved(".h2o-durable-1-0.tmp")),
        ("reclaim-root", reserved(".h2o-reclaim")),
    ];
    for (label, occupant) in cases {
        let name = occupant.name.clone();
        assert_eq!(
            remedy_hint(vec![occupant], &name),
            None,
            "[{label}] must receive no remedy hint, and the field must be omitted"
        );
    }
}

/// (8) a VerifiedGeneration produces no remedy hint on any of its rows —
/// candidate, protected or out-of-scope alike.
#[test]
fn a_verified_generation_never_carries_a_remedy_hint() {
    let preview = preview_from_parts(
        &scan(five("chat_a")),
        &db(vec![], vec![]),
        &cas(vec![]),
        &request(&[("chat_a", "ok", &hash(5))]),
    )
    .expect("an envelope");
    let value = serde_json::to_value(&preview).unwrap();
    let decisions = value["plan"]["decisions"].as_array().unwrap();
    assert!(decisions.len() >= 5, "the fixture really produced rows");
    let mut saw_candidate = false;
    for row in decisions {
        assert!(
            row.get("occupant_remedy").is_none(),
            "a verified generation row carried a hint: {row}"
        );
        if row["decision"] == "candidate" {
            saw_candidate = true;
        }
    }
    assert!(saw_candidate, "anti-vacuity: the fixture really produced a candidate");

    // Out-of-scope rows are verified packages too, and equally never offered.
    let scoped = PreviewRequest {
        chat_scope: Some(vec!["chat_other".to_string()]),
        projections: vec![],
    };
    let value = serde_json::to_value(
        &preview_from_parts(&scan(five("chat_a")), &db(vec![], vec![]), &cas(vec![]), &scoped)
            .expect("an envelope"),
    )
    .unwrap();
    let decisions = value["plan"]["decisions"].as_array().unwrap();
    assert!(decisions.iter().any(|d| d["reason"] == "out-of-scope"), "anti-vacuity");
    assert!(decisions.iter().all(|d| d.get("occupant_remedy").is_none()));
}

/// (10) the hint identity comes ONLY from the canonical basename parser, never
/// from a manifest or snapshot — which for this occupant class are damaged,
/// unreadable, or actively disagree with the name.
#[test]
fn the_hint_identity_comes_from_the_canonical_basename_never_the_content() {
    /* An IdentityMismatch occupant VERIFIES: its manifest names one chat while
       the basename names another. The hint must follow the BASENAME. */
    let stored_as = format!("chat_named_by_filename.g{}.h2ochat", hash(7));
    let hint = remedy_hint(
        vec![indeterminate(&stored_as, IndeterminateReason::IdentityMismatch)],
        &stored_as,
    )
    .expect("the hint is present");
    assert_eq!(hint["chat_id"], "chat_named_by_filename");

    /* A chat id containing `.g` cannot shadow the generation marker: the
       canonical parser splits at the LAST one, and the hint inherits that. */
    let tricky = format!("chat.g_weird.g{}.h2ochat", hash(3));
    let hint = remedy_hint(vec![indeterminate(&tricky, IndeterminateReason::Corrupt)], &tricky)
        .expect("the hint is present");
    assert_eq!(hint["chat_id"], "chat.g_weird", "the canonical parser decides, not a naive split");

    /* And the row's own chat_id/content_hash stay empty for this class, so the
       hint is the ONLY identity a renderer could use. */
    let preview = preview_from_parts(
        &scan(vec![indeterminate(&tricky, IndeterminateReason::Corrupt)]),
        &db(vec![], vec![]),
        &cas(vec![]),
        &request(&[]),
    )
    .unwrap();
    let value = serde_json::to_value(&preview).unwrap();
    let row = &value["plan"]["decisions"][0];
    assert_eq!(row["chat_id"], "");
    assert_eq!(row["content_hash"], "");
    assert_eq!(row["decision"], "excluded");
    assert_eq!(row["reason"], "indeterminate");
}

/// The hint is DISPLAY metadata: it carries an identity and nothing else.
#[test]
fn the_remedy_hint_carries_no_authority_beyond_identity() {
    let name = format!("chat_a.g{}.h2ochat", hash(9));
    let hint = remedy_hint(vec![indeterminate(&name, IndeterminateReason::Corrupt)], &name).unwrap();
    let keys: Vec<&String> = hint.as_object().unwrap().keys().collect();
    assert_eq!(keys, vec!["chat_id"], "exactly one field");
    let raw = hint.to_string();
    for forbidden in [
        "path", "run", "force", "candidate", "plan", "quarantine", "sha256",
        "classification", "reason", "destination",
    ] {
        assert!(!raw.contains(forbidden), "the hint must not carry {forbidden}");
    }
    /* And the eligibility rule has ONE owner, shared with the destructive path. */
    let plan_src = include_str!("../archive_retention_plan.rs");
    assert!(plan_src.contains("reason.is_occupant_remedy_class()"));
    let occupant_src = include_str!("../archive_occupant_quarantine.rs");
    assert!(occupant_src.contains("reason.is_occupant_remedy_class()"));
    for src in [plan_src, occupant_src] {
        assert!(
            !src.contains("IndeterminateReason::Corrupt\n        | IndeterminateReason::Partial"),
            "the four-state rule must not be restated outside its owner"
        );
    }
}
