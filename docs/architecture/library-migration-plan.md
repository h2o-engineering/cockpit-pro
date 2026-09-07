# Library Migration Plan — Native → Shared / Studio

Status: Phase 0 (planning) — no code changes yet
Date: 2026-05-15
Owner: Library team
Related: [ADR-0004 Library Index Source Model](../decisions/ADR-0004-library-index-source-model.md), [ADR-0005 Linked vs Saved Records](../decisions/ADR-0005-linked-vs-saved-library-records.md), [ADR-0006 Shared Library Storage Tier](../decisions/ADR-0006-shared-library-storage-tier.md), [Library Record Shapes](../systems/library/record-shapes.md), [Library Contract](../systems/library/contract.md)

## Mission

Consolidate the Library system so **Studio is the primary Library application UI** and **native ChatGPT scripts shrink to thin adapters** for the capabilities that genuinely require chatgpt.com page-world (DOM observation, transcript capture, native menu injection). Shared Library business logic lives in one place and is consumed by every surface.

This is **not a file-copy migration**. Moving `src-runtime-base/0F3a` into `src-surfaces-base/studio/` would relocate DOM-injection code into a context where it cannot run. The migration is by **responsibility** (pure logic vs DOM vs storage), not by file path.

## Current Lane Governance Alignment

This Plan's “Library team” owner label is local Plan wording; it does not
establish a standing Lane Owner. Current durable engineering ownership is
`L-COCKPIT-LIBRARY`, with `LANE_OWNER=NOT_ESTABLISHED` in Cockpit Pro
Management.

The Library Lane owns the shared business boundary this Plan is moving toward:
catalog and Chat Registry semantics, Index/read models, search/browse/recents,
Explorer/Insights, folders/categories/labels/tags/projects, organizational
relationships and bindings, Library navigation/actions, and shared Library
contracts/core. Studio being the preferred current Library UI does not make
Library a Studio-domain capability; Extension and Studio implementations are
surface consumers/adapters of the shared Cockpit capability.

Adjacent ownership remains separate:

- Saved Chats Storage owns durable archive representation, serialization,
  retention, recovery, and durability.
- Platform Sync owns cross-surface propagation, conflict handling, and
  convergence; “Library Sync” module names do not transfer Library meaning to
  Sync or convergence mechanics to Library.
- Studio Application Shell owns the structural route/sidebar/container slots
  in which Studio Library UI mounts; Library owns what those routes and actions
  mean.
- Studio Reader owns consumption of an opened conversation, and Studio
  Authoring owns authored notes/highlights/editing semantics.

This alignment does not change the Plan's historical phases, code disposition,
storage decisions, or implementation state.

## What stays native, what becomes shared, what becomes Studio

| Concern | Stays native (adapter) | Moves to shared logic | Becomes Studio UI |
|---|---|---|---|
| Sidebar chat-row "..." menu injection (Add to Library, Save to Folder) | ✓ | — | — |
| Transcript capture from chatgpt.com page | ✓ (0D3a archive engine) | — | — |
| Current-chat detection / `STATE.lastChatHrefForMenu` | ✓ | — | — |
| Native ChatGPT project DOM scrape / cache | ✓ | — | — |
| Turn-level tag keyword extraction (reads message turns) | ✓ | — | — |
| Save Strip overlay on chatgpt.com | ✓ | — | — |
| Folder catalog / binding logic | — | ✓ | — |
| Category catalog + auto-classification + candidate pool | — | ✓ | — |
| Label catalog + bindings | — | ✓ | — |
| Tag pool + occurrence index | — | ✓ | — |
| Project metadata + name resolution | — | ✓ | — |
| Chat Registry record merge / normalize / dedup / invariants | — | ✓ | — |
| Library Index build / facet compute / counts | — | ✓ | — |
| Library Actions (`addToLibrary`, `saveToFolder`, `openLinkedChat`) | — | ✓ | — |
| Library Dashboard / Explorer / Analytics / Recents / Saved / Organize | — | — | ✓ |
| Library Maintenance / diagnostics surfaces | — | — | ✓ |
| Linked / Saved row chips + click behavior + secondary "Open original" | — | — | ✓ |
| Sidebar Folders / Labels / Categories / Projects sections (Studio side) | — | — | ✓ |
| Command Bar palette (Studio) | — | — | ✓ |

## Current Architecture Map

### Native modules (`src-runtime-base/`)

