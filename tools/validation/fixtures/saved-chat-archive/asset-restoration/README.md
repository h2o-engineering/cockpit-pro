# Saved-chat asset-restoration fixture (T02)

`ar-v3-assistant-raster.h2ochat/` is the deterministic, synthetic, renderer-free
v3 package the asset-restoration harness recovers. It carries no user data; ids,
timestamps, bodies and bytes are fixed and committed so a maintainer can inspect
exactly what the permanent harness proves.

| Property | Value |
| --- | --- |
| `chatId` / `snapshotId` | `ar-v3-assistant-raster` / `snap_ar_v3_assistant_raster` |
| Family | v3, `snapshot.json` stored `identity` (2223 B, logical == physical) |
| Package `contentHash` | `sha256-d2ee3ae4b03623f3c6c1a4976d6a793c285ff6ce3955727bd49c3ba2f83fb272` |
| Asset A | `sha256-edbcba34…2ca2` — a REAL 1×1 RGBA PNG (70 B), referenced by turns 1 and 2 |
| Asset B | `sha256-48ac27d3…020a` — a REAL 1×1 GIF89a (35 B), referenced by turn 2 only |
| Turns | 0 user (text only), 1 assistant (A), 2 assistant (A + B) — every message has an `html` part |

Shape decisions that the harness depends on:

- Every message carries a typed `html` part wrapped as a captured conversation
  turn (`data-testid="conversation-turn-N"` + `data-message-author-role`), so
  the Renderer's rich replay has complete coverage and the AC10 raster lives on
  ASSISTANT turns. The older `v3/t06-canonical-assets` fixture (user-turn,
  non-PNG bytes) is deliberately NOT used for asset-restoration or AC10 claims.
- Asset A is shared by two turns (one CAS object, one registry row, two links);
  asset B gives a second identity for CAS ordering / multi-asset vectors.
- The manifest asset paths are the canonical `assets/sha256-<hex>.<ext>` form
  and the html parts reference exactly those paths — the shape the product's
  materializer writes and the hydration helper reverses.

The `contentHash` was recomputed by the trusted Rust verifier
(`saved_chat_package_verify`) over these exact bytes. Error and mutant variants
(missing / extra / substituted members, hash or length contradictions,
duplicate same-turn refs, oversize members, corrupt or repaired destination CAS
objects, native rollback) are generated in temporary state by the harness and
are never committed.

Consumers:

- `tools/validation/studio/validate-saved-chat-asset-restoration-harness-v1.mjs`
- `tools/validation/studio/validate-saved-chat-recovered-asset-hydration-rf-v1.mjs`
- the T03 real-Desktop proof (copied into a disposable archive/packages root).
