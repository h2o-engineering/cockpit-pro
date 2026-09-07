# Studio Surface

A portable workspace surface for captured chats. Today hosted inside the Cockpit Pro MV3 extension (`studio.html`); intended to migrate later into a Tauri desktop app with a slim browser extension handling capture.

## Read These Before Touching Studio Code

The five contracts that govern Studio development are in this folder. Read in order:

1. **[STUDIO_ARCHITECTURE.md](./STUDIO_ARCHITECTURE.md)** — What Studio is, what it owns, what it does not. Identity and boundaries.
2. **[STUDIO_DEVELOPMENT_RULES.md](./STUDIO_DEVELOPMENT_RULES.md)** — Operational rules and the pre-merge checklist. Start here at PR time.
3. **[STUDIO_PORTABILITY_CONTRACT.md](./STUDIO_PORTABILITY_CONTRACT.md)** — Rules 1–10 that keep Studio Tauri-ready.
4. **[STUDIO_PLATFORM_ADAPTER_GUIDE.md](./STUDIO_PLATFORM_ADAPTER_GUIDE.md)** — The adapter layer through which all platform calls flow.
5. **[STUDIO_STORAGE_CONTRACT.md](./STUDIO_STORAGE_CONTRACT.md)** — The StudioStore façade, canonical record shapes, SQLite mapping.
6. **[STUDIO_CAPTURE_BOUNDARY.md](./STUDIO_CAPTURE_BOUNDARY.md)** — Separation between capture and workspace.

## TL;DR

- Studio is a **workspace over saved chats**, not a chatgpt.com DOM decorator. The decoration engines (MiniMap, Highlights, Wash, etc.) run against Studio's own replay DOM inside `studio.html`.
- Studio is not one umbrella Engineering Lane. Application Shell owns its
  structural composition, Host Integration owns its environment adapters,
  Cockpit Library owns cross-surface Library semantics, and Build & Delivery
  owns Studio software packaging/artifact delivery. Reader, Renderer,
  Authoring, Canvas, Source Documents, Knowledge Model, Binary Assets, Saved
  Chats Storage, Platform Sync, and Studio Runtime retain separate semantic
  boundaries. The latter four newly admitted capability boundaries do not imply
  that future modules or CAS extraction have already been implemented.
- Studio code must not call `chrome.*` directly. Go through `H2O.Studio.platform.*`.
- Studio code must not query live chatgpt.com DOM. Consume normalized records via the CaptureSource interface.
- Studio persistence goes through `H2O.Studio.store`. No scattered `chrome.storage` / `localStorage` / `IndexedDB` calls in feature code.
- Studio messaging goes through `H2O.events`. Cross-surface signaling goes through `H2O.Studio.platform.broadcast`.
- Shared hotspots such as `studio.html`, `studio.css`, `studio.js`, Ribbon,
  Dock, platform adapters, and Desktop Tauri files use one home semantic owner
  plus temporary narrow leases for cross-Lane work; they do not have
  co-primary ownership.

## File Layout

```
src-surfaces-base/studio/
├── README.md                            # this file
├── STUDIO_ARCHITECTURE.md
├── STUDIO_DEVELOPMENT_RULES.md
├── STUDIO_PORTABILITY_CONTRACT.md
├── STUDIO_PLATFORM_ADAPTER_GUIDE.md
├── STUDIO_STORAGE_CONTRACT.md
├── STUDIO_CAPTURE_BOUNDARY.md
├── studio.html                          # reader shell loaded as chrome-extension page
├── studio.js                            # reader runtime, archive workbench
├── studio.css
├── S0A1a. 🎬 H2O Core - Studio.js       # event bus (Studio variant)
├── S0A2a. 🎬 Observer Hub - Studio.js
├── S0D3a. 🎬 Transcript Archive Engine - Studio.js
├── S0D3e. 🎬 Transcript Studio Host - Studio.js
├── S0F0a. 🎬 Library Surface Host - Studio.js
├── S0F1a–S0F1h.                         # Library Core/Workspace/Index/Insights/Store/Maintenance/Registry/Sync
├── S0F2a–S0F6a.                         # Projects, Folders, Categories, Tags, Labels
├── S0X1a–S0X1b.                         # Command Bar (+ Library plugin)
├── S0Z1f–S0Z1g.                         # Sidebar tab and sections
├── S1A1a–S1A1f.                         # MiniMap (Kernel, Core, Engine, Shell, Skin, Views)
├── S1A2a.                               # Answer Wash Engine
├── S1A3a.                               # Highlight Dots
├── S1C1a.                               # Turn Title Bar
├── S1X1a.                               # Answer Numbers
├── S1Z1a, S2Z1a.                        # Timestamps
├── S2A1a, S2B1a, S2C1a.                 # Question Wrapper, Quote Tracker, Question Wash
├── S3H1a.                               # Highlights Engine
└── S9D1a.                               # Auto Emoji Title
```

To be added (per `STUDIO_PLATFORM_ADAPTER_GUIDE.md`):

```
src-surfaces-base/studio/
└── platform/
    ├── index.js
    ├── adapter-extension-mv3.js
    ├── adapter-tauri.js                 # future
    ├── adapter-mock.js
    ├── store.js                         # H2O.Studio.store façade
    ├── messaging.js
    ├── broadcast.js
    ├── runtime.js
    ├── files.js
    ├── auth.js
    └── selectors.contract.js
```

## How Studio Boots Today

Bootstrap, module admission, dependency/readiness ordering, activation, and
lifecycle are owned by `L-RUNTIME-KERNEL-SCOPE-STU`. The current explicit
script-tag sequence remains unchanged by this documentation adoption; future
contribution modules should enter through stable Runtime contracts rather than
each extending the global bootstrap surface manually.

1. Service worker (`bg.js`) opens `chrome-extension://<id>/src-surfaces-base/studio/studio.html` in a panel/window.
2. `studio.html` loads `studio.js` plus the 30+ `S*.Studio.js` modules in numeric order via `<script>` tags.
3. Each module is an IIFE that registers itself in `H2O.events`, `H2O.Library.*`, or other `H2O.*` namespaces.
4. The reader (`studio.js`) renders captured chats inside its own DOM using ChatGPT-compatible data attributes.
5. Decoration engines (MiniMap, Highlights, Wash, etc.) attach to the rendered DOM and provide workspace activities.

See `docs/architecture/storage-map.md` and `docs/systems/library/*` for the existing repo-wide architecture context. The contracts in this folder build on those without duplicating them.

## How Studio Will Boot Under Tauri (future)

1. Tauri opens a WebView pointing at the bundled Studio assets.
2. `studio.html` boots the same way — `<script>` tags load the same `S*.Studio.js` modules.
3. The platform adapter detects Tauri and binds `H2O.Studio.platform` to the Tauri implementation (`tauri-plugin-sql` for storage, Tauri events for messaging, etc.).
4. A slim browser extension captures chats on chatgpt.com and ships them to the Tauri app via native messaging or localhost.
5. Studio feature code is unchanged.

That is the contract this folder defends.
