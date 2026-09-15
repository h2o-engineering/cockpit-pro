# Saved Chat Archive Generations — Immutable Publication, Freshness & Coverage Contract

Status: Normative / M05 T1.1.1 contract freeze

Date: 2026-08-26

Lane: 🗃️ L-STORAGE-SAVED-CHATS — Saved Chats Storage

Mission: M05 — Establish Immutable Saved-Chat Archive Generations, Freshness &
Coverage

Related:

- [Saved Chat Package Format — Versioned Umbrella Spec](saved-chat-package-format.md)
- [Saved Chat Package v1 Schema Spec](saved-chat-package-v1.md)
- [Saved Chat Package v3 Contract](saved-chat-package-v3.md)
- [DP-PRE-M05-ASSET-BOUND](../../decisions/DP-PRE-M05-ASSET-BOUND.md)
- [ADR-0009 — Chat Saving Architecture](../../decisions/ADR-0009-chat-saving-architecture.md)
- [ADR-0010 — Saved Chat Asset CAS](../../decisions/ADR-0010-saved-chat-asset-cas.md)
- [M05 T1.2.3 member-bound evidence](../../../release-evidence/2026-08-26/saved-chat-storage-m05-t123-member-bound-evidence.md)

## A. Mission, authority and scope

This document is the normative M05 contract for immutable saved-chat archive
generations: naming, classification, validity, freshness, coverage, the trusted
staged publication protocol, and its bounds. It freezes authority for the M05
implementation phases; it does not itself implement anything.

Standing constraints it operates under, none of which it modifies:

- D9, stated precisely: **this cockpit-pro source owns migrations through
  v17**, and the **production database legitimately contains externally owned
  migrations v18–v21**. Because those two authorities have diverged, this Lane
  allocates **no** new migration — not v18, v19, v20, v21, and not v22 — and
  integrates none of the external ones. The shorthand "the highest migration
  is v17, so the next one is v18" is misleading and must not be used without
  that production-authority divergence stated alongside it. All new queue
  metadata lives in the existing `meta_json` column.
- Live v3 remains OFF. `SERIALIZATION PARTIAL` remains carried.
- PRE-M05 remains authoritative: the CAS-scoped trusted durable write, the CAS
  repair write, and DP-PRE-M05-ASSET-BOUND (32 MiB per newly ingested asset —
  an ingest ceiling, never a read ceiling).
- New UI only. No Chrome architecture changes. No Sync-owned changes.

## B. Generation naming

The canonical immutable generation directory name is:

```text
<chatId>.g<hex64>.h2ochat
```

- `hex64` is the **complete** 64-character lowercase hexadecimal component of
  that package's own `contentHash`, with the `sha256-` prefix dropped in the
  filename only. No truncation. The manifest keeps the full prefixed value.
- `chatId` rules are unchanged from the existing writer
  (`safePackageDirName`): `^[A-Za-z0-9._-]+$`, not `.`, not `..`, no path
  separators. The charset is ASCII-only, so byte length equals character
  length.
- The name is **version-agnostic**: the hex is the contentHash of that package
  under its own payload version's frozen construction (v1 or v2 today; v3 if
  and when live v3 is separately activated).
- Generations live beside legacy packages under
  `$APPLOCALDATA/archive/packages/`.
- Post-M05 invariant: **all** newly published packages — including the first
  package of a previously uncovered chat — are generation-named. New
  legacy-shaped names are never created after M05.

## C. Legacy grandfathering

An existing `<chatId>.h2ochat` package is a grandfathered preservation
artifact. M05 never renames, rewrites, moves, or deletes it — not to adopt
generations, not on refresh, not on corruption. It participates in freshness
and selection exactly like a generation (§E). Legacy names are only ever
pre-M05 artifacts.

## D. Manifest-derived filename classification

A filename is **discovery input only** — never identity authority. Discovery
enumerates `archive/packages/` directories whose basename ends `.h2ochat`,
excluding the reserved staging prefix (§R).

**Discovery must be complete, and today it is not.** The existing inventory
truncates at a default 500 entries and merely emits a warning when it does.
Under the pre-M05 one-package-per-chat model that ceiling was effectively
unreachable; under accumulating generations it is the *first* thing M05 makes
reachable — and silent truncation would corrupt every derived judgement built
on it: PRESERVED, COVERED, BEST-HISTORICAL and the create-only dedupe check
would all be computed from a partial view. Phase 2 must therefore make
generation discovery **complete or explicitly paginated**, and any residual
truncation must be a first-class blocker on the affected chat's coverage
verdict rather than a warning on the whole inventory. This is a correctness
prerequisite for §E/§G, not a scaling nicety.

**But scanning is not the create-only authority — exclusive publication is.**
An incomplete scan must never be used to conclude "no fresh generation exists"
for any coverage or user-facing decision. It cannot, however, cause duplicate
content: identical logical content derives the identical trusted generation
name, so a truncated pre-publication scan simply leads to a promotion that
finds the destination occupied, and §N.2's trusted-side classification returns
`DEDUPED` when the occupant is valid and equal. So complete/paginated discovery
is mandatory before Phase 3 wires user-visible publication and before any
consumer emits a freshness/coverage verdict — and it is *not* the atomic
publication fence.

Classification is explicitly a **join** between the filesystem discovery
basename and the package's **verified identity** — not a manifest-only
derivation, and not a filename parse. After package verification:

```text
legacyExpected     = verifiedManifest.chatId + ".h2ochat"
generationExpected = verifiedManifest.chatId + ".g"
                     + lowercase64hex(recomputedContentHash) + ".h2ochat"
```

`recomputedContentHash` is the value the verifier **recomputes** from the
package's own bytes under §L, never the raw `manifest.contentHash` string as
written. (For a package that passes verification the two agree by definition —
`content-hash-mismatch` is a blocker — so this tightening changes no outcome
for valid packages; it removes any path where an unverified claimed hash could
steer classification.)

Classification is exact basename equality:

| Condition | Classification |
| --- | --- |
| `basename == generationExpected` | canonical immutable generation |
| `basename == legacyExpected` | grandfathered legacy package |
| otherwise | `package-name-identity-mismatch` |

- Generation identity is **never parsed from the filename first**. A
  legitimate legacy chatId that literally ends in `.g<64hex>` classifies as
  LEGACY, because its basename equals `legacyExpected` and can never equal
  `generationExpected` (which appends a further `.g<hex64>` suffix).
- `package-name-identity-mismatch` packages are excluded from automatic
  selection and surfaced as diagnostics; they remain openable by explicit
  path.
- **Reader supersession.** This classification **replaces** the existing
  per-package blocker `package-dirname-chat-id-mismatch`
  (`saved-chat-archive-diagnostics.tauri.js:1242`, which requires
  `basename == chatId + '.h2ochat'` and therefore blocks every generation
  name). That replacement is a governed **reader change**, implemented in
  Phase 2 diagnostics convergence, and it is a sequencing prerequisite: until
  it lands, the pre-M05 verifier cannot classify any generation as VALID, so
  publication wiring (Phase 3) must not precede it.
- Identity resolution for classification uses **exactly the chatId the
  governed verifier already resolves** — `manifest.chatId`, falling back to
  the verified `snapshot.chatId` when the manifest omits it, as the reader
  does at HEAD. This deliberately preserves an existing behavior: a package
  whose manifest lacks `chatId` but whose verified snapshot supplies it
  classifies today and must keep classifying, or M05 would silently strip it
  of PRESERVED/COVERED status — a reader-side compatibility reduction. Only
  when **neither** source yields a chatId is the package unclassifiable, and
  such a package is already blocked by existing verification. The
  `contentHash` half of the join is never subject to any fallback: it is
  always the recomputed value.
