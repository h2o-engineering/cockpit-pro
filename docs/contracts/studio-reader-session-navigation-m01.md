# Reader M01 session/navigation regression floor

T1 baseline: Product `f2a434c8ad457f82136f0a3668e5ab5d82c2036c`.
T1 checkpoint: `98f9782dc6231c9ec2c453126eadd8f307d34542` (contract/tests only).
T2 checkpoint: `5a8cf94a76550bedc1f378d771cd4fb037a08bbb` (selection identity).
T3 implements common semantic navigation and repairs populated MiniMap rebuilding.
MiniMap access remains a T4 baseline; Mission acceptance is pending.

## Run and interpret

```sh
node tools/validation/studio/validate-studio-reader-session-navigation-m01.mjs
node tools/validation/studio/validate-studio-renderer-contract-repair.mjs
```

The Reader validator invokes `validate-studio-renderer-lifecycle-idempotence.mjs`
once as a required child suite; no separate rerun is necessary. Chromium is
required. As with other Studio validators, set `H2O_PLAYWRIGHT_MODULE` to a local
Playwright package if it is not resolvable normally; optionally set
`H2O_READER_CHROMIUM` to an installed Chromium executable. Missing browser support
fails the checkpoint; it is never counted as a pass. No package installation,
generated app, server, user profile, saved-chat storage or external page is used.

Output distinguishes:

- **PASSING CURRENT CONTRACT**: executable current behavior.
- **KNOWN BASELINE GAP**: the named defect was reproduced, not repaired.
- **FUTURE POST-FIX EXPECTATION**: acceptance data/available semantic references
  only; the future behavior is pending and excluded from current PASS counts.

## Current contract and evidence

| Seam | Executable floor |
| --- | --- |
| Session / snapshot | Reused owner lifecycle suite: one active snapshot/root; equivalent refresh reuses the mount and publishes fresh snapshot metadata without source mutation; Renderer-visible changes replace it. |
| Async completion | Reused suite: `renderToken` rejects late A after B and after route leave; detached/superseded roots reject deferred work. |
| Discard / reopen | Reused suite: replacement, missing/error loads, route leave and reopen remain single-mounted; cleanup runs once before forgetting the current binding, including cleanup failure. |
| Renderer binding | Real `buildReaderDOM` receives the real Renderer result. Reader retains only the frozen current `{ root, semanticIndex, decorationContributions }` bridge. Accessors return the exact bound objects or null for a foreign root. Renderer owns creation and lifecycle implementation. |
| Selection | Real delegated click handler on real canonical/rich DOM, both role orders: user and assistant turns publish the linked source message ID and stable 1-based `selectedTurnIdx`, preserve existing Ribbon context, and move one selection outline. The full interactive ignore list and non-turn clicks do not republish. Missing identity stays null; stale/foreign targets cannot update selection. Edit Mode preserves selection classes and single-click editor invocation. |
| Dock compatibility | Real accessors follow A → B → closed with `snapshotId`, `chatId`, `source`, `eligible`; visible saved-editor fallback is retained. Highlights consumer is neither loaded nor changed. |

Lifecycle storage/host collaborators are the existing owner's small test seams.
The browser fixture extracts the named Reader functions verbatim from `studio.js`
and loads the real Renderer chain. It stubs host mount, Ribbon storage, overlay,
top-offset and edit lookup collaborators, and spies on editor invocation without
mounting the Authoring editor; it does not boot the full Studio app.
MiniMap control coverage loads all six real modules in `studio.html` order in a
separate empty Reader container, then mounts real canonical/rich Reader content.
The runtime-unavailable rebuild is checked before loading the existing real
`S0A1a` H2O Core for paired-turn and Engine integration checks. No MiniMap or
turn-runtime implementation is stubbed. API wrappers observe calls and forward
to the real Reader implementation. This is an isolated browser fixture, not a
claim of full integrated New UI acceptance.

### RDR-LIVE-001 — T1 gap, repaired by T2

At the T1 checkpoint, the rich assistant fixture's outer
`[data-turn="assistant"]` had no message ID; the index-linked inner message host
had `a-1`; Reader published turn 2 and `selectedMessageId: null`. T1 reproduced
the same gap in canonical projection and for user turns, including reversed
role order. That historical null diagnostic is superseded, not retained as a
successful target expectation.

**Current T2 contract:** the handler calls `getReaderSemanticIndex(root)` at click
time, finds the turn record whose `target` is exactly the clicked turn, follows
`messageKey` → `getMessage()`, and publishes the linked `sourceRef.messageId`
(normalized to a trimmed string). The existing 1-based Reader position remains
independent of the zero-based index ordinal. No Renderer DOM or index code changes.

The eight role/projection/order vectors now assert
`selectedMessageId === linkedMessage.sourceRef.messageId`. Four missing-ID
vectors assert null even with nonempty projection keys and planted DOM ID decoys.
Six mismatch vectors cover old detached/reattached roots with identical source
IDs, a foreign cloned turn inside the current container, a foreign index under
the current root, a detached current root, and a discarded binding. Unmatched
turns, missing linked records and disconnected targets return before Ribbon,
selection-class or editor side effects. Legitimate current messages without source
identity still select with null. Four Edit Mode vectors preserve existing classes
and invoke the current snapshot's editor exactly once per eligible click.

