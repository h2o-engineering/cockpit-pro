# Studio Portability Contract

Status: Active
Audience: Anyone adding or modifying code under `src-surfaces-base/studio/`.
Companion: `STUDIO_ARCHITECTURE.md`, `STUDIO_PLATFORM_ADAPTER_GUIDE.md`, `STUDIO_STORAGE_CONTRACT.md`, `STUDIO_CAPTURE_BOUNDARY.md`, `STUDIO_DEVELOPMENT_RULES.md`.

## Purpose

State the rules that keep Studio portable from MV3 extension → Tauri desktop app with the smallest possible rewrite. These rules are binding on all Studio feature code (`src-surfaces-base/studio/`) effective immediately. They do not require touching existing call sites except as opportunistic clean-ups; new code must comply.

## Lane Boundary

The portable host seam is owned by `L-STUDIO-HOST-INTEGRATION`. Feature code
depends on stable Studio ports/contracts; Host Integration selects and binds
the Tauri, MV3, PWA, mock, browser, or operating-system adapter. Common Cockpit
runtime/kernel semantics remain with `L-COCKPIT-RUNTIME-KERNEL` and are not
co-owned by the Studio adapter Lane.

Portability does not collapse other boundaries: Application Shell owns Studio
structural composition and host-placement geometry; feature Lanes own feature
semantics; Cockpit Library owns Library business contracts; Platform Sync owns
cross-surface convergence; Saved Chats Storage owns durable archive
representation; and Build & Delivery owns software packaging and artifact
delivery. A cross-boundary edit to `studio.js`, a platform module, or Desktop
Tauri source uses one semantic home owner plus a temporary narrow lease.

## Migration Targets Studio Must Stay Compatible With

| Target | Hosted by | Storage backend | Messaging | Capture source |
|---|---|---|---|---|
| **Today: MV3 extension page** | `studio.html` in chrome-extension origin | IndexedDB + localStorage + `chrome.storage.local` | `H2O.events` + `chrome.runtime.sendMessage` + `chrome.storage.onChanged` | Live chatgpt.com content scripts → archive bridge |
| **Future: Tauri desktop app** | Tauri WebView | SQLite via `tauri-plugin-sql`, plus app-data files | `H2O.events` + Tauri `invoke`/`listen` | Slim browser extension → native messaging or localhost endpoint |
| **Optional intermediate: PWA** | hosted web app | IndexedDB + OPFS | `H2O.events` + `postMessage` | Slim browser extension → fetch/WebSocket to PWA |

For the contract to hold, **the same Studio feature code must run in any of these three with only adapter swaps**. That is the standard a change is judged against.

## Rule 1 — No Direct Platform APIs in Feature Code

Studio feature files (any file under `src-surfaces-base/studio/` except the Platform Adapter modules listed in `STUDIO_PLATFORM_ADAPTER_GUIDE.md`) **must not** reference any of the following directly:

| Forbidden API | Replacement |
|---|---|
| `chrome.runtime` | `H2O.Studio.platform.messaging` / `H2O.Studio.platform.runtime` |
| `chrome.storage.local` / `chrome.storage.sync` / `chrome.storage.session` | `H2O.Studio.store` (StudioStore) for persistence; `H2O.Studio.platform.broadcast` for cross-surface signaling |
| `chrome.storage.onChanged` | `H2O.Studio.platform.broadcast.subscribe` |
| `chrome.tabs` | `H2O.Studio.platform.runtime.openUrl` |
| `chrome.runtime.sendMessage` / `chrome.runtime.onMessage` | `H2O.Studio.platform.messaging.send` / `messaging.subscribe` |
| `chrome.runtime.getURL` | `H2O.Studio.platform.runtime.resolveAsset` |
| `chrome.scripting`, `chrome.action`, `chrome.contextMenus` | Out of scope for Studio; if you need them, the work belongs in the capture extension or the platform adapter, not in feature code |
| `localStorage`, `sessionStorage` | `H2O.Studio.store` (with appropriate scope: durable vs session) |
| `indexedDB`, `IDBDatabase`, `idb-keyval` | `H2O.Studio.store` |
| `GM_*` (Tampermonkey legacy) | `H2O.Studio.store` (the GM fallback in `S3H1a` is legacy and should not be reproduced) |
| `unsafeWindow` (Tampermonkey) | Use `window`/`TOPW` directly (we are not running in Tampermonkey; see CLAUDE.md correction) |
| `fetch('/api/...')` for persistence | `H2O.Studio.store` if local; an explicit `H2O.Studio.platform.sync` adapter if remote (today there is no remote sync) |
| `window.open()` for OAuth or external links | `H2O.Studio.platform.runtime.openUrl` |
| Hard-coded `chrome-extension://` URLs | `H2O.Studio.platform.runtime.resolveAsset(path)` |