- The shallow inventory tier (which already parses each manifest) may emit the
  same classification **provisionally** for display; selection, freshness and
  coverage require the fully verified classification.

## E. Validity, freshness, preservation, coverage

| Term | Definition |
| --- | --- |
| GENERATION | One immutable package at a generation-classified path. |
| VALID | The governed verification pass fully passes for that package — the **existing** reader contract, amended by §D's name classification and by nothing else. M05 adds no reader-side check: §S's commit-gate obligations govern what may be newly *published*, never what counts as valid on read. |
| CURRENT DESKTOP PROJECTION | `{contentHash, snapshotId, assetShas}` computed from the canonical current Desktop snapshot by a pure probe that shares the writer's own projection/identity math and mutates nothing. Requires the SQLite backend to be ready; otherwise INDETERMINATE. |
| FRESH | A VALID package (generation or legacy) whose `contentHash` equals the current projection's `contentHash`. |
| STALE | A VALID package that is not FRESH (see §F for the two kinds). |
| PRESERVED | The chat has ≥ 1 VALID package of any age. |
| COVERED | The chat has ≥ 1 FRESH package. |

Positive freshness requires logical equality of `contentHash` values and
nothing else. **No timestamp — filesystem, manifest, queue, or wall clock —
ever positively establishes freshness.** Timestamps are diagnostics and
context only.

Deterministic selection: a FRESH generation is preferred; else a FRESH legacy;
else there is no fresh package and consumers present the stale set (§G).
Corrupt, partial, mismatched and unclassifiable packages are excluded from
automatic selection and surfaced. When the projection is INDETERMINATE
(store unavailable) or UNDEFINED (no current snapshot), packages remain
PRESERVED, freshness is not asserted either way, and no refresh proceeds.

## F. Content-stale vs format-stale

- **content-stale**: VALID, same contentHash construction version as the live
  writer, hash differs — the archived content genuinely differs from the
  current projection.
- **format-stale**: VALID, but its payload version's contentHash construction
  differs from the live writer's (e.g. v1/v2 packages after a future live v3
  activation). Format-stale is recorded distinctly so a future format
  transition is legible as such and is never treated as content obsolescence
  (in particular by any future GC authority).

## G. BEST-HISTORICAL

Among VALID packages of a chat with no FRESH package, consumers may present a
BEST-HISTORICAL candidate: the highest verified `snapshot.savedAt` — a hashed
content field inside the verified snapshot, not filesystem metadata — with
ties (including empty `savedAt`) presented **as ties** in lexicographic
contentHash-hex display order. BEST-HISTORICAL is presentation only. It is
never freshness authority, never an automatic input to any destructive or
recovery action, and is always labeled as historical.

## H. No mutable current pointer

No `current.json`, no symlink, no `latest` alias, no mutable package pointer,
no second authoritative store of "which package is current". Currentness is
derived per view from verification plus the current projection.

## I. No persistent archive index initially

Discovery remains filesystem scanning plus manifest reads. No
`archive_package_index` table or equivalent persistent mutable index is
introduced for generation discovery. Any future index must be derived and
rebuildable, never preservation authority, and must earn its way in with
measured evidence.

## J. Live v1/v2 required persistent members

A live v1/v2 persistent package requires exactly:

```text
manifest.json
snapshot.json
chat.md
chat.html
```

plus governed `assets/` member copies when the manifest declares assets. All
four are staged members under §N (`manifest` included), and all four are
verified through the same descriptor-relative path.
Live v3 remains OFF; M05 publication does not use the v3 two-member durable
form. The staged publication commit gate (§S) admits payload versions 1 and 2
only.

## K. chat.md / chat.html presentation-member status

`chat.md` and `chat.html` are **required v1/v2 persistent presentation
members**: deterministic renderings of the snapshot. They carry governed
`manifest.files` descriptors (`markdown`, `html` keys) whose `sha256` and
`byteLength` the trusted commit gate re-verifies against the staged bytes.
They are **not** package identity authority (§L). Their sizes are linear in
snapshot content with small constants (see the T1.2.3 evidence).

## L. v1/v2 contentHash semantics — unchanged, byte-exact

```text
v1: contentHash = files.snapshot.sha256          (physical snapshot.json SHA-256)
v2: contentHash = sha256(canonicalJson({
      snapshot: <files.snapshot.sha256>,
      assets:   [ ...cleaned manifest asset sha256 strings, sorted ]
    }))
```

Byte-exactness requirements frozen for the trusted derivation (each is pinned
by a cross-language test vector in T1.2.2):

- `canonicalJson` sorts keys before insertion and emits compact JSON. For the
  v2 pre-image specifically — whose only two property names, `assets` and
  `snapshot`, are non-integer ASCII — that yields exactly
  `{"assets":[…],"snapshot":"sha256-…"}`. This is a claim about **this
  descriptor**, not a general property of the function: §T records why
  key-sorted insertion does *not* imply lexicographic emission in general, and
  nothing in M05 may generalize from this bullet;
- the hash construction does **not** deduplicate asset sha strings (it hashes
  the list it is given; historical duplicate-bearing manifests verify by this
  same math on read — the commit gate separately refuses to *newly publish*
  duplicates, §S);
- the sorted values are the **raw cleaned** `sha256-`-prefixed strings (no
  normalization pass);
- the sort is plain lexicographic order over the full prefixed strings. JS
  `.sort()` compares UTF-16 code units and Rust compares UTF-8 bytes; the two
  coincide exactly because the gate has already validated every value against
  the ASCII sha grammar (`sha256-` + 64 lowercase hex) before hashing — this
  ASCII premise is part of the frozen claim.

`chat.md` / `chat.html` do **not** participate in contentHash under any
version. M05 does not redefine v1/v2 identity in any way.

## M. Create-only publication

- Target generation absent → create.
- Exact target occupied by a VALID package with the same derived contentHash →
  idempotent dedupe success (no write).
- Older valid generations are never touched.
- A corrupt or partial occupant is **never** silently overwritten; publication
  refuses and surfaces it (§P cases C/D).
- There is no overwrite, force, delete, or rename parameter anywhere in the
  publication surface.

## N. Staged trusted publication protocol

Publication is a purpose-bounded, Rust-owned staged protocol (module of its
own; the PRE-M05 CAS-scoped durable-write command is not widened). Exact
command names are implementation detail; the semantic protocol is:

```text
BEGIN {chatId}                    → {token}     (plain-argument command)
WRITE MEMBER {token, member}      + bounded raw chunk       (repeatable: §Q)
  member ∈ { snapshot, markdown, html, manifest }  — enum only, fixed filenames
COMMIT {token, expectedManifestSha256?}         (plain-argument command)
ABORT {token}                                   (plain-argument command)
```

**`manifest` is a staged member like every other member** (Reconciliation R1).
COMMIT carries **no large body**. This is load-bearing for three reasons:

- v1/v2 has no semantic manifest size ceiling today, so a one-shot COMMIT body
  with an allocation cap would have created a **new product boundary** — the
  exact thing §"Member bounds" forbids;