| Module | Global | Persists to | Reads ChatGPT DOM? | Renders UI? | Migration disposition |
|---|---|---|:--:|:--:|---|
| 0F1a Library Core | `H2O.LibraryCore` | none | no | no | Logic → shared |
| 0F1b Library Workspace | `H2O.LibraryWorkspace` | `h2o:prm:cgx:library-workspace:…` | yes | yes | Logic → shared; UI deprecate in favor of Studio |
| 0F1c Library Index | `H2O.LibraryIndex` | `h2o:prm:cgx:library:registry:v2` (Library Store) + scan-ledger keys | no | no | Logic → shared; data storage → ADR-0006 |
| 0F1d Library Insights | `H2O.LibraryInsights` | `h2o:prm:cgx:library-insights:prefs:v1` | yes (turn DOM analytics) | yes | UI deprecate in favor of Studio; turn-DOM analytics keeps an adapter |
| 0F1e Library Store | `H2O.Library.Store` | adapter chain | no | no | Already adapter pattern; gains SW-IDB tier per ADR-0006 |
| 0F1f Library Maintenance | `H2O.Library.Maintenance` | read-only | no | no | Logic → shared |
| 0F1g Chat Registry | `H2O.ChatRegistry` | `window.localStorage` key `h2o:library:chat-registry:v1` | yes (chat-href discovery) | no | Logic → shared; native keeps DOM scan adapter |
| 0F1h Library Sync | `H2O.Library.Sync` | bridge writes to chrome.storage | no | no | Stays; envelope contract becomes shared |
| 0F1i Sync Consumers | internal | none | no | no | Stays |
| 0F1j Library Actions | `H2O.LibraryActions` | none | no | no | Logic → shared |
| 0F2a Projects | `H2O.Projects` | `h2o:prm:cgx:fldrs:state:projects_cache:v1` + native_headers | yes | yes | Catalog → shared; DOM scrape stays native |
| 0F3a Folders | `H2O.folders` | `h2o:prm:cgx:fldrs:state:data:v1` + `…ui:v1` | yes (sidebar inject + menu) | yes | Logic → shared; menu injection + sidebar section stay native |
| 0F4a Categories | `H2O.Categories` | `h2o:prm:cgx:fldrs:state:ui:v1` (shared with Folders) + override / candidate-pool keys | yes | yes | Catalog + classifier → shared; category page UI deprecate to Studio |
| 0F5a Tags | `H2O.Tags` | `h2o:prm:cgx:library:tag-auto-pool:v1` + `…tag-occ-index:v1` + turn-level keys | yes (turn DOM) | yes | Pool + occurrence index → shared; turn-level extraction stays native |
| 0F6a Labels | `H2O.Labels` | `h2o:prm:cgx:library:labels:catalog:v1` + `…bindings:v1` | yes | yes | Catalog + bindings → shared; native sidebar adapter stays |
| 0X1a Command Bar | `H2O.commandBar` | `h2o:archive:dock:collapsed:v1` (legacy) | yes | yes | Native-only on chatgpt.com; Studio has its own |

### Studio modules (`src-surfaces-base/studio/`)

| Module | Global | Persists to | Type |
|---|---|---|---|
| S0F0a Surface Host | `H2O.Library.LibrarySurfaceHost` | none | Studio-only seam (canonical) |
| S0F1a Library Core | `H2O.LibraryCore` | none | Canonical Studio reimpl |
| S0F1b Library Workspace | `H2O.LibraryWorkspace` | `h2o:prm:cgx:library-workspace:sidebar-layout:v1` | Mirror |
| S0F1c Library Index | `H2O.LibraryIndex` | `h2o:prm:cgx:library-index:studio:registry:v1` | Mirror (parallel index, separate key) |
| S0F1d Library Insights | `H2O.LibraryInsights` | `h2o:prm:cgx:library-insights:studio:prefs:v2` | Mirror — richer UI than native today |
| S0F1e Library Store | `H2O.Library.Store` | IndexedDB `h2o.library.studio` | Canonical Studio store |
| S0F1f Library Maintenance | `H2O.Library.Maintenance` | read-only | Mirror (lighter) |
| S0F1g Chat Registry | `H2O.ChatRegistry` | `h2o:library:chat-registry:studio:v1` | Mirror **shape drift from native** — fix in Phase 2 |
| S0F1h Library Sync | `H2O.Library.Sync` | bridge | Canonical peer of native 0F1h |
| S0F2a Projects | `H2O.Projects` | in-memory only | Read-only mirror |
| S0F3a Folders | `H2O.folders` | in-memory only | Read-only + light write-through |
| S0F4a Categories | `H2O.Categories` | in-memory | Read-only mirror |
| S0F5a Tags | `H2O.Tags` | `h2o:prm:cgx:library:tags:studio:prefs:v1` | Read-only mirror |
| S0F6a Labels | `H2O.Labels` | in-memory | Read-only mirror |
| S0X1a Command Bar | `H2O.CommandBar` | none | Canonical (Studio UI) |
| S0X1b Library Commands | plugin | none | Canonical (Studio plugin) |
| S0Z1f Sidebar Tab | `H2O.Library.SidebarTab` | none | Studio sidebar UX |
| S0Z1g Sidebar Sections | sections renderer | `h2o:studio:sidebar:sections:collapse:v1` + writes back to `h2o:prm:cgx:fldrs:state:ui:v1` via chrome.storage for native interop | Studio-only with interop mirror |

## Native vs Studio Capability Matrix

