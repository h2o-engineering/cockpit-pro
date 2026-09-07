# Studio Architecture

Status: Active
Audience: Anyone writing or modifying code under `src-surfaces-base/studio/`.
Companion docs: `STUDIO_PORTABILITY_CONTRACT.md`, `STUDIO_PLATFORM_ADAPTER_GUIDE.md`, `STUDIO_STORAGE_CONTRACT.md`, `STUDIO_CAPTURE_BOUNDARY.md`, `STUDIO_DEVELOPMENT_RULES.md`.

## Purpose

Define what Studio is, what it owns, what it does not own, and the boundaries that must hold so Studio remains a portable workspace surface — currently hosted inside the Chrome/MV3 extension, intended to migrate later into a standalone desktop app (Tauri preferred) with a thin capture extension.

## Studio Identity

Studio is a **portable workspace application surface** for captured chats. It is *not* a chatgpt.com DOM decoration layer.

Studio's long-term role is closer to Notion / OneNote / Obsidian than to a userscript:

- a Library catalog of captured/imported chats and future Product item kinds
- structured organization (folders, projects, categories, labels, tags)
- future semantic references/provenance, source documents, and spatial Canvas
  capabilities under their own Lane boundaries
- a reader that re-renders chats with visual parity to ChatGPT but full Studio control over the DOM
- a workspace for activities over saved chats: MiniMap navigation, inline highlights, quote tracking, answer/question wash, timestamps, answer numbering, insights
- a host for future workflows over saved knowledge

Today Studio runs inside an MV3 extension page (`studio.html`). Tomorrow it should be able to run inside a Tauri WebView on macOS with no rewrite of feature code — only swaps in the platform/storage/capture adapters.

## Engineering Lane Boundaries

Studio is a Product surface shared by several Engineering Lanes; physical
location under `src-surfaces-base/studio/` does not make one Lane the umbrella
owner.

| Lane | Primary responsibility here | Boundary |
|---|---|---|
| `L-STUDIO-APPLICATION-SHELL` | Top-level application frame, route/view containers, app navigation shell, global scroll roots, Desktop chrome/safe-area composition, sidebar/rail/stage/topbar structure, and Ribbon/Dock host placement | Owns where features mount, not what feature actions or records mean |
| `L-STUDIO-HOST-INTEGRATION` | `H2O.Studio.platform.*`, environment selection, MV3/Tauri adapters, messaging/IPC, filesystem, clipboard, and host runtime bridges | Adapts Studio ports to host APIs; does not own Studio Runtime lifecycle or Shell geometry |
| `L-RUNTIME-KERNEL-SCOPE-STU` | Studio bootstrap, module admission, dependency/readiness ordering, runtime/service registration, activation, disposal, health, and lifecycle | Owns how accepted Studio modules become operational; not Shell geometry, host adaptation, build packaging, or feature meaning |
| `L-COCKPIT-LIBRARY` | Cross-surface Library catalog, Chat Registry, Index/read models, search/ranking/filters/snippets/browse/recents, insights, organization, organizational bindings, and Library actions/contracts | Owns Library catalog/search/discovery meaning; not semantic fragment relationships, content meaning, archive durability, sync convergence, or Studio mount geometry |
| `L-COCKPIT-KNOWLEDGE-MODEL` | Shared semantic references, anchors, provenance, backlinks, cross-item/fragment relationships, and semantic projections/contracts | Owns how exact things/fragments refer semantically; not Library organization or Renderer implementation |
| `L-STUDIO-CANVAS` | Canvas document model, spatial composition, visual-local relations, Canvas persistence, and Canvas engine behavior | Shell owns mount/pane geometry; Knowledge Model owns Product-semantic relations; Binary Assets owns generic bytes |
| `L-STUDIO-SOURCE-DOCUMENTS` | External/reference source-document versions, parsing, extraction, page geometry, OCR/document metadata, and document projections | Authoring owns native authored content; Binary Assets owns generic file bytes; Reader/Renderer own consumption/rendering |
| `L-DEVELOPER-BUILD-DELIVERY-SCOPE-STU` | Studio build, package, stage, software/artifact publication, promotion, delivery provenance, activation, rollback, recovery, and Desktop bundles | Owns delivery mechanics, not runtime feature semantics or saved-chat “publication” |
| `L-STORAGE-SAVED-CHATS` | Durable saved-chat/archive representation, serialization, retention, recovery, and durability | Does not own Library discovery/organization meaning |
| `L-STORAGE-BINARY-ASSETS` | Generic immutable binary payloads, content/hash identity, deduplication, `AssetRef`, streaming, and shared CAS mechanics | Current saved-chat CAS implementation stays incumbent under Saved Chats until an explicit extraction Mission |
| `L-PLATFORM-SYNC` | Cross-surface propagation, conflict handling, and convergence | Does not own Library business semantics |
| `L-STUDIO-READER`, `L-STUDIO-RENDERER`, `L-STUDIO-AUTHORING` | Opened-conversation consumption, content projection, and authoring semantics respectively | May use Shell-owned structural slots through temporary narrow leases |

