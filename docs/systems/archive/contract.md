# Contract: Archive

Status: Draft / Placeholder

Purpose:
TODO

## Current Engineering Lane Boundary

```text
AUTHORITY_TARGET=L-STORAGE-BINARY-ASSETS
CURRENT_SAFETY_SENSITIVE_INCUMBENT_IMPLEMENTATION=L-STORAGE-SAVED-CHATS
CAS_EXTRACTION_STATUS=NOT_PERFORMED
```

`L-STORAGE-SAVED-CHATS` owns saved-chat package/archive representation, asset
dependency semantics, retention, recovery, and the current mature saved-chat
CAS implementation. `L-STORAGE-BINARY-ASSETS` owns the admitted durable target
authority for reusable generic binary bytes, hash identity, deduplication,
verified put/get, `AssetRef`, metadata, streaming, reachability, and shared CAS
mechanics.

No ownership statement here claims the safety-sensitive incumbent CAS has
moved. Transfer of proven reusable primitives requires a separately authorized
extraction Mission. Future generic binary storage should target Binary Assets
rather than create a second CAS.