| Capability | Native | Studio | Status |
|---|---|---|---|
| Add to Library / Save to Folder (action API) | ✓ `H2O.LibraryActions` | Studio can invoke via cross-surface RPC (not yet wired) | Write paths native-only by necessity (archive + DOM) |
| Folder catalog CRUD | ✓ full | read-only facade | Duplicated read; native owns writes |
| Folder binding (chat ↔ folder) | ✓ write + capture+bind | read-only + thin write-through | Native owns writes |
| Folder sidebar injection | ✓ chatgpt.com sidebar | ✓ Studio sidebar (S0Z1g) | Surface-specific |
| Category catalog | ✓ + auto-classification | read-only list | Native owns writes |
| Category candidate pool / overrides | ✓ | ✗ | Native-only |
| Tag turn-level extraction | ✓ DOM-coupled | ✗ | Native-only (forever) |
| Tag auto-pool / occurrence index | ✓ writes | reads via Index facets | Native owns writes |
| Label catalog management | ✓ full CRUD | read-only list | Native owns writes |
| Label binding (chat → labels) | ✓ | ✗ direct write | Native owns writes |
| Project metadata + cache | ✓ (intercepts `/backend-api/projects`) | derived from Index facets | Native owns; Studio derives |
| Library dashboard | partial (no real dashboard UI on native) | ✓ rich Dashboard | Studio is better |
| Explorer filters / grouping / sort | partial | ✓ | Studio is better |
| Analytics | ✗ minimal | ✓ | Studio-only |
| Recents tab | (via facets) | ✓ explicit tab | Studio is better |
| Saved tab | (via folders + categories pages) | ✓ explicit tab | Studio is better |
| Organize / batch ops | ✗ | ✓ | Studio-only |
| Linked records visible | ✓ since Phase 7 broadcast projection | ✓ since Phase 7 | Both |
| Imported records (no source URL) | ✓ via importSnapshot | ✓ read via Index facets | Both |
| Search (chat-level) | ✓ | ✓ | Both |
| Sidebar Folders / Labels / Categories / Projects sections | ✓ chatgpt.com | ✓ Studio (S0Z1g) | Surface-specific |
| Command Bar (⌘K) | ✓ chatgpt.com (0X1a) | ✓ Studio (S0X1a + S0X1b plugin) | Surface-specific |
| Diagnostics / maintenance | ✓ (0F1f) | ✓ (S0F1f) | Both, different scope |
| Cross-surface sync | ✓ (0F1h + 0F1i) | ✓ (S0F1h) | Symmetric, working |
| Native chat row "…" menu (Add to Library / Save to Folder) | ✓ injected by 0F3a | n/a | Native-only by necessity |
| Transcript capture from chatgpt.com page | ✓ (archive engine) | ✗ — must remain native | Native-only by necessity |

## Data / Storage / Source-of-Truth Map (34 keys observed)

| Key | Owner | Origin | Cross-surface? | Source of truth |
|---|---|---|:--:|---|
| `h2o:library:chat-registry:v1` | native 0F1g | chatgpt.com localStorage | no | Native (Phase 1 record shape) |
| `h2o:library:chat-registry:studio:v1` | Studio S0F1g | Studio Store (IDB) | no | Studio (legacy shape; **drifts from native**) |
| `h2o:library:cross-surface:broadcast:v1` | Studio 0F1h | chrome.storage.local | yes | Transport only |
| `h2o:library:cross-surface:broadcast:native:v1` | native 0F1h (via bridge) | chrome.storage.local | yes | Transport + linked-record snapshot |
| `h2o:prm:cgx:fldrs:state:data:v1` | native 0F3a | chatgpt.com localStorage | no | Native — folder catalog + bindings |
| `h2o:prm:cgx:fldrs:state:ui:v1` | native 0F3a + 0F4a + Studio S0Z1g writes back | chatgpt.com localStorage + chrome.storage events | partial | Native + Studio appearance writes |
| `h2o:prm:cgx:fldrs:state:folders_expanded:v1` | native 0F3a | localStorage | no | Native UI state |
| `h2o:prm:cgx:fldrs:state:see_more:v1` | native 0F3a | localStorage | no | Native UI state |
| `h2o:prm:cgx:fldrs:state:projects_cache:v1` | native 0F2a | localStorage | no | Native — projects scrape cache |
| `h2o:prm:cgx:fldrs:state:projects_native_headers:v1` | native 0F2a | localStorage | no | Native |
| `h2o:prm:cgx:library:registry:v2` | native 0F1c | Library Store | partial via Store | Native — Library Index registry |
| `h2o:prm:cgx:library-index:known-registry:v1` | native 0F1c | localStorage (legacy) | no | Native (migration target → v2) |
| `h2o:prm:cgx:library-index:studio:registry:v1` | Studio S0F1c | Studio Store (IDB) | no | Studio (parallel index) |
| `h2o:prm:cgx:library-workspace:sidebar-layout:v1` | Studio S0F1b | localStorage | no | Studio UI |
| `h2o:prm:cgx:library-insights:prefs:v1` | native 0F1d | localStorage | no | Native UI prefs |
| `h2o:prm:cgx:library-insights:studio:prefs:v2` | Studio S0F1d | localStorage | no | Studio UI prefs |
| `h2o:prm:cgx:library:_sentinel:v1` | native 0F1e | (adapter test) | n/a | n/a |
| `h2o:prm:cgx:library:autoclass-prefs:v1` | native 0F4a | Library Store | partial | Native |
| `h2o:prm:cgx:library:cat-candidate-pool:v1` | native 0F4a | Library Store | partial | Native |
| `h2o:prm:cgx:library:category-overrides:v1` | native 0F4a | Library Store | partial | Native |
| `h2o:prm:cgx:library:chat-title:state:v1` | native title module | localStorage | partial (broadcast prefix) | Native |
| `h2o:prm:cgx:library:interface-meta:v1` | native | localStorage | partial | Native |
| `h2o:prm:cgx:library:labels:catalog:v1` | native 0F6a | localStorage | no | Native — label catalog |
| `h2o:prm:cgx:library:labels:bindings:v1` | native 0F6a | localStorage | no | Native — chat ↔ labels |
| `h2o:prm:cgx:library:pending-nav:v1` | native | localStorage | no | Native nav state |
| `h2o:prm:cgx:library:scan-batches:v1` | native 0F1c | Library Store | partial | Native scan ledger |
| `h2o:prm:cgx:library:tag-auto-pool:v1` | native 0F5a | Library Store | partial | Native — tag auto-pool |
| `h2o:prm:cgx:library:tag-occ-index:v1` | native 0F5a | Library Store | partial | Native — tag occurrence index |
| `h2o:prm:cgx:library:tags:studio:prefs:v1` | Studio S0F5a | localStorage | no | Studio prefs |
| `h2o:prm:cgx:mnmp:state:titles:v1` | native title module | localStorage | no | Native |
| `h2o:tags:pending-turn-nav:v1` | native | localStorage | no | Native |
| `h2o:folders:data:v1` / `…ui:v1` / `…v1` | native fallback paths | localStorage | no | Native legacy |
| `h2o:studio:sidebar:sections:collapse:v1` | Studio S0Z1g | localStorage | no | Studio UI |