The principal shared shell hotspots are `studio.html`, `studio.css`,
`studio.js`, `S0Y1a` Studio Ribbon, and the shared Dock/Ribbon surfaces. Each
change has one semantic home owner. Cross-Lane edits use a temporary narrow
lease for the exact structural slot; shared files do not imply co-primary
ownership.

## Ownership Map

| Layer | Owns | Does NOT own |
|---|---|---|
| **Studio Product surface** | Hosts Shell, Runtime, Library, Reader, Renderer, Authoring, and Host Integration implementations according to the Lane boundaries above | A single umbrella Lane; capturing live ChatGPT chats; user auth/identity; service-worker-only behaviors |
| **Browser Capture Extension** (current native content scripts on chatgpt.com) | Observing chatgpt.com DOM. Snapshotting turns. Streaming new turns. Writing snapshots to the archive bridge. | Workspace UI. Knowledge organization. User-facing chat reader. |
| **Platform Adapter / Host Integration** (see `STUDIO_PLATFORM_ADAPTER_GUIDE.md`) | Host messaging, capture intake bridge, file I/O, env detection, runtime URL resolution, and concrete MV3/Tauri adaptation | Domain logic, UI geometry, Studio module admission/readiness/lifecycle |
| **Studio Runtime** | Bootstrap, module admission, dependency/readiness ordering, runtime/service registration, activation, disposal, health, and failure/recovery semantics | Shell geometry, host adaptation, build/package mechanics, or feature semantics |
| **Storage Adapter** (concrete implementation behind the StudioStore façade) | Persistence implementation: today IndexedDB + localStorage + `chrome.storage.local`; tomorrow SQLite via `tauri-plugin-sql` | Library business semantics; schema meaning; UI components |
| **Shared Library contracts/core** | Library record/catalog/index/organization/search meaning and pure normalizers used across surfaces | Semantic fragment relationships, content meaning, storage durability backend, sync transport/convergence, or surface UI geometry |
| **Identity Surface** (`src-surfaces-base/identity/`) | Auth UI and token state. | Studio cannot perform auth directly; it consumes `H2O.Identity` state via events only. |

## Current Source Responsibility Map

The current modules under `src-surfaces-base/studio/` participate in these
boundaries:

- **Cockpit Library** — `S0F0a` Library Surface Host; `S0F1a` Library
  Core; `S0F1b` Library Workspace; `S0F1c` Library Index; `S0F1d` Library
  Insights; `S0F1f` Library Maintenance; `S0F1g` Chat Registry; Library
  contracts/core; `S0F2a` Projects; `S0F3a` Folders; `S0F4a` Categories;
  `S0F5a` Tags; `S0F6a` Labels; and Library-specific command/sidebar
  semantics. `S0F1h` transport/convergence behavior remains Platform Sync.
- **Application Shell** — structural composition in `studio.html`, `studio.js`,
  and `studio.css`, including route/view containers, sidebar/rail, stage,
  topbar, scroll roots, and Ribbon/Dock host placement.
- **Reader / Renderer / Authoring** — reader navigation and consumption,
  replay/content projection, decorations, and authored knowledge semantics
  according to their respective Charters. Placement inside a Shell slot does
  not transfer semantic ownership.
- **Host Integration** — the `platform/` adapters and Studio-specific host
  bridge surfaces. Archive/storage semantics behind a bridge retain their
  Saved Chats Storage boundary.
- **Studio Runtime** — current/future bootstrap, module admission, readiness,
  runtime/service registration, activation, and lifecycle primitives consumed
  by Studio modules; environment-specific adaptation stays with Host Integration.
