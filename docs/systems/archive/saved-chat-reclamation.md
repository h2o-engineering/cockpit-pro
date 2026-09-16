# Saved Chat Archive Reclamation — Governed GC Contract

Status: Normative / M06 Phase P0 contract freeze — **M06 is COMPLETE / ACCEPTED**
(G3 passed 2026-08-31)

Date: 2026-08-28

Lane: 🗃️ L-STORAGE-SAVED-CHATS — Saved Chats Storage

Mission: M06 — Reclamation / GC

Architecture: **Revision 2 — HDA ACCEPTED 2026-08-28**

Decision: **DP-M06-RETENTION-FLOOR — APPROVED 2026-08-28**, default `K = 3`,
structural range `K >= 1`; **`K = 0` is invalid**.

Related:

- [Saved Chat Archive Generations Contract](saved-chat-generations.md) — M05, COMPLETE / ACCEPTED
- [Saved Chat Package Format — Versioned Umbrella Spec](saved-chat-package-format.md)
- [ADR-0009 — Chat Saving Architecture](../../decisions/ADR-0009-chat-saving-architecture.md)
- [ADR-0010 — Saved Chat Asset CAS](../../decisions/ADR-0010-saved-chat-asset-cas.md)
- [M05 acceptance record](../../../release-evidence/2026-08-28/saved-chat-storage-m05-acceptance.md)
- [M06 acceptance record](../../../release-evidence/2026-08-31/saved-chat-storage-m06-acceptance.md)

## A. Mission, authority and scope

This document is the normative M06 contract for governed reclamation of
saved-chat archive storage. It freezes authority for the M06 implementation
phases; it does not itself implement, delete, activate or migrate anything.

M06 inherits and MUST NOT weaken the M05 contract. Standing constraints it
operates under, none of which it modifies:

- **G02 remains the standing HDA destructive activation gate.** No physical
  reclamation authority is active before G02 acceptance.
- **I-CAS-01** remains the standing CAS reference-integrity authority.
- D9 remains binding: this source owns migrations through v17, production
  legitimately holds externally owned v18–v21, and M06 allocates **no**
  migration. All new metadata MUST live in existing columns.
- Live v3 remains OFF. M06 MUST NOT activate it as a side effect.
- New UI only. No Chrome architecture changes. No Sync-owned changes.

## B. Mission purpose

M06 makes immutable Saved-Chat history sustainable by reclaiming **only** data
that is provably reclaimable.

The design MUST structurally prevent, by construction rather than by care:

1. deletion of the last protected or recoverable good generation;
2. physical CAS reclamation while a new authoritative reference can still be
   created outside the reclamation proof boundary;
3. missing renderer assertions making data **more** deletable;
4. weakening of any M05 archive mutation or security guarantee.

## C. Functional Core

The accepted Revision 2 Functional Core is:

- manual, preview-first generation pruning;
- per-chat retention floor;
- staging / temp residue reclamation;
- **read-only** CAS orphan analysis only;
- governed occupant quarantine for eligible corrupt, partial, foreign or
  unreadable generation occupants;
- enforced single-instance reclamation precondition;
- trusted read-only DB probe;
- quarantine plus receipts;
- New UI Analyze / Reclaim surface;
- residue diagnostics correction;
- assembled acceptance evidence.

**DESTRUCTIVE CAS RECLAMATION IS NOT PART OF M06 FUNCTIONAL CORE.**

## D. Enforced single-instance precondition

*Normative rule.* Reclamation MUST run under enforced single-instance execution
against one archive root:

- every M06-aware instance MUST participate in the instance-presence lock;
- participating instances MUST hold the lifetime **shared** presence lock;
- reclamation MUST require **exclusive** acquisition;
- exclusive acquisition is positive proof that no other participating instance
  is executing against that archive root;
- reclamation MUST additionally require the in-process mutation gate and an
  **empty** publisher session registry;
- failure to establish the required exclusivity MUST fail closed.

*Rationale.* Exclusivity is a positive proof obligation, not an assumption. It
is deliberately stronger than "a single mutator": a single mutator does not
establish that no other instance is operating on the same root.

*Residual risk (explicit, accepted).* Mixed-version concurrent execution with an
uncooperative pre-M06 binary is **unsupported** during reclamation and remains
an explicit residual operational-envelope risk.

## E. Generation protection and retention

*Normative rule.* Per verified `chatId`, reclamation logic MUST NEVER make
candidates of:

- the newest VALID package overall;
- the newest **K** VALID same-family generations;
- any grandfathered legacy package;
- any format-stale package;
- any non-VALID, unclassifiable or unreadable package;
- any unorderable package;
- anything protected by trusted provenance or writing-state roots;
- any chat for which required authoritative enabling information is
  unavailable.

Ordering MUST be:

- verified in-content `snapshot.savedAt`;
- deterministic `contentHash` tiebreak;
- **never** a filesystem timestamp;
- **never** wall-clock age as deletion authority.

