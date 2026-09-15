//! M06 T3.5 — stale quarantine convergence.
//!
//! DORMANT. No `#[tauri::command]`, nothing in either invoke-handler arm, no
//! renderer route and no UI. G02 remains the activation gate.
//!
//! A crash between a quarantine rename and its purge leaves the archive in a
//! state that is SAFE but not finished: the canonical namespace is already
//! consistent — the entry is wholly gone, never half-deleted — and the item
//! sits complete inside `archive/.h2o-reclaim/run-<id>/`. Contract §J says that
//! must "converge safely and idempotently"; this module is that convergence.
//!
//! Three rules shape it.
//!
//! **It runs BEFORE the current run has a namespace.** The recovery pass is the
//! first thing a governed run does after its preconditions hold, and the fresh
//! run id is minted afterwards. So every run this pass can see is by
//! construction a PREVIOUS run: the current run is not merely excluded from
//! recovery, it does not yet exist. That is what implements occupant one-run
//! dwell (§J) without a clock — no mtime, no wall time, no run-id ordering read
//! as age. A run cannot purge the occupant it is about to quarantine, because
//! recovery already happened.
//!
//! **It acts only through typed structure.** There is no `purge_run`, no
//! `purge_all`, and no path input. Recovery asks `ReclaimRoot` for validated
//! `QuarantineRunId`s, asks each `RunDir` for validated `QuarantineComponent`s,
//! attributes each item to a family through the committed identity grammars,
//! and removes it with the T3.1 confined purge. Anything it cannot attribute is
//! reported and LEFT IN PLACE.
//!
//! **It fails closed and stops.** First material failure ends the pass, and the
//! governed run refuses to begin fresh destructive work on top of an
//! unconverged archive rather than layering new deletions over a contradiction.
//!
//! Canonical state is untouchable from here: this module opens neither
//! `archive/packages` nor `archive/assets`, so no canonical package and no CAS
//! object is reachable, let alone restorable. Nothing is ever moved back — an
//! item inside quarantine is already logically absent, and re-materialising it
//! would resurrect data a governed run decided to remove.

// DORMANT until G02: nothing in production calls this destructive authority
// yet, so the compiler correctly reports parts of it as unused.
#![allow(dead_code)]

use crate::archive_instance_lock::ExclusiveOwnership;
use crate::archive_package_scan::NameShape;
use crate::archive_reclaim::{
    crash, purge_quarantined_item, QuarantineComponent, QuarantineKind, QuarantineRunId,
    QuarantineTarget, ReceiptsDir,
};
use crate::archive_reclaim_execute::{RUN_SCHEMA, RUN_SCHEMA_VERSION};

/// The stage name this pass writes into run evidence.
pub const RECOVERY_STAGE: &str = "stale-quarantine-recovery";

pub mod codes {
    pub const RECLAIM_UNAVAILABLE: &str = "recovery-reclaim-unavailable";
    pub const RUN_UNREADABLE: &str = "recovery-run-unreadable";
    /// A quarantine entry whose identity matches no committed family grammar.
    /// Reported and LEFT IN PLACE — never guessed at.
    pub const ITEM_UNATTRIBUTABLE: &str = "recovery-item-unattributable";
    pub const PURGE_FAILED: &str = "recovery-purge-failed";
    pub const EVIDENCE_FAILED: &str = "recovery-evidence-failed";
    pub const RUN_ID_UNAVAILABLE: &str = "recovery-run-id-unavailable";
}

/// Which committed destructive family produced a quarantine entry.
///
/// Attribution is by IDENTITY GRAMMAR, using the same constructors the acting
/// stages used — the T3.3 family tags and the T2.1 generation-name parser. It
/// never parses an arbitrary string into a target, and an entry that matches
/// nothing is not attributed at all.
fn attribute(item: &QuarantineComponent) -> Option<QuarantineKind> {
    let name = item.as_str();
    if name.starts_with(&format!("{}.", crate::archive_occupant_quarantine::OCCUPANT_TAG)) {
        return Some(QuarantineKind::Occupant);
    }
    for family in [
        crate::archive_residue_probe::ResidueFamily::GenerationStaging,
        crate::archive_residue_probe::ResidueFamily::DurableTemp,
        crate::archive_residue_probe::ResidueFamily::CapabilityProbe,
    ] {
        if name.starts_with(&format!("{}.", family.tag())) {
            return Some(QuarantineKind::StagingTemp);
        }
    }
    // A generation was quarantined under its own canonical basename, so the
    // canonical parser is the authority on whether this is one.
    match crate::archive_package_scan::name_shape(name) {
        NameShape::Generation { .. } => Some(QuarantineKind::Generation),
        _ => None,
    }
}

