//! M10 P1 — READ-ONLY Saved-Chat archive integrity exposure.
//!
//! This module implements NO integrity authority of its own. It is a projection
//! seam: it asks the already-accepted trusted chain what it currently observes
//! in the canonical archive and shapes that into one stable wire envelope.
//!
//! It ORCHESTRATES exactly three existing authorities:
//!
//! * `archive_durable_write::archive_root` — the canonical archive root. The
//!   renderer supplies no path of any kind;
//! * `archive_package_scan::scan_packages_within` — enumeration, verification
//!   and classification (which itself delegates to the publisher's verifier);
//! * `saved_chat_generation_policy::production_policy` — the immutable-per-build
//!   live generation family.
//!
//! What it deliberately does NOT do:
//!
//! * no verification algorithm, no hash derivation, no second verifier pass —
//!   the scan is performed once and only projected;
//! * no retention, reclamation, quarantine, delete, repair, restore, relink or
//!   import authority, and no composition with that destructive stack;
//! * no aggregate health verdict. There is no `status`, no `ok`, and no
//!   GOOD/WARNING/BAD. Rust reports FACTS; interpreting them into an operator
//!   verdict remains the renderer's job until a later authorized phase moves
//!   it. Emitting a verdict here would create a third integrity authority.
//! * no persistent state — no database table, no cache, no index, no current
//!   pointer, and nothing written anywhere.
//!
//! Determinism is load-bearing: the envelope carries no wall clock, no
//! `generatedAt`, no elapsed time and no random identifier, and occupant order
//! is the scanner's own canonical name sort. Two invocations over identical
//! on-disk state are byte-identical.

use crate::archive_package_scan::{
    ClassifiedOccupant, ConstructionFamily, IndeterminateReason, OccupantClass, OrderFact,
    PackageScan, VerifiedPackage,
};
use crate::saved_chat_generation_policy::LiveGenerationFamily;

/// Envelope identity, so later phases can version what they consume.
pub const INTEGRITY_SCHEMA: &str = "h2o.savedChatArchiveIntegrity";
pub const INTEGRITY_SCHEMA_VERSION: u32 = 1;

pub mod codes {
    /// The canonical archive root could not be derived. This is the ONLY
    /// condition that denies an envelope: without a root there is nothing to
    /// report on. Every observable archive defect is reported INSIDE the
    /// envelope instead.
    pub const ARCHIVE_ROOT_UNAVAILABLE: &str = "integrity-archive-root-unavailable";
}

/// Canonical occupant class labels. Deliberately the same kebab-case strings
/// the trusted `OccupantClass` already serializes, so the projection cannot
/// invent a second vocabulary for the same classification.
mod class_labels {
    pub const VERIFIED_GENERATION: &str = "verified-generation";
    pub const LEGACY_PACKAGE: &str = "legacy-package";
    pub const RESERVED_INFRASTRUCTURE: &str = "reserved-infrastructure";
    pub const INDETERMINATE: &str = "indeterminate";
}

/// One piece of package-verification evidence.
///
/// `code` is the GRANULAR `saved_chat_package_verify` rule code — which trusted
/// verification rule failed — carried VERBATIM and never renamed, collapsed or
/// re-derived. The coarse admission classification is deliberately NOT repeated
/// here: `class` and `reason` already carry it, so the two vocabularies stay
/// complementary instead of redundant.
///
/// `member` is deliberately absent in P1: deriving it would mean parsing package
/// internals or duplicating verification logic, and a correct canonical code is
/// worth more than decorative context.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityBlocker {
    pub code: String,
}

/// Per-reason population of the indeterminate class.
///
/// Every variant of the canonical `IndeterminateReason` is represented, so a
/// reason can never go uncounted. `unexpectedOutcome` is included because it is
/// a REAL current canonical reason, not because a contract sketch named it.
#[derive(serde::Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndeterminateByReason {
    pub not_a_package_name: u64,
    pub partial: u64,
    pub corrupt: u64,
    pub unreadable: u64,
    pub identity_mismatch: u64,
    pub unexpected_outcome: u64,
}

impl IndeterminateByReason {
    fn count(&mut self, reason: &IndeterminateReason) {
        match reason {
            IndeterminateReason::NotAPackageName => self.not_a_package_name += 1,
            IndeterminateReason::Partial => self.partial += 1,
            IndeterminateReason::Corrupt => self.corrupt += 1,
            IndeterminateReason::Unreadable => self.unreadable += 1,
            IndeterminateReason::IdentityMismatch => self.identity_mismatch += 1,
            IndeterminateReason::UnexpectedOutcome => self.unexpected_outcome += 1,
        }
    }
}

/// Construction-family population across BOTH verified generations and legacy
/// packages: the family is what the publisher's version-triple gate proved, and
/// that fact is independent of which name the package is stored under.
#[derive(serde::Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ByConstructionFamily {
    pub v1: u64,
    pub v2: u64,
    pub v3: u64,
}

