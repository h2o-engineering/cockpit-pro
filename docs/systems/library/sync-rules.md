# Library Sync Rules

Status: Active

Purpose:
Define allowed data-flow direction between Library surfaces, source scanners, and feature owners.

## Lane Boundary

`L-COCKPIT-LIBRARY` owns what Library records, relationships, Index views, and
actions mean. `L-PLATFORM-SYNC` owns propagation, reconciliation, conflict
handling, and convergence between Product surfaces. A module named “Library
Sync” may carry the Platform Sync mechanism, but its name does not give Sync
ownership of Library business semantics. Durable saved-chat/archive
representation remains with `L-STORAGE-SAVED-CHATS`.

## Data Flow
- Native Recents DOM/cache -> Library Index -> Library Workspace Recents, Explorer, Analytics.
- Native Projects sidebar chat sightings -> Library Index -> Explorer and facets.
- Feature catalogs -> Library Index enrichment -> Library read model.
- Library Workspace UI state -> URL/history route view for workspace tabs.

## Sync Direction
- Sync into Library Index is one-way from source adapters. Explorer and Analytics must not push data back into source adapters.
- Library Index may write normalized known-chat evidence and scan ledger state; it must not mutate native ChatGPT, feature catalogs, or feature page state.
- Library Workspace may request navigation to feature pages; feature pages remain the active page owners after navigation.
- Tag-category link display flows from Tags/Categories storage into category rows and popups; display overflow must not change storage.

## Freshness Rules
- Sidebar Recents scrolling is a freshness signal and should trigger loaded Recents scans.
- Project sidebar mutations or scrolls are freshness signals for project chat sightings.
- Refresh events must carry a reason and should be debounced before rebuilding the model.

## Title And Surface Sync
- H2O internal page state -> browser tab title while the page is active.
- Native ChatGPT chat state -> browser tab title when no H2O internal page is active.
- H2O internal page state -> MiniMap hidden; native chat state -> MiniMap eligible.
