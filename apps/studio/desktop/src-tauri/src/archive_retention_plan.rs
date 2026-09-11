//! M06 T2.2 — READ-ONLY retention computation and plan model.
//!
//! Answers: *given trusted package facts, trusted protection roots, and
//! bounded enabling-only renderer evidence, which generations are protected,
//! which are read-only candidates, and why?*
//!
//! Pure and deterministic. It performs no I/O of any kind: no filesystem, no
//! database, no clock, no command. It mutates nothing and executes nothing —
//! producing a candidate record is a statement about eligibility, never an
//! instruction, and physical reclamation remains gated behind G02.
//!
//! Every authority is borrowed, never re-implemented:
//!
//! * package verification and classification — T2.1 `archive_package_scan`;
//! * ordering and `savedAt` semantics — T1.5 `archive_generation_order`;
//! * DB protection roots — T1.4 `archive_db_probe`;
//! * the current projection — the RENDERER's authoritative verdict, never a
//!   second Rust projection or contentHash implementation (§P).
//!
//! Protection is monotonic (§F, AC-M06-07). Renderer input is enabling-only:
//! it may narrow scope or supply the positive proof candidacy requires, and
//! its absence, failure or corruption can only protect or exclude. Losing
//! renderer information can never grow the candidate set.

use std::collections::{BTreeMap, BTreeSet};

use crate::archive_cas_scan::CasInventory;
use crate::archive_db_probe::{DbProbeResult, ProtectionSource};
use crate::archive_package_scan::{ConstructionFamily, OccupantClass, OrderFact, PackageScan};
use crate::saved_chat_generation_policy::{
    production_live_generation_family, LiveGenerationFamily,
};

/// `DP-M06-RETENTION-FLOOR` — APPROVED 2026-08-28, default `K = 3`.
pub const RETENTION_FLOOR_K: usize = 3;

/// Internal plan shape identity, so T2.3 can version what it exposes.
pub const PLAN_SCHEMA: &str = "h2o.m06.reclamationPlan";
pub const PLAN_SCHEMA_VERSION: u32 = 1;

pub mod codes {
    /// The trusted package scan did not enumerate the whole namespace.
    pub const SCAN_INCOMPLETE: &str = "plan-package-scan-incomplete";
    /// The trusted DB probe could not establish the full protection set.
    pub const DB_INCOMPLETE: &str = "plan-db-probe-incomplete";
    /// `K = 0` is invalid per the accepted decision.
    pub const INVALID_FLOOR: &str = "plan-retention-floor-invalid";
    /// A scoped chat has no authoritative projection verdict.
    pub const PROJECTION_UNAVAILABLE: &str = "plan-projection-unavailable";
    /// Package-side CAS reference evidence is incomplete.
    pub const CAS_REFERENCES_INCOMPLETE: &str = "plan-cas-references-incomplete";
    /// The canonical CAS body inventory was not complete.
    pub const CAS_INVENTORY_INCOMPLETE: &str = "plan-cas-inventory-incomplete";
}

/// The renderer's per-chat current-projection verdict — the ONLY renderer input
/// this engine consumes besides scope, and the smallest contract T2.3 can
/// populate later.
///
/// Mirrors the shipped verdict exactly: the renderer treats a projection as
/// authoritative only when `status === 'ok'` AND a contentHash is present, and
/// only an authoritative projection may expose a hash. Every other state —
/// indeterminate, failed, absent, or `ok` without a usable hash — collapses to
/// `Unavailable`, which fails the chat closed (§F).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectionVerdict {
    Authoritative { content_hash: String },
    Unavailable,
}

impl ProjectionVerdict {
    /// Builds the verdict from the renderer's raw fields, applying the same
    /// rule the renderer applies. A malformed hash is NOT authoritative.
    pub fn from_renderer(status: &str, content_hash: &str) -> Self {
        if status.trim() != "ok" {
            return ProjectionVerdict::Unavailable;
        }
        match crate::archive_durable_write::normalize_expected_sha(content_hash) {
            Some(hex) => ProjectionVerdict::Authoritative { content_hash: hex },
            None => ProjectionVerdict::Unavailable,
        }
    }
}