/// Physical snapshot encoding population WITHIN the v3 family. V1/V2 have no
/// encoding choice, so counting them here would imply one exists.
#[derive(serde::Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct V3ByEncoding {
    pub identity: u64,
    pub gzip: u64,
}

/// Populations the scan actually OBSERVED.
///
/// Named `observed`, never `total`: when `complete` is false these are a
/// truthful account of what was seen, and nothing more. The contract must make
/// it impossible to read them as guaranteed whole-archive totals.
#[derive(serde::Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ObservedPopulations {
    pub occupants: u64,
    pub verified_generations: u64,
    pub legacy_packages: u64,
    pub reserved_infrastructure: u64,
    pub indeterminate: u64,
    pub indeterminate_by_reason: IndeterminateByReason,
    pub by_construction_family: ByConstructionFamily,
    pub v3_by_encoding: V3ByEncoding,
}

/// A projected occupant. Deliberately NOT `VerifiedPackage` itself: that type
/// exists to serve trusted internal consumers, and re-exporting it wholesale
/// would let any future field reach the renderer without a decision.
///
/// Carries identity and structural evidence only — never snapshot bytes,
/// messages, titles, chat bodies, asset payloads or host absolute paths. The
/// `path` is archive-relative, exactly as the scanner produced it.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityOccupant {
    /// Archive-relative identity, e.g. `archive/packages/<name>`.
    pub path: String,
    pub name: String,
    pub class: &'static str,

    // ---- verified / legacy package facts ----
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    /// The verifier-established snapshot identity. Present only where a trusted
    /// `VerifiedPackage` exists; an indeterminate occupant never fabricates one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    /// RECOMPUTED by the publisher's verifier from the stored bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub construction_family: Option<ConstructionFamily>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_physical_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_physical_byte_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_snapshot_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_snapshot_byte_length: Option<u64>,
    /// Present only when T1.5 proved the package orderable. A package can
    /// verify perfectly and still be unorderable; no synthetic time is ever
    /// substituted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orderable: Option<bool>,
    /// Package-side CAS references, exactly as the trusted verifier's manifest
    /// already established them: normalized, sorted and deduplicated by
    /// `archive_package_scan`. Projected, never re-read and never re-hashed, and
    /// deliberately carrying only the SHAs — no path, extension or MIME type.
    ///
    /// Present only where a trusted `VerifiedPackage` exists. An indeterminate
    /// occupant never fabricates one: an empty list there would falsely read as
    /// "references no assets".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_shas: Option<Vec<String>>,

    // ---- indeterminate facts ----
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<IndeterminateReason>,

    /// PACKAGE-VERIFICATION evidence for THIS occupant. Never the archive-level
    /// enumeration blockers, which live at the envelope root. Empty when the
    /// classification is scanner-owned and no canonical verifier blocker
    /// exists — an empty list means "no verifier blocker", never "unknown".
    pub blockers: Vec<IntegrityBlocker>,
}

/// The read-only integrity envelope.
///
/// `complete` is mandatory and is the archive ENUMERATION layer: false means
/// the package namespace was not enumerated end to end, so `observed` is a
/// partial account. Every trustworthy occupant is still returned in that case —
/// partial evidence is useful evidence.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveIntegrityResult {
    pub schema: &'static str,
    pub schema_version: u32,

    /// True only when the namespace was enumerated end to end.
    pub complete: bool,
    /// ARCHIVE-LEVEL enumeration/completeness blockers. Distinct in both name
    /// and nesting from the per-occupant verification blockers.
    pub blockers: Vec<String>,

    pub observed: ObservedPopulations,

    /// The immutable-per-build production family, from the canonical policy —
    /// never inferred from what happens to be on disk. `FormatStale` is NOT
    /// derived here: that classification remains M06's authority.
    pub live_generation_family: LiveGenerationFamily,

    pub occupants: Vec<IntegrityOccupant>,
}

fn package_occupant(
    occupant: &ClassifiedOccupant,
    package: &VerifiedPackage,
    class: &'static str,
) -> IntegrityOccupant {
    let (saved_at, orderable) = match &package.order {
        OrderFact::Orderable { saved_at } => (Some(saved_at.clone()), Some(true)),
        OrderFact::Unorderable { .. } => (None, Some(false)),
    };
    IntegrityOccupant {
        path: occupant.path.clone(),
        name: occupant.name.clone(),
        class,
        chat_id: Some(package.chat_id.clone()),
        snapshot_id: Some(package.snapshot_id.clone()),
        content_hash: Some(package.content_hash.clone()),
        construction_family: Some(package.construction_family),
        snapshot_encoding: Some(package.snapshot_encoding.clone()),
        snapshot_physical_sha256: Some(package.snapshot_physical_sha256.clone()),
        snapshot_physical_byte_length: Some(package.snapshot_physical_byte_length),
        logical_snapshot_sha256: Some(package.logical_snapshot_sha256.clone()),
        logical_snapshot_byte_length: Some(package.logical_snapshot_byte_length),
        saved_at,
        orderable,
        // Already normalized/sorted/deduplicated upstream; no second ordering
        // rule is invented here.
        asset_shas: Some(package.asset_shas.clone()),
        reason: None,
        blockers: Vec::new(),
    }
}

