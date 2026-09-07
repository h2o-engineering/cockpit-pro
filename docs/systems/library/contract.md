# Contract: Library

Status: Active

Purpose:
Define ownership boundaries for H2O Library surfaces, Library Workspace navigation, Library Index data, and feature-owned list/detail pages.

## Related architecture documents

The contract on this page defines **surface ownership and route invariants**. The data shapes the contract references (Chat Registry record, folder, category, label, tag, project, snapshot metadata) and the cross-surface migration that will move their canonical storage off chatgpt.com are tracked separately:

- [Library Migration Plan](../../architecture/library-migration-plan.md) — the 10-phase plan to move shared Library business logic out of chatgpt.com page-world and consolidate it under `shared/library/` while keeping native adapters for DOM-coupled work. **Phase 1 landed 2026-05-15** — canonical service names registered on both surfaces (see plan for the table); `H2O.LibraryCore.listCanonicalServices()` and `getCanonicalServiceStatus()` are the diagnostic entry points. **Phase 2A landed 2026-05-15** — pure Chat Registry merge/normalize logic extracted into `shared/library/chat-registry-core.js` (loaded by `src-runtime-base/0F0c.` on native, `src-surfaces-base/studio/S0F0c.` on Studio); `0F1g` and `S0F1g` now share byte-identical merge behaviour and Studio's record shape has been widened to the canonical Phase 1 shape with `state.isLinked` + provenance fields. Storage stays separate per surface. **Phase 2B landed 2026-05-15** — pure Library Index normalize/merge/facet/count/filter/sort/bucket logic extracted into `shared/library/library-index-core.js` (loaded by `src-runtime-base/0F0d.` on native, `src-surfaces-base/studio/S0F0d.` on Studio); `0F1c` and `S0F1c` now share byte-identical row + facet + count computation. Row shapes per surface are unchanged; storage remains separate.
- [ADR-0006: Shared Library Storage Tier](../../decisions/ADR-0006-shared-library-storage-tier.md) — commits to a background-service-worker-owned IndexedDB (`h2o.library.shared`) as the canonical store; `chrome.storage.local` is reserved for the broadcast envelope and small hot-path UI state.
- [Library Record Shapes](record-shapes.md) — single source of truth for every Library record (chat registry, linked-only projection, saved transcript, imported, folder, folder binding, category, label, tag, project, snapshot metadata, scan ledger). Includes per-field merge rules, invariants, and dedupe keys.
- [ADR-0005: Linked vs Saved Library Records](../../decisions/ADR-0005-linked-vs-saved-library-records.md) — the linked/saved state model summarised in the "Library Record States" section below.

This page should not duplicate the content of those documents. When a contract assertion needs detail (e.g., "what exactly is in a Chat Registry record"), link out to the record-shapes spec rather than restating it here.

## Engineering Lane Ownership

`L-COCKPIT-LIBRARY` owns the durable cross-surface Library Product capability:
Library workspace/business behavior, catalog and Chat Registry semantics,
Library Index/read models, search, ranking, filters, snippets, browse/recents,
Explorer/Insights semantics,
folders, categories, labels, tags, projects, organizational relationships and
bindings, Library-specific navigation/actions, and shared Library contracts and
core logic.

The primary Domain is `COCKPIT` because the capability is shared by Product
surfaces and its purpose is being the Library. It is not `PLATFORM` merely
because more than one surface consumes it. Surface implementations and adapters
may remain Extension- or Studio-specific while consuming the Library-owned
contracts.

The adjacent boundaries are explicit:

- `L-STORAGE-SAVED-CHATS` owns durable archive representation, saved-chat
  serialization, retention, recovery, and durability.
- `L-PLATFORM-SYNC` owns propagation, conflict handling, and convergence
  mechanics between surfaces.
- `L-STUDIO-APPLICATION-SHELL` owns where Library routes, containers, and
  sidebar slots are structurally mounted in Studio.
- `L-STUDIO-READER` owns consumption of an opened conversation.
- `L-STUDIO-AUTHORING` owns authored notes, highlights, and editing semantics.
- `L-COCKPIT-KNOWLEDGE-MODEL` owns semantic cross-item and cross-fragment
  references, anchors, provenance, backlinks, and semantic relationships.
- `L-STUDIO-SOURCE-DOCUMENTS` owns external/reference document structure,
  versions, parsing, and extraction; `L-STUDIO-CANVAS` owns Canvas spatial
  composition and Canvas-local relations.

Library owns what a catalog entry, organizational relationship, search result,
route, or action means; the Application Shell owns where its Studio entry or
route is structurally mounted. Item-to-folder/project/category/label/tag
bindings are Library relationships. Relations such as `supports`,
`contradicts`, or `derived-from` between exact items or fragments belong to
Knowledge Model.

Generic Library item kinds may include `captured_chat`, `editable_chat`,
`native_note`, `source_document`, `canvas`, and future kinds. Library owns the
catalog/search/discovery envelope only; content semantics remain with the
applicable owner.
A narrow cross-Lane edit to `studio.html`, `studio.css`, `studio.js`, Ribbon,
Dock, or sidebar composition uses a temporary lease and does not create
co-primary ownership.

## Component Owners Within the Library Lane