**Headline:** the canonical truth for every Library feature (folders, categories, labels, tags, projects, registry, index) lives on **chatgpt.com origin**. Studio mirrors what it can via the bridge and reads through the archive bridge for the rest. ADR-0006 commits to moving this canonical truth into a **background-SW-owned IndexedDB** that both surfaces query.

## Proposed Target Architecture

```
   ┌──────────────────────────────────────────────────────────┐
   │ Surfaces (UI)                                             │
   │  • chatgpt.com page-world (native menus, save-strip,      │
   │    sidebar sections, transcript capture)                  │
   │  • Studio (chrome-extension page: Library hub UI)         │
   │  • Future: Tauri desktop, etc.                            │
   └─────────────────────┬────────────────────────────────────┘
                         │
   ┌─────────────────────▼────────────────────────────────────┐
   │ Shared Library Logic (NEW — shared/library/)              │
   │  • Record shape + normalize + merge                       │
   │  • Folder/Category/Label/Tag/Project catalogs (pure)      │
   │  • Library Index build + facet compute                    │
   │  • Auto-classification, scan ledger                       │
   │  • Dedup, link/save invariants                            │
   │  • LibraryActions business logic                          │
   └─────────────────────┬────────────────────────────────────┘
                         │
   ┌─────────────────────▼────────────────────────────────────┐
   │ Surface Adapters                                          │
   │  • Storage adapter (per-surface backend)                  │
   │  • DOM adapter (chatgpt.com only: sidebar/turn observers, │
   │    menu injection, save-strip)                            │
   │  • Archive bridge (chatgpt.com → background SW → IDB)     │
   │  • Cross-surface sync (already exists — 0F1h / S0F1h)     │
   └──────────────────────────────────────────────────────────┘
```

The shared layer lives at the **repo root in `shared/library/`** — sibling to `src-runtime-base/` and `src-surfaces-base/`. Pure modules, no DOM, no localStorage, no chrome.storage. Each module accepts an injected `services` bag at construction time.

## Service Contract

A single `LibrarySurfaceServices` bag that each surface assembles at boot:

```text
LibrarySurfaceServices = {
  storage:             { get, set, del, listKeys, backend }
  registry:            { listRecords, getRecord, upsertRecord, … }
  index:               { getAll, getByChatId, facets, counts, refresh, … }
  archive:             { captureNow, getLatestSnapshot, listAll, … }
  nativeLinkOpener:    { open(url, opts) }
  currentChatProvider: { getCurrentChatId(), getCurrentChatHref() }
  projectProvider:     { listProjects, getProjectName, … }
  folderProvider:      { list, get, create, rename, delete, bind, unbind, … }
  categoryProvider:    { listCatalog, classify, applyOverride, … }
  labelProvider:       { listCatalog, listForChat, addToChat, removeFromChat, … }
  tagProvider:         { listPool, listForTurn, addTurnTag, … }
  eventBus:            { emit, on, off }
  syncBridge:          { broadcast, onBroadcast, … }
}
```

| Service | Native impl | Studio impl | Shared logic |
|---|:--:|:--:|:--:|
| storage | chatgpt.com localStorage | Studio IndexedDB | — |
| registry shape | ✓ | ✓ | merge / normalize |
| index build | — | — | ✓ |
| archive | ✓ (capture engine) | bridge wrapper | — |
| nativeLinkOpener | `window.open` | `chrome.tabs.create` | — |
| currentChatProvider | DOM scrape | n/a | — |
| projectProvider scan | ✓ (DOM observer) | derives from Index | — |
| folderProvider catalog | ✓ today | reads + light write | logic shared |
| categoryProvider | ✓ today | reads | logic shared |
| labelProvider | ✓ today | reads | logic shared |
| tagProvider pool | ✓ today | reads | aggregation shared |
| tagProvider turn-extract | ✓ DOM-coupled | — | — |
| eventBus | `H2O.events` | `H2O.events` | — |
| syncBridge | 0F1h | S0F1h | envelope shape shared |

