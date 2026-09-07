# Studio Development Rules

Status: Active
Audience: Anyone writing or reviewing Studio code, including future Claude/Codex sessions.
Companion: `STUDIO_ARCHITECTURE.md`, `STUDIO_PORTABILITY_CONTRACT.md`, `STUDIO_PLATFORM_ADAPTER_GUIDE.md`, `STUDIO_STORAGE_CONTRACT.md`, `STUDIO_CAPTURE_BOUNDARY.md`.

## Purpose

A short, operational set of rules and a checklist that every Studio change must pass. The other contracts say *what* the architecture is; this one says *what to do at PR time*.

## TL;DR For Future Sessions

If you are an AI session reading this for the first time and asked to "add X to Studio," do exactly this:

1. **Read `STUDIO_ARCHITECTURE.md`** to understand what Studio owns vs. what it doesn't.
2. **Check `STUDIO_PORTABILITY_CONTRACT.md` Rules 1–10** for forbidden patterns.
3. **Decide which file(s) the change touches.**
4. **Run through the checklist at the end of this document** before producing the diff.
5. **If anything on the checklist is a "no" on a "must" item, stop and surface the issue** — do not silently produce non-compliant code.

The point of the contracts is that they make refusing the wrong shortcut easy. Use them.

## Quick Decision Tree

```
You need to add a feature to Studio.

Q: Does it need to capture chats from chatgpt.com?
   → YES: This is capture-side work, not Studio. Belongs in src-surfaces-base/desk/ or
          (in the future) the slim capture extension. STOP — wrong surface.
   → NO:  Continue.

Q: Does it need persistence?
   → YES: Use H2O.Studio.store. Add an entity store or a prefs scope per
          STUDIO_STORAGE_CONTRACT.md. Do NOT call chrome.storage / localStorage /
          IndexedDB directly.
   → NO:  Continue.

Q: Does it need to talk to another extension context (service worker, content scripts)?
   → YES: Use H2O.Studio.platform.messaging or platform.broadcast. Do NOT call
          chrome.runtime.sendMessage or chrome.storage.onChanged directly.
   → NO:  Continue.

Q: Does it need to read or write files?
   → YES: Use H2O.Studio.platform.files. Do NOT use Blob+download or <input file>
          directly in feature code.
   → NO:  Continue.

Q: Does it need a CSS selector against the chat replay DOM?
   → YES: Use a constant from selectors.contract.js. Do NOT hardcode
          '[data-message-author-role=...]' or similar in feature code.
   → NO:  Continue.

Q: Does it need to know if the user is signed in?
   → YES: Use H2O.Studio.platform.auth.getIdentity() or H2O.events
          h2o:identity:* listeners. Do NOT call Supabase / OAuth / identity
          providers directly. Auth flows belong to src-surfaces-base/identity/.
   → NO:  Continue.

You are now free to write feature code in pure DOM + H2O.events + H2O.Studio.store.
```

## Lane Boundary Check

Classify the semantic responsibility before treating a shared Studio file as
the owner:

- `L-STUDIO-APPLICATION-SHELL` owns application-frame composition, app-level
  route/view containers, navigation shell, global scroll roots, Desktop
  chrome/safe-area structure, sidebar/rail/stage/topbar structure, and
  Ribbon/Dock host-placement geometry.
- `L-STUDIO-HOST-INTEGRATION` owns `H2O.Studio.platform.*`, MV3/Tauri adapter
  selection, messaging/IPC, filesystem, clipboard, and host runtime bridges.
- `L-COCKPIT-LIBRARY` owns Library catalog/index/search/browse/organization
  meaning and shared Library business contracts; Platform Sync owns
  propagation/convergence and Saved Chats Storage owns archive durability.
- `L-DEVELOPER-BUILD-DELIVERY-SCOPE-STU` owns Studio build, package, stage,
  software/artifact publication, promotion, delivery provenance, activation,
  rollback, recovery, and delivery validation.
- `L-COCKPIT-RUNTIME-KERNEL` retains common Cockpit runtime/kernel semantics;
  Host Integration only adapts them to Studio's environment.

