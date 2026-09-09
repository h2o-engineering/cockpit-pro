//! M06 T3.4 — governed occupant quarantine.
//!
//! DORMANT. No `#[tauri::command]`, nothing in either invoke-handler arm, no
//! renderer route and no UI. G02 remains the activation gate.
//!
//! The remedy this replaces is manual filesystem surgery. A corrupt, partial,
//! foreign or unreadable occupant sitting at a canonical generation path blocks
//! re-publication of that exact generation, because publication is create-only:
//! `promote_dir_exclusive` refuses rather than replacing. Today the only fix is
//! for a person to delete a directory by hand. This gives that operation a
//! governed shape.
//!
//! Two rules define it.
//!
//! **The operator names an IDENTITY, never a path.** The request carries a chat
//! id and an occupant basename and nothing else — no root, no `PathBuf`, no
//! destination, no run id. The trusted side re-derives the canonical source
//! under `archive/packages` through the existing T2.1 name authority, and
//! refuses anything that is not generation-path shaped for that exact chat.
//!
//! **Classification is RE-DERIVED, never inherited.** Archive Health, Preview,
//! a renderer verdict and a previous error reason are all irrelevant here. The
//! action acquires exclusive ownership FIRST and then re-runs the T2.1 package
//! authority underneath it, so an occupant that a diagnostic called corrupt but
//! which now verifies is refused — the stale verdict cannot authorize anything.
//!
//! ```text
//! bounded identity request → exclusive → registry empty
//!   → fresh trusted scan → locate the named occupant
//!   → prove generation-path shape, chat agreement and eligibility
//!   → plan evidence DURABLE  ── before the canonical rename
//!   → ONE atomic non-replacing rename out of archive/packages
//!   → namespace transition DURABLE
//!   → quarantine receipt DURABLE
//!   → STOP
//! ```
//!
//! That last line is the defining difference from the generation and staging
//! stages. Occupant quarantine uses **dwell** (contract §J): the quarantined
//! occupant stays physically present for at least one run, so a mistaken action
//! is recoverable by inspection. There is NO purge here — this module never
//! calls `purge_quarantined_item`, never unlinks, and writes no purge receipt.
//! Convergence of quarantined occupant runs belongs to the later crash and
//! recovery task, which will also decide dwell expiry. Nothing here reads a
//! clock, an mtime or a run-id ordering to do it.
//!
//! Canonical CAS is untouched: no path is built through `assets`, and the
//! read-only orphan analysis is not consulted at all. Revision 2 removed
//! destructive CAS reclamation from M06 entirely.

// DORMANT until G02: nothing in production calls this destructive authority
// yet, so the compiler correctly reports it as unused. The attribute records
// that dormancy deliberately rather than leaving build noise; it is removed
// when the activation task wires a caller.
#![allow(dead_code)]

use crate::archive_package_scan::{
    IndeterminateReason, NameShape, OccupantClass, PackageScan, PACKAGE_SUFFIX,
};
use crate::archive_reclaim::{crash, QuarantineComponent, QuarantineRunId};
use crate::archive_reclaim_execute::{RUN_SCHEMA, RUN_SCHEMA_VERSION};
use crate::archive_instance_lock::ExclusiveOwnership;

/// The stage name this action writes into run evidence.
///
/// It is the value a reader must branch on to recognise an occupant record, and
/// it is why no schema bump is needed — see `SCHEMA_NOTE`.
pub const OCCUPANT_STAGE: &str = "occupant-quarantine";

/// The quarantine identity prefix, matching the T3.3 residue convention
/// (`genstage.`, `durtmp.`).
pub const OCCUPANT_TAG: &str = "occupant";

/// The dwell this action promises, recorded in evidence as a fact rather than
/// enforced by any clock. One run: the occupant stays in quarantine and is not
/// purged by the run that put it there.
pub const OCCUPANT_DWELL: &str = "one-run";