- **Knowledge Model / Canvas / Source Documents / Binary Assets** — current
  ownership boundaries for future shared semantic-reference, spatial Canvas,
  external source-document, and generic binary capabilities. This document
  does not claim those future modules or the Saved Chat CAS extraction exist.

Studio does **not** own `src-surfaces-base/desk/` (live chatgpt.com decoration), `src-surfaces-base/identity/`, the service worker (`bg.js`), or content scripts (`loader.js`).

## Reader Visual-Parity Convention (load-bearing invariant)

Studio renders captured chats inside `studio.html` using the **same `data-*` attribute names ChatGPT uses on its live page**: `data-message-id`, `data-message-author-role`, `data-testid="conversation-turn"`, etc. This is intentional: it lets the decoration engines (MiniMap, Highlights, Wash, Timestamps, Answer Numbers) run unchanged on either chatgpt.com (native variant) or Studio's replay (Studio variant) by querying the same selectors.

Implication: **the decoration engines in `src-surfaces-base/studio/` query `studio.html`'s own DOM via `document.querySelector` — they do not, and cannot, reach chatgpt.com's DOM** (different origin, different context). The same selectors work because Studio's replay is shaped that way on purpose.

If ChatGPT ever renames its data attributes, two things move together: (a) the live capture extension's selectors, and (b) Studio's replay renderer must keep emitting the legacy attribute name (or both) so existing captures remain readable. Selector constants are documented in `STUDIO_CAPTURE_BOUNDARY.md` and must be centralized in one place — never sprinkled across decoration files.

## Runtime Today vs Future

```
TODAY (MV3 extension)
─────────────────────
chatgpt.com content scripts (capture)
  → service worker (bg.js) archive bridge
  → chrome.storage.local + IndexedDB
  → chrome.storage.onChanged
  → Library Sync (S0F1h) inside studio.html
  → Library Index/Workspace/Insights/Reader

FUTURE (Tauri desktop app + slim capture extension)
───────────────────────────────────────────────────
chatgpt.com content scripts (capture, in a slim browser extension)
  → native messaging / localhost endpoint
  → Tauri command (Rust side)
  → SQLite (tauri-plugin-sql)
  → Tauri event channel
  → Library Sync (Studio side) inside Tauri WebView
  → Library Index/Workspace/Insights/Reader
```

Studio feature code in both pictures is **the same code**. Only the adapters under it change.

## Boundaries That Must Hold

1. **Studio feature code must not call platform APIs directly.** No `chrome.*`, no `localStorage.*`, no `indexedDB.*`, no `fetch('/api/...')` for persistence, no `chrome.runtime.sendMessage` in feature files. All such access routes through the Platform Adapter and/or StudioStore. See `STUDIO_PLATFORM_ADAPTER_GUIDE.md`.
2. **Studio does not capture from ChatGPT.** Studio consumes normalized records from a CaptureSource interface. Today the capture pipeline lives in the live content scripts + archive bridge; tomorrow the same interface is fed by a slim browser extension via Tauri IPC. See `STUDIO_CAPTURE_BOUNDARY.md`.
3. **Storage goes through StudioStore.** No scattered storage calls in feature files. Records have versioned shapes that can be mapped to SQLite tables. See `STUDIO_STORAGE_CONTRACT.md`.
4. **Messaging inside Studio uses `H2O.events`.** Direct extension messaging (`chrome.runtime.sendMessage`) is allowed only inside the Platform Adapter, never in feature code. Cross-surface sync goes through the Library Sync façade, which is itself adapter-backed.
5. **Replay DOM uses ChatGPT-compatible data attributes.** Selectors are centralized; feature code uses named selector constants rather than literal CSS strings.
6. **The Tauri-readiness checklist (`STUDIO_DEVELOPMENT_RULES.md`) is consulted before adding any new feature.**
7. **Studio modules enter through the Runtime boundary.** New contribution
   modules should register through stable admission/readiness/lifecycle
   contracts rather than each extending global bootstrap manually.

## Why This Matters Now (Not Later)

Porting Studio is cheap if the boundaries hold and expensive if they don't. Two years of "just call `chrome.storage.local.set` inline" is the difference between a weekend port and a multi-month rewrite. The contracts in the companion docs cost very little to follow today — one indirection per call site — and remove the largest categories of port-time work.

This document is the entry point. Read it once. Then read the companion docs for concrete rules.