fn bare_occupant(occupant: &ClassifiedOccupant, class: &'static str) -> IntegrityOccupant {
    IntegrityOccupant {
        path: occupant.path.clone(),
        name: occupant.name.clone(),
        class,
        chat_id: None,
        snapshot_id: None,
        content_hash: None,
        construction_family: None,
        snapshot_encoding: None,
        snapshot_physical_sha256: None,
        snapshot_physical_byte_length: None,
        logical_snapshot_sha256: None,
        logical_snapshot_byte_length: None,
        saved_at: None,
        orderable: None,
        asset_shas: None,
        reason: None,
        blockers: Vec::new(),
    }
}

/// The projection seam: everything the command does once the trusted scan and
/// the build policy are in hand. Separated so behaviour is provable against
/// disposable fixtures without a Tauri app.
///
/// The policy is a PARAMETER rather than a global read, matching the existing
/// `policy_for` seam, so a V1V2 rollback is provable without mutable state.
pub fn integrity_from_scan(
    scan: &PackageScan,
    live_generation_family: LiveGenerationFamily,
) -> ArchiveIntegrityResult {
    let mut observed = ObservedPopulations::default();
    let mut occupants = Vec::with_capacity(scan.occupants.len());

    for occupant in &scan.occupants {
        observed.occupants += 1;
        let projected = match &occupant.class {
            OccupantClass::VerifiedGeneration(package) => {
                observed.verified_generations += 1;
                count_package(&mut observed, package);
                package_occupant(occupant, package, class_labels::VERIFIED_GENERATION)
            }
            OccupantClass::LegacyPackage(package) => {
                observed.legacy_packages += 1;
                count_package(&mut observed, package);
                package_occupant(occupant, package, class_labels::LEGACY_PACKAGE)
            }
            OccupantClass::ReservedInfrastructure => {
                observed.reserved_infrastructure += 1;
                bare_occupant(occupant, class_labels::RESERVED_INFRASTRUCTURE)
            }
            OccupantClass::Indeterminate {
                reason,
                verifier_blocker,
            } => {
                observed.indeterminate += 1;
                observed.indeterminate_by_reason.count(reason);
                let mut projected = bare_occupant(occupant, class_labels::INDETERMINATE);
                projected.reason = Some(reason.clone());
                // At most one, because the verifier is fail-fast. Empty when no
                // rule-level verifier blocker exists — a scanner-owned
                // classification, or a filesystem/admission failure that never
                // reached the package verifier. No "primary" blocker is chosen
                // and none is fabricated.
                projected.blockers = verifier_blocker
                    .map(|code| {
                        vec![IntegrityBlocker {
                            code: code.to_string(),
                        }]
                    })
                    .unwrap_or_default();
                projected
            }
        };
        occupants.push(projected);
    }

    ArchiveIntegrityResult {
        schema: INTEGRITY_SCHEMA,
        schema_version: INTEGRITY_SCHEMA_VERSION,
        complete: scan.complete,
        blockers: scan.blockers.clone(),
        observed,
        live_generation_family,
        // The scanner already sorted by canonical occupant name, so filesystem
        // enumeration order cannot leak into the result and no re-sort is
        // needed here.
        occupants,
    }
}

fn count_package(observed: &mut ObservedPopulations, package: &VerifiedPackage) {
    match package.construction_family {
        ConstructionFamily::V1 => observed.by_construction_family.v1 += 1,
        ConstructionFamily::V2 => observed.by_construction_family.v2 += 1,
        ConstructionFamily::V3 => {
            observed.by_construction_family.v3 += 1;
            match package.snapshot_encoding.as_str() {
                "gzip" => observed.v3_by_encoding.gzip += 1,
                _ => observed.v3_by_encoding.identity += 1,
            }
        }
    }
}

/// READ-ONLY Saved-Chat archive integrity.
///
/// The renderer supplies nothing at all: the canonical archive root is derived
/// internally by trusted native code. There is intentionally no paired setter
/// and no mutation partner.
///
/// `Err` means NO trustworthy envelope could be formed. Observable archive
/// defects — corrupt, partial, unreadable, identity-mismatched or non-package
/// occupants, and incomplete enumeration — are successful diagnostic RESULTS
/// inside the envelope, never invocation exceptions.
#[tauri::command]
pub async fn h2o_saved_chat_archive_integrity(
    app: tauri::AppHandle,
) -> Result<ArchiveIntegrityResult, String> {
    let root = crate::archive_durable_write::archive_root(&app)
        .map_err(|_| codes::ARCHIVE_ROOT_UNAVAILABLE.to_string())?;
    let scan = crate::archive_package_scan::scan_packages_within(&root);
    Ok(integrity_from_scan(
        &scan,
        crate::saved_chat_generation_policy::production_policy().live_generation_family,
    ))
}

#[cfg(test)]
mod tests;
