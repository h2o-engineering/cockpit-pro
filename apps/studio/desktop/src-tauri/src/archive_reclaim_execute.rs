//! M06 T3.2 — generation reclamation execution under full preflight.
//!
//! DORMANT. No `#[tauri::command]`, nothing in either invoke-handler arm, no
//! renderer route and no UI. G02 remains the activation gate.
//!
//! This module decides WHICH trusted generation to act on and in what order it
//! becomes durable. It owns no filesystem destruction of its own: the atomic
//! quarantine rename, the receipt writes and the purge all belong to
//! `archive_reclaim`.
//!
//! The defining rule is ANTI-STALE. A Preview candidate list is never execution
//! authority. Execution acquires exclusive ownership FIRST and then recomputes
//! the package scan, the DB protections, the CAS inventory and the whole T2.2
//! plan underneath it, so a generation that Analyze called a candidate may be
//! protected by the time Execute runs — and is then left alone.
//!
//! Ordering is load-bearing and deliberately conservative:
//!
//! ```text
//! validate request → exclusive → registry empty → recompute generations
//!   → recompute BOTH residue families → complete plan
//!   → run plan evidence DURABLE  ── before any canonical rename at all
//!   → generation stage, per candidate:
//!       atomic non-replacing rename out of archive/packages
//!       → namespace transition DURABLE
//!       → quarantine receipt DURABLE  ── before any purge
//!       → confined purge
//!       → purge receipt DURABLE
//!   → staging/temp stage, only if the generation stage did not fail:
//!       the same five steps per residue item
//! ```
//!
//! The first material failure stops further canonical renames IN BOTH STAGES: a
//! generation failure never lets the residue stage start, and a residue failure
//! stops the residue items after it. A crash between a successful rename and
//! its receipt leaves the item physically present in quarantine with the
//! canonical namespace already consistent, which is recoverable; a purge before
//! that receipt is durable would not be, so it never happens.
//!
//! Scope: GENERATIONS plus the two established trusted-writer residue families,
//! `.h2o-genstage-*` under `archive/packages` and `.h2o-durable-*.tmp` under
//! `archive/assets/<aa>`. Both are enumerated TRUSTED-SIDE under the held
//! exclusive ownership; the renderer's packages inventory can see the staging
//! family but is never destructive authority for it. Occupant action belongs to
//! a later task and is untouched here.
//!
//! Canonical CAS is never renamed, quarantined, purged or restored. The residue
//! stage does open one CAS shard, because durable-temp residue lives inside it,
//! but `quarantine_residue` refuses any source name that is not a reserved
//! trusted-writer component — so a `sha256-<hex>` body is unreachable through
//! that handle. Revision 2 removed destructive CAS reclamation from M06
//! entirely, and `observed_unreferenced` is evidence, never an instruction.
//!
//! Residue identity is SHAPE plus exclusive-state proof. There is no mtime,
//! ctime, birthtime, wall clock or "older than" anywhere: a trusted writer
//! cannot be running while this holds exclusive ownership with an empty
//! publisher registry, which is what makes the residue abandoned.

// DORMANT until G02: nothing in production calls this destructive authority
// yet, so the compiler correctly reports it as unused. The attribute records
// that dormancy deliberately rather than leaving build noise; it is removed
// when the activation task wires a caller.
#![allow(dead_code)]

use crate::archive_db_probe::DbProbeResult;
use crate::archive_durable_write::confined;
use crate::archive_reclaim::crash;
use crate::archive_instance_lock::ExclusiveOwnership;
use crate::archive_reclaim::{
    purge_quarantined_item, quarantine_generation, quarantine_residue, QuarantineComponent,
    QuarantineKind, QuarantineRunId, QuarantineTarget, ReceiptsDir, ReclaimRoot, RunDir,
};
use crate::archive_reclamation_preview::PreviewRequest;
use crate::archive_residue_probe::{
    ProbeLocation, ResidueFamily, TrustedResidueItem, TrustedResidueScan,
};
use crate::archive_retention_plan::{Decision, ReclamationPlan, RetentionInputs};

pub const RUN_SCHEMA: &str = "h2o.m06.reclamationRun";

/// Version 2 — T3.3 added the staging/temp stage.
///
/// This is a BUMP, not an additive extension, and deliberately so. The
/// repository's stated schema-version discipline (saved-chat-package-format,
/// "Rules") is that readers branch on the version and a reader for version N
/// rejects N+1 cleanly rather than consuming it partially. A version-1 reader
/// handed a version-2 run record would find every key it knows about present
/// and well-formed, and would silently report that no residue action occurred
/// in a run where residue WAS quarantined and purged — under-reporting
/// destructive actions is exactly what AC-M06-11 evidence completeness exists
/// to prevent. So the record announces that it is a different thing.
///
/// The bump costs nothing: `h2o.m06.reclamationRun` has no reader anywhere in
/// the repository, and the destructive core has never been activated, so no
/// version-1 run record exists in any archive.
pub const RUN_SCHEMA_VERSION: u32 = 2;

pub mod codes {
    pub const EXCLUSIVE_UNAVAILABLE: &str = "execute-exclusive-unavailable";
    pub const PUBLISHER_SESSIONS_ACTIVE: &str = "execute-publisher-sessions-active";
    pub const PLAN_NOT_AUTHORITATIVE: &str = "execute-plan-not-authoritative";
    pub const RUN_ID_UNAVAILABLE: &str = "execute-run-id-unavailable";
    pub const EVIDENCE_FAILED: &str = "execute-evidence-failed";
    pub const QUARANTINE_FAILED: &str = "execute-quarantine-failed";
    pub const QUARANTINE_COLLISION: &str = "execute-quarantine-collision";
    pub const PURGE_FAILED: &str = "execute-purge-failed";
    pub const PACKAGES_UNAVAILABLE: &str = "execute-packages-unavailable";
    pub const ARCHIVE_UNAVAILABLE: &str = "execute-archive-unavailable";
    /// T3.3: the trusted staging/temp residue enumeration could not complete.
    /// An incomplete residue authority is NEVER read as "no residue"; the whole
    /// run refuses before any canonical mutation, in either stage.
    pub const RESIDUE_NOT_AUTHORITATIVE: &str = "execute-residue-not-authoritative";
    pub const RESIDUE_QUARANTINE_FAILED: &str = "execute-residue-quarantine-failed";
    pub const RESIDUE_QUARANTINE_COLLISION: &str = "execute-residue-quarantine-collision";
    /// T3.3: a residue item carried a family/shard pairing the trusted scan
    /// cannot produce, so no quarantine identity could be derived for it.
    pub const RESIDUE_IDENTITY_INVALID: &str = "execute-residue-identity-invalid";
    pub const RESIDUE_SHARD_UNAVAILABLE: &str = "execute-residue-shard-unavailable";
    pub const RESIDUE_PURGE_FAILED: &str = "execute-residue-purge-failed";
    /// T3.5: stale quarantine from a previous run did not converge, so this run
    /// refuses to layer fresh deletions on top of an unresolved contradiction.
    pub const RECOVERY_INCOMPLETE: &str = "execute-recovery-incomplete";
    /// T4.1: the activated command's blocking task did not return a result.
    pub const EXECUTE_TASK_FAILED: &str = "execute-task-failed";
}

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RunState {
    /// Refused before ANY mutation.
    Refused,
    /// Preconditions held; the fresh plan had nothing to act on. No mutation.
    NoOp,
    /// Every recomputed candidate was quarantined and purged.
    Complete,
    /// A material failure stopped the run. Some work may have completed.
    Partial,
}