/// Why a generation is protected. Every applicable reason is retained: keeping
/// them all is what makes a preview auditable.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ProtectionReason {
    /// Grandfathered `<chatId>.h2ochat` (§L). Never a candidate.
    Legacy,
    /// Verified, but T1.5 could not order it. Never treated as oldest.
    Unorderable,
    /// The newest verified orderable generation for this chat.
    NewestOverall,
    /// Within the newest `K` of its same-family orderable set.
    RetentionFloor,
    /// Its contentHash equals the current authoritative projection.
    CurrentProjection,
    /// Trusted `status='writing'` publication intent.
    StrandedWriting,
    ImportProvenance,
    RestoreProvenance,
    RelinkProvenance,
    /// No authoritative projection verdict for this chat (§F fail-closed).
    ProjectionUnavailable,
    /// A syntactically valid projection hash that matches NO verified on-disk
    /// generation for this chat. The renderer's claim has no trusted witness,
    /// so it cannot be used to declare anything content-obsolete.
    ProjectionUnwitnessed,
    /// A VALID generation from a construction family the live writer does not
    /// produce. Format-stale is protected, and is NEVER content-obsolete (§L).
    FormatStale,
}

/// Why an occupant took no part in generation retention at all.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ExclusionReason {
    /// Reserved trusted infrastructure; residue accounting is T1.3's.
    ReservedInfrastructure,
    /// Not safely classifiable. "Cannot prove valid" is never "safe to remove".
    Indeterminate,
    /// Outside the caller's requested chat scope.
    OutOfScope,
}

/// The positive evidence candidacy required. Absence of protection is never
/// enough on its own: every field here had to be affirmatively established.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct CandidateEvidence {
    /// The authoritative projection hash this generation was compared against.
    pub current_projection_content_hash: String,
    /// Proven different from the current projection, hence content-obsolete.
    /// Never inferred from age, format, filename or timestamps.
    pub content_obsolete: bool,
    /// Rank within its same-family orderable set, newest first, 0-based.
    pub family_rank: usize,
    /// The floor it had to fall outside of.
    pub retention_floor: usize,
    /// Its ordering key, for a human-readable preview.
    pub saved_at: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "decision", rename_all = "kebab-case")]
pub enum Decision {
    Protected { reasons: Vec<ProtectionReason> },
    Candidate { evidence: CandidateEvidence },
    Excluded { reason: ExclusionReason },
}

/// DISPLAY-ONLY evidence that a row is the governed operator-remedy occupant
/// class, carrying the one identity the New UI needs to address it.
///
/// This is NOT destructive authority. Its presence lets an operator be OFFERED
/// the governed occupant action; it grants nothing. The command still acquires
/// exclusive ownership, proves the publisher registry empty, re-derives the
/// canonical target and re-classifies it from scratch, and refuses a target
/// that has since become VALID. A stale Preview may therefore show an action
/// the trusted command then declines, which is the correct outcome.
///
/// It exists because the Preview otherwise collapses every indeterminate
/// occupant into one row: a damaged generation, a damaged legacy package and a
/// foreign filename are indistinguishable in it. Without this the renderer
/// would have to re-derive `<chatId>.g<hex>.h2ochat` itself and become a second
/// owner of canonical package-name grammar.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct OccupantRemedyHint {
    /// The chat identity the CANONICAL basename parser proved. Never taken from
    /// a corrupt manifest or snapshot — for this occupant class neither is
    /// trustworthy, and often neither is even readable.
    pub chat_id: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct GenerationDecision {
    /// Trusted archive-relative identity. Never a renderer-supplied path.
    pub path: String,
    pub name: String,
    pub chat_id: String,
    pub content_hash: String,
    #[serde(flatten)]
    pub decision: Decision,
    /// Present ONLY on a generation-path occupant in the governed remedy class.
    /// Omitted entirely otherwise, so every other row's payload is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occupant_remedy: Option<OccupantRemedyHint>,
}

/// READ-ONLY CAS analysis. M06 removed physical CAS reclamation (§H), so this
/// deliberately reports only what is REFERENCED and whether that view is
/// complete. It emits no unreferenced set and no deletion candidates: naming
/// something collectible here would imply an authority M06 does not have.
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct CasAnalysis {
    /// True only when the CAS inventory AND every reference source were
    /// complete. `observed_unreferenced` is an authoritative orphan conclusion
    /// ONLY when this is true.
    pub complete: bool,
    /// Canonical CAS bodies actually observed on disk.
    pub observed: Vec<String>,
    /// Union of package-manifest references and both DB root tables, sorted
    /// and deduplicated.
    pub referenced: Vec<String>,
    /// Observed MINUS referenced. Deliberately ANALYTICAL: these are not
    /// deletion candidates, not collectible and not safe to delete. Physical
    /// CAS reclamation is out of M06 and no path here can remove one.
    pub observed_unreferenced: Vec<String>,
    pub incomplete_reasons: Vec<String>,
}

