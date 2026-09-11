use super::*;
use crate::archive_generation_publish::{begin, commit_with_policy, write_member, Member, Publisher};
use crate::archive_generation_order::UnorderableReason;
use crate::archive_package_scan::{scan_packages_within, OrderFact};
use crate::saved_chat_package_verify::tests::{
    gzip_zero_asset_v3, permanent_v3_fixture, zero_asset_v3, OwnedPackage,
};
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Fixtures. Synthetic scans exercise the PROJECTION; the on-disk cases below
// drive the real scanner and the real verifier, so the whole chain is proven.
// ---------------------------------------------------------------------------

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "h2o-m10-p1-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(dir.join("archive")).expect("scratch");
    dir.join("archive")
}

fn package(chat_id: &str, family: ConstructionFamily, encoding: &str, saved_at: Option<&str>) -> VerifiedPackage {
    VerifiedPackage {
        chat_id: chat_id.to_string(),
        snapshot_id: format!("snap-{chat_id}"),
        content_hash: "a".repeat(64),
        construction_family: family,
        snapshot_encoding: encoding.to_string(),
        snapshot_physical_sha256: "b".repeat(64),
        snapshot_physical_byte_length: 128,
        logical_snapshot_sha256: "c".repeat(64),
        logical_snapshot_byte_length: 256,
        order: match saved_at {
            Some(at) => OrderFact::Orderable {
                saved_at: at.to_string(),
            },
            None => OrderFact::Unorderable {
                reason: UnorderableReason::SavedAtMissing,
            },
        },
        asset_shas: vec![],
        persistent_members: vec!["manifest.json".to_string()],
    }
}

fn occupant(name: &str, class: OccupantClass) -> ClassifiedOccupant {
    ClassifiedOccupant {
        path: format!("archive/packages/{name}"),
        name: name.to_string(),
        class,
    }
}

fn scan_of(complete: bool, blockers: Vec<String>, occupants: Vec<ClassifiedOccupant>) -> PackageScan {
    PackageScan {
        complete,
        blockers,
        occupants,
    }
}

fn project(scan: &PackageScan) -> ArchiveIntegrityResult {
    integrity_from_scan(scan, LiveGenerationFamily::V3)
}

fn json(result: &ArchiveIntegrityResult) -> serde_json::Value {
    serde_json::to_value(result).expect("serialize integrity envelope")
}

fn packages_dir(root: &Path) -> PathBuf {
    root.join("packages")
}

fn content_hash_of(package: &OwnedPackage) -> String {
    serde_json::from_slice::<serde_json::Value>(&package.manifest)
        .expect("fixture manifest")
        .get("contentHash")
        .and_then(serde_json::Value::as_str)
        .expect("contentHash")
        .strip_prefix("sha256-")
        .expect("normalized hash")
        .to_string()
}

fn generation_name(package: &OwnedPackage) -> String {
    format!("{}.g{}.h2ochat", package.chat_id, content_hash_of(package))
}

/// Installs fixture bytes straight into the namespace, so a DAMAGED package can
/// exist on disk without asking the publisher to create an invalid one.
fn install_direct(root: &Path, name: &str, package: &OwnedPackage) -> PathBuf {
    let path = packages_dir(root).join(name);
    std::fs::create_dir_all(&path).expect("package directory");
    std::fs::write(path.join("manifest.json"), &package.manifest).expect("manifest");
    if let Some(snapshot) = &package.snapshot {
        std::fs::write(path.join("snapshot.json"), snapshot).expect("snapshot");
    }
    if let Some(markdown) = &package.markdown {
        std::fs::write(path.join("chat.md"), markdown).expect("markdown");
    }
    if let Some(html) = &package.html {
        std::fs::write(path.join("chat.html"), html).expect("html");
    }
    for (sha, bytes) in &package.asset_bodies {
        let asset = package
            .assets
            .iter()
            .find(|asset| &asset.sha256 == sha)
            .expect("asset descriptor");
        let target = path.join(&asset.path);
        std::fs::create_dir_all(target.parent().unwrap()).expect("asset directory");
        std::fs::write(target, bytes).expect("asset body");
    }
    // `unexpected` is an in-memory fixture field; the scanner enumerates the
    // REAL directory, so an unexpected member has to actually exist on disk.
    for name in &package.unexpected {
        std::fs::write(path.join(name), b"unexpected persistent member")
            .expect("unexpected member");
    }
    path
}

/// Publishes a REAL v3 generation through the actual publisher.
fn publish_v3(root: &Path, package: &OwnedPackage) -> String {
    package.install_cas(root);
    let publisher = Publisher::new(root.to_path_buf());
    let begun = begin(&publisher, &package.chat_id);
    assert!(begun.ok, "begin refused: {:?}", begun.blockers);
    assert!(
        write_member(
            &publisher,
            begun.token,
            Member::Snapshot,
            package.snapshot.as_deref().expect("snapshot"),
        )
        .ok
    );
    assert!(write_member(&publisher, begun.token, Member::Manifest, &package.manifest).ok);
    let published = commit_with_policy(&publisher, begun.token, None, LiveGenerationFamily::V3);
    assert!(published.ok, "commit refused: {:?}", published.blockers);
    published
        .content_hash
        .strip_prefix("sha256-")
        .expect("trusted hash")
        .to_string()
}