/// What actually happened to one generation. Evidence only — no chat content,
/// no absolute host path.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ActedItem {
    /// Trusted archive-relative canonical identity, from T2.1/T2.2.
    pub canonical_path: String,
    pub chat_id: String,
    pub content_hash: String,
    pub saved_at: String,
    pub quarantined: bool,
    pub purged: bool,
    pub blocker: Option<String>,
}

/// What actually happened to one residue item. Evidence only — a trusted
/// archive-relative identity and the derived quarantine identity, never chat
/// content, a renderer value or an absolute host path.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ActedResidue {
    /// Trusted archive-relative source identity, from the residue scan.
    pub archive_path: String,
    pub family: ResidueFamily,
    /// The derived, collision-safe quarantine component.
    pub quarantine_item: String,
    pub quarantined: bool,
    pub purged: bool,
    pub blocker: Option<String>,
}

/// Acted and purged counts BY FAMILY. Generation staging, durable temp and
/// capability-probe residue are different source classes with different safety
/// arguments, so a run reports them separately rather than as one residue
/// total.
#[derive(serde::Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResidueCounts {
    pub generation_staging_quarantined: usize,
    pub generation_staging_purged: usize,
    pub durable_temp_quarantined: usize,
    pub durable_temp_purged: usize,
    pub capability_probe_quarantined: usize,
    pub capability_probe_purged: usize,
}

impl ResidueCounts {
    fn record(&mut self, family: ResidueFamily, quarantined: bool, purged: bool) {
        match family {
            ResidueFamily::GenerationStaging => {
                self.generation_staging_quarantined += usize::from(quarantined);
                self.generation_staging_purged += usize::from(purged);
            }
            ResidueFamily::DurableTemp => {
                self.durable_temp_quarantined += usize::from(quarantined);
                self.durable_temp_purged += usize::from(purged);
            }
            ResidueFamily::CapabilityProbe => {
                self.capability_probe_quarantined += usize::from(quarantined);
                self.capability_probe_purged += usize::from(purged);
            }
        }
    }
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct RunOutcome {
    pub schema: &'static str,
    pub schema_version: u32,
    /// Present only once a run namespace was actually created.
    pub run_id: Option<String>,
    pub state: RunState,
    pub retention_floor: usize,
    pub blockers: Vec<String>,
    /// Deterministic: ordered by trusted canonical identity.
    pub acted: Vec<ActedItem>,
    pub quarantined: usize,
    pub purged: usize,
    /// T3.3, deterministic: ordered by family then trusted archive identity.
    pub residue_acted: Vec<ActedResidue>,
    pub residue: ResidueCounts,
    /// Name-matching entries that did NOT have the required trusted shape. They
    /// are reported, never acted on — including on a no-op run, so "nothing was
    /// reclaimable" and "nothing looked like residue" stay distinguishable.
    pub residue_indeterminate: usize,
    /// T3.5: stale quarantine entries from PREVIOUS runs this run converged.
    /// Detail lives in the recovery record on disk.
    pub recovered: usize,
}

impl RunOutcome {
    fn refused(code: &str) -> Self {
        RunOutcome {
            schema: RUN_SCHEMA,
            schema_version: RUN_SCHEMA_VERSION,
            run_id: None,
            state: RunState::Refused,
            retention_floor: crate::archive_retention_plan::RETENTION_FLOOR_K,
            blockers: vec![code.to_string()],
            acted: vec![],
            quarantined: 0,
            purged: 0,
            residue_acted: vec![],
            residue: ResidueCounts::default(),
            residue_indeterminate: 0,
            recovered: 0,
        }
    }
}

/// A trusted-side run identity.
///
/// 128 bits from the OS CSPRNG (`getentropy` on macOS, `getrandom(2)` on
/// Linux, `ProcessPrng` on Windows, through the platform-neutral facade) — the
/// same source the publisher uses for its session seed. Deliberately WITHOUT
/// that function's weak pid⊕nanos fallback: a run id must be collision
/// resistant, so entropy failure fails closed rather than degrading silently.
///
/// A run id is namespace and evidence identity ONLY. No wall clock is involved
/// and nothing derives deletion authority from its ordering. The caller cannot
/// supply one.
pub(crate) fn generate_run_id() -> Result<QuarantineRunId, String> {
    let mut buf = [0u8; 16];
    if crate::archive_durable_write::fill_entropy(&mut buf).is_err() {
        return Err(codes::RUN_ID_UNAVAILABLE.to_string());
    }
    let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    QuarantineRunId::parse(&hex).map_err(|_| codes::RUN_ID_UNAVAILABLE.to_string())
}

/// The freshly recomputed generations this run may act on, in deterministic
/// order. Derived ONLY from `Decision::Candidate` entries of a plan computed
/// under exclusive ownership.
struct FreshCandidate {
    canonical_path: String,
    name: String,
    chat_id: String,
    content_hash: String,
    saved_at: String,
}

fn fresh_candidates(plan: &ReclamationPlan) -> Vec<FreshCandidate> {
    let mut out: Vec<FreshCandidate> = plan
        .decisions
        .iter()
        .filter_map(|d| match &d.decision {
            Decision::Candidate { evidence } => Some(FreshCandidate {
                canonical_path: d.path.clone(),
                name: d.name.clone(),
                chat_id: d.chat_id.clone(),
                content_hash: d.content_hash.clone(),
                saved_at: evidence.saved_at.clone(),
            }),
            _ => None,
        })
        .collect();
    out.sort_by(|a, b| a.canonical_path.cmp(&b.canonical_path));
    out
}

/// One planned residue action: the TYPED trusted item, the evidence record it
/// will produce, and its derived quarantine identity.
///
/// The item is carried rather than an archive-relative string, so the stage
/// reads its shard and basename from validated trusted fields and never parses
/// a path back apart to find them.
struct ResidueAction<'a> {
    item: &'a TrustedResidueItem,
    planned: ActedResidue,
    target: QuarantineComponent,
}

