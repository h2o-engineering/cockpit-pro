# Saved-Chat Asset Restoration (Recover as New)

Lane: `L-STORAGE-SAVED-CHATS` · Mission: `complete-saved-chat-recovery-asset-restoration` ·
Task: T02 candidate. Frozen contract: Management
`missions/complete-saved-chat-recovery-asset-restoration/t01-recover-as-new-asset-restoration-contract.md`
(commit `f4dc5c13…`, blob `0fcda838…`).

This document describes the behavior of the T02 implementation candidate as
built. It records no acceptance state: T02 completion, the T03 real-Desktop
proof, G01 and DP02 are separate, later decisions, and nothing here is on
Product main until T04 lands the exact accepted object.

## 1. Scope

Recover as New already preserved a trusted package's chat text and `assetRefs`
but never re-ingested the package's asset bytes into the destination Saved-Chat
CAS, so a recovered chat referenced assets it could not resolve. This candidate
closes that gap for **asset-bearing** trusted packages while leaving
**asset-free** recovery on the existing legacy path unchanged.

Owned surfaces:

| Surface | Role |
| --- | --- |
| `src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js` | asset recovery plan, CAS ensure, native transaction call, post-commit proof, store reload, Reader-side hydration helper |
| `apps/studio/desktop/src-tauri/src/saved_chat_asset_recovery.rs` | `h2o_saved_chat_asset_recovery_commit` — the purpose-bounded, connection-affine native transaction |
| `apps/studio/desktop/src-tauri/src/lib.rs` | module + command registration only |
| `src-surfaces-base/studio/studio.js` | one leased hunk in `loadSnapshotFromStoresDesktop` that awaits the hydration helper |

## 2. Trusted binding

- The required-asset identity set is the **trusted verifier's** set: the archive
  integrity occupant's `assetShas` (the same occupant the snapshot read is
  bound to) or the portable verifier's `assetShas`. The manifest never decides
  that set. A verified package whose trusted set is empty is asset-free.
- Archive path: `manifest.json` is an address read through the bounded codec
  (`readBoundedPackageMemberBytes`) and serves only as the **descriptor
  carrier**. Its asset SHA set must equal the trusted set exactly; each
  descriptor path must satisfy the canonical `assets/sha256-<hex>.<ext>`
  grammar and bind to its own SHA; `byteLength` is a constrained descriptor.
  Each asset member is read through the same bounded codec with
  `physicalByteCap = assetCas.assetBlobCapBytes` (never the 8 MiB snapshot
  cap); the codec's physical SHA must equal the trusted SHA and the physical
  length must equal the descriptor length. A member over the CAS ingest bound
  is refused with `asset-restoration-bound-refusal`.
- Portable ZIP: bytes come from the same immutable in-memory entry set the
  verifier ruled on; no second read and no second hash opinion in the importer
  (the CAS put recomputes the identity over those bytes and a mismatch stops
  recovery).
- Every message `assetRef` must close over the trusted set; duplicate same-turn
  references collapse to one logical `(turnIdx, sha256)` link; unreferenced
  required assets are restored to CAS and registry without a link.

All closure checks run before the first CAS write. A refusal writes nothing.

## 3. CAS-first ordering and destination CAS ensure

```
trusted verify + immutable plan → destination CAS ensure/verify (sorted SHA order)
→ ONE native atomic DB transaction → post-commit proof → store-view reload → result
```

Per asset: `readVerifiedAssetBytes` — a throw (hash contradiction) is
`DESTINATION_CAS_CORRUPT` and stops before any DB work; a verified object of the
trusted length is `CAS_REUSED_VERIFIED` with no write; `null` is not treated as
clean absence — `putAssetBytes` runs under the existing CAS authority and its
**returned outcome** is classified: clean dedupe → `CAS_REUSED_VERIFIED`; clean
verified write → `CAS_MATERIALIZED_VERIFIED`; `repaired: true`, or a
`mismatchCount` delta revealing the module's hidden already-valid repair path
→ `DESTINATION_CAS_CORRUPT`; anything else → `CAS_OUTCOME_AMBIGUOUS`; a thrown
put → `CAS_WRITE_FAILED`. Accepted outcomes must match the trusted SHA and
length and pass a verified reread; `durabilityComplete: false` is recorded as
evidence only. Recovery never repairs, deletes or garbage-collects.

## 4. One atomic DB commit (native)

`h2o_saved_chat_asset_recovery_commit` accepts a closed schema
(`h2o.savedChatAssetRecoveryCommit.v1`, `deny_unknown_fields`, no SQL text) and
runs on one acquired connection: assert the renderer-minted `recovered_…` chat
id is absent; mint the recovered snapshot id (`snap_<uuid4>`) from OS entropy
and assert it is absent; registry ensure (insert absent rows from the trusted
descriptor; existing rows keep their presentation metadata; a `byte_size`
contradiction is a rollback); insert the recovered chat (the legacy adapter's
exact column set), the recovered snapshot, every normalized turn and every
pre-deduplicated link; recompute `assets.refcount` from the join relation for
the linked SHAs; commit once. Any failure before commit rolls back the whole
mutation and returns `{ stage, code }`; existing chats, snapshots, turns, links
and registry rows are never updated or deleted; no overwrite mode exists.

## 5. Residue and failure truth

