# M10 P3 — Archive Health migrated to trusted Rust integrity

Implementation and runtime-acceptance record for the P3 production switch. It
authorizes no push, no P3.5 and no P4, and it does not itself constitute final
acceptance: **P3 implementation is complete and ready for final acceptance
review.**

## Identity

**Accepted P2 start:** `570b8fe0dcf03ca740939be82e1cfa1e87e3954f`
**P3a:** `846a715707ed75e8ffdd61f59597e63891396565` —
`feat(studio): prepare trusted archive health composition`
**Lane:** L-SAVED-CHAT-STORAGE · `work/saved-chat-storage`

## P3a foundation

- The **only** Rust product change in P3: the additive `assetShas` projection,
  taken verbatim from the already-verified `VerifiedPackage.asset_shas`
  (normalized, sorted, deduplicated upstream). Present only where a trusted
  verified package exists; never fabricated.
- Thin trusted integrity client (`saved-chat-archive-integrity.tauri.js`).
- Trusted composition layer (`saved-chat-archive-health-composition.js`).
- `dbDriftForIdentity` extracted decision-neutrally from the legacy diagnostics
  module; the legacy wrapper delegates so the pre-P3 path is unchanged.
- `liveCasPresenceForShas` extracted; CAS observation is driven by the trusted
  `assetShas` rather than by re-parsed manifest data.
- P3a shipped **unwired**: production Health still ran the legacy path.
- No M06 decision source changed.

## P3b production switch

Archive Health integrity truth now flows exclusively through:

```
h2o_saved_chat_archive_integrity            (trusted Rust)
  -> saved-chat-archive-integrity.tauri.js  (thin client)
  -> saved-chat-archive-health-mapping.js   (P2 presentation mapper)
  -> saved-chat-archive-health-composition.js
  -> diagnoseSavedChatArchiveV1             (compatibility facade)
  -> archive-health-ui.studio.js            (unchanged surface)
```

### Desktop load order

`src-surfaces-base/studio/studio.html` declares, in strict order, each exactly
once:

1. `saved-chat-archive-integrity.tauri.js`
2. `saved-chat-archive-health-mapping.js`
3. `saved-chat-archive-health-composition.js`
4. `saved-chat-archive-diagnostics.tauri.js`
5. `archive-health-ui.studio.js`

The first three must precede the facade, which resolves
`composeSavedChatArchiveHealthV1` at call time.

### No runtime fallback

A failure of the trusted command, client, schema or mapper propagates to the
**existing** Health error lifecycle. There is no `trusted || legacy`, no
try/catch-to-legacy, no dual-verifier voting and no merged blocker sets. The
legacy JS verifier is never consulted for Archive Health. Operational rollback is
reverting this commit, not a hidden second authority.

## Metric truth correction (HDA-approved)

- **`brokenPackageAssets` — retired.** Canonical verification is fail-fast, so an
  exact multi-error asset total does not exist.
- **`assetRefMismatches` — retired.** It conflated package-integrity mismatches
  with renderer-hygiene observations.
- **`dataImageResidue` / renderer hygiene — deferred to P3.5.** Not observed in
  P3.
- Unavailable renderer hygiene renders `n/a` (the repository's existing
  unavailable label), **never** a fake zero, and it has **zero** aggregate-state
  effect. Unobserved is neither drift nor healthy evidence.
- Trusted per-package blocker explanations replace the retired approximate
  counts as the operator's account of why a package is blocked.

A measured zero still renders `0`; `countValue` / `listCount` were left
untouched so unrelated measured metrics are unaffected.

## Reserved infrastructure

Trusted `reserved-infrastructure` occupants are hidden: no package row, no
total, no warning, no integrity problem. A complete archive holding only
reserved infrastructure reads **Empty**.

## False-healthy closure

All eight P0 divergence families are structurally non-healthy through the
trusted path — Integrity problems alone, Mixed beside a valid package — and can
never read Healthy or Healthy-with-drift.

## Focused validation

| Suite | Result |
| --- | --- |
| trusted-switch validator | **15 / 15** |
| saved-chat diagnostics | **70 / 70** |
| Archive Health UI | **36 / 36** |
| trusted composition | **15 / 15** |
| P2 mapper | **15 / 15** |
| P1 wire contract | **14 / 14** |
| coverage | **20** (unchanged) |
| reclamation activation | **16** |
| archive materializer | **46** |
| Studio pack/reference smoke | ALL PASS |
| `node --check` on modified JS/MJS | PASS |

## Real disposable Desktop acceptance

Fresh disposable identifier **`org.h2o.studio.desktop.m10p34b`**, isolated by an
external Tauri `--config` overlay held outside the repository. Real Tauri Desktop
loaded the refreshed P3b frontend; the real command
`h2o_saved_chat_archive_integrity` executed and the client accepted schema
`h2o.savedChatArchiveIntegrity` version `1`.

**Case 1 — trusted-valid V3.** Package trusted valid, `packagesBlocked: 0`, no
trusted blocker. Aggregate **Healthy with drift**, explained solely by the
intentionally empty disposable DB (`missing-db-chat`, `missing-db-snapshot`).
Renderer hygiene unobserved with no state effect.

**Case 2 — historical V3 persistent-renderer-forbidden divergence.** Blocked;
aggregate **Integrity problems**. The legacy false-healthy behaviour is closed.

> Granularity note: this refusal originates in the admission adapter, not in
> `saved_chat_package_verify`, so it carries **no granular verifier blocker**.
> The non-healthy classification is still correct, and this matches the
> previously accepted P1.2 boundary — only verifier-originated failures carry
> granular codes. Recorded, not fixed here.

**Case 3 — valid + V3 messages-non-array.** Aggregate **Mixed**, with the
granular blocker `generation-v3-snapshot-messages-invalid` and its operator
explanation visible on the blocked package.

### Runtime metric shape confirmed

The real P3b report carried `rendererHygiene = { observed: false, deferredTo:
"P3.5" }`; `brokenPackageAssets`, `assetRefMismatches` and `dataImageResidue`
were **absent** from the trusted counts; the legacy renderer buckets were absent
from trusted package rows; and trusted blocker codes/explanations were present
wherever the trusted path supplies them.

### Production safety

The production archive was byte-identical before and after the runtime
acceptance:

- file count `19`
- inode `246337901`
- mtime `1782299170`
- ctime `1782299170`
- digest `c983537373030a39b1ceb5c0099c7da0f5f64cfbffefbcf2346dbbccf45fce1d`

All disposable fixtures and activity stayed under the disposable
identifier-scoped root. Another Lane's Studio process was running throughout and
was never terminated, clicked or manipulated.

## Build / delivery

The canonical chain was used —
`H2O_EXT_DEV_VARIANT=production node
tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs`, then
`apps/studio/desktop/build-tools/prepare-dist.mjs`. All generated output is
gitignored; the rebuild produced **zero tracked change** (identical dirty path
set and tracked-diff hash). The refreshed `dist/studio.html` carried the strict
five-module P3 load order.

## Duplicate authority status

- Archive Health operator integrity truth is now **exclusively trusted Rust**.
- The legacy JS integrity code still **physically exists**.
- `saved-chat-coverage.tauri.js` and `saved-chat-archive-inspector.studio.js`
  still use the legacy verifier directly.
- Repository-wide duplicate production authority is **REDUCED, NOT RETIRED**.
- **P3.5 is required before P4.**

## Phase status

P3 implementation complete and ready for final acceptance review.
P3.5: not started. P4: not started / not authorized.