/// The quarantine identity for one residue item.
///
/// Deterministic, separator-free, and INJECTIVE over legitimate distinct
/// sources — which a durable-temp basename alone is not. The durable writer
/// mints `.h2o-durable-<pid>-<counter>.tmp` with a process-global counter, so
/// after a pid is reused the very same basename can legitimately exist under
/// two different CAS shards. The shard is therefore part of the identity.
///
/// Injectivity comes from FIXED-WIDTH leading fields, not from the separator: a
/// family tag is one of two fixed literals and a shard is exactly two hex
/// digits, so the split points are unambiguous even though a durable-temp name
/// contains dots of its own.
///
/// ```text
/// generation staging   genstage.<staging-name>
/// durable temp         durtmp.<aa>.<temp-name>
/// ```
///
/// Both source components were already validated by the trusted scan — bounded,
/// printable ASCII, no separator, no whitespace for component parsing to trim —
/// so no encoding and no second hash authority is needed. Nothing
/// renderer-supplied reaches this, and a colliding destination would in any
/// case be refused by `RENAME_EXCL` rather than replaced.
fn residue_target_component(item: &TrustedResidueItem) -> Result<QuarantineComponent, String> {
    let tag = item.family().tag();
    let raw = match (item.family(), item.shard(), item.probe_location()) {
        (ResidueFamily::GenerationStaging, None, None) => format!("{tag}.{}", item.name()),
        (ResidueFamily::DurableTemp, Some(shard), None) => {
            format!("{tag}.{shard}.{}", item.name())
        }
        // RC-T02-02: the typed location is part of the identity, so one probe
        // name standing both at the root and under packages yields two
        // distinct, non-colliding quarantine items.
        (ResidueFamily::CapabilityProbe, None, Some(location)) => {
            format!("{tag}.{}.{}", location.tag(), item.name())
        }
        // A pairing the trusted scan cannot produce.
        _ => return Err(codes::RESIDUE_IDENTITY_INVALID.to_string()),
    };
    QuarantineComponent::parse(&raw)
}