`K` is a **retention floor only**. `K` MUST NOT itself authorize deletion:
exceeding the floor makes a package merely *not floor-protected*, never a
candidate on that basis alone.

## F. Monotonic renderer-input rule

*Normative rule.* Removing, omitting, corrupting or failing to obtain
renderer-supplied information MUST NEVER cause a transition:

```text
PROTECTED → CANDIDATE
```

Renderer inputs are **enabling-only**. The currently accepted renderer inputs
are exactly:

1. chat scope;
2. per-chat projection verdict.

Their absence or failure MUST narrow eligibility, or protect or exclude the
chat. They MUST NEVER remove trusted protection.

Protective roots — generation floor, legacy, format-stale, validity, ordering,
Import provenance, Restore provenance, Relink provenance, and stranded-writing
hashes — MUST come from trusted filesystem or DB authority.

M06 MUST NOT add a second trusted-side `contentHash` or projection
implementation. If an authoritative projection verdict is unavailable,
generation reclamation for that chat MUST fail closed.

## G. Trusted DB probe

*Normative rule.*

- The probe MUST be **read-only**.
- It MUST NOT perform schema migration.
- It supplies generation provenance protections and writing-state protections.
- CAS reference sets MAY be used for **analysis**.
- Probe failure MUST block any destructive stage depending on it.
- `assets.refcount` is **not** deletion authority.

*Implementation seam.* Mechanics such as `rusqlite` versus the plugin pool
remain implementation-time choices, provided the contract stays read-only and
fail-closed.

## H. CAS policy

*Normative rule.* M06 MAY **analyze** CAS orphan candidates. M06 MUST NOT
physically quarantine, rename, unlink, purge or otherwise reclaim canonical CAS
objects.

**Negative invariant.** No M06 code path may mutate the canonical CAS.

*Deferred seam.* Physical CAS reclamation remains deferred until a later
authority proves structural serialization of all CAS reference-creation and
dedupe decisions. That future prerequisite includes at minimum:

- trusted serialization of every CAS reference-creation / dedupe path;
- restored-chat asset display-resolution semantics;
- future M07 peer/remote reference roots where applicable;
- a new explicit Decision Point and destructive evidence gate before
  activation.

## I. Concurrency and mutation authority

*Normative rule.*

- The renderer MUST receive no archive delete or rename capability.
- Destructive operations MUST exist only in trusted Rust.
- New reclamation functionality MUST be **policy/identity shaped**, never
  arbitrary renderer-supplied-filesystem-path shaped.
- Existing publisher and durable-write behavioral and security contracts MUST
  remain intact.
- Minimal lock/gate edits are permitted where required.
- Unrelated refactoring is **not** authorized by M06.

Preserved from M05: create-only publication; no replacing rename; no renderer
archive mutation authority; no arbitrary recursive deletion; existing negative
pins remain green. Documented retryable lock-busy behavior is allowed.

## J. Quarantine, interruption and recovery

*Normative rule.*

- Logical removal MUST use an atomic rename into a dedicated archive quarantine
  namespace.
- The canonical namespace MUST NEVER contain a half-deleted entry.
- Quarantine MUST remain outside normal package and CAS resolution.
- Receipts are required before or while destructive actions occur, per the
  accepted evidence contract.
- Recomputation and revalidation SHOULD be preferred over unnecessary
  persistent GC journals.
- Crash and restart MUST converge safely and idempotently.
- Occupant quarantine uses dwell.

CAS crash and purge semantics are **excluded**, because CAS mutation is not
part of M06.

### J.1 Later compatibility reflection — capability-probe residue (post-M06)

*This subsection is NOT part of the accepted M06 Revision 2 record above and
does not reopen it; it is recorded so the current implementation stays legible
against that record.* The later Mission
`establish-cross-platform-saved-chat-filesystem-safety` (T02; its contract
§10 rule 1 and certification case C24) adds a **third trusted residue family**
beside the two accepted at M06 (generation-staging, durable-temp):

- **`capability-probe`** — exact `.h2o-probe-<digits>-<digits>` crash residue
  of the class O filesystem-capability probes, and ONLY in the two
  archive-owned locations capability probing actually writes: directly under
  the admitted archive root, and under `archive/packages`. No probe runs in a
  CAS shard, so none is walked there.
- It is typed (`ResidueFamily::CapabilityProbe`, with a typed probe location)
  and is discovered by the **existing** trusted residue scan and moved by the
  **existing** no-replace quarantine machinery — the same atomic rename into
  the run namespace, the same durability barrier, receipts and purge — under
  the quarantine identity `probe.<root|packages>.<name>`.
- Symlink / reparse-point lookalikes and malformed reserved-prefix lookalikes
  are reported indeterminate and are never actionable; probe-shaped names
  outside that archive-owned boundary (a CAS shard, the export root, ZIP
  staging) remain inert.
- The addition authorizes **no** physical CAS reclamation (§H unchanged) and
  widens **no** renderer mutation authority (§I and §P unchanged): no new
  command, delete primitive or renderer-nameable path exists for it.
