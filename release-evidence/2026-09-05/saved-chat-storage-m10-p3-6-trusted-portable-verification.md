# M10 P3.6 — Trusted portable byte-source verification

Lane 🗃️ L-SAVED-CHAT-STORAGE · Mission M10
Steps P3.6a / P3.6b / P3.6c · Branch `work/saved-chat-storage` · Parent `cec3a613`
Date 2026-09-05 · NOT PUSHED

## What changed, in one sentence

Portable `.h2ochat` import and export stopped deciding package validity in
JavaScript and now ask the same trusted Rust verifier the archive path has used
since P3 — through ONE new entry point, not a new authority.

## P3.6a — native entry point + thin client

`apps/studio/desktop/src-tauri/src/saved_chat_portable_verify.rs`
`src-surfaces-base/studio/ingestion/saved-chat-portable-package-verification.tauri.js`

Five commands, raw-body transport, reusing the established pattern:

```
begin(packageDirName, unexpectedMembers)
  -> declare(memberKey, expectedLength)
  -> write raw chunk x N          (members may interleave)
  -> finish            abort at any point, idempotent
```

There is no `end_member`: a member is complete when its accumulated length
equals what was declared.

**The adapter owns** framing, bounded accumulation, member identity safety and
assembling the existing `PackageMembers` input (including hashing the asset
bytes that actually arrived). **It owns no semantics** — manifest and version
rules, snapshot semantics, contentHash, member hashes, V3 renderer rules, gzip
validity and cross-binding all stay in `verify_package`, entered at
`VerificationAdmission::AllSupported`.

Identity binding comes from the package basename via the existing
`archive_package_scan::name_shape`, never from the manifest's own claim. No
competing name grammar was introduced and no visibility refactor was needed.

**Caps** are the approved values, reusing existing constants where the same
semantic limit already existed (`CHUNK_CAP_BYTES`, `GOVERNED_ASSET_BLOB_CAP_BYTES`,
`SESSION_IDLE_TIMEOUT`): manifest 1 MiB, snapshot 8 MiB, markdown 8 MiB, html
16 MiB, 1 020 assets, 1 024 members, 128 MiB per package and in aggregate,
255-byte basename and member path, one active session. Declared lengths are
charged against the package total at `declare`, so a caller cannot reserve
128 MiB across members and discover it only at finish.

**Sessions are memory.** One at a time, swept lazily at `begin` with no timer
thread, never evicted while live, destroyed unconditionally at finish. No
archive path, no DB, no CAS, no staging file, no persistent verification record.

> Honest limit: Tauri materializes the raw request body before adapter code can
> reject an oversized request. The chunk cap bounds what is *retained*, not that
> pre-materialization allocation. The existing raw-body pattern was reused rather
> than inventing another transport.

**Result wire** `h2o.savedChatPortablePackageVerification` v1, contentHash and
assetShas as BARE lowercase hex, matching the trusted archive wire. Refusals say
`stage: "adapter" | "verifier"` with the genuine code; an adapter failure never
borrows a verifier blocker.

Coverage: **24 Rust tests** (framing, every cap at limit and limit+1, session
lifecycle, plus semantic delegation reusing the canonical verifier fixtures) and
**20 JS client checks**.

## P3.6b — importer migration and mapInspectStatus retirement

The legacy chain (`validateSavedChatPackageBytesV1` → diagnostic →
`mapInspectStatus`) is gone. Verification happens **before** the snapshot is
decoded, so a refused package never reaches the decoder; V3 gzip decoding still
goes through the governed shared codec, and a post-verification decode failure is
an import/read error rather than a second verdict.

`mapInspectStatus` had exactly one production consumer. With the importer
migrated it had none, so the temporary M08 bridge was deleted in the same
checkpoint. The trusted internal Inspector mapper stays.

**Status honesty.** `unsupported-version` is retired: the verifier refuses an
incoherent version triple as structural incoherence, which is a different claim,
and no trusted fact proves the other one. The trusted labels `incomplete`,
`unreadable` and `identity-mismatch` now map to `corrupted` rather than falling
through to `rejected` — they are verdicts about the package, not failures to
reach one. No hash-mismatch granularity was invented.

### Two things the runtime taught us

**Session tokens were being corrupted in transit.** A 64-bit token crosses the
IPC boundary as a JSON number and was silently rounded in the renderer, so every
later call named a session that did not exist — and the abandoned one held the
single slot. Tokens are now masked into the range JavaScript represents exactly,
with a test that pins it.

**Portable V3 exports carry renderer companions.** A V3 export regenerates
`chat.md`/`chat.html`, and the container's governed inventory requires them — but
V3 package semantics forbid a persistent renderer. They are transport artifacts,
so they are not offered as semantic members. Shaping that on the manifest's
CLAIMED version is safe in both directions because it can only make the verdict
stricter: claims v3 but really v1/v2 refuses `required-renderer-missing`; claims
v1/v2 but really v3 has its renderers verified.

