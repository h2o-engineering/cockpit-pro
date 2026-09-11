# M10 P2 — Trusted-to-operator health mapping

Focused record for the P2 presentation boundary. It authorizes no operator
migration, no push, no merge, and no P3/P4 work.

## Identity

**Starting HEAD:** `3601d021d03182a9283c9aeec99fdfa8f0e74ad1`
**Lane:** L-SAVED-CHAT-STORAGE · `work/saved-chat-storage`

## What P2 adds

One pure module,
`src-surfaces-base/studio/ingestion/saved-chat-archive-health-mapping.js`:

```
trusted h2o.savedChatArchiveIntegrity envelope (P1)
+ separate existing non-integrity presentation facts (DB drift, other warnings)
→ presentation model over the SIX existing operator states
```

It performs partitioning, aggregate-state selection, compatibility shaping,
blocker humanization and presentation summaries — and nothing else. No hashing,
manifest/snapshot parsing, gzip work, schema admission, validity decision,
contentHash derivation, filesystem read, Tauri invoke, persistent state or
mutation. No package bytes enter it.

**It is packaged but deliberately UNWIRED.** No production caller references it;
`diagnoseSavedChatArchiveV1` remains the Health authority until P3.

## Package partition

| Trusted input | Treatment |
| --- | --- |
| `verified-generation` | package row |
| `legacy-package` | package row, VALID (never stale/outdated/migration-needed) |
| `indeterminate`, reason ≠ `not-a-package-name` | package row, status `blocked` |
| `indeterminate`, reason = `not-a-package-name` | stray → archive-level warning, NO package row |
| `reserved-infrastructure` | hidden: no row, no total, no warning, no integrity problem |

An unrecognised class throws rather than being silently dropped.

## Six-state precedence

`complete === false` → **partial-scan**, over everything, so archive blockers are
incomplete-scan evidence rather than a separate corruption state. Then
`packagesTotal === 0` → **empty** (over drift and strays, as production does
today). Then all-blocked → **integrity-problems**; some blocked →
**mixed**; warning-only mix → **mixed**; all-warning or archive drift →
**healthy-with-drift**; otherwise **healthy**.

`selectAggregateState` is total over valid input and throws on malformed input.
Exhaustively proven across every `total ≤ 3` × `blocked` × `warning` ×
`archiveWarnings` combination.

## Deliberate parity differences (both authorized)

1. **ReservedInfrastructure is hidden**, so it contributes no stray warning. This
   can reduce visible warning counts versus the current JS diagnostics path.
2. **The unknown-status healthy fallback is gone.** The pre-P2 formatter paired a
   neutral pill with the healthy headline for an unrecognised status; the mapper
   is exhaustive and fails closed instead.

Both live only in the unwired mapper and become operator-visible in P3.

## Deliberately preserved

The **Mixed copy quirk** — production says "Some packages have integrity
problems" even when the cause is warning-only drift. P2 preserves that mapping
state and does not improve the wording. Carried copy debt for a later phase.

## Blocker humanization

Exact overrides for three high-signal codes
(`generation-v3-gzip-decode-failed`, `generation-content-hash-mismatch`,
`generation-v3-persistent-renderer-forbidden`), then eleven semantic family
prefixes ordered most-specific-first, then a generic fallback. An unknown future
code keeps its exact string, gets a generic explanation, is never suppressed and
never softens the trusted reason. No text claims a root cause the code cannot
support.

## Results

| Check | Result |
| --- | --- |
| New mapper validator | **15 / 15** |
| Archive Health UI validator | 35 — unchanged |
| Saved-chat diagnostics validator | 70 — unchanged |
| Coverage validator | 20 — unchanged |
| Reclamation activation validator | 16 — unchanged |
| P1 trusted wire validator | 14 — unchanged |
| Studio pack/reference smoke | ALL PASS |
| Rust files changed since `3601d021` | **0** |
| `node --check` on new/modified JS/MJS | 3 / 3 OK |

## Authority

Trusted Rust verifier and scanner unchanged; the new module is pure
presentation; the old JS verifier still exists and remains production Health
authority. **P2 creates no third integrity authority, and duplicate authority is
NOT retired — P4 remains required.** P3/P4 unauthorized.
