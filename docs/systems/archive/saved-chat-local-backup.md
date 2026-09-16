# Saved Chat Manual Local Backup v1 — Native Publisher

Status: Normative reflection of the accepted T01 contract / Backup v1 T02
candidate (native root policy + create-only publisher); NOT landed on Product
main; T03 (Studio module / UI), T04 (acceptance) and T05 (landing) pending

Date: 2026-09-16

Lane: 🗃️ L-STORAGE-SAVED-CHATS — Saved Chats Storage

Mission: `manual-local-saved-chat-backup-v1` — Manual Local Saved-Chat Backup v1

Authority: the HDA-accepted T01 contract
`missions/manual-local-saved-chat-backup-v1/t01-local-backup-v1-contract.md`
(Management repository; SHA-256
`ad0709a18f18cf73f67d3648fe4d8281e58620c15fd88cd08c2d15d4fa3d5504`). This
document reflects that contract for the native surface T02 implements; where
the two differ, the contract governs.

Related:

- [Saved Chat Archive Generations Contract](saved-chat-generations.md)
- [Saved Chat Package v3 Contract](saved-chat-package-v3.md)
- [Saved Chat Archive Reclamation Contract](saved-chat-reclamation.md)
- [Saved Chat Storage ↔ Transport Object Handoff Contract](saved-chat-transport-handoff.md)

## 1. Bounded outcome

Backup v1 lets a person write every currently saved chat, as a verified v3
archive package, into ONE immutable backup object under a governed local root,
and later verify that object. The native surface consists of two new modules:

| Module | Role |
| --- | --- |
| `apps/studio/desktop/src-tauri/src/saved_chat_backup_root_policy.rs` | immutable root policy: `BACKUP_ROOT = <base>/H2O Studio Backups`; one read-only query command |
| `apps/studio/desktop/src-tauri/src/saved_chat_local_backup.rs` (+ `saved_chat_local_backup/tests.rs`) | session-bound, create-only staged publisher; LIST and VERIFY read-only commands |

