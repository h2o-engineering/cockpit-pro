# Architecture: Ownership Map

Status: Active

Purpose:
Map cross-system ownership boundaries for H2O internal pages.

## Engineering Lane Boundaries

- `L-COCKPIT-LIBRARY` owns Library business semantics across Product surfaces:
  catalog/Chat Registry, Index/read models, search/browse/recents,
  Explorer/Insights, organization, relationships/bindings, navigation/actions,
  and shared Library contracts/core.
- `L-STUDIO-APPLICATION-SHELL` owns Studio application-frame composition,
  route/view containers, navigation shell, global scroll roots, and the
  structural slots in which Library and other features mount.
- `L-STUDIO-HOST-INTEGRATION` owns Studio-specific MV3/Tauri/environment
  adapters and host bridges. `L-COCKPIT-RUNTIME-KERNEL` separately owns common
  Cockpit runtime/kernel semantics.
- `L-DEVELOPER-BUILD-DELIVERY-SCOPE-STU` owns Studio software/artifact build,
  package, stage, publication/promotion, provenance, activation, rollback, and
  recovery mechanics.
- `L-STORAGE-SAVED-CHATS` owns durable saved-chat/archive representation;
  `L-PLATFORM-SYNC` owns cross-surface propagation and convergence.

Shared files and containers have one semantic home owner per change. A
cross-Lane edit uses a temporary narrow lease and does not create co-primary
ownership.

## Library Core Ownership

- Library Core owns Library service registries, Library route semantics, and
  page-host registration/coordination.
- Library Core does not own feature data or Studio application-shell geometry.

## Library Ownership
- Library Workspace owns Library dashboard behavior, workspace tabs, search
  semantics, route shortcuts, and Library UI preferences; Application Shell
  owns the structural Studio container and sidebar/route mount geometry.
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

## Cross-System Rule
- A module may read another module through public owner/service APIs or documented events.
- A module must not write another module's storage or mutate another module's DOM-owned surface directly.
- Library owns what a Library entry/action means; Application Shell owns where
  that entry or route is structurally mounted in Studio.