## Migration Phases

### Phase 0 — Audit + Contracts (this phase)
Land the migration plan, ADR-0006 (shared storage tier), and the record-shapes spec. Pointer added to the Library contract.
**Risk:** zero — docs only.
**DoD:** three new doc artifacts merged; team has agreed on Option B for shared storage; no code touched.

### Phase 1 — Service-boundary interfaces (LANDED 2026-05-15)
Introduce a documented `LibrarySurfaceServices` registry pattern. Native and Studio both register the canonical service names through `H2O.LibraryCore.registerService(...)`. No behavior change.
**Risk:** low — pure additive registry entries.
**DoD:** `H2O.LibraryCore.listServices()` on both surfaces includes every canonical name; `selfCheck()` clean.

**Implementation (landed):**
- New native module: [src-runtime-base/0F1k.⬛️🗂️ Library Canonical Services 🪪🗂️.js](../../src-runtime-base/0F1k.⬛️🗂️%20Library%20Canonical%20Services%20🪪🗂️.js)
- New Studio module: [src-surfaces-base/studio/S0F1k. 🎬 Library Canonical Services - Studio.js](../../src-surfaces-base/studio/S0F1k.%20🎬%20Library%20Canonical%20Services%20-%20Studio.js) (wired into `studio.html` after `S0F1h`)
- Both modules register 14 canonical names additively over existing service registrations. Legacy names (`chat-registry`, `library-index`, `folders`, `categories`, `labels`, `tags`, `projects`, `library-sync`, `library-store`) remain registered so no caller is broken.
- Both modules install `H2O.LibraryCore.listCanonicalServices()` and `getCanonicalServiceStatus()`, and wrap `selfCheck()` to include a `canonical` section without changing its existing shape.
- Both modules install `H2O.flags` (one localStorage key per surface: `h2o:flags:v1`). No feature reads a flag yet.

**Canonical service name → adapter target:**

| Canonical | Native target | Studio target | Notes |
|---|---|---|---|
| `storage` | `H2O.Library.Store` (0F1e) | `H2O.Library.Store` (S0F1e) | |
| `registry` | `H2O.ChatRegistry` (0F1g) | `H2O.ChatRegistry` (S0F1g) | |
| `index` | `H2O.LibraryIndex` (0F1c) | `H2O.LibraryIndex` (S0F1c) | |
| `archive` | `H2O.archiveBoot` (0D3a) | `H2O.archiveBoot` (S0D3a) | |
| `native-link-opener` | `window.open` adapter (inline) | `chrome.tabs.create` → `window.open` fallback (inline) | |
| `current-chat-provider` | live `window.location.href` + `ChatRegistry.parseChatIdFromHref` (inline) | placeholder `{unsupported: 'studio-has-no-live-chatgpt-chat'}` | Studio has no live ChatGPT chat |
| `project-provider` | `H2O.Projects` (0F2a) | `H2O.Projects` (S0F2a) | |
| `folder-provider` | `H2O.folders` (0F3a) | `H2O.folders` (S0F3a) | |
| `category-provider` | `H2O.Categories` (0F4a) | `H2O.Categories` (S0F4a) | |
| `label-provider` | `H2O.Labels` (0F6a) | `H2O.Labels` (S0F6a) | |
| `tag-provider` | `H2O.Tags` (0F5a) | `H2O.Tags` (S0F5a) | |
| `event-bus` | `H2O.events` (0A1a) | `H2O.events` (S0A1a) | |
| `sync-bridge` | `H2O.Library.Sync` (0F1h) | `H2O.Library.Sync` (S0F1h) | |
| `archive-bridge` | placeholder `{unsupported: 'native-has-direct-archive-access'}` | `chat-list` service from `S0F0a` Surface Host | Native talks to archive directly; only Studio needs the bridge |

**Placeholder contract:** When a provider is absent at registration time, a frozen `{__placeholder: true, unsupported: true, reason}` object is registered. Callers can `getService(name)` without null-checks and detect placeholders via the `__placeholder` flag or `getCanonicalServiceStatus()`.

**`H2O.flags` API (per-surface, no cross-surface sync in Phase 1):**
- `H2O.flags.get(name, fallback)` — returns the stored value or the supplied fallback
- `H2O.flags.set(name, value)` — persists to `h2o:flags:v1` (single localStorage key per surface)
- `H2O.flags.diagnose()` — returns `{ surface, loadedAt, key, keys, values, lastErr }`
- No feature behavior reads a flag in Phase 1. The registry exists so Phase 3+ migrations can ship with per-phase opt-in gates.

### Phase 2 — Shared Registry + Index logic
Extract merge / normalize / dedup of `0F1g Chat Registry` and `0F1c Library Index` into pure shared modules. Both native and Studio import the shared logic. Studio's Chat Registry **adopts the Phase 1 record shape**, ending the current shape drift. Storage stays separate per surface this phase.
**Risk:** medium — load-bearing merge logic.
**DoD:** Studio and native compute byte-identical merged records for identical inputs; both expose the same Phase 1 shape; `repairLinkedFlag()` works on Studio.

