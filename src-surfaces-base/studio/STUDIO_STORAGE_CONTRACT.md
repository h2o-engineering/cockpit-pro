# Studio Storage Contract

Status: Active
Audience: Anyone touching persistence from `src-surfaces-base/studio/`.
Companion: `STUDIO_PORTABILITY_CONTRACT.md`, `STUDIO_PLATFORM_ADAPTER_GUIDE.md`. Cross-references: `docs/architecture/storage-map.md`, `docs/systems/library/storage.md`, `docs/systems/library/sync-rules.md`.

## Purpose

Define the single, portable façade through which Studio persists data, the canonical record shapes, and the conceptual mapping from the current Chrome-side storage (IndexedDB + localStorage + `chrome.storage.local`) to a future SQLite schema running under Tauri. The goal is a storage layer where a SQLite swap is mechanical, not a redesign.

This document supersedes scattered storage assumptions inside `src-surfaces-base/studio/` and is consistent with the existing repo storage rules in `docs/architecture/storage-map.md` and `docs/systems/library/storage.md` (it adds the portability layer those docs do not address).

## Lane Boundary

This façade does not make all persisted semantics one Lane. Cockpit Library
owns Library catalog, Index, organization, organizational-relationship, and
action meaning. Cockpit Knowledge Model owns semantic references, anchors,
provenance, and cross-item/fragment relationships. Studio Canvas owns Canvas
spatial/content semantics and Studio Source Documents owns external/reference
document versions, parsing, and extraction.
Saved Chats Storage owns durable archive/saved-chat representation,
serialization, retention, recovery, and durability. Platform Sync owns
cross-surface propagation and convergence. Studio Host Integration owns the
concrete MV3/Tauri/OS storage bridge, not the business meaning of records that
pass through it. Classify ownership by the semantic operation, not by the fact
that bytes are persisted or a module uses the word “publication.”

`L-STORAGE-BINARY-ASSETS` owns the generic shared binary/CAS target authority.
The existing mature saved-chat CAS implementation remains under
`L-STORAGE-SAVED-CHATS` until an explicit extraction Mission transfers proven
generic primitives. This contract does not claim or implement that extraction.

## The Façade: `H2O.Studio.store`

All Studio feature persistence routes through one object: `H2O.Studio.store`. The façade has two parts:

- **Entity stores** — one namespace per domain entity (chats, turns, folders, labels, tags, categories, projects, captures, highlights, prefs, etc.) with relational-shaped methods.
- **Generic KV** — for transient/UI/preference state where relational modeling would be overkill.

Both are backed by `H2O.Studio.platform.storage` today and swap to SQLite tomorrow.

### Entity store shape (sketch)

```ts
interface EntityStore<T extends { id: string; schemaVersion: number }> {
  get(id: string): Promise<T | null>;
  list(query?: EntityQuery<T>): Promise<T[]>;
  upsert(record: T): Promise<T>;
  bulkUpsert(records: T[]): Promise<T[]>;
  remove(id: string): Promise<void>;
  subscribe(fn: (change: ChangeEvent<T>) => void): Unsubscribe;
}
```

Concrete namespaces:

```ts
H2O.Studio.store.chats        : EntityStore<ChatRecord>
H2O.Studio.store.turns        : EntityStore<TurnRecord>
H2O.Studio.store.snapshots    : EntityStore<SnapshotRecord>
H2O.Studio.store.folders      : EntityStore<FolderRecord>
H2O.Studio.store.labels       : EntityStore<LabelRecord>
H2O.Studio.store.labelBindings: EntityStore<LabelBindingRecord>
H2O.Studio.store.tags         : EntityStore<TagRecord>
H2O.Studio.store.tagBindings  : EntityStore<TagBindingRecord>
H2O.Studio.store.categories   : EntityStore<CategoryRecord>
H2O.Studio.store.projects     : EntityStore<ProjectRecord>
H2O.Studio.store.highlights   : EntityStore<HighlightRecord>
H2O.Studio.store.chatTitles   : EntityStore<ChatTitleRecord>
H2O.Studio.store.captures     : EntityStore<CaptureEventRecord>
H2O.Studio.store.editOverlay  : EntityStore<EditOverlayRecord>   // Phase 2a — non-destructive overlay over saved snapshots; see STUDIO_OVERLAY_CONTRACT.md
```