- `0F1b Library Workspace` owns the Library dashboard behavior, Library search field, workspace tabs, first-row route shortcuts, sidebar Library-entry semantics, and Library UI preferences. Application Shell retains the structural mount geometry.
- `0F1c Library Index` owns the normalized known-chat read model used by Library Workspace, Explorer, Analytics, Recents, and source diagnostics.
- `0F1d Library Insights` owns rendering for Explorer and Analytics only. It must consume Library Index APIs and must not scan ChatGPT DOM or own persistent chat data.
- Folders, Labels, Categories, Tags, and Projects are Library-owned subdomains whose components own their catalogs, list pages, detail pages, popups, and business relationships. Persistence remains behind the applicable storage boundary. Library Workspace may route to those pages but must not duplicate their page ownership.
- `0F1a Library Core` owns Library route semantics, page-host registration, and Library service registries. Library feature owners register with Core; Core does not own feature data or Studio application-shell geometry.

## Library Workspace Invariants
- The canonical second-row workspace tab order is `Dashboard`, `Analytics`, `Explorer`, `Recents`, `Saved`, `Organize`.
- The canonical Recents tab key is `recents`. The old `recent` key is migration-only and must normalize to `recents`.
- The first-row shortcuts beside search are route shortcuts for `Folders`, `Labels`, `Categories`, and `Projects`; they open the canonical feature-owned list pages.
- Library Workspace must not render Folders, Labels, Categories, or Projects lists inside its body after those pages have route owners.
- Opening a workspace tab should keep Library mounted and update the Library route view when route state is available.

## Route Invariants
- H2O internal pages use `h2o_flsc=1` plus `h2o_flsc_view=<view>` for stable URL state.
- Library workspace route views are `library`, `dashboard`, `analytics`, `explorer`, `recents`, `saved`, and `organize`.
- `library` and `dashboard` both resolve to the Dashboard tab; canonical emitted Dashboard URL should use `library` unless a caller explicitly preserves `dashboard`.
- Feature list/detail route views remain feature-owned: `folders`, `folder`, `labels`, `label`, `categories`, `category`, `tags`, `tag`, `projects`, and `project`.
- Browser back/forward inside H2O surfaces must be routed through Core route parsing and feature route handlers, not through direct DOM toggles.

## Library Record States (Linked vs Saved)

A Chat Registry record (`0F1g`) carries two independent state flags that together describe the user's intent toward the chat:

- `state.isLinked` — explicit intent that the chat belongs in the Library. Set by the **Add to Library** action (planned, future phase). A linked-only record stores only identity + metadata + native URL; **no transcript is captured**.
- `state.isSaved` — a full transcript snapshot exists in `0D3a` archive. Set by the **Save to Folder** action (the planned visible rename of today's "Add to Folder", future phase). Implies a captured transcript.

### Invariant (enforced in `0F1g mergeRecord`)

```
chatId is parsable AND state.isSaved === true   ⟹   state.isLinked === true
```

A "saved-only with chatId" record cannot exist. The only legitimate `isSaved === true && isLinked === false` shape is an **imported/local transcript** whose `chatId` is empty (no native source URL to link back to). The invariant is enforced at every merge, and a one-shot `H2O.ChatRegistry.repairLinkedFlag()` backfill runs on boot to fix any pre-existing records.

### Link provenance fields

Three top-level fields on each record carry the provenance of `isLinked` once it is true:

| Field | Semantics | Conflict rule |
|---|---|---|
| `linkedAt` | ISO timestamp of the first true transition | Existing wins (first-write); never overwritten on re-merge |
| `linkedFrom` | Action label (`'add-to-library'`, `'save-to-folder'`, `'backfill:saved'`, `'manual-api'`, …) | Incoming patch wins, else existing, else `'backfill:saved'` |
| `linkSourceHref` | Exact href at link time (full URL when available) | Incoming patch wins, else existing, else record `href`/`normalizedHref` |

When `isLinked` is false, all three remain empty strings. The fields are additive on the existing record shape; no `schemaVersion` bump is needed because absence on a legacy record is indistinguishable from the explicit empty default.

### Click behavior (defined here, implemented in a later phase)

The Studio Library row click rules below are a **contract**, not yet a UI:

- `state.isSaved` (transcript exists, snapshot in archive) — **primary click → Studio reader at `#/read/<snapshotId>`**. Secondary action available: "Open original ChatGPT chat" via `linkSourceHref`/`href` (omit when the source URL is empty, i.e. imported-only).
- `state.isLinked && !state.isSaved` — **primary click → open original ChatGPT chat** in a new tab using `linkSourceHref` or `href`.
- Neither flag — record is invisible in the Library page by default; visible only in the Recents facet, where the click target is the native ChatGPT URL.

These rules will be implemented in a later phase. Phase 1 only lands the data model, the invariant, and the backfill — no UI, no menu changes, no rename.

## Forbidden Coupling
- Explorer and Analytics must not directly scan native Recents, Projects DOM, chat history cache, or feature stores.
- Library Workspace must not write Folders, Labels, Categories, Tags, or Projects storage directly.
- Feature list/detail pages must not depend on Library Workspace being mounted.
- No separate database should be introduced for Library page routing or Explorer source pooling while Library Store and Library Index can represent the state.
- Native ChatGPT title, sidebar, or DOM controllers may be observed through documented adapters only; feature owners must not patch native internals directly when Core/PageHost/Index services can provide the boundary.
