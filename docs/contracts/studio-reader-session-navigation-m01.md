# Reader M01 session/navigation regression floor

This is the durable Reader regression contract retained after accepted M01
closure.

```text
M01_STATUS=Complete
M01_ACCEPTANCE=Accepted
M01_CLOSURE=Complete
AC01–AC10=Pass
ACCEPTED_PRODUCT_MAIN=0cb641f9cd78c47f3329b911bd43b74df95ebb64
ACCEPTED_PRODUCT_TREE=fd85208502ea154573ac4821d5c16ff5d2b4eb4b
```

Historical execution checkpoints:

T1 baseline: Product `f2a434c8ad457f82136f0a3668e5ab5d82c2036c`.
T1 checkpoint: `98f9782dc6231c9ec2c453126eadd8f307d34542` (contract/tests only).
T2 checkpoint: `5a8cf94a76550bedc1f378d771cd4fb037a08bbb` (selection identity).
T3 implements common semantic navigation and repairs populated MiniMap rebuilding.
T4 repairs collapsed MiniMap access using a native control and focused browser
evidence. T5 integrated the Reader lineage and T6 completed final current-main
New UI acceptance before HDA/User acceptance and closure.

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

Output categories retained from M01 execution distinguish:

- **PASSING CURRENT CONTRACT**: executable current behavior.
- **KNOWN BASELINE GAP**: a named historical defect was reproduced, not repaired
  at that checkpoint; the accepted post-M01 baseline has zero such gaps.
- **FUTURE POST-FIX EXPECTATION**: acceptance data/available semantic references
  only; any separately authorized future fixture remains excluded from current
  PASS counts. The accepted post-M01 baseline has zero fixture gaps.

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

## Final acceptance and durable ownership boundary

Final isolated current-main New UI acceptance passed on the accepted Product SHA
and tree recorded above. The accepted closure baseline is:

- Reader: **22 current-contract groups, 0 baseline gaps, 0 fixture gaps, 0 failures**;
- Renderer lifecycle: **24/24 PASS**;
- the Shell MiniMap stacking correction is accepted in the tested lineage;
- final native T6 New UI acceptance: **PASS**;
- unresolved HIGH Reader-owned blockers: **none**;
- M01: **Accepted / Complete / Closed**.

Canonical acceptance detail remains in the Management repository rather than
being duplicated here:

- `missions/establish-reliable-reader-session-and-navigation/t06-final-current-main-new-ui-acceptance.md`
- `missions/establish-reliable-reader-session-and-navigation/m01-hda-acceptance-and-closure.md`

Reader navigation remains scoped to the current render and its turn targets. M01
establishes neither a generic Anchor API nor durable reading-position persistence.
Renderer owns projection and Semantic Index construction. Application Shell owns
structural scrolling, routes and chrome. Authoring owns highlights and annotations.
Storage owns durable saved-chat persistence. Sync owns convergence.

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

### RDR-LIVE-002 — historical gap, repaired by T4

T1–T3 reproduced a working toggle behind an effectively hidden access affordance:
collapsed opacity `0.15`, no accessible name/title, and a DIV outside keyboard
order. T4 supersedes that baseline diagnostic with passing browser assertions.
Default collapsed-on-boot remains intentional and unchanged.

The existing `mnmp-toggle` wrapper contains independent pin buttons. Turning
that wrapper into a native button would nest interactive controls. T4 instead
creates one `button[type=button]` (`data-cgxui="mnmp-access"`) inside the wrapper,
as a sibling of the counter and pin row. It covers the same control footprint;
pins remain separately hit-testable. Its native click bubbles to the existing
Shell toggle binding. No keydown/keyup activation implementation is added.

The access button exposes `Show MiniMap navigation` while collapsed and
`Hide MiniMap navigation` while expanded through `aria-label` (also supplied as
its title). `aria-expanded` follows the actual panel's collapsed state through
`setCollapsed`, UI reuse and view visibility updates. The existing panel has no
stable ID, so no `aria-controls` or invented panel ID is added.