/// The durable pre-mutation record. Written and fsynced BEFORE the first
/// canonical rename; if it cannot be persisted, nothing is renamed.
fn plan_evidence(
    run: &QuarantineRunId,
    plan: &ReclamationPlan,
    candidates: &[FreshCandidate],
    residue: &TrustedResidueScan,
    residue_actions: &[ResidueAction<'_>],
) -> Vec<u8> {
    let mut stages: Vec<&str> = vec![];
    if !candidates.is_empty() {
        stages.push("generation");
    }
    if !residue_actions.is_empty() {
        stages.push("staging-temp");
    }
    let value = serde_json::json!({
        "schema": RUN_SCHEMA,
        "schemaVersion": RUN_SCHEMA_VERSION,
        "runId": run.component(),
        "stages": stages,
        "retentionFloor": plan.retention_floor,
        "planComplete": plan.complete,
        "planBlockers": plan.blockers,
        "sources": {
            "chatsInScope": plan.totals.chats_in_scope,
            "occupants": plan.totals.occupants,
            "protected": plan.totals.protected,
            "candidates": plan.totals.candidates,
            "referencedCasObjects": plan.totals.referenced_cas_objects,
        },
        "candidates": candidates
            .iter()
            .map(|c| serde_json::json!({
                "canonicalPath": c.canonical_path,
                "chatId": c.chat_id,
                "contentHash": c.content_hash,
                "savedAt": c.saved_at,
            }))
            .collect::<Vec<_>>(),
        // The complete staging/temp action set, recorded in the SAME durable
        // pre-mutation record as the generation candidates. There is no second
        // plan format and no second run.
        "residue": {
            "sourceComplete": residue.complete,
            "sourceBlockers": residue.blockers,
            "generationStagingFound": residue.count_of(ResidueFamily::GenerationStaging),
            "durableTempFound": residue.count_of(ResidueFamily::DurableTemp),
            "capabilityProbeFound": residue.count_of(ResidueFamily::CapabilityProbe),
            "indeterminate": residue.indeterminate,
            "actions": residue_actions
                .iter()
                .map(|a| serde_json::json!({
                    "archivePath": a.planned.archive_path,
                    "family": a.planned.family,
                    "quarantineItem": a.planned.quarantine_item,
                }))
                .collect::<Vec<_>>(),
        },
    });
    serde_json::to_vec(&value).unwrap_or_default()
}

fn residue_evidence(run: &QuarantineRunId, item: &ActedResidue, action: &str) -> Vec<u8> {
    let value = serde_json::json!({
        "schema": RUN_SCHEMA,
        "schemaVersion": RUN_SCHEMA_VERSION,
        "runId": run.component(),
        "kind": "staging",
        "subtype": item.family,
        "action": action,
        "archivePath": item.archive_path,
        "quarantineItem": item.quarantine_item,
        "quarantined": item.quarantined,
        "purged": item.purged,
        "blocker": item.blocker,
    });
    serde_json::to_vec(&value).unwrap_or_default()
}

fn item_evidence(run: &QuarantineRunId, item: &ActedItem, action: &str) -> Vec<u8> {
    let value = serde_json::json!({
        "schema": RUN_SCHEMA,
        "schemaVersion": RUN_SCHEMA_VERSION,
        "runId": run.component(),
        "kind": "generation",
        "action": action,
        "canonicalPath": item.canonical_path,
        "chatId": item.chat_id,
        "contentHash": item.content_hash,
        "savedAt": item.saved_at,
        "quarantined": item.quarantined,
        "purged": item.purged,
        "blocker": item.blocker,
    });
    serde_json::to_vec(&value).unwrap_or_default()
}

/// PRODUCTION entry point.
///
/// Acquires exclusive ownership, samples the publisher registry and derives the
/// canonical archive root itself, then recomputes every trusted fact inside the
/// destructive sequence. The ONLY caller-controlled input is the same bounded
/// enabling-only request Preview accepts: no scan, no probe result, no CAS
/// inventory, no plan, no candidate list, no path and no run id can be handed
/// in.
///
/// DORMANT: no command routes here.
pub(crate) async fn execute_generation_reclamation(
    app: &tauri::AppHandle,
    request: &PreviewRequest,
) -> RunOutcome {
    use tauri::Manager;

    let archive_root = match crate::archive_durable_write::archive_root(app) {
        Ok(root) => root,
        Err(_) => return RunOutcome::refused(codes::ARCHIVE_UNAVAILABLE),
    };
    let Some(lock) = app.try_state::<crate::archive_instance_lock::ArchiveInstanceState>() else {
        return RunOutcome::refused(codes::EXCLUSIVE_UNAVAILABLE);
    };
    // NON-BLOCKING acquisition, held for the whole window below.
    let Ok(exclusive) = lock.try_acquire_exclusive() else {
        return RunOutcome::refused(codes::EXCLUSIVE_UNAVAILABLE);
    };

    // Sampled AFTER exclusive ownership, so it cannot change underneath us.
    let sessions_empty = match app.try_state::<crate::archive_generation_publish::PublisherState>() {
        Some(state) => {
            let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().map(|p| p.sessions_empty()).unwrap_or(true)
        }
        None => true,
    };

    // The DB probe is the one trusted fact that needs the app handle; it is
    // taken here, still under exclusive ownership, and handed to the private
    // sequence. No production caller outside this module can supply it.
    let db = crate::archive_db_probe::probe_protection_facts(app).await;

    let outcome = run_internal(&exclusive, &archive_root, sessions_empty, request, &db);
    let _ = exclusive.release();
    outcome
}

/// The destructive sequence. PRIVATE: production reaches it only through the
/// wrapper above, so `db` cannot be forged by a caller, and the package scan
/// and CAS inventory are recomputed HERE rather than accepted.
fn run_internal(
    exclusive: &crate::archive_instance_lock::ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
    publisher_sessions_empty: bool,
    request: &PreviewRequest,
    db: &DbProbeResult,
) -> RunOutcome {
    // Same bounded enabling-only discipline Preview uses — reused, not restated.
    let (projections, scope) =
        match crate::archive_reclamation_preview::admit_request(request) {
            Ok(parts) => parts,
            Err(code) => return RunOutcome::refused(&code),
        };

    // Hard precondition: no publication session may be in flight. Checked
    // BEFORE any recomputation so a refusal costs nothing and, critically,
    // before any namespace or evidence could be created.
    if !publisher_sessions_empty {
        return RunOutcome::refused(codes::PUBLISHER_SESSIONS_ACTIVE);
    }

    // ── Stale quarantine convergence, BEFORE this run has a namespace ────────
    // Every run visible to this pass is a PREVIOUS run by construction: the
    // fresh run id is not minted until further down, so the current run cannot
    // be seen, let alone consumed. That is what implements occupant one-run
    // dwell without any clock.
    let recovery = crate::archive_reclaim_recovery::recover_and_record(exclusive, archive_root);
    if !recovery.may_proceed() {
        // An unconverged archive is not a base for fresh destructive work.
        let mut refused = RunOutcome::refused(codes::RECOVERY_INCOMPLETE);
        refused.blockers.extend(recovery.blockers.iter().cloned());
        refused.blockers.sort();
        refused.blockers.dedup();
        refused.recovered = recovery.purged;
        return refused;
    }

    // ── RECOMPUTED HERE, under exclusive ownership ───────────────────────────
    // Not accepted from a caller: a previous Preview's scan or plan is never
    // execution authority, and a stale candidate must be able to come back
    // Protected.
    let scan = crate::archive_package_scan::scan_packages_within(archive_root);
    let cas = crate::archive_cas_scan::scan_cas_within(archive_root);

    // Recomputed UNDER exclusive ownership. The caller already gathered these
    // after acquiring it; nothing from a previous Preview is consulted.
    let plan = crate::archive_retention_plan::plan(&RetentionInputs {
        scan: &scan,
        db,
        projections,
        scope,
        cas: &cas,
    });

    // An incomplete plan is never destructive authority. This subsumes the
    // package-scan and DB-probe preconditions, which the engine already turns
    // into plan blockers.
    if !plan.complete {
        let mut refused = RunOutcome::refused(codes::PLAN_NOT_AUTHORITATIVE);
        refused.blockers.extend(plan.blockers.iter().cloned());
        refused.blockers.sort();
        refused.blockers.dedup();
        return refused;
    }

    // ── The other trusted residue authority, ALSO recomputed here ───────────
    // Under the same exclusive ownership, from the filesystem, never from the
    // renderer's packages inventory and never from a previous Preview.
    let residue = crate::archive_residue_probe::scan_trusted_residue_within(archive_root);
    if !residue.complete {
        // The conservative rule the canonical contract leaves open: an
        // incomplete residue authority is not an empty one, and it does not buy
        // an independent generation stage either. ZERO destructive mutation for
        // the whole run, refused before the run namespace even exists.
        let mut refused = RunOutcome::refused(codes::RESIDUE_NOT_AUTHORITATIVE);
        refused.blockers.extend(residue.blockers.iter().cloned());
        refused.blockers.sort();
        refused.blockers.dedup();
        refused.residue_indeterminate = residue.indeterminate.len();
        return refused;
    }

    let candidates = fresh_candidates(&plan);
    // Derived once, BEFORE plan durability, so the durable record names exactly
    // the actions the run will attempt.
    let mut residue_actions: Vec<ResidueAction<'_>> = vec![];
    for item in &residue.items {
        match residue_target_component(item) {
            Ok(target) => residue_actions.push(ResidueAction {
                item,
                planned: ActedResidue {
                    archive_path: item.archive_relative_path().to_string(),
                    family: item.family(),
                    quarantine_item: target.as_str().to_string(),
                    quarantined: false,
                    purged: false,
                    blocker: None,
                },
                target,
            }),
            Err(code) => {
                // A residue item whose identity cannot be derived is not acted
                // on, and the run does not proceed pretending it was seen.
                let mut refused = RunOutcome::refused(codes::RESIDUE_NOT_AUTHORITATIVE);
                refused.blockers.push(code);
                refused.blockers.sort();
                refused.blockers.dedup();
                refused.residue_indeterminate = residue.indeterminate.len();
                return refused;
            }
        }
    }

    if candidates.is_empty() && residue_actions.is_empty() {
        // Truthful no-op: no reclaim namespace, no run directory, no receipt.
        return RunOutcome {
            schema: RUN_SCHEMA,
            schema_version: RUN_SCHEMA_VERSION,
            run_id: None,
            state: RunState::NoOp,
            retention_floor: plan.retention_floor,
            blockers: vec![],
            acted: vec![],
            quarantined: 0,
            purged: 0,
            residue_acted: vec![],
            residue: ResidueCounts::default(),
            residue_indeterminate: residue.indeterminate.len(),
            recovered: recovery.purged,
        };
    }

    let run_id = match generate_run_id() {
        Ok(id) => id,
        Err(code) => return RunOutcome::refused(&code),
    };

    let reclaim = match crate::archive_reclaim::open_reclaim_root_for_run(exclusive, archive_root) {
        Ok(root) => root,
        Err(code) => return RunOutcome::refused(&code),
    };
    let receipts = match reclaim.receipts_dir(exclusive) {
        Ok(dir) => dir,
        Err(code) => return RunOutcome::refused(&code),
    };

    // ── Plan evidence DURABLE before the first canonical rename ──────────────
    let plan_name = match QuarantineComponent::parse(&format!("{}.plan.json", run_id.component())) {
        Ok(name) => name,
        Err(code) => return RunOutcome::refused(&code),
    };
    let plan_written = if fault::armed(fault::Point::BeforePlanDurability) {
        Err(codes::EVIDENCE_FAILED.to_string())
    } else {
        receipts.write_durable(
            exclusive,
            &plan_name,
            &plan_evidence(&run_id, &plan, &candidates, &residue, &residue_actions),
        )
    };
    if let Err(code) = plan_written {
        // Includes a receipt collision: refused BEFORE any mutation.
        let mut refused = RunOutcome::refused(codes::EVIDENCE_FAILED);
        refused.blockers.push(code);
        refused.blockers.sort();
        return refused;
    }
    trace::record(trace::Event::PlanDurable);
    crash::hit(crash::Point::AfterPlanDurableBeforeRename);
    pause::wait_if_armed();
    if fault::armed(fault::Point::AfterPlanDurableBeforeRename) {
        // The evidence is durable but the run stops before touching anything
        // canonical. Nothing has left archive/packages.
        let mut refused = RunOutcome::refused(codes::EVIDENCE_FAILED);
        refused.run_id = Some(run_id.component().to_string());
        return refused;
    }

    let run_dir = match reclaim.create_run(exclusive, &run_id) {
        Ok(dir) => dir,
        Err(code) => return RunOutcome::refused(&code),
    };
    // Opened only when something under `archive/packages` will actually be
    // addressed. A staging/temp-only run against an archive that has no
    // packages directory at all must not be refused for a descriptor it never
    // uses.
    let needs_packages = !candidates.is_empty()
        || residue_actions.iter().any(|a| {
            a.planned.family == ResidueFamily::GenerationStaging
                || (a.planned.family == ResidueFamily::CapabilityProbe
                    && a.item.probe_location() == Some(ProbeLocation::Packages))
        });
    let packages = if needs_packages {
        match crate::archive_reclaim::open_packages_dir(exclusive, archive_root) {
            Ok(dir) => Some(dir),
            Err(_) => return RunOutcome::refused(codes::PACKAGES_UNAVAILABLE),
        }
    } else {
        None
    };

    let mut outcome = RunOutcome {
        schema: RUN_SCHEMA,
        schema_version: RUN_SCHEMA_VERSION,
        run_id: Some(run_id.component().to_string()),
        state: RunState::Complete,
        retention_floor: plan.retention_floor,
        blockers: vec![],
        acted: vec![],
        quarantined: 0,
        purged: 0,
        residue_acted: vec![],
        residue: ResidueCounts::default(),
        residue_indeterminate: residue.indeterminate.len(),
        recovered: recovery.purged,
    };

    for candidate in &candidates {
        let mut acted = ActedItem {
            canonical_path: candidate.canonical_path.clone(),
            chat_id: candidate.chat_id.clone(),
            content_hash: candidate.content_hash.clone(),
            saved_at: candidate.saved_at.clone(),
            quarantined: false,
            purged: false,
            blocker: None,
        };
        // The source is derived from the TRUSTED generation identity; no caller
        // filename and no renderer input reaches this.
        let (source, item) = match (
            QuarantineComponent::parse(&candidate.name),
            QuarantineComponent::parse(&candidate.name),
        ) {
            (Ok(a), Ok(b)) => (a, b),
            _ => {
                acted.blocker = Some(codes::QUARANTINE_FAILED.to_string());
                outcome.acted.push(acted);
                outcome.state = RunState::Partial;
                break;
            }
        };

        // ── ONE bounded canonical mutation ───────────────────────────────────
        trace::record(trace::Event::FirstRename);
        let Some(packages) = packages.as_ref() else {
            // Unreachable: a non-empty candidate list implies the descriptor.
            acted.blocker = Some(codes::PACKAGES_UNAVAILABLE.to_string());
            outcome.acted.push(acted);
            outcome.blockers.push(codes::PACKAGES_UNAVAILABLE.to_string());
            outcome.state = RunState::Partial;
            break;
        };
        match quarantine_generation(exclusive, packages, &run_dir, &source, &item) {
            Ok(true) => acted.quarantined = true,
            Ok(false) => {
                acted.blocker = Some(codes::QUARANTINE_COLLISION.to_string());
                outcome.acted.push(acted);
                outcome.blockers.push(codes::QUARANTINE_COLLISION.to_string());
                outcome.state = RunState::Partial;
                break;
            }
            Err(code) => {
                acted.blocker = Some(code.clone());
                outcome.acted.push(acted);
                outcome.blockers.push(codes::QUARANTINE_FAILED.to_string());
                outcome.state = RunState::Partial;
                break;
            }
        }
        outcome.quarantined += 1;
        crash::hit(crash::Point::AfterRenameBeforeNamespaceDurable);

        // ── The namespace transition must be DURABLE before anything claims it
        //    happened, and before the item is purged. Atomic is not durable.
        let namespace_durable = if fault::armed(fault::Point::AfterRenameBeforeNamespaceDurability) {
            Err(crate::archive_reclaim::codes::QUARANTINE_NOT_DURABLE.to_string())
        } else {
            crate::archive_reclaim::durable_quarantine_transition(exclusive, packages, &run_dir)
        };
        if let Err(code) = namespace_durable {
            // The rename result is captured as observed. No purge, no later
            // candidate, no rollback: renaming it back would conceal a failure
            // whose durability we cannot vouch for either.
            acted.blocker = Some(code);
            outcome.acted.push(acted);
            outcome.blockers.push(crate::archive_reclaim::codes::QUARANTINE_NOT_DURABLE.to_string());
            outcome.state = RunState::Partial;
            break;
        }
        trace::record(trace::Event::QuarantineNamespaceDurable);
        crash::hit(crash::Point::AfterNamespaceDurableBeforeReceipt);

        // ── Quarantine receipt DURABLE before any purge ──────────────────────
        let qname = QuarantineComponent::parse(&format!(
            "{}.{}.quarantined.json",
            run_id.component(),
            candidate.content_hash
        ));
        let durable = if fault::armed(fault::Point::AfterRenameBeforeQuarantineReceipt) {
            // The exact crash window: the canonical rename SUCCEEDED and the
            // receipt for it does not become durable.
            Err(codes::EVIDENCE_FAILED.to_string())
        } else {
            match qname {
                Ok(name) => receipts.write_durable(
                    exclusive,
                    &name,
                    &item_evidence(&run_id, &acted, "quarantined"),
                ),
                Err(code) => Err(code),
            }
        };
        if let Err(code) = durable {
            // The item stays in quarantine, unpurged and recoverable.
            acted.blocker = Some(code);
            outcome.acted.push(acted);
            outcome.blockers.push(codes::EVIDENCE_FAILED.to_string());
            outcome.state = RunState::Partial;
            break;
        }
        trace::record(trace::Event::QuarantineReceiptDurable);
        crash::hit(crash::Point::AfterReceiptBeforePurge);

        // ── Same-run purge, through the T3.1 confined primitive only ─────────
        let bare_id = run_id.component().trim_start_matches("run-").to_string();
        let target = match QuarantineTarget::parse(
            &bare_id,
            item.as_str(),
            QuarantineKind::Generation,
        ) {
            Ok(target) => target,
            Err(code) => {
                acted.blocker = Some(code);
                outcome.acted.push(acted);
                outcome.state = RunState::Partial;
                break;
            }
        };
        if fault::armed(fault::Point::AfterQuarantineReceiptBeforePurge) {
            // Receipt durable, purge never attempted: the item stays contained.
            outcome.acted.push(acted);
            outcome.blockers.push(codes::PURGE_FAILED.to_string());
            outcome.state = RunState::Partial;
            break;
        }
        trace::record(trace::Event::Purge);
        let mut purge = purge_quarantined_item(exclusive, &reclaim, &target);
        if fault::armed(fault::Point::PurgeFails) {
            purge.converged = false;
            purge.blockers.push(crate::archive_reclaim::codes::PURGE_FAILED.to_string());
        }
        if purge.converged {
            acted.purged = true;
            outcome.purged += 1;
            crash::hit(crash::Point::AfterPurgeBeforePurgeReceipt);
        } else {
            // Logical deletion already happened; the canonical package is NOT
            // restored. The physical residue stays contained for recovery.
            acted.blocker = Some(codes::PURGE_FAILED.to_string());
            outcome.blockers.extend(purge.blockers.iter().cloned());
            outcome.acted.push(acted);
            outcome.blockers.push(codes::PURGE_FAILED.to_string());
            outcome.state = RunState::Partial;
            break;
        }

        let pname = QuarantineComponent::parse(&format!(
            "{}.{}.purged.json",
            run_id.component(),
            candidate.content_hash
        ));
        let durable = if fault::armed(fault::Point::AfterPurgeBeforePurgeReceipt) {
            Err(codes::EVIDENCE_FAILED.to_string())
        } else {
            match pname {
                Ok(name) => receipts.write_durable(
                    exclusive,
                    &name,
                    &item_evidence(&run_id, &acted, "purged"),
                ),
                Err(code) => Err(code),
            }
        };
        if let Err(code) = durable {
            acted.blocker = Some(code);
            outcome.acted.push(acted);
            outcome.blockers.push(codes::EVIDENCE_FAILED.to_string());
            outcome.state = RunState::Partial;
            break;
        }
        trace::record(trace::Event::PurgeReceiptDurable);
        outcome.acted.push(acted);
        crash::hit(crash::Point::BetweenGenerationItems);
    }

    // ── Stage two: staging/temp residue ─────────────────────────────────────
    // Only after the generation stage completed or had nothing to do. A
    // material generation failure means the run already met a contradiction, so
    // it does not go on to delete anything else.
    if outcome.state == RunState::Complete {
        crash::hit(crash::Point::AfterGenerationStageBeforeStaging);
        run_residue_stage(
            exclusive,
            archive_root,
            &reclaim,
            &receipts,
            &run_dir,
            &run_id,
            packages.as_ref(),
            &residue_actions,
            &mut outcome,
        );
    }

    outcome.blockers.sort();
    outcome.blockers.dedup();
    outcome
}

/// The staging/temp stage, under the SAME exclusive ownership, the same run id,
/// the same run directory, the same receipt authority, the same durability
/// barrier and the same first-material-failure policy as the generation stage
/// above. It is an additional stage of one run, not a second GC subsystem.
///
/// Per item the required order is exactly the proven one:
///
/// ```text
/// atomic non-replacing rename
///   → namespace transition DURABLE
///   → quarantine receipt DURABLE
///   → confined purge
///   → purge receipt DURABLE
/// ```
#[allow(clippy::too_many_arguments)]
fn run_residue_stage(
    exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
    reclaim: &ReclaimRoot,
    receipts: &ReceiptsDir,
    run_dir: &RunDir,
    run_id: &QuarantineRunId,
    packages: Option<&confined::Dir>,
    actions: &[ResidueAction<'_>],
    outcome: &mut RunOutcome,
) {
    let bare_id = run_id.component().trim_start_matches("run-").to_string();

    for action in actions {
        let target = &action.target;
        let mut acted = action.planned.clone();

        // The rename SOURCE, derived from the item's own trusted family and its
        // validated shard component or typed probe location. No caller path and
        // no renderer value participates, and no archive-relative string is
        // parsed back apart.
        let shard_dir = match (acted.family, action.item.shard()) {
            (ResidueFamily::DurableTemp, Some(shard)) => {
                match crate::archive_reclaim::open_cas_shard_dir(exclusive, archive_root, shard) {
                    Ok(dir) => Some(dir),
                    Err(code) => {
                        acted.blocker = Some(code);
                        outcome.residue_acted.push(acted);
                        outcome
                            .blockers
                            .push(codes::RESIDUE_SHARD_UNAVAILABLE.to_string());
                        outcome.state = RunState::Partial;
                        break;
                    }
                }
            }
            _ => None,
        };
        // RC-T02-02: probe residue leaves the admitted archive root or the
        // packages directory — the two locations the probe layer writes —
        // selected by the item's TYPED location, never by parsing its path.
        // Every other family keeps the packages directory here.
        let located = match (acted.family, action.item.probe_location()) {
            (ResidueFamily::CapabilityProbe, Some(ProbeLocation::ArchiveRoot)) => {
                Some(reclaim.archive_dir())
            }
            (ResidueFamily::CapabilityProbe, Some(ProbeLocation::Packages)) => packages,
            (ResidueFamily::CapabilityProbe, None) => None,
            _ => packages,
        };
        let source_dir = match (acted.family, shard_dir.as_ref(), located) {
            (ResidueFamily::DurableTemp, Some(dir), _) => dir,
            (ResidueFamily::GenerationStaging, _, Some(dir)) => dir,
            (ResidueFamily::CapabilityProbe, _, Some(dir)) => dir,
            _ => {
                acted.blocker = Some(codes::RESIDUE_SHARD_UNAVAILABLE.to_string());
                outcome.residue_acted.push(acted);
                outcome
                    .blockers
                    .push(codes::RESIDUE_SHARD_UNAVAILABLE.to_string());
                outcome.state = RunState::Partial;
                break;
            }
        };

        // The source name is the trusted basename the scan proved, re-validated
        // as a component. It is never composed from a path.
        let source_name = match QuarantineComponent::parse(action.item.name()) {
            Ok(name) => name,
            Err(code) => {
                acted.blocker = Some(code);
                outcome.residue_acted.push(acted);
                outcome
                    .blockers
                    .push(codes::RESIDUE_QUARANTINE_FAILED.to_string());
                outcome.state = RunState::Partial;
                break;
            }
        };

        // ── ONE bounded canonical mutation ──────────────────────────────────
        trace::record(trace::Event::ResidueRename);
        match quarantine_residue(exclusive, source_dir, run_dir, &source_name, target) {
            Ok(true) => acted.quarantined = true,
            Ok(false) => {
                acted.blocker = Some(codes::RESIDUE_QUARANTINE_COLLISION.to_string());
                outcome.residue_acted.push(acted);
                outcome
                    .blockers
                    .push(codes::RESIDUE_QUARANTINE_COLLISION.to_string());
                outcome.state = RunState::Partial;
                break;
            }
            Err(code) => {
                acted.blocker = Some(code);
                outcome.residue_acted.push(acted);
                outcome
                    .blockers
                    .push(codes::RESIDUE_QUARANTINE_FAILED.to_string());
                outcome.state = RunState::Partial;
                break;
            }
        }
        outcome.residue.record(acted.family, true, false);
        crash::hit(crash::Point::AfterResidueRenameBeforeNamespaceDurable);

        // ── Namespace transition DURABLE before any claim or purge ──────────
        // Source is whichever canonical namespace the entry left: the packages
        // directory, or the exact CAS shard.
        let namespace_durable =
            if fault::armed(fault::Point::AfterResidueRenameBeforeNamespaceDurability) {
                Err(crate::archive_reclaim::codes::QUARANTINE_NOT_DURABLE.to_string())
            } else {
                crate::archive_reclaim::durable_quarantine_transition(
                    exclusive, source_dir, run_dir,
                )
            };
        if let Err(code) = namespace_durable {
            acted.blocker = Some(code);
            outcome.residue_acted.push(acted);
            outcome
                .blockers
                .push(crate::archive_reclaim::codes::QUARANTINE_NOT_DURABLE.to_string());
            outcome.state = RunState::Partial;
            break;
        }
        trace::record(trace::Event::ResidueNamespaceDurable);
        crash::hit(crash::Point::AfterResidueNamespaceDurableBeforeReceipt);

        // ── Quarantine receipt DURABLE before any purge ─────────────────────
        let qname = QuarantineComponent::parse(&format!(
            "{}.{}.residue-quarantined.json",
            run_id.component(),
            target.as_str()
        ));
        let durable = if fault::armed(fault::Point::AfterResidueRenameBeforeReceipt) {
            Err(codes::EVIDENCE_FAILED.to_string())
        } else {
            match qname {
                Ok(name) => receipts.write_durable(
                    exclusive,
                    &name,
                    &residue_evidence(run_id, &acted, "quarantined"),
                ),
                Err(code) => Err(code),
            }
        };
        if let Err(code) = durable {
            // The item stays in quarantine, unpurged and recoverable.
            acted.blocker = Some(code);
            outcome.residue_acted.push(acted);
            outcome.blockers.push(codes::EVIDENCE_FAILED.to_string());
            outcome.state = RunState::Partial;
            break;
        }
        trace::record(trace::Event::ResidueReceiptDurable);
        crash::hit(crash::Point::AfterResidueReceiptBeforePurge);

        // ── Same-run purge, through the T3.1 confined primitive only ────────
        let quarantine_target =
            match QuarantineTarget::parse(&bare_id, target.as_str(), QuarantineKind::StagingTemp) {
                Ok(t) => t,
                Err(code) => {
                    acted.blocker = Some(code);
                    outcome.residue_acted.push(acted);
                    outcome.state = RunState::Partial;
                    break;
                }
            };
        trace::record(trace::Event::ResiduePurge);
        let purge = if fault::armed(fault::Point::ResiduePurgeFails) {
            // A purge that reached the primitive and did NOT converge, leaving
            // the quarantined item physically behind — the state a real partial
            // failure produces, rather than a successful purge relabelled.
            crate::archive_reclaim::PurgeOutcome {
                converged: false,
                removed: 0,
                already_absent: false,
                blockers: vec![crate::archive_reclaim::codes::PURGE_FAILED.to_string()],
            }
        } else {
            purge_quarantined_item(exclusive, reclaim, &quarantine_target)
        };
        if !purge.converged {
            // Logical removal already happened; the canonical entry is NOT
            // restored. The physical residue stays contained for recovery.
            acted.blocker = Some(codes::RESIDUE_PURGE_FAILED.to_string());
            outcome.blockers.extend(purge.blockers.iter().cloned());
            outcome.residue_acted.push(acted);
            outcome
                .blockers
                .push(codes::RESIDUE_PURGE_FAILED.to_string());
            outcome.state = RunState::Partial;
            break;
        }
        acted.purged = true;
        outcome.residue.record(acted.family, false, true);

        let pname = QuarantineComponent::parse(&format!(
            "{}.{}.residue-purged.json",
            run_id.component(),
            target.as_str()
        ));
        let durable = match pname {
            Ok(name) => receipts.write_durable(
                exclusive,
                &name,
                &residue_evidence(run_id, &acted, "purged"),
            ),
            Err(code) => Err(code),
        };
        if let Err(code) = durable {
            acted.blocker = Some(code);
            outcome.residue_acted.push(acted);
            outcome.blockers.push(codes::EVIDENCE_FAILED.to_string());
            outcome.state = RunState::Partial;
            break;
        }
        trace::record(trace::Event::ResiduePurgeReceiptDurable);
        outcome.residue_acted.push(acted);
        crash::hit(crash::Point::BetweenStagingItems);
    }
}

/// M06 P4 T4.1 — the ACTIVATED governed reclamation command.
///
/// G02 passed, so this authority is reachable. The command is deliberately the
/// thinnest possible shell: it forwards the same bounded, enabling-only request
/// the read-only Preview already accepts and returns the trusted outcome
/// verbatim. It derives no path, plans no retention, classifies nothing,
/// enumerates no residue, consults no database, quarantines nothing, recovers
/// nothing and purges nothing — every one of those decisions stays inside the
/// reviewed sequence below.
///
/// The renderer cannot hand in authority. There is no run id, no candidate
/// list, no plan, no destructive target, no retention override and no force
/// flag, because `PreviewRequest` expresses none of them. A Preview the
/// operator looked at a moment ago is CONTEXT, never a plan: this reacquires
/// exclusive ownership and recomputes the package scan, the DB protections, the
/// CAS inventory, the residue scan and the whole retention plan underneath it,
/// so a candidate that has since become protected is left alone.
///
/// A domain-level refusal is reported INSIDE the outcome as a state plus
/// blockers, never as a command error, so the operator sees why.
///
/// The sequence runs on a blocking thread of the app's own runtime. That is
/// runtime affinity, not policy: exclusive ownership is a non-`Send`
/// `RwLockWriteGuard` and T3.2 deliberately HOLDS it across the trusted DB
/// probe's await, so the whole destructive window is covered by one
/// acquisition. Moving the probe out from under the guard would make the future
/// `Send` and would also break that reviewed property, so the guard stays put
/// and the future is confined to a single thread instead. Nothing about the
/// ordering, the preconditions or the recomputation changes.
#[tauri::command]
pub async fn h2o_archive_reclamation_execute(
    app: tauri::AppHandle,
    request: PreviewRequest,
) -> RunOutcome {
    let handle = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(execute_generation_reclamation(&app, &request))
    });
    match handle.await {
        Ok(outcome) => outcome,
        // The trusted sequence never unwinds; a join failure means the task
        // died, which is reported as a refusal rather than a silent success.
        Err(_) => RunOutcome::refused(codes::EXECUTE_TASK_FAILED),
    }
}