- The accepted M06 retention / quarantine / recovery model is preserved, not
  reopened: run-record evidence carries the family additively, and recovery
  attributes its quarantine entries exactly as it does the two accepted
  families.

## K. Manual-first policy

*Normative rule.* Functional Core reclamation is explicit and manual:

```text
Analyze → operator review → explicit confirmation → Reclaim
```

M06 MUST NOT introduce: startup GC; a timer; a background daemon; an on-publish
janitor; process-exit cleanup; or automatic physical reclamation.

Automatic bounded GC is future work and requires separate authority.

## L. Legacy compatibility

*Normative rule.*

- Grandfathered legacy `<chatId>.h2ochat` packages MUST NEVER be reclamation
  candidates.
- They MUST NEVER be automatically renamed, repacked or moved.
- Legacy manifests protect referenced CAS identities for analysis.
- Unreadable legacy authority MUST fail closed.
- Format-stale MUST NOT be read as content-obsolete.

## M. New UI

New UI only. No Legacy UI fallback.

The Functional Core UI MUST minimally provide:

- a storage / reclamation overview;
- Analyze / dry-run;
- generation protection and candidate reasons;
- indeterminate and blocker visibility;
- an explicit Reclaim control, available only after a successful Analyze;
- receipts and results;
- residue and quarantine visibility;
- an eligible occupant-quarantine action.

## N. Phase and gate structure

| Phase | Subject |
| --- | --- |
| P0 | Contract & Decision |
| P1 | Non-destructive Foundations |
| P2 | Read-only Engine |
| P3 | Destructive Core — dormant / unregistered |
| P4 | Activation & Acceptance |

Gates:

- **G0** — canonical contract plus accepted `DP-M06-RETENTION-FLOOR`.
- **G1'** — non-destructive foundations proven without unacceptable M05
  behavior or security regression.
- **G2** — read-only engine, fail-closed and monotonicity proof.
- **G02** — standing HDA destructive activation gate.
- **G3** — final M06 acceptance and evidence closure.

*Normative rule.* Before G02 acceptance: destructive commands MUST remain
unregistered; destructive UI controls MUST remain unavailable; and no physical
reclamation authority is active.

## O. Acceptance criteria

- **AC-M06-01 — Floor invariance.** No reclamation path may reduce a chat below
  its protected set under §E, for any `K >= 1`.
- **AC-M06-02 — No CAS mutation.** No M06 path mutates the canonical CAS;
  analysis is read-only.
- **AC-M06-03 — Enforced single-instance proof.** Reclamation proceeds only on
  positive exclusive acquisition per §D, and fails closed otherwise.
- **AC-M06-04 — Crash convergence.** Interruption at any point converges safely
  and idempotently, leaving no half-deleted canonical entry.
- **AC-M06-05 — M05 preservation.** M05 mutation and security contracts remain
  intact, with existing negative pins green.
- **AC-M06-06 — No timestamp authority.** Neither filesystem timestamps nor
  wall-clock age are deletion authority anywhere.
- **AC-M06-07 — Renderer-input monotonicity.** Absent, corrupt or failed
  renderer input never produces `PROTECTED → CANDIDATE`.
- **AC-M06-08 — Trusted DB probe.** The read-only probe is a precondition for
  dependent stages and supplies provenance and writing-state protection; its
  failure blocks those stages.
- **AC-M06-09 — Staging reclamation soundness.** Staging and temp residue
  reclamation never removes live or in-flight state.
- **AC-M06-10 — Occupant action safety.** Occupant quarantine applies only to
  eligible corrupt, partial, foreign or unreadable occupants, under dwell.
- **AC-M06-11 — Evidence completeness.** Receipts and assembled acceptance
  evidence cover every destructive action taken.
- **AC-M06-12 — No collateral change.** No migration, no live-v3 activation, no
  production-state change.
- **AC-M06-13 — Destructive gate ordering.** Destructive commands remain
  unregistered and destructive UI unavailable until G02 acceptance.

## P. Explicit no-go boundaries

M06 MUST NOT introduce or rely on any of:

- renderer `fs:allow-remove` or `fs:allow-rename` under `archive`;
- a renderer-named arbitrary deletion path;
- physical CAS reclamation;
- automatic GC in the Functional Core;
- filesystem timestamp or wall-clock deletion authority;
- `assets.refcount` as deletion authority;
- legacy reclamation;
- a second `contentHash` or projection implementation;
- migration;
- live-v3 activation as a side effect;
- Sync, M07 or M08 expansion;
- cross-Lane worktree reuse;
- anything other than New UI.

## Q. Withdrawn Revision 1 rules

Revision 2 **withdrew** the following; they are not authority and MUST NOT be
implemented or cited:

- single-mutator treated as a substitute for enforced single-instance;
- destructive CAS collection;
- one-run CAS dwell as the structural CAS safety proof;
- renderer-supplied provenance protections;
- byte-identical publisher / durable-write source preservation.
