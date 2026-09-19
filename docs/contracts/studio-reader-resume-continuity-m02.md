# Studio Reader resume continuity contract (M02)

Status: M02 P2 T3 implemented checkpoint. This document records the bounded
implementation returned for independent Reader verification; it does not claim
Mission acceptance or completion.

Canonical authority:

- `h2o-engineering/cockpit-pro-management/missions/establish-reader-resume-and-position-continuity/t01-reader-resume-contract-freeze.md`
- `h2o-engineering/cockpit-pro-management/missions/establish-reader-resume-and-position-continuity/t01-capture-point-reconciliation-accepted.md`
- `h2o-engineering/cockpit-pro-management/missions/establish-reader-resume-and-position-continuity/t03-bounded-execution-authorization-decision.md`
- `h2o-engineering/cockpit-pro-management/missions/establish-reader-resume-and-position-continuity/t03-execution-validation-packet-preparation.md`
- `h2o-engineering/cockpit-pro-management/missions/establish-reader-resume-and-position-continuity/final-jit-executable-validation-acceptance.md`

The T1 reconciliation superseded only the original route-leave capture timing.
The T2 PRE/GAP/FIX baseline remains useful history: T3 promotes those accepted
expectations into production-executing regression coverage while preserving the
frozen architecture and owner boundaries.

## Scope and predecessor

M02 implements page-lifetime continuity for a saved-chat Reader session when a
current render is replaced, the Reader route is left and reopened, or a
presentation change rebuilds the rendered root. The state is private to
`studio.js`; there is no public `H2O.Studio.readerResume` surface.

The accepted M01 session/navigation contract remains the predecessor. M02
consumes M01's current-root and navigation rules. An old root, old Semantic
Index, late render, foreign root, or detached root can never regain authority.
Equivalent same-root reuse remains `PRESERVED` and performs no restore effects.

This bounded implementation establishes no generic Anchor API and no durable
reading-position persistence. It does not own Sync, Renderer identity, Shell
structure, Ribbon structure, MiniMap state, or a new Reader runtime module.

## Private session state

`state.readerResume` exposes only the private collaborator methods
`remember(reason)`, `restore()`, and `forget(chatKey)`. The controller owns a
page-lifetime ledger and deletion tombstones, each bounded to 16 chat keys.

The implemented record has this exact logical shape:

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
lifecycle object, transient Renderer object, or callable. Capture replaces the
entry for the same chat and makes it most recent; the least recently captured
entry is evicted at capacity. Tombstones are FIFO bounded.

The controller uses no `localStorage`, `sessionStorage`, `chrome.storage`,
IndexedDB, network, Sync payload, or `postMessage` persistence.

## Current binding authority

Capture and restore use only the current Reader binding:

- `state.currentReaderRender` exists and its root is connected;
- the root is contained by `#viewReader`;
- `H2O.studioHost.getReaderRoot()` returns that exact root;
- the active route is Reader;
- `getReaderSemanticIndex(root)` returns the current immutable index.

Content provenance comes from Semantic Index `sourceRef`, never from
`state.currentReaderSnapshot`. No DOM-search identity fallback exists.

## Resolution policy

Resolution uses only public Renderer Semantic Index observations and fails
closed when provenance is missing or ambiguous.

### R1 — source identity

`messageId is primary` when present; otherwise R1 uses `turnId`. The same chat
and matching role are required, and exactly one current candidate must remain.
When the stored reference contains both identifiers and a candidate exposes
both, the secondary identity must also agree.

Duplicate source identity may be disambiguated by equal `projectionKey` only
when the stored and current renders have the same snapshotId and renderMode and
exactly one candidate remains. An unresolved present primary identity returns
`NOT_RESTORED` and never falls through to R2. R1 is the only path permitted
across newer snapshots of the same chat.

### R2 — same-snapshot structural identity

R2 is available only when both stored identity fields are null. All of these
must hold:

- chat and snapshot match;
- same snapshotId and renderMode;
- equal `turnCount`;
- the stored ordinal exists;
- equal `projectionKey`, role, and `turnNo`;
- the current turn is also identity-less.

This is same-snapshot structural identity, not ordinal recovery. Any failed
predicate returns `NOT_RESTORED`. There is no transcript-text,
visual-similarity, nearest-turn, loose ordinal, or private-DOM fallback.

## Capture contract

M02 implements two disjoint capture seams.

### S1 — pre-leave capture

For a Reader-to-non-Reader transition, `setStudioRouteScope(routeName, opts)`
calls `remember()` before `state.activeRoute` changes, Ribbon visibility sync,
`applyUiState`, `body[data-route]`, or `.wbMain` layout changes.

Eligible destination reasons are:

- `studio:route-scope:list`
- `studio:route-scope:library`
- `studio:route-scope:migrate`
- `studio:route-scope:settings`

The call is failure isolated and cannot change normal route behavior. Same-route
Reader transitions are not captured.

### Reader replacement capture

`studioHostUnmount(reason)` calls `remember(reason)` as its first semantic
operation. Only `studio:reader-replace` is eligible. Capture precedes edit
override clearing, decoration disposal, and Reader binding teardown.

Later route funnels, missing/error funnels, unknown reasons, test teardown,
memory teardown, benchmark teardown, and detached bindings are `NOT_CAPTURED`.
That reason partition prevents a later route unmount from overwriting the S1
record.

## Viewport capture

The scroll context is `root.closest('.wbMain')`. The reading line is a constant
120 CSS pixels from the `.wbMain` content-box top and is never derived from
`clientHeight`.

