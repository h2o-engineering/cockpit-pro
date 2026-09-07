# MECHANISMS RULES — Navigation & Performance Mechanisms Contract

**Status: CANONICAL product/engineering contract. Source of truth.**
**Scope:** Chat Page Dividers · Page Divider Circle · Title Bars · Title-list / mass title-bar collapse · NO ANSWER title bars · MiniMap page dividers · Pagination-backed page collapse · Unmount / hydration behavior · Native TOC Rail · Performance → Mechanisms routing.

This contract exists to stop circular redesigns where one patch violates rules an earlier patch established. **This document is the source of truth for product behavior — not the current runtime implementation.** Where the runtime disagrees with this contract, the runtime is wrong (see “Forbidden Regression Patterns / Runtime Failures To Prove Against”).

**Engineering Lane boundary:** `L-RUNTIME-KERNEL-SCOPE-EXT` owns Extension
module admission, bootstrap, ordering, readiness, activation, and lifecycle
infrastructure. This file governs feature/mechanism semantics owned by their
applicable feature Lanes. Its physical location under `src-runtime-base/` does
not transfer those semantics to Runtime.

A failing debug snapshot is **not** automatically a runtime failure. A snapshot is evidence only when its classification is correct (see §8F): a stacked/rehosted title bar counted as an in-flow duplicate, or an absent active-flash reported as a missing-active-style failure, is a **debug false positive**, not a contract violation. Prove the classification before declaring a failure.

---

## Mandatory Review Before Mechanism Changes

- Any future assistant or implementation task touching Chat Page Dividers, Page Divider Circle, Title Bars, title-list mode, NO ANSWER rows, MiniMap dividers, pagination-backed page collapse, unmount/hydration, Native TOC Rail, or Performance → Mechanisms routing **must review this contract first**.
- Future prompts and reports **must name which contract sections were reviewed**.
- Future implementation reports **must explicitly confirm whether the patch obeys each relevant rule** (see §11 “Required Proof Rules”).
- If a requested change **conflicts with this contract, the assistant must stop and ask for explicit approval** before changing the rule. Rule changes are edits to this file, made deliberately — never implied by a runtime patch.
- Runtime patches **must not reinterpret** Page Divider Circle, Divider Double-Click, MiniMap divider actions, or Title Bar ownership **without updating this contract first**.
- This contract is the source of truth for product behavior, **not the current broken runtime implementation**.

### Current ownership map (update when ownership moves)

| Mechanism | Owner file (src-runtime-base) | Key functions (as of 2026-07) |
|---|---|---|
| Canonical turn/pair ledger | `0A1a.⬛️🧠 H2O Core 🧠.js` | `H2O.turnRuntime.listTurnRecords`, `getTurnRecordByAId/QId/TurnNo` (gap-aware `turnNo`) |
| Chat Page Divider placement | `1A1b.🟥🗺️ MiniMap Core 🧱🗺️.js` | `renderChatPageDividers`, `getPageStartTurnWrapper`, `forcePlaceDividerBeforeTurnWrapper`, `isDividerPassThroughEl` |
| Page circle / title-list / title-intent / title-bar stack | `1C1b.🔴📑 Thread Pages Controller 📑.js` | `S.onDividerDotClick`, `setTitleListMode`, `applyTitleListVisuals`, `syncSyntheticTitleList`, `releaseTitleStackBars`, intent ledger + `resolveDesiredTitleState`, `titleIntentDebugSnapshot` |
| Title bars (creation, text, per-bar gestures) | `1C1a.🟥📛 Turn Title Bar 📛.js` | `DOM_ensureTitleBar`, `DOM_buildBarSkeleton`, `API_AT_buildDetachedBar`, `API_AT_getBar`, `API_AT_setCollapsed`, title cache `MNMP_STATE_TITLES_V1` |
| NO ANSWER bars | `1A1b` (creation via `ensureNoAnswerTitleBar` / `syncNoAnswerTitleBars`), `1C1b` (list participation) | `data-at-no-answer="1"` shells on true orphan user turns only |
| Mechanisms routing | `1C1c.🔴🔀 Outline Mechanisms Router 🔀.js` (config), `0Z1d` Performance Tab (UI), `1C1b.getConfiguredDividerRoutes` (consumer) | `gestureBackend`, `dividerDotClickMode`, `dividerDblClickMode` |
| Pagination windowing / page collapse engine | `0C1a` (engine), `0C1b` (chat adapter) | inline `.cgxui-pgnw-page-divider`s while windowing owns the flow |
| Unmount engine (collapse executor) | `0C2b.⚫️⛰️ Unmount Messages ⛰️.js` | `collapseManyByIds` / `expandManyByIds`, source-tagged manual ledger |
| MiniMap | `1A1b` / `1A1c` / `1A1e` | full-chat map; local-only divider actions |
| Native TOC Rail | `1A1g.🟥🧭 Native Prompt TOC Rail 🧭.js` (+ settings in `0Z1c`) | isolated from the mechanisms above |