### Disposable runtime — Import A / Import B

Identifier `org.h2o.studio.desktop.m10p36b`, external Tauri `--config` overlay,
disposable AppLocalData and DB. Bundle freshness proved before each run.

> The portable-ZIP import/export APIs have no UI surface in this build, so the
> acceptance was driven by a harness injected into the DISPOSABLE dist only —
> never into tracked source. It calls the shipped product APIs and reimplements
> nothing; the importer, the client and the five native commands under test are
> the real ones. The dist was rebuilt harness-free afterwards.

**Import A** — valid portable V3 gzip:

| step | result |
| --- | --- |
| dry-run | `import-ready`, "verified and not present in store" |
| trusted identity | chatId `t06-canonical-assets`, snapshot `snap_t06_canonical_assets` |
| contentHash | `sha256-f8d91c31…` (trusted value, prefixed outwardly) |
| schema / payload | 3 / 3, from the trusted construction family |
| dry-run mutation | **none** (chats and snapshots unchanged) |
| import | `imported`, chats +1 / snapshots +1 |
| fresh ids | `recovered_4a584e04-…` / `snap_731dfafd-…`, both != the originals |
| provenance | `h2ochat-zip-recovery`, originalChatId/SnapshotId, portableZipName |
| **restart** | the recovered chat, its snapshot and its 2 turns all survive; still exactly one recovered chat |

**Import B** — corrupt portable V3 gzip: `rejected`, and chats/snapshots
unchanged at 1/1. The raw native probe returned
`{stage: "verifier", code: "generation-member-sha-mismatch"}`.

## P3.6c — exporter migration and private contentHash retirement

Final sequence: source trust from the trusted Archive Inspector -> assemble
members -> **trusted native verification ONCE, before any ZIP exists** -> ZIP
encode/write/read-back -> unchanged native create-only publication.

The read-back is now TRANSPORT identity only: it proves the container round-trips
those exact bytes, which is what binds the semantic claim to what gets published.
Verifying a second time after the write would be ceremony, not assurance.

**Retired:** `contentHashExpected` (deleted), `canonicalJson` (deleted — its only
consumer was the retired hash), and the `copied package contentHash mismatch`
comparison. **Retained and demoted:** `sha256Prefixed`, now explicitly
transport-only — copied-member equality and the published ZIP's own byte
identity. `verifyCopiedFiles` keeps its per-member hash and byteLength checks
against the manifest's declared descriptors.

Canonical package contentHash now comes from the trusted result as bare hex and
is formatted to `sha256-<hex>` only where the outward export contract requires
it. No JS package-semantic contentHash recomputation remains.

### Disposable runtime — Export C

| step | result |
| --- | --- |
| dry-run | `export-ready` |
| export | `exported`, method 8, 5 entries, 2 998 bytes |
| read-back | byte-equality passed ("portable ZIP exported and read-back verified") |
| contentHash | `sha256-f8d91c31…` — the trusted value |
| **published bytes re-verified natively** | fed back through the trusted import path: `import-ready`, identical trusted contentHash, schema/payload 3/3, zero mutation |

The destination-collision case was not re-run: its native create-only authority
is unchanged by this phase.

## Final legacy reachability

| claim | result |
| --- | --- |
| Health / Coverage / Inspector -> trusted archive integrity | unchanged |
| Importer AND Exporter -> trusted portable native verification | **yes** |
| `validateSavedChatPackageBytesV1` production consumers | **zero** |
| `validateSavedChatPackageV1` production validity consumers | zero outside its own byte-path delegation |
| `mapInspectStatus` | **symbol retired** |
| `listSavedChatArchivePackagesV1` production archive consumers | zero |

The legacy JS verifier code remains physically present; retiring production
authority did not require deleting it. That cleanup is P4.

## Assurance

Native: 24 portable-adapter tests, 10 semantic-verifier tests. JS: portable
client 20, import-recovery harness 77, recovery-import-export 34, export-share
57, reachability 10, trusted Inspector 11, relink 24, restore-relink 14,
coverage 24. `node --check` on every modified JS/MJS, `rustfmt --check` clean on
the new native module, Studio pack/reference smoke OK.

## Safety

Production archive byte-identical before and after (19 files, mtime
`1782299170`); production `studio-v1.db` digest unchanged (`7a728e1f9db84270`).
All runtime work stayed under the disposable identifier. Another Lane's Studio
process ran throughout and was never terminated or manipulated. No push.

## New-authority seal

New package verifier NO · new scanner NO · new hash authority NO · new integrity
severity authority NO · new format-stale authority NO · new retention authority
NO · new destructive authority NO · new persistent verification state NO.
