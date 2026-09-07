# ADR-0013: Canonical Generated-Delivery Ownership

- Status: Proposed foundation; live enforcement not enabled
- Date: 2026-07-29
- Current Lane: `L-DEVELOPER-BUILD-DELIVERY-SCOPE-STU`
- Former canonical Lane ID: `L-STUDIO-INFRASTRUCTURE` (legacy provenance)
- Scope: Cross-worktree publication ownership, inspection, and proof

## Current Lane Alignment

Studio software/artifact generation, staging, publication/promotion,
provenance receipts, activation, retained generations, rollback/recovery, and
delivery validation belong to the continuing Studio Build & Delivery
Engineering Lane. The identity normalization preserves this ADR and its
historical evidence; it does not create a residual Studio Infrastructure Lane
or change the proposed enforcement state recorded here.

Saved-chat data/package publication is outside this ADR's software-delivery
meaning and remains with Saved Chats Storage or Platform Sync according to the
semantic operation.

## Context

Cockpit Pro has one browser-facing canonical development delivery but many Git
worktrees. The generated proxy, aliases, title bridge, loader, and unpacked
extension are ignored by Git. Builders launched from different worktrees can
therefore publish coherent but mutually incompatible output into the same
browser-facing destination without creating a tracked change or merge
conflict.

Five independently observed overwrites established that this is structural:

1. The selected-path presentation worktree at `d0a31215...` published marker
   `1785254852537`, embedded its foreign HEAD and order source, and redirected
   most aliases away from authoritative `main`.
2. The selected-path intent-fix worktree at `4ed2cc67...` published marker
   `1785257986526` and redirected all 154 aliases into that worktree.
3. The effective-title-list-collapse worktree at `f6d948c9...` published marker
   `1785279392665`, restored a stale version-2 title bridge, and again redirected
   all 154 aliases away from authoritative `main`.
4. During independent E1 review, the effective-title-list-collapse worktree at
   HEAD `527e228adecb458eabf3a5e1ccdc08973149419d` published marker
   `1785281759467`.
5. The later page-unit-ordering delivery came from worktree
   `h2o-cp-page-unit-ordering-527e228a-20260729T133208Z`, non-main HEAD
   `bea4ce7c...`, with marker `1785333403265`.

During the independent E1 review the active live delivery was foreign,
unaccepted, and exposed the pre-Stage-1D version-2 contract surface. All
committed Title Management source remained intact. The defect was that
independent publishers shared a destination without shared ownership, not that
the individual build commands generated random bytes.

## Decision

Stage 1D-E1 adds a proof-only ownership foundation:

- a strict lease/session library;
- a strict CLI for lease lifecycle and inspection;
- realpath-aware `LOCAL` versus `CANONICAL` destination classification;
- an explicit default and pre-merge-canary eligibility policy;
- a sandbox-only adversarial validator;
- narrow ignore rules for future alias and dev-output staging/retired siblings.

At E1 acceptance no writer imported the library. Stage E2A adds only the
bounded alias-writer guard described below. No live canonical lease is created,
and no canonical destination permissions or flags are changed. Generation,
staging, promotion, rollback, provenance publication, and browser activation
remain outside this phase.

`sync-dev-order.mjs` remains outside delivery leasing because it updates
source-side order views rather than generated delivery.

## Shared anchor

The control root is derived from:

```text
git rev-parse --path-format=absolute --git-common-dir
```

The common Git directory identifies the authoritative repository shared by all
linked worktrees. The default anchor is its cockpit-pro parent:

```text
<cockpit-pro>/.h2o-canonical-delivery/
```

It is outside every worktree and outside tracked source. Tests may set
`H2O_CANONICAL_DELIVERY_ROOT`, but callers must also explicitly acknowledge
that override. An environment variable alone cannot silently redirect an
operation. Override validation enumerates `git worktree list --porcelain`,
normalizes every registered root, and rejects ordinary or symlinked paths
inside any worktree. Git discovery failure has no permissive fallback.
Nonstandard absolute common-directory layouts derive the authoritative
worktree from executable Git configuration and worktree discovery.

## Destination classes

Normalized absolute paths are resolved through the longest existing ancestor
with the E1 real-aware path helper, so symlinked spellings and missing
descendants cannot evade classification.

