# Library Storage

Status: Active

Purpose:
Define Library storage ownership and persistence boundaries.

## Lane Boundary

`L-COCKPIT-LIBRARY` owns Library catalog, registry, Index/read-model,
organization, relationship, and action semantics represented by these keys.
`L-STORAGE-SAVED-CHATS` owns durable saved-chat/archive representation,
serialization, retention, recovery, and durability; it does not absorb Library
meaning merely because Library records are persisted. Cross-surface transport
and convergence remain with `L-PLATFORM-SYNC`.

## Library Workspace Storage
- Library Workspace owns `h2o:prm:cgx:library:ui:v1` for UI preferences such as active workspace tab, query, and view mode.
- Library Workspace owns `h2o:prm:cgx:library-workspace:sidebar-layout:v1` for Library sidebar section order and visibility.
- Stored tab keys must normalize through the Library Workspace tab normalizer; `recent` must migrate to `recents`.

## Library Index Storage
- Library Index owns `h2o:prm:cgx:library-index:cache:v1` as a read-model cache.
- Library Index owns `h2o:prm:cgx:library-index:prefs:v1` for Index/Insights preferences.
- Library Index legacy known registry `h2o:prm:cgx:library-index:known-registry:v1` is migration/rollback storage.
- Durable known-chat registry writes should target Library Store key `h2o:prm:cgx:library:registry:v2` through the Library Store service when available.
- Scan batch ledger writes belong to `h2o:prm:cgx:library:scan-batches:v1`.

## Storage Boundaries
- Route state belongs in URL/history state, not in a separate database table.
- Feature catalogs and bindings remain feature-owned. Library Index may read via public APIs and store normalized chat evidence, but must not become the storage owner for Folders, Labels, Categories, Tags, or Projects catalogs.
- Tag-category relationships belong to the Tags/Categories feature boundary, not Library Workspace.
- Runtime code must not add a special database for Library tabs, route views, or Explorer source pooling while the existing route service, Library Store, and Library Index can represent the state.
