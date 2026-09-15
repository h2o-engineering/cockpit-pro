# Saved-Chat filesystem safety — cross-platform realization

**Authority:** the frozen T01 contract of the canonical Mission
`establish-cross-platform-saved-chat-filesystem-safety`
(Cockpit Pro Management,
`missions/establish-cross-platform-saved-chat-filesystem-safety/t01-cross-platform-filesystem-safety-contract.md`,
SHA-256 `facd766476bc296472df8676b20a6d644b145744c28651a6d031182464977f3d`).
This document is the Product-side reflection of contract §5–§12 as
implemented by T02. Where the two disagree, the contract governs; this page
records what the native crate does today and what it deliberately does not
claim.

**Term.** "Cross-platform" here means the native operating-system filesystem
platforms — macOS, Linux, Windows — and their real filesystems. It is not the
F10.2 `@h2o/cross-platform-envelope` vocabulary.

## 1. Three facts that are never interchanged

| Fact | Established by | Reported as |
| --- | --- | --- |
| **Compile-time platform support** — a `cfg` arm exists for a primitive class on this OS | the build | `…-unsupported-platform` when absent; never evidence that a primitive works |
| **Runtime filesystem capability** — a behavioural probe on the admitted governed root proved the semantics in this process | `archive_filesystem_capability` (class O) | `…-capability-unproven` when absent; environmental, mutates nothing, retryable only after remount / relocation |
| **Native certification** — T03 / T05 evidence exists for (OS, filesystem, primitive class) | Mission evidence in Management | never queried at runtime, never a runtime gate |

Nothing is inferred from `statfs` magic, volume names, OS versions,
compilation or symbol presence; those are recorded as probe evidence only.
No capability ever selects a weaker or pathname-raceable fallback.

## 2. The primitive layer

`archive_durable_write::confined` is one platform-neutral facade over three
back-ends exposing the same class A–O operations of the contract:

| Class | macOS (accepted floor, unchanged) | Linux | Windows |
| --- | --- | --- | --- |
| A/B/C root admission, handle-relative traversal, no-follow inspection | `open(O_DIRECTORY)` on the trusted prefix; `mkdirat` + `openat(O_DIRECTORY\|O_NOFOLLOW)`; `fstatat(AT_SYMLINK_NOFOLLOW)` | identical | `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS)` on the trusted prefix; relative `NtCreateFile(RootDirectory, FILE_OPEN_REPARSE_POINT, OBJ_DONT_REPARSE)` then `FileAttributeTagInfo` — any reparse point is refused, never traversed; `OBJ_DONT_REPARSE` is never retried without |
| D exclusive file creation | `openat(O_CREAT\|O_EXCL)` | same, plus anonymous `O_TMPFILE` staging for publication | `NtCreateFile(FILE_CREATE, FILE_OPEN_REPARSE_POINT)`, `ShareAccess = 0`, handle retained |
| E exclusive directory creation | `mkdirat(0700)`, `EEXIST` refused | same | `NtCreateFile(FILE_CREATE, FILE_DIRECTORY_FILE)`; a reparse point at the name is a refusal |
| F create-only file publication | `renameatx_np(RENAME_EXCL)` of the reserved staging name + H′ | `linkat` of the anonymous inode by descriptor (`AT_EMPTY_PATH`, or the `/proc/self/fd` spelling of the same primitive); the former named-temp `linkat` promotion is retired | handle-bound `FileRenameInfo{ReplaceIfExists = FALSE, RootDirectory}` |
| G create-only directory publication | `renameatx_np(RENAME_EXCL)` + H′ | `renameat2(RENAME_NOREPLACE)` + H′ | the same handle-bound rename on the retained staging directory handle |
| H publication bound to the open source | `fclonefileat` (portable ZIP) | class F | inherent (rename by handle) |
| H′ post-publication identity verification | `fstat` of the retained object vs `fstatat(AT_SYMLINK_NOFOLLOW)` of the final name (`st_dev` + `st_ino`) | same | `FileIdInfo` recorded from the held handle, handle released, fresh relative no-reparse open of the final name |
| I controlled replacement (CAS repair only) | `renameat` within one descriptor | same | `FileRenameInfoEx{REPLACE_IF_EXISTS \| POSIX_SEMANTICS \| IGNORE_READONLY}` on the staging handle; legacy `ReplaceIfExists = TRUE` where the Ex class is refused |
| J content fence | `F_FULLFSYNC` → `fsync` fallback, truth flag | `fsync` | `FlushFileBuffers` through the retained **write** handle before close |
| K namespace fence | `fsync(dirfd)` | `fsync(dirfd)` | `FlushFileBuffers` on the parent directory handle (write access), acceptance proven by probe |
| L staging cleanup | identity-checked `unlinkat` | same; anonymous inodes need none | relative open + `FileDispositionInfoEx{DELETE \| POSIX_SEMANTICS}` (legacy disposition fallback), identity-checked |
| M quarantine move | `renameatx_np(RENAME_EXCL)` across descriptors + H′ | `renameat2(RENAME_NOREPLACE)` + H′ | source opened relative with `DELETE`, reparse refused, renamed by handle + H′ |
| N presence lock | `flock` on the lock file opened **relative to the admitted root with `O_NOFOLLOW`** | same | `LockFileEx` on the lock file opened relative to the root without `FILE_SHARE_DELETE`; conversion is unlock + lock |
| O capability detection | `fgetattrlist` (`VOL_CAP_INT_RENAME_EXCL`, `VOL_CAP_INT_CLONE`, declared AND valid) + behavioural probes | behavioural probes | behavioural probes; `GetVolumeInformationByHandleW` as evidence |

Every other target compiles the same operation set and fails closed at
runtime.