#[derive(serde::Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct PlanTotals {
    pub occupants: usize,
    pub protected: usize,
    pub candidates: usize,
    pub excluded: usize,
    pub chats_in_scope: usize,
    pub referenced_cas_objects: usize,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ReclamationPlan {
    pub schema: &'static str,
    pub schema_version: u32,
    /// True only when every required trusted input was complete. A plan that
    /// is not complete carries NO authoritative candidates — the candidate
    /// list is emptied rather than left to look actionable.
    pub complete: bool,
    pub retention_floor: usize,
    pub blockers: Vec<String>,
    pub decisions: Vec<GenerationDecision>,
    pub totals: PlanTotals,
    pub cas: CasAnalysis,
}

/// Everything the engine is allowed to see.
pub struct RetentionInputs<'a> {
    pub scan: &'a PackageScan,
    pub db: &'a DbProbeResult,
    /// chatId -> renderer verdict. A chat absent from this map has no
    /// authoritative projection and therefore fails closed.
    pub projections: BTreeMap<String, ProjectionVerdict>,
    /// Enabling-only chat scope. `None` means every chat.
    pub scope: Option<BTreeSet<String>>,
    /// Trusted READ-ONLY canonical CAS inventory, for orphan ANALYSIS only.
    pub cas: &'a CasInventory,
}

/// One generation being considered, after trusted verification.
struct Entry {
    path: String,
    name: String,
    chat_id: String,
    content_hash: String,
    construction_family: ConstructionFamily,
    order: OrderFact,
    legacy: bool,
}

fn protection_reason_for(source: ProtectionSource) -> ProtectionReason {
    match source {
        ProtectionSource::StrandedWriting => ProtectionReason::StrandedWriting,
        ProtectionSource::Import => ProtectionReason::ImportProvenance,
        ProtectionSource::Restore => ProtectionReason::RestoreProvenance,
        ProtectionSource::Relink => ProtectionReason::RelinkProvenance,
    }
}

/// Production entry point: bound to the approved floor.
pub fn plan(inputs: &RetentionInputs<'_>) -> ReclamationPlan {
    plan_for_live_family(inputs, production_live_generation_family())
}

/// Pure active-family seam. Production callers use [`plan`], which binds the
/// immutable Rust build policy internally; native tests may inject the other
/// admitted family without mutating process state or accepting renderer input.
pub(crate) fn plan_for_live_family(
    inputs: &RetentionInputs<'_>,
    live_family: LiveGenerationFamily,
) -> ReclamationPlan {
    // The approved constant is the only production floor. `expect` is safe by
    // construction: RETENTION_FLOOR_K is 3, and a future edit to 0 would fail
    // the invariant test rather than ship a floor-less plan.
    plan_with_floor_for_live_family(inputs, RETENTION_FLOOR_K, live_family)
        .expect("approved retention floor must satisfy K >= 1")
}

/// The pure engine. `k` is injectable for tests only; production binds the
/// approved constant above. `K = 0` is invalid per DP-M06-RETENTION-FLOOR and
/// is refused rather than silently protecting nothing.
pub fn plan_with_floor(inputs: &RetentionInputs<'_>, k: usize) -> Result<ReclamationPlan, String> {
    plan_with_floor_for_live_family(inputs, k, production_live_generation_family())
}

