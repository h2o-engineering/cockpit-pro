# Studio Reader resume continuity contract (M02)

Status: M02 P1 T2 regression baseline. Future behavior described here is not
implemented by this document or its validator.

Canonical authority:

- `h2o-engineering/cockpit-pro-management/missions/establish-reader-resume-and-position-continuity/t01-reader-resume-contract-freeze.md`
- `h2o-engineering/cockpit-pro-management/missions/establish-reader-resume-and-position-continuity/t01-capture-point-reconciliation-accepted.md`

The reconciliation supersedes only T1's route-leave capture timing. All other
accepted T1 architecture remains controlling.

## Scope and predecessor

M02 owns page-lifetime continuity for a saved-chat Reader session when a current
render is replaced, the Reader route is left and reopened, or presentation
changes rebuild the rendered root. It does not own durable persistence, Sync,
generic Anchors, Renderer identity, Shell structure, Ribbon structure, MiniMap
state, or a new Reader runtime module.

The accepted M01 session/navigation contract is an immutable predecessor. M02
consumes M01's current-root and navigation rules. An old root, old Semantic
Index, late render, foreign root, or detached root can never regain authority.
Equivalent same-root reuse remains `PRESERVED` under M01.

## ReaderResumeRecord

The future Reader-owned record has this exact logical shape:

```text
ReaderResumeRecord
  content   { chatId, snapshotId }
  render    { renderMode, turnCount }
  selection ReaderTurnRef | null
  viewport  { ref: ReaderTurnRef, fraction } | null

ReaderTurnRef
  projectionKey
  ordinal
  turnNo
  role
  messageId | null
  turnId | null
```

Records are plain, deeply frozen, serializable data. They contain no Element,
Reader root, Semantic Index, DecorationContribution, presentation descriptor,
lifecycle object, or callable. They live only for the current page/application
session.

The ledger has at most 16 chat keys. Capture replaces the entry for the same
key and makes it the most recently captured entry. The least-recently-captured
entry is evicted at capacity. Deletion tombstones are FIFO-bounded to 16 keys.

## Resolution policy

Resolution uses only public Renderer Semantic Index observations and fails
closed when provenance is missing or ambiguous.

### R1 — source identity

Use `messageId` first, otherwise `turnId`. The chat and role must match, and
exactly one current turn must match. If identity produces duplicates, an equal
`projectionKey` may disambiguate only when it leaves exactly one candidate. If
stored identity no longer resolves, the outcome is `NOT_RESTORED`; it never
falls through to R2.

R1 is the only path that may resolve across snapshot versions of one chat.

### R2 — same-snapshot structural identity

R2 is available only when both stored identity fields are null. All of these
must hold:

- chat and snapshot match;
- `renderMode` and `turnCount` match;
- the current turn exists at the stored ordinal;
- `projectionKey`, role, and `turnNo` match;
- the current turn remains identity-less.

The result is `RESTORED_STRUCTURAL`. Any failed predicate returns
`NOT_RESTORED`. There is no loose ordinal, transcript-text, visual-similarity,
nearest-turn, or private-DOM fallback.

## Outcomes

The complete outcome vocabulary is:

- `PRESERVED`
- `RESTORED_IDENTITY`
- `RESTORED_STRUCTURAL`
- `NOT_RESTORED`
- `CAPTURED`
- `NOT_CAPTURED`

Selection and viewport outcomes are independent. A successful automatic
restore never changes `document.activeElement`. Explicit M01 navigation retains
its existing focus policy.

## Reconciled capture contract

M02 has two disjoint future capture seams.

### Pre-leave capture

For a Reader-to-non-Reader transition, capture occurs at the entry of
`setStudioRouteScope(routeName, opts)`, before `state.activeRoute` changes,
`syncDesktopRibbonHiddenScope` runs, `applyUiState` runs, `body[data-route]`
changes, or `.wbMain` scroll/layout changes.

The entry is eligible only when a current Reader binding exists, the current
active route is Reader, and the normalized destination is non-Reader. Its
capture reasons are:

- `studio:route-scope:list`
- `studio:route-scope:library`
- `studio:route-scope:migrate`
- `studio:route-scope:settings`

This is a conditional Application-Shell-owned implementation seam. Direct
future mutation requires G7 authorization under
`EXT-SHELL-READER-M02-TRANSITION-HOOKS`. T2 grants no Shell authority and does
not create the hook.

### Discard-funnel capture

`studioHostUnmount(reason)` may capture only `studio:reader-replace`.

These later route funnels are `NOT_CAPTURED` because the correct state was
already captured at the pre-leave seam:

- `studio:list`
- `studio:route-library`
- `studio:route-migrate`
- `studio:route-settings`
- `studio:library-folders-visible-body`

These are also `NOT_CAPTURED`: `studio:reader-missing`,
`studio:reader-error`, `studio:unmount`, `studio:route-leave`,
`studio:route-scope:reader`, test reasons, benchmark reasons, and unknown
reasons.

Reason partition guarantees exactly one logical capture per transition. A
later funnel cannot overwrite the valid pre-transition record. Reader replace
has no pre-leave capture and captures once at the discard funnel.

A successful semantic chat deletion forgets its entry and installs a bounded
tombstone. A later pre-leave call cannot recapture the deleted state. The next
successful bind may clear the tombstone. Any physical deletion hook requires a
fresh G8 semantic-owner check; file location confers no owner authority.

## Restore timing and effects

Restore occurs only after the winning replacement root is connected and
authoritative, its public Semantic Index is bound, the Studio host and Reader
route are current, layout is ready, and the render token remains current.