#### Phase 2A — Chat Registry merge/normalize logic (LANDED 2026-05-15)

Shared module added at [shared/library/chat-registry-core.js](../../shared/library/chat-registry-core.js) — pure functions only, no DOM / no storage / no events / no side effects. Two byte-identical runtime mirrors load the same body into each surface's script-discovery scheme (the build pipeline that would let Studio reach `shared/` directly is a Phase 3 concern):

- Native bundle: [src-runtime-base/0F0c.⬛️🧬 Library Registry Core 🧬.js](../../src-runtime-base/0F0c.⬛️🧬%20Library%20Registry%20Core%20🧬.js)
- Studio HTML: [src-surfaces-base/studio/S0F0c. 🎬 Library Registry Core - Studio.js](../../src-surfaces-base/studio/S0F0c.%20🎬%20Library%20Registry%20Core%20-%20Studio.js) (wired in `studio.html` after `S0F0a` and before `S0F1g`)

All three publish to `window.H2O.Library.RegistryCore` and short-circuit when a prior loader already set up the module, so duplicate loads are no-ops.

**Exported pure API** (identical on both surfaces):
- `parseChatIdFromHref`, `normalizeChatId`, `isImportedId`, `normalizeHref`, `hrefForChatId`
- `sanitizeState`, `sanitizeRecord`, `sanitizeTombstone`
- `chooseBetterTitle`, `isPlaceholderTitle`, `titleSourceRank`, `TITLE_SOURCE_RANK`
- `diffFields`, `mergeRecord` (enforces `chatId && state.isSaved ⟹ state.isLinked`)
- `deriveRecordView` — returns `'saved' | 'linked' | 'recents' | 'imported'`
- `getRecordDedupeKey` — primary `chatId:<id>`, secondary `href:<normalizedHref>`, tertiary `snap:<latestSnapshotId>`
- `repairLinkedFlag(recordsById)` — pure transform; returns `{ recordsById, scanned, updated, updatedIds }`
- `adoptShape(raw)` — handles both wrapped (`{recordsById, idByHref, …}`) and legacy flat (`{[chatId]: legacy}`) on-disk shapes
- Helpers: `trimString`, `dateMs`, `isoOrEmpty`, `pickOlderIso`, `pickNewerIso`, `uniqueStrings`, `isFiniteNumber`, `maxNum`

**Native `0F1g` changes:** every previously-inline pure helper is now a thin wrapper that delegates to `H2O.Library.RegistryCore.*`. State, storage adapter, event emission, indexing, public API surface, storage key, and boot order are all unchanged. The public `H2O.ChatRegistry.*` shape is byte-identical to v1.0.0 — only the internal implementation route changed.

**Studio `S0F1g` changes:** rewritten to use the shared core and widen the persisted record shape to the canonical Phase 1 shape on first read. Storage key (`h2o:library:chat-registry:studio:v1`) is unchanged. Public surface now mirrors native:

- New sync API (canonical, parity with native): `getRecord`, `getRecordByHref`, `listRecords`, `upsertRecord`, `upsertMany`, `resolveChatId`, `parseChatIdFromHref`, `normalizeHref`, `repairLinkedFlag`, `getStats`, `selfCheck`, `diagnose`
- Legacy async API preserved for backward compat: `upsertChat`, `upsertManyAsync`, `getChat`, `listAll`, `listActive`, `markDeleted`, `patch`, `findByNormalizedHref`

Legacy Studio records (`{chatId, title, projectId, folderId, snapshotCount, lastSeenTs, deleted}`) are read safely — `sanitizeRecord` migrates flat `projectId`/`folderId`/`deleted` into `project.projectId`/`organization.folderId`/`state.isDeleted`, and converts `lastSeenTs` (epoch ms) into `lastSeenAt` (ISO). Once a record is read it's stored back in canonical shape on the next flush, completing the widen in-place. Studio's boot now runs `repairLinkedFlag()` once on first load, just like native, so the invariant holds across the surface.

**Storage:** unchanged. Native still writes to `window.localStorage` under `h2o:library:chat-registry:v1`. Studio still writes through `H2O.Library.Store` under `h2o:library:chat-registry:studio:v1`. **No cross-surface storage migration in this phase** — that's Phase 3.

**Mirror sync constraint:** the body of `shared/library/chat-registry-core.js`, `src-runtime-base/0F0c. …`, and `src-surfaces-base/studio/S0F0c. …` must remain byte-identical (after the IIFE wrapper). Phase 3 introduces a real shared-loader pipeline that removes this triplicate.

#### Phase 2B — Library Index merge/normalize/facet/count logic (LANDED 2026-05-15)

Same shared-core pattern as Phase 2A, this time for Library Index pure logic. Shared module added at [shared/library/library-index-core.js](../../shared/library/library-index-core.js); two byte-identical mirrors load the same body into each surface:

- Native bundle: [src-runtime-base/0F0d.⬛️🧬 Library Index Core 🧬.js](../../src-runtime-base/0F0d.⬛️🧬%20Library%20Index%20Core%20🧬.js)
- Studio HTML: [src-surfaces-base/studio/S0F0d. 🎬 Library Index Core - Studio.js](../../src-surfaces-base/studio/S0F0d.%20🎬%20Library%20Index%20Core%20-%20Studio.js) (wired in `studio.html` after `S0F0c` and before `S0F1c`; also added to `tools/product/studio/pack-studio.mjs` allowlists in both `ARCHIVE_WORKBENCH_SOURCE_FILES` and `ARCHIVE_WORKBENCH_OUT_FILES` at the same index position to avoid the Phase 2A packaging miss)

All three publish to `window.H2O.Library.LibraryIndexCore` and short-circuit when a prior loader already set up the module.

**Exported pure API** (identical on both surfaces):
- Identity / href delegation: `parseChatIdFromHref`, `normalizeChatId`, `normalizeHref`, `isImportedId`, `hrefForChatId` (delegates to RegistryCore when present)
- String / date helpers: `normText`, `slug`, `trimString`, `uniqueStrings`, `toNonNegativeInt`, `firstCount`, `dateMs`, `isoOrEmpty`, `pickNewerDate`, `pickOlderDate`, `compareDateDesc`, `readDateField`
- Source rank / merge (native shape): `SOURCE_RANK`, `sourceRank`, `normalizeSource`, `mergeSourceArrays`, `bestSource`, `sourceHintsForRow`
- Title / confidence / batch: `chooseBetterTitle` (LibraryIndex variant — prefers longer/more-descriptive), `higherConfidence`, `mergeBatchHistory`, `REGISTRY_BATCH_HISTORY_LIMIT`
- Native row: `deriveTurnCounts`, `mergeObjectsById`, `normalizeChatRow`, `mergeChatRecord`
- Studio row: `normalizeRowStudio`, `normalizeLinkedOnlyProjection`
- View / dedupe: `deriveViewFromBooleans` (`'saved'|'linked'|'imported'|'recents'`), `getRowDedupeKey` (chatId → normalizedHref → snapshotId precedence)
- Facets / counts: `bumpFacet`, `facetRowsFromMap`, `normalizeCategoryList`, `collectTagFacets`, `buildFacets` (native shape with sources/folders/labels/categories/projects/tags/years/months), `buildCounts` (native shape), `buildFacetsStudio` (Studio shape with byView/byFolder/byCategory/byProject/byLabel/byTag), `countsFromFacetsStudio`
- Filter / sort / bucket: `matchesOne`, `filterChats`, `sortChats`, `bucketKey`, `isoWeekKey`, `bucketLabel`

**Native `0F1c` changes:** every previously-inline pure helper is now a thin wrapper that delegates to `H2O.Library.LibraryIndexCore.*`. The 3738-line file shrinks to 3350 lines (~400 lines of pure logic moved to shared). State, storage adapter (`KEY_CACHE_V1`, `KEY_REGISTRY_V2`, `KEY_SCAN_LEDGER_V1`, `KEY_PREFS_V1`), event emission, MutationObserver scanning, sidebar recents/project scrape, build-model orchestration, public `H2O.LibraryIndex.*` API — all unchanged. The native row shape is unchanged. The scan-ledger durability rules (firstSeenAt oldest wins, scanBatchId only-on-batch-context) are preserved verbatim in the shared `mergeChatRecord`.

**Studio `S0F1c` changes:** `normalizeRow` delegates to `LibraryIndexCore.normalizeRowStudio`, `normalizeLinkedOnlyRegistryRow` delegates to `normalizeLinkedOnlyProjection`, `rebuildFacets` delegates to `buildFacetsStudio`, `counts()` delegates to `countsFromFacetsStudio`. The 524-line file shrinks to 386 lines. Storage key (`h2o:prm:cgx:library-index:studio:registry:v1`) unchanged. Public `H2O.LibraryIndex.*` API unchanged. The Studio row shape is unchanged; the Saved-tab vs Linked-tab view filter is unchanged (linked-only projection still forces `view: 'linked'`).

**Storage:** unchanged. Native still owns `KEY_CACHE_V1` / `KEY_REGISTRY_V2` / `KEY_SCAN_LEDGER_V1` / `KEY_PREFS_V1`; Studio still owns its own `registry:v1`. **No cross-surface storage migration in this phase.**

**Mirror sync constraint:** as in Phase 2A, the three Library Index Core files (`shared/library/library-index-core.js`, `src-runtime-base/0F0d. …`, `src-surfaces-base/studio/S0F0d. …`) must remain byte-identical (after the IIFE wrapper). Verified via SHA256 (`8d005a6b…d719501`, 37600 bytes) after build.

**Smoke tests:** 25/25 pure-logic tests pass under Node (see `/tmp/h2o-phase2b-tests.mjs`). Covered: native row normalize/merge, Studio row normalize, linked-only projection (linked/saved-rejected/deleted-rejected branches), native + Studio facet builders, filter/sort/bucket, view derivation, dedupe-key precedence, source-rank merge, title-choice heuristic, identity delegation through RegistryCore.

### Phase 3 — Folders migration
Move the folder catalog + binding logic into shared. Native keeps DOM injection (sidebar section + Add-to-Library / Save-to-Folder menu) as an adapter. Studio keeps its sidebar section. Both call the same shared `folderProvider`. **First feature that exercises ADR-0006's shared-storage tier.**
**Risk:** high — folders is the most-touched Library feature.
**DoD:** folder catalog reads/writes go through shared logic; legacy data still loads; both surfaces show identical state.