`studio.html`, `studio.css`, `studio.js`, `S0Y1a` Studio Ribbon, shared
Dock/Ribbon surfaces, `platform.tauri.js`, and Desktop Tauri files are shared
hotspots. Give each change one home semantic owner. When another Lane must
touch a hotspot, use a temporary narrow lease for the exact files/slot and do
not claim co-primary ownership.

## Allowed Patterns

Feature code under `src-surfaces-base/studio/` may freely use:

- `document.querySelector`, `document.querySelectorAll`, `MutationObserver` — **against `studio.html`'s own DOM only**. Selectors come from `selectors.contract.js`.
- `H2O.events.emit` / `H2O.events.on` / `H2O.bus.*` for messaging within Studio.
- `H2O.Studio.store.*` for persistence.
- `H2O.Studio.platform.*` for everything platform-dependent (storage low-level, messaging, broadcast, runtime, files, auth).
- Plain DOM creation, CSS, classes, IDs.
- `requestAnimationFrame`, `setTimeout`, `Promise`, `async/await`, `fetch` *for non-persistence remote calls if any* — though Studio has none today.
- Shared `H2O.*` namespace usage (`H2O.util`, `H2O.msg`, `H2O.SEL`, `H2O.runtime.schedule`).
- `W` / `TOPW` for globals shared with the rest of the H2O system (carefully — see Rule 2 of `STUDIO_PORTABILITY_CONTRACT.md`).

## Forbidden Patterns

Forbidden in feature files (anything under `src-surfaces-base/studio/` outside the platform adapter folder):

- `chrome.*` API calls of any kind.
- `localStorage`, `sessionStorage`, `indexedDB`, `idb-keyval`, `idb`.
- `GM_*` Tampermonkey APIs (the GM fallback in `S3H1a` is legacy and not a precedent).
- Hardcoded `chrome-extension://` URLs.
- `chatgpt.com`, `chat.openai.com`, `claude.ai` URLs in fetch/observer/document references.
- `MutationObserver` against `window.top` or any non-`studio.html` document.
- Imports from `src-surfaces-base/desk/` or content-script modules.
- Direct Supabase / OAuth / identity-provider calls.
- Inline migration code that reads or writes legacy storage keys outside the platform adapter's migrations module.

## Naming and Style

- File naming follows the existing repo convention: `S<id>. 🎬 <Name> - Studio.js` for surface modules; `platform/<concern>.js` for adapter modules; flat kebab-case for everything else.
- Globals registered on `H2O` use the existing pattern (`H2O.Library`, `H2O.Studio`, `H2O.events`, `H2O.bus`).
- Event names follow `evt:h2o:<domain>:<action>`; Studio-scoped events use `evt:h2o:studio:<domain>:<action>`.
- Storage keys: do not invent new top-level prefixes. New persistence goes through `H2O.Studio.store`; only the adapter chooses the underlying key shape.

## Desktop Chrome and Sidebar Layout Invariants

These rules are mandatory for Studio Desktop/Tauri titlebar, ribbon, sidebar, and topbar work. They encode the current macOS overlay-titlebar design and must be preserved across Library, Settings, saved-chat lists, and reader/chat transcript routes.