---

## Forbidden Regression Patterns / Runtime Failures To Prove Against

These are **not** optional “fix later” items — they are **forbidden runtime states**. Every patch touching these mechanisms must prove it does not produce any of them. Recorded from the rejected Page Divider Circle runtime (do **not** treat the current runtime as the spec):

1. PAGE divider appears **under** the title-list; it must be above it.
2. Title-list uses **fake/cloned row blocks** instead of actual title bars / the real title-bar component.
3. Some **original title bars remain visible below the title-list**, causing duplicates.
4. **TITLE 19 NO ANSWER** is not correctly handled as a normal page title row (skipped in the list, left floating in flow).
5. Some rows show fallback text (`Untitled Answer` / `Answer N`) **when real titles exist**.
6. **Double-clicking a listed title bar** does not yet reliably open/reveal only that one turn.
7. The implementation does not clearly enforce **separation between page-level circle state and individual title-bar state**.
8. Page Divider Circle, title-bar double-click, and Chat Page Divider double-click must remain **separate gestures** — the runtime has repeatedly blurred them.

Each item above is a **forbidden pattern** going forward. A patch that reintroduces any of them fails review regardless of what else it fixes.

---

## 1. Mechanisms Routing Rules

- Control Hub mechanism labels must reflect **real runtime behavior**, not cosmetic labels.
- Master Action Routing must not secretly arm unrelated engines.
- Local DOM and Engine routes may use **different executors**, but the **product contract stays identical**. If the modes differ, document the difference as *executor* behavior, never *product* behavior.
- Every route setting must be debuggable in runtime snapshots (`mechanismRoutes` in the title-intent snapshot).
- No mechanism may do heavy replay, page-wide scans, or DOM mutation on chat open unless explicitly required and proven safe.
- **Default/inert state means:** no DOM mutation, no localStorage writes, no membership scans, no replay storm. “Inert” must be a structural property (an O(1) gate before any work), not a promise.
- Debug snapshots must be read-only (see §8).
- Route settings must not be used to hide broken behavior.

## 1A. Mechanism Option Value & Compatibility Rules

- Every Performance → Mechanisms option must have a clear practical product purpose.
- No option should exist only because it is technically possible.
- If two options create the same user-visible behavior, merge them or explicitly document the difference.
- If an option is unsafe, incomplete, experimental, or dev-only, it must be hidden behind Advanced/Manual mode or disabled.
- Every option must declare, in code comments or docs near its owner:
  - product purpose
  - runtime owner
  - state owner
  - executor path
  - allowed combinations
  - incompatible combinations
  - recovery/reset path
  - required proof
- Incompatible mechanism combinations must not be selectable together unless a safe fallback exists.
- No allowed combination may create content that can collapse but cannot expand (see §1B).
- Mechanism labels must describe **user-visible behavior**, not internal implementation names only.
- Route settings must not be used to hide broken behavior.
- “off” / kill-switch behavior is **dev-only** unless explicitly approved as product behavior.
- User-facing Performance UI should optimize for a premium product: simple, meaningful, safe, and not cluttered with duplicate implementation switches.

## 1B. Mechanism Reversibility Rules

- Every collapse action must have a reliable expand action.
- Every expand action must have a reliable collapse action.
- No mechanism may create a one-way state.
- Title-bar collapse/expand must be reversible for the same title bar.
- Page Divider Circle title-list collapse/expand must be reversible for the same page.
- Chat Page Divider double-click page collapse/expand must be reversible for the same page.
- Global unmount/pagination must not prevent local title-bar/page recovery.
- Reset / Restore this chat’s layout must always recover the chat to a safe normal state (see §11A).
- A mechanism combination is **invalid** if it can hide content but cannot reliably restore it.

## 2. Chat Page Divider Rules

- A Chat Page Divider marks the **start/header** of a page.
- The divider must always appear **above** the first turn / title-stack / title-list of its page.
- PAGE 1 divider sits before the first complete Q+A pair; PAGE N divider sits before PAGE N content.
- A divider must **never** appear after its own page’s first turn, and **never** between a user prompt and its paired assistant answer.
- Divider placement is **identity-based and deterministic**: page-start section by testid/turn-id from the canonical ledger — never `hosts[0]` of a hydrated subset, never sibling guessing. There is exactly **one placement authority** (`getPageStartTurnWrapper` → `forcePlaceDividerBeforeTurnWrapper`); every other module that repairs divider position must resolve through it.
- Divider repair must treat **approved title-list containers/stacks as pass-through** only in the sense of keeping the divider above them (`isDividerPassThroughEl`).
- **Divider double-click is not page focus.** It is page collapse/expand using pagination-backed lightening.
- The divider must remain visible while its page is collapsed (it is the restore handle).
- Divider circle is a separate gesture from divider double-click (§4).
- Placement must be stable during scroll, hydration, unmount, title-list mode, and page collapse/expand.