The captured anchor is the last visible semantic turn whose top is at or before
the reading line. A gap selects the preceding visible turn; a line above the
first visible turn selects the first with fraction zero. No usable visible turn
produces a null viewport. The normalized fraction is clamped to
`[0, 0.9999]`. Raw `scrollTop` is never identity.

## Rebuild-only restore

Restore runs only for a real winning Reader rebuild, never for equivalent DOM
reuse. In `renderReader(...)` it runs after the final successful-path
`applyUiState()` and before `evt:h2o:studio:reader-refresh-requested`, after the
current snapshot, connected root, Semantic Index, host, route metadata,
selection/sidebar sync, and `.wbMain` are current.

Selection is restored at most once through the existing M01 Reader selection
publication semantics. A rebuild with no resolved selection explicitly
publishes `selectedMessageId = null` and `selectedTurnIdx = null`. Automatic
restore never changes `document.activeElement` or `tabindex`.

Viewport restoration resolves the logical turn against current geometry and
issues exactly one `.wbMain.scrollTo(...)` when resolved. An unresolved
viewport issues zero scroll calls. It never calls `window.scrollTo`,
`scrollIntoView`, a turns-root scroll method, a timeout, observer, daemon, or
deferred re-anchoring loop. Restore failure is isolated and cannot turn an
otherwise valid Reader render into `reader-error`.

Stale render-token completions have zero restore, publication, focus, and
scroll effects.

## Ribbon coherence

The final `renderRoute` Ribbon context publication remains additive to route,
chat type, snapshot, chat, title, original URL, and read-only context.

For a valid accepted Reader selection it publishes matching
`selectedMessageId` and 1-based `selectedTurnIdx`. An accepted rebuild without
a valid selection publishes nulls. Non-Reader routes cannot retain stale Reader
selection. The existing C1 Format Painter chat/snapshot identity fence remains
foreign-owned and unchanged.

## Deletion invalidation

`executeDeleteChat(...)` calls `forget(chatId)` only after semantic archive
deletion returns `deleted === true` and before edit-override, cache, DOM, and
navigation cleanup. The call is failure isolated. If both deletion attempts
fail, no forget occurs.

Forget removes the ledger entry and installs a bounded tombstone, so a later
route leave cannot recreate deleted state. A legitimate later successful
Reader bind for that chat clears the tombstone.

## MiniMap and owner boundaries

M02 never writes MiniMap resume or active state, creates no MiniMap resume API,
and calls no MiniMap API during automatic restore. MiniMap remains a consumer
of current viewport and Semantic Index state. `RDR-M02-T1-OBS-001` remains a
separate observation.

Renderer owns normalized input, render mode, Semantic Index construction,
projection keys, source references, and target geometry. Application Shell
owns route/view/chrome and the structural `.wbMain` scroll context. Authoring
owns highlights and annotations. Storage owns durable saved-chat persistence.
Sync owns convergence. Reader stores only bounded page-session observations.

## Implemented T3 assurance

The M02 validator executes production seams rather than an assertion-free
model. Its current groups cover:

| Vector | Production assurance |
| --- | --- |
| V-Q1 | Every covered S1 non-Reader route captures before route mutation, including snapshot-null and reading-line gap placement. |
| V-Q2 | Real `studioHostUnmount('studio:reader-replace')` captures before teardown; ineligible reasons do not capture. |
| V-Q3 | Real/extracted `renderReader` restores selection and viewport, uses one Shell scroll, preserves focus, and publishes additive Ribbon state. |
| V-Q3b | A stale render-token completion produces zero restore effects. |
| V-Q4 | Real ledger/tombstone behavior covers deletion success/failure, later bind, and both capacity bounds. |
| V-Q5 | Real/extracted final `renderRoute` publication follows actual Ribbon Shell additive semantics. |
| V-Q6 | Real Renderer Semantic Index fixtures exercise R1, R2, duplicates, newer snapshots, identity-less turns, role mismatch, and fail-closed outcomes. |
| V-Q7 | The production S1 hook proves the former T2 observation-probe limitation is removed. |

The scenario floor also covers canonical and rich rebuilds, rapid A→B→C with B
pending, leave while a same-snapshot load is pending, empty transcripts, one
very tall turn, detached roots, equivalent reuse with zero restore effects,
deletion followed by route leave, and tombstone clearing on a later valid bind.

The mandatory negative control removes the T3 production seam from a controlled
fixture and must show the harness fails. M01 navigation, Renderer lifecycle and
presentation contracts, ContentRenderer, Reader & Notes, Library/Saved Chats,
pack references, long-chat behavior, and memory behavior remain independent
compatibility gates.

## Historical T1/T2 baseline

T1 froze the architecture and owner boundaries. Its accepted reconciliation
moved route-leave capture from late unmount funnels to the beginning of
`setStudioRouteScope`, leaving replacement capture in `studioHostUnmount`.

T2 encoded the missing implementation as PRE/GAP/FIX evidence. Its GAP vectors
documented lost selection/viewport across rebuild and route reopen, absent
per-chat ledger and deletion tombstones, stale/null Ribbon publication, and the
then-unimplemented capture hooks. Those findings are historical and superseded
by the implemented T3 production vectors above; they remain useful provenance
for why each fail-closed rule exists.

The earlier T2 gate list was execution planning, not runtime architecture. T3
entered only after HDA/User authorization, exact Product base/blob checks,
foreign-writer checks, G7/G8 anchor checks, and a bounded three-file writer
reservation. Independent Reader verification still decides acceptance.