/// Deterministic fault injection for the destructive ordering proofs.
///
/// TEST-ONLY. In a release build `armed` is a `const false`, so every call site
/// folds away and the production path is byte-for-byte the real one: there is
/// no environment variable, no runtime flag and no production switch.
pub(crate) mod fault {
    /// Exactly the points where a crash would be dangerous if the ordering were
    /// wrong.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Point {
        BeforePlanDurability,
        AfterPlanDurableBeforeRename,
        AfterRenameBeforeNamespaceDurability,
        AfterRenameBeforeQuarantineReceipt,
        AfterQuarantineReceiptBeforePurge,
        /// A deterministic mid-run pause point, used to prove that no other
        /// process can obtain archive participation while the run holds
        /// exclusive ownership.
        PauseAfterPlanDurable,
        /// Forces the confined purge to report failure, so the "stop after a
        /// material purge failure" rule is provable deterministically.
        PurgeFails,
        AfterPurgeBeforePurgeReceipt,
        /// T3.3 staging stage: the residue rename SUCCEEDED and the namespace
        /// transition does not become durable.
        AfterResidueRenameBeforeNamespaceDurability,
        /// T3.3 staging stage: rename and namespace durability succeeded, and
        /// the receipt for them does not.
        AfterResidueRenameBeforeReceipt,
        /// T3.3 staging stage: forces the confined purge to report failure.
        ResiduePurgeFails,
    }

    #[cfg(test)]
    thread_local! {
        static ARMED: std::cell::RefCell<Option<Point>> =
            const { std::cell::RefCell::new(None) };
    }

    #[cfg(test)]
    pub fn arm(point: Point) {
        ARMED.with(|a| *a.borrow_mut() = Some(point));
    }

    #[cfg(test)]
    pub fn clear() {
        ARMED.with(|a| *a.borrow_mut() = None);
    }

    #[cfg(test)]
    pub(super) fn armed(point: Point) -> bool {
        ARMED.with(|a| *a.borrow() == Some(point))
    }

    #[cfg(not(test))]
    pub(super) const fn armed(_point: Point) -> bool {
        false
    }
}