## 3. Page Divider Circle / Title-List Rules

- Page Divider Circle means **page title-list / mass title-bar collapse-expand**. Not page focus. Not pagination collapse.
- The circle controls **the whole page** (canonical membership), never only visible/hydrated DOM.
- Required result of collapse:

  ```
  PAGE N divider
  TITLE 1  (real title bar)
  TITLE 2  (real title bar)
  …
  TITLE 25 (real title bar)
  ```

  Final page: the actual remaining title bars.
- The list consists of the page’s **real title bars, or the same real title-bar component produced by the Title Bar system’s own factory** — never fake row blocks, never clones.
- **No duplicates**: only one visible instance of each title bar, ever. Originals must not remain visible below the list while it is active.
- NO ANSWER rows are included at their canonical numbers (§6). Numbers never skip.
- Order is **canonical page/title order** (ledger `turnNo`) — never visible-DOM order, never hydration order.
- Rows stay visible and stable while scrolling; hydration/unmount must not add, remove, or reorder rows.
- Expand restores normal page flow and removes every list/hide stamp cleanly (zero `data-*-hidden` / stack attrs left).

## 4. Title Bar & Page Circle Relationship Rules

Page-level title-list state and individual title-bar open/collapse state are **separate layers**:

- Page Divider Circle controls the page-level title-list state; a title bar controls only its own turn.
- After a circle collapse, each listed title bar remains **individually interactive**.
- Double-clicking one listed title bar opens/reveals **only that bar’s own turn**; double-clicking again collapses/hides only that same turn.
- Opening one listed title bar must not expand the page, must not remove the title-list, must not reveal other turns. The page remains in title-list mode.
- A later Page Divider Circle action may reset/supersede individual opened-title overrides (versioned intent beats older overrides).
- Title-bar double-click must never be interpreted as page expand/collapse. Circle click must never be interpreted as opening one title bar.

**The three gestures are permanently separate:**

| Gesture | Meaning |
|---|---|
| Title bar double-click | only this turn |
| Page circle click | all title bars of this page |
| Page divider double-click | whole page collapse/expand (pagination-backed) |

- A title bar must not appear both in the page title-list and in the original flow at the same time. No cloned duplicate + original in-flow bar.

### Same Collapse Authority Rule (Circle = Mass Title Shortcut)

- A Page Divider Circle click that collapses/expands all title bars into the page title-list is **semantically a mass
  shortcut** for applying the same title-bar collapse/expand action to every page member individually.
