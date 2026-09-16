# Saved-Chat O1 — Recovered-chat list-card counter correction

Date: 2026-09-16. Lane: 🗃️ L-STORAGE-SAVED-CHATS.
Residual: **O1 — `NON_BLOCKING_DISPLAY_DEBT`** (recovered-chat list-card
counters), carried by the closed `integrate-accepted-saved-chat-lineage`
Mission from its T05 disposable Desktop acceptance on `80960547`.
Governance: **`BOUNDED_RESIDUAL_DEBT_CORRECTION`** (shape A) — HDA authorized:
"Authorize O1 bounded recovered-chat counter correction using governance
shape A." Not a new Mission; the active
`establish-cross-platform-saved-chat-filesystem-safety` Mission and the
completed Recovery Center Mission are neither amended nor reopened.
Read-only ARC assessment: `O1_ROOT_CAUSE_CONFIRMED —
BOUNDED_COUNTER_FIX_READY_FOR_IMPLEMENTATION_PLANNING`.
Result: **`O1_IMPLEMENTATION_COMPLETE — CANDIDATE_READY_FOR_INDEPENDENT_VERIFICATION`**.

## Live Product base

- `origin/main` fetched immediately before implementation:
  `8ee63b25cee529e03f719547b0209f32d7cc3433` (tree
  `125f96cfff5a819b9ca91f9a53ec43d75f71ebaf`) — equal to the Supervisor
  observation; no advancement.
- Importer blob at that base: `699bae10f68304046d0a386f0040d996d030224f`
  (equal to the ARC-assessed blob); permanent recovery harness blob
  `3470f3c32130ad310a693d53da7829a5ad5ab6c1`. No material baseline drift.
- Branch `work/saved-chat-o1-recovered-chat-counters-20260916`, created
  directly on that main in its own worktree. The parked filesystem-safety T02
  candidate (`80598237`) is not touched and not used as a base.

## Root cause (confirmed)

`importCandidate(...)` in
`src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js`
wrote the recovered chat through `chatStore.upsert(chatPatch)` with a patch
carrying only `chatId`, `title`, `isSaved`, `isLinked` and
`meta.recovered`. The fresh-id INSERT therefore left `message_count`,
`user_turn_count` and `assistant_turn_count` at their database defaults (0)
and carried no `meta.answerCount`, while the recovered snapshot and its
`snapshot_turns` were complete. The Desktop Library Index projection
(`projectChatToCompactRow`) reads `answerCount` from the chat row's `meta`
(there is no chats column for it) and the counters from the row, so the list
card rendered `0 answers` for a fully recovered chat.

## Exact changed Product paths (three)

| Path | Change |
| --- | --- |
| `src-surfaces-base/studio/ingestion/saved-chat-archive-importer.studio.js` | +59/−2. New pure helpers `turnTimeToEpochMs` and `deriveRecoveredChatSummary(turns)`; the INITIAL recovered-chat patch now carries `messageCount`, `userTurnCount`, `assistantTurnCount`, `lastMessageAt` (only when a trustworthy per-turn time exists) and `meta.answerCount` beside the unchanged `meta.recovered` provenance. Blob `59bb7b745d042a73ba15d4e66e4e457002f0cac8`. |
| `tools/validation/studio/validate-saved-chat-archive-import-recovery-harness-v1.mjs` | +266/−1. The permanent temp-DB recovery harness captures the recovered row, its exact bound INSERT payload and the fixture-derived expectations, boots the REAL Desktop read model (`chats.tauri.js`, `snapshots.tauri.js`, `shared/library/library-index-core.js`, `S0F1c` Library Index, the real `studio.js` Workbench/card seam functions) over the same temp DB, and adds eight `[O1]` checks. Blob `287ab437474892a6df16b13beca03232aecbe8a9`. |
| `release-evidence/2026-09-16/saved-chat-o1-recovered-chat-counters.md` | this record |

No other path. No Library Index, `studio.js`, store schema / migration, Sync,
CAS, Recovery Center UI, command, capability or package-format change.

## Trusted counter derivation

Derived from the SAME normalized `turns` array the importer persists in
`snapStore.create(snapPatch)` — never from the package's count metadata:

- `messageCount = turns.length`;
- `userTurnCount` / `assistantTurnCount` = turns whose cleaned, lower-cased
  role is `user` / `assistant` (the canonical capture / import rule);
- `answerCount = assistantTurnCount`, stored inside `meta` beside
  `meta.recovered` (the Library Index reads it from meta; no unknown
  top-level patch field);
- `lastMessageAt` = the latest VALID per-turn `meta.createdAt`, normalized to
  the chat store's epoch-ms representation by the Studio shell's
  `toTimestampMs` rule (epoch number or numeric string with the
  seconds-vs-ms boundary, otherwise a parseable date string); omitted from
  the patch when no turn carries a trustworthy time, so nothing is
  manufactured from the recovery moment and `created_at` keeps its meaning.