The Platform Adapter is the only module that may touch these APIs. Everything else goes through it.

## Rule 2 — Studio Does Not Capture

No file in `src-surfaces-base/studio/` may query, scrape, or observe the **live chatgpt.com DOM**. Studio code may only query `studio.html`'s own DOM (which is shaped by the Studio reader to be ChatGPT-attribute-compatible). The boundary is enforced by origin in practice today; the rule is restated so it survives a future move to Tauri where the WebView might technically be cross-loadable.

Concretely:

- Studio decoration engines (`S1A1*` MiniMap, `S1A2a` Wash, `S1A3a` Highlight Dots, `S3H1a` Highlights Engine, `S2*` question/answer decorators, `S1X1a` Answer Numbers, `S1Z1a`/`S2Z1a` Timestamps) operate on **Studio-rendered DOM** with ChatGPT-compatible data attributes.
- Studio receives normalized chat records via the CaptureSource interface (see `STUDIO_CAPTURE_BOUNDARY.md`).
- ChatGPT-attribute selectors used by Studio reader/decorations are declared in a single selector-constants module (`SELECTORS.contract`); feature code references those constants, not string literals.

## Rule 3 — Storage Goes Through StudioStore

All persistence in Studio feature code routes through `H2O.Studio.store`. The façade is small (entity-level CRUD + queries) and the backing implementation is replaceable.

Bad (forbidden in new feature code):

```js
// scattered direct calls — these are the patterns we are firewalling
chrome.storage.local.set({ ['h2o:prm:cgx:fldrs:state:data:v1']: bigBlob });
localStorage.setItem('h2o:studio:ui-prefs:v1', JSON.stringify(prefs));
const db = await idb.openDB('h2o.library.studio', 1, ...);
```

Good:

```js
await H2O.Studio.store.folders.upsert(folderRecord);
await H2O.Studio.store.chats.bulkUpsert(chatRecords);
const prefs = await H2O.Studio.store.prefs.get('library:ui');
```

Schemas are defined in shared domain models (`@h2o-studio/types`). Records have an explicit `schemaVersion` field. Mappings from each entity to the current Chrome-side implementation and to a future SQLite schema are documented in `STUDIO_STORAGE_CONTRACT.md`.

## Rule 4 — Messaging Uses `H2O.events`; Cross-Surface Uses `platform.broadcast`

Within Studio's runtime, modules communicate via `H2O.events.emit` / `H2O.events.on`. The bus is defined in `S0A1a` and is platform-agnostic.

For cross-surface broadcasts (today: between `studio.html` and the chatgpt.com content scripts via the service worker), feature code uses `H2O.Studio.platform.broadcast` — never `chrome.storage.local.set` for the heartbeat key, never `chrome.runtime.sendMessage` directly. `S0F1h` Library Sync is the canonical example of broadcast plumbing and is itself adapter-backed today.

Event-name conventions are unchanged:

- Canonical: `evt:h2o:<domain>:<action>` (e.g., `evt:h2o:inline:changed`)
- Studio-scoped: `evt:h2o:studio:<domain>:<action>` for events that should never reach non-Studio listeners

Payload shapes must be stable. Add fields; do not rename or repurpose existing ones without a schema version bump.

## Rule 5 — Selectors Are Centralized