### Phase 4 — Categories migration
Same pattern as Folders. Auto-classification and candidate-pool logic extracted carefully (sensitive heuristic). Category UI bits stay surface-specific.
**Risk:** medium-high.
**DoD:** same Inbox classifies identically on both surfaces.

### Phase 5 — Labels + Tags migration
Labels catalog + bindings → shared. Tags **pool aggregation + occurrence index + search/filter** → shared; **turn-level keyword extraction stays native** (DOM-coupled).
**Risk:** medium — tag occurrence index is the largest single Library data piece.

### Phase 6 — Projects migration
Project metadata + name resolution → shared. **Native project DOM scraping stays native** (intercepts `/backend-api/projects`).
**Risk:** medium.

### Phase 7 — Actions consolidation
`H2O.LibraryActions` becomes the single business-logic surface for `addToLibrary` / `saveToFolder` / `openLinkedChat`. Studio mirror calls into the same shared layer. Both Command Bars (native 0X1a, Studio S0X1a + S0X1b) invoke through `H2O.LibraryActions.*`.
**Risk:** low.

### Phase 8 — Studio UI completion
With Phases 2–7 done, Studio gains every feature page native has (auto-classification UI, candidate-pool reviewer, label catalog editor). Native page UIs can be deprecated where Studio is preferred.
**Risk:** low — UI only.

### Phase 9 — Native slimming
Identify native code that no longer has a reason to exist (inline merge functions, redundant page UIs). **Mark deprecated, do not delete.** Wait one release for telemetry. Then prune.
**Risk:** medium (regression if deleted too early).

### Phase 10 — Validation + release gate
Comprehensive matrix: mixed-surface flows, storage-migration validators, performance, rollback drill.

## Risks & Rollback Plan

### Risk register

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| Native and Studio Chat Registries diverging (already true today) | high (already happening) | medium | Phase 2 fixes |
| Linked records disappearing after reload | medium | medium | Phase 2's shared registry + Phase 7's snapshot-on-boot |
| Saved snapshots losing folder/category metadata | medium | high | preserve archive integrity in every phase; folder migration must read archive meta |
| Linked-only rows leaking into Saved tab | low | low | already guarded (`view='linked'`) |
| Duplicate records by chatId / href / snapshotId | medium | medium | shared dedup + dedup audit per phase |
| Chat renamed in native | known | low | `titleSource` rank handles it |
| Project moved | medium | low | shared `organization.protected` rule |
| Folder deleted | medium | medium | shared cascade-or-orphan policy must be explicit |
| Label / tag / category renamed | medium | low | catalog with stable IDs; name is a label |
| Record exists in Studio but native chat deleted | medium | low | shared tombstone mechanism |
| Archive capture unavailable | medium | medium | `H2O.LibraryActions.saveToFolder` already soft-fails |
| Bridge unavailable | low | high | dual-transport in place; circuit breaker if both fail |
| `chrome.storage` quota exceeded | medium | medium | ADR-0006 picks Option B specifically to avoid this for large stores |
| localStorage origin isolation | known | (mitigated by bridge) | n/a |
| IndexedDB schema migration | medium | medium | versioned schemas; one-shot migration on boot |
| Multiple extension variants | known | medium | manifest discipline |
| Dev vs prod build mismatch | known | medium | `dev:rebuild` verification per phase |
| Stale loader / manual extension reload | known | low | documented in every phase |
| Offline / storage write failure | medium | low | retry + diag log |
| Partial migration where native + Studio both write conflicting data | **high** | **high** | one-writer rule per key; locked by ADR-0006 |

### Rollback strategy

Every phase ships with a **feature flag** (e.g., `H2O.flags.libraryMigration.phase3.enabled`) defaulting to `true` in dev, `false` in prod initially.

- Flag off → modules fall back to their inline logic (preserved in git history but commented out via the flag check, not deleted until Phase 9).
- Storage migration is **never destructive** — legacy keys stay in localStorage. Shared layer reads legacy on cold start and writes to the new store, but never deletes legacy data until Phase 9.

## Final Recommendation

### Do first (Phase 0)
1. Land this migration plan.
2. Land ADR-0006 committing to Option B (background-SW-owned IndexedDB) as the long-term shared store, with Option A (chrome.storage) for hot-path small state.
3. Land the record-shapes spec with explicit shapes for chat / linked / saved / imported / folder / folder-binding / category / label / tag / project / snapshot-meta.

### Then Phase 1 + Phase 2
Service contract registration (mechanically trivial) unblocks Phase 2 (shared registry + index merge logic, which fixes the most acute pain point — Studio's Chat Registry shape drift).

### Do NOT yet
- Touch 0F3a Folders, 0F4a Categories, 0F5a Tags, 0F6a Labels, 0F2a Projects internals before Phase 2 lands.
- Delete any Studio mirror module.
- Move files in bulk — migration is by responsibility, not by file path.
- Change storage keys. Legacy keys stay loadable until Phase 9.
- Make Studio writeable for features without a defined write-back path.

### The single most important architectural call
ADR-0006 locks **where the canonical Library store physically lives**. Get this right, then start Phase 2.
