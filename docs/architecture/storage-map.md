# Architecture: Storage Map

Status: Active

Purpose:
Map storage ownership for the Library-related systems.

Lane boundary: `L-COCKPIT-LIBRARY` owns the meaning of Library catalogs,
registries, Index/read models, organization, and their Library-specific keys.
`L-STORAGE-SAVED-CHATS` separately owns durable saved-chat/archive
representation, serialization, retention, recovery, and durability.
`L-PLATFORM-SYNC` owns cross-surface propagation and convergence. Persistence
or transport does not transfer Library business semantics.

`L-STORAGE-BINARY-ASSETS` owns the admitted generic shared binary/CAS target
authority: immutable payloads, hash identity, deduplication, generic verified
put/get, `AssetRef`, MIME/size metadata, streaming, and shared binary
durability. This documentation round does not extract the current saved-chat
CAS. `L-STORAGE-SAVED-CHATS` remains the safety-sensitive incumbent owner of
its current CAS implementation and saved-chat package/dependency semantics
until an explicitly authorized extraction Mission.

Source Documents owns document versions, parsing, extraction, and page
structure over generic source-file bytes. Canvas owns placement and meaning of
binary assets used as Canvas elements. Storage location alone does not transfer
those semantics to Binary Assets.

## Library Storage
- `h2o:prm:cgx:library:ui:v1` belongs to Library Workspace.
- `h2o:prm:cgx:library-workspace:sidebar-layout:v1` belongs to Library Workspace.
- `h2o:prm:cgx:library-index:cache:v1` belongs to Library Index.
- `h2o:prm:cgx:library-index:prefs:v1` belongs to Library Index.
- `h2o:prm:cgx:library-index:known-registry:v1` is Library Index legacy registry storage.
- `h2o:prm:cgx:library:registry:v2` is the durable Library Store registry target.
- `h2o:prm:cgx:library:scan-batches:v1` belongs to Library Index scan durability.

## Cross-System Rule
- URLs/history own page route state. Do not introduce persistent storage to remember the active route when URL state can represent it.
- Feature-owned catalogs and bindings stay in their feature storage.
- Normalized evidence can be copied into Library Index only as read-model evidence, not as ownership transfer.
