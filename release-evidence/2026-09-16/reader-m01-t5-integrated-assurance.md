# Reader M01 P3 T5 — Integrated assurance and lease closeout

Date: 2026-09-16. Lane: L-STUDIO-READER.
Result: **READER_M01_T5_PASS**. Recommendation: **T6_READY**.
Scope: explicitly authorized Reader T5 only. T6 has not started. This record
supports a T6 readiness decision; it does not accept the Mission or close AC10.

## Exact basis and synchronization

- Product main rechecked: `cebb5d25099972519ccea38f5c2c3255ae316f10`.
- Management main rechecked: `35e72f5c43f91ec0de9552bc951e66fd60ee84bd`.
- Existing branch: `work/stu-reader-m01-session-navigation`.
- Existing worktree: `/Users/hobayda/H2OCode/products/cockpit-pro/worktrees/h2o-cp-studio-reader-m01`.
- Initial worktree: clean at `6452bcce964b82799b112931bdc0e7fb58c39618`.
- After `git fetch origin` and `git merge --ff-only origin/work/stu-reader-m01-session-navigation`:
  `3b5eac870e1c13770352f42860469ef228f68cc6`, tree
  `4fbd9b3fbb691b20327f759d0d59e21918127445`.
- Composition parent: `b1c2ad512ccdb7b00fa865180c50bec4f7f0f349`, containing
  accepted Reader P2 `6452bcce964b82799b112931bdc0e7fb58c39618`.
- The commit containing this report is the validator/evidence-only T5 checkpoint
  directly on that candidate. All production and core assurance inputs remain
  byte-identical to `3b5eac87`; no alternative integration candidate is substituted.

The live Product-main delta from common base `f2a434c8` contains only the
STAB-03 Library Workspace/Index/Insights/Canonical Services, Tags, Auto Emoji
Title, platform/index.js and platform.mv3.js changes. It has no material Reader,
Renderer presentation, Appearance or MiniMap overlap. No main merge/rebase occurred.

The seven required canonical Management records were read. They are unchanged
between the supplied `703dbc7e` and latest observed `35e72f5c`. The Reader
mission's incoming-lease coordination entry explicitly records SATISFIED,
CLOSED_WRITE_WINDOW_RELEASED and continuing_reader_write_authority=false.
Its older T5 Waiting projection is superseded for execution by the explicit
User instruction and completed Renderer handback.

Renderer's exact `t04-presentation-reader-closeout.md` confirms the candidate,
tree, composition, bounded C/D implementation and closed Reader lease. Later
Management updates accept Build Decision E/R01 and propose Decision F/R02;
they do not change this Reader basis or reopen Reader authority. Decision F is
not authorized. Renderer `9e641de1` changes four Build/verification files only
and is not incorporated here.

## Executed assurance

Commands run from the Reader worktree with Node v25.2.1. Real-browser validators
used Playwright 1.59.1 at
`/Users/hobayda/.npm/_npx/e41f203b7505f1fb/node_modules/playwright` through
`H2O_PLAYWRIGHT_MODULE`. The initial sandbox-only Reader launch was blocked by
macOS Chromium process registration; the authorized native-browser rerun passed.
No skipped browser tier is counted as passing.

| Validator under tools/validation | Result |
| --- | --- |
| studio/validate-studio-reader-session-navigation-m01.mjs | 22 current-contract groups, 0 baseline gaps, 0 failures |
| studio/validate-studio-renderer-lifecycle-idempotence.mjs | 24/24 PASS |
| studio/validate-studio-renderer-presentation-registry-v1.mjs | PASS 9; H2O_REQUIRE_PRESENTATION_REGISTRY_TIER2=1 |
| studio/validate-studio-content-renderer-v1.mjs | PASS 74; H2O_REQUIRE_CONTENT_RENDERER_TIER2=1 |
| studio/validate-studio-renderer-contract-repair.mjs | PASS |
| chat-atlas/validate-chat-atlas-minimap-page-collapse-directional-flow.mjs | 120 assertions; 19/19 expectations; 9/9 negative controls; GREEN |
| reader-notes/validate-reader-notes-mvp-a2a_4-highlight-resolution-consumer.mjs | 32/32 PASS after the bounded reconciliation below |
| reader-notes/validate-reader-notes-mvp-a2a_4-consumer-readiness.mjs | 23/23 PASS after the bounded reconciliation below |
| reader-notes/validate-reader-notes-mvp-a2a_5-reader-root-resolution-probe.mjs | 23/23 PASS; unchanged validator |
| reader-notes/validate-reader-notes-mvp-nv1-annotation-report.mjs | 21/21 PASS; unchanged validator |
| studio/validate-studio-renderer-visual-regression-v1.mjs | PASS 103; baseline update modes disabled |