### RDR-LIVE-002 — control function healthy, access defective

All six MiniMap modules report ready; real Core replaces the Kernel stub; Shell
mounts; the actual bound toggle's programmatic click expands and collapses.
Default collapsed-on-boot is intentional. Collapsed opacity computes to `0.15`;
the outer toggle has no `aria-label` or `title`, is a `DIV` without a control role,
and has `tabIndex: -1`. These are objective reproduction of the live
discoverability/accessibility finding, not a new screenshot acceptance claim.

**T4 promotion:** keep intentional default collapse and the working engine.
Replace the access diagnostic with a nonempty accessible-name assertion,
pointer hit-testing/click, sequential Tab focus plus Enter/Space activation,
visible focus indicator, and expanded-state correspondence. Verify a clearly
visible collapsed affordance in the current New UI without requiring hover.
Do not reduce discoverability acceptance to a particular numeric opacity.

### RDR-M01-T1-OBS-001 — T1/T2 gap, repaired by T3

T1/T2 reproduced `ReferenceError: rt is not defined` during populated
`core.rebuildNow()` in `buildCanonicalTurnCollection`. T3 adds exactly one local
binding: `const rt = getTurnRuntimeApi()`. That existing Core accessor obtains
`H2O.turnRuntime`; no new runtime, membership authority or global fallback is added.
The existing numbering priorities remain runtime `turnNo`, pagination
`answerIndex`, then existing row/fallback fields.

Real populated canonical/rich rebuilding now returns `ok:true`, `status:"ok"`,
with buttons built and no diagnostic errors, including with runtime unavailable.
With the real H2O Core, an unanswered first turn remains turn/button 1 and the
following true Q+A pairs remain 2 and 3. This preserves Core membership and
numbering; Reader message positions still count each user/assistant separately.

## T3 implemented Reader navigation contract

The frozen `H2O.Studio.readerNavigation` API exposes:

```js
const target = { currentRendererRoot, projectionKey }; // a turn key
readerNavigation.goTo(target, { preserveFocus: true, behavior: 'smooth' });
readerNavigation.next(options);
readerNavigation.previous(options);
readerNavigation.targetForElement(currentElement); // target or null
```

`goTo`, `next` and `previous` return true on an accepted transition and false
on a no-op. The optional element adapter resolves an element through the
current index's turn targets/containment, without private Renderer selectors.
It returns a frozen render-scoped target or null. T3 navigates **turn projections**;
message/block/text keys are not accepted as turn keys. No generic Anchor API or
durable reading-position meaning is introduced.

Resolution requires the exact bound root, connected under the current Reader
pane and matching the current Host mount/snapshot. `getReaderSemanticIndex(root)`
resolves `getTurn(projectionKey)` and its linked `getMessage(messageKey)`; both
connected targets must belong to that root and the message must link back to the
turn. Missing keys, foreign/discarded roots, disconnected targets and mismatched
indexes produce no selection, publication, focus or scroll. Reattaching an old
root with the same source IDs and projection key cannot make it current.

Order comes from the current immutable `index.turns()`. Successful clicks and
navigation retain one current `{ currentRendererRoot, projectionKey }` selection.
Binding a replacement and unmounting clear it; equivalent refresh keeps it.
`next` starts at first when unselected; `previous` starts at last. Neither wraps.
All accepted navigation enters `goToReaderTarget`, sharing selection publication
with the delegated click handler. Reader position remains the existing 1-based
`[data-turn]` position; identity remains linked `sourceRef.messageId` or null.
Ribbon fields merge additively exactly once. Edit Mode keeps selection classes
unchanged; delegated clicks still invoke the editor as before.

Default focus uses `focus({preventScroll:true})` before Reader scrolling.
`preserveFocus:true` leaves focus alone. Targets without `tabindex` receive a
bounded `-1` while focused, removed on blur; they never become sequential tab
stops. Existing `tabindex` is preserved. Immediate removal after focus was
rejected by the browser regression because it loses activeElement.

Shell owns `.wbMain`, the actual Reader scroll context in current `studio.css`.
The Host bridge's transcript `data-scroll-root` marker is explicitly styled with
visible overflow on Reader routes. Navigation consumes the enclosing `.wbMain`
without changing structure/styles or discovering alternate ancestors. It computes
nearest block/inline offsets and calls that container's `scrollTo` once. Default
behavior is `auto`; `behavior:'smooth'` is explicit opt-in and reduced motion
forces `auto`. Fully visible targets or targets covering the viewport do not
shift that axis. No transcript `scrollIntoView` or window-scroll fallback occurs.

### MiniMap integration

