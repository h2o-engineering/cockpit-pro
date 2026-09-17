# Local Backup harness seed dataset

`seed-dataset.json` is the deterministic, synthetic Saved-Chat dataset the
permanent Local Backup harness
(`tools/validation/studio/validate-saved-chat-local-backup-harness-v1.mjs`)
loads into a throwaway `node:sqlite` database. It contains no user data.

| Chat | Shape | Expected classification |
| --- | --- | --- |
| `bk-alpha` | saved, 2 turns, one inline `data:image/png` asset | eligible (asset-bearing) |
| `bk-bravo` | saved, 1 text turn | eligible |
| `bk-charlie` | saved, `is_deleted = 1` | `skipped.deleted` |
| `bk-delta` | saved, active chat tombstone (`restored_at` NULL) | `skipped.tombstoned` |
| `bk-delta2` | saved, active chat tombstone (`restored_at = ''`) | `skipped.tombstoned` (NB-02) |
| `bk-echo` | saved, no snapshot | `skipped.noSnapshot` |
| `bk-foxtrot` | saved, zero-turn snapshot | `skipped.noSnapshot` (NB-10) |
| `bk-golf` | saved, two snapshots | eligible on the NEWER snapshot (`snap-golf-new`) |
| `bk-hotel` | saved, RESTORED tombstone | eligible |
| `link-only-1` | linked-only (`is_saved = 0`) | `skipped.linkedOnly` (outside `enumerated`) |

The inline asset bytes are the same 20-byte synthetic PNG the committed v3
fixture carries (`sha256-b6a38573…`), so the asset member the backup streams
can be checked against a known identity. The `{{INLINE_PNG}}` placeholder is
replaced at seed time with the `data:image/png;base64,…` URI.

Scenario-specific rows (a Windows-reserved `CON` chat for NB-T02-07, an
oversize inline asset, source mutations for the change guard) are injected by
the harness into its temp database only; this committed dataset stays fixed.