## Reader consumer pin reconciliation and ownership

Only two existing consumer validators are changed. Reader's Charter assigns
content-consumption/session behavior to Reader while excluding Notes/Authoring,
Knowledge Model anchors and Renderer projection implementation. The modified
assertions concern the Reader render call, read-only current-render binding and
the public Renderer message-root contract used by Reader consumers. No resolver,
annotation, highlight, report, Renderer or other production behavior changes.

Initial highlight-consumer result: 30 passed, 2 failed. Both failures were the
reported historical pins, not semantic regressions:

1. `renderer.render(rendererInput, { getEditOverride })` became
   `renderer.render(rendererInput, { getEditOverride, presentationProfile })`
   under accepted T4 HDA Decision C. The validator now executes the real
   buildReaderDOM function, verifies normalized input, exact edit callback,
   verbatim unknown preference, one render call, exact returned root and one
   binding of the exact result. It no longer prescribes formatting of the call.
2. The old binding key list `[root, semanticIndex, decorationContributions]`
   legitimately gains `presentation`. The executed check still requires a
   frozen bounded record with no extra keys, exact root/index/decorations and
   descriptor identity, null descriptor on replacement without one, foreign-root
   rejection and unmount clearing. Key order and object-literal layout are not
   consumer contracts. All existing read-only/negative behavior checks remain.

Initial readiness result: 22 passed, 1 failed. Its same old render-call pin
masked two additional historical pins:
`wrap.setAttribute(ROLE_ATTR, role)` and
`wrap.setAttribute(MESSAGE_ID_ATTR, String(meta.messageId))`.
Both exist before `35d6da7a`, disappear in that accepted M03 reconciliation,
and are absent on current Product main, the composition parent and T4.
Thus these are pre-existing assertion defects, not T4 production regressions.
The current Renderer writes the public attributes on the message host.
The smallest reconciliation replaces these three pins with the executed Reader
consumer check and the existing Renderer contract-repair validator, which
asserts exact public role/message-ID attributes for canonical and rich output.
No new Renderer implementation expectation or private local-variable pin is added.

Initial downstream probe: 21 passed, 2 dependency failures (consumer/readiness).
Initial NV1: 18 passed, 3 dependency failures (probe/consumer/readiness).
Every failure was inspected; their own behavioral assertions passed.
No production correction or unrelated historical behavior repair was needed.

Disposable, in-memory source mutations detected all six negative controls:
wrong edit callback, dropped preference, wrong render input, copied descriptor,
extra binding internals and foreign-root leakage. A call formatting/property-order
change passed. No production file was modified for those controls.

## Preserved behavior and evidence mapping

The accepted Reader P2 selection handler and these twelve functions are
byte-identical at the composed candidate: isCurrentReaderRoot,
getReaderSemanticIndex, resolveReaderNavigationTarget, getReaderNavigationTarget,
publishReaderTurnSelection, readerNearestScrollDelta, goToReaderTarget,
stepReaderTarget, nextReaderTarget, previousReaderTarget,
disposeReaderRenderDecorations and studioHostUnmount. Removing only T4's added
presentation equality condition makes canReuseReaderDOM byte-identical to P2;
all earlier reuse predicates remain present.