Engine answer/question gestures, page-divider navigation and public
`setActiveTurnId` enter the same Reader API when installed. Core remains the
source of paired membership, live elements, buttons, numbering and page metadata.
Retained Core elements must map to the current Reader index; stale elements are
rejected even if source IDs repeat. Question resolution uses Core/runtime question
references, or a source-ID lookup in the current Renderer index anchored by a
proven current answer. No question/answer pairing is inferred by Reader ordinal.
The Engine does not materialize, query or independently scroll transcript DOM on
these paths. It retains MiniMap-local active state/centering after acceptance.
The follow-up click from a handled Reader pointer gesture is suppressed to avoid
two Reader publications. Collapse/expand and unrelated controls remain intact.

Executable evidence includes both projections, 22 navigation transition/rejection
vectors, 12 focus/motion vectors, temporary-focus cleanup/discard/reopen, every
T2 selection regression, runtime-unavailable populated rebuilding, real paired
numbering, direct runtime-over-pagination priority/fallback coverage, and real
Engine API/button/page dispatch. The T3 focused checkpoint reports 19 current
contract groups, 1 known baseline, 0 pending T3 fixtures and 0 failures, with the
reused lifecycle suite separately reporting 19/19 PASS. RDR-LIVE-002 remains a named
baseline diagnostic; no T4 access success is claimed.

## Task write-sets (T3 implemented; T4 pending)

Paths below are repository-relative. The validator and this contract remain
Reader-owned and accompany each task's assertion/contract promotion.

| Task | Exact proposed production files and semantic home | Leases |
| --- | --- | --- |
| T2 | `src-surfaces-base/studio/studio.js`: Reader-owned delegated selection inside `buildReaderDOM`; consumes the existing index linkage. | No Renderer lease required or used. Any Renderer DOM/index change would require a new bounded Renderer lease and is not proposed. |
| T3 | `src-surfaces-base/studio/studio.js`: Reader-owned current-session navigation/focus/scroll policy and compatibility accessors. `src-surfaces-base/studio/S1A1b. 🎬 MiniMap Core - Studio.js`: Reader-owned populated-rebuild `rt` repair assigned by the accepted T1 Management record. `src-surfaces-base/studio/S1A1c. 🎬 MiniMap Engine - Studio.js`: Reader-owned semantic target dispatch into that path. | No lease needed for these Reader seams. Recheck if the Core repair crosses its navigation substrate. Shell lease only if structural scroll-root/route/host geometry must change; Runtime admission and Build list leases only if a new runtime module is proposed. None is proposed. |
| T4 | `src-surfaces-base/studio/S1A1d. 🎬 MiniMap Shell - Studio.js`: Reader-owned MiniMap control semantics/keyboard access. `src-surfaces-base/studio/S1A1e. 🎬 MiniMap Skin - Studio.js`: Reader-owned control affordance/focus styles. | No Application Shell lease needed for control-local changes. The filename “MiniMap Shell” does not transfer semantic ownership to Application Shell. Any global placement/geometry change requires a Shell lease. |

Each task also proposes exactly
`tools/validation/studio/validate-studio-reader-session-navigation-m01.mjs` and
`docs/contracts/studio-reader-session-navigation-m01.md` (Reader).
The T3 Core delta is one accessor binding. T3 adds no new runtime module and
requires no Renderer, Shell, Runtime or Build lease. T4 still needs only its two
control-local files plus the existing Reader validator and this document.

Renderer M04 was clean at `efb0dcb0cd5901de04d1101bf0d99116fc7aa66b`, with seven
Renderer-local implementation/documentation/validation files changed from this
baseline. T1's two new paths do not collide. M04's planned Reader integration
touches `buildReaderDOM`, binding/reuse and presentation refresh in `studio.js`;
recheck before T3 and serialize overlapping edits under the exact owner lease.
Before T2 mutation, Management `3e22ffba42a0c76e1d4414afc0fc30c93338a6a5`
recorded only a non-binding `EXT-READER-LEASE` recommendation. The final check
at `ea501ca2e72e182c33eeac63a6ba09d10201b10e` records HDA/User authorization,
but the write window remains inactive and Renderer T4 remains Planned pending
Appearance permission and writer coordination. The lease explicitly excludes
the delegated message-selection handler. Renderer's live Product checkpoint
and seven-file delta remained unchanged, with no `studio.js` mutation. No active
overlapping writer was found; T2 uses no Renderer lease.
No M04 delta is absorbed. RDR-LIVE-003 remains outside M01; Highlights, Product
main, Management, PAL, Runtime admission, packaging and publication are untouched.

T3 pre-mutation recheck: Product main `f2a434c8`, Management
`f3ae7fcfce0a0d53022c88f7a46512dddf56a4bd`, Renderer branch `885355fe`.
Renderer T3 is Complete; T4 remains Planned. EXT-READER-LEASE is HDA-authorized
with its writer window inactive; EXT-APPEARANCE-LEASE is not obtained.
The live Renderer worktree is clean and its branch has no `studio.js` delta.
Reader takes only the bounded T3 navigation writer scope. The selection state
reset added beside binding/unmount must be retained when later composing
Renderer M04 integration; its profile/reuse/subscription behavior is not included.