pub(crate) fn plan_with_floor_for_live_family(
    inputs: &RetentionInputs<'_>,
    k: usize,
    live_family: LiveGenerationFamily,
) -> Result<ReclamationPlan, String> {
    if k < 1 {
        return Err(codes::INVALID_FLOOR.to_string());
    }

    let mut blockers: Vec<String> = Vec::new();
    // Completeness of the TRUSTED inputs decides whether candidates may carry
    // authority at all. Neither can be waived by renderer evidence.
    if !inputs.scan.complete {
        blockers.push(codes::SCAN_INCOMPLETE.to_string());
    }
    if !inputs.db.complete {
        blockers.push(codes::DB_INCOMPLETE.to_string());
    }

    // Trusted protection index: (chatId, contentHash) -> reasons.
    let mut db_protections: BTreeMap<(String, String), BTreeSet<ProtectionReason>> =
        BTreeMap::new();
    for protection in &inputs.db.generation_protections {
        db_protections
            .entry((protection.chat_id.clone(), protection.content_hash.clone()))
            .or_default()
            .insert(protection_reason_for(protection.source));
    }

    // ── Collect entries, and decide exclusions that need no retention logic ──
    let mut entries: Vec<Entry> = Vec::new();
    let mut decisions: Vec<GenerationDecision> = Vec::new();
    let mut package_refs: BTreeSet<String> = BTreeSet::new();
    let mut cas_reference_evidence_incomplete = false;

    for occupant in &inputs.scan.occupants {
        match &occupant.class {
            OccupantClass::ReservedInfrastructure => decisions.push(GenerationDecision {
                path: occupant.path.clone(),
                name: occupant.name.clone(),
                chat_id: String::new(),
                content_hash: String::new(),
                decision: Decision::Excluded {
                    reason: ExclusionReason::ReservedInfrastructure,
                },
                // Reserved infrastructure is never an operator remedy target.
                occupant_remedy: None,
            }),
            // `..` is deliberate: M06 reads ONLY `reason`. The additive
            // diagnostic blocker field must never reach a destructive decision.
            OccupantClass::Indeterminate { reason, .. } => {
                // An occupant we could not classify may hold CAS references we
                // cannot see, so the reference view is no longer complete.
                cas_reference_evidence_incomplete = true;
                /* The display hint needs BOTH halves, from the two existing
                   trusted authorities: the canonical T2.1 name parser must call
                   this a generation path AND yield its chat identity, and the
                   fresh classification must be in the governed remedy class.
                   Either alone is not enough — a damaged LEGACY package
                   classifies identically, and a foreign name parses to nothing. */
                let occupant_remedy = match crate::archive_package_scan::name_shape(&occupant.name) {
                    crate::archive_package_scan::NameShape::Generation { chat_id, .. }
                        if reason.is_occupant_remedy_class() =>
                    {
                        Some(OccupantRemedyHint { chat_id })
                    }
                    _ => None,
                };
                decisions.push(GenerationDecision {
                    path: occupant.path.clone(),
                    name: occupant.name.clone(),
                    chat_id: String::new(),
                    content_hash: String::new(),
                    decision: Decision::Excluded {
                        reason: ExclusionReason::Indeterminate,
                    },
                    occupant_remedy,
                });
            }
            OccupantClass::LegacyPackage(pkg) | OccupantClass::VerifiedGeneration(pkg) => {
                // A legacy manifest still protects the CAS identities it names.
                package_refs.extend(pkg.asset_shas.iter().cloned());
                entries.push(Entry {
                    path: occupant.path.clone(),
                    name: occupant.name.clone(),
                    chat_id: pkg.chat_id.clone(),
                    content_hash: pkg.content_hash.clone(),
                    construction_family: pkg.construction_family,
                    order: pkg.order.clone(),
                    legacy: matches!(occupant.class, OccupantClass::LegacyPackage(_)),
                });
            }
        }
    }

    // ── Scope is enabling-only: it may narrow which chats are analysed, and
    //    nothing else. It can never suppress a protection that applies to a
    //    generation still inside the scope.
    let in_scope = |chat_id: &str| match &inputs.scope {
        None => true,
        Some(scope) => scope.contains(chat_id),
    };

    let mut chats: BTreeSet<String> = BTreeSet::new();
    for entry in &entries {
        if in_scope(&entry.chat_id) {
            chats.insert(entry.chat_id.clone());
        }
    }

    // ── Per-chat retention ──────────────────────────────────────────────────
    for entry in &entries {
        if !in_scope(&entry.chat_id) {
            decisions.push(GenerationDecision {
                path: entry.path.clone(),
                name: entry.name.clone(),
                chat_id: entry.chat_id.clone(),
                content_hash: entry.content_hash.clone(),
                // A VERIFIED package out of scope: never a remedy target.
                occupant_remedy: None,
                decision: Decision::Excluded {
                    reason: ExclusionReason::OutOfScope,
                },
            });
            continue;
        }

        let mut reasons: BTreeSet<ProtectionReason> = BTreeSet::new();

        // Trusted DB roots apply regardless of scope, projection or ordering.
        if let Some(found) =
            db_protections.get(&(entry.chat_id.clone(), entry.content_hash.clone()))
        {
            reasons.extend(found.iter().copied());
        }
        if entry.legacy {
            reasons.insert(ProtectionReason::Legacy);
        }

        let saved_at = match &entry.order {
            OrderFact::Unorderable { .. } => {
                // Independently protected, and never counted as "oldest".
                reasons.insert(ProtectionReason::Unorderable);
                None
            }
            OrderFact::Orderable { saved_at } => Some(saved_at.clone()),
        };

        // Newest-overall and the same-family floor are computed against the
        // chat's ORDERABLE, non-legacy generations, ordered by T1.5.
        let ordered_all = ordered_generations(&entries, &entry.chat_id, None);
        let ordered_family =
            ordered_generations(&entries, &entry.chat_id, Some(entry.construction_family));
        let rank_all = ordered_all.iter().position(|h| *h == entry.content_hash);
        let rank_family = ordered_family
            .iter()
            .position(|h| *h == entry.content_hash);

        if rank_all == Some(0) {
            reasons.insert(ProtectionReason::NewestOverall);
        }
        if let Some(rank) = rank_family {
            if rank < k {
                reasons.insert(ProtectionReason::RetentionFloor);
            }
        }

        // CORRECTION B: format-stale. A VALID generation from a family the live
        // writer does not produce is protected, and is never content-obsolete.
        if !entry
            .construction_family
            .is_live_writer_family_for(live_family)
        {
            reasons.insert(ProtectionReason::FormatStale);
        }

        // CORRECTION A: the renderer verdict is enabling-only, so a syntactically
        // valid hash is not enough. It must be WITNESSED by a verified on-disk
        // generation of the same chat carrying that trusted recomputed hash.
        //
        // Without this, the ordinary state "a current projection exists but has
        // not been materialized yet" would read as "every package hash differs,
        // therefore every old package is content-obsolete" — and pruning would
        // begin against an unproven claim.
        let verdict = match inputs.projections.get(&entry.chat_id) {
            None => ProjectionVerdict::Unavailable,
            Some(ProjectionVerdict::Unavailable) => ProjectionVerdict::Unavailable,
            Some(ProjectionVerdict::Authoritative { content_hash }) => {
                if witnessed(&entries, &entry.chat_id, content_hash) {
                    ProjectionVerdict::Authoritative {
                        content_hash: content_hash.clone(),
                    }
                } else {
                    reasons.insert(ProtectionReason::ProjectionUnwitnessed);
                    ProjectionVerdict::Unavailable
                }
            }
        };

        let decision = match (&verdict, saved_at, rank_family) {
            (ProjectionVerdict::Unavailable, _, _) => {
                // §F: no authoritative verdict means reclamation for this chat
                // fails closed. Absence NEVER creates eligibility.
                reasons.insert(ProtectionReason::ProjectionUnavailable);
                Decision::Protected {
                    reasons: reasons.into_iter().collect(),
                }
            }
            (ProjectionVerdict::Authoritative { content_hash }, Some(saved_at), Some(rank)) => {
                if *content_hash == entry.content_hash {
                    reasons.insert(ProtectionReason::CurrentProjection);
                }
                // Candidacy requires the live-writer family AND no protection.
                if reasons.is_empty()
                    && entry
                        .construction_family
                        .is_live_writer_family_for(live_family)
                {
                    Decision::Candidate {
                        evidence: CandidateEvidence {
                            current_projection_content_hash: content_hash.clone(),
                            content_obsolete: true,
                            family_rank: rank,
                            retention_floor: k,
                            saved_at,
                        },
                    }
                } else {
                    Decision::Protected {
                        reasons: reasons.into_iter().collect(),
                    }
                }
            }
            // Unorderable, legacy, or otherwise unranked: already protected
            // above, and never eligible without an ordering position.
            _ => Decision::Protected {
                reasons: reasons.into_iter().collect(),
            },
        };

        decisions.push(GenerationDecision {
            path: entry.path.clone(),
            name: entry.name.clone(),
            chat_id: entry.chat_id.clone(),
            content_hash: entry.content_hash.clone(),
            decision,
            // Verified generations and legacy packages are never remedy targets.
            occupant_remedy: None,
        });
    }

    // ── READ-ONLY CAS analysis ──────────────────────────────────────────────
    let mut referenced: BTreeSet<String> = package_refs;
    referenced.extend(inputs.db.cas_roots.iter().cloned());
    let mut cas_incomplete: Vec<String> = Vec::new();
    if cas_reference_evidence_incomplete {
        cas_incomplete.push(codes::CAS_REFERENCES_INCOMPLETE.to_string());
    }
    if !inputs.scan.complete {
        cas_incomplete.push(codes::SCAN_INCOMPLETE.to_string());
    }
    if !inputs.db.complete {
        cas_incomplete.push(codes::DB_INCOMPLETE.to_string());
    }
    if !inputs.cas.complete {
        cas_incomplete.push(codes::CAS_INVENTORY_INCOMPLETE.to_string());
    }
    cas_incomplete.sort();
    cas_incomplete.dedup();
    let observed: BTreeSet<String> = inputs.cas.observed.iter().cloned().collect();
    // Read-only ANALYSIS: observed bodies that no trusted root references. This
    // is evidence, never an instruction — M06 has no CAS removal authority, and
    // when the analysis is incomplete this set is not an orphan conclusion.
    let observed_unreferenced: Vec<String> = observed
        .iter()
        .filter(|hex| !referenced.contains(*hex))
        .cloned()
        .collect();
    let cas = CasAnalysis {
        complete: cas_incomplete.is_empty(),
        observed: observed.into_iter().collect(),
        referenced: referenced.into_iter().collect(),
        observed_unreferenced,
        incomplete_reasons: cas_incomplete,
    };

    // Deterministic order: by trusted archive-relative identity.
    decisions.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.name.cmp(&b.name)));

    // A plan whose trusted inputs were incomplete carries no candidates.
    // Downgrading them to protected is the fail-closed direction, and it keeps
    // the blockers visible instead of hidden behind an empty list.
    let complete = blockers.is_empty();
    if !complete {
        for decision in decisions.iter_mut() {
            if matches!(decision.decision, Decision::Candidate { .. }) {
                decision.decision = Decision::Protected {
                    reasons: vec![ProtectionReason::ProjectionUnavailable],
                };
            }
        }
    }

    blockers.sort();
    blockers.dedup();

    let totals = PlanTotals {
        occupants: decisions.len(),
        protected: decisions
            .iter()
            .filter(|d| matches!(d.decision, Decision::Protected { .. }))
            .count(),
        candidates: decisions
            .iter()
            .filter(|d| matches!(d.decision, Decision::Candidate { .. }))
            .count(),
        excluded: decisions
            .iter()
            .filter(|d| matches!(d.decision, Decision::Excluded { .. }))
            .count(),
        chats_in_scope: chats.len(),
        referenced_cas_objects: cas.referenced.len(),
    };

    Ok(ReclamationPlan {
        schema: PLAN_SCHEMA,
        schema_version: PLAN_SCHEMA_VERSION,
        complete,
        retention_floor: k,
        blockers,
        decisions,
        totals,
        cas,
    })
}