| Failure | Durable residue | Result |
| --- | --- | --- |
| plan / descriptor / member closure fails | none | `rejected`, `assets.result = <code>` |
| CAS corrupt / ambiguous / write failed | earlier verified objects only | `rejected`, `assets.residue[]` classified `VERIFIED_UNREFERENCED_CAS_RESIDUE` |
| native transaction rolled back | all materialized objects (classified residue) | `rejected`, `assets.result = recovery-transaction-rolled-back` |
| transport failure after the request left the renderer | as above | `rejected`, `ambiguousCommit: true`, never retried automatically |
| committed, post-commit proof fails | committed recovery | `status = committed-verification-failed`, `ok = false`, committed identities surfaced |
| committed and proven | committed DB + verified CAS | `status = imported`, `assets.result = imported-asset-complete` |

Residue is deduplicated by a later explicit Recover as New; nothing deletes it.
Import-time `imported-asset-complete` means persistence and verification are
complete — it is not a rendering claim.

## 6. Post-commit proof and store reload

Before success the importer re-reads durable state: fresh chat and snapshot
exist, the turn count matches, `store.assets.listBySnapshot` returns exactly
the planned `(turnIdx, sha256)` set, a registry row exists for every required
asset, every referenced CAS object passes `readVerifiedAssetBytes` at the
trusted length, and the archive snapshot member still binds to its trusted
anchors. Because the native transaction bypasses the JS adapters' notifications,
`store.chats / snapshots / assets .reload()` run afterwards (auto-export
ignores `reload`, so no Sync side effect is introduced).

## 7. Fresh identity

The recovered chat id is minted by the existing importer generator and
re-asserted absent inside the transaction; the recovered snapshot id is minted
natively; neither may equal the package's original ids, which appear only as
provenance (`meta.recovered`). Repeated explicit gestures create distinct fresh
recoveries and reuse the CAS objects.

## 8. Asset-free legacy path

A trusted package with an empty trusted asset set follows the unchanged legacy
sequence `chats.upsert` → `snapshots.create` (fresh id, no CAS, no registry,
no native command). O1 counters and the existing recovery validators are the
regression gate.

## 9. Reader-side hydration (ephemeral)

`H2O.Studio.archiveImporter.hydrateRecoveredSnapshotProjectionV1(canonical)`
is awaited by `loadSnapshotFromStoresDesktop` on the **projected canonical
copy**, after `projectSqliteSnapshotToCanonical` and before `renderReader` /
`normalizeInput` / the equivalence decision. Gate — all three required:

- **G-a** `canonical.meta.recovered.recoveredFromPackage === true`;
- **G-b** `store.assets.listBySnapshot(snapshotId)` returns persisted links;
- **G-c** each link SHA is contained in that turn's own `assetRefs`.

Only the exact `src="assets/sha256-<hex>.<ext>"` reference of a gated link is
replaced, with a standard-base64 `data:` URI built from
`assetCas.readVerifiedAssetBytes`, the registry MIME (png / jpeg / gif / webp
only), accepted by the Renderer's public `sanitizerPolicy.classifyUrl(uri,
'image')` oracle and within `sanitizerPolicy.maxInputBytes` (all-or-nothing per
turn). Unsupported MIME, missing or unverifiable CAS bytes, policy refusal or
budget overflow leave that turn's canonical reference in place; the snapshot
still loads. Hydration is deterministic, total, per-call deduplicated by SHA,
never cached across loads, never persisted, and never changes `messages[]`,
ids, order, roles, `snapshotId`, `chatId`, `digest` or `meta.recovered`. It uses
no remote, `file:`, `blob:`, `tauri:`, `asset:` or unverified source.

## 10. Renderer envelope boundary

The Renderer and its sanitizer are unchanged. A restored asset is renderable
through the production seam only when its registry MIME is an admitted raster
family and the hydrated turn fits the sanitizer input guard (2,097,152
characters); otherwise it is restored (CAS + registry + link) but truthfully
not renderable under the current envelope, and no rendering claim is made for
it.

## 11. R-F invariant (Reader-only projection)

The hydrated projection is a Reader-side runtime value. It never becomes
snapshot DB state, package bytes, Sync payload, export bundle, DOCX /
transcript output, backup content or edit-overlay identity: those writers read
the raw store (`store.snapshots.get` / `listByChat`) or `messages[].text`, and
the edit-overlay base digest covers `messages[]` only.
`tools/validation/studio/validate-saved-chat-recovered-asset-hydration-rf-v1.mjs`
pins this permanently: the hook lives only in `loadSnapshotFromStoresDesktop`;
every `loadSnapshot` consumer in the Studio tree is inventoried and every
non-Reader consumer must be Chrome-gated; the behavioral guards prove DB,
package, CAS, Sync projection, package builder, transcript, DOCX and overlay
digest are unaffected by hydration.

## 12. Assurance

- Native: `cargo test --lib saved_chat_asset_recovery` (closed input,
  fresh ids, no-clobber, byte-size contradiction, every injected failure stage
  rolls back, exact rows on success, refcounts from the join).
- JS: `tools/validation/studio/validate-saved-chat-asset-restoration-harness-v1.mjs`
  (accepted contract §20 vectors AR-01…AR-27, AR-RD-01, RED/mutant control) and
  the R-F validator above, over the fixture in
  `tools/validation/fixtures/saved-chat-archive/asset-restoration/`.

## 13. T03 proof boundary

Restart durability, the real Desktop recovery of an asset-bearing trusted
package, and the actual rendered assistant-turn image through the production
seam are T03 proofs on the exact final candidate. Nothing in this document
claims them.