## 3. Capability probes (class O)

Probes run in the reserved namespace `.h2o-probe-<pid>-<n>` directly under
the governed root (a reserved component prefix: no renderer path can name it,
every scanner classifies residue as reserved infrastructure), remove their own
artifacts, run at most once per root identity per process, and are re-run on
the next admission after a failure — never on a timer.

| Capability | Proven by | Refuses when absent |
| --- | --- | --- |
| `CAP-EXCL` | a second exclusive create of one probe name collides | every staging creation |
| `CAP-XRENAME` | a no-replace directory rename onto an existing probe name collides and onto an absent name succeeds (macOS additionally requires the declared volume capability) | generation publication, folder export publication, quarantine moves, macOS CAS writes |
| `CAP-TMPFILE` / `CAP-LINK-BY-FD` (Linux) | `O_TMPFILE` succeeds; the anonymous inode links by descriptor and a second link collides | Linux CAS writes and portable ZIP publication |
| `CAP-CLONE` (macOS, per staging/final root pair) | declared `VOL_CAP_INT_CLONE` and a behavioural `fclonefileat` | portable ZIP publication (`unsupported-filesystem-capability`) |
| `CAP-DIRFSYNC` / `CAP-DIRFLUSH` | the namespace fence returns success on the admitted root | every publishing operation |
| `CAP-PRESENCE` | with shared presence held, an exclusive request on a **second** handle to the lock file is refused | every trusted mutation on that root (`archive-instance-lock-unsupported-filesystem`) |

A root that this process cannot write at all (permission denied / read-only
filesystem) is a permission condition, not a capability verdict: the owning
operation keeps its accepted infrastructure code (`create-failed`,
`publish-failed`, `generation-staging-create-failed`, …) and still mutates
nothing.

## 4. Durability ordering and the `full_fsync` flag

Every publication follows: stage in the destination directory object → write
→ content fence (J) → verify where applicable → create-only namespace
insertion with the staged handle retained → H′ where required → namespace
fence (K) → success. The insertion is the single commit point: before it the
final name does not exist; after it the object under the final name is
complete and verified, and a fence failure after a committed insertion is
reported as `committed:true, durabilityComplete:false`, never as "nothing
happened".

`full_fsync` keeps its existing meaning — **the macOS `F_FULLFSYNC` media
fence succeeded**. On Linux and Windows it is `false` while the platform's
documented fence was issued (`fsync` flushes a disk cache when present;
`FlushFileBuffers` synchronizes the storage cache). Consumers must not read
`full_fsync:false` as "not durable"; the durability claim is carried by
`committed` / `durabilityComplete`. No wire schema changed.

### The export folder (class D4) is verified on consume

The folder export (`OP-08` stage, renderer member writes, `OP-09` create-only
publication) remains the weaker **verified-on-consume** class by decision
(contract OQ-2): its members are written by the renderer through `plugin:fs`,
no member or namespace fence is issued, and `published` means exactly the
namespace commit. A torn export folder after power loss is rejected by the
portable verifier on re-import and by the trusted verifier on any consumption.
It is not promoted into the app-owned durable-recovery guarantee.

## 5. Naming policy (contract §12)

Governed leaves are ASCII-only, matched byte-exactly, admitted by one
authority per name class, never normalized, case-folded or trimmed to fit:

- `chatId` and every export leaf refuse the Windows reserved device stems
  (`CON PRN AUX NUL COM0–9 LPT0–9`) ASCII-case-insensitively on **every**
  platform, as the whole name and as the segment before the first `.`;
- export leaves refuse a leading `.`;
- component length is admitted against the parent's real limit read through
  the admitted object (`fpathconf(_PC_NAME_MAX)` /
  `lpMaximumComponentLength`), with `name-exceeds-filesystem-limit` and
  `name-limit-indeterminate` as the specific refusals;
- `.h2o-probe-` joins `.h2o-durable-` and `.h2o-genstage-` as a reserved
  component prefix;
- case-insensitive lookup (APFS default, NTFS default, ext4 `casefold`
  directories) resolves by deterministic refusal or trusted classification of
  the occupant — never by silent adoption.

## 6. Dependencies outside this Lane

- **D1 — Windows leading-dot condition.** Tauri's `fs` scope defaults
  `requireLiteralLeadingDot` to `true` on Unix and `false` on Windows; the
  product currently ships `plugins: {}`. The documented §R.1 protection of
  the `.h2o-*` reserved namespaces against wildcard read grants therefore
  holds on Windows only once `plugins.fs.requireLiteralLeadingDot = true`
  lands (owner: the Desktop shell / Tauri configuration owner, co-landed with
  the Saved-Chat test and this documentation). Until then Windows renderer
  READ reach into reserved staging namespaces is wider; no mutation invariant
  depends on it.
- **D3 / D5.** Sibling native modules (Sync / P02) carry ungated
  `libc::getentropy` calls, and the Windows Desktop build needs its icon and
  packaging pipeline; the whole crate is therefore not yet buildable on
  Windows. The Saved-Chat primitive modules compile for Windows and Linux
  through the bounded harness
  `apps/studio/desktop/src-tauri/harness/saved-chat-fs-primitives` — compile
  evidence only.

## 7. What is and is not claimed

Implemented and unit-tested on the macOS host: every arm above, the class O
probes, H′, identity-checked cleanup, the naming policy and the presence
probe. Check-compiled for `x86_64-unknown-linux-gnu` and
`x86_64-pc-windows-msvc` through the harness. **Not claimed:** native Linux
or Windows behaviour on any real filesystem — that is the Mission's T03 / T05
certification (ext4 and NTFS required; APFS re-certified), which
cross-compilation, mocks and cfg-gated stubs can never satisfy.