E2A classification is destination-authoritative and multi-context. The guard
derives a trusted writer repository from the real filesystem location of
`canonical-write-guard.mjs`, never from caller `cwd`, `H2O_SRC_DIR`, or
`H2O_SERVER_DIR`. It also starts at the destination's nearest existing
directory, walks every real ancestor to the filesystem root, and resolves
every `.git` directory or `.git` file through the E1 shared-anchor API. The
contexts are deduplicated by authoritative repository root and shared-anchor
root. Caller `cwd` remains ordinary execution context only; it is not an
authority boundary.

Classification runs against the trusted writer context and every
destination-derived repository context. A `CANONICAL` result from any context
wins. Nested repositories therefore cannot hide an outer repository's
canonical generated-delivery path. Duplicate observations of one owner are
accepted, while distinct canonical owners are a path-coupling ambiguity and
fail before mutation.

`LOCAL` includes equivalent generated-looking paths beneath non-authoritative
worktrees. Local destinations require no canonical lease and retain their
existing behavior. A destination with no `.git` boundary anywhere on its real
ancestor chain is a legitimate outside-repository `LOCAL` destination and
also remains token-free. An unrelated standalone repository can classify its
own canonical generated-output paths as `CANONICAL`, but its anchor and lease
cannot authorize a different repository's canonical destination.

Repository discovery has no permissive error fallback. Once a `.git` marker
is detected, malformed or unreadable metadata, corrupt worktree state,
ambiguous Git output, command failure, or any inability to resolve the marker
through E1 fails closed. Such a failure is never converted to `LOCAL`.

`CANONICAL` includes authoritative:

- `apps/dev-server/alias` and descendants;
- `alias.staging-*` and `alias.retired-*` siblings;
- `apps/dev-server/dev_output` and descendants;
- `dev_output.staging-*` and `dev_output.retired-*` siblings;
- extension variant directories;
- extension `.staging-*` and `.retired-*` siblings.

Exact directory-level replacement parents are also canonical:

- `apps/dev-server`;
- `apps/extensions/chatgpt`;
- `apps/extensions/chatgpt/chrome`.

Their unrelated descendants remain local: for example `serve.py` and
unrelated source beneath `apps/dev-server` are not generated delivery.
The expected extension output must be an exact accepted variant, staging
sibling, or retired sibling beneath the authoritative Chrome-extension model.

The classifier reports that future enforcement would require a canonical
session, but Stage 1D-E1 never blocks or authorizes a live writer.

## Lease/session contract

Schema version 1 records:

- session ID;
- SHA-256 ownership-token hash and short correlation prefix;
- canonical, repository, and worktree roots;
- branch and approved HEAD;
- whether HEAD is main or an ancestor of main;
- optional approval reference;
- purpose and lane;
- PID, process-start identity, hostname, and boot identity;
- acquisition, heartbeat, and expiry timestamps;
- heartbeat counter;
- shared build timestamp and ISO value;
- session-specific staging directory names;
- expected extension output;
- lifecycle state.

The default TTL is four hours. Expiry marks a lease eligible for evidenced
force recovery; it does not delete, release, or replace the lease. A boot
identity mismatch similarly marks the lease stale without releasing it.

Before acquisition, all caller-controlled strings and absolute paths, the
expected extension destination, TTL, build timestamp and canonical ISO,
process identity, Git eligibility, and the complete immutable lease record are
validated in memory. Only then does acquisition create the shared anchor if
necessary and perform:

```text
mkdir(<anchor>/active-lease, recursive=false)
```

`EEXIST` means another owner holds the lease. The lease directory persists
after the acquiring process exits. Release is an explicit authenticated
lifecycle action. Every initialization operation after the exclusive `mkdir`
is inside one cleanup boundary. Failure after directory creation, temporary
metadata creation, metadata publication, or final readback validation removes
only bytes belonging to that acquisition and leaves the anchor reacquirable.
Unexpected residue is preserved for explicit recovery rather than recursively
deleted.

Status distinguishes `absent`, `held`, `stale`, and `corrupt`. Missing
metadata, malformed JSON, invalid schema, non-regular metadata, or unexpected
initialization residue is `corrupt` with integrity exit code 15. Corrupt state
is never auto-released.

Lease and approval normalization takes one own-property descriptor snapshot,
rejects accessors and unexpected or inherited containers, validates only the
fresh data-property snapshot, does not mutate caller input, and returns a
deeply frozen clone.

## Token model