For the deterministic fixture (2 turns, user `2026-06-24T00:00:00.000Z`,
assistant `2026-06-24T00:00:01.000Z`): `message_count = 2`,
`user_turn_count = 1`, `assistant_turn_count = 1`, `meta.answerCount = 1`,
`last_message_at = 1782259201000` (`2026-06-24T00:00:01.000Z`, derived by the
harness independently from the fixture's own `createdAt`).

## No-update / no-overwrite preservation

- The only write shape change is a richer INITIAL INSERT of the fresh
  recovered chat row; the harness proves the counters ride that INSERT
  (columns `message_count`, `user_turn_count`, `assistant_turn_count`,
  `last_message_at`, `meta_json` bound in the single `INSERT chats`
  statement) and that the import's write verbs still contain NO `UPDATE`.
- Fresh chat id, fresh snapshot id (`snapStore.create` still receives no
  `snapshotId`), `isSaved`, `isLinked`, title, verification gate,
  already-imported no-op and provenance are unchanged; pre-existing rows are
  unchanged; `snapshot_count`, `last_snapshot_id` and `last_captured_at` are
  not written.
- No direct SQL was added to the importer (the harness's raw-SQL source guard
  stays green); no schema change; no new command or capability.

## RED → GREEN control

- **RED control = PASS.** With the unfixed importer (the exact `origin/main`
  blob `699bae10` written over the candidate file, from a byte copy) the
  extended harness fails exactly the six behavioural / source `[O1]` checks —
  `message_count` 0, `last_message_at` 0, INSERT without the counters, no
  `deriveRecoveredChatSummary`, Library Index `answerCount` 0, Workbench
  `answerCount` 0 — and passes all 92 pre-existing checks (`6 failed,
  92 passed`). The two remaining `[O1]` checks (fixture sanity; provenance /
  write-shape preservation) legitimately hold in both states.
- The candidate importer was restored from the byte copy and digest-verified
  byte-identical before the GREEN run.
- **GREEN = PASS 98 checks** (90 existing + 8 `[O1]`).

## Real read-model / list-card regression proof

Through the REAL modules over the recovered row: `LibraryIndex.refresh()` →
`getAll()` row `answerCount = 1`, `userTurnCount = 1`,
`assistantTurnCount = 1`, `messageCount = 2`, `lastMessageAt =
1782259201000`, `view = saved`, zero writes performed by the read model;
`projectLibraryIndexRowToWorkbenchInput` → `normalizeWorkbenchRow` →
`answerCount = 1`, `lastTurnAt = 2026-06-24T00:00:01.000Z`; `rowMetaParts`
→ `["Unfiled", "1 answer", …]` — the card's own singular / plural rule
renders `1 answer`, never `0 answers`.

## Live Desktop DB untouched

The harness routes every read and write to a throwaway temp `node:sqlite`
file (`seedIsTemp = true`) and its guarded witness proves the developer's
live `studio-v1.db` mtime / size unchanged across the run
(`[I.2] live Desktop DB untouched … ✓` in both the RED and GREEN runs).

## Targeted validation (Node v25.2.1)

| Validator | Result |
| --- | --- |
| `studio/validate-saved-chat-archive-import-recovery-harness-v1.mjs` | PASS 98 checks (GREEN); RED control 6 failed / 92 passed |
| `studio/validate-saved-chat-archive-recovery-import-export-v1.mjs` | PASS 35 checks |
| `studio/validate-saved-chat-recovery-center-v1.mjs` | PASS 104 |
| `sync/validate-p02-imported-chat-timestamp-authority.mjs` (shared read-model seam witness) | `P02_IMPORTED_CHAT_TIMESTAMP_AUTHORITY_PASS` |
| `sync/validate-p02-imported-chat-metadata.mjs` | `P02_IMPORTED_CHAT_METADATA_PASS` |
| `studio/validate-saved-chat-archive-cloud-sync-boundary-v1.mjs` | all 10 checks passed |
| `studio/validate-saved-chat-archive-restore-relink-v1.mjs` | PASS 14 checks |
| `studio/validate-saved-chat-archive-relink-v1.mjs` | PASS 24 checks |
| `studio/validate-saved-chat-legacy-integrity-reachability-v1.mjs` | all 10 checks passed |
| `studio/validate-saved-chat-portable-verification-client-v1.mjs` | all 20 checks passed |
| `studio/validate-saved-chat-archive-export-share-v1.mjs` | PASS (56 checks) |
| `studio/validate-saved-chat-reclamation-activation-v1.mjs` | all 16 checks passed |
| `git diff --check` | clean |

## Boundaries

- No Azure, Linux, Windows or T03 dependency: pure JavaScript importer change
  proven on the host with the permanent harness.
- The adjacent restore-original-identity role-counter omission is NOT fixed
  here (explicit non-goal); the Created / Added / Last-turn label semantics are
  unchanged.
- Management and the Lane ROADMAP are not modified; the ROADMAP residual is
  discharged only after independent verification and landing.
- Product main is not modified; the branch is pushed non-force and not merged.

## Candidate identity

The commit containing this record is the single O1 candidate commit directly
on base `8ee63b25` (its commit and tree ids are reported in the
implementation return and are the exact object for independent verification).