fn mutate_snapshot(package: &mut OwnedPackage, update: impl FnOnce(&mut serde_json::Value)) {
    let mut value: serde_json::Value =
        serde_json::from_slice(package.snapshot.as_ref().expect("snapshot")).expect("snapshot json");
    update(&mut value);
    package.snapshot = Some(serde_json::to_vec(&value).expect("serialize snapshot"));
}

/// Re-establishes the structural bindings an identity-encoded v3 package needs
/// after its snapshot bytes change, so the verifier reaches the SEMANTIC check
/// under test instead of failing earlier on a stale descriptor or hash.
fn rebind_identity_snapshot(package: &mut OwnedPackage) {
    let snapshot = package.snapshot.clone().expect("snapshot");
    let sha = format!(
        "sha256-{}",
        crate::archive_durable_write::sha256_hex(&snapshot)
    );
    let len = snapshot.len() as u64;
    let content_hash = crate::saved_chat_package_verify::derive_content_hash_v3(&sha, &[])
        .expect("v3 content hash");
    mutate_manifest(package, |m| {
        m["files"]["snapshot"]["sha256"] = sha.into();
        m["files"]["snapshot"]["byteLength"] = len.into();
        m["contentHash"] = content_hash.into();
    });
}

fn mutate_manifest(package: &mut OwnedPackage, update: impl FnOnce(&mut serde_json::Value)) {
    let mut value: serde_json::Value =
        serde_json::from_slice(&package.manifest).expect("fixture manifest");
    update(&mut value);
    package.manifest = serde_json::to_vec(&value).expect("serialize manifest");
}

fn find<'a>(result: &'a ArchiveIntegrityResult, name: &str) -> &'a IntegrityOccupant {
    result
        .occupants
        .iter()
        .find(|o| o.name == name)
        .unwrap_or_else(|| {
            panic!(
                "{name} missing from envelope: {:?}",
                result.occupants.iter().map(|o| &o.name).collect::<Vec<_>>()
            )
        })
}

// ---------------------------------------------------------------------------
// §22 — command behaviour
// ---------------------------------------------------------------------------

/// The envelope identity is pinned, and it is versioned.
#[test]
fn the_envelope_declares_a_stable_schema_and_version() {
    let value = json(&project(&scan_of(true, vec![], vec![])));
    assert_eq!(value["schema"], "h2o.savedChatArchiveIntegrity");
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(INTEGRITY_SCHEMA, "h2o.savedChatArchiveIntegrity");
    assert_eq!(INTEGRITY_SCHEMA_VERSION, 1);
}

/// An empty but fully enumerated archive is a COMPLETE result with zero
/// populations — not an error, and not an absence of evidence.
#[test]
fn an_empty_complete_archive_is_a_successful_zero_population_result() {
    let value = json(&project(&scan_of(true, vec![], vec![])));
    assert_eq!(value["complete"], true);
    assert_eq!(value["blockers"], serde_json::json!([]));
    assert_eq!(value["occupants"], serde_json::json!([]));
    assert_eq!(value["observed"]["occupants"], 0);
    assert_eq!(value["observed"]["verifiedGenerations"], 0);
    assert_eq!(value["observed"]["indeterminate"], 0);
    assert_eq!(value["observed"]["byConstructionFamily"]["v3"], 0);
    assert_eq!(value["observed"]["v3ByEncoding"]["gzip"], 0);
}