Generic KV (for UI prefs, sidebar layout, sentinel, etc.):

```ts
H2O.Studio.store.prefs.get(scope: string): Promise<unknown | null>
H2O.Studio.store.prefs.set(scope: string, value: unknown): Promise<void>
H2O.Studio.store.prefs.remove(scope: string): Promise<void>
H2O.Studio.store.prefs.subscribe(scope: string, fn): Unsubscribe
```

Where `scope` is a dotted name (e.g., `library:ui`, `library:workspace:sidebar-layout`, `minimap:ui:collapsed`) and the value is a JSON-serializable object.

### Bad vs Good

Bad (forbidden in new code; existing instances are debts):

```js
chrome.storage.local.set({ 'h2o:prm:cgx:fldrs:state:data:v1': bigBlob });
localStorage.setItem('h2o:studio:ui-prefs:v1', JSON.stringify(prefs));
const db = await idb.openDB('h2o.library.studio', 1, ...);
sessionStorage.setItem('h2o:studio:lastListHash:v1', hash);
```

Good:

```js
await H2O.Studio.store.folders.bulkUpsert(folderRecords);
await H2O.Studio.store.prefs.set('studio:ui', prefs);
const last = await H2O.Studio.store.prefs.get('studio:lastListHash'); // adapter chooses session vs durable based on scope policy
```

## Canonical Domain Models

These shapes are the authority. Implementations may add optional fields but must not rename or repurpose existing ones without a `schemaVersion` bump and a migration. Types live in `@h2o-studio/types` (or — if creating the package now is too much — in `src-surfaces-base/studio/platform/types.js` as JSDoc typedefs).

### Common envelope

Every record carries:

```ts
type RecordEnvelope = {
  id: string;             // stable primary key
  schemaVersion: number;  // bumped on shape change
  createdAt: number;      // epoch ms
  updatedAt: number;      // epoch ms
};
```

### ChatRecord

```ts
type ChatRecord = RecordEnvelope & {
  schemaVersion: 1;
  source: 'chatgpt' | 'claude' | 'import' | 'manual';
  externalId?: string;       // ChatGPT conversation id, etc.
  title: string;
  emoji?: string;
  pinned: boolean;
  folderId?: string;
  categoryId?: string;
  labelIds: string[];
  tagIds: string[];
  projectId?: string;
  lastCapturedAt?: number;
  lastSnapshotId?: string;
  messageCount?: number;
  archivedAt?: number;       // soft delete
};
```

### TurnRecord

```ts
type TurnRecord = RecordEnvelope & {
  schemaVersion: 1;
  chatId: string;            // FK → ChatRecord.id
  index: number;             // 0-based position within chat
  role: 'user' | 'assistant' | 'system' | 'tool';
  contentHtml?: string;      // sanitized HTML for replay; null if only markdown
  contentText: string;       // plain text fallback
  createTime?: number;       // ChatGPT timestamp if available
  metadata?: Record<string, unknown>;
  editOverrideText?: string; // user-edited override (replaces current studio.js localStorage key)
};
```

### SnapshotRecord

```ts
type SnapshotRecord = RecordEnvelope & {
  schemaVersion: 1;
  chatId: string;
  turnIds: string[];         // FK → TurnRecord.id, in order
  capturedAt: number;
  isPinned: boolean;
  reason?: 'manual' | 'auto' | 'retention';
};
```

### FolderRecord, LabelRecord, TagRecord, CategoryRecord, ProjectRecord

Each follows the same envelope plus:

```ts
type FolderRecord    = RecordEnvelope & { name: string; iconColor?: string; parentId?: string };
type LabelRecord     = RecordEnvelope & { name: string; color: string };
type TagRecord       = RecordEnvelope & { name: string };
type CategoryRecord  = RecordEnvelope & { name: string };
type ProjectRecord   = RecordEnvelope & { name: string; description?: string };
```

Bindings (many-to-many) are explicit entity stores so they translate cleanly to SQLite join tables:

```ts
type LabelBindingRecord = RecordEnvelope & { chatId: string; labelId: string };
type TagBindingRecord   = RecordEnvelope & { chatId: string; tagId: string };
```

### HighlightRecord (replaces `S3H1a`'s `h2o:nlnhghlghtr:state:inline_highlights:v3` blob)

```ts
type HighlightRecord = RecordEnvelope & {
  schemaVersion: 3;
  answerId: string;       // turn id
  chatId: string;
  marks: Array<{
    start: number;
    end: number;
    color: 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'gray';
    note?: string;
  }>;
};
```

The current `S3H1a` schema is already at v3 with v2/v1 read-fallback; preserving `schemaVersion: 3` for new records keeps reader compatibility.

### ChatTitleRecord (replaces `h2o:prm:cgx:library:chat-title:state:v1:${chatId}` per-chat keys)

```ts
type ChatTitleRecord = RecordEnvelope & {
  schemaVersion: 1;
  chatId: string;            // primary key alias
  emoji?: string;
  customTitle?: string;
  heat?: number;
  tint?: string;
};
```

### CaptureEventRecord (audit trail for what came in when)

```ts
type CaptureEventRecord = RecordEnvelope & {
  schemaVersion: 1;
  chatId: string;
  snapshotId?: string;
  origin: 'chatgpt-live' | 'chatgpt-import' | 'manual';
  status: 'ok' | 'partial' | 'failed';
  detail?: string;
  ts: number;
};
```

## Mapping: Current Storage → StudioStore → Future SQLite

A row of this table reads as "the value behind this current storage key becomes records of this entity store, which translates to this SQLite table on port."