/// Why T3.4 keeps run-evidence schema version 2 rather than bumping to 3.
///
/// The rule the repository applies is that a reader for version N must reject
/// N+1 cleanly rather than consume it partially, and T3.3 bumped 1 → 2 because
/// a version-1 reader handed a version-2 record would find every field it knew
/// present and well formed and would conclude "no residue action occurred" in a
/// run where residue WAS reclaimed. That is a silent under-report of a
/// destructive action, which AC-M06-11 exists to prevent.
///
/// An occupant record cannot under-report that way. It announces itself in a
/// field a conforming version-2 reader already has to branch on — `stages`
/// carries `occupant-quarantine` and the item receipt carries
/// `kind: "occupant"` — so a reader either handles the value or rejects the
/// record. It never sees a familiar shape that means "nothing happened". And no
/// version-2 field is populated with a false value: the occupant plan record
/// simply does not carry the generation plan's `retentionFloor`, `sources`,
/// `candidates` or `residue` fields, because this action computes no retention
/// plan at all.
pub const SCHEMA_NOTE: &str = "occupant records are self-announcing within v2";

pub mod codes {
    pub const EXCLUSIVE_UNAVAILABLE: &str = "occupant-exclusive-unavailable";
    pub const ARCHIVE_UNAVAILABLE: &str = "occupant-archive-unavailable";
    pub const PUBLISHER_SESSIONS_ACTIVE: &str = "occupant-publisher-sessions-active";
    /// The request was not a bounded identity.
    pub const REQUEST_CHAT_ID_INVALID: &str = "occupant-request-chat-id-invalid";
    pub const REQUEST_NAME_INVALID: &str = "occupant-request-name-invalid";
    /// The fresh package scan could not account for the whole namespace, so
    /// "this occupant is eligible" could not be established.
    pub const SCAN_NOT_AUTHORITATIVE: &str = "occupant-scan-not-authoritative";
    /// The named occupant is not present. Truthful, and zero mutation.
    pub const OCCUPANT_NOT_FOUND: &str = "occupant-not-found";
    /// The name is not `<chatId>.g<64 hex>.h2ochat`.
    pub const NOT_A_GENERATION_PATH: &str = "occupant-not-a-generation-path";
    /// The name is generation shaped, but for a different chat than requested.
    pub const CHAT_IDENTITY_MISMATCH: &str = "occupant-chat-identity-mismatch";
    /// It verifies. Absolute refusal, whatever a diagnostic said earlier.
    pub const OCCUPANT_IS_VALID: &str = "occupant-is-a-verified-generation";
    /// Grandfathered `<chatId>.h2ochat`. Never reclaimable.
    pub const OCCUPANT_IS_LEGACY: &str = "occupant-is-a-legacy-package";
    /// Reserved trusted infrastructure, including staging and temp residue.
    pub const OCCUPANT_IS_RESERVED: &str = "occupant-is-reserved-infrastructure";
    /// Present and not valid, but not positively within the governed remedy.
    pub const OCCUPANT_NOT_ELIGIBLE: &str = "occupant-not-eligible";
    pub const NAME_EXCEEDS_LIMIT: &str = "occupant-name-exceeds-filesystem-limit";
    pub const NAME_MAX_INDETERMINATE: &str = "occupant-name-max-indeterminate";
    pub const RUN_ID_UNAVAILABLE: &str = "occupant-run-id-unavailable";
    pub const EVIDENCE_FAILED: &str = "occupant-evidence-failed";
    pub const PACKAGES_UNAVAILABLE: &str = "occupant-packages-unavailable";
    pub const QUARANTINE_FAILED: &str = "occupant-quarantine-failed";
    pub const QUARANTINE_COLLISION: &str = "occupant-quarantine-collision";
}

/// The bounded, IDENTITY-shaped request.
///
/// Deliberately two strings. There is no root, no `PathBuf`, no packages path,
/// no quarantine destination, no run id, no candidate list, no retention floor,
/// no force and no override — none of those is a refused input, because no
/// value of this type expresses one.
#[derive(serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OccupantRequest {
    pub chat_id: String,
    /// The canonical basename, e.g. `<chatId>.g<64 hex>.h2ochat`. A LOCATOR for
    /// the trusted review below, never an instruction.
    pub occupant_name: String,
}