1. The sidebar logo/title row has a fixed viewport position. It must not move when changing route, opening a chat, leaving a chat, showing a ribbon menu, hiding a ribbon menu, collapsing the sidebar, scrolling the sidebar, changing zoom, or opening Settings.
2. The top empty macOS traffic-light area is not a floating overlay attached to the sidebar. When a page has no visible app ribbon/menu strip, the empty space must be structurally owned by the sidebar/right pane surfaces below it, so their backgrounds and divider lines continue naturally from the top of the window.
3. Hidden Library ribbon and hidden reader/chat ribbon must use the same layout model: the Tauri chrome strip is out of normal flow, while the sidebar and right pane reserve their own top-safe space. Do not replace this with a full-width transparent or glass strip above `.wbShell`.
4. The reader/chat title topbar also owns top-safe empty space when the reader ribbon menu is hidden. Hiding the ribbon menu must not pull the titlebar up to the traffic-light row.
5. Visible ribbon menu strips may occupy the top desktop chrome row. Hidden ribbon menu strips must hide the controls without shifting `.wbShell`, `.wbStage`, `.wbRail`, `.wbSide--sidebar`, or the reader title topbar.
6. The vertical divider between sidebar and right pane must be one continuous line from the top of the window through the sidebar. Do not draw a second top-only divider, patch panel, glass layer, or separate block that makes the top segment look different from the rest.
7. The macOS traffic-light buttons stay visible and usable. The top empty/menu area remains draggable with `-webkit-app-region: drag`, and all real controls in that area use `-webkit-app-region: no-drag`.
8. The reader/chat title topbar appears only on reader/chat transcript routes. Library, Settings, migration, and other non-reader pages must not show the reader title topbar.
9. Library and reader/chat ribbon toggle buttons show or hide the ribbon menu strip. They must not resize the title topbar, change sidebar header position, or switch to the unrelated ribbon collapse behavior.

Before changing any of these CSS selectors or route-state attributes, test at least these transitions in Desktop Studio:

- Library with ribbon menu hidden -> Library with ribbon menu shown -> hidden again.
- Library with ribbon menu hidden -> Settings -> Library.
- Library -> reader/chat transcript -> hide reader ribbon menu -> show reader ribbon menu.
- Reader/chat transcript with hidden ribbon menu -> Library -> reader/chat transcript.
- Sidebar expanded and collapsed states for all of the above.

## Pre-Merge Checklist

Run through this before opening a PR or marking a Studio change complete. "Must" items block merge.

### Platform coupling (must)

- [ ] No `chrome.*` references in the diff (outside `src-surfaces-base/studio/platform/`).
- [ ] No `localStorage`, `sessionStorage`, `indexedDB`, or `idb-keyval` references in the diff (outside `src-surfaces-base/studio/platform/` or the adapter implementation).
- [ ] No new direct `chrome.runtime.sendMessage` / `chrome.storage.onChanged` calls.
- [ ] No new hardcoded `chrome-extension://` URLs.
- [ ] No `chatgpt.com` / `claude.ai` / live host-page references inside Studio code.
- [ ] No imports from `src-surfaces-base/desk/`.

### Storage (must if change touches persistence)

- [ ] All new persistence routes through `H2O.Studio.store.*`.
- [ ] New entity records have a `schemaVersion` field.
- [ ] If introducing a new entity store, the conceptual SQLite mapping is documented (one line is fine) in the PR description or `STUDIO_STORAGE_CONTRACT.md`.
- [ ] No giant unstructured JSON blobs when relational modeling fits (chats, turns, snapshots, bindings).
- [ ] Generic UI/pref state uses `H2O.Studio.store.prefs.*`, not `prefs` baked into entity stores.

### Capture (must if change touches capture or reader rendering)

- [ ] Studio code consumes normalized records via `CaptureSource`; it does not scrape live host DOM.
- [ ] Reader rendering uses centralized selectors from `selectors.contract.js`.
- [ ] No new `MutationObserver` targets outside `studio.html`'s own document.

### Messaging (should)

- [ ] In-Studio communication uses `H2O.events`; cross-surface uses `H2O.Studio.platform.broadcast` or `.messaging`.
- [ ] Event payload shapes are stable; if changed, schema bumped.

### Identity (must if change reads or affects user state)

- [ ] Studio reads identity via `H2O.Studio.platform.auth` or `h2o:identity:*` events, not by calling identity providers directly.

### Tauri-readiness sanity (must)

Ask each of these about the change. If the honest answer to any is "would need real work to port to Tauri," call it out in the PR description:

- [ ] Does this feature call `chrome.*` directly? (must be no)
- [ ] Does this feature assume MV3 (service worker, content scripts)? (must be no)
- [ ] Does this feature depend on a live ChatGPT DOM? (must be no)
- [ ] Does this feature store data through `H2O.Studio.store`? (must be yes if it stores anything)
- [ ] Can the storage model map to SQLite tables? (must be yes — entity-shaped or generic-KV)
- [ ] Is capture separate from workspace logic? (must be yes — Studio reads, Capture writes)
- [ ] Is this UI Studio-owned or host-page-owned? (must be Studio-owned)
- [ ] Would this still work in a Tauri WebView with `chrome.*` unavailable? (must be yes)
- [ ] If the answer to the previous is "with a small adapter change," is the change inside `src-surfaces-base/studio/platform/`? (must be yes)
- [ ] If the change touches Desktop titlebar/ribbon/sidebar/topbar CSS, does it preserve the Desktop Chrome and Sidebar Layout Invariants above? (must be yes)

## Examples

### Good: adding a "favorite folders" feature

```js
// In a new S0F3b. 🎬 Favorite Folders - Studio.js file:
(function(){
  async function toggleFavorite(folderId){
    const f = await H2O.Studio.store.folders.get(folderId);
    if (!f) return;
    await H2O.Studio.store.folders.upsert({
      ...f,
      schemaVersion: 1,
      metadata: { ...(f.metadata||{}), favorite: !f.metadata?.favorite },
      updatedAt: Date.now(),
    });
    H2O.events.emit('evt:h2o:studio:folders:favorite-toggled', { folderId });
  }
  // ... UI wiring uses document.querySelector against studio.html DOM
})();
```

Why this passes:
- No `chrome.*`, no `localStorage`.
- Persistence routes through `H2O.Studio.store.folders`.
- Event uses canonical `evt:h2o:studio:*` naming.
- No capture-side concerns.

### Bad: same feature, written incorrectly

```js
// FORBIDDEN — illustrates Rule 1 / Rule 3 violations
(function(){
  async function toggleFavorite(folderId){
    const raw = await new Promise(r => chrome.storage.local.get('h2o:prm:cgx:fldrs:state:data:v1', r));
    const folders = raw['h2o:prm:cgx:fldrs:state:data:v1'] || {};
    folders[folderId] = { ...folders[folderId], favorite: !folders[folderId]?.favorite };
    chrome.storage.local.set({ 'h2o:prm:cgx:fldrs:state:data:v1': folders });
    chrome.runtime.sendMessage({ type: 'folder:favorited', folderId });
  }
})();
```

Why this fails:
- Direct `chrome.storage.local` calls (Rule 1, Rule 3).
- Hardcoded storage key string (Rule 3 — go through StudioStore).
- Direct `chrome.runtime.sendMessage` (Rule 1).
- Blob-shaped mutation instead of relational upsert (Rule 3).

A reviewer rejecting this can point at three rule references; no rewriting from scratch needed.

## When Rules Genuinely Conflict With the Task

If a rule appears to block legitimate work, the answer is *not* to bypass the rule. The answer is one of:

1. **The task belongs on the other side of a boundary.** Move it. (E.g., DOM scraping of chatgpt.com belongs in capture, not Studio.)
2. **The adapter needs a new method.** Add it inside `src-surfaces-base/studio/platform/`, document it in `STUDIO_PLATFORM_ADAPTER_GUIDE.md`, then use it from feature code.
3. **The contract has a gap.** Propose a contract amendment in the PR description. Until the amendment lands, do not ship the bypass.

The contracts are designed to be cheap to follow and to point out misclassified work. Treat a rule conflict as a useful signal, not as friction.

## How Future Claude Sessions Should Read This

When a Studio task lands in a fresh session, the recommended reading order is:

1. `STUDIO_ARCHITECTURE.md` — what Studio is, what it owns.
2. This file (`STUDIO_DEVELOPMENT_RULES.md`) — what is allowed and forbidden, the checklist.
3. The specific companion (`STUDIO_STORAGE_CONTRACT.md`, `STUDIO_CAPTURE_BOUNDARY.md`, `STUDIO_PLATFORM_ADAPTER_GUIDE.md`) that matches the work.
4. The actual code under `src-surfaces-base/studio/` for the relevant feature.

If the task description conflicts with the contracts, ask the user before bypassing. The contracts encode prior decisions; the user is the only authority to amend them.