`lib.rs` receives a mechanical registration only (two `pub mod` lines, one
`.manage(saved_chat_local_backup::BackupState::default())`, and the ten command
names in BOTH `generate_handler!` arms — pure line additions, byte-disjoint
from the accepted filesystem-safety T02 candidate's `lib.rs` hunk).

Nothing here is retention, rotation, GC, restore, scheduling, encryption, a
remote destination, a user-selected destination, a new package format or a
Recovery Center change. Backup packages ARE archive generations: same members,
same encodings, same descriptor rules, same `contentHash`, same leaf grammar.

## 2. Root policy

`BACKUP_ROOT = <base>/H2O Studio Backups`, where `<base>` is resolved natively
by the SAME immutable mode enum the export-root policy uses: `home_dir()` in
ordinary builds; `app_local_data_dir()` only under the existing debug-only
`saved-chat-v3-acceptance` feature (`hostRootMode: "home" | "appLocalData"`).
No feature flag, environment variable, renderer input or persisted preference
selects the root. `h2o_saved_chat_backup_root_policy` returns
`{ schema: "h2o.studio.saved-chat-backup-root-policy.v1", baseDirectory,
rootComponent: "H2O Studio Backups" }` for display only.

The root is CREATED only by BEGIN's creating admission (`Dir::open_root`),
after the declaration has been validated. LIST and VERIFY admit it
non-creating (`Dir::open_existing_nofollow`) and report `backup-root-absent`
when it does not exist.

Capability / config decision (RPC-3): `NO_CHANGE_REQUIRED`. Every byte under
`BACKUP_ROOT` is written, fenced, verified, listed and read by native commands
that derive the root internally; the renderer holds no `plugin:fs` scope on
it and needs none. `tauri.conf.json`, the capability files, `Cargo.toml` and
`Cargo.lock` are unchanged.

## 3. Backup object

```text
<BACKUP_ROOT>/
  <backupId>.h2obackup/                 (complete set)     — or —
  <backupId>.partial.h2obackup/         (explicitly incomplete set)
    backup-manifest.json
    packages/
      <chatId>.g<64 lowercase hex>.h2ochat/
        manifest.json
        snapshot.json
        assets/sha256-<64 lowercase hex>.<ext>      (0..n)
```

- `BACKUP_ID_GRAMMAR`: `^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{16}$` — a UTC basic
  timestamp from the native clock (human ordering only) plus 16 hex digits of
  native entropy. Identity is the whole string; the timestamp is never
  freshness, ordering or validity authority. `backupId` is native-generated
  at BEGIN.
- Package leaves use the archive generation grammar
  (`archive_generation_publish::generation_basename`) derived from the
  RECOMPUTED content hash, never from the renderer's claim.
- Reserved staging names (Backup-owned; NOT added to the archive's
  `RESERVED_COMPONENT_PREFIXES`): `.h2o-backupstage-<32 hex>` (run, under the
  root), `.h2o-bkpkg-<32 hex>` (package, under `<run>/packages`),
  `.h2o-bkmanifest-<32 hex>.tmp` (manifest, under `<run>`).
- Name admission: every governed leaf is ASCII, single-component, refuses
  Windows reserved device stems ASCII-case-insensitively (whole stem and the
  segment before the first `.`), and is admitted against the parent's real
  `name_max()` (`backup-name-limit-indeterminate` when unanswerable,
  `backup-name-exceeds-filesystem-limit` when too long). `chatId` is admitted
  by the existing `validated_chat_id` authority.
- Every open below the admitted root is descriptor-relative and no-follow; a
  redirecting object at a governed component is refused
  (`backup-path-redirect-refused`). A pre-existing entry of any type at a
  staging or final name is a collision, never a target.

## 4. Native command / session model

`NATIVE_COMMAND_MODEL = SESSION_TOKEN_BOUND_STAGED_PUBLISHER`. The renderer
names only: a session token (decimal text, the publisher's `ipc_token` rule),
the declared enumeration, a `(chatId, snapshotId)` pair at `package_begin`,
member KINDS (plus the canonical asset name), bytes, byte lengths, an
`expectedContentHash` at `package_finish`, failure records, and a governed
leaf chosen from the native list. Never accepted: any path, root, destination,
staging name, package leaf, `backupId`, `complete` flag, or any timestamp that
bears on identity or validity.

| Command | Input | Output |
| --- | --- | --- |
| `h2o_saved_chat_backup_root_policy` | — | policy (§2) |
| `h2o_saved_chat_backup_begin` | `{ enumeration: { at, eligible: [{chatId, snapshotId}], skipped: {deleted, tombstoned, linkedOnly, noSnapshot}, enumeratedCount, source: {appBuildStamp} } }` | `{ ok, status: "created", token, backupId, stagingLeaf, platform: {supported, family} }` or `{ ok:false, status }` |
| `h2o_saved_chat_backup_package_begin` | `{ token, chatId, snapshotId }` (no hash: the stage is opened BEFORE the projection, RC-T01-BACKUP-01) | `{ ok, status: "created" }` |
| `h2o_saved_chat_backup_write_member` | raw body chunk (≤ 8 MiB) + `options` header `{ token, member: { kind: "snapshot" \| "manifest" \| "asset", name? }, final, byteLength? }` | `{ ok, status: "accepted", memberBytes, memberSha256? }` |
| `h2o_saved_chat_backup_package_finish` | `{ token, expectedContentHash }` (`sha256-<hex>` or bare hex) | `{ ok, status: "verified", entry }` or `{ ok:false, status, codes? }` |
| `h2o_saved_chat_backup_package_abort` | `{ token, reason }` | `{ ok, status: "aborted", cleanupIncomplete }` |
| `h2o_saved_chat_backup_finalize` | `{ token, failures: [{chatId, snapshotId, code, stage, detail}] }` | `{ ok, status: "published" \| "published-partial", committed, durabilityComplete, fullFsync, backupId, backupLeaf, complete, counts, setDigest, manifestSha256, codes? }` |
| `h2o_saved_chat_backup_abort` | `{ token }` | `{ ok, status: "aborted", cleanupIncomplete }` |
| `h2o_saved_chat_backup_list` | — | `{ ok, status, rootPresent, rootDisplayPath, entries: [{leaf, kind, backupId?, manifestPresent?}], residueCount, codes }` |
| `h2o_saved_chat_backup_verify` | `{ leaf }` | `{ status, codes, backupId, complete, counts, setDigest, entriesVerified, occupantsSeen }` |

BEGIN order (NB-05): (1) compile-time platform arm (`backup-unsupported-platform`
on every non-macOS target, before any filesystem access); (2) session
availability (`backup-session-busy` while a live session exists; a terminal
PUBLISHED / FAILED / ABORTED record and an idle-expired live session are
evicted, the latter with own cleanup); (3) declaration validation —
non-empty `eligible` (`backup-nothing-to-back-up`), well-formed pairs, no
duplicate pair and no duplicate `chatId`, the counts identity
`enumerated = eligible + deleted + tombstoned + noSnapshot`
(`backup-enumeration-inconsistent`); ONLY THEN (4) creating root admission,
exclusive `.h2o-backupstage-<hex>` and `packages/`, session registration. A
refusal in (1)–(3) creates no root, no staging and no session.

Session rules: `MAX_ACTIVE_BACKUP_SESSIONS = 1`; idle eviction after 15
minutes by the next command that observes it (`backup-session-evicted`, own
cleanup; afterwards `backup-session-unknown`); cooperative cancellation
(NB-06): `abort` raises a flag, an in-flight command completes its current
step, a command that observes the pending abort returns `backup-cancelled`,
every command on an `ABORTED` record returns `backup-cancelled`, and
`backup-invalid-state` is reserved for a transition the machine does not draw
from a live state. A cancel observed inside FINALIZE before the commit point
yields FAILED / `backup-cancelled` with own cleanup; after the commit point
FINALIZE returns its normal published result and the abort is a no-op.

```text
NEW ──begin──▶ STAGING ──package_begin──▶ PACKAGE_OPEN ──package_finish ok──▶ STAGING
                  │                            └──package_finish(fail) / package_abort / discarded write──▶ STAGING
                  ├──finalize──▶ SET_FINALIZING ──(manifest, scan, promote ok)──▶ PUBLISHED
                  │                     └──(any failure)──▶ FAILED (own staging removed best-effort)
                  └──abort──▶ ABORTED ──(next BEGIN / idle eviction)──▶ record gone
```

`package_abort` is benign when no package is open (a stage already discarded
by a failed write or finish): `{ ok, status: "aborted", cleanupIncomplete: false }`.

## 5. Member writes

- `snapshot` → `snapshot.json`, `manifest` → `manifest.json` (filenames derived
  natively; a supplied `name` is refused); `asset` requires the canonical name
  `sha256-<64 lowercase hex>.<ext>` (`ext` in `[a-z0-9]{1,16}`) and lands in
  `assets/` (created exclusively on the first asset).
- The first chunk of a member creates it exclusively (`create_new_child`);
  later chunks append to the retained handle; SHA-256 is computed
  incrementally; `final: true` closes the member: content fence
  (`sync_file_contents`, `F_FULLFSYNC` truth flag folded into `fullFsync`),
  then the closing sha is bound to the asset name.
- Admission: chunk > 8 MiB ⇒ `backup-chunk-too-large`; a member name may be
  opened once (`backup-member-duplicate`); one open member at a time
  (`backup-invalid-state`); an invalid selector ⇒ `backup-invalid-member-name`.
  These are protocol refusals with no side effect (the stage stays open).
- Integrity / infrastructure failures discard the package stage (own names
  only) and return the session to STAGING: `backup-member-empty`,
  `backup-member-length-mismatch` (declared `byteLength` ≠ received),
  `backup-asset-hash-mismatch`, `backup-write-failed` (I/O incl. `ENOSPC`),
  `backup-fence-failed`.

## 6. Package finish — binding sequence (RC-T01-BACKUP-01)

1. Both application members closed and no member open, else `backup-invalid-state`.
2. `expectedContentHash` normalized through `normalize_expected_sha`; a value
   it rejects is refused as `backup-invalid-member-name` (PROTOCOL_ERROR, no
   side effect).
3. Fences: `assets/` (if present) and the stage directory.
4. `verify_occupant_all_supported(<retained packages Dir>, <.h2o-bkpkg-… stage name>)`
   — the trusted verifier inspects the package under its dot-prefixed staging
   name (NB-11); any refusal ⇒ `backup-package-verification-failed` with the
   verifier's coarse code and granular rule code carried in `codes[]`. The
   construction family must be v3.
5. Recomputed identity (normalized) MUST equal the claim, and the verified
   `chat_id` / `snapshot_id` MUST equal the pair declared at `package_begin`,
   else `backup-package-identity-mismatch` — NO promotion, stage removed.
6. Leaf = `generation_basename(chatId, <recomputed hex>)`, admitted against
   `name_max()`; H′ pre-image = `fstat` of the retained stage object;
   `promote_dir_exclusive(stage, leaf)` (`Ok(false)` ⇒
   `backup-package-leaf-occupied`, `Unsupported` ⇒ `backup-unsupported-platform`,
   other ⇒ `backup-promote-failed`); H′ post-check via `stat_child_nofollow(leaf)`
   (`st_dev` + `st_ino`) ⇒ `backup-publication-identity-mismatch` when the
   occupant is not the verified object (never registered, never removed);
   fence `packages` — a fence failure here removes the own leaf again
   (identity-checked) and fails the package with `backup-fence-failed`.
7. The entry is registered; the result carries the manifest entry.

## 7. Finalize — durability order and the single commit point

Pre-transition refusals (no side effect; the session stays STAGING):
`backup-invalid-state` (a package is open), `backup-no-package-succeeded`
(`success == 0`), `backup-entry-unknown` (a failure names an undeclared pair),
`backup-manifest-inconsistent` (failures ∪ entries ≠ eligible, duplicates,
identity violations), `backup-manifest-too-large` (writer-side bound
`BACKUP_MANIFEST_MAX_BYTES = 256 MiB`, checked BEFORE any temp file exists,
NB-07).

Then, inside SET_FINALIZING (every failure ⇒ FAILED with own cleanup; a
pending abort is observed before each step ⇒ `backup-cancelled`):

8. Manifest: `create_new_child(run, ".h2o-bkmanifest-<hex>.tmp")` → write →
   content fence → `promote_exclusive(tmp, "backup-manifest.json")` → H′ →
   run fence.
9. Set verification: `archive_package_scan::scan_packages_within(<native
   staging run path>)` (RC-T01-BACKUP-02 — path-parameterized, native-derived;
   the scanner opens `<run>/packages` itself; the manifest at the run root is
   outside its enumeration) plus the manifest cross-check (§9) and the
   `setDigest` recomputation over occupant NAMES and verified identities.
10. Run fence after the verification reads.
11. `promote_dir_exclusive(".h2o-backupstage-<hex>", "<backupId>[.partial].h2obackup")`
    — the SINGLE commit point; `Ok(false)` ⇒ `backup-destination-exists`.
12. H′ (`fstat` of the retained run object before step 11 vs
    `stat_child_nofollow(final leaf)` after) then the root fence.
    `durabilityComplete = true` only when every fence of the run succeeded; a
    root-fence failure after step 11 is reported as `committed: true,
    durabilityComplete: false` with `codes: ["backup-fence-failed"]`, never as
    "nothing happened".

No final leaf can exist without a fenced, verified manifest and fenced,
verified packages. Free space is NOT pre-checked in v1 (frozen decision):
disk exhaustion surfaces as `backup-write-failed` / `backup-fence-failed`, the
run FAILS and removes its own staging.

## 8. Backup manifest (`h2o.savedChatLocalBackup.v1`)

Authored natively at FINALIZE, 2-space indented, `\n` line endings, trailing
newline, no BOM, keys in exactly this order:

`schema`, `schemaVersion` (1), `backupId`, `createdAt` (native clock,
ISO-8601 UTC ms), `complete`, `consistency`
(`"per-entry-guarded-enumeration-time-set"`), `source` {`appBuildStamp`
(renderer-declared or null), `liveGenerationFamily`, `platform`,
`hostRootMode`}, `enumeration` {`at` (renderer-declared), `counts`
{`enumerated`, `eligible`, `success`, `failed`, `skipped` {`deleted`,
`tombstoned`, `linkedOnly`, `noSnapshot`}}}, `entries[]` {`chatId`,
`snapshotId`, `contentHash`, `packageLeaf`, `constructionFamily`,
`schemaVersion`, `payloadVersion`, `snapshot` {`encoding`, `physicalSha256`,
`physicalByteLength`, `logicalSha256`, `logicalByteLength`}, `members`,
`assets`, `assetSource` (`"projection"`), `savedAt`}, `failures[]` {`chatId`,
`snapshotId`, `code`, `stage`, `declaredBy` (`"renderer"`), `detail` (≤ 512
bytes)}, `setDigest`, `verification` {`packageScanComplete`, `occupantCount`,
`verifiedCount`, `crossCheck`, `fullFsync`}.

- Entries are ordered by `chatId` byte order then `snapshotId`; failures by
  `chatId`. Every stored hash is `sha256-<64 lowercase hex>`; every native
  equality comparison is on bare hex through `normalize_expected_sha` (NB-13).
- `members` is the verifier's `persistent_members`; `assets` its `asset_shas`;
  `savedAt` is the ordering authority's `Orderable.saved_at` or null (never a
  filesystem timestamp).
- `setDigest = "sha256-" + hex(SHA-256(canonicalJson({ schema, entries:
  [{chatId, snapshotId, contentHash}] })))` over the sorted verified entries,
  no whitespace; two backups of identical content share it.
- `verification.*` states what the FINALIZE set scan proves for any object
  that reaches a final name (the manifest is written before the scan; a scan
  failure fails the run and the manifest never survives under a final name).
  `verification.fullFsync` covers the package member content fences; the
  finalize RESULT's `fullFsync` additionally covers the manifest's own fence.
- Counts identities: `enumerated = eligible + deleted + tombstoned + noSnapshot`
  and `eligible = success + failed`; `complete == (failures.length == 0)`;
  leaf/`complete` agreement (`.partial.` ⇔ `complete: false`).
- On read (VERIFY): duplicate JSON keys, duplicate entry pairs, an entry also
  present in `failures`, any missing/ill-typed required field ⇒ `malformed`;
  `schema` mismatch or `schemaVersion > 1` ⇒ `unsupported`; unknown fields are
  ignored.

## 9. Verification model

Per package: the trusted verifier at `package_finish` (§6).

Set level (FINALIZE on the staging run path; VERIFY on the admitted final
backup path): `scan.complete == true` and no blockers; every occupant must be
`VerifiedGeneration` (`LegacyPackage`, `ReservedInfrastructure`, a
non-package name or an unrepresentable entry ⇒ `backup-set-foreign-entry`;
a partial / corrupt / unreadable / identity-mismatched occupant ⇒
`backup-set-package-unverified`); occupant `name` ↔ `entries[].packageLeaf`
one-to-one; per entry `chat_id`, `snapshot_id`, `content_hash`, family v3,
snapshot descriptor facts, `asset_shas`, `persistent_members` and `savedAt`
equal (`backup-set-cross-check-failed`); `setDigest` recomputed from the
verified occupants equals the stored value (`backup-set-digest-mismatch`).

`VERIFY` (`h2o_saved_chat_backup_verify({ leaf })`, read-only, zero writes):

| `status` | Meaning |
| --- | --- |
| `valid-complete` | final grammar, v1 manifest, every check passes, `complete: true` |
| `valid-incomplete` | as above with `complete: false`, a `.partial.` leaf, failures listed |
| `malformed` | manifest missing / unparsable / duplicate keys / schema-shape failure (`backup-manifest-invalid`), counts or leaf-marker disagreement (`backup-manifest-inconsistent`), read bound exceeded (`backup-manifest-too-large`), any set check failure (`backup-set-*`) |
| `unsupported` | a leaf outside the final grammar (`backup-not-a-backup-leaf`), a foreign `schema` or `schemaVersion > 1` (`backup-manifest-invalid`), platform arm absent |
| `unreadable` | root absent (`backup-root-absent`), a redirecting or non-directory object at the root or leaf (`backup-path-redirect-refused`), an absent leaf (`backup-not-a-backup-leaf`), I/O (`backup-root-unavailable`) |

`LIST` classifies root entries by SHAPE only, never by timestamp: `backup`
(`<id>.h2obackup` directory), `backup-partial` (`<id>.partial.h2obackup`
directory), `staging-residue` (a Backup reserved prefix), `foreign`
(everything else, including a symlink or file shaped like a backup).
`residueCount > 0` adds the informational code
`backup-staging-residue-detected`; residue is never removed.

## 10. Own-cleanup rule

`STAGING_RESIDUE_RULE = OWN_SESSION_CLEANUP_ONLY; OLDER_RESIDUE_CLASSIFIED_NEVER_REMOVED`.
A session removes only names it created in THIS session — its open package
stage, its registered package leaves (identity-tracked from the H′ pre-image),
its manifest artifacts and its run staging directory — bottom-up through the
retained directory objects; every unlink is identity-checked against the
retained handle or recorded identity. A foreign entry inside the own tree
stops the removal of that subtree and the result reports
`cleanupIncomplete: true` / `backup-cleanup-incomplete`, never masking the
operation's outcome. Residue from other sessions is listed and classified
only. No retention, rotation, GC, quarantine or purge authority exists.

## 11. Error vocabulary

Classes: `RETRYABLE`, `SOURCE_DATA_ERROR`, `DESTINATION_ERROR`, `UNSUPPORTED`,
`INTEGRITY_FAILURE`, `CANCELLED`, `PROTOCOL_ERROR`. Codes produced natively:

| Class | Codes |
| --- | --- |
| DESTINATION_ERROR | `backup-root-unavailable`, `backup-root-absent`, `backup-path-redirect-refused`, `backup-destination-exists`, `backup-write-failed`, `backup-fence-failed`, `backup-promote-failed`, `backup-cleanup-incomplete` |
| UNSUPPORTED | `backup-unsupported-platform` |
| RETRYABLE | `backup-session-busy`, `backup-staging-collision` |
| PROTOCOL_ERROR | `backup-session-unknown`, `backup-session-evicted`, `backup-invalid-state`, `backup-name-exceeds-filesystem-limit`, `backup-name-limit-indeterminate`, `backup-invalid-member-name` (also a malformed `expectedContentHash`), `backup-member-duplicate`, `backup-member-empty`, `backup-chunk-too-large`, `backup-entry-unknown`, `backup-entry-duplicate`, `backup-manifest-inconsistent`, `backup-nothing-to-back-up`, `backup-no-package-succeeded`, `backup-enumeration-inconsistent` |
| INTEGRITY_FAILURE | `backup-asset-hash-mismatch`, `backup-member-length-mismatch`, `backup-package-identity-mismatch`, `backup-package-verification-failed`, `backup-publication-identity-mismatch`, `backup-package-leaf-occupied`, `backup-set-foreign-entry`, `backup-set-package-unverified`, `backup-set-cross-check-failed`, `backup-set-digest-mismatch`, `backup-manifest-invalid`, `backup-manifest-too-large`, `backup-not-a-backup-leaf` |
| CANCELLED | `backup-cancelled` |
| informational | `backup-staging-residue-detected` |

Renderer-side codes of the contract (`backup-enumeration-indeterminate`,
`backup-source-*`, `backup-projection-*`) are declared by the Studio module
(T03) inside `failures[]`; native stores them verbatim and never invents codes.

## 12. Resource bounds

| Bound | Value |
| --- | --- |
| member write chunk | ≤ 8 MiB per call (`CHUNK_CAP_BYTES` precedent), a transport constant, not a member ceiling |
| streaming | members are written and hashed incrementally from the retained handle; verification reads through the shared 256 KiB window; no whole-package buffering natively |
| manifest bytes | `BACKUP_MANIFEST_MAX_BYTES = BACKUP_MANIFEST_READ_CAP_BYTES = 256 MiB` |
| path component | `name_max()` of the admitted parent |
| free space | no pre-check (frozen decision); exhaustion surfaces as `backup-write-failed` / `backup-fence-failed` |
| sessions | 1 active per process; 15-minute idle eviction |
| cancellation checkpoints | at command entry and before each FINALIZE step |

## 13. Source non-mutation

During a run the Saved-Chat DB, `$APPLOCALDATA/archive/packages`, the CAS,
the asset registry, Recovery state and Sync state are READ ONLY, and the
native Backup module opens NONE of them: it consumes no `archive_root`, no
`app_local_data_dir` (outside the root policy's acceptance arm), no archive
command, no CAS primitive, no SQL. Its only root is `BACKUP_ROOT`.

## 14. Platform posture

macOS is the v1 acceptance target; every mutation composes the macOS-proven
floor of `archive_durable_write::confined::Dir` (`renameatx_np(RENAME_EXCL)`
for create-only promotion, `F_FULLFSYNC` content fences). Linux: FAIL_CLOSED —
BEGIN refuses `backup-unsupported-platform` by compile-time arm before
touching the filesystem. Windows: the module carries a `#[cfg(not(unix))]`
arm returning `backup-unsupported-platform` from every command. On a macOS
volume without `RENAME_EXCL` the promotion fails closed as
`backup-promote-failed` (coarse, honest); no pathname-raceable fallback is
ever selected. No Backup code, result field or string claims filesystem
T02/T03 certification.

## 15. Composition and compatibility (RPC-2)

`COMPOSE_DONT_REIMPLEMENT`: the module calls `Dir::open_root`,
`open_existing_nofollow`, `open_child_nofollow`, `open_child_read_nofollow`,
`stat_child_nofollow`, `mkdir_child_exclusive`, `create_new_child`,
`promote_exclusive`, `promote_dir_exclusive`, `unlink_child`,
`unlink_child_dir`, `read_entry_names`, `name_max`, `sync`, `as_raw_fd`,
`sync_file_contents`, `sha256_hex`, `normalize_expected_sha`,
`validated_chat_id`, `generation_basename`, `verify_occupant_all_supported`,
`scan_packages_within`, `random_token_seed` and `ipc_token` exactly as they
exist on Product main. The single direct syscall it issues is the read-only
`libc::fstat` identity query for class H′ (main exposes no H′ helper). It
implements no mutating syscall wrapper, no hashing primitive, no package
semantics and no name validator beyond the Backup grammars.

Implemented against CURRENT LANDED main APIs only. The accepted
filesystem-safety T02 candidate `80598237` changes three consumed APIs
(`promote_dir_exclusive` gains a leading `staging: &Dir` argument;
`stat_child_nofollow` returns `Option<EntryStat>`; `is_regular` /
`is_symlink` take `&EntryStat`) — the inventoried
`KNOWN_ACCEPTED_CONSUMER_API_DRIFT`, handled by the HDA-approved,
proof-only, Backup-owned consumer adaptation inside the RPC-2 composed-tree
proof at T04/T05 (`PROOF_ONLY_ADAPTATION_PATHS = src/saved_chat_local_backup.rs`
and its tests). No compatibility shim, feature flag or cfg arm for the unlanded
candidate is committed to Product.

Forbidden edit surface (`T02_SHARED_SEMANTIC_SURFACE`) — unchanged by this
candidate: `archive_durable_write.rs`, `archive_filesystem_capability.rs`,
`archive_generation_publish.rs` (+ tests), `archive_package_scan.rs`,
`saved_chat_package_verify.rs`, `saved_chat_folder_publish.rs`,
`saved_chat_zip_publish.rs`, `archive_transport_handoff.rs`,
`archive_instance_lock.rs`, `archive_reclaim*`, `archive_residue_probe.rs`,
`archive_cas_scan.rs`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`,
`capabilities/*`, the archive docs the candidate edits, and the exporter /
reclamation Studio modules.

## 16. Test contract (T02, `cargo test --lib`)

`src/saved_chat_local_backup/tests.rs` proves, against scratch roots and the
real v3 fixtures (identity + gzip): root confinement (symlink at the root, at
a final name, at a package leaf); create-only (occupants at the final and
package leaves left byte-identical); session isolation (unknown token, second
BEGIN, undrawn transitions); member writes (chunk cap, duplicate, invalid
asset name, hash/name mismatch, length mismatch, empty member, one open member,
incremental hash = whole-file hash); verification gating (positive identity and
gzip controls, byte-flipped negatives, both `expectedContentHash`
representations, declared-pair binding, the NB-11 dot-prefixed stage pin);
scanner reuse (foreign entry, `.h2o-bkpkg-*` leftover, legacy leaf ⇒ FAILED;
the manifest is not an occupant); declaration-before-creation (no root, no
staging, no session on every refusal; the non-macOS arm); cancellation and
eviction (`backup-cancelled` → `backup-session-unknown`; own cleanup; foreign
entry ⇒ `cleanupIncomplete`); the manifest bound (no temp file); durability
(fence failures before the commit point ⇒ FAILED, after ⇒ `committed: true,
durabilityComplete: false`; per-package fences); a pending abort at every
FINALIZE checkpoint; retry with a new identity; complete vs partial vs zero
success; VERIFY across every status class with zero writes; LIST by shape
with residue never removed; registration parity; and source tripwires for the
composition and source-non-mutation rules.

## 17. Not in v1

Scheduling; remote or cloud destinations; encryption; retention, rotation,
deletion, GC or residue reclamation; a user-selected destination; whole-DB
backup; raw CAS backup; a restore-from-backup adapter or UI; restore-current
or overwrite-existing; historical snapshot versions; renderer companions for
v3 packages; Linux or Windows certification.