- the framework materializes an invoke body *before* the command runs
  (verified: `wry` `url_scheme_handler` → `tauri::ipc::protocol`), so a
  command-side length check could not have provided the pre-allocation
  admission it appeared to promise;
- an out-of-band manifest body would have given `manifest.json` a **different
  verification path** from every other governed member. Staging it means it is
  read back through the same descriptor-relative, `O_NOFOLLOW`, opened-fd
  path as the rest.

`expectedManifestSha256`, if retained, is assertion-only (§U).

Manifest remains the **final logically completed member before promotion** —
but that is a property of the *promotion boundary*, not an ordering rule on
the caller. §Q permits appends to different members to interleave freely and
provides no per-member seal before COMMIT, so the trusted side cannot observe
staging order and this contract does not pretend to constrain it. What is
actually enforced: COMMIT refuses if the manifest member is absent, and no
final generation exists until the exclusive promotion — so no observer can
ever see a published package whose manifest is missing or unverified. The
manifest-last completeness invariant is carried by the atomic promotion, not
by staging sequence.

COMMIT, in order: consume the session (§Q) → **enumerate the staging directory
and refuse any entry the session did not create** → read and validate the
staged manifest and version triple (§V) → cross-check the staged snapshot (§S)
→ re-hash every staged member against its `manifest.files` descriptor →
validate every asset descriptor and copy asset bytes from the canonical CAS
with streaming re-verification (§W) → derive `contentHash` internally and
require the manifest to agree (§T) → durability fences (F_FULLFSYNC members,
staging dir fsync) → derive the final generation name internally → exclusive
promotion → **if occupied, classify the occupant trusted-side (§N.2) → clean
only this attempt's staging** → parent directory fsync (on both the promoted
and the occupied path) → honest report `{ok, committed, durabilityComplete,
generationPath, contentHash, outcome, blockers[]}`.

That four-step tail — **classify → clean own staging → parent fsync →
report** — is the single frozen ordering for the occupied path; §N.2 restates
it verbatim and no other sequence is authoritative. Cleaning before the fence
is deliberate: staging lives inside the promotion parent, so a staging removal
left unfsynced could resurrect as residue after power loss.

Every member read at COMMIT is read **from the retained staging descriptor**,
opened once per member, and hashed from that single handle — never by
re-resolving a path. That closes substitution, unexpected entries and path
re-resolution. It does **not** close post-hash in-place mutation through a
separately held writable handle; §R.1's dot-leading scope exclusion is what
closes that, and it is a required pre-cutover invariant rather than a
property of this ordering.

**Promotion is the commit point, and the durability fence cannot retract it.**
Once exclusive promotion succeeds, the generation exists in the final
namespace, so the result reports `committed: true` — unconditionally, and
including when the subsequent parent-directory fsync returns an error. That
case reports `committed: true` with `durabilityComplete: false` plus the fence
blocker: the generation is real but not yet proven durable, which is the honest
description and the only one a consumer can act on correctly. A successful
promotion also transfers the staged tree out of §X's cleanup scope — a fence
failure must **never** trigger cleanup, because the tree is no longer staging,
it is the published generation. Reporting such a promotion as uncommitted, or
as durable, are both forbidden. (§P case H covers the adjacent *crash* timing;
this rule covers the fence returning an error.)

COMMIT re-hashes **every member required by the declared version (§J) and
every member actually staged**; a required member that was never staged, or a
staged entry the session did not create, is a refusal — the quantifier is the
version's required set, not merely "what was written".

The load-bearing crash-safety mechanism for staged publication is the atomic
exclusive promotion — a final-name directory never exists without its complete
verified manifest. **Proof obligation (T1.2.2):** the existing trusted module
promotes only *regular files*; no test covers promoting a populated
*directory*, and the non-macOS `linkat` fallback **cannot** hard-link a
directory. Phase 1 must prove directory promotion on the supported platform
and keep the non-macOS arm fail-closed; `promote_exclusive` must never be
read as portable for directories. Refusals are returned as
`ok:false` results with blocker codes (they resolve; they do not throw).
Every caller must treat any result without a trusted success `outcome` as
failure. The caller never adjudicates an occupied destination: `deduped` is a
**trusted-side verdict** returned by COMMIT itself (§N.2), never a conclusion
the renderer reaches by inspecting the occupant.

**Platform arms, stated precisely** (the distinction is load-bearing for the
proof obligation above; corrected by T02 of the cross-platform filesystem
safety Mission, see `saved-chat-filesystem-safety.md`): the trusted module has
**per-platform arms in the primitive layer, not module-level platform gates**.
Create-only directory promotion is `renameatx_np(RENAME_EXCL)` on macOS,
`renameat2(RENAME_NOREPLACE)` on Linux and a handle-bound
`ReplaceIfExists = FALSE` rename of the retained staging directory handle on
Windows; a plain replacing `renameat` is never used for it anywhere. A target
without a compiled arm compiles and fails closed at runtime
(`generation-unsupported-platform`); a root whose filesystem has not
behaviourally proven exclusive creation, the no-replace rename and the
namespace fence refuses at BEGIN, before any staging exists
(`generation-capability-unproven`). On macOS and Linux the rename is
pathname-bound, so the retained staging descriptor is re-identified under the
final name after the rename and a divergence is reported as
`generation-publication-identity-mismatch`, never as `Created`. Publishing
never silently degrades on a platform or filesystem where the promotion
primitive cannot express create-only directory promotion.

**Reading `full_fsync`.** Result schemas carry the boolean `full_fsync`
meaning exactly "the macOS `F_FULLFSYNC` media fence succeeded". On Linux
(`fsync`, documented to flush a disk cache when present) and Windows
(`FlushFileBuffers` through the retained write handle, which synchronizes the
storage cache) it is `false` while the platform's documented fence WAS issued.
Consumers must never read `full_fsync:false` as "not durable"; the durability
claim is carried by `committed` / `durabilityComplete`.

### N.2 Occupied-destination classification is trusted-side

When exclusive promotion reports that the final generation path already exists,
**the trusted COMMIT operation itself classifies the occupant before returning
any success-equivalent result.** Delegating that judgement to the renderer
would be a trust inversion: the renderer would decide "is this occupied package
valid and identical to mine?", which is precisely the question the trusted side
exists to answer.

Trusted-side occupied flow:

```text
derive target from staged, verified identity
→ exclusive promotion reports occupied
→ open the occupant DESCRIPTOR-RELATIVELY (O_NOFOLLOW)
→ reject symlink / wrong shape / foreign entries
→ verify the required members are present
→ re-hash member bytes
→ re-derive contentHash
→ classify
→ clean only this attempt's staging
→ parent-directory fsync
→ report
```

The last three steps are §N's frozen tail, reproduced here so the two sections
cannot drift: **classify → clean own staging → parent-directory fsync →
report**. A fence failure on this path returns the classified occupant outcome
**plus** the fence blocker; it never suppresses or downgrades the occupant
verdict, and it never converts a `DEDUPED` into a failure.

Trusted outcomes (names refinable during implementation):

| Outcome | Meaning |
| --- | --- |
| `DEDUPED` | Occupant is valid **and** carries the same verified/recomputed content identity |
| `GENERATION_DESTINATION_CORRUPT` | Occupant present, verification fails |
| `GENERATION_PARTIAL` | Occupant incomplete (e.g. no manifest) |
| `GENERATION_DESTINATION_FOREIGN` | Occupant valid but a different identity |
| `GENERATION_OCCUPANT_UNREADABLE` | Occupant cannot be read/classified |