Studio's reader is allowed to render chats using ChatGPT-compatible data attributes (`data-message-author-role`, `data-testid="conversation-turn"`, `data-message-id`). But every selector that uses these attributes must come from `SELECTORS.contract` (to be created — see `STUDIO_DEVELOPMENT_RULES.md` next steps). Feature code may not embed literal `'[data-message-author-role="assistant"]'` strings.

Today there are dozens of such literals across decoration modules; the contract creates the obligation to centralize as a precondition for any future ChatGPT-attribute migration. New code complies from day one; existing literals are flagged in the risk section of the summary.

## Rule 6 — Identity Is Consumed, Not Owned

Studio feature code may read identity state via `H2O.events` (`h2o:identity:ready`, `h2o:identity:changed`) and `H2O.Identity` global. Studio must not initiate auth flows, store credentials, or call identity providers (Supabase, Google OAuth, etc.) directly. Those belong to `src-surfaces-base/identity/`.

If Studio needs an authenticated action (e.g., remote sync once that exists), it requests it via `H2O.Studio.platform.auth.requestToken(scope)` rather than touching providers.

## Rule 7 — Filesystem / Import / Export Through the Adapter

Today: Studio doesn't have meaningful filesystem access. Imports/exports via `Blob`/`createObjectURL` and `<input type=file>` work but are sandboxed by the browser.

Tomorrow: Tauri exposes a real filesystem. To make the difference invisible to feature code, all file I/O routes through `H2O.Studio.platform.files`:

```js
await H2O.Studio.platform.files.exportJson({ suggestedName: 'library.json', data });
const imported = await H2O.Studio.platform.files.importJson();
```

On Chrome, the adapter uses `Blob` + `<a download>` for export and `<input type=file>` for import. On Tauri, it uses the Tauri dialog/fs plugins. Feature code is identical.

## Rule 8 — Schema Records Are Versioned

Every domain record has a `schemaVersion: number` field. Migrations live in `@h2o-studio/core` (or a `studio-migrations/` module) and are owned by the storage adapter. Storage keys may continue the existing `:v1`/`:v2` suffix convention but new entities should rely on the in-record `schemaVersion` so that a SQLite migration can read the version from the row, not the key.

## Rule 9 — No Hidden Mutation, One-Way Sync Inside Studio

Within Studio, data flows in one direction at any given boundary:

- Capture → Library Index → Workspace → Reader (read path).
- User action → feature service → StudioStore → broadcast → Index refresh (write path).

Consumers do not silently mutate their producers. If `Library Insights` needs to write back to `Library Index`, that write goes through an explicit Index API, not through direct catalog mutation. This rule already exists in `docs/systems/library/sync-rules.md`; this contract restates it as Studio-wide.

## Rule 10 — Tauri-Readiness Checklist Before Merge

Before merging any Studio change, complete the checklist in `STUDIO_DEVELOPMENT_RULES.md`. The questions are short; answering "no" on a "must" item is a blocker.

## How This Contract Is Enforced

Today: by review. The companion `STUDIO_DEVELOPMENT_RULES.md` is the checklist reviewers use.

Tomorrow (recommended, optional): a lint rule (`eslint-plugin-no-restricted-syntax` or a tiny custom rule) that forbids `chrome\.` and `localStorage\.` token sequences inside `src-surfaces-base/studio/` except in files explicitly whitelisted as platform adapters. This is **not** required to comply with the contract today; it's listed in the summary as a recommended next step.

## What This Contract Does Not Forbid

- Continued use of `H2O.bus`, `H2O.events`, `W`, `TOPW`, `H2O.*` globals — these are Studio-internal and portable.
- Continued use of `document.querySelector` against `studio.html`'s own DOM with ChatGPT-compatible selectors (provided selectors are centralized per Rule 5).
- Existing call sites that violate Rule 1 or Rule 3. They are debts, not bugs. New code complies; debts are paid down opportunistically. See the risk register in the summary for the priority order.

The point of the contract is to stop the bleed, not to relitigate every line of existing code.