fn kind_label(kind: QuarantineKind) -> &'static str {
    match kind {
        QuarantineKind::Generation => "generation",
        QuarantineKind::StagingTemp => "staging-temp",
        QuarantineKind::Occupant => "occupant",
    }
}

/// One recovered quarantine entry. Evidence only — a run identity, a typed
/// item identity and a family. No chat content, no absolute host path.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredItem {
    pub run: String,
    pub item: String,
    pub kind: &'static str,
    pub purged: bool,
    pub blocker: Option<String>,
}

#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryState {
    /// Nothing stale was found. No mutation, no evidence, no namespace.
    Clean,
    /// Every recognized stale entry converged.
    Converged,
    /// A material failure stopped the pass. The governed run must not proceed.
    Blocked,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOutcome {
    pub schema: &'static str,
    pub schema_version: u32,
    pub stage: &'static str,
    pub state: RecoveryState,
    /// Recognized PRIOR runs this pass examined, in deterministic order.
    pub runs: Vec<String>,
    /// Reclaim-root entries that are not recognizable runs. Left untouched.
    pub unrecognized_runs: Vec<String>,
    /// Quarantine entries that could not be attributed. Left in place.
    pub unattributable: Vec<String>,
    pub recovered: Vec<RecoveredItem>,
    pub purged: usize,
    pub blockers: Vec<String>,
}

impl RecoveryOutcome {
    fn new(state: RecoveryState) -> Self {
        RecoveryOutcome {
            schema: RUN_SCHEMA,
            schema_version: RUN_SCHEMA_VERSION,
            stage: RECOVERY_STAGE,
            state,
            runs: vec![],
            unrecognized_runs: vec![],
            unattributable: vec![],
            recovered: vec![],
            purged: 0,
            blockers: vec![],
        }
    }

    fn fail(&mut self, code: &str) {
        self.state = RecoveryState::Blocked;
        let code = code.to_string();
        if !self.blockers.contains(&code) {
            self.blockers.push(code);
        }
    }

    /// True when the governed run may go on to fresh destructive work.
    pub fn may_proceed(&self) -> bool {
        self.state != RecoveryState::Blocked
    }

    /// True when this pass materially changed persistent state. Used to decide
    /// whether evidence is owed, and by the idempotence proof.
    pub fn acted(&self) -> bool {
        self.purged > 0
    }
}

fn evidence(id: &QuarantineRunId, outcome: &RecoveryOutcome) -> Vec<u8> {
    let value = serde_json::json!({
        "schema": RUN_SCHEMA,
        "schemaVersion": RUN_SCHEMA_VERSION,
        "recoveryId": id.component(),
        "stages": [RECOVERY_STAGE],
        "recovery": {
            "state": outcome.state,
            "runs": outcome.runs,
            "unrecognizedRuns": outcome.unrecognized_runs,
            "unattributable": outcome.unattributable,
            "items": outcome.recovered,
            "purged": outcome.purged,
            "blockers": outcome.blockers,
        },
    });
    serde_json::to_vec(&value).unwrap_or_default()
}