`outcome` is the **sole success discriminator**: `DEDUPED` carries
`ok: true`, and `committed` reports whether **this attempt** promoted — so
`committed: false` for `DEDUPED`, which is a success that deliberately wrote
nothing. (Do not infer "blockers empty on success": a fence failure can
accompany a success outcome, per §X.)

**Only** a valid occupant with the same verified identity may become
`deduped`. Every other outcome is a failure result carrying its blocker.

Cleanup ordering for the losing writer: **verify the occupant → clean only
this attempt's staging → return the trusted result.** The occupant is never
overwritten, never replaced, and never deleted — create-only is unconditional
here, including when the occupant is corrupt (§P case C's operator escape
hatch remains the only remedy).

### N.1 Package construction is not final-path authority

Verified at HEAD: the JS builder hard-codes `packageDirName = chatId +
".h2ochat"` and throws if a caller supplies any other value; the live writer
writes `manifest.json` **first**, before snapshot and renderers.

Neither fact contradicts immutable generations, because M05 draws the boundary
differently:

> **PACKAGE CONSTRUCTION ≠ FINAL PUBLICATION PATH AUTHORITY.**

The JS builder may continue constructing logical package bytes and the
manifest. What ceases is its `packageDirName` / `packagePath` outputs being
*publication authority* — the trusted publisher derives the final generation
path from its own digest (§T), and the renderer supplies only `chatId` (§O).
Phase 1 must remove or isolate every assumption that a built package's
`packageDirName` names the final archive destination, and must sequence the
retirement or isolation of the **manifest-first legacy publication path** so
it cannot remain the live path after cutover (a G1 prerequisite). Existing
grandfathered packages are never rewritten (§C).

Two verified implementation notes for that refactor: the builder is **not**
side-effect-free — it materializes assets into the CAS (writing CAS blobs and
DB rows) *before* any package bytes exist, and its `packageDirName` check
fires after that, so clean build/publish separation requires hoisting or
opting out of materialization; and the materializer consumes only a small
result contract (`packagePath`, `schemaVersion`, `payloadVersion`,
`contentHash`, `snapshotId`, `writtenAt`), which the staged publisher can
satisfy directly.

## O. Renderer authority exclusions

The trusted side re-validates the renderer-supplied `chatId` against the §B
charset and shape rules at BEGIN, before any path construction; the renderer's
string is an input to validation, never a path fragment taken on trust.

The renderer never supplies:

- the final generation destination or any part of it beyond `chatId`;
- any member path or filename (member enum only; fixed name map);
- any package path;
- any CAS source path (asset bytes are located by the trusted side from
  verified manifest sha identities and never cross IPC);
- an authoritative contentHash (§U).

## P. Complete case model

| Case | Behavior |
| --- | --- |
| A. target absent | Stage, verify, promote; report `created`. |
| B. exact VALID occupant, same derived contentHash | Trusted side classifies the occupant (§N.2) and returns `DEDUPED` — idempotent success decided in the trust domain, not by the caller. |
| C. corrupt occupant at target | Trusted classification returns `GENERATION_DESTINATION_CORRUPT`; never overwritten. Documented escape hatch: explicit manual operator removal, with diagnostics printing the exact path. |
| D. partial (manifest-less) occupant at target | Trusted classification returns `GENERATION_PARTIAL`. Staged publication cannot create new partial final names. |
| E. two writers race for the same generation | Exclusive promotion admits one; the loser's own COMMIT classifies the occupant (§N.2) and returns `DEDUPED` or the appropriate failure outcome, after cleaning only its own staging. |
| F. two writers create different generations for one chat | Both succeed under different names; freshness selects. |
| G. crash before manifest / before promotion | Residue only under the reserved staging prefix; the final namespace is untouched. |
| H. crash after promotion, before the parent fence | The generation may vanish wholly after power loss — never partially. Reported honestly: `durabilityComplete` is true only after the parent fence returns. |
| I. target occupied by a VALID package with a **different** identity | Trusted classification returns `GENERATION_DESTINATION_FOREIGN` (reachable via the `X.g<64hex>`-literal-chatId legacy collision, or manual manipulation); never overwritten; the operator escape hatch of case C applies. |
| J. occupant cannot be read or classified | Trusted classification returns `GENERATION_OCCUPANT_UNREADABLE`; treated as failure, never as dedupe. |

## Q. Token / session concurrency semantics

Session concurrency is **normative**, not an implementation detail. The
consume-before-I/O rule alone is not sufficient: WRITE MEMBER, ABORT and idle
eviction each need an explicit contract, and holding one global map lock across
multi-MiB filesystem I/O is the wrong shape.

**Structure.** A synchronized session map plus a **per-session operation
guard** (an active lease / mutex). The map lock is held only for map
operations; member I/O runs under the session's own guard, never under the
global lock.

**State model** (conceptual; exact spelling is implementation detail):

```text
OPEN → BUSY/ACTIVE → COMMITTING → CONSUMED
  ↘ TERMINATING ↗
```

**Normative properties:**

1. global session-map operations are synchronized;
2. every session carries a per-session operation guard / active lease;
3. WRITE obtains its lease **before** operating on staging;
4. an in-flight operation is **never** considered idle;
5. idle time is refreshed on operation **entry** (not exit), so a long write
   cannot age into eviction while running;
6. COMMIT obtains exclusive ownership and removes/consumes the session from the
   map **before** any publication work;
7. `COMMITTING` and `CONSUMED` sessions are unreachable by eviction (they are
   not in the map) and release their **admission slot** only when COMMIT
   returns;
8. ABORT and eviction may **not** delete staging beneath an active WRITE;
9. whoever successfully obtains the exclusive removal/termination claim **owns
   the cleanup** — exactly one owner, never two;
10. if termination is requested while active work exists, the session enters
    `TERMINATING` and cleanup runs only **after the final active operation
    leaves**;
11. session identity/token is never recycled beneath an in-flight operation.

**Acceptance invariant:** *an in-flight operation must never have its staging
directory cleaned, nor its session identity reused, beneath it.*

- Member writes are **append-only ordered sequences**: a member may be
  delivered in one call (the common, KB-scale case) or as multiple bounded
  append calls (§"Member bounds"). Rewrites and seeks are refused; append calls
  for **different** members may interleave freely; the at-most-once invariant
  applies to the member's append stream as a whole. There is no explicit seal
  call: a member is sealed by COMMIT, whose verification re-hash of the final
  staged bytes is the seal. Chunked delivery is the T1.2.3-resolved
  generalization that prevents the transport from defining package semantics
  (Amendment A2).
- ABORT of an unknown or already-consumed token is a **benign no-op** (a
  `finally { abort }` caller shape must be harmless after a successful
  commit); ABORT of a session with active work marks it `TERMINATING` and
  defers cleanup to property 10.
- Sessions are bounded in number; when the cap is reached, BEGIN **refuses
  with a blocker** (`generation-staging-sessions-exhausted`) — it never
  implicitly evicts a live session. A session removed from the map by COMMIT
  (property 6) **continues to occupy an admission slot**, tracked by a counter
  separate from the map, until COMMIT returns; BEGIN may be refused on that
  count. Without this the cap would bound only sessions idling between BEGIN
  and COMMIT, leaving the expensive phase — streamed CAS copies, member
  re-hash, the staged byte tree — running in no slot at all and making §R.2's
  required "bounded number of simultaneous sessions" vacuous. The slot must
  **not** be implemented by leaving the session in the map: that would relax
  property 6 and reopen the eviction-safety argument below. This bounds
  concurrent operations, never bytes — a large valid package still publishes.
