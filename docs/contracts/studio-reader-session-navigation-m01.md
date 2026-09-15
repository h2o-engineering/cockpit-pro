# Reader M01 session/navigation regression floor

T1 baseline: Product `f2a434c8ad457f82136f0a3668e5ab5d82c2036c`.
This records current behavior and future acceptance vectors. It does not implement
T2/T3/T4 or declare Mission acceptance.

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
| Selection | Real delegated click handler on real canonical/rich DOM, both role orders: user and assistant turns publish stable 1-based `selectedTurnIdx`, preserve existing Ribbon context, and move one selection outline. Interactive descendants and non-turn clicks are ignored. |
| Dock compatibility | Real accessors follow A → B → closed with `snapshotId`, `chatId`, `source`, `eligible`; visible saved-editor fallback is retained. Highlights consumer is neither loaded nor changed. |

Lifecycle storage/host collaborators are the existing owner's small test seams.
The browser fixture extracts the named Reader functions verbatim from `studio.js`
and loads the real Renderer chain. It stubs host mount, Ribbon storage, overlay,
top-offset and edit lookup collaborators; it does not boot the full Studio app.
MiniMap control coverage loads all six real modules in `studio.html` order in a
separate empty Reader container; no MiniMap implementation is stubbed.

### RDR-LIVE-001 — known selection identity gap

Rich assistant fixture: outer `[data-turn="assistant"]` has no message ID;
the index-linked inner message host has `a-1`; Reader publishes turn 2 and
`selectedMessageId: null`. The fixtures additionally reproduce the same gap in
canonical projection and for user turns, including reversed role order.

**T2 promotion:** replace the null diagnostic with
`selectedMessageId === selectedMessage.sourceRef.messageId` for both roles in
both projections. Resolve the clicked turn via the current index's turn `target`,
then `messageKey` → `getMessage()`. Preserve the 1-based Reader position while
index `ordinal` remains zero-based. Do not derive identity from private DOM
nesting or treat a projection key as a durable message ID. Missing source identity
remains null; reject foreign/stale render targets without guessing.

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

### Additional T1 observation — RDR-M01-T1-OBS-001

Loading the real modules over populated Renderer content exposed `ReferenceError:
rt is not defined` in MiniMap Core's `buildCanonicalTurnCollection` (the `if (rt
&& answerId)` branch). The permanent diagnostic boots the healthy control fixture,
inserts the real rich transcript, then reproduces the error through
`core.rebuildNow()`. It reports `ok:false`, `status:"error"` and the `rt` diagnostic.
This is distinct from RDR-LIVE-002. T1 changes no Core implementation. Supervisor
disposition is needed before adding that repair to later work; boot/toggle PASS
does not certify populated navigation or full live application health.

## Future T3 navigation contract — behavior pending

One Reader path accepts a current-render target `{ currentRendererRoot,
projectionKey }`; `goTo`, `next` and `previous` all resolve through that path.
Use the existing index's `turns()`, `getTurn()` and linked `getMessage()` records.
There is no duplicate transcript index, new generic Anchor meaning, or durable
reading-position persistence. Projection keys are valid only with their render.

The validator carries explicit two-turn vectors: go-to second, next first→second,
previous second→first; with no selection, next starts at first and previous at
last. Boundaries do not wrap. Missing keys, foreign/discarded roots and disconnected
targets are no-ops with no selection, focus, scroll or notification side effects.
T3 must execute these vectors against its real service, including a discarded
root that reuses the same key. T1 only checks fixture references in the real index.

Proposed deterministic policy: default focus goes to the resolved target using
`preventScroll`; explicit preserve-focus leaves the active element unchanged.
Default scrolling is immediate (`auto`), with nearest block/inline alignment;
smooth motion requires explicit opt-in and becomes immediate under reduced motion.
Apply scrolling only within the Shell-supplied scroll root, with no structural
changes to `.wbMain`, route containers, Ribbon or Dock. Test policies with focus,
scroll and notification spies in T3, then verify them in the integrated New UI.
Publish one coherent selection/session update per accepted transition; retain
the current Reader accessors and refresh-event compatibility.

## Proposed later write-sets (not authorization)

Paths below are repository-relative. The validator and this contract remain
Reader-owned and accompany each task's assertion/contract promotion.

| Task | Exact proposed production files and semantic home | Leases |
| --- | --- | --- |
| T2 | `src-surfaces-base/studio/studio.js`: Reader-owned delegated selection inside `buildReaderDOM`; consume the existing index linkage. | No Renderer lease required for consumption. Any Renderer DOM/index change would require a new bounded Renderer lease and is not proposed. |
| T3 | `src-surfaces-base/studio/studio.js`: Reader-owned current-session navigation/focus/scroll policy and compatibility accessors. `src-surfaces-base/studio/S1A1c. 🎬 MiniMap Engine - Studio.js`: Reader-owned semantic target dispatch into that path. | No lease needed for these Reader seams. Shell lease only if structural scroll-root/route/host geometry must change; Runtime admission and Build list leases only if a new runtime module is proposed. None is proposed. |
| T4 | `src-surfaces-base/studio/S1A1d. 🎬 MiniMap Shell - Studio.js`: Reader-owned MiniMap control semantics/keyboard access. `src-surfaces-base/studio/S1A1e. 🎬 MiniMap Skin - Studio.js`: Reader-owned control affordance/focus styles. | No Application Shell lease needed for control-local changes. The filename “MiniMap Shell” does not transfer semantic ownership to Application Shell. Any global placement/geometry change requires a Shell lease. |

Each task also proposes exactly
`tools/validation/studio/validate-studio-reader-session-navigation-m01.mjs` and
`docs/contracts/studio-reader-session-navigation-m01.md` (Reader).
`S1A1b. 🎬 MiniMap Core - Studio.js` is excluded from these proposed write-sets
pending Supervisor disposition of RDR-M01-T1-OBS-001.

Renderer M04 was clean at `efb0dcb0cd5901de04d1101bf0d99116fc7aa66b`, with seven
Renderer-local implementation/documentation/validation files changed from this
baseline. T1's two new paths do not collide. M04's planned Reader integration
touches `buildReaderDOM`, binding/reuse and presentation refresh in `studio.js`;
recheck before T2/T3 and serialize overlapping edits under the exact owner lease.
No M04 delta is absorbed. RDR-LIVE-003 remains outside M01; Highlights, Product
main, Management, PAL, Runtime admission, packaging and publication are untouched.