/// Every class is counted under `observed`, and each projection carries the
/// facts its class actually has.
#[test]
fn every_occupant_class_is_counted_and_projected() {
    let scan = scan_of(
        true,
        vec![],
        vec![
            occupant(
                "chat_a.gaa.h2ochat",
                OccupantClass::VerifiedGeneration(package(
                    "chat_a",
                    ConstructionFamily::V3,
                    "gzip",
                    Some("2026-01-01T00:00:00.000Z"),
                )),
            ),
            occupant(
                "chat_b.gbb.h2ochat",
                OccupantClass::VerifiedGeneration(package(
                    "chat_b",
                    ConstructionFamily::V3,
                    "identity",
                    None,
                )),
            ),
            occupant(
                "chat_c.h2ochat",
                OccupantClass::LegacyPackage(package(
                    "chat_c",
                    ConstructionFamily::V1,
                    "identity",
                    Some("2026-01-02T00:00:00.000Z"),
                )),
            ),
            occupant(
                "chat_d.h2ochat",
                OccupantClass::LegacyPackage(package(
                    "chat_d",
                    ConstructionFamily::V2,
                    "identity",
                    Some("2026-01-03T00:00:00.000Z"),
                )),
            ),
            occupant(".h2o-archive.lock", OccupantClass::ReservedInfrastructure),
            occupant(
                "stray.txt",
                OccupantClass::Indeterminate {
                    reason: IndeterminateReason::NotAPackageName,
                    verifier_blocker: None,
                },
            ),
            occupant(
                "chat_e.gee.h2ochat",
                OccupantClass::Indeterminate {
                    reason: IndeterminateReason::Corrupt,
                    verifier_blocker: Some("generation-destination-corrupt"),
                },
            ),
        ],
    );
    let result = project(&scan);
    let value = json(&result);
    let observed = &value["observed"];

    assert_eq!(observed["occupants"], 7);
    assert_eq!(observed["verifiedGenerations"], 2);
    assert_eq!(observed["legacyPackages"], 2);
    assert_eq!(observed["reservedInfrastructure"], 1);
    assert_eq!(observed["indeterminate"], 2);
    assert_eq!(observed["indeterminateByReason"]["notAPackageName"], 1);
    assert_eq!(observed["indeterminateByReason"]["corrupt"], 1);
    assert_eq!(observed["indeterminateByReason"]["partial"], 0);
    // Family population spans verified AND legacy: the family is what the
    // publisher proved, independent of the name it is stored under.
    assert_eq!(observed["byConstructionFamily"]["v1"], 1);
    assert_eq!(observed["byConstructionFamily"]["v2"], 1);
    assert_eq!(observed["byConstructionFamily"]["v3"], 2);
    // Encoding is counted WITHIN v3 only.
    assert_eq!(observed["v3ByEncoding"]["gzip"], 1);
    assert_eq!(observed["v3ByEncoding"]["identity"], 1);

    // Verified generation projection.
    let verified = find(&result, "chat_a.gaa.h2ochat");
    assert_eq!(verified.class, "verified-generation");
    assert_eq!(verified.chat_id.as_deref(), Some("chat_a"));
    assert_eq!(verified.construction_family, Some(ConstructionFamily::V3));
    assert_eq!(verified.snapshot_encoding.as_deref(), Some("gzip"));
    assert_eq!(verified.saved_at.as_deref(), Some("2026-01-01T00:00:00.000Z"));
    assert_eq!(verified.orderable, Some(true));
    assert!(verified.blockers.is_empty());
    assert!(verified.reason.is_none());

    // A verified but UNORDERABLE package carries no synthetic time.
    let unorderable = find(&result, "chat_b.gbb.h2ochat");
    assert_eq!(unorderable.orderable, Some(false));
    assert!(unorderable.saved_at.is_none());
    assert!(
        !json(&result)["occupants"][1]
            .as_object()
            .unwrap()
            .contains_key("savedAt"),
        "an absent savedAt is omitted, never nulled or invented"
    );

    // Legacy projection is a DISTINCT class, never laundered into a generation.
    let legacy = find(&result, "chat_c.h2ochat");
    assert_eq!(legacy.class, "legacy-package");
    assert_eq!(legacy.construction_family, Some(ConstructionFamily::V1));

    // Reserved infrastructure is never a package and carries no package facts.
    let reserved = find(&result, ".h2o-archive.lock");
    assert_eq!(reserved.class, "reserved-infrastructure");
    assert!(reserved.chat_id.is_none());
    assert!(reserved.content_hash.is_none());
    assert!(reserved.reason.is_none());
    assert!(reserved.blockers.is_empty());

    // Indeterminate reason + blocker projection.
    let corrupt = find(&result, "chat_e.gee.h2ochat");
    assert_eq!(corrupt.class, "indeterminate");
    assert_eq!(corrupt.reason, Some(IndeterminateReason::Corrupt));
    assert_eq!(
        corrupt.blockers,
        vec![IntegrityBlocker {
            code: "generation-destination-corrupt".to_string()
        }]
    );

    // A scanner-owned classification carries an EMPTY blocker list, which means
    // "no verifier blocker exists" — never a placeholder.
    let stray = find(&result, "stray.txt");
    assert_eq!(stray.reason, Some(IndeterminateReason::NotAPackageName));
    assert!(stray.blockers.is_empty());
}

/// Reason serialization is the canonical kebab-case vocabulary, not a second
/// taxonomy invented by the projection.
#[test]
fn indeterminate_reasons_serialize_with_the_canonical_vocabulary() {
    let scan = scan_of(
        true,
        vec![],
        vec![occupant(
            "a",
            OccupantClass::Indeterminate {
                reason: IndeterminateReason::IdentityMismatch,
                verifier_blocker: None,
            },
        )],
    );
    assert_eq!(json(&project(&scan))["occupants"][0]["reason"], "identity-mismatch");
}