/// True when some VERIFIED on-disk generation for this chat carries exactly the
/// trusted recomputed hash the renderer claims is current. Legacy packages are
/// excluded: they are never generations.
fn witnessed(entries: &[Entry], chat_id: &str, content_hash: &str) -> bool {
    entries
        .iter()
        .any(|entry| entry.chat_id == chat_id && !entry.legacy && entry.content_hash == content_hash)
}

/// Content hashes of a chat's ORDERABLE, non-legacy generations, newest first,
/// ordered by T1.5 alone. `family` restricts to one construction family.
///
/// Legacy packages and unorderable generations are deliberately absent: they
/// are independently protected and must not consume a retained slot.
fn ordered_generations(
    entries: &[Entry],
    chat_id: &str,
    family: Option<ConstructionFamily>,
) -> Vec<String> {
    let facts: Vec<crate::archive_generation_order::VerifiedGenerationFacts> = entries
        .iter()
        .filter(|entry| entry.chat_id == chat_id && !entry.legacy)
        .filter(|entry| family.map(|f| entry.construction_family == f).unwrap_or(true))
        .filter_map(|entry| match &entry.order {
            OrderFact::Orderable { saved_at } => {
                Some(crate::archive_generation_order::VerifiedGenerationFacts {
                    saved_at: Some(saved_at.clone()),
                    content_hash: entry.content_hash.clone(),
                })
            }
            OrderFact::Unorderable { .. } => None,
        })
        .collect();
    crate::archive_generation_order::order(&facts)
        .orderable
        .into_iter()
        .map(|g| g.content_hash)
        .collect()
}

#[cfg(test)]
mod tests;