/// A deterministic mid-run pause, so a test can hold the run INSIDE its
/// exclusive window while a real second process tries to participate.
///
/// TEST-ONLY: in a release build `wait_if_armed` is an empty inlined function
/// with no state, no timer and no switch.
pub(crate) mod pause {
    #[cfg(test)]
    pub(crate) static GATE: std::sync::Mutex<Option<std::sync::mpsc::Receiver<()>>> =
        std::sync::Mutex::new(None);

    #[cfg(test)]
    pub(crate) static REACHED: std::sync::Mutex<Option<std::sync::mpsc::Sender<()>>> =
        std::sync::Mutex::new(None);

    /// Arms one pause and returns (notify-when-reached, release-handle).
    #[cfg(test)]
    pub(crate) fn arm() -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (reached_tx, reached_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        *REACHED.lock().unwrap() = Some(reached_tx);
        *GATE.lock().unwrap() = Some(release_rx);
        (reached_rx, release_tx)
    }

    #[cfg(test)]
    pub(crate) fn clear() {
        *REACHED.lock().unwrap() = None;
        *GATE.lock().unwrap() = None;
    }

    #[cfg(test)]
    pub(super) fn wait_if_armed() {
        let reached = REACHED.lock().unwrap().take();
        let gate = GATE.lock().unwrap().take();
        if let (Some(tx), Some(rx)) = (reached, gate) {
            let _ = tx.send(());
            let _ = rx.recv();
        }
    }