/// An INCOMPLETE enumeration still returns every trustworthy occupant, and the
/// archive-level blockers are structurally distinct from the per-occupant ones.
#[test]
fn an_incomplete_scan_reports_blockers_and_still_returns_observed_evidence() {
    let scan = scan_of(
        false,
        vec!["package-scan-entry-unrepresentable".to_string()],
        vec![
            occupant(
                "chat_a.gaa.h2ochat",
                OccupantClass::VerifiedGeneration(package(
                    "chat_a",
                    ConstructionFamily::V3,
                    "identity",
                    Some("2026-01-01T00:00:00.000Z"),
                )),
            ),
            occupant(
                "chat_e.gee.h2ochat",
                OccupantClass::Indeterminate {
                    reason: IndeterminateReason::Corrupt,
                    verifier_blocker: Some("generation-destination-corrupt"),
                },
            ),
        ],
    );
    let value = json(&project(&scan));

    assert_eq!(value["complete"], false);
    assert_eq!(
        value["blockers"],
        serde_json::json!(["package-scan-entry-unrepresentable"])
    );
    // Partial evidence is still evidence: nothing was withheld.
    assert_eq!(value["observed"]["occupants"], 2);
    assert_eq!(value["occupants"].as_array().unwrap().len(), 2);

    // The two blocker layers never conflate: the archive layer is a flat list
    // of strings at the root, the occupant layer is objects nested per
    // occupant, and neither contains the other's entries.
    assert!(value["blockers"].as_array().unwrap().iter().all(|b| b.is_string()));
    let occupant_blockers = &value["occupants"][1]["blockers"];
    assert!(occupant_blockers.as_array().unwrap().iter().all(|b| b.is_object()));
    assert_eq!(occupant_blockers[0]["code"], "generation-destination-corrupt");
    assert!(!value["blockers"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("generation-destination-corrupt")));
}

/// The active family comes from the immutable build policy, never from what
/// happens to be on disk.
#[test]
fn the_live_generation_family_is_the_build_policy_not_the_observed_packages() {
    // An archive holding ONLY v1 packages still reports the policy's family.
    let scan = scan_of(
        true,
        vec![],
        vec![occupant(
            "chat_c.h2ochat",
            OccupantClass::LegacyPackage(package(
                "chat_c",
                ConstructionFamily::V1,
                "identity",
                Some("2026-01-02T00:00:00.000Z"),
            )),
        )],
    );
    assert_eq!(json(&project(&scan))["liveGenerationFamily"], "v3");

    // And the policy is a parameter, so a V1V2 rollback needs no mutable state.
    let rolled_back = integrity_from_scan(&scan, LiveGenerationFamily::V1V2);
    assert_eq!(json(&rolled_back)["liveGenerationFamily"], "v1v2");

    // The command itself reads the canonical production policy.
    assert_eq!(
        project(&scan).live_generation_family,
        crate::saved_chat_generation_policy::production_policy().live_generation_family
    );
}