Acquisition generates at least 32 random bytes. Only its SHA-256 digest is
stored. The plaintext capability is returned once to the caller and is never
written to lease metadata, approval records, audit evidence, receipts, or
status output. Logs and status may expose only a short digest-derived
correlation prefix.

This token is a capability and correlation mechanism. It is not a same-user
security boundary: another process running as the same account may inspect
memory, process arguments, environment variables, change permissions, or
bypass an unwired library. Supplying a token through argv or the environment
can therefore expose it to same-user operating-system inspection. Redaction
prevents application-level persistence and logging; it does not prevent that
operating-system-level observation. The design provides coordination and
fail-closed evidence, not hostile-user isolation.

## Eligibility

The default policy requires:

- the authoritative repository and worktree root;
- a HEAD equal to main or proven to be an ancestor of main;
- no arbitrary unapproved branch publication.

An ordinary caller-supplied ancestry boolean is not trusted. The eligibility
boundary verifies the publisher HEAD and main ref through executable Git and
runs `git merge-base --is-ancestor` itself.

The explicit pre-merge-canary policy requires a separate, unexpired approval
record. The record binds exact commit, exact worktree root, purpose, lane,
approver, and expiry. Any HEAD, worktree, purpose, or lane drift fails.
Subsequent provenance must identify such output as a non-main approved canary.

## CLI boundary

The enabled foundation commands are:

```text
acquire
status
verify
renew
release
force-release
approve-canary
```

They use strict unique arguments, JSON output, and the documented exit-code
contract. Stage, promote, rollback, filesystem locking, and receipt publication
are deliberately unavailable.

Success and failure each produce one JSON response on stdout. Stderr is
reserved and currently unused by the CLI; callers must evaluate both the exit
code and JSON body.

During the proof-only foundation phase, `acquire`, `renew`, `release`, `force-release`, and
`approve-canary` require `--ack-foundation-real-anchor` before they may mutate
the default shared anchor. Sandbox overrides remain explicitly acknowledged
with `--allow-root-override`. `status` and `verify` remain read-only. This
temporary foundation guard must be reviewed before operational canonical
publication is enabled.

Force recovery requires a bounded reason and evidence. A live valid lease can
never be force-released. A stale valid lease audit preserves a redacted prior
lease snapshot including ownership context, HEAD, lane, timestamps, build
marker, lifecycle and staging names. A corrupt-state audit preserves bounded
directory inventory, malformed-metadata digest or parse failure, evidence
digest, and actor/process context. Audit publication must succeed before the
lease directory is removed; audit failure leaves it intact.

## Stage E2A alias-writer guard

Stage E2A is source-only, direct pre-mutation enforcement for
`tools/loader/make-aliases.mjs`. It adds a reusable canonical-write guard that
imports E1 destination, anchor, lease, token, eligibility, expiry, and session
verification logic instead of copying it.

For a `LOCAL` alias destination the guard returns an immutable result with no
canonical session and permits existing token-free behavior. It neither creates
nor reads a canonical lease for authorization. This preserves ordinary
worktree-local alias generation, including direct and compatibility symlinks,
linked foreign-worktree-local generation, and output entirely outside a
repository.

For a `CANONICAL` destination, diagnostics fail closed in this order: lease
absence, token validity, expiry, repository/worktree/HEAD/session eligibility,
and caller assertions such as the shared build marker. Environment values for
session ID, approved HEAD, and build timestamp are assertions only; the
verified lease remains authoritative. The writer token is supplied through
`H2O_CANONICAL_DELIVERY_TOKEN`, remains subject to the same-user observation
limitations above, and is never returned or logged by the guard.

The selected canonical owner, not caller `cwd`, supplies the anchor passed to
lease status and verification and the repository/worktree/branch/HEAD identity
expected from the lease. This closes the independently demonstrated case where
`H2O_SRC_DIR` named unrelated repository B while `H2O_SERVER_DIR` named
repository A's canonical server. A lease under B's anchor cannot authorize A,
and a valid lease under A reaches the same E2 terminal rejection regardless of
the unrelated caller context.

Even a fully valid lease cannot authorize a live canonical alias mutation in
E2A. The guard returns path-coupling exit code 16 with
`canonical-live-write-disabled-until-stage-e3`. This rejection occurs before
the alias writer's first `mkdirSync`, cleanup, unlink, symlink, or copy. Stage
E3 must provide a verified staging destination before canonical writes can
become possible. The authoritative worktree's normal default canonical alias
build is therefore intentionally blocked during E2. This correction closes
the caller-controlled-`cwd` classification bypass specifically; it does not
claim global live-delivery exclusivity while other writers remain unwired.

