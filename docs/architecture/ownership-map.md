# Architecture: Ownership Map

Status: Active

Purpose:
Map cross-system ownership boundaries for H2O internal pages.

## Engineering Lane Boundaries

- `L-COCKPIT-LIBRARY` owns Library business semantics across Product surfaces:
  catalog/Chat Registry, Index/read models, search/ranking/filters/snippets,
  browse/recents, Explorer/Insights, organizational relationships/bindings,
  navigation/actions, and shared Library contracts/core.
- `L-COCKPIT-KNOWLEDGE-MODEL` owns shared semantic references, anchors,
  provenance, backlinks, cross-item/fragment relationships, and semantic
  transfer/reference contracts. It does not own Library organization.
- `L-STUDIO-APPLICATION-SHELL` owns Studio application-frame composition,
  route/view containers, navigation shell, global scroll roots, and the
  structural slots in which Library and other features mount.
- `L-STUDIO-HOST-INTEGRATION` owns Studio-specific MV3/Tauri/environment
  adapters and host bridges.
- `L-RUNTIME-KERNEL-SCOPE-EXT` owns Extension loader/bootstrap, module
  admission, dependency/readiness ordering, activation, and lifecycle.
- `L-RUNTIME-KERNEL-SCOPE-STU` owns Studio bootstrap, module admission,
  runtime/service registration, readiness, activation, and lifecycle.
- `L-DEVELOPER-BUILD-DELIVERY-SCOPE-STU` owns Studio software/artifact build,
  package, stage, publication/promotion, provenance, activation, rollback, and
  recovery mechanics.
- `L-STORAGE-SAVED-CHATS` owns durable saved-chat/archive representation;
  `L-PLATFORM-SYNC` owns cross-surface propagation and convergence.
- `L-STUDIO-CANVAS` owns Canvas spatial composition and Canvas-local visual
  relations. `L-STUDIO-SOURCE-DOCUMENTS` owns external/reference document
  versions, parsing, extraction, page structure, and document metadata.
- `L-STORAGE-BINARY-ASSETS` owns the generic shared binary/CAS target
  responsibility. Saved Chats retains its incumbent safety-sensitive CAS
  implementation until an explicit extraction Mission transfers it.

Canvas, Source Documents, Knowledge Model, and generic Binary Assets are
current ownership boundaries; this map does not claim their future Product
modules or the CAS extraction are already implemented.

Shared files and containers have one semantic home owner per change. A
cross-Lane edit uses a temporary narrow lease and does not create co-primary
ownership.

## Library Core Ownership

- Library Core owns Library service registries, Library route semantics, and
  page-host registration/coordination.
- Library Core does not own feature data or Studio application-shell geometry.
- Library service/page registration is not Runtime module admission. Runtime
  Lanes own execution bootstrap and module lifecycle for their scoped surfaces.

## Library Ownership
- Library Workspace owns Library dashboard behavior, workspace tabs, search
  and discovery semantics, route shortcuts, and Library UI preferences;
  Application Shell owns the structural Studio container and sidebar/route
  mount geometry.
- Library Index owns the normalized known-chat read model and Chat Registry
  discovery/catalog semantics.
- Library Insights owns Explorer and Analytics rendering only.

## Feature Ownership
- Within the Library Lane, Folders owns folder catalog, folder pages, and
  Library folder-binding semantics.
- Within the Library Lane, Labels owns label catalog, label pages, and
  chat-label assignment semantics.
- Within the Library Lane, Categories owns category catalog, category pages,
  category appearance, and category popups.
- Within the Library Lane, Tags owns tag catalog, tag pool creation,
  suggestions, usage semantics, and tag popups.
- Within the Library Lane, Projects owns project catalog and project pages.
- Item-to-folder/project/category/label/tag bindings are organizational Library
  relationships. Semantic relations such as `supports`, `contradicts`, or
  `derived-from` between exact items/fragments belong to Knowledge Model.

## Cross-System Rule
- A module may read another module through public owner/service APIs or documented events.
- A module must not write another module's storage or mutate another module's DOM-owned surface directly.
- Library owns what a Library entry/action means; Application Shell owns where
  that entry or route is structurally mounted in Studio.
- Feature code owns content meaning; Runtime owns how accepted modules become
  operational. Physical placement under `src-runtime-base/` or Studio does not
  transfer feature semantics to Runtime.