/// Identical on-disk state yields byte-identical envelopes, and occupant order
/// is the scanner's canonical name sort rather than filesystem order.
#[test]
fn the_envelope_is_deterministic_and_carries_no_clock_or_identifier() {
    let root = scratch("deterministic");
    let mut names = vec![];
    for package in [zero_asset_v3(), gzip_zero_asset_v3()] {
        let hash = publish_v3(&root, &package);
        names.push(format!("{}.g{hash}.h2ochat", package.chat_id));
    }
    std::fs::write(packages_dir(&root).join("zz-stray.txt"), b"stray").expect("stray");

    let first = json(&project(&scan_packages_within(&root)));
    let second = json(&project(&scan_packages_within(&root)));
    assert_eq!(first, second, "repeated projection must be identical");

    let ordered: Vec<&str> = first["occupants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["name"].as_str().unwrap())
        .collect();
    let mut expected = ordered.clone();
    expected.sort();
    assert_eq!(ordered, expected, "occupants are sorted by canonical name");

    // No wall clock, elapsed time or random identity anywhere in the envelope.
    let raw = first.to_string();
    for forbidden in [
        "generatedAt", "generated_at", "timestamp", "elapsed", "durationMs",
        "scannedAt", "uuid", "nonce", "requestId",
    ] {
        assert!(!raw.contains(forbidden), "envelope must not carry {forbidden}");
    }
    assert!(!names.is_empty());

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// The envelope leaks neither host filesystem layout nor chat content.
#[test]
fn the_envelope_exposes_no_host_path_and_no_chat_content() {
    let root = scratch("no-leak");
    let package = zero_asset_v3();
    let hash = publish_v3(&root, &package);
    let name = format!("{}.g{hash}.h2ochat", package.chat_id);
    std::fs::write(packages_dir(&root).join("notes.txt"), b"stray").expect("stray");

    let value = json(&project(&scan_packages_within(&root)));
    let raw = value.to_string();

    // Every path is archive-relative, and the host root never appears.
    assert!(
        !raw.contains(root.to_string_lossy().as_ref()),
        "the host archive root must never appear in the envelope"
    );
    assert!(!raw.contains("/Users/"), "no absolute host path");
    assert!(!raw.contains(std::env::temp_dir().to_string_lossy().as_ref()));
    for occupant in value["occupants"].as_array().unwrap() {
        let path = occupant["path"].as_str().unwrap();
        assert!(path.starts_with("archive/packages/"), "{path} must be archive-relative");
        assert!(!path.starts_with('/'), "{path} must not be absolute");
    }

    // No chat body of any kind is projected.
    for forbidden in [
        "messages", "message", "title", "body", "markdown", "html", "snapshotBytes",
        "content\":", "assetBodies", "text\":",
    ] {
        assert!(!raw.contains(forbidden), "envelope must not carry {forbidden}");
    }
    assert!(find(&project(&scan_packages_within(&root)), &name).content_hash.is_some());

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// Rust reports FACTS. It emits no aggregate health verdict, because doing so
/// would make this a third integrity authority beside the verifier and the
/// existing JS diagnostics.
#[test]
fn rust_emits_no_aggregate_health_verdict() {
    let scan = scan_of(
        false,
        vec!["package-scan-entry-unrepresentable".to_string()],
        vec![occupant(
            "chat_e.gee.h2ochat",
            OccupantClass::Indeterminate {
                reason: IndeterminateReason::Corrupt,
                verifier_blocker: Some("generation-destination-corrupt"),
            },
        )],
    );
    let value = json(&project(&scan));
    let object = value.as_object().expect("envelope object");

    for forbidden in ["status", "ok", "health", "verdict", "severity", "grade", "level"] {
        assert!(
            !object.contains_key(forbidden),
            "the envelope must not carry an aggregate `{forbidden}`"
        );
    }
    let raw = value.to_string();
    for forbidden in ["\"GOOD\"", "\"WARNING\"", "\"BAD\"", "\"healthy\"", "\"unhealthy\""] {
        assert!(!raw.contains(forbidden), "no health taxonomy: {forbidden}");
    }

    // Populations are named `observed`, never `total`, so a partial scan cannot
    // read as a guaranteed whole-archive count.
    assert!(object.contains_key("observed"));
    assert!(!object.contains_key("total"));
    assert!(!object.contains_key("totals"));
    assert!(
        !value["observed"].as_object().unwrap().keys().any(|k| k.starts_with("total")),
        "population keys must not be named total*"
    );

    // The module implements no verification and no health taxonomy of its own.
    let src = include_str!("../saved_chat_archive_integrity.rs");
    // No verification algorithm and no hash derivation: P1 reuses the trusted
    // chain rather than becoming a third authority.
    for forbidden in [
        "sha256_hex", "derive_content_hash", "verify_package", "verify_occupant",
    ] {
        assert!(!src.contains(forbidden), "P1 must not re-implement `{forbidden}`");
    }
    // No filesystem authority of ANY kind — not even a read. The module never
    // touches `std::fs`; the scanner it delegates to owns every access.
    for forbidden in [
        "std::fs::", "OpenOptions", "remove_file", "remove_dir", "create_dir",
    ] {
        assert!(!src.contains(forbidden), "P1 must not perform `{forbidden}`");
    }
    // P1 composes ONLY the three accepted authorities. The destructive planning
    // stack is not reached at all — checked as module REFERENCES, since the
    // doc comment above names those modules precisely to disclaim them.
    for forbidden in [
        "crate::archive_retention_plan",
        "crate::archive_reclamation_preview",
        "crate::archive_reclaim_execute",
        "crate::archive_reclaim",
        "crate::archive_occupant_quarantine",
        "crate::archive_transport_handoff",
        "crate::archive_cas_scan",
        "crate::archive_db_probe",
    ] {
        assert!(
            !src.contains(forbidden),
            "P1 must not compose `{forbidden}`"
        );
    }
    for required in [
        "crate::archive_durable_write::archive_root",
        "crate::archive_package_scan::scan_packages_within",
        "crate::saved_chat_generation_policy::production_policy",
    ] {
        assert!(src.contains(required), "P1 must compose `{required}`");
    }
}

// ---------------------------------------------------------------------------
// §23 — differential P1-side coverage: the trusted command can never present a
// divergence family as healthy.
// ---------------------------------------------------------------------------

/// Each false-healthy divergence family reaches the envelope as an
/// INDETERMINATE occupant carrying the canonical verifier blocker — never as a
/// verified generation, and never counted as one.
#[test]
fn false_healthy_divergence_families_are_never_projected_as_verified() {
    // Families driven through the REAL verifier via on-disk fixtures.
    //
    // Each case pins the GRANULAR `saved_chat_package_verify` rule code it must
    // produce, so the test proves the intended rule fired AND that its code
    // reached the wire — not merely that something somewhere refused the
    // package. Every one of these collapsed to the single coarse string
    // `generation-destination-corrupt` before P1.2.
    // The expectation is `Option`, because §9's rule is precise: a granular code
    // exists ONLY when a `saved_chat_package_verify` rule refused the package.
    // Families rejected by the ADAPTER's own directory-inventory check never
    // reach that verifier, so they legitimately carry none and none is invented.
    let cases: Vec<(&str, Option<&str>, OwnedPackage)> = vec![
        (
            "v3-persistent-renderer-forbidden",
            None,
            {
                let mut p = zero_asset_v3();
                p.markdown = Some(b"must not persist".to_vec());
                p
            },
        ),
        (
            "v3-invalid-manifest-file-inventory",
            Some("generation-v3-manifest-file-inventory-invalid"),
            {
                let mut p = zero_asset_v3();
                mutate_manifest(&mut p, |m| {
                    m["files"]["chat.md"] = serde_json::json!({
                        "path": "chat.md",
                        "sha256": format!("sha256-{}", "d".repeat(64)),
                        "byteLength": 3
                    });
                });
                p
            },
        ),
        (
            "absent-chat-id",
            Some("generation-manifest-chat-id-missing"),
            {
                let mut p = zero_asset_v3();
                mutate_manifest(&mut p, |m| {
                    m["chatId"] = serde_json::Value::Null;
                });
                p
            },
        ),
        (
            "v3-legacy-content-forbidden",
            Some("generation-v3-snapshot-legacy-content-forbidden"),
            {
                let mut p = zero_asset_v3();
                mutate_snapshot(&mut p, |s| {
                    s["messages"][0]["contentText"] = "legacy rendering".into();
                });
                rebind_identity_snapshot(&mut p);
                p
            },
        ),
        (
            "v3-messages-non-array",
            Some("generation-v3-snapshot-messages-invalid"),
            {
                let mut p = zero_asset_v3();
                mutate_snapshot(&mut p, |s| {
                    s["messages"] = serde_json::json!({"not": "an array"});
                });
                rebind_identity_snapshot(&mut p);
                p
            },
        ),
        (
            "unexpected-persistent-member",
            None,
            {
                let mut p = zero_asset_v3();
                p.unexpected = vec!["surprise.bin".to_string()];
                p
            },
        ),
    ];

    for (tag, expected_code, package) in cases {
        let root = scratch(tag);
        let name = generation_name(&package);
        install_direct(&root, &name, &package);

        // The admission adapter carries both vocabularies; confirm the granular
        // one is the pinned rule and that it is genuinely more specific than the
        // coarse admission classification.
        let packages =
            crate::archive_durable_write::confined::Dir::open_existing_nofollow(&packages_dir(&root))
                .expect("packages dir");
        let (coarse, granular) =
            match crate::archive_generation_publish::verify_occupant_all_supported(
                &packages,
                name.as_bytes(),
            ) {
                Err((_, coarse, granular)) => (coarse, granular),
                Ok(_) => panic!("{tag}: this divergence family must not verify"),
            };
        assert_eq!(
            granular, expected_code,
            "{tag}: the granular verifier rule must be preserved exactly"
        );
        assert_eq!(
            coarse, "generation-destination-corrupt",
            "{tag}: the coarse admission code must be UNCHANGED"
        );
        if let Some(code) = expected_code {
            assert_ne!(
                code, coarse,
                "{tag}: the granular code must add information over the coarse one"
            );
        }

        let result = project(&scan_packages_within(&root));
        let projected = find(&result, &name);

        assert_eq!(
            projected.class, "indeterminate",
            "{tag}: a divergence family must never project as verified"
        );
        assert_eq!(
            projected.blockers,
            expected_code
                .map(|code| vec![IntegrityBlocker { code: code.to_string() }])
                .unwrap_or_default(),
            "{tag}: the granular verifier code must reach the wire verbatim"
        );
        // And the coarse admission string is never duplicated into the wire
        // blocker: `class` and `reason` already carry that classification.
        assert!(
            !projected.blockers.iter().any(|b| b.code == coarse),
            "{tag}: the coarse admission code must not appear as a blocker"
        );
        assert!(
            projected.chat_id.is_none() && projected.content_hash.is_none(),
            "{tag}: an unverified occupant must carry no proven identity"
        );
        assert_eq!(
            result.observed.verified_generations, 0,
            "{tag}: it must not be counted as a verified generation"
        );
        assert_eq!(result.observed.indeterminate, 1, "{tag}");
        assert!(
            result.observed.by_construction_family == ByConstructionFamily::default(),
            "{tag}: an unverified occupant has no proven family"
        );

        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}

/// A duplicated / padded generation name and a post-publication mutation both
/// reach the envelope as indeterminate, with the canonical blocker preserved.
#[test]
fn identity_and_mutation_divergences_reach_the_envelope_with_their_blocker() {
    let root = scratch("identity-divergence");
    let package = zero_asset_v3();
    let hash = publish_v3(&root, &package);
    let published = format!("{}.g{hash}.h2ochat", package.chat_id);

    // Post-publication snapshot mutation: the verifier refuses it.
    std::fs::write(
        packages_dir(&root).join(&published).join("snapshot.json"),
        b"{\"tampered\":true}",
    )
    .expect("mutate");

    // A padded/lying generation name over the same bytes.
    let padded = zero_asset_v3();
    let padded_name = format!("{}.g{}.h2ochat", padded.chat_id, "0".repeat(64));
    install_direct(&root, &padded_name, &padded);

    let result = project(&scan_packages_within(&root));

    let mutated = find(&result, &published);
    assert_eq!(mutated.class, "indeterminate");
    assert_eq!(mutated.reason, Some(IndeterminateReason::Corrupt));
    assert_eq!(
        mutated.blockers.len(),
        1,
        "the fail-fast verifier yields exactly one canonical blocker"
    );
    assert!(!mutated.blockers[0].code.is_empty());

    // Scanner-owned identity mismatch: the verifier accepted the bytes, so
    // there is no verifier blocker to report and none is invented.
    let lying = find(&result, &padded_name);
    assert_eq!(lying.class, "indeterminate");
    assert_eq!(lying.reason, Some(IndeterminateReason::IdentityMismatch));
    assert!(lying.blockers.is_empty());

    assert_eq!(result.observed.verified_generations, 0);
    assert_eq!(result.observed.indeterminate, 2);
    assert_eq!(result.observed.indeterminate_by_reason.corrupt, 1);
    assert_eq!(result.observed.indeterminate_by_reason.identity_mismatch, 1);

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// A genuinely healthy archive projects as verified with its trusted facts, so
/// the divergence assertions above are not vacuously true.
#[test]
fn a_healthy_v3_archive_projects_as_a_verified_generation() {
    let root = scratch("healthy");
    let package = zero_asset_v3();
    let hash = publish_v3(&root, &package);
    let name = format!("{}.g{hash}.h2ochat", package.chat_id);

    let result = project(&scan_packages_within(&root));
    let verified = find(&result, &name);

    assert_eq!(verified.class, "verified-generation");
    assert_eq!(verified.chat_id.as_deref(), Some(package.chat_id.as_str()));
    assert_eq!(verified.content_hash.as_deref(), Some(hash.as_str()));
    assert_eq!(verified.construction_family, Some(ConstructionFamily::V3));
    assert!(verified.blockers.is_empty());
    assert!(verified.reason.is_none());
    assert!(result.complete);
    assert_eq!(result.observed.verified_generations, 1);
    assert_eq!(result.observed.indeterminate, 0);
    assert_eq!(result.observed.by_construction_family.v3, 1);

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// M10 P1.2 §15 — the trusted snapshotId reaches the wire for verified and
/// legacy packages, and an indeterminate occupant never carries one.
#[test]
fn the_trusted_snapshot_id_reaches_the_envelope_and_is_never_fabricated() {
    // Synthetic projection: the DTO carries whatever the trusted package proved.
    let scan = scan_of(
        true,
        vec![],
        vec![
            occupant(
                "chat_a.gaa.h2ochat",
                OccupantClass::VerifiedGeneration(package(
                    "chat_a",
                    ConstructionFamily::V3,
                    "identity",
                    Some("2026-01-01T00:00:00.000Z"),
                )),
            ),
            occupant(
                "chat_c.h2ochat",
                OccupantClass::LegacyPackage(package(
                    "chat_c",
                    ConstructionFamily::V1,
                    "identity",
                    Some("2026-01-02T00:00:00.000Z"),
                )),
            ),
            occupant(".h2o-archive.lock", OccupantClass::ReservedInfrastructure),
            occupant(
                "chat_e.gee.h2ochat",
                OccupantClass::Indeterminate {
                    reason: IndeterminateReason::Corrupt,
                    verifier_blocker: Some("generation-v3-snapshot-messages-invalid"),
                },
            ),
        ],
    );
    let result = project(&scan);
    let value = json(&result);

    assert_eq!(value["occupants"][0]["snapshotId"], "snap-chat_a");
    assert_eq!(value["occupants"][1]["snapshotId"], "snap-chat_c");
    // Absent — omitted, never nulled and never invented.
    for index in [2, 3] {
        assert!(
            !value["occupants"][index]
                .as_object()
                .unwrap()
                .contains_key("snapshotId"),
            "occupant {index} must not carry a snapshotId"
        );
    }
    assert!(find(&result, "chat_e.gee.h2ochat").snapshot_id.is_none());
    assert!(find(&result, ".h2o-archive.lock").snapshot_id.is_none());

    // End to end through the real publisher and verifier: the fixture's own
    // snapshotId ("s0") is what reaches the wire.
    let root = scratch("snapshot-id-wire");
    let fixture = zero_asset_v3();
    let hash = publish_v3(&root, &fixture);
    let name = format!("{}.g{hash}.h2ochat", fixture.chat_id);
    let live = project(&scan_packages_within(&root));
    assert_eq!(find(&live, &name).snapshot_id.as_deref(), Some("s0"));
    assert_eq!(json(&live)["occupants"][0]["snapshotId"], "s0");

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// M10 P1.2 §16 — the granular verifier rule survives the WHOLE chain, and is
/// strictly more informative than the coarse admission code it travels beside.
///
/// verify_package(G) → admission (C, K, Some(G)) → scanner Indeterminate{R,
/// Some(G)} → envelope blockers [{code: G}], with G != K at every hop.
#[test]
fn a_granular_verifier_rule_survives_the_whole_chain_and_outranks_the_coarse_code() {
    let root = scratch("granular-chain");
    let mut package = zero_asset_v3();
    mutate_snapshot(&mut package, |s| {
        s["messages"][0]["contentText"] = "legacy rendering".into();
    });
    rebind_identity_snapshot(&mut package);
    let name = generation_name(&package);
    install_direct(&root, &name, &package);

    const GRANULAR: &str = "generation-v3-snapshot-legacy-content-forbidden";
    const COARSE: &str = "generation-destination-corrupt";

    // Hop 1-2: the admission adapter carries both vocabularies.
    let packages = crate::archive_durable_write::confined::Dir::open_existing_nofollow(
        &packages_dir(&root),
    )
    .expect("packages dir");
    let (outcome, coarse, granular) =
        match crate::archive_generation_publish::verify_occupant_all_supported(
            &packages,
            name.as_bytes(),
        ) {
            Err(failure) => failure,
            Ok(_) => panic!("the fixture must not verify"),
        };
    assert_eq!(
        outcome,
        crate::archive_generation_publish::Outcome::GenerationDestinationCorrupt
    );
    assert_eq!(coarse, COARSE, "the coarse admission code is unchanged");
    assert_eq!(granular, Some(GRANULAR));

    // Hop 3: the scanner keeps `reason` (broad) and `verifier_blocker` (granular)
    // complementary rather than redundant.
    let scan = scan_packages_within(&root);
    let classified = scan
        .occupants
        .iter()
        .find(|o| o.name == name)
        .expect("occupant scanned");
    match &classified.class {
        OccupantClass::Indeterminate {
            reason,
            verifier_blocker,
        } => {
            assert_eq!(*reason, IndeterminateReason::Corrupt);
            assert_eq!(*verifier_blocker, Some(GRANULAR));
        }
        other => panic!("expected indeterminate, got {other:?}"),
    }

    // Hop 4: the wire carries the granular rule, and never the coarse string.
    let result = project(&scan);
    let projected = find(&result, &name);
    assert_eq!(
        projected.blockers,
        vec![IntegrityBlocker {
            code: GRANULAR.to_string()
        }]
    );
    assert!(!projected.blockers.iter().any(|b| b.code == COARSE));

    // The anti-vacuity property this correction exists to guarantee.
    assert_ne!(GRANULAR, COARSE);

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}

/// M10 P3a — the trusted asset SHA set is PROJECTED where a verified package
/// exists, and never fabricated where one does not.
#[test]
fn trusted_asset_shas_are_projected_only_where_a_verified_package_exists() {
    // End to end through the real publisher and verifier: an asset-bearing v3
    // package carries exactly the SHAs its verified manifest declared.
    let root = scratch("asset-shas");
    let fixture = permanent_v3_fixture(false);
    let hash = publish_v3(&root, &fixture);
    let name = format!("{}.g{hash}.h2ochat", fixture.chat_id);
    std::fs::write(packages_dir(&root).join("stray.txt"), b"stray").expect("stray");

    let result = project(&scan_packages_within(&root));
    let projected = find(&result, &name).asset_shas.clone().expect("verified package");
    assert!(!projected.is_empty(), "the fixture declares assets");

    // Exactly the trusted scanner's own set — normalized, sorted, deduplicated.
    let scan = scan_packages_within(&root);
    let trusted = scan
        .occupants
        .iter()
        .find(|o| o.name == name)
        .map(|o| match &o.class {
            OccupantClass::VerifiedGeneration(p) | OccupantClass::LegacyPackage(p) => {
                p.asset_shas.clone()
            }
            other => panic!("expected a verified package, got {other:?}"),
        })
        .expect("occupant scanned");
    assert_eq!(projected, trusted, "projected verbatim from the trusted set");
    let mut sorted = projected.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(projected, sorted, "deterministic order preserved from source");

    // An indeterminate occupant never fabricates one: an empty list would read
    // as "references no assets", which is a claim nothing proved.
    assert_eq!(find(&result, "stray.txt").asset_shas, None);
    let value = json(&result);
    let stray = value["occupants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["name"] == "stray.txt")
        .unwrap();
    assert!(!stray.as_object().unwrap().contains_key("assetShas"), "omitted, not empty");

    // Reserved infrastructure likewise carries none.
    let reserved_scan = scan_of(
        true,
        vec![],
        vec![occupant(".h2o-archive.lock", OccupantClass::ReservedInfrastructure)],
    );
    assert_eq!(project(&reserved_scan).occupants[0].asset_shas, None);

    // The wire carries SHAs ONLY — no path, extension or MIME inflation.
    let wire = value["occupants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["name"] == name.as_str())
        .unwrap();
    let shas = wire["assetShas"].as_array().expect("assetShas array");
    assert!(shas.iter().all(|v| v.is_string()), "a flat list of strings");
    for forbidden in ["assetPaths", "assetExt", "assetMime", "assets\":"] {
        assert!(
            !value.to_string().contains(forbidden),
            "the envelope must not inflate with {forbidden}"
        );
    }

    let _ = std::fs::remove_dir_all(root.parent().unwrap());
}