Collapsed presentation now shows a readable **MiniMap** label, opaque existing
Studio surface/text colors and a restrained gold border in the existing 72×36
control footprint. The old counter remains available and displays again when
expanded. Pin controls and expanded presentation are retained. The native access
button stays present in both states and receives a gold 2px `:focus-visible`
outline with 3px offset. All styles remain scoped within MiniMap Skin.

The real-module browser fixture proves:

- all six modules, Shell mount and intentional default collapse;
- one native named button, enabled and sequentially Tab-reachable;
- Enter and Space each generate one click and one state transition;
- actual pointer hit-testing and click activation;
- focus-visible matching plus computed outline, with focus retained after toggle;
- accessible expanded state matching real panel visibility;
- visible text, text/background contrast, border, font size, usable hit dimensions,
  viewport containment and unobstructed pin targets without hover;
- programmatic toggle and repeated UI reuse retain one current access control;
- all T2/T3 selection, navigation, populated rebuilding and Engine tests.

The focused T4 checkpoint reported **22 current-contract groups, 0 baseline gaps,
0 failures**, plus the then-current reused lifecycle suite's **19/19 PASS**. This
was bounded browser evidence. Final T6 acceptance later passed in the integrated
current-main New UI across surrounding chrome, actual themes and tested window
sizes; no fixture visibility or hit-target concern remained open.

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
reused lifecycle suite separately reporting 19/19 PASS. That historical T3 baseline is superseded by the T4 access evidence above.

## Historical M01 task write-sets (implemented)

Paths below are repository-relative. The validator and this contract remain
Reader-owned and accompanied each task's assertion/contract promotion.

| Task | Exact implemented production files and semantic home | Leases |
| --- | --- | --- |
| T2 | `src-surfaces-base/studio/studio.js`: Reader-owned delegated selection inside `buildReaderDOM`; consumes the existing index linkage. | No Renderer lease was required or used. Any Renderer DOM/index change would have required a new bounded Renderer lease. |
| T3 | `src-surfaces-base/studio/studio.js`: Reader-owned current-session navigation/focus/scroll policy and compatibility accessors. `src-surfaces-base/studio/S1A1b. 🎬 MiniMap Core - Studio.js`: Reader-owned populated-rebuild `rt` repair assigned by the accepted T1 Management record. `src-surfaces-base/studio/S1A1c. 🎬 MiniMap Engine - Studio.js`: Reader-owned semantic target dispatch into that path. | No lease needed for these Reader seams. Recheck if the Core repair crosses its navigation substrate. Shell lease only if structural scroll-root/route/host geometry must change; Runtime admission and Build list leases only if a new runtime module is proposed. None is proposed. |
| T4 | `src-surfaces-base/studio/S1A1d. 🎬 MiniMap Shell - Studio.js`: Reader-owned MiniMap control semantics/keyboard access. `src-surfaces-base/studio/S1A1e. 🎬 MiniMap Skin - Studio.js`: Reader-owned control affordance/focus styles. | No Application Shell lease needed for control-local changes. The filename “MiniMap Shell” does not transfer semantic ownership to Application Shell. Any global placement/geometry change requires a Shell lease. |

Each task also changed exactly
`tools/validation/studio/validate-studio-reader-session-navigation-m01.mjs` and
`docs/contracts/studio-reader-session-navigation-m01.md` (Reader).
The T3 Core delta is one accessor binding. T3 adds no new runtime module and
requires no Renderer, Shell, Runtime or Build lease. T4 used only its two
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

T4 pre-mutation recheck: Product main `f2a434c8`, Reader `677e863f`, Management
`e9bdae1e39474b95c8656e5b29968b26b0367cce`, Renderer `885355fe`.
No active sibling worktree has a dirty or committed Shell/Skin delta beyond
Product main; no new remote writer to those files was found. Renderer remains
outside these control seams. T4 changes only MiniMap Shell/Skin and the two
Reader evidence files. It requires no Application Shell structural lease and
leaves `studio.js`, Core, Engine, Renderer, Appearance and package/runtime lists
unchanged. Product main, Management, PAL and publication remain untouched.
