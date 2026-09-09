# M10 P3.5 — Secondary consumers + renderer hygiene

Lane 🗃️ L-SAVED-CHAT-STORAGE · Mission M10 (Archive Integrity & Observability)
Phase P3.5 · Steps P3.5.2R (a) and P3.5.4 (b)
Date 2026-09-04 · Parent `61994567` · Branch `work/saved-chat-storage`

## What this step closes

P3.5a moved Coverage and the Archive Inspector onto trusted integrity. Renderer
hygiene could not follow: the observation needs the snapshot's LOGICAL bytes,
and the shared codec exposed no way to obtain them without also asserting the
package valid. P3.5.3 reported BLOCKED for that reason rather than duplicating a
decoder. P3.5.4 resolves the blocker by EXPOSING the bounded non-verifying
decoder the codec already owned, then completes hygiene as drift.

## a. The authorized codec change

`src-surfaces-base/studio/ingestion/saved-chat-package-codec.tauri.js`

One line. `decodeGzipBounded` — already present since M03, already bounded,
already non-verifying, previously reachable only through
`verifyPackageMemberBytes` — is now exposed on the public surface.

Option A (direct export) was taken: the surface already exposes positional
functions (`gzipEncodeBytes(logicalInput, options)`, `sha256PrefixedBytes(value)`),
so no options-object wrapper was materially required.

- the decoder body is byte-identical (verified by diff against the pre-state);
- exactly ONE `decodeGzipBounded` implementation remains;
- exactly ONE `new global.DecompressionStream` construction site remains.

### Why exposing it is safe

The decoder returns a plain `Uint8Array` and nothing else. It computes no
digest, compares no digest, and carries no `verified` / `valid` / `hashOk` /
`integrityStatus` / `packageVerified` / `logicalSha256` field, so no consumer
can mistake a successful decode for a validity signal. Its bound is
`min(contentByteLength, logicalByteCap)`, so a decompression bomb is refused
rather than buffered.

### Codec proofs — `validate-saved-chat-package-codec-bounded-decode-v1.mjs`

**9 / 9 pass.**

| | proof |
| --- | --- |
| P1 | exposed on the public codec surface |
| P2 | round-trips gzip-encoded logical bytes |
| P3 | returns raw bytes only — no validity field of any kind |
| P4 | performs no hash comparison; the decoder body contains no digest logic |
| P5 | enforces the cap → `saved-chat-member-decoded-output-exceeds-cap` |
| P6 | the effective cap is `min(contentByteLength, logicalByteCap)`, in both directions |
| P7 | malformed gzip → `saved-chat-member-decompression-failed` |
| P8 | missing `DecompressionStream` → `saved-chat-member-gzip-unavailable` |
| P9 | one decoder implementation, one gzip construction site |

## b. Renderer hygiene

New: `src-surfaces-base/studio/ingestion/saved-chat-archive-renderer-hygiene.js`

Hygiene is **drift, never a verdict**. Trusted Rust integrity remains the sole
authority on validity; hygiene reads the snapshot a second time for a cosmetic
question and can only add warnings beside the trusted classification.

### Family rule

| trusted class | hygiene |
| --- | --- |
| indeterminate (any reason) | **SKIP** — trusted integrity already refused it; a renderer read must not tell a second story |
| reserved-infrastructure | SKIP |
| verified-generation / legacy-package, ANY family incl. **V3**, identity or gzip | **OBSERVE** |

V3 is deliberately in scope, and this is the one place the hygiene rule diverges
from the pre-existing V1/V2 `rendererDetail` seam. That seam skips V3 because V3
forbids persistent renderer MEMBERS. Hygiene looks for residue inside snapshot
CONTENT, which V3 packages still carry — so a valid V3 package with `data:image`
residue is real, and is exactly the case that must surface.

### Absent is not zero

Every failure mode reports itself unavailable **with a reason**, contributing no
warning and no count:

`renderer-hygiene-codec-unavailable` · `-encoding-unsupported` ·
`-logical-length-unavailable` · `-package-unreadable` (a package that vanished
between the trusted scan and this read is a RACE, not a finding) ·
`-transport-unavailable` · `-read-failed` · `-decode-failed` · `-threw`

The gzip bound is taken from the trusted `logicalSnapshotByteLength`. Where that
trusted fact is absent the observation reports unavailable rather than guessing
a cap — the module invents no package fact of its own.

### Code rename

