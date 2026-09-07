# Studio Dock Panel Contract

Status: Active (Phase 0A landed). Implementation begins Phase 0B.
Audience: anyone designing, implementing, or reviewing Dock Panel features in Studio.
Companion docs:
- `docs/architecture/studio-dock-panel-plan.md` — phased plan.
- `docs/contracts/studio-dock-tab-registration.md` — Studio-local `H2O.Studio.dock.registerTab` API.
- `src-surfaces-base/studio/dock/README.md` — code-level conventions for `dock/` modules.
- `src-surfaces-base/studio/STUDIO_STORAGE_CONTRACT.md` — entity-store shapes; this contract refines per-feature ownership and conflict rules.
- `src-surfaces-base/studio/STUDIO_ARCHITECTURE.md` — surface boundaries.

## Purpose

Define **where Dock Panel feature state lives**, **who is allowed to write it**, **how the two surfaces sync without fighting**, and **what happens in V1 for features that don't fit cleanly into Studio**.

Native and Studio both render user-facing feature UI (highlights, notes, bookmarks, navigator, context). The Dock Panel is the surface for those features. The Command Bar is the surface for system / diagnostic actions. This contract preserves that split: nothing here moves user-feature actions into the Command Bar, and nothing here moves system actions into the Dock Panel.

## Shell Placement vs Feature Semantics

`L-STUDIO-APPLICATION-SHELL` owns the Dock host's structural placement and
geometry within `.wbShell`, `.wbRail`, `.wbSide--sidebar`, and `.wbStage`.
That boundary covers the mount slot, panel/rail composition, application-level
visibility geometry, and preservation of global scroll/layout invariants.

The feature Lane for each Dock tab retains its data, action, and rendering
semantics. Studio Authoring retains authored notes/highlights/editing semantics;
Reader retains opened-conversation consumption; Cockpit Library retains
Library actions and organizational meaning. A feature may receive a temporary
narrow lease to change the Shell-owned Dock slot, but the lease does not create
co-primary structural ownership. Conversely, Shell placement does not transfer
feature meaning to Application Shell.

## Core rules

### Rule 1 — Studio is a reader, not a capturer

Studio reads snapshots and renders them in `studio.html`. Studio never observes or captures the live chatgpt.com DOM. Live capture is the native content scripts' job; the native surface owns it.