| Current key / shape | StudioStore namespace | Future SQLite table | Notes |
|---|---|---|---|
| `h2o:prm:cgx:library:registry:v2` (chat registry blob) | `store.chats` | `chats` | One row per chat. Blob keys (e.g., `id`, `title`, `folderId`) become columns. |
| `h2o:library:chat-registry:studio:v1` (Studio variant) | `store.chats` | `chats` | Merged into single table; the v1 variant becomes legacy and migration-read only. |
| `h2o:prm:cgx:library-index:studio:registry:v1` (`{ rows, ts }` blob in IndexedDB via Library Store) | `store.chats` (index columns; `lastCapturedAt`, `messageCount`, `pinned`) | `chats` | Index is a read-model over `chats`; in SQLite this is a derived view, not a separate table. |
| `h2o:prm:cgx:fldrs:state:data:v1` (folder vault blob) | `store.folders` | `folders` + `chats.folderId` | Folder objects → `folders` table. `chatIds[]` reverse-mapping → `chats.folderId` FK. |
| `h2o:prm:cgx:fldrs:state:ui:v1` | `store.prefs.set('folders:ui', ...)` | `prefs` table (key, value JSON) | UI state stays generic KV. |
| `h2o:prm:cgx:fldrs:state:see_more:v1` | `store.prefs.set('folders:see_more', ...)` | `prefs` | Same. |
| `h2o:prm:cgx:fldrs:state:folders_expanded:v1` | `store.prefs.set('folders:expanded', ...)` | `prefs` | Same. |
| `h2o:prm:cgx:fldrs:state:projects_cache:v1` | (derived; do not persist) | (none) | This is a cache; rebuild from `chats` and `projects` on demand. |
| `h2o:prm:cgx:library:labels:catalog:v1` | `store.labels` | `labels` | One row per label. |
| `h2o:prm:cgx:library:labels:bindings:v1` | `store.labelBindings` | `label_bindings` (chat_id, label_id) | Many-to-many join table. |
| `h2o:prm:cgx:library:labels:ui:v1` | `store.prefs.set('labels:ui', ...)` | `prefs` | |
| `h2o:prm:cgx:library:tags:studio:prefs:v1` | `store.prefs.set('tags:ui', ...)` | `prefs` | |
| `h2o:prm:cgx:library:tag-auto-pool:v1` | `store.tags` | `tags` | Tag definitions normalize into `tags`. |
| `h2o:prm:cgx:library:tag-occ-index:v1` | (derived; do not persist) | (none) | Computed from `tag_bindings` on demand. |
| `h2o:prm:cgx:library:cat-candidate-pool:v1` | (derived) | (none) | |
| `h2o:prm:cgx:library:category-overrides:v1` | `store.chats` (`categoryId` column) | `chats.category_id` FK | The "override" is just the current category — denormalize into chat row. |
| `h2o:prm:cgx:library-workspace:sidebar-layout:v1` | `store.prefs.set('library:workspace:sidebar-layout', ...)` | `prefs` | |
| `h2o:prm:cgx:library-insights:prefs:v1` / `:studio:prefs:v2` | `store.prefs.set('library:insights', ...)` | `prefs` | Merge v1 → v2 → unified prefs scope. |
| `h2o:prm:cgx:nlnhghlghtr:state:inline_highlights:v3` | `store.highlights` | `highlights` (chat_id, turn_id, marks JSON) | One row per `(chat_id, turn_id)`. Studio-side store reads/writes only this canonical v3 key (Phase A1/A2). Native `src-runtime-base/3H1a` also reads/writes only this key after Phase B1; legacy v1/v2/alias keys, GM_*, and the localStorage mirror are gone from both surfaces. Single shared backend (`chrome.storage.local`); cross-context sync via `chrome.storage.onChanged`. |
| `h2o:prm:cgx:library:chat-title:state:v1:${chatId}` (per-chat keys) | `store.chatTitles` | `chat_titles` (chat_id PK) or columns on `chats` | Prefer columns on `chats` long-term; keep separate during migration. |
| `h2o:tmjttl` and NS variants | `store.chatTitles` | (folded into above) | |
| `h2o:archiveWorkbench:editOverrides:v1:${snapshotId}:${turnIdx}` | `store.turns` (`editOverrideText` field) | `turns.edit_override_text` | Stop keying on `(snapshotId, turnIdx)`; key by `turnId`. |
| `h2o:studio:ui-prefs:v1` | `store.prefs.set('studio:ui', ...)` | `prefs` | |
| `h2o:studio:lastListHash:v1` (sessionStorage) | `store.prefs.set('studio:lastListHash', ...)` with `scope.policy = 'session'` | (none in SQLite; in-memory) | Adapter routes session-policy scopes to ephemeral storage. |
| `h2o:prm:cgx:mnmp:*` (MiniMap UI state) | `store.prefs.set('minimap:*', ...)` | `prefs` | All MiniMap UI state is generic KV. |
| `h2o:prm:cgx:mrgnnchr:*` (Margin Characters) | `store.prefs.set('margin:*', ...)` | `prefs` | Same. |
| `h2o:qwash:map:v1` | `store.prefs.set('qwash:map', ...)` | `prefs` | Map of `qId → color`; stays generic since it's UI-derived. |
| `h2o:library:cross-surface:broadcast:v1` and `:native:v1` | Not in StudioStore — handled by `platform.broadcast` | (no persistence) | These are signaling keys, not durable data. |
| `h2o:prm:cgx:library:_sentinel:v1:studio:${adapter}` | Adapter internal | (none) | Probe sentinel for adapter selection. |

## Schema Versioning Rules

1. **In-record `schemaVersion`.** Every entity record carries `schemaVersion`. Migrations read the version off the row, not off the storage key. This is what makes the SQLite migration mechanical: SELECT, branch on schemaVersion, transform, UPDATE.
2. **Storage-key versioning is preserved for back-compat.** Existing `:v1` / `:v2` / `:v3` suffixes stay; new records writing to old keys still bump `schemaVersion` if the shape changes.
3. **Migrations live in one place.** Either `@h2o-studio/core/migrations/` or `src-surfaces-base/studio/platform/migrations.js`. Feature code does not migrate inline.
4. **Forward-compatibility is acceptable; backward-compatibility is required.** If a record is upgraded v1 → v2, the adapter must still be able to read pre-existing v1 records and upgrade on read. New writes are always at the current version.

## Indexing and Query Patterns

Today: most queries are full-blob reads followed by in-memory filtering (e.g., Library Index loads `{ rows, ts }` and filters/sorts in JS). This works at current scale but won't at thousands of chats.