- Sessions carry an **idle timeout** measured from the last operation entry (an
  implementation-level operational constant, not a product value). Eviction is
  **lazy**: it runs under the BEGIN path (claim terminable sessions, then
  refuse if still full). No timer thread, no heartbeats, no cross-process
  leases.
- **Eviction is integrity-neutral** because of properties 4, 7 and 8 together:
  a committing session is not in the map, and an actively writing session is
  not idle and cannot have its staging removed beneath it. The only evictable
  session is one idle between operations, whose worst case is a refused later
  append — an availability loss, never a corrupt or partial package. **This is
  a stated precondition:** if COMMIT ordering or the lease discipline is ever
  relaxed, this decision reopens.
- A session abandoned between BEGIN and COMMIT is cleaned by this eviction
  path (§X governs post-consumption refusals; §Q eviction governs
  abandonment) — subject to the residue caveat in §X.

## R. Staging location, prefix, discovery filtering

Staging directories live **inside** `archive/packages/` under the reserved
prefix:

```text
archive/packages/.h2o-genstage-<token>/
```

- Same directory as promotion targets → exclusive promotion needs no
  cross-directory primitive and stays atomic.
- **The trusted staged publisher creates `archive/` and `archive/packages/`
  itself**, descriptor-relatively, pairing each `mkdir` with an `O_NOFOLLOW`
  open on that component, before creating the staging directory. This must be
  stated because the only thing that creates `archive/packages/` today is the
  renderer's recursive `mkdir` on the legacy write path, which G1 retires —
  and the existing trusted CAS command cannot be the successor, since its
  destination validation admits only canonical CAS blob paths. Post-cutover,
  **nothing renderer-side creates any archive directory.**
- **Build requirement, not an existing fact:** the trusted path-component
  validation today reserves only the PRE-M05 temp prefix. Phase 1 must extend
  it to a **shared reserved-prefix list** covering the staging prefix, kept
  separate from the temp-name *generator*. Until that lands, the reservation
  does not exist.
- JS discovery/inventory filtering excludes the prefix. The existing
  inventory's `.h2ochat` suffix filter already skips such entries; its
  `archive-entry-not-package` warning is the residue signal.
- **The token is not a security boundary.** It is an opaque, high-entropy,
  single-use *session identifier* whose only job is confusion resistance; it
  may be observable, and observing it grants nothing. The trusted Rust
  descriptor is the authority.

### R.1 Staging-integrity invariant (required pre-cutover)

**Commit-time hashing alone does not make renderer interference harmless, and
this contract must not claim it does.** A staged file's inode can be verified,
then mutated in place through a *separately held writable handle*, and then
carried into the published generation by the directory rename — inode identity
never changes, so no re-open, no re-hash and no descriptor discipline detects
it. Retained descriptors plus commit-time re-read/re-hash close **substitution,
unexpected entries and path re-resolution**; they do **not** close post-hash
in-place mutation.

What actually closes it, on the supported Unix/macOS configuration at current
authority, is that the renderer has no authority to open a staging member for
writing at all:

- staging **MUST** live under a **literal dot-leading** reserved directory
  component (`archive/packages/.h2o-genstage-<opaque>`);
- the pinned glob matcher applies `require_literal_leading_dot`, so the broad
  `archive/**` renderer grant does **not** confer `write_file`, `open`,
  `mkdir` or `read_file` authority through that dot-leading component;
- this scope exclusion is therefore a **REQUIRED pre-cutover integrity
  invariant** — load-bearing, not token secrecy and not optional hardening;
- staging directory *names* may still be visible through a parent `read_dir`.
  Visibility is not authority.

Implementation and test obligations (T1.2.2):

1. the staging prefix begins with a literal `.`;
2. no fs-plugin configuration may disable `require_literal_leading_dot` while
   this pre-cutover assumption is load-bearing — a committed test pins that
   the app ships no such override;
3. a committed test proves the renderer cannot enter the dot-leading staging
   namespace via `write_file`, open-for-write, `mkdir`, or `read_file`;
4. a committed test may assert that parent `read_dir` *can* list staging names,
   recording that visibility is deliberate and harmless.

**Lifecycle of this dependency — it is not eternal.** The glob exclusion is the
load-bearing protection only *until* the G1 capability cutover removes renderer
`fs:allow-write-file` and `fs:allow-mkdir` over the archive root entirely. After
that cutover the renderer holds **no** archive mutation authority at all, and
that removal is the primary protection; the dot-leading rule remains as defense
in depth and as namespace reservation. Neither mechanism is described here as
the eternal sole security boundary, and the ordering matters: the dot-leading
invariant must hold **before** the cutover, because until the cutover the broad
grant exists.
- Crash residue is bounded per run by the session cap (which, per §Q, counts
  in-flight commits), is honestly unbounded across repeated crash cycles, and is reclaimed only by a future explicitly
  authorized janitor — never automatically in M05 (see "Carried risks").

### R.2 Environmental resource refusal ≠ package size limit

The trusted publisher must fail **safely** when the local machine runs out of
room. That necessity must never be laundered into a package-size ceiling, so
this contract freezes the distinction:

**A — package semantic limits (forbidden here).** No fixed maximum complete
snapshot, markdown, html or manifest size for v1/v2; no fixed maximum total
package size; no fixed maximum aggregate asset bytes; no fixed per-session
total staged-byte ceiling that an otherwise valid package can never exceed; no
fixed process-wide staged-byte ceiling that makes one sufficiently large — but
valid — package permanently impossible on an otherwise healthy machine. Each
would be a semantic ceiling in practice, whatever it is called.

**B — environmental / retryable resource refusals (required).** Machine-local
conditions: insufficient filesystem free space, quota exhaustion, `ENOSPC`,
`EDQUOT`, integer/offset overflow, inability to maintain a configured local
safety reserve, and temporary concurrency/backpressure pressure. These:

- are **machine-local and retryable** — the same package may publish
  successfully on the same machine later, or on another machine, with no
  change to its bytes;
- **never** mark the package structurally invalid and **never** redefine v1/v2
  validity;
- use a distinct `generation-staging-resource-*` blocker family, kept separate
  from every validity blocker so no consumer can confuse the two;
- trigger cleanup by the owner defined in §X — the operation itself when the
  refusal happens before consumption (BEGIN or WRITE), §X's post-consumption
  rule after.

Resource-accounting requirements: `u64` / checked arithmetic for all byte and
offset accounting; a bounded number of simultaneous sessions **counting
in-flight COMMITs** (§Q); bounded
in-memory and current-chunk buffering; a filesystem free-space / reserve check
before extending staged files where that is technically reliable; OS `ENOSPC`
and `EDQUOT` mapped onto the environmental-resource outcome rather than a
validity blocker; and backpressure permitted to refuse a *new* operation
temporarily.

Any concrete free-space reserve value is derived from engineering and resource
evidence and recorded as **operational safety policy, not package validity**.
If implementation later proves a fixed *total* staged threshold technically
unavoidable, and that threshold could reject a valid v1/v2 package on a healthy
machine, it stops being environmental and becomes semantic: raise a Human
Decision Point **before** enforcing it.

## S. Commit gate ⊇ governed verifier