    #[cfg(not(test))]
    #[inline(always)]
    pub(super) fn wait_if_armed() {}
}

/// Test-only ordering trace. Compiled out of production entirely, so the
/// shipped path records nothing.
pub(crate) mod trace {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Event {
        PlanDurable,
        FirstRename,
        QuarantineNamespaceDurable,
        QuarantineReceiptDurable,
        Purge,
        PurgeReceiptDurable,
        ResidueRename,
        ResidueNamespaceDurable,
        ResidueReceiptDurable,
        ResiduePurge,
        ResiduePurgeReceiptDurable,
    }

    #[cfg(test)]
    thread_local! {
        static EVENTS: std::cell::RefCell<Vec<Event>> = const { std::cell::RefCell::new(Vec::new()) };
    }

    #[cfg(test)]
    pub fn record(event: Event) {
        EVENTS.with(|e| e.borrow_mut().push(event));
    }

    #[cfg(not(test))]
    pub fn record(_event: Event) {}

    #[cfg(test)]
    pub fn reset() {
        EVENTS.with(|e| e.borrow_mut().clear());
    }

    #[cfg(test)]
    pub fn taken() -> Vec<Event> {
        EVENTS.with(|e| e.borrow().clone())
    }
}

#[cfg(test)]
mod tests;