`renderer-data-image-residue` replaces the legacy blocker code
`data-image-residue-v2`, which asserted a v2-only scope and rode in a blocker
bucket. Hygiene is neither.

> Scope note: `data-image-residue-v2` is still emitted by the LEGACY walk, which
> serves only the M08 portable byte-source carveout (`validateSavedChatPackageBytesV1`).
> That carveout is retained until P3.6 by prior direction, so the legacy code was
> left in place rather than renamed underneath it. It is retired from the
> PRODUCTION Archive Health path, which no longer reaches the legacy walk at all.

### Asset-ref model

Drift is measured against the trusted `assetShas` projection — hygiene never
re-reads or re-derives a manifest. Trusted SHAs are bare hex while content
references are `sha256-` prefixed, so both sides are normalized; without that
every package would have read as drifting. Where `assetShas` is absent the
comparison is simply not made (`assetRefsComparable: false`) rather than
reported as zero drift.

## Wiring

| file | change |
| --- | --- |
| `saved-chat-archive-health-composition.js` | `rendererHygiene` seam + family rule + `hygieneSummary`; findings enter the same presentation bucket every other observation uses, so they can only ever be package drift |
| `saved-chat-archive-diagnostics.tauri.js` | the `{ observed: false, deferredTo: 'P3.5' }` stub is replaced by a real availability block; the legacy `counts.dataImageResidue` stays retired |
| `archive-health-ui.studio.js` | Drift card renders measured hygiene counts, `n/a` when unobserved, and states partial coverage (`hygieneUnobservedPackages`) rather than hiding it |
| `studio.html` | script tag after the codec, before the composition |
| `tools/product/studio/pack-studio.mjs` | registered in BOTH module lists |

### Cause-aware copy — no seventh state