- Title Bar double-click and Page Divider Circle mass collapse/expand **share the same canonical collapse authority**
  (the engine's source-tagged manual ledger in engine routing; the legacy collapse state in local routing). The circle
  must never create a separate competing collapse pathway.
- Per answer/title, circle collapse is **equivalent to calling the same collapse backend** used by individual
  title-bar double-click — only the **source tag** differs (`answer-title` vs `title-list-row`, §8A).
- **Circle/dot expand is a page-level mass expand:** it is equivalent to applying expand to every title in that
  page. It therefore clears BOTH the `title-list-row` source AND the `answer-title` source for page members — a
  title collapsed individually before the circle action expands with the rest of the page. Each source is still
  removed by its own source-tagged expand call (§8A: every expand call removes exactly one source); the mass command
  is a batch over the same per-title pathway, never a ledger wipe.
- **Circle/dot expand is page-scoped:** it must not clear collapse sources for titles outside the current page, and
  it must not clear unrelated mechanisms (background unmount records, pagination state, wash, titles).
- The code may call this control “circle” or “dot” (`routeChatPageDotClick`, divider dot) — they are the SAME
  control, and every rule here applies to both names.
- **Unhydrated page members** cannot hold a physical engine record (`collapseManyByIds` reports them
  `answer-missing` = deferred, not failed). While a title-list page is active, authoritative page membership carries
  their pending `title-list-row` state and the pages controller re-applies it the moment a member hydrates. After a
  circle/dot expand deactivates the page, hydrating members must come up expanded — no stale re-application. Probes
  must read `getManualCollapsedIds({ source: 'title-list-row' })` as covering **hydrated members only**; the
  under-count is by design, not drift.
- The page title-list stack is an **additional UI projection**, not a different collapse truth.
- **Native rehydration replay treats both sources identically:** if the collapse ledger
  (`manualCollapsedIds` / engine records) says an answer is collapsed, any rehydrated title bar/body **must replay
  the collapsed projection** — regardless of whether the collapse came from an individual title double-click or a
  circle mass activation. A ledger-collapsed answer whose rehydrated bar shows expanded/`editable` state is a
  forbidden runtime state.
- Replay is a **projection** (DOM state on the live bar/body); it must not touch cached fragments. Expanding a
  replayed-collapsed answer flows through the hydration-guarded executor (§8G) as usual.
- **Scope/placement is the only difference between the two gestures:** individual title double-click acts on one
  title in flow; the circle/dot applies the same per-title action to every page member and creates/reveals the
  title-list projection. Neither gesture may gain semantics the other lacks.
- **Gesture liveness:** a visible title bar must always answer its collapse/expand gesture. Handlers resolve the
  **live** message element and answer id **at event time** — wire-time closures and one-shot wiring flags
  (`_collapseWired`-style guards) must never pin a gesture to a detached node. Every ensure/repair pass re-wires
  identity idempotently; a replayed-collapsed bar whose double-click does not route to the canonical executor is a
  forbidden runtime state.
- **Shared row treatment:** an individually collapsed in-flow title bar and a page title-list row are the SAME
  component from the same skeleton factory and receive the same numeral, active-styling, and washer/gold treatment.
  Washer paint is applied only through the 1A2a executor (`applyToTitleBar`) for both contexts; rehydration that
  rebuilds a bar must re-project its wash, never fork a second styling path.

### Single Visible Instance Rule

- There must be **exactly one visible title bar instance** for each page title member.
- If a title bar is visible in the page title-list stack, its original in-flow instance must not also be visible.
- Duplicate title bars are forbidden **even if one is “real” and one is “relocated”** — the rule is about visible instances, not about which element is canonical.
- The stack owner must actively dedup: any bar recreated in flow for a stacked member is removed on the next repair pass.

### Active / Selected Title-Bar Styling Rule

- A title bar moved into page title-list mode must preserve the same active/selected styling it has in normal flow.
- If TITLE N is the active/current answer title bar (e.g. MiniMap navigation flash/highlight), it must keep the same gold/yellow active styling in the title-list stack.
- The title-list must not visually downgrade active title bars; styling must not depend on whether the title bar is in normal flow or title-list mode.
- **Active/current styling must follow the visible title bar instance.**
- **If the normal in-flow title bar is hidden/rehosted, the active/gold/yellow styling must move to the stacked visible title bar.**
- **Active/gold styling must never remain only on a hidden duplicate or removed flow bar.**
- **MiniMap active state and the visible stacked title-bar active state must not contradict each other.**
- **If no active/flash state currently exists, debug proof must report that clearly (e.g. `activeFlashState: none`) instead of producing a false failure** (see §8F).

### Faded Title Number Rule

- A title bar moved into page title-list mode must preserve the small faded side-number visual language used by normal collapsed title bars (the `data-h2o-turn-num` `::before` numeral).
- The stack must not drop the faded number marker and must not replace real title-bar numbering with a different visual system.
- Title bars in page title-list mode must use the **same faded-number design language as the large faded answer/question numbers, scaled down** for title bars.
- The number must appear as a **left-side faded marker, visually aligned** with the title-bar row.
- Title-list mode must not invent a different number style.
- If the title bar is rehosted into the stack, its faded number visual must **move with the visible title bar**.
- The faded number must remain **stable during scroll, hydration, unmount, collapse, and expand**.

### Divider/Stack Unit Rule

- The PAGE N divider and the PAGE N title-bar stack form one ordered unit: `[divider][stack]`.
- The divider placement repair owns the unit: whenever it places or moves a divider, it must re-anchor that page’s stack container immediately after the divider in the same pass. Two repair systems with different cadences must never be able to leave the stack above the divider.

## 5. Title Bar Rules

- Only **one visible title bar per page member/turn state**.
- A complete Q+A pair is **atomic**; the **assistant answer owns the title bar** for a complete pair.
- A user prompt must not get a NO ANSWER title if a paired assistant answer exists. NO ANSWER is only for a true orphan/unanswered user turn.
- Title **numbers are stable** (canonical pair number, gap-aware) and title **order is canonical** — never derived from currently visible hydrated DOM.
- **Real title text is preferred over fallback.** `Answer N` / `Untitled Answer` only when no real title is known anywhere (hydrated bar text → persisted title cache → ledger metadata). Once a real title is known it must never regress to fallback.
- Title bars must not flicker to wrong numbers during hydration/scroll.
- Title bars must not be duplicated when moving into a page title-list; a bar inside title-list mode keeps its own individual behavior (edit, per-turn open/close).
- A title bar must not become a page-control button.

**Collapse scope — the pair is the unit:**

- Title-bar collapse/expand for a complete Q+A pair controls the **whole pair**: the user question **and** the assistant answer.
- It is **invalid** for title-bar collapse to hide only the assistant answer while leaving the paired user question exposed.
- The assistant answer **owns** the title bar, but the **collapse scope is the complete Q+A pair**.
- For a true NO ANSWER / orphan user turn, the NO ANSWER title bar controls **only that unanswered user turn**.
- Title-bar state must be **independent** from page-level state, but both must **resolve safely when combined** (see §8A source-based ledger, §8B compatibility matrix).

## 6. NO ANSWER Rules

- NO ANSWER appears only when a user turn has no assistant answer; a paired turn must never show it.
- NO ANSWER rows **participate in title-list mode**: if TITLE 19 is NO ANSWER, the page title-list contains `TITLE 19 NO ANSWER` at position 19 in canonical order.
- The original in-flow NO ANSWER bar is hidden while title-list mode is active and **restored on expand** — never left floating below the list.
- NO ANSWER rows follow the same divider/list/title interaction contracts as normal title bars unless explicitly stated otherwise.

## 7. Title-List Row Interaction Rules

- Double-clicking a title bar inside the page title-list opens/reveals **only that specific turn** — not the page, not other turns, and it does not remove the title-list.
- The opened row is marked as manually opened/overridden (durable, identity-keyed override; survives scroll/rehydration).
- Double-clicking the same row again collapses/hides only that same turn.
- The next Page Divider Circle action may supersede/reset the manual override.
- **Single-click behavior must be explicitly defined if implemented.** Single-click must never accidentally trigger page-wide behavior. (Current definition: single click on a stacked bar does nothing page-scoped; the bar’s own title-edit affordance may apply.)

## 8. Hydration / Unmount / Performance Rules

Evidence baseline (probe 2026-07-07): ChatGPT keeps **all turn sections in the DOM with stable `data-turn-id`s** while message bodies hydrate/unhydrate (69 sections, 5 hydrated, 64 zero-height shells; message nodes churn during scroll; zero section churn).

- Features must not rely only on visible hydrated DOM. Use **canonical turn/page/title membership** (`turnRuntime` records, gap-aware `turnNo`).
- **No page-wide scans on chat open. No localStorage write loops on chat open.**
- Resolver paths must never treat a default state (`expanded, rev 0`) as a DOM mutation command — default answers are read-only data.
- Debug snapshots must not create DOM, attrs, title bars, dividers, or localStorage entries, and must not trigger repair/replay. Membership reads inside snapshots must not route through side-effectful row builders (`getRows`/`buildChatPageAnswerRows` **creates** NO ANSWER bars — it is not a read).
- Mutation observers must ignore their own mutations (owner-attr filters, reentrancy guards, applied-state no-op keys).
- **Wrapper compression and shell-placeholder strategies are risky** (they fight `--last-known-height` reservation) and require explicit review + approval before use.
- Any feature working with title bars under hydration must **prove** rows do not appear/disappear while scrolling; any feature using cached titles must **prove** real titles do not regress to fallback.
- Hot read APIs (e.g. `isCollapsed`) may consult cross-module state only behind an O(1) cached gate — a storage read or membership scan per call is a freeze regression (this happened; see git history of the title-intent Stage 1 freeze).

## 8A. Source-Based Collapse Ledger Rules

- Collapse state must be **source-based**, not stored as one shared boolean.
- Every collapse write must carry a **source**.
- Every expand must remove **exactly one source**.
- **Source-less expand is forbidden** except inside an explicit full reset.
- `sources.clear()` is reserved for reset / Restore this chat’s layout only (see §11A).
- Page title-list collapse must use its **own source**, not the same source as manual title collapse.
- Manual title collapse, page title-list, page collapse, background unmount, and pagination windowing must **not overwrite each other**.

**Required source families:**

| Source | Meaning |
|---|---|
| `manual:title` | User double-clicks one title bar. |
| `page:title-list` | Page Divider Circle shows the page as a title-list. |
| `page:collapse` | Chat Page Divider double-click collapses/lightens the page. |
| `background:unmount` | Background optimization unmounts far content. |
| `pagination:window` | Pagination/windowing owns out-of-window content. |

**Resolution rules:**

- A turn is hidden if it has **one or more active sources**, or if it is background-unmounted / out-of-window.
- Removing `page:title-list` restores only rows whose **sole** source is `page:title-list`.
- A manually collapsed row must remain collapsed after page title-list is turned off.
- Double-clicking a row inside title-list creates/clears a **per-row exception** without clearing unrelated page sources.
- Page expand must restore page hosts, **then** re-apply surviving manual/title-list sources.
- Global unmount and pagination must be **transparent optimizations** and must not erase user collapse sources.

## 8B. Mechanism Compatibility Matrix Rules

Every mechanism pair must be classified as exactly one of: **allowed** · **allowed with guard** · **allowed with ordering** · **mutually exclusive** · **dev-only** · **forbidden**.

Required matrix rows (each must carry a classification and, where relevant, its guard/ordering):

| Mechanism pair | Classification (fill/keep current when implemented) |
|---|---|
| Title local collapse × Title engine collapse | mutually exclusive (one resolved backend per gesture) |
| Title collapse × Page title-list | allowed with ordering (§8A: independent sources) |
| Title collapse × Page collapse/detach | allowed with guard |
| Title collapse × Global Unmount | allowed with guard (transparent optimization) |
| Title collapse × Global Pagination | allowed with guard (transparent optimization) |
| Page title-list × Page collapse/detach | allowed with ordering |
| Page collapse CSS-hide × Global Unmount | allowed with guard |
| Page detach × Global Pagination | allowed with ordering |
| Global Unmount × Global Pagination | allowed with guard |
| Routing legacy × Global engines | allowed with guard (executor only) |
| Routing off × anything | dev-only |
| MiniMap local collapse × everything | allowed (local-only, §9) |
| Reset × everything | allowed (reset wins; §11A) |
| Streaming turn/page × unmount/detach/mass-collapse | forbidden unless proven safe (§8E) |

- **One resolved backend per gesture.**
- Guarded combinations must **document the guard**.
- Forbidden / dev-only combinations must **not** be normal user-facing options.

## 8C. Mechanism Ownership / One Executor Rules

- Each mechanism must have **one clear owner** for: state · DOM placement · repair/replay · visual styling · event handling · persistence · reset/recovery.
- **No two scripts** may independently create, preserve, move, or reveal the same title bar.
- **No two scripts** may independently decide divider/list order.
- **No two scripts** may independently hide/release original page flow.
- **One gesture, one executor.**
- If the router returns `handled:true`, the legacy fallback must **not** also execute.
- If a bridge/reconciler runs after an engine action, it may reconcile **visuals only**; it must not re-hide/re-expand what the engine owns.
- Divider and title-list stack are **one placement unit**: `[divider][stack]` (see §4 Divider/Stack Unit Rule).
- Scroll/hydration repair must **not undo** page-circle / title-list state.

## 8D. Legacy State / Persistence Safety Rules

- Legacy collapsed / title-list / localStorage keys must **not silently arm** newer engines on chat open.
- Reading old state must **not write** new state unless a user action or explicit migration requires it.
- Migration must be **versioned, bounded, and reversible**.
- Default expanded rev 0 is **read-only data**, not a DOM mutation command.
- Persistence must be **per-chat** for user collapse state.
- Page collapse driver/mode must persist with the page collapse state, **or** the product must explicitly declare the behavior as CSS-only.
- Refresh must restore the **same mechanism semantics**, not a lookalike.
- Stale state must not cause open-chat freeze, replay storms, hidden content, or random collapse resurrection.

## 8E. Streaming / Generation Safety Rules

- A streaming turn and its page must **not** be detached, background-unmounted, mass-collapsed, or page-collapsed unless explicitly proven safe.
- If a user tries to collapse a page containing an active streaming turn, the action must **defer or show a temporary blocked/finishing state**.
- Streaming protection must apply to: Page Divider Circle · Chat Page Divider double-click · Global Unmount pass · Pagination/windowing pass · reset/recovery flows.
- **No mechanism may break an active generation stream.**

## 8F. Debug Snapshot Classification Rules

- Debug snapshots must classify visible title bars by ownership/location: `inStack` · `inFlow` · `hiddenFlow` · `detached/unmounted` · `placeholder`.
- A stacked/rehosted title bar must **not** be counted as an in-flow duplicate.
- A stacked/rehosted NO ANSWER title bar must **not** be counted as an in-flow NO ANSWER leak.
- Snapshot fields must distinguish: **visible duplicate** · **hidden original** · **stacked visible instance** · **debug-only false positive**.
- Snapshot reads must **not** create NO ANSWER bars, title bars, dividers, stack containers, attrs, or localStorage entries.
- A snapshot failure is only a runtime failure when its classification is correct; a mis-classified stacked bar or an absent-flash reading is a **debug false positive**, not a contract violation.

## 8G. Native Virtualization Ownership Rules

Native reference baseline (2026-07-11 captures, extension disabled, pollution gate clean): ChatGPT itself is a
**measured virtual list** — all turn shells persist with stable testids inside reserved-height wrappers
(`--last-known-height`), while message bodies hydrate/unhydrate from **app state** (2–19 of 69 bodies live at rest;
114 body nodes added in one scroll pass; bodies are re-rendered by the app, never restored from cached DOM).

- **Native ChatGPT owns the physical message-body lifecycle. H2O owns semantic layout / navigation / projection
  state** over stable shell/turn identity (testids, message ids, the gap-aware turn ledger).
- Default mechanisms must **NOT detach, reparent, replace, or reconstruct native message bodies or turn shells.**
  The only approved exception is an explicitly approved, **hydration-guarded collapse executor** acting on a bounded,
  user-triggered gesture (title-bar / page-circle collapse).
- A hydration-guarded executor must check the live hydration state of a body **before re-attaching any cached
  content**: if native re-rendered the body, cached fragments are discarded and only state is reconciled. Restoring a
  cached `DocumentFragment` into a body native already re-rendered is a forbidden pattern (duplicate-content class).
- **Physical Unmount** (body-fragment caching) and **physical Pagination** (whole-turn windowing /
  `replaceChildren` over native turn nodes) are **Advanced/dev-only** mechanisms, **off by default**, and must be
  structurally inert while off. They must never be presented as normal product options (§1A).
- **Display-hide of shells/wrappers** (attribute/style level) is the approved default physical primitive: native
  hydration continues to own hidden bodies harmlessly, and reserved-height measurement stays intact.
- H2O must never act as a **second virtualizer** over native-owned bodies: no background body detachment, no shell
  swaps, no restore of cached DOM without owning the data needed to reconcile it.

## 9. MiniMap Rules

- MiniMap always represents the **full chat/page structure**, regardless of virtualization, collapse, unmount, reset, or restore.
- MiniMap **turn count and page boxes** must always represent the **full chat**, not only hydrated or visible turns.
- Title-list mode, page collapse, title collapse, unmount, pagination, reset, and restore must **never remove MiniMap boxes** from the full-chat representation.
- MiniMap may **visually mark** collapsed/unmounted/page state, but it must **not lose the underlying full turn/page structure**.
- MiniMap-origin actions must remain **local-only** unless a future task explicitly changes the contract.
- Chat-origin page ops may propagate **one-way** to MiniMap only where contracted (Chat → MiniMap).
- MiniMap Page Divider direct actions are **local-only**; they must not mutate Chat Page Divider state unless explicitly approved.
- Never use MiniMap behavior to hide Chat Page Divider or title-list bugs.
- MiniMap divider actions and Chat Page Divider actions remain separate unless a task explicitly changes this contract.

## 9A. Ordered Chat → MiniMap Page Propagation (Option A)

**Status:** specification ADOPTED; product implementation LANDED in the working tree and gated
GREEN, not yet committed. `1C1b` owns a monotonic per-page Chat revision (`…:ui:chat-pages:rev:…`)
and stamps it on every Chat → MiniMap push; `1A1b` keeps a `:v2` per-page record
(`c` collapsed, `ar` applied revision, `lc` local-change-since) and applies a push only when the
revision is newer than `ar`. `1C1b` binds `evt:h2o:minimap:shell-ready` and replays the Chat
snapshot through `1A1b.reconcileOnMiniMapReady`, which recovers a push dropped while MiniMap Core
was unavailable. Gate:
`tools/validation/chat-atlas/validate-chat-atlas-minimap-page-collapse-directional-flow.mjs`.

**Surface scope.** These ordered-propagation rules govern the **Chrome / ChatGPT runtime surface
only** (`1C1b`, `1A1b`). Behavioral parity for the Studio MiniMap surface
(`src-surfaces-base/studio/S1A1b`) is **explicitly deferred** to a separately governed Studio-lane
assessment, and nothing in this section may be read as asserting or requiring Studio compliance.

For each `(chatId, pageNum)`:

- A Chat collapse or expansion **action** propagates to the corresponding MiniMap page, and it is
  the *action* that advances the ordering revision, not a change in Chat's stored boolean. A user
  who re-collapses a page in Chat must outrank a MiniMap-local expansion even though Chat's own
  value never moved; only a reconciliation **re-assert** re-reads the current revision without
  advancing it. `1C1b` names its three re-assert sources literally
  (`chat-pages-controller:refresh`, `chat-pages-controller:title-set`, `reset-all-mechanisms`);
  every other source is an action.
- A later **direct MiniMap action** changes MiniMap only, persists locally, and must never write
  Chat Page Divider state (§9, and the Chat → MiniMap one-way rule).
- Refresh, route change, rebind, remount and reconciliation **must preserve** that newer
  MiniMap-local choice when **no newer Chat action** has occurred. Re-asserting current Chat state
  merely because Chat still holds a value is **forbidden** — that is continuous Chat authority,
  which this section replaces.
- A later meaningful Chat action **overrides** the older MiniMap-local choice.
- A Chat action taken while MiniMap Core is **unavailable** must be **recoverable** once MiniMap
  becomes available; it must not be lost, and recovery must not require polling or an unbounded
  retry loop.
- Collapse and expansion are **symmetric**.
- One Chat action produces **at most one** effective MiniMap transition — no bounce, recursion or
  amplification.
- `chatId` and `pageNum` identity remain **exact** across every hop.

**Ordering, not value comparison.** Distinguishing "a newer Chat action" from "the same Chat state
re-asserted by a refresh" requires ordering state, because a Chat sequence that collapses then
expands returns to its original value while still being newer than an intervening MiniMap-local
action. Value comparison alone cannot express this contract.

**Legacy state.** Pre-existing MiniMap collapsed-page state is **preserved as local**. It must not
be aligned destructively to Chat on first run; the first subsequent Chat action overrides it in the
normal way. Migration reads the legacy `:v1` key once and writes the `:v2` record with `ar = 0` and
`lc = true`; the `:v1` key is **left untouched** so a rollback needs no repair.

**Forbidden reverse writer (both surfaces).** No MiniMap module — Chrome or Studio — may call a Chat
page-collapse writer from any MiniMap action, handler, observer, callback or reconciliation path.
Compatibility definitions and exports may exist, but the count of MiniMap-origin internal call sites
is **zero**. This rule applies to `1A1b` and `S1A1b` alike and is independent of the Studio
behavioral deferral above.


## 10. Native TOC Rail Rules

- Native TOC Rail is **separate** from MiniMap Core (own module `1A1g`; settings via Control Hub).
- Do not modify Native TOC Rail while fixing Page Divider / Title Bar mechanisms unless the task explicitly says so.
- Rail placement must not be used as a workaround for divider/title-list bugs.
- Rail logic stays isolated from MiniMap Core except through a thin, explicit bridge if needed.

## 11. Required Proof Rules

Any future patch touching these mechanisms must report:

- Which contract sections were reviewed.
- Which files/functions own the changed behavior.
- Before/after runtime proof (DevTools snippets or operator smoke).
- Whether open-chat inert state remains safe (no freeze, flat counters).
- Whether divider order is correct (divider above its page’s content/list).
- Whether title bars are duplicated (must be no).
- Whether NO ANSWER rows are handled (listed at canonical numbers, hidden in flow, restored on expand).
- Whether title-bar double-click opens only that turn.
- Whether Page Divider Circle still controls the whole page title-list.
- Whether Chat Page Divider double-click still controls pagination-backed page collapse/expand.
- Whether MiniMap direct actions remain local-only.
- Whether the debug snapshot is read-only.
- Whether `.gitignore` and `references/` were untouched.
- Whether nothing was staged or committed unless explicitly requested.

### Mechanism Combination Proof Rules

Any patch touching mechanism routing, title bars, page dividers, title-list, unmount, or pagination must prove:

**Inert open-chat:**
- no freeze · no DOM mutation · no localStorage writes · no membership scans · no replay storm.

**Page Divider Circle:**
- divider above stack · expected title count listed · real title bars/components used · no duplicates below stack · NO ANSWER included in order · active/gold styling preserved · faded side numbers present · scroll stability.

**Title-bar double-click:**
- normal flow: toggles the **whole Q+A pair** · inside title-list: opens/reveals **only that turn** · page remains in title-list mode · other turns remain collapsed · no duplicate title bars appear.

**Chat Page Divider double-click:**
- collapses/expands the page · does **not** become page focus · divider remains visible as restore handle · MiniMap remains complete.

**Combination tests:**
- title collapse × page title-list · title collapse × page collapse · title collapse × global unmount · title collapse × global pagination · page collapse × global unmount · page detach × pagination · reset × mixed state · streaming turn/page guard.

**Performance:**
- large chats must not freeze · mass operations must be chunked if needed · no listener growth after repeated chat switches · debug snapshots are read-only.

## 11A. Reset / Safe Mode Rules

- **Restore this chat’s layout** must clear **all** mechanism families:
  - manual title collapse
  - page title-list
  - page collapse
  - detached hosts
  - background unmount placeholders
  - pagination/windowing projections
  - MiniMap-local collapsed page set
  - stale hide/rehost attrs
- Reset must restore normal DOM flow and leave:
  - zero title-list stacks
  - zero duplicate title bars
  - zero hidden/rehost stamps
  - zero unmounted placeholders
  - zero detach comments
  - zero stale MiniMap-local collapse state
- Reset must **not** depend only on in-memory driver/mode maps.
- Reset must work after mixed states, refreshes, scroll/hydration, and mode switches.