Standing invariant, **scoped honestly**: the commit gate's refusal set is a
superset of the governed v1/v2 verifier's blocker set for published packages,
as that verifier stands after the §D reader supersession, **except for the
`RESIDUAL` class defined below**.

The exception exists because of a fact verified at HEAD: a **sanctioned-writer
package can already trip some verifier blockers today**. The materializer
supports only `png|jpe?g|gif|webp` and deliberately leaves any other
`data:image/…` URI inline; and a chat *title* containing the literal text
`data:image/` passes through `escapeHtml` into `chat.html`. Either case makes
the substring test behind `data-image-residue-v2` match. Such a package
publishes successfully today and merely *verifies as blocked*.

Turning those blockers into publication refusals would therefore **newly fail
a user's save on real content** — a class-C new package-validity rule, which
R11 forbids adopting silently. So:

- **`RESIDUAL` blockers** — `data-image-residue-v2`,
  `renderer-asset-ref-not-in-manifest`, `renderer-asset-ref-missing-file`,
  `renderer-asset-ref-exists-check-failed` — are **NOT** enforced by the
  commit gate. M05 neither creates nor repairs this pre-existing condition:
  the package publishes, and the verifier reports what it reports, exactly as
  today. No `chat.md` scan, no image-source policy, and no sanitized-marker
  requirement is added (each verified class C or value-free class B).
- Making any RESIDUAL blocker a publication refusal requires
  `DP-M05-RESIDUE-REFUSAL` with reachability evidence from real captures.

Every **non-RESIDUAL** v1/v2 blocker must be unreachable for a committed
generation. That includes, at minimum:

- manifest envelope validity: parseable JSON, `schema ==
  "h2o.savedChatPackage"`, coherent version triple (§V), required-member
  completeness (§J);
- `manifest.files` descriptor equality (key-matched `snapshot` / `markdown` /
  `html`; re-hashed sha256 + byteLength);
- staged-snapshot cross-checks via bounded streaming field extraction:
  `snapshot.chatId == manifest.chatId == BEGIN chatId`,
  `snapshot.snapshotId == manifest.snapshotId`, and snapshot asset references
  ⊆ manifest assets;
- full reader-contract asset descriptor validation: package path exactly
  `assets/<sha256-…>.<ext>`, non-empty `ext` equal to the path's extension,
  non-empty `mimeType`, finite `byteLength`; descriptor identity verified
  against actual CAS bytes during copy;
- **descriptor uniqueness**: no two descriptors may share a `path` **or** a
  `sha256`. The sanctioned writer already produces unique-by-sha descriptor
  sets by construction (`manifestAssets = Object.keys(manifestBySha)`,
  `saved-chat-package-assets.tauri.js:391`), so this refuses nothing the
  live writer can produce; the reader continues to accept historical
  duplicate-bearing packages (its duplicate check stays a warning). This
  rule is also the technical bound that caps trusted-side copy amplification
  (see the T1.2.3 evidence §4.5);
- internally derived contentHash equality (§T);
- the staging directory containing **no entry the session did not create**
  (checked at commit via directory enumeration of the staging handle).

T1.2.2 carries the **complete enumerated v1/v2 blocker list** as its test
input — not a paraphrase. Beyond the codes named above it must include, at
least: `package-path-required`, `package-path-out-of-scope`,
`manifest-json-invalid`, `snapshot-json-invalid`, `manifest-schema-invalid`,
`manifest-schema-version-invalid`, `manifest-payload-version-invalid`,
`manifest-missing`, `snapshot-missing`, `markdown-missing`, `html-missing`,
`chat-html-unreadable`, `chat-id-mismatch`, `snapshot-id-mismatch`,
`snapshot-sha-mismatch`, `content-hash-mismatch`, `package-validation-failed`,
the eight `manifest-asset-*` descriptor codes, the five
`package-asset-*` codes, `snapshot-asset-ref-invalid`, and
`snapshot-asset-ref-missing-manifest`. Each is proven unreachable for a
committed generation, or explicitly listed as RESIDUAL with its justification.

## T. Trusted derivation of contentHash and destination

Rust derives the package `contentHash` itself from the staged bytes and the
manifest's asset list, using the frozen §L constructions, and the final
generation name derives from Rust's **own** digest. The manifest's
`contentHash` must equal the derived value or commit refuses. The caller can
never name a destination, directly or through a hash parameter.

**M05 owns no general-purpose JSON canonicalizer, and must never acquire one.**
The JS `canonicalJson` is *not* generically portable: it sorts keys, inserts
into an ordinary object, and calls `JSON.stringify` — but JavaScript emits
integer-index-like property names in ascending numeric order *first*,
regardless of insertion order, so the result is not lexicographic for objects
with keys like `"2"` / `"10"`. Arbitrary keys are reachable in projected
snapshot metadata, so a generic port would be a live hazard. The frozen rules
are deliberately narrow:

- **v1** — Rust derives identity as SHA-256 over the **exact staged
  `snapshot.json` bytes**. There is no Rust-side snapshot recanonicalization
  of any kind.
- **v2** — Rust builds only the historical two-key descriptor
  `{"assets":[…],"snapshot":"…"}`. Both property names are non-integer ASCII,
  so JS and serde emission order provably coincide. The `assets` values are
  the **raw cleaned descriptor `sha256` strings exactly as written in the
  manifest** (per §L) — never a normalized form; normalization exists only to
  locate CAS objects, and §S's grammar validation makes raw and normalized
  coincide for every publishable manifest.

**Permanent boundary tripwires (T1.2.2):** tests asserting (i) the
integer-like-key divergence is understood and never relied upon, (ii)
integer-like keys reachable in `message.metadata` do not affect archive
publication, and (iii) a **negative control** proving archive generation
identity does not reuse any unrelated Rust transport/sync canonicalization —
specifically `sorted_json_value`, generic `String::cmp` object key sorting, or
a `sha256:` colon-prefixed identity form. Substituting any of them must fail a
committed test rather than silently changing published identity. These are boundary tests; they do not require Rust to
reproduce generic JS projection canonicalization.

## U. Caller assertions are assertion-only

`expectedManifestSha256`, when supplied at COMMIT, is compared to the digest
of the staged manifest member and can only cause a refusal
(`generation-expected-hash-mismatch`). It never selects, overrides, or names
anything. The same rule governs any future assertion parameter: an assertion
may refuse a publication, never steer one.

## V. Coherent version triples

| Version | Required triple |
| --- | --- |
| v1 | `schemaVersion: 1`, **no** `payloadVersion` key, `assets` empty |
| v2 | `schemaVersion: 2`, `payloadVersion: 2`, `assets` non-empty |

Anything else — including hybrids such as `schemaVersion: 1` with
`payloadVersion: 2`, and any `schemaVersion: 3` manifest — is refused at
commit.

**Classification of the `assets` cardinality conditions** (they are commit-gate
rules with no verifier blocker behind them, so they need the same A/B/C
treatment as every other invariant): both are **class B —
writer-conformance**, enforced on new publications only. Proof: the writer
computes its manifest asset list as `isV2 ? materializedAssets : []`, and the
v2 branch is selected precisely when the materializer reports it extracted at
least one asset — so a sanctioned v1 manifest always has an empty list and a
sanctioned v2 manifest always has a non-empty one. Neither condition can
refuse writer-producible output. The **reader is untouched**: an existing v1
package with non-empty assets remains valid (it is a warning at HEAD, and
stays one), so no historical or imported package is invalidated. v3 publication is not admitted by M05; admitting it later is a live-v3
activation decision, not a gate relaxation.