Hygiene introduces a third drift cause beside DB and asset-cache drift, and the
only purely cosmetic one. The existing copy ("Warnings are database or
asset-cache drift") would now be actively misleading. `explanationFor(status, result)`
varies only the explanation text; state, pill and tone are unchanged and hygiene
never moves severity.

## Validation

| validator | result |
| --- | --- |
| **renderer hygiene (new)** | **33 / 33** |
| **bounded decode (new)** | **9 / 9** |
| legacy-integrity reachability | 7 / 7 |
| coverage | 23 |
| inspector trusted | 8 / 8 |
| integrity contract | 14 / 14 |
| health mapping | 15 / 15 |
| trusted composition | 15 / 15 |
| health trusted switch | 15 / 15 |
| archive diagnostics | 70 / 70 |

Two validators asserted the now-removed `deferredTo: 'P3.5'` marker and were
updated to assert the delivered behaviour instead — that an observation which
reached no package still publishes no count.

> **CORRECTED — see the P3.5.6B section below.** The statement that followed here
> was: `validate-saved-chat-archive-export-share-v1.mjs` fails 15 checks, verified
> as a baseline failure by restoring every changed file to `61994567`. That
> measurement was correct but the REFERENCE was wrong: `61994567` is P3.5a, not
> accepted P3. It showed only that P3.5b added nothing further; it did not show
> that P3.5 as a whole matched accepted P3. It did not. The classification is left
> in place above rather than erased, because the misreading is the point.

## Real disposable Desktop acceptance

Disposable identifier **`org.h2o.studio.desktop.m10p354`**, isolated by an
external Tauri `--config` overlay held outside the repository. Built with the
canonical chain (`npm run dev:rebuild` → `H2O_EXT_DEV_VARIANT=production
build-chrome-live-extension.mjs` → `prepare-dist.mjs`).

**Bundle freshness proved before running**: `dist/…/saved-chat-archive-renderer-hygiene.js`
SHA-256 `ecb48b00f66a95f0…` matches the source byte for byte — the stale-bundle
failure mode that invalidated the first P3.4 attempt.

Fixtures were built by reproducing the v3 identity algorithm
(`{"assets":[…],"payloadVersion":3,"snapshot":"…"}` → SHA-256), first verified
against the known `t06-canonical-assets` fixture.

### Case 1 — valid V3 **gzip** package carrying residue

`m10p354-case1-residue.gcd63865d….h2ochat`, `nameClassification: "generation"`,
`contentHashOk: true`, `blockers: []`, **`status: "warning"`**.

Its warning list carries:

> `package snapshot content still contains inline data:image renderer residue`

The snapshot is stored gzip (565 physical / 1224 logical bytes). Compressed
bytes read as UTF-8 cannot contain the literal `data:image/`, so finding the
residue proves the new bounded decoder actually ran on the real Desktop path.

### Case 2 — indeterminate package, hygiene SKIPPED

`m10p354-case2-indeterminate.h2ochat`, blocked by the trusted verifier with
`generation-manifest-json-invalid`.

Its snapshot deliberately contains `data:image/png;base64,` as a **falsifier**:
had hygiene read it, `dataImageResidue` would be 2. It reports **1**.

### Runtime shape

```json
"rendererHygiene": {
  "observed": true, "attempted": true,
  "packagesObserved": 1, "packagesUnavailable": 0, "packagesSkipped": 1,
  "dataImageResidue": 1, "assetRefDrift": 0
}
```

`counts` carries no `brokenPackageAssets`, no `assetRefMismatches`, no
`dataImageResidue`, and the result carries no `deferredTo`. `assetRefDrift: 0`
confirms the trusted-SHA normalization: Case 1's snapshot assetRef matched the
trusted `assetShas` entry despite differing representations.

Aggregate **Mixed** (`status: "partial"`) — Case 2's trusted blocker plus Case 1's
drift. Hygiene contributed drift and never a blocker. The cause-aware copy
rendered live:

> Some packages have integrity problems; others are healthy and portable, though
> some carry cosmetic renderer residue.

### Production safety

The production archive was byte-identical before and after:

| | value |
| --- | --- |
| files | `19` |
| inode | `246337901` |
| mtime / ctime | `1782299170` / `1782299170` |
| digest | `ba8c0100909fc1b97917fe06ec0328237d2e80af34455f2769a5bfe7296ddcfb` |

All fixtures and runtime activity stayed under the disposable
identifier-scoped root. Another Lane's Studio process (PID 64655) ran throughout
and was never terminated, clicked or manipulated; the disposable app carried a
distinct product name and bundle id, so every action was bundle-scoped to it.

The full build chain produced **zero tracked change** — `dist/` and
`apps/extensions/chatgpt/chrome/prod/` are gitignored.

## Not done here

No Rust change. No P3.6 (legacy verifier retirement, M08 carveout). No P4. The
legacy verifier code, the M08 byte-source carveout and its `data-image-residue-v2`
code are all untouched. No repair, delete, quarantine or restore authority was
added, and no persistent observability state was created.


---

# P3.5.6B — Inspector compatibility repair (2026-09-05)

## What the earlier comparison got wrong

The P3.5b review measured its export-share failures against **`61994567`**, which
is P3.5a. That comparison was valid for what it asked — P3.5b itself introduced no
further export-share failures — and invalid for what it was taken to mean: it never
established that P3.5 as a whole matched accepted P3.

Independent review compared true accepted P3, **`0cb18cf7`**, and found:

| tree | export-share failures |
| --- | --- |
| accepted P3 `0cb18cf7` | **1** |
| P3.5a `61994567` | 16 |
| P3.5b `bd6974a7` | 16 |

> Measurement note. Those counts are from like-for-like EXTRACTED trees. The single
> accepted-P3 failure is `no S0F0j/S0F1j files are staged by J.2`, whose check shells
> out to `git diff --cached`; outside a git repository that command errors, so the
> check fails for environmental reasons. Given each extracted tree its own throwaway
> repository, accepted P3 scores **0**. In the live repository the same three trees
> score 0 / 15 / 15. Both measurement modes agree on the quantity that matters:
> **P3.5 introduced exactly 15 export-share failures.** The J.2 item is untouched by
> this repair and behaves identically to accepted P3 under either mode.

## Why a harness-only repair was not enough

The first attempted repair fixed only the validator dependency graph. It recovered
13 of the 15 and left two, which turned out to be genuine PRODUCT compatibility
regressions that P3.5a had introduced silently:

**A — the published mapper contract changed.** `mapInspectStatus(diag, readError)`
was the accepted-P3 public API consuming the LEGACY diagnostic shape. P3.5a changed
its implementation to consume trusted occupants while keeping the same published
symbol. The untouched M08 portable importer still calls
`getInspector().mapInspectStatus(diag, null)` with a legacy diagnostic, which carries
no `class` — so the trusted mapper returned `read-error` and portable import became
`rejected`. A live M08 product regression.

**B — the public contentHash representation changed.** Accepted-P3 Inspector output
was `identity.contentHash = sha256-<64hex>`; P3.5a exposed bare `<64hex>`. The trusted
value was right, the outward representation was not. Relink compares
`identity.digest || identity.contentHash` against a DB digest written in the prefixed
form, so the comparison would have failed silently rather than thrown.

## The repair

One product file: `saved-chat-archive-inspector.studio.js`.

**Two explicit trust-domain mappers.**

| symbol | domain | visibility | caller |
| --- | --- | --- | --- |
| `mapInspectStatus(diag, readError)` | legacy diagnostic | **public** | `saved-chat-archive-importer.studio.js`, and nothing else |
| `mapTrustedInspectStatus(occupant, readError)` | trusted occupant | **internal** | `inspectPackage` and `listPackages` only |

The legacy mapper is restored to accepted-P3 behaviour verbatim, including the
historical `missing-files`, `unsupported-version` and `/sha|hash/i` heuristics —
valid only inside it. The trusted mapper keeps the final HDA taxonomy, and a
source-scoped assertion proves the retired labels appear in the legacy mapper and
nowhere else in the module. No shape sniffing; no dual-domain mapper.

**Representation, not authority.** `prefixedHash()` formats the already-trusted
contentHash and does not hash, re-hash, canonicalize or compare. Trusted Rust remains
the sole contentHash authority, and `contentHashVerified` still derives from trusted
status rather than legacy `hashChecks`. Restoring the prefix also repairs a display
bug: the manifest's claimed hash is stored prefixed, so under the bare form the
Inspector card always rendered the "does not match verified" warning.

**Harness dependency repair.** The export-share suite now loads the REAL
`saved-chat-archive-integrity.tauri.js` and `saved-chat-archive-health-mapping.js`
before the Inspector, mirroring `studio.html`, and its native invoke stub answers
`h2o_saved_chat_archive_integrity` with a canonical `h2o.savedChatArchiveIntegrity`
v1 envelope built from the manifests each test already installed — bare canonical hex
on the wire, honest classification (an unparseable manifest is reported
indeterminate). Nothing is stubbed, hard-coded verified, or routed back through the
legacy validator.

## Recovery attribution, measured

Each contribution was isolated in its own extracted tree:

| tree | failures | recovered |
| --- | --- | --- |
| P3.5b `bd6974a7` | 16 | — |
| \+ harness dependency repair only | 3 | **13** |
| \+ restored `mapInspectStatus` | 2 | **1** (`M08 portable ZIP reaches the shared import-as-new core`) |
| \+ restored prefixed contentHash | 2 | **1** (`M05 P4 zero-asset v2 exports`) |
| full repair | **1** | 15 total |

Final export-share result matches accepted P3 exactly: the sole remaining item is the
same J.2 debt, neither suppressed nor repaired.

## Residual — P3.5 regression surface is NOT fully closed

Export-share is back to baseline, but two further validators that accepted P3 passed
cleanly are still failing, and this repair did not close them:

| validator | accepted P3 | P3.5b | after this repair |
| --- | --- | --- | --- |
| `validate-saved-chat-archive-import-recovery-harness-v1` | 0 | 32 | **32** |
| `validate-saved-chat-archive-recovery-import-export-v1` | 0 | 2 | **1** |
| `validate-studio-import-bundle` | 16 | 16 | 16 (genuinely pre-existing, unrelated) |

Diagnosed in scratch, not committed: **31 of those 32 are the identical harness
dependency debt** — `STORE_MODULES` does not load the two trusted modules and the
mock invoke has no `h2o_saved_chat_archive_integrity` case. Applying the same two-hunk
fix takes it from 32 failures to 1.

The 32nd, `[M03 T04] Inspector fails closed on a corrupt gzip v3 member`, cannot be
closed the same way. A package with a byte-corrupt gzip member still has a valid,
parseable manifest, so a manifest-derived envelope classifies it verified while the
real Rust verifier would refuse it. Answering honestly needs the harness to establish
trusted facts from member BYTES, which is a design decision this step has no authority
to make — and faking it by running the legacy verifier and relabelling its output is
exactly what the trusted-envelope rule forbids.

The remaining `recovery-import-export` failure is `[H.2] inspector reuses the
read-only diagnostics validation`, an assertion superseded by the P3.5a trusted
migration by design.

## Runtime acceptance

None repeated. The repair restores established contracts and adds no filesystem,
codec, admission-write or publication semantics, and the export-share suite exercises
the affected portable path directly with the real modules.

## P3.5.8 — recovery validation restored at the trusted native boundary

The two carried validator failures above are now closed. This step changed
validators and evidence only: **zero product delta, zero Rust delta.**

### Baseline methodology correction

The earlier export-share `no S0F0j/S0F1j files are staged by J.2` failure was
recorded as genuine baseline debt. It was not. It was an **extraction
environment artifact**: the check shells `git diff --cached`, and the accepted-P3
tree had been extracted with `git archive` into a plain directory that was not a
Git repository. Re-run inside a real throwaway Git repository, accepted P3
`0cb18cf7` reports **zero** export-share failures. Baselines for Git-shelling
validators are established that way from here on.

Accepted-P3 baselines, real-Git execution boundary:

| validator | accepted P3 `0cb18cf7` |
| --- | --- |
| export-share | PASS 56 checks |
| import-recovery-harness | PASS 77 checks |
| recovery-import-export | PASS 34 checks |

### The 31 dependency failures

Closed exactly as diagnosed: `STORE_MODULES` now loads the real
`saved-chat-archive-integrity.tauri.js` and `saved-chat-archive-health-mapping.js`
in the production-faithful order studio.html uses (codec → integrity client →
diagnostics → mapping → inspector), and the harness's existing `mockInvoke`
answers `h2o_saved_chat_archive_integrity` with the canonical
`h2o.savedChatArchiveIntegrity` / `schemaVersion: 1` envelope.

### The 32nd — corrupt gzip, resolved without a JS verifier

The blocking concern above was right that a manifest-derived envelope must not
decide validity, and wrong that the harness therefore needed byte-level facts.
It needed neither. Package-byte validity is **Rust's**, and Rust already proves
this case:

- `archive_package_scan::tests::scanner_refuses_v3_renderer_members_malformed_gzip_and_false_logical_descriptor`
  — case `scan-v3-gzip-malformed`, asserting `Indeterminate` with
  `Corrupt | Partial`, and deliberately **no** granular blocker code.
- `saved_chat_package_verify::tests::v3_rejects_gzip_logical_descriptor_and_bounded_decode_failures`
  — granular refusals for descriptor and bounded-decode failures.
- `saved_chat_package_verify::tests::permanent_identity_and_gzip_fixtures_verify_to_one_js_identity`
  — both permanent V3 fixtures verify, anchoring the valid declarations.

So each scenario **declares** the trusted outcome the native boundary is proven
to return, and the test double replays it. `writeV3` now refuses to run without
an explicit declaration — there is no inferred default. Nothing in the harness
inspects bytes, hashes, decodes gzip, or calls a JS validator to decide validity.

The assertion changed accordingly: `corrupt gzip must report blockers` demanded
specificity the trusted boundary does not guarantee. It now asserts the
downstream truth — status `corrupted`, `ok: false`, not verified — while keeping
the guarantee that unverified payload never reaches semantic JSON parsing.

One further honest consequence: the P4.11 sibling stored under a generation
basename whose hash does not match its proven identity is declared
`indeterminate` / `identity-mismatch`, matching the `NameShape::Generation` arm
in `archive_package_scan.rs`. Its explicit-selection assertions still pass.

### The obsolete H.2 assertion

`[H.2] inspector reuses the read-only diagnostics validation` required the
Inspector to call `validateSavedChatPackageV1` and
`listSavedChatArchivePackagesV1` — the architecture P3.5a retired. It now asserts
the accepted one: the Inspector reads `readSavedChatArchiveIntegrityV1`,
partitions through `partitionOccupants`, maps via `mapTrustedInspectStatus`, and
references neither retired symbol for archive-integrity decisions. The sibling
read-only, no-store-write, no-HTML-execution and status-vocabulary assertions are
untouched. `mapInspectStatus` legitimately remains for the M08 carveout.

### Result

| validator | before | after | accepted P3 |
| --- | --- | --- | --- |
| export-share | 56 checks, 0 fail | 56 checks, 0 fail | 56 checks |
| import-recovery-harness | 45 pass / 32 fail | **PASS 77 checks** | 77 checks |
| recovery-import-export | 33 pass / 1 fail | **PASS 34 checks** | 34 checks |

No runtime acceptance was repeated: this step modifies validation and evidence
only, so the renderer-hygiene and portable-import runtime evidence above still
applies unchanged.

P3.5 is **not** self-accepted here. It returns for independent final review.

## Still owed

P3.6 must retire the temporary legacy `mapInspectStatus` together with the M08 JS
validation authority it serves: establish trusted native portable byte-source
verification, migrate importer/exporter off the legacy diagnostic validity path, stop
passing legacy diagnostics through Inspector mapping, keep the trusted internal
mapper, and retire the exporter's private contentHash authority.