| Reader AC | T5 evidence disposition (not Mission acceptance) |
| --- | --- |
| AC01 | Sufficient: lifecycle 24/24 and Reader 22 groups cover open/equivalent refresh, fresh snapshot publication, replacement/discard, failed/empty loads, stale completions, leave/reopen, current root/index/decorations and disposal before clearing. |
| AC02 | Sufficient: 8 canonical/rich user/assistant/order selections; 4 missing-source-ID cases return null; 6 stale/foreign/detached/discarded cases reject without publication; edit-mode and Ribbon compatibility preserved. |
| AC03 | Sufficient: 22 goTo/next/previous/rejection vectors; populated canonical/rich MiniMap rebuilds; true paired numbering/runtime fallback; Engine answer/question/page-divider dispatch through Reader; duplicate publication suppressed. |
| AC04 | Sufficient: 12 focus/motion vectors; preventScroll focus, preserveFocus, nearest scrolling only within Shell container, immediate default, opt-in smooth, reduced-motion override; temporary tabindex cleanup and selection reset on binding/unmount. |
| AC05 | Sufficient automated evidence: native named MiniMap button; Tab/Enter/Space/pointer; one native click; retained focus; aria-expanded follows panel; default collapse; visible 70x34 hit area, 11.33:1 text contrast, focus-visible treatment and unobstructed independent pins. |
| AC06 | Sufficient: deterministic refresh and Reader/Dock A-to-B-to-closed context; current snapshot on reuse; consumer chain; presentation hydration, unknown/empty preference and stale-completion guards. |
| AC07 | Sufficient: exact Renderer result/index/decorations/descriptor retained read-only; Renderer owns effective-profile resolution, DOM/index/decorations; contract repair and ContentRenderer 74 PASS; no T5 production edits. |
| AC08 | Sufficient: Shell retains route/view/scroll/Dock structure; focus/scroll tests consume its root; MiniMap control-local changes preserved; no structural lease used. |
| AC09 | Sufficient: validator/evidence-only T5 diff; no Authoring, Knowledge Model, Library, Storage, Sync, Host, Runtime or Build responsibility absorbed. |

Presentation registry and lifecycle evidence additionally prove verbatim storage
of every string (including unknown/empty), non-string fallback without coercion
hooks, lazy list-derived selector and missing-registry isolation. Equivalent
effective configuration reuses; committed A-to-B-to-A rebuilds twice; obsolete B
cannot install; hydration is deterministic; route leave cleans up; no prior-root
cache exists. Exactly one application-lifetime subscription retains its unsubscribe
handle; repeated installation is a no-op; only ready/presentationProfile events
enter the guarded refresh path. Other Appearance keys do not refresh Reader.

## Cross-Lane closeout

| Item | Verified state |
| --- | --- |
| RENDERER-M04-T4-READER-LEASE-CLOSEOUT | SATISFIED |
| EXT-READER-LEASE | CLOSED |
| Renderer temporary studio.js writer window | RELEASED |
| Continuing Renderer Reader-write authority | NONE |
| Reader T1-T4 foreign-owner leases used | NONE |
| T4 Application Shell structural lease | NOT REQUIRED / NOT USED |
| Reader Runtime admission | NOT REQUIRED / NOT USED |
| Reader Build admission | NOT REQUIRED / NOT USED |

No Reader-facing temporary execution lease remains open. Renderer R01/Decision E
does not block T5. Renderer R02/AC05b remains separately owned: ContentRenderer
still honestly reports the known summary keyboard-focus observation. No new
Reader dependency was demonstrated. RDR-LIVE-003 remains external/non-blocking;
the Reader/Dock context contract passes and its consumer defect is not absorbed.

## Visual boundary and completion boundary

This run exactly matches the committed environment: macOS arm64 / Darwin 25.6.0,
Chromium 147.0.7727.15, Playwright 1.59.1. Reference and Clean Reader wide/narrow
dark/light cells all match committed baselines: zero differing pixels, repeat
determinism, source/packed parity and all companion fingerprints. The intentional
negative control differs by 54,168 pixels. Both baseline-update modes were off;
no baseline, manifest or environment guard changed. The earlier independent
Linux/Chromium 153 BASELINE_ENVIRONMENT_MISMATCH remains accurate for that run.

These fixtures do not constitute final integrated current-main New UI acceptance.
AC10 remains pending T6 final current-main New UI acceptance. No Mission acceptance
or T6 completion is declared. No Product-main merge, Renderer Decision E absorption,
Management/PAL working-file or commit mutation, publication, activation or release
was performed. Management fetches only refreshed read-only inspection refs.

Raw local logs and disposable source-preservation/negative-control evidence are
in `/private/tmp/reader-m01-t5-evidence/`. The final handback identifies this
checkpoint's commit, tree and confirmed push state.