Selection restoration uses the common Reader publication path without a
duplicate publication. Failed selection resolution publishes coherent Ribbon
nulls: `selectedTurnIdx = null` and `selectedMessageId = null`. A direct future
`renderRoute` change remains within the separately gated Shell package.

Viewport restoration stores the logical turn under the reading line and a
fraction bounded to `[0, 0.9999]`. It issues exactly one
`root.closest('.wbMain').scrollTo(...)` against the current geometry. It does
not use `window.scrollTo`, `scrollIntoView`, a new scroll root, or Shell
structural mutation. Selection, viewport, and focus effects remain independent.

## MiniMap and Renderer coherence

M02 never writes MiniMap resume or active state. The real MiniMap Engine derives
active state from the current viewport and current Semantic Index after rebuild.
`RDR-M02-T1-OBS-001` remains a separate non-blocking observation unless later
evidence proves it blocks acceptance.

Renderer remains authoritative for normalized input, render mode, public
Semantic Index records, projection keys, source references, and current target
geometry. M02 stores observations only. Presentation identifiers and
descriptors are not resume identity. Stable public projection tuples across
equivalent repeated renders are a prerequisite.

## Validator result classes

The M02 validator reports three disjoint classes:

- **CURRENT PRODUCT PASS / PRE** executes current Product seams or unchanged
  owner validators.
- **KNOWN BASELINE GAP / GAP** must reproduce accepted missing behavior. A
  reproduced gap is baseline evidence, not a Product pass.
- **FUTURE POST-T3 FIX EXPECTATION / FIX** executes a visibly labelled
  `EXPECTED POST-T3 CONTRACT MODEL`. It never counts as current behavior.

An unexpectedly fixed gap, failed prerequisite, missing fixture, inconclusive
production seam, determinism failure, or capture-point failure makes T2 fail.

## Baseline vectors

| Vector | Class | Baseline or future expectation |
| --- | --- | --- |
| V-A1 | GAP + FIX | Canonical presentation A→B→A loses selected target and viewport continuity today; future selection/viewport restore independently without focus movement. |
| V-A2 | GAP + FIX | Rich presentation A→B→A has the same baseline and future policy. |
| V-B1 | GAP + FIX | `studio:list` then reopen loses position today; future same-snapshot state restores. |
| V-B2 | GAP + FIX | `studio:route-settings` then reopen loses position today; future same-snapshot state restores. |
| V-B3 | GAP + FIX | A→B→A has no per-chat ledger today; future A and B remain isolated. |
| V-C1 | GAP + FIX | Equivalent target survives while route Ribbon publication erases selection today; future publication remains coherent. |
| V-C2 | GAP + FIX | An unresolvable rebuild does not explicitly clear stale Ribbon selection today; future publication nulls both fields. |
| V-D | PRE | A new binding clears the M01 current-render navigation target. |
| V-E | PRE + FIX | Unrelated roots cannot inherit selection; a future ledger is chat/snapshot isolated. |
| V-F1 | GAP + FIX | Identity-less same-snapshot rebuild loses continuity today; future result is `RESTORED_STRUCTURAL` with null message identity. |
| V-F2 | PRE | Identity-less content across a newer snapshot is `NOT_RESTORED`. |
| V-G1 | PRE | Deleted stored identity is `NOT_RESTORED`. |
| V-G2 | PRE | Duplicate identity unresolved after projection-key filtering is `NOT_RESTORED`. |
| V-G3 | PRE | Role or structural invariants changed is `NOT_RESTORED`. |
| V-G4 | FIX | Every route-scope and funnel reason is classified and every current route funnel is dominated by its pre-leave scope transition. |
| V-G5 | FIX | Delete forgets, tombstones, blocks recapture, and permits clear on a later successful bind. |
| V-H1 | PRE | A stale render-token completion has no authority. |
| V-H2 | PRE | Detached or reattached stale roots cannot regain authority. |
| V-H3 | FIX | Records are deeply frozen, plain, serializable, and root-free. |
| V-I | PRE + FIX | Explicit M01 navigation focus remains green; automatic restore preserves focus. |
| V-J | FIX | One Shell `.wbMain` scroll call; no global/new-root/`scrollIntoView` path. |
| V-K1 | FIX | No direct MiniMap resume/active-state write. |
| V-K2 | PRE | Real MiniMap modules derive current active state through viewport/index behavior. |
| V-L | FIX | Executable R1/R2 table covers unique, ambiguous, missing, changed, unrelated, and absent-current cases. |
| V-M | PRE | Real Renderer tuples are deterministic across modes, profiles, and identity classes; a structural negative differs. |
| V-N | FIX | Ledger/tombstone capacity, replacement, and eviction order are executable. |
| V-O | PRE | M01, lifecycle, presentation, ContentRenderer, Reader/Notes, and M03 extraction consumers stay green. |
| V-P | PRE + FIX | Current geometry plus the reconciled observation probe proves pre-leave/funnel partition, both placements, Library-subscriber ordering, and no probe side effects. |

## T3 gate reference

These gates are planning constraints only. T2 does not authorize T3:

1. G1: T1 and its capture-point reconciliation are accepted.
2. G2: this baseline is accepted with no failed or inconclusive vectors.
3. G3: Authoring sequencing is released or explicitly reordered.
4. G4: fresh Product main is read before T3.
5. G5: no overlapping Reader/Authoring/Renderer/Shell writer exists.
6. G6: Renderer has no pending repair over Reader lifecycle/reuse seams.
7. G7: `EXT-SHELL-READER-M02-TRANSITION-HOOKS` and any Ribbon write receive bounded Shell authorization.
8. G8: the exact write set and deletion owner check are frozen.
9. G9: no runtime module, package, or admission work is required.
10. G10: foreign extraction inventories and source-shape pins remain compatible.