## W. Assets copied from canonical CAS by trusted code

Package asset member bytes never cross IPC at publication. For each validated
descriptor, the trusted side locates the canonical CAS object from the sha
identity (`archive/assets/<aa>/sha256-<hex>`), streams it into the staging
`assets/` member with incremental SHA-256, and requires the digest and length
to equal the descriptor's. A missing or mismatched CAS object refuses the
commit. Per DP-PRE-M05-ASSET-BOUND's compatibility rule, no ingest bound is
applied at copy time: a historical oversized CAS object remains packageable.

## X. Cleanup semantics (Supervisor Amendment A1)

Rule: once COMMIT has consumed the session, **every path that returns without
a successful promotion cleans its own staging before returning** — tracked
member files, the staged `assets/` contents it created, and the staging
directory itself. Successful promotion is the only outcome that transfers the
staged tree out of cleanup scope (it becomes the published generation).

**Symmetrically, any operation that creates staging owns its removal on its own
refusal path** — including a BEGIN that creates
`archive/packages/.h2o-genstage-<token>/` and then refuses (a staging-dir
fsync error, descriptor exhaustion, a §R.2 resource refusal). It removes only
the directory it created in that same call, never a foreign artifact — the
same "no janitor, but every operation cleans what it created" discipline the
existing trusted module already follows. The cleanup authority set is therefore
**exhaustive, with no uncovered remainder**: refusing BEGIN cleans its own
staging; §Q eviction covers abandonment between BEGIN and COMMIT;
post-consumption COMMIT is governed by this rule. The
rule therefore covers, without needing enumeration: invalid manifest, missing
member, member hash mismatch, incoherent version triple, asset descriptor
refusal, descriptor-uniqueness refusal, CAS
mismatch/missing, contentHash mismatch, expectedManifestSha256 refusal,
undeclared staging entries, name-length refusal, member/staging fsync
failures, every `generation-staging-resource-*` environmental refusal (§R.2),
**and any promotion outcome other than a successful promotion** — including
the occupied path, whose ordering is fixed by §N.2: the trusted side
classifies the occupant **first**, then cleans only this attempt's staging,
then returns its verdict. Classification precedes cleanup because the verdict
is trusted-side; cleanup is unconditional on every occupied outcome,
`DEDUPED` included. ABORT cannot run on a consumed token, so this rule is
the sole cleanup authority after consumption. Normal rejected commits do not
accumulate residue. (Sessions abandoned before COMMIT are cleaned by §Q idle
eviction, not by this rule.)

If cleanup itself fails, the result reports the original refusal **and** the
cleanup failure honestly (`blockers` carries both; `committed`/`durabilityComplete`
truth is never altered by cleanup outcomes), and the residue is surfaced by
diagnostics.

**Persistent residue is reachable without any crash, and the contract says so
plainly.** A session abandoned between BEGIN and COMMIT — a webview reload, a
navigation, or an ordinary app quit — is cleaned only by §Q's *lazy* eviction,
which runs solely under a subsequent BEGIN in the same process. If the process
exits before another BEGIN occurs, the staging directory persists, and M05
ships no reclamation (see "Carried risks"). So the honest statement is: an
abandoned session and a crash are **both** legitimate sources of persistent
staging residue. A **refused BEGIN is not** a residue source: it cleans the
staging it created before returning, per the creator-owns-cleanup rule above.
So a completed COMMIT (successful or refused) and a refused BEGIN both
guarantee no residue; abandonment and crash do not. Any future move to eager cleanup at process exit is
an explicit change, not an assumption this contract already makes.

## Y. Exclusions

M05 performs no SQLite migration and allocates no v22; adds no capability
scope; changes nothing Sync-owned; does not activate live v3; does not touch
`$HOME/H2O Studio Sync`; does not modify Chrome surfaces beyond none.

## Z. Mission boundaries

- **M06** owns GC/reclamation: stale-generation pruning, staging-residue
  reclamation, CAS garbage collection, and any delete authority. M06 must
  honor §F's content-stale vs format-stale distinction and §C's grandfathering.
- **M07** owns storage ↔ sync transport.
- **M08** owns ZIP/export container work.
- Broad DB schema work requires separate cross-lane migration authority (D9).

## Member bounds (frozen by T1.2.3)

Authority and full evidence: the
[T1.2.3 evidence document](../../../release-evidence/2026-08-26/saved-chat-storage-m05-t123-member-bound-evidence.md).
Summary of the frozen policy:

| Concern | Bound | Class |
| --- | --- | --- |
| `snapshot.json` (v1/v2 publication) | **No new semantic cap.** Existing governed caps continue to govern exactly where they already apply (the 8 MiB logical cap is v3 write authority and is *not* extended to v1/v2). | — |
| `chat.md`, `chat.html` | **No semantic cap.** Streamed and hashed — never parsed as structured documents; commit additionally performs the bounded streaming residue/reference **scans** over `chat.html` that the §S superset invariant requires (memory O(scan window), not O(member)). | — |
| `manifest.json` | **No semantic cap.** Staged as an ordinary member (§N); read back and parsed from the staging descriptor. The former 64 MiB one-shot COMMIT-body ceiling is **withdrawn** — it would have created a product boundary that does not exist at HEAD. Consequence stated openly: parsing the staged manifest at COMMIT is an O(staged-manifest-size) trusted-side allocation that the per-chunk transport constant does **not** bound. That is accepted deliberately — matching HEAD, where the verifier also reads and parses whole manifests unbounded — rather than reintroducing a ceiling by another name. | — |
| WRITE MEMBER per-call chunk | 8 MiB per append call (members of any size arrive as N calls) | Transport/allocation constant — **not** product semantics; revisable without compatibility impact |
| Aggregate / cumulative size | **No aggregate *semantic* ceiling** — not per member, not per package, not across assets, and no per-session or process-wide staged-byte ceiling that an otherwise valid package can never exceed. Environmental resource refusals are a separate, permitted category (§R.2). | A fixed aggregate ceiling would be a new semantic package limit → `DP-M05-<MEMBER>-BOUND` first |
| Asset descriptor count | **No fixed count limit.** Bounded by per-descriptor validation, CAS existence verification, and the §S uniqueness rule (which is what actually caps copy amplification). | — |
| Generation basename | The real filesystem component limit, read at the opened archive parent via descriptor-relative platform authority (`fpathconf(_PC_NAME_MAX)`); fail closed if unavailable. No hardcoded 240/255. **Honest headroom note**: the 74-byte generation suffix (`.g` + 64 hex + `.h2ochat`) versus legacy's 8 bytes means a chatId longer than `NAME_MAX − 74` bytes (181 on a 255-byte filesystem) cannot receive a generation even though the same chatId up to `NAME_MAX − 8` could receive a legacy name pre-M05 — see the T1.2.3 evidence §4.6 for why no real state approaches this and the standing escalation that fires before any real one is refused. | Filesystem fact + evidence-classified headroom consequence |
| Snapshot commit-gate parse | Bounded **streaming** field extraction (memory ∝ extracted fields, not member size) | Implementation technique, no size cap |

Standing escalation rule: if any measured or reported real package state ever
approaches a transport/allocation constant, or a proposed change would turn
one into a semantic package limit, a Human Decision Point
(`DP-M05-<MEMBER>-BOUND`) is raised **before** any refusal ships. No new
product-size boundary is ever hidden inside an implementation constant.