/// Converges stale quarantine left by PREVIOUS runs.
///
/// Call this at the start of a governed destructive run, after exclusive
/// ownership and the publisher-registry precondition hold and BEFORE the run
/// mints its own id. Everything visible here is then a prior run by
/// construction.
///
/// `receipts` is `None` until the caller has a reason to create the evidence
/// namespace; a clean pass creates nothing at all, so a no-op governed run
/// still leaves no `.h2o-reclaim` behind.
pub(crate) fn recover_stale_quarantine(
    exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
) -> RecoveryOutcome {
    let mut out = RecoveryOutcome::new(RecoveryState::Clean);

    let reclaim = match crate::archive_reclaim::open_reclaim_root_if_present(exclusive, archive_root)
    {
        // No quarantine namespace at all: a proven absence, and nothing was
        // created by looking.
        Ok(None) => return out,
        Ok(Some(root)) => root,
        Err(_) => {
            out.fail(codes::RECLAIM_UNAVAILABLE);
            return out;
        }
    };

    let listing = reclaim.run_ids(exclusive);
    out.unrecognized_runs = listing.unrecognized.clone();
    for blocker in &listing.blockers {
        // An unreadable or non-directory reclaim entry is reported, and the
        // pass refuses to guess what it was. Nothing is erased.
        out.fail(blocker);
    }
    if !out.may_proceed() {
        return out;
    }

    for run in &listing.runs {
        out.runs.push(run.component().to_string());
        let dir = match reclaim.open_run(exclusive, run) {
            Ok(Some(dir)) => dir,
            // Raced away: already converged.
            Ok(None) => continue,
            Err(code) => {
                out.fail(&code);
                return out;
            }
        };
        let items = dir.item_names(exclusive);
        for blocker in &items.blockers {
            out.fail(blocker);
        }
        if !out.may_proceed() {
            return out;
        }
        for name in &items.unrecognized {
            out.unattributable.push(format!("{}/{name}", run.component()));
        }
        if !items.unrecognized.is_empty() {
            // A run holding something this pass cannot name is not converged,
            // and it must not be reported as if it were.
            out.fail(codes::ITEM_UNATTRIBUTABLE);
            return out;
        }

        let bare = run.component().trim_start_matches("run-").to_string();

        // ATTRIBUTE FIRST, ACT SECOND. Every entry in the run must be
        // recognizable before any of them is removed, so one unattributable
        // entry blocks its whole run instead of leaving it half converged. A
        // partially converged run is exactly the state this pass exists to end.
        let mut attributed: Vec<(&QuarantineComponent, QuarantineKind)> = vec![];
        for item in &items.items {
            match attribute(item) {
                Some(kind) => attributed.push((item, kind)),
                None => out
                    .unattributable
                    .push(format!("{}/{}", run.component(), item.as_str())),
            }
        }
        if attributed.len() != items.items.len() {
            out.fail(codes::ITEM_UNATTRIBUTABLE);
            return out;
        }

        for (item, kind) in attributed {
            let target = match QuarantineTarget::parse(&bare, item.as_str(), kind) {
                Ok(target) => target,
                Err(code) => {
                    out.fail(&code);
                    return out;
                }
            };
            let purge = purge_quarantined_item(exclusive, &reclaim, &target);
            let converged = purge.converged;
            out.recovered.push(RecoveredItem {
                run: run.component().to_string(),
                item: item.as_str().to_string(),
                kind: kind_label(kind),
                purged: converged,
                blocker: (!converged).then(|| codes::PURGE_FAILED.to_string()),
            });
            if !converged {
                // First material failure: stop before any later item, and
                // before the governed run starts fresh destructive work.
                for blocker in &purge.blockers {
                    out.fail(blocker);
                }
                out.fail(codes::PURGE_FAILED);
                return out;
            }
            out.purged += 1;
            crash::hit(crash::Point::AfterRecoveryPurgeBeforeReceipt);
        }
    }

    if out.acted() {
        out.state = RecoveryState::Converged;
    }
    out
}

/// Persists a durable record for a pass that materially acted.
///
/// Only a pass that actually purged something owes evidence. That keeps
/// repeated recovery idempotent — a second pass finds nothing, writes nothing,
/// and cannot collide with the first pass's receipt — and it keeps a governed
/// run that merely REFUSES over an unconverged archive from accumulating a
/// record on every attempt. A pass that purged some items and then hit a
/// material failure still records, with its blocker, so every acted item stays
/// accounted for (AC-M06-11).
///
/// The identity comes from the SAME trusted entropy authority the run ids use,
/// under a distinct `recovery-` prefix so a recovery record can never be
/// mistaken for — or collide with — a quarantine run namespace.
pub(crate) fn record_recovery(
    exclusive: &ExclusiveOwnership<'_>,
    receipts: &ReceiptsDir,
    outcome: &mut RecoveryOutcome,
) {
    if !outcome.acted() {
        return;
    }
    let id = match crate::archive_reclaim_execute::generate_run_id() {
        Ok(id) => id,
        Err(_) => {
            outcome.fail(codes::RUN_ID_UNAVAILABLE);
            return;
        }
    };
    let bare = id.component().trim_start_matches("run-");
    let name = match QuarantineComponent::parse(&format!("recovery-{bare}.recovery.json")) {
        Ok(name) => name,
        Err(code) => {
            outcome.fail(&code);
            return;
        }
    };
    if let Err(code) = receipts.write_durable(exclusive, &name, &evidence(&id, outcome)) {
        outcome.fail(&code);
        outcome.fail(codes::EVIDENCE_FAILED);
    }
}

/// Converges stale quarantine AND persists the record it owes, in one call.
///
/// This is what a governed run invokes. Evidence is opened lazily and only when
/// the pass has something to say, so a clean pass against an archive with no
/// quarantine namespace still creates nothing at all.
pub(crate) fn recover_and_record(
    exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
) -> RecoveryOutcome {
    let mut out = recover_stale_quarantine(exclusive, archive_root);
    if !out.acted() {
        return out;
    }
    // Anything found implies the namespace already exists, so this opens rather
    // than manufactures it.
    match crate::archive_reclaim::open_reclaim_root_for_run(exclusive, archive_root)
        .and_then(|root| root.receipts_dir(exclusive))
    {
        Ok(receipts) => record_recovery(exclusive, &receipts, &mut out),
        Err(code) => {
            out.fail(&code);
            out.fail(codes::EVIDENCE_FAILED);
        }
    }
    out
}

#[cfg(test)]
mod tests;