Implication: feature state (highlights, notes, bookmarks, navigator, context, captures) is **attached to the chat**, not to a snapshot. The join key across surfaces is the canonical native chat id, exposed in Studio as `ChatRecord.externalId`. Within a chat, the per-message join key is `data-message-id` (which Studio's replay emits identically — see `STUDIO_ARCHITECTURE.md`).

### Rule 2 — Snapshots are immutable

A snapshot is a captured point in time. Studio never mutates a snapshot's turn records. If the user wants to edit a turn's text, that edit goes to `TurnRecord.editOverrideText` (per `STUDIO_STORAGE_CONTRACT.md`), not back into the snapshot.

### Rule 3 — UI state never syncs

Each surface owns its own Dock Panel UI state (open/closed, active tab, panel width, color palette current selection, view mode). Studio's keys are prefixed `h2o:studio:dock:*` and are distinct from native's `h2o:prm:cgx:dckpnl:state:panel:v1` (file:line cite in `docs/architecture/studio-dock-panel-plan.md`). Trying to sync UI state is a guaranteed event loop with no upside.

### Rule 4 — Per-feature ownership is explicit

See the ownership table below. Every cross-surface feature has one of:
- **Shared backend, shared key, last-writer-wins per item** — the Highlights pattern.
- **Shared backend, shared key, preserve-both with conflict flag** — the Notes body pattern.
- **One-way ingestion** — snapshots from native into Studio's reader.
- **Native master, Studio read-only** — Smart Highlight V1.
- **Per-surface local** — Dock Panel UI state, Finder query.

### Rule 5 — No loops

Every new shared-key entity store follows the loop-prevention pattern established in `src-surfaces-base/studio/store/highlights.js`:
1. Writes go through `H2O.Studio.store.<entity>.update(blob)`.
2. The cross-tab listener calls `merge(prev, incoming)` and notifies subscribers with `{ source: 'cross-tab' }`.
3. Engines listen for the change event and re-render; they do **not** call `storage.set` from inside a `source: 'cross-tab'` notification.

If an entity needs a derived/cache key written on the same surface, it must be added to an `IGNORED_SELF_REFRESH_KEYS` set (pattern from `S0F1h Library Sync - Studio.js`).

### Rule 6 — Studio writes use `_meta.source`

Once Phase 3 begins, every blob written to a shared key carries a top-level `_meta.source: 'studio' | 'native'` so future diagnostics can attribute writes. Merge functions must ignore `_meta` during item-level merging.

### Rule 7 — Capture and Smart Highlight are constrained in V1

- **Capture Tab in Studio is disabled.** It renders as an inert placeholder explaining that capture is disabled when viewing snapshots in Studio V1. Studio does not write to the capture queue. (Phase 6 may re-enable for "live-linked" chats — a chat with `externalId` AND a concurrent chatgpt.com tab AND user opt-in — with documented policy.)
- **Smart Highlight in Studio is read-only restore.** If Smart Highlight runs exist for a chat (written by native), Studio renders them inside the Highlights tab. Studio does not re-score runs from saved transcripts in V1.

## Source-of-truth ownership

| Domain | Master | Sync direction | Conflict rule |
|---|---|---|---|
| Live chat capture | Native | n/a | Studio never captures |
| Snapshots | Native, Studio mirrors read-only | one-way (native → Studio) | immutable |
| Library taxonomy (folders / labels / tags / categories / projects / title / emoji / pin) | Shared backend (chrome.storage.local) | two-way via Library Sync | LWW on scalars, union on bindings; existing in `S0F1h` |
| Highlights (marks) | Shared backend, canonical v3 key | two-way (already in place) | LWW per item `ts`; tombstones in Phase 4 |
| Bookmarks | Shared backend, per-chat key | two-way (Phase 3a) | LWW on existence per `msgId`; `snapText` is **write-once** (first writer wins permanently) |
| Notes — body | Shared backend, per-chat key | two-way (Phase 3e) | **Preserve-both with conflict flag** (see below). Not LWW. |
| Notes — tags | Shared backend, same key | two-way | LWW union (set semantics) |
| Notes — pinned | Shared backend, same key | two-way | LWW per `ts` |
| Notes — anchor (`source.msgId`) | Shared backend, same key | two-way | immutable; older `createdAt` wins on disagreement |
| Scratchpad | Shared backend, per-chat key | two-way (Phase 3e) | Preserve-both (same model as note body); FIFO trim at 20 revisions |
| Navigator | Shared backend, per-chat key | two-way (Phase 3d) | LWW per node-id, **per field** (pin / alias / collapse independent) |
| Context — items | Shared backend, per-chat key | two-way (Phase 3c) | LWW per item `ts` |
| Context — history | Shared backend, per-chat key | two-way (Phase 3c) | append-only, monotonic `seq` |
| Context — UI mode | Per-surface local | none | n/a |
| Capture queue | Shared backend at storage layer | one-way (native → Studio read-only) in V1 | LWW per item `ts`; **Studio writes disabled in V1** |
| Smart Highlight runs | Native master | one-way (native → Studio) in V1 | Studio renders read-only |
| Attachments | Derived from reader DOM | n/a | re-discovered per render |
| Dock Panel UI state (open / view / width / bg mode / mode / arrange) | Per-surface local; Studio uses `h2o:studio:dock:*` | none | n/a — never sync |
| Finder query | Per-surface, transient | none | n/a |

## Notes-body preserve-both conflict model

This is the only feature that does **not** use last-writer-wins for body content. Concurrent edits to the same note body must both survive until the user explicitly resolves them.

### Record shape (Studio side; native equivalent in Phase 3e)

```
NoteRecord {
  id: string,
  chatId: string,
  source: { msgId, role } | null,          // immutable after creation
  tags: string[],                          // LWW union
  pinned: boolean,                         // LWW per ts
  createdAt: number,
  updatedAt: number,                       // ts of last non-body change
  bodyVersions: [
    {
      revisionId: string,                  // ulid
      body: string,
      writtenAt: number,                   // monotonic clock (Phase 4)
      writtenBy: 'studio' | 'native',
      replacedRevisionId?: string,         // parent rev this edit was made on top of
      conflictsWith?: string[],            // sibling revisionIds sharing the same parent
    }
  ],
  activeRevisionId: string,                // the rev the local UI shows by default
  conflictFlag: boolean,                   // true iff bodyVersions has >1 leaf
}
```

### Detection

After merging two `bodyVersions` arrays:

1. A "leaf" is a `revisionId` that is not any other rev's `replacedRevisionId`.
2. If there is more than one leaf with the **same `replacedRevisionId`**, the note is in conflict.
3. Set `conflictFlag = true`; each conflicting leaf gets `conflictsWith` filled with its sibling ids.
4. `activeRevisionId` is **not** changed by the merge — each surface keeps its local choice until the user resolves.

### Resolution

The Notes tab UI shows a "two versions" badge on conflicted notes. The user opens a side-by-side picker and chooses one revision. The resolution writes a new revision:

```
{
  revisionId: <new ulid>,
  body: <chosen body>,
  writtenAt: <now>,
  writtenBy: <local surface>,
  replacedRevisionId: <chosen leaf>,
  conflictsWith: undefined,
}
```

After this rev is appended, only one leaf remains; `conflictFlag = false`.

### What is never automatic

- **No automatic merge of bodies.** A three-way text merge is out of scope; the goal is to never lose user text.
- **No automatic GC of old revisions.** Body history is kept indefinitely by default. The scratchpad is the exception: FIFO trim at 20 revisions, with a tab-UI warning before trimming.
- **No silent overwrite.** Writing a body always either chains onto a known parent (single-leaf) or registers as a conflict (multi-leaf).

### Other note fields

Tags, pinned, and anchor are independent of body and follow their own rules (LWW union on tags; LWW per `ts` on pinned; immutable on anchor). A tag edit on Studio and a body edit on native do not conflict with each other.

## Migration story

For every feature whose state is going to cross surfaces, the migration path is the same one Highlights followed in Phase A1:

1. Define the entity store under `src-surfaces-base/studio/store/<entity>.js` using the IIFE pattern (see `src-surfaces-base/studio/dock/README.md`).
2. Read the existing native key as canonical; do not invent a new key for shared state.
3. On first read, upgrade `schemaVersion` in memory if needed and write back at current version. Lazy-on-read; no migration entry point.
4. Add cross-context sync via `H2O.Studio.platform.broadcast.onAnyChange`.
5. Add an `_meta.source` field to all writes (Phase 3+).
6. Add tombstones for any entity that supports delete.

`fullBundle.v2` schema extension to carry feature state is **deferred to Phase 5**. Until then, bundle round-trips do not carry highlights, notes, bookmarks, navigator, context, or captures. This is a known limitation; the contract document tracks it so it is not a surprise.

## What this contract does not cover

- **Native runtime behavior changes.** Native files in `src-runtime-base/` are not modified by this contract; their existing behavior is the source of truth.
- **A shared cross-surface `H2O.Feature.dock.register` contract.** Studio uses its own `H2O.Studio.dock.registerTab` first (see `docs/contracts/studio-dock-tab-registration.md`). Unification is considered no earlier than Phase 6.
- **UI design for tabs.** Visual design lives in CSS and tab implementation files, not in this contract.
- **Server-side or cloud sync.** All sync in scope is local cross-context (chrome.storage.local + onChanged today; tauri-plugin-sql + events tomorrow). Any future cloud-sync goes through a separate adapter; this contract continues to govern local state.

## Open items tracked here

- **Smart Highlight V2** — read-only-restore is the V1 stance; opt-in re-score is the Phase 6 question.
- **Capture re-enable policy** — "live-linked chat" definition (Phase 6).
- **Monotonic clock helper** — `H2O.Studio.clock.now()` becomes the single source of `ts` values in Phase 4.
- **Conflict diagnostics in Command Bar** — Phase 4 adds a Studio Command Bar entry that surfaces detected note-body conflicts across all chats.