For the contract:

- **List operations accept a query object** (`EntityQuery<T>`) with `filter`, `sort`, `limit`, `offset` fields. The MV3 adapter implements these in memory; the Tauri adapter implements them as SQL. Feature code uses the same query shape on both.
- **Subscriptions are per-namespace, not per-key.** `store.chats.subscribe(fn)` fires on any chat upsert/remove. Coarser subscriptions are cheap on both adapters.
- **No client-side full-text search yet.** When it's needed, it goes through `H2O.Studio.search` (separate concern, future). Do not bake full-text indexes into `store.chats`.

## What Stays Generic KV (Prefs) and Why

A field belongs in `prefs` (generic KV) if:

- It is UI state owned by exactly one consumer.
- It has no relations to other entities.
- A future Tauri SQLite schema would not benefit from typed columns.

Examples: sidebar layout, expanded/collapsed states, last-viewed list hash, panel positions, theme.

A field belongs in an entity store if any of:

- It has relationships (foreign keys, many-to-many).
- Multiple consumers read it.
- A future query would benefit from a column index.

Examples: chat metadata, label bindings, highlight marks per turn, chat-title state.

## What This Contract Does Not Cover

- The actual SQLite schema (column names, indexes, FKs). That comes at port time and is a function of these entity shapes — the contract guarantees the shapes map cleanly.
- Server-side / cloud sync. There is no remote sync today. When one is added, it goes through a `H2O.Studio.platform.sync` adapter on top of the same StudioStore — not in place of it.
- Backups. Existing Data Core (`0B1a` native) handles backup imports; a Studio-side backup interface will route through `platform.files`.

## Existing Repo Docs This Refines

- `docs/architecture/storage-map.md` — defines storage-key ownership. This contract is consistent with that map; it adds the StudioStore façade layer above the keys.
- `docs/systems/library/storage.md` — defines Library-specific storage boundaries. Compatible: catalogs remain feature-owned; this contract reorganizes the access path through StudioStore but does not move ownership.
- `docs/systems/library/sync-rules.md` — defines one-way sync into Index. Unchanged: StudioStore subscriptions are the medium for the same one-way flow.
- `docs/systems/archive/contract.md`, `metadata-schema.md`, `capture-flow.md` — currently drafts. When filled in, they should reference `SnapshotRecord` and `TurnRecord` here as the canonical shapes.

## Companion: Studio Dock Panel

The Studio Dock Panel introduces per-feature state for Highlights, Bookmarks, Notes (with preserve-both body history), Navigator, Context, Capture, Finder, and Attachments. Its ownership, conflict, and surface-policy rules are governed by a separate contract that builds on this one:

- `STUDIO_DOCK_PANEL_CONTRACT.md` — source-of-truth ownership table, per-feature conflict rules (including the non-LWW preserve-both model for note bodies and the scratchpad), UI-state-never-syncs rule, and the Capture / Smart Highlight V1 stance.
- `../../docs/contracts/studio-dock-tab-registration.md` — the Studio-local `H2O.Studio.dock.registerTab` API. Studio-local only; the native runtime's `H2O.Dock.registerTab` is not unified with it.
- `dock/README.md` — code-level conventions for modules under `src-surfaces-base/studio/dock/` (IIFE pattern; no ES module syntax; constants attach to `H2O.Studio.dock.*`).
- `../../docs/architecture/studio-dock-panel-plan.md` — the phased plan. Read this for sequence (Phase 0A → 0B → 1 → … → 6) and what is in/out of each phase.

Where the Dock Panel contract introduces new entity stores (Bookmarks, Notes, Navigator, Context), they follow the storage-key, schemaVersion, and migration rules already declared in this document. Where it diverges (notes-body preserve-both), the divergence is documented in `STUDIO_DOCK_PANEL_CONTRACT.md` and is treated as a refinement to the generic LWW guidance here, not a contradiction.

`fullBundle.v2` schema extension to carry Dock Panel feature state is **deferred to Phase 5** of that plan. Until then, bundle round-trips do not carry feature state. This document will be updated to reflect the new bundle fields when Phase 5 lands.