/// What the action did. Deliberately four states so a caller cannot confuse
/// "there was nothing to do" with "we refused" or with "we moved something and
/// then could not vouch for it".
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OccupantState {
    /// Refused before ANY mutation.
    Refused,
    /// The named occupant is not there. No mutation, no run, no evidence.
    NotFound,
    /// Quarantined and durably recorded. NOT purged — dwell.
    Quarantined,
    /// The rename happened and something after it did not. Never Complete.
    Partial,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OccupantOutcome {
    pub schema: &'static str,
    pub schema_version: u32,
    pub stage: &'static str,
    /// Present only once a run namespace was actually created.
    pub run_id: Option<String>,
    pub state: OccupantState,
    /// The validated request identity, echoed back.
    pub chat_id: String,
    pub occupant_name: String,
    /// The FRESH trusted classification, not the requester's belief.
    pub classification: Option<String>,
    pub quarantine_item: Option<String>,
    pub quarantined: bool,
    /// Always false. Occupant quarantine dwells; this run never purges.
    pub purged: bool,
    pub dwell: &'static str,
    pub blockers: Vec<String>,
}

impl OccupantOutcome {
    fn base(request: &OccupantRequest, state: OccupantState) -> Self {
        OccupantOutcome {
            schema: RUN_SCHEMA,
            schema_version: RUN_SCHEMA_VERSION,
            stage: OCCUPANT_STAGE,
            run_id: None,
            state,
            chat_id: request.chat_id.trim().to_string(),
            occupant_name: request.occupant_name.trim().to_string(),
            classification: None,
            quarantine_item: None,
            quarantined: false,
            purged: false,
            dwell: OCCUPANT_DWELL,
            blockers: vec![],
        }
    }

    fn refused(request: &OccupantRequest, code: &str) -> Self {
        let mut out = OccupantOutcome::base(request, OccupantState::Refused);
        out.blockers.push(code.to_string());
        out
    }
}

/// One request component: non-empty, printable ASCII, separator free.
///
/// Bounds are STRUCTURAL here and the length authority is the filesystem's own
/// `NAME_MAX`, checked below through the opened packages descriptor exactly as
/// the publisher does at `begin` and `commit`. Nothing is ever truncated: an
/// over-long identity is refused.
fn admissible(text: &str) -> bool {
    !text.is_empty()
        && text != "."
        && text != ".."
        && text.bytes().all(|b| b.is_ascii_graphic())
        && !text.contains('/')
        && !text.contains('\\')
}

fn admit(request: &OccupantRequest) -> Result<(String, String), String> {
    let chat_id = request.chat_id.trim().to_string();
    if !admissible(&chat_id) {
        return Err(codes::REQUEST_CHAT_ID_INVALID.to_string());
    }
    let name = request.occupant_name.trim().to_string();
    if !admissible(&name) || !name.ends_with(PACKAGE_SUFFIX) {
        return Err(codes::REQUEST_NAME_INVALID.to_string());
    }
    Ok((chat_id, name))
}

/// The occupant states the governed remedy accepts.
///
/// Exactly the four the contract names — corrupt, partial, foreign and
/// unreadable — mapped onto the T2.1 reasons that carry those meanings. An
/// occupant is never eligible because it merely failed to classify: both
/// `NotAPackageName` and `UnexpectedOutcome` fall through to a refusal, so an
/// unmodelled state fails closed instead of widening the remedy.
///
/// `Unreadable` is where a SYMLINK at a generation path lands, because the
/// authoritative verifier refuses to follow one. Quarantining it moves the link
/// ENTRY; the atomic rename never dereferences it, so whatever it pointed at is
/// untouched.
fn eligible(reason: &IndeterminateReason) -> bool {
    // ONE authority, beside the classifier that produces the reasons. The
    // read-only Preview hint asks the same question of the same function, so
    // what the operator is offered and what this action accepts cannot drift.
    reason.is_occupant_remedy_class()
}

fn classification_of(reason: &IndeterminateReason) -> String {
    serde_json::to_value(reason)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

/// The quarantine identity for one occupant.
///
/// Deterministic, separator free, and derived from the VALIDATED canonical
/// basename only. That matters: the occupant is by definition one the verifier
/// would not accept, so its manifest is not trustworthy identity — nothing here
/// reads it, and no second hash authority is introduced. The canonical packages
/// directory is flat, so the basename is already unique among legitimate
/// occupants, and a colliding destination is refused by `RENAME_EXCL` rather
/// than replaced.
fn occupant_target(name: &str) -> Result<QuarantineComponent, String> {
    QuarantineComponent::parse(&format!("{OCCUPANT_TAG}.{name}"))
}

fn receipt_name(run: &QuarantineRunId, target: &QuarantineComponent) -> Result<QuarantineComponent, String> {
    QuarantineComponent::parse(&format!(
        "{}.{}.occupant-quarantined.json",
        run.component(),
        target.as_str()
    ))
}

fn plan_evidence(
    run: &QuarantineRunId,
    chat_id: &str,
    name: &str,
    archive_path: &str,
    classification: &str,
    target: &QuarantineComponent,
) -> Vec<u8> {
    let value = serde_json::json!({
        "schema": RUN_SCHEMA,
        "schemaVersion": RUN_SCHEMA_VERSION,
        "runId": run.component(),
        "stages": [OCCUPANT_STAGE],
        "occupant": {
            "chatId": chat_id,
            "occupantName": name,
            "archivePath": archive_path,
            // The FRESH verdict this run established, not the requester's.
            "classification": classification,
            "action": "quarantine",
            "dwell": OCCUPANT_DWELL,
            "purgeInThisRun": false,
            "quarantineItem": target.as_str(),
            "preconditions": {
                "exclusiveOwnership": true,
                "publisherRegistryEmpty": true,
                "packageScanComplete": true,
                "reclassifiedUnderExclusive": true,
            },
        },
    });
    serde_json::to_vec(&value).unwrap_or_default()
}

fn item_evidence(run: &QuarantineRunId, outcome: &OccupantOutcome, archive_path: &str) -> Vec<u8> {
    let value = serde_json::json!({
        "schema": RUN_SCHEMA,
        "schemaVersion": RUN_SCHEMA_VERSION,
        "runId": run.component(),
        "kind": "occupant",
        "action": "quarantined",
        "chatId": outcome.chat_id,
        "occupantName": outcome.occupant_name,
        "archivePath": archive_path,
        "classification": outcome.classification,
        "quarantineItem": outcome.quarantine_item,
        "quarantined": outcome.quarantined,
        // Explicit, not omitted: the receipt states that dwell is in force.
        "purged": false,
        "dwell": OCCUPANT_DWELL,
    });
    serde_json::to_vec(&value).unwrap_or_default()
}

/// PRODUCTION entry point.
///
/// Acquires exclusive ownership, samples the publisher registry and derives the
/// canonical archive root itself, then re-classifies inside that window. The
/// ONLY caller-controlled input is the bounded identity above.
///
/// DORMANT: no command routes here.
pub(crate) fn execute_occupant_quarantine(
    app: &tauri::AppHandle,
    request: &OccupantRequest,
) -> OccupantOutcome {
    use tauri::Manager;

    let archive_root = match crate::archive_durable_write::archive_root(app) {
        Ok(root) => root,
        Err(_) => return OccupantOutcome::refused(request, codes::ARCHIVE_UNAVAILABLE),
    };
    let Some(lock) = app.try_state::<crate::archive_instance_lock::ArchiveInstanceState>() else {
        return OccupantOutcome::refused(request, codes::EXCLUSIVE_UNAVAILABLE);
    };
    // NON-BLOCKING acquisition, held for the whole window below.
    let Ok(exclusive) = lock.try_acquire_exclusive() else {
        return OccupantOutcome::refused(request, codes::EXCLUSIVE_UNAVAILABLE);
    };

    // Sampled AFTER exclusive ownership, so it cannot change underneath us.
    let sessions_empty = match app.try_state::<crate::archive_generation_publish::PublisherState>() {
        Some(state) => {
            let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().map(|p| p.sessions_empty()).unwrap_or(true)
        }
        None => true,
    };

    let outcome = quarantine_internal(&exclusive, &archive_root, sessions_empty, request);
    let _ = exclusive.release();
    outcome
}

/// The destructive sequence. PRIVATE: production reaches it only through the
/// wrapper above, so no caller can supply a scan, a classification or a root.
///
/// No DB probe participates. The trusted read-only probe supplies generation
/// PROVENANCE and WRITING-STATE protections, which exist to stop retention from
/// deleting a recoverable VALID generation (§G, AC-M06-08). This action deletes
/// nothing recoverable: it refuses every VALID generation by construction, and
/// its authority is occupant validity, not retention candidacy. Making it
/// depend on unrelated DB availability would add a failure mode without adding
/// a protection.
fn quarantine_internal(
    exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
    publisher_sessions_empty: bool,
    request: &OccupantRequest,
) -> OccupantOutcome {
    let (chat_id, name) = match admit(request) {
        Ok(parts) => parts,
        Err(code) => return OccupantOutcome::refused(request, &code),
    };

    // Hard precondition: no publication session may be in flight. Checked
    // BEFORE any recomputation, so a refusal costs nothing and, critically,
    // before any namespace or evidence could be created.
    if !publisher_sessions_empty {
        return OccupantOutcome::refused(request, codes::PUBLISHER_SESSIONS_ACTIVE);
    }

    // ── RE-CLASSIFIED HERE, under exclusive ownership ────────────────────────
    // The existing T2.1 authority, re-run. No second verifier, no second name
    // parser, and nothing inherited from Archive Health, Preview or the caller.
    let scan: PackageScan = crate::archive_package_scan::scan_packages_within(archive_root);
    if !scan.complete {
        let mut refused = OccupantOutcome::refused(request, codes::SCAN_NOT_AUTHORITATIVE);
        refused.blockers.extend(scan.blockers.iter().cloned());
        refused.blockers.sort();
        refused.blockers.dedup();
        return refused;
    }

    let Some(occupant) = scan.occupants.iter().find(|o| o.name == name) else {
        // Truthful: nothing to act on, and nothing was created by looking.
        let mut out = OccupantOutcome::base(request, OccupantState::NotFound);
        out.blockers.push(codes::OCCUPANT_NOT_FOUND.to_string());
        return out;
    };

    // The name must be generation-path shaped for THIS chat. One check refuses
    // legacy packages, reserved infrastructure, staging and temp residue and
    // every foreign basename, through the canonical T2.1 parser rather than a
    // restated grammar.
    match crate::archive_package_scan::name_shape(&occupant.name) {
        NameShape::Generation {
            chat_id: named, ..
        } => {
            if named != chat_id {
                return OccupantOutcome::refused(request, codes::CHAT_IDENTITY_MISMATCH);
            }
        }
        NameShape::Reserved => {
            return OccupantOutcome::refused(request, codes::OCCUPANT_IS_RESERVED)
        }
        NameShape::Legacy { .. } | NameShape::NotAPackage => {
            return OccupantOutcome::refused(request, codes::NOT_A_GENERATION_PATH)
        }
    }

    // Branch ONLY on the fresh verdict.
    let reason = match &occupant.class {
        OccupantClass::VerifiedGeneration(_) => {
            // It verifies NOW. Whatever an earlier diagnostic said, this is a
            // good generation and the governed remedy does not apply to it.
            return OccupantOutcome::refused(request, codes::OCCUPANT_IS_VALID);
        }
        OccupantClass::LegacyPackage(_) => {
            return OccupantOutcome::refused(request, codes::OCCUPANT_IS_LEGACY)
        }
        OccupantClass::ReservedInfrastructure => {
            return OccupantOutcome::refused(request, codes::OCCUPANT_IS_RESERVED)
        }
        // Eligibility stays driven solely by `reason`; `..` keeps the additive
        // diagnostic blocker field out of quarantine authority entirely.
        OccupantClass::Indeterminate { reason, .. } if eligible(reason) => reason.clone(),
        OccupantClass::Indeterminate { .. } => {
            return OccupantOutcome::refused(request, codes::OCCUPANT_NOT_ELIGIBLE)
        }
    };

    let archive_path = occupant.path.clone();
    let classification = classification_of(&reason);

    // The rename SOURCE. Opened before anything is created, so the name-length
    // authority below is the real filesystem's and a refusal costs nothing.
    let packages = match crate::archive_reclaim::open_packages_dir(exclusive, archive_root) {
        Ok(dir) => dir,
        Err(_) => return OccupantOutcome::refused(request, codes::PACKAGES_UNAVAILABLE),
    };
    let name_max = match packages.name_max() {
        Ok(value) => value,
        // Unanswerable: fail closed, exactly as the publisher does at `begin`.
        Err(_) => return OccupantOutcome::refused(request, codes::NAME_MAX_INDETERMINATE),
    };

    let run_id = match crate::archive_reclaim_execute::generate_run_id() {
        Ok(id) => id,
        Err(code) => return OccupantOutcome::refused(request, &code),
    };
    let target = match occupant_target(&occupant.name) {
        Ok(component) => component,
        Err(code) => return OccupantOutcome::refused(request, &code),
    };
    let receipt = match receipt_name(&run_id, &target) {
        Ok(component) => component,
        Err(code) => return OccupantOutcome::refused(request, &code),
    };
    // Refused, never truncated.
    if target.as_str().len() as u64 > name_max || receipt.as_str().len() as u64 > name_max {
        return OccupantOutcome::refused(request, codes::NAME_EXCEEDS_LIMIT);
    }

    let mut outcome = OccupantOutcome::base(request, OccupantState::Refused);
    outcome.classification = Some(classification.clone());
    outcome.quarantine_item = Some(target.as_str().to_string());

    let reclaim = match crate::archive_reclaim::open_reclaim_root_for_run(exclusive, archive_root) {
        Ok(root) => root,
        Err(code) => {
            outcome.blockers.push(code);
            return outcome;
        }
    };
    let receipts = match reclaim.receipts_dir(exclusive) {
        Ok(dir) => dir,
        Err(code) => {
            outcome.blockers.push(code);
            return outcome;
        }
    };

    // ── Plan evidence DURABLE before the canonical rename ────────────────────
    let plan_name = match QuarantineComponent::parse(&format!("{}.plan.json", run_id.component())) {
        Ok(component) => component,
        Err(code) => {
            outcome.blockers.push(code);
            return outcome;
        }
    };
    let plan_written = if fault::armed(fault::Point::BeforePlanDurability) {
        Err(codes::EVIDENCE_FAILED.to_string())
    } else {
        receipts.write_durable(
            exclusive,
            &plan_name,
            &plan_evidence(
                &run_id,
                &chat_id,
                &occupant.name,
                &archive_path,
                &classification,
                &target,
            ),
        )
    };
    if let Err(code) = plan_written {
        // Includes a receipt collision: refused BEFORE any mutation.
        outcome.blockers.push(codes::EVIDENCE_FAILED.to_string());
        outcome.blockers.push(code);
        outcome.blockers.sort();
        outcome.blockers.dedup();
        return outcome;
    }
    trace::record(trace::Event::PlanDurable);
    crash::hit(crash::Point::AfterOccupantPlanDurableBeforeRename);

    let run_dir = match reclaim.create_run(exclusive, &run_id) {
        Ok(dir) => dir,
        Err(code) => {
            outcome.blockers.push(code);
            return outcome;
        }
    };
    outcome.run_id = Some(run_id.component().to_string());

    let source = match QuarantineComponent::parse(&occupant.name) {
        Ok(component) => component,
        Err(code) => {
            outcome.blockers.push(code);
            return outcome;
        }
    };

    // ── ONE bounded canonical mutation ───────────────────────────────────────
    trace::record(trace::Event::OccupantRename);
    match crate::archive_reclaim::quarantine_occupant(
        exclusive, &packages, &run_dir, &source, &target,
    ) {
        Ok(true) => {
            outcome.quarantined = true;
            crash::hit(crash::Point::AfterOccupantRenameBeforeNamespaceDurable);
        }
        Ok(false) => {
            outcome.blockers.push(codes::QUARANTINE_COLLISION.to_string());
            return outcome;
        }
        Err(code) => {
            outcome.blockers.push(codes::QUARANTINE_FAILED.to_string());
            outcome.blockers.push(code);
            outcome.blockers.sort();
            outcome.blockers.dedup();
            return outcome;
        }
    }

    // ── The namespace transition must be DURABLE before anything claims it
    //    happened. Atomic is not durable.
    let namespace_durable = if fault::armed(fault::Point::AfterRenameBeforeNamespaceDurability) {
        Err(crate::archive_reclaim::codes::QUARANTINE_NOT_DURABLE.to_string())
    } else {
        crate::archive_reclaim::durable_quarantine_transition(exclusive, &packages, &run_dir)
    };
    if let Err(code) = namespace_durable {
        // Observed as it happened. No rollback: renaming it back would conceal
        // a failure whose durability we cannot vouch for either.
        outcome.state = OccupantState::Partial;
        outcome.blockers.push(code);
        return outcome;
    }
    trace::record(trace::Event::QuarantineNamespaceDurable);
    crash::hit(crash::Point::AfterOccupantNamespaceDurableBeforeReceipt);

    // ── Quarantine receipt DURABLE ───────────────────────────────────────────
    let durable = if fault::armed(fault::Point::AfterRenameBeforeReceipt) {
        Err(codes::EVIDENCE_FAILED.to_string())
    } else {
        receipts.write_durable(
            exclusive,
            &receipt,
            &item_evidence(&run_id, &outcome, &archive_path),
        )
    };
    if let Err(code) = durable {
        // The occupant stays in quarantine, unpurged and recoverable.
        outcome.state = OccupantState::Partial;
        outcome.blockers.push(codes::EVIDENCE_FAILED.to_string());
        outcome.blockers.push(code);
        outcome.blockers.sort();
        outcome.blockers.dedup();
        return outcome;
    }
    trace::record(trace::Event::QuarantineReceiptDurable);

    // ── STOP. Dwell (§J): the occupant stays physically in quarantine. ───────
    // There is no purge call, no purge receipt and no next-run sweep here.
    outcome.state = OccupantState::Quarantined;
    outcome
}

/// M06 P4 T4.1 — the ACTIVATED governed occupant-quarantine command.
///
/// G02 passed, so this authority is reachable. It forwards the identity — a
/// chat id and an occupant basename — and nothing else; no path, no root, no
/// run id, no quarantine destination, no classification and no force flag is
/// expressible. The trusted sequence re-derives the canonical source through
/// the T2.1 parser and RE-CLASSIFIES it under exclusive ownership, so a target
/// an operator saw as corrupt but which now verifies is refused.
///
/// Quarantine only: the run that moves an occupant never purges it.
#[tauri::command]
pub async fn h2o_archive_occupant_quarantine(
    app: tauri::AppHandle,
    request: OccupantRequest,
) -> OccupantOutcome {
    execute_occupant_quarantine(&app, &request)
}

/// Test-only seam letting the T3.5 crash matrix drive the real occupant
/// sequence from a child process. Compiled out of production entirely, so it
/// adds no shipped surface; the private sequence itself is unchanged.
#[cfg(test)]
pub(crate) fn quarantine_internal_for_test(
    exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
    publisher_sessions_empty: bool,
    request: &OccupantRequest,
) -> OccupantOutcome {
    quarantine_internal(exclusive, archive_root, publisher_sessions_empty, request)
}

/// Deterministic fault injection for the occupant ordering proofs.
///
/// TEST-ONLY, and shaped exactly like the T3.2/T3.3 seam: in a release build
/// `armed` is a `const false`, so every call site folds away and the production
/// path is byte-for-byte the real one. No environment variable, no runtime flag
/// and no production switch.
///
/// Kept in THIS module rather than extended onto the reclamation-run seam so
/// `archive_reclaim_execute` can keep its pin that no occupant vocabulary
/// appears there at all. That pin is what proves the generation and staging
/// stages perform no occupant action, and weakening it to share a test enum
/// would be a bad trade.
pub(crate) mod fault {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Point {
        BeforePlanDurability,
        /// The rename SUCCEEDED and the namespace transition does not become
        /// durable.
        AfterRenameBeforeNamespaceDurability,
        /// Rename and namespace durability succeeded, and the receipt does not.
        AfterRenameBeforeReceipt,
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

/// Test-only ordering trace. Compiled out of production entirely.
///
/// There is deliberately NO purge event: the dwell rule is that this action
/// cannot purge, so a purge step has no representation here to record.
pub(crate) mod trace {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Event {
        PlanDurable,
        OccupantRename,
        QuarantineNamespaceDurable,
        QuarantineReceiptDurable,
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