Only `make-aliases.mjs` imports the guard in E2A. Proxy, loader, bridge, and
extension writers remain unintegrated. Historical copies of any writer remain
unprotected until E3 activates and proves the destination permission floor.
Live enforcement is therefore incomplete, Stage 1D remains blocked, and the
promotion primitive remains unresolved and rejected.

## Why a lease alone is insufficient

Historical builders do not yet consult the lease. A valid lease therefore
cannot stop an old `mkdir`, unlink, copy, symlink, temporary-file rename, or
whole-directory replacement.

Temporarily unlocking the live tree during a build is also insufficient. The
validator coordinates a publisher and a historical foreign temp-file-plus-
rename child, opens the writable window only after both report ready, and
requires a foreign write to remain after the floor is restored. Extending the
lease does not close that path.

`chmod` and `uchg` are useful anti-accident destination controls. They are not
same-user security boundaries, and neither replaces staging or validation.

The immediate containment direction is to leave accepted live content locked
while all ordinary build activity writes to a session-specific staging tree.

## Publication window and unresolved primitive

The intuitive promotion:

```text
live -> retired
staging -> live
```

has a missing-path interval. During that gap a historical writer can run:

```js
mkdirSync(live, { recursive: true });
writeFileSync(path.join(live, "foreign"), bytes);
```

The Stage 1D-E1 sandbox validator deliberately hammers that exact interval. It
observes a takeover and the second rename can no longer claim the canonical
name. The two-rename primitive is therefore unsuitable as currently defined.
A zero-hit probabilistic run would not have established a mathematical
guarantee; this validator instead requires the takeover to remain visible.

Every validator-spawned child has an overall timeout, captured stdout and
stderr, awaited close, deterministic `SIGTERM`, and `SIGKILL` escalation when
needed. A dedicated hanging-child scenario proves the child is terminated and
reaped. Runtime acceptance uses an exact scenario count rather than a floor;
the corrected E1 suite is fixed at 81 runtime and 12 scope scenarios.

Before live promotion is implemented, independent evidence must accept one:

1. a true atomic exchange primitive on supported macOS;
2. a pointer/symlink switch with no missing canonical path and proven
   Chrome/`serve.py` compatibility;
3. a fail-closed two-rename protocol that proves exact historical operations
   cannot claim the path, detects any attempted takeover, reverses it before
   validation can succeed, and prevents receipt or canary publication.

## Future receipt ordering

The planned receipt is:

```text
apps/dev-server/dev_output/provenance.json
```

It must be published only after promotion and production-byte validation:

```text
stage -> promote -> validate -> receipt -> independent review -> canary
```

Validation failure must reverse or quarantine the candidate before any receipt
or browser canary can exist. A receipt is evidence of accepted bytes, never a
pre-authorization for a candidate.

## Rollout

1. **E1 — foundation:** lease, classifier, CLI, ADR, and sandbox proofs.
2. **E2A — alias-writer guard:** preserve token-free local aliases and reject
   direct live canonical aliases before mutation, even with a valid session.
3. **E2B — remaining writer plumbing:** make every remaining generated writer
   classify its destination without yet enabling live publication.
4. **E3 — staging and permission floor:** keep live content unchanged while
   session output is generated and validated in staging.
5. **E4 — promotion primitive:** independently accept atomic exchange, pointer
   promotion, or a demonstrably fail-closed reversible protocol.
6. **E5 — provenance and recovery:** publish receipts only after validation,
   exercise rollback, expiry, reboot, and force-release evidence.
7. **E6 — activation:** independent delivery review followed by a narrow
   browser canary.

Stage 1D remains blocked until staging publication and operational tests 3, 4,
and 19 are implemented and independently accepted.

## Consequences

- The repository gains one shared, versioned coordination model.
- Local development remains unrestricted.
- Canonical enforcement is explicitly not enabled by this ADR alone.
- Lease state stays outside source and survives process exit.
- Pre-merge canonical publication becomes possible only through an explicit,
  expiring, exact approval.
- The known two-rename gap remains an open gate rather than an accepted
  implementation.