**What the per-chunk bound does and does not do.** Verified at HEAD: an invoke
body is fully materialized by the framework *before* any command body runs
(WebKit `NSData` → `wry` → `tauri::ipc::protocol`), and the existing
`body_len()` check prevents exactly **one** subsequent clone. So the 8 MiB
chunk constant constrains the peak of a **cooperative** writer; it is not
admission control against a hostile caller, and this contract never claims
otherwise. No WebKit-layer ceiling on a single invoke body could be
established from source — carried as an open question, not as a guarantee.

## G1 prerequisites — immutable publication is not COMPLETE until all hold

Verified at HEAD: `capabilities/archive-cas.json` grants `fs:allow-write-file`
over `$APPLOCALDATA/archive/**`. That permission maps to three commands —
`write_file`, `open`, `write` — and this entry is the **only** grant of any of
them reaching `$APPLOCALDATA/archive`. (The export capability grants the same
permission, but scoped to `$HOME/H2O Studio Exports/**`, a different root that
this narrowing neither touches nor needs.) A renderer can therefore rewrite or
truncate the members of an already-published generation — a perfect trusted
publication is not yet an immutable one. Closing that is a genuine M05
prerequisite, sequenced as follows (no capability edit happens in this
document's batch):

1. every live package-write consumer migrates off renderer plugin-fs package
   writes onto the trusted staged protocol (the live path is
   `writeSavedChatPackageV1`, reached from exactly one production caller in
   the materializer);
2. the legacy destructive overwrite path is retired in code — it holds the
   only recursive-delete call on any publication path, behind a guard that
   tolerates an unreadable manifest, and it is currently inert only because
   the capability withholds `fs:allow-remove` (§Z assigns remove authority to
   M06, which is precisely the milestone that would grant it);
3. dormant and current writer dependencies are explicitly inventoried —
   including three pin classes that must be amended in the same change:
   pins asserting the legacy writer *is* the live path, pins asserting the
   destructive `overwrite: true` path succeeds, and the dormant-v3-writer
   validator;
4. the renderer's archive **mutation** capability is removed entirely.
   Verified grounding: the trusted durable-write path already creates every
   ancestor and CAS shard itself, descriptor-relatively with `O_NOFOLLOW`, and
   the renderer's CAS `mkdir` runs immediately before that same trusted call —
   it is redundant. The cutover therefore also removes that redundant renderer
   CAS `mkdir` call, after which the expected **post-cutover renderer mutation
   set under `$APPLOCALDATA/archive/**` is EMPTY**, and both
   `fs:allow-write-file` **and** `fs:allow-mkdir` are removed from the archive
   capability. Mechanism, stated precisely: removing these entries removes
   **scope**, not command availability — the default capability's
   app-specific-dirs grant leaves a `mkdir` command enabled with no scope of
   its own, so post-cutover it is the *absence of a matching scope entry* that
   separates the renderer from `archive/**`. Any pin proving the cutover must
   therefore be written over the **resolved permission union for the `main`
   window**, not over a single capability file.
   Removal — not an "allow `archive/**` except `packages/**`" expression — is
   the shape (a single glob cannot express the exception; a `deny` list can,
   and a `deny` on a command-bearing entry was verified to bind only that
   entry's own commands, but removal is strictly safer and needs neither).
   Removing `mkdir` is not merely tidy: a renderer retaining it over
   `archive/packages/**` could pre-create a generation directory name and
   permanently deny publication of that exact content, since promotion is
   exclusive and create-only;
5. what remains is **read/metadata only**, and the retained scopes are
   **not** uniform — reading the list distributively would break the CAS:
   - `fs:allow-exists`, `fs:allow-read-file`, `fs:allow-lstat` keep scope
     covering `archive/assets/**` **as well as** `archive/packages/**` (live
     CAS read/verify call sites depend on the assets scope);
   - `fs:allow-read-dir` remains scoped to `archive/packages` +
     `archive/packages/**` only;
6. the canonical CAS path and every other legitimate archive writer keep
   working — verified: the CAS no longer uses `plugin:fs|write_file` at all
   (it writes through the two trusted commands), and request receipts are
   written under `$HOME`, not under `archive/`;
7. the cutover is **proven, not assumed** — committed proof that CAS object
   creation still works solely through trusted Rust, that generation
   publication works solely through trusted Rust, and that the renderer can no
   longer pre-create, truncate or overwrite any package, staging or CAS path —
   **including a first save on a profile where `archive/packages` has never
   existed**, proving the trusted side creates its own archive ancestors.

Capability **narrowing** is in scope for the phase that performs it;
capability **widening** remains forbidden.

## Carried risks (M05 does not resolve these)

- **Storage amplification is a new capability, not a regression.** At HEAD a
  second publication for the same chat does **not** overwrite — it fails with
  `package-already-exists`, because the only production caller passes
  `overwrite: false`. Generations are what make repeat publication possible at
  all. The cost is that every accepted refresh writes a full package including
  fresh copies of every asset. §S's descriptor-uniqueness rule is the only
  sanctioned cap on per-commit copy amplification; cross-generation dedupe and
  pruning belong to M06 (§Z). Quantified sizing lives in the T1.2.3 evidence,
  deliberately not as a normative cost model.
- **Library-only edits mint generations** (§E/§F): folder, category, label,
  tag and similar bindings are read live at projection time and are inside the
  hashed snapshot bytes, so a binding change alters `contentHash` with no new
  `snapshotId`. This is the accepted whole-projection freshness authority, not
  a reopened decision — M05 introduces no second content-only identity. Two
  specific consequences are recorded rather than fixed: a **pin toggle** bumps
  the snapshot's `updated_at`, which feeds `savedAt` inside the hashed bytes,
  so pinning can mint a generation; and **label ordering** is projected in
  binding-recency order without sorting, so unbinding and rebinding the same
  label set in a different order yields a different `contentHash` for
  semantically identical state. Normalizing either would change existing
  hashes and is its own product decision.
- **Staging residue** is unbounded across repeated crash cycles and M05 ships
  **no** reclamation. This is deliberate: "any staging directory at startup is
  orphaned" is unsound while multiple instances can run against the same
  archive root, and a recursive sweep against a live peer could unlink a
  member between commit-time verification and promotion — publishing a
  generation with a verified manifest and a missing member, the exact failure
  M05 exists to prevent. Reclamation would also carry no capability diff
  (the trusted module bypasses plugin-fs by design), so it would ship the
  mission's broadest new delete authority through its least-reviewed channel.
  Phase-1 position: **diagnostics report residue count and exact paths; no
  delete authority.** Any future reclamation requires enforced single-instance
  as a hard precondition.
- **Accepted product consequence:** residue entries make the archive inventory
  report a non-OK (warning) status that cannot return to OK without manual
  cleanup, since the inventory warns on every non-`.h2ochat` entry. This is
  accepted knowingly as the visibility mechanism.
- **`RESIDUAL` verifier blockers** (§S) remain reachable for sanctioned-writer
  packages exactly as today. M05 neither creates nor repairs them.
- **Latent nondeterminism**, recorded not expanded: message ordering and
  snapshot-header ordering use `localeCompare` tie-breaks. Both are gated
  today — turn ordering by a database primary key, snapshot selection by the
  caller passing an explicit `snapshotId` — so neither is live. Phase 1 must
  confirm snapshot selection stays renderer-side and explicit, since §O has
  the renderer supply only `chatId` at BEGIN.
