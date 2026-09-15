// Bounded durable write for the app-owned saved-chat archive.
//
// `plugin:fs|write_file` opens, writes and drops the handle with no fsync, and
// `plugin:fs|rename` is a bare `std::fs::rename` with no parent-directory sync.
// The archive package writer therefore has no durability fence: its
// "manifest.json written last means the package is complete" invariant holds
// only in program order, so a power loss can persist the manifest while losing
// the snapshot member written before it.
//
// This module closes that gap with the narrowest primitive that does the job:
// a destination and bytes go in, a durably promoted file comes out. It is NOT
// a rename API — no source path is ever accepted from the renderer, so no
// caller can move or replace an arbitrary file. It exposes no delete
// authority: the only unlink that can ever happen is of this module's own
// private temporary artifact on a failed write.
//
// AUTHORITY IS CAS-SCOPED. The create-only command's sole production consumer
// is the saved-chat asset CAS, so its admitted destinations are exactly the
// canonical blob shape `assets/<aa>/sha256-<hex>` — not packages, not
// manifests, not snapshots, not arbitrary archive paths. The traversal
// machinery below is deliberately more general (the CAS repair path derives
// its own destinations through it), but nothing renderer-reachable inherits
// that generality. When durable v3 package publication is adopted it gets its
// own separately reviewed, purpose-bounded operation.
//
// CONTAINMENT IS DESCRIPTOR-RELATIVE, NOT PATHNAME-RELATIVE.
//
// A custom command bypasses the `plugin:fs` scope entirely, so this module's own
// containment implementation IS the security boundary. A check-then-use design
// over pathnames is not sufficient: an earlier revision validated ancestors with
// `symlink_metadata` and then called `create_dir_all`, and a concurrent attacker
// swapping an ancestor for a symlink between those two steps redirected writes
// outside the root (reproduced in 59 attempts).
//
// The boundary is therefore established once, as an open directory descriptor on
// the archive root, and every subsequent operation is performed RELATIVE to an
// already-admitted descriptor via `openat`/`mkdirat`/`fstatat`/`renameat` with
// `O_NOFOLLOW` and `O_DIRECTORY`. Once a descriptor is held it names an inode,
// not a path, so replacing a component afterwards cannot redirect anything: the
// attacker either loses the race (we keep writing into the original directory,
// still inside the root) or wins it before our `openat`, which then fails closed
// with `ELOOP`. There is no window in which a redirected pathname is used.
//
// The archive root itself is admitted the same way — opened through its parent
// with `O_NOFOLLOW | O_DIRECTORY`, so a symlink standing where `archive` belongs
// is refused rather than followed.
//
// PLATFORM SUPPORT (T02, frozen T01 contract §6–§11): `confined` is a
// platform-neutral facade over three back-ends that expose the same class
// A–O operations. macOS keeps every accepted primitive (`renameatx_np`
// `RENAME_EXCL`, `fclonefileat`, `F_FULLFSYNC`); Linux stages anonymously
// (`O_TMPFILE`) and publishes by descriptor (`linkat`), promotes directories
// with `renameat2(RENAME_NOREPLACE)`; Windows opens every component relative
// to an admitted handle (`NtCreateFile` + `OBJ_DONT_REPARSE`) and publishes by
// handle-bound no-replace rename. A cell a platform cannot express compiles
// and fails closed (`…-unsupported-platform`); a cell whose filesystem
// capability is unproven on the admitted root refuses before any staging
// (`…-capability-unproven`, `archive_filesystem_capability`). No cell ever
// degrades to the raceable pathname model.
//
// Ordering follows the established durable-write discipline (stage in the
// destination directory -> write -> content fence -> create-only namespace
// insertion with the staged handle retained -> post-publication identity
// verification -> namespace fence). See
// docs/systems/archive/saved-chat-package-v3.md and
// docs/systems/archive/saved-chat-filesystem-safety.md.

use serde::{Deserialize, Serialize};
#[cfg(not(h2o_saved_chat_primitive_harness))]
use std::path::PathBuf;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

pub const DURABLE_WRITE_SCHEMA: &str = "h2o.studio.archive.durable-write.v1";
pub const CAS_REPAIR_SCHEMA: &str = "h2o.studio.archive.cas-repair-write.v1";

/// DP-PRE-M05-ASSET-BOUND (ACCEPTED): the governed decoded-byte ceiling for
/// ONE newly ingested saved-chat binary asset — 32 MiB.
///
/// This is the trusted side of the authority. The renderer carries its own
/// copy (`asset-cas.tauri.js`, `assetBlobCapBytes`) and enforces it earlier at
/// the data-URI/ingest boundary, but that copy is a convenience, not the
/// authority: this check is independent and a caller that bypasses the JS
/// layer is still refused here, before any hashing, staging, durable write or
/// CAS replacement.
///
/// SCOPE — this governs one newly ingested asset only. It does NOT govern
/// `snapshot.json` (that is DP-M03-C's separate 8 MiB logical bound), total
/// package size, total chat size, or aggregate assets across a package.
///
/// COMPATIBILITY — an ingest ceiling, never a read ceiling. Historical CAS
/// objects larger than this stay readable; nothing here is applied to reads.
pub const GOVERNED_ASSET_BLOB_CAP_BYTES: u64 = 33_554_432;

/// Every admitted destination lives under `$APPLOCALDATA/<ARCHIVE_ROOT>`.
pub const ARCHIVE_ROOT: &str = "archive";

/// Distinguishes this module's private staging artifacts from any real
/// archive member. A CAS blob is `sha256-<hex>` and a package member is a
/// plain name, so neither can collide with this prefix.
pub(crate) const TEMP_PREFIX: &str = ".h2o-durable-";

/// M05 §R: the generation publisher's private staging component. Declared here
/// so the reserved-prefix authority below owns exactly one list; the publisher
/// re-exports this constant rather than declaring a second literal.
pub(crate) const GENERATION_STAGING_PREFIX: &str = ".h2o-genstage-";

/// Every reserved path component prefix. Deliberately SEPARATE from the
/// temp-name *generator* (`temp_name`), which stays on `TEMP_PREFIX` alone:
/// reserving a name and minting one are different jobs, and §R requires the
/// reservation to be a shared list rather than a side effect of the generator.
pub(crate) const RESERVED_COMPONENT_PREFIXES: &[&str] = &[
    TEMP_PREFIX,
    GENERATION_STAGING_PREFIX,
    crate::archive_filesystem_capability::PROBE_PREFIX,
];

/// M06 T1.2: the instance-presence lock component. REFERENCED from T1.1 rather
/// than restated, so the reservation can never drift from the file the lock
/// authority actually creates.
pub(crate) const ARCHIVE_LOCK_COMPONENT: &str = crate::archive_instance_lock::ARCHIVE_LOCK_NAME;

/// M06 T1.2: the quarantine namespace of reclamation contract §J, reserved NOW
/// so no caller-controlled path can occupy or collide with the identity before
/// P3 implements quarantine. T1.2 reserves the IDENTITY ONLY — nothing here
/// renames, quarantines, purges or deletes anything.
pub(crate) const RECLAIM_NAMESPACE_COMPONENT: &str = ".h2o-reclaim";

/// Reserved EXACT path components, deliberately separate from the prefix list.
///
/// These are single identities, not families. Putting them in
/// `RESERVED_COMPONENT_PREFIXES` would reserve every name that merely BEGINS
/// the same way -- `.h2o-archive.lock.bak`, `.h2o-reclaimed-notes` -- which
/// reserves more of the namespace than the architecture requires. The staging
/// prefixes are genuinely prefix-shaped because they mint `<prefix><unique>`
/// names; these two do not.
///
/// Reserving the exact component `.h2o-reclaim` also covers everything beneath
/// it: admission validates EVERY component, so `.h2o-reclaim/run-1/x` is
/// refused on its first component. No separate subtree rule is needed.
pub(crate) const RESERVED_EXACT_COMPONENTS: &[&str] =
    &[ARCHIVE_LOCK_COMPONENT, RECLAIM_NAMESPACE_COMPONENT];

/// The single canonical reservation predicate. One authority consumed by every
/// trusted module, rather than a second parallel reserved-name implementation.
///
/// Case-sensitive, matching the existing durable-write admission semantics
/// exactly; the publisher applies its own ASCII-case-insensitive belt-and-
/// braces on top, as it already did for the prefix list.
pub(crate) fn is_reserved_component(text: &str) -> bool {
    RESERVED_COMPONENT_PREFIXES
        .iter()
        .any(|prefix| text.starts_with(prefix))
        || RESERVED_EXACT_COMPONENTS.iter().any(|exact| *exact == text)
}
pub(crate) const TEMP_SUFFIX: &str = ".tmp";

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// The content-addressed store lives at `<ARCHIVE_ROOT>/<CAS_DIR>`.
pub(crate) const CAS_DIR: &str = "assets";

/// How many distinct private temp names to try before giving up.
const TEMP_ATTEMPTS: u32 = 8;

/// What to do when the canonical destination already exists.
///
/// PRIVATE ON PURPOSE. This is not `Deserialize` and no caller-supplied field
/// maps to it: a renderer cannot ask for replacement of an arbitrary archive
/// destination. `Replace` is reachable only from the CAS repair path below,
/// which derives its own destination from bytes it hashed itself.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum ExistingPolicy {
    /// Refuse the write and report `durable-write-destination-exists`.
    #[default]
    Fail,
    /// Let the atomic rename supersede the existing entry. This is not a
    /// delete: the old inode is unlinked by `rename(2)` itself, never by an
    /// unlink this module issues, and the destination is never left absent.
    Replace,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableWriteOptions {
    /// Destination relative to the archive root. Must be relative, must not
    /// escape the root, and must contain only normal path components.
    /// There is deliberately no `existing` field — see `ExistingPolicy`.
    pub path: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CasRepairOptions {
    /// Optional caller assertion of the content hash. It can only ever cause a
    /// REFUSAL: the destination is derived from the hash this module computes
    /// itself, never from anything the caller supplies.
    #[serde(default)]
    pub expected_sha256: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableWriteBlocker {
    pub code: String,
}

impl DurableWriteBlocker {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
        }
    }
}

/// Outcome of a durable write.
///
/// The atomic promotion is an irreversible boundary, so committed-ness and
/// durability-completeness are reported SEPARATELY. A parent-directory sync
/// that fails after a successful rename leaves the canonical destination
/// already changed; returning a bare error there would tell the caller
/// "nothing happened", which is false. The three honest states are:
///
///   committed:false                            — the destination is untouched
///   committed:true, durabilityComplete:false   — the bytes are in place but the
///                                                directory entry is not fenced
///   committed:true, durabilityComplete:true    — fully durable
///
/// `ok` is true only for the last of those.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableWriteResult {
    pub schema: &'static str,
    pub ok: bool,
    /// The atomic promotion succeeded: the canonical destination now holds the
    /// new bytes. Never true unless the rename returned success.
    pub committed: bool,
    /// The parent directory entry was synced after the promotion.
    pub durability_complete: bool,
    pub replaced: bool,
    pub byte_length: u64,
    /// True only when the file contents were flushed with macOS `F_FULLFSYNC`.
    /// False means the weaker `fsync(2)` guarantee — see `sync_file_contents`.
    pub full_fsync: bool,
    pub blockers: Vec<DurableWriteBlocker>,
    /// Infrastructure detail accompanying an incomplete-durability commit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl DurableWriteResult {
    fn skeleton() -> Self {
        Self {
            schema: DURABLE_WRITE_SCHEMA,
            ok: false,
            committed: false,
            durability_complete: false,
            replaced: false,
            byte_length: 0,
            full_fsync: false,
            blockers: vec![],
            detail: None,
        }
    }

    pub fn blocked(code: &str) -> Self {
        let mut result = Self::skeleton();
        result.blockers.push(DurableWriteBlocker::new(code));
        result
    }
}

/// Outcome of a CAS repair. The `sha256`/`path` fields are what this module
/// DERIVED, not what any caller asked for — they exist so the caller can see
/// where the trusted side decided the object belongs.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CasRepairResult {
    pub schema: &'static str,
    pub ok: bool,
    pub sha256: String,
    pub path: String,
    /// The canonical object already held exactly these bytes; nothing written.
    pub already_valid: bool,
    /// A mismatching object was superseded by the verified bytes.
    pub repaired: bool,
    pub committed: bool,
    pub durability_complete: bool,
    pub byte_length: u64,
    pub full_fsync: bool,
    pub blockers: Vec<DurableWriteBlocker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CasRepairResult {
    fn skeleton(sha256: String, path: String) -> Self {
        Self {
            schema: CAS_REPAIR_SCHEMA,
            ok: false,
            sha256,
            path,
            already_valid: false,
            repaired: false,
            committed: false,
            durability_complete: false,
            byte_length: 0,
            full_fsync: false,
            blockers: vec![],
            detail: None,
        }
    }

    fn blocked(code: &str) -> Self {
        let mut result = Self::skeleton(String::new(), String::new());
        result.blockers.push(DurableWriteBlocker::new(code));
        result
    }
}

/// Splits a caller-supplied relative destination into validated components.
///
/// Rejects anything that is not a plain relative path built from normal
/// components, so `..`, absolute paths, drive prefixes, `.` and embedded NULs
/// never reach the traversal. The components are returned as owned byte strings
/// because every subsequent syscall consumes them one at a time, relative to a
/// descriptor — the joined pathname is never used to open anything.
fn validated_components(relative: &str) -> Result<Vec<Vec<u8>>, &'static str> {
    if relative.is_empty() {
        return Err("durable-write-path-empty");
    }
    if relative.contains('\0') {
        return Err("durable-write-path-invalid");
    }

    let candidate = Path::new(relative);
    if candidate.is_absolute() {
        return Err("durable-write-path-not-relative");
    }

    let mut out: Vec<Vec<u8>> = vec![];
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                let text = part.to_str().ok_or("durable-write-path-invalid")?;
                // Reject every reserved component so a caller can never target
                // another operation's private artifact — this operation's temp,
                // the M05 generation publisher's staging, or (M06 T1.2) the
                // instance-presence lock and the reserved quarantine namespace.
                if is_reserved_component(text) {
                    return Err("durable-write-path-reserved");
                }
                out.push(text.as_bytes().to_vec());
            }
            Component::ParentDir => return Err("durable-write-path-traversal"),
            Component::CurDir => return Err("durable-write-path-invalid"),
            Component::RootDir | Component::Prefix(_) => {
                return Err("durable-write-path-not-relative")
            }
        }
    }

    if out.is_empty() {
        return Err("durable-write-path-empty");
    }
    Ok(out)
}

/// The Windows back-end of `confined` (contract §9), kept in its own file.
/// Declared at file level so the path resolves identically inside the crate
/// and inside the bounded primitive compile harness.
#[cfg(windows)]
#[path = "archive_durable_write/confined_windows.rs"]
mod confined_windows_backend;

/// Descriptor / handle-relative filesystem primitives — the platform-neutral
/// facade of the frozen T01 cross-platform filesystem safety contract (§6
/// classes A–O). Every operation is performed against an already-admitted
/// directory object, so a concurrent rename / symlink / reparse-point swap of
/// a path component cannot redirect it.
///
/// Three back-ends expose the SAME operation set:
///
/// * `unix` — macOS (accepted floor: `renameatx_np(RENAME_EXCL)`,
///   `fclonefileat`, `F_FULLFSYNC`) and Linux (`O_TMPFILE` + `linkat` by
///   descriptor, `renameat2(RENAME_NOREPLACE)`, `fsync`);
/// * `windows` — NT handle-relative opens (`NtCreateFile` with
///   `RootDirectory`, `OBJ_DONT_REPARSE`, `FILE_OPEN_REPARSE_POINT`),
///   handle-bound no-replace renames, `FlushFileBuffers` fences;
/// * everything else — every cell compiles and fails closed at runtime.
///
/// A cell a platform cannot express returns `io::ErrorKind::Unsupported`
/// (compile-time arm absent, reported by callers as
/// `…-unsupported-platform`); a cell whose filesystem capability has not been
/// proven on the admitted root is refused by the caller through
/// `archive_filesystem_capability` (`…-capability-unproven`). No cell ever
/// selects a weaker or pathname-raceable fallback (contract I14).
pub(crate) mod confined {
    use std::fs::File;
    use std::io;

    /// What a no-follow inspection reports about a directory child. A link,
    /// reparse point, junction or mount point is reported as `Symlink` and is
    /// never traversed to find out what it points at.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum EntryKind {
        Regular,
        Directory,
        Symlink,
        Other,
    }

    /// Filesystem object identity, independent of any name: `st_dev` +
    /// `st_ino` on Unix, volume serial + 128-bit file id on Windows. Two
    /// identities are equal only when they name the same object on the same
    /// volume; this is what the post-publication identity check (class H′)
    /// and identity-checked staging cleanup (class L) compare.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
    pub struct ObjectIdentity {
        pub device: u64,
        pub object: u128,
    }

    /// The result of a no-follow inspection of one directory child.
    #[derive(Clone, Copy, Debug)]
    pub struct EntryStat {
        kind: EntryKind,
        identity: ObjectIdentity,
        size: u64,
    }

    impl EntryStat {
        pub(crate) fn new(kind: EntryKind, identity: ObjectIdentity, size: u64) -> Self {
            Self {
                kind,
                identity,
                size,
            }
        }
        pub fn kind(&self) -> EntryKind {
            self.kind
        }
        pub fn identity(&self) -> ObjectIdentity {
            self.identity
        }
        pub fn size(&self) -> u64 {
            self.size
        }
        pub fn is_regular(&self) -> bool {
            self.kind == EntryKind::Regular
        }
        pub fn is_directory(&self) -> bool {
            self.kind == EntryKind::Directory
        }
        pub fn is_symlink(&self) -> bool {
            self.kind == EntryKind::Symlink
        }
    }

    /// Whether `st` describes a regular file.
    pub fn is_regular(st: &EntryStat) -> bool {
        st.is_regular()
    }

    /// Whether `st` describes a symbolic link / reparse point.
    pub fn is_symlink(st: &EntryStat) -> bool {
        st.is_symlink()
    }

    /// Whether `st` describes a directory.
    pub fn is_directory(st: &EntryStat) -> bool {
        st.is_directory()
    }

    /// Environmental resource refusals. Retryable and machine-local; they never
    /// mark an object structurally invalid.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum ResourceError {
        NoSpace,
        Quota,
        FileTooLarge,
    }

    /// Which spelling of the Linux descriptor-bound link succeeded during the
    /// capability probe. Both are the SAME fd-bound primitive (contract §10
    /// rule 5); neither resolves a staging pathname.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum LinkByHandleSpelling {
        /// `linkat(fd, "", dirfd, name, AT_EMPTY_PATH)` (Linux ≥ 6.10
        /// unprivileged, or `CAP_DAC_READ_SEARCH`).
        EmptyPath,
        /// `linkat(AT_FDCWD, "/proc/self/fd/N", dirfd, name, AT_SYMLINK_FOLLOW)`.
        ProcSelfFd,
    }

    /// Volume capability flags a platform DECLARES for an admitted root.
    /// Declared is never proof (contract §10 rule 3): the behavioural probe
    /// settles every capability, and this record is evidence detail only.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct DeclaredVolumeCapabilities {
        pub rename_excl: Option<bool>,
        pub clone: Option<bool>,
        pub filesystem_name: Option<[u8; 16]>,
        pub filesystem_name_len: usize,
    }

    impl DeclaredVolumeCapabilities {
        pub fn filesystem_name_string(&self) -> Option<String> {
            let name = self.filesystem_name?;
            let len = self.filesystem_name_len.min(name.len());
            Some(String::from_utf8_lossy(&name[..len]).into_owned())
        }
    }

    /// Reads the byte body of an already-opened file up to `limit + 1` bytes,
    /// so a wrong object can never force an unbounded allocation.
    pub fn read_bounded(file: &mut File, limit: usize) -> io::Result<Vec<u8>> {
        use std::io::Read;
        let mut buf = Vec::with_capacity(limit.min(1 << 20) + 1);
        file.by_ref().take(limit as u64 + 1).read_to_end(&mut buf)?;
        Ok(buf)
    }

    /// Unix back-end: macOS (the accepted floor) and Linux. Every operation is
    /// `openat`-family relative to an admitted descriptor with `O_NOFOLLOW`.
    #[cfg(unix)]
    mod backend {
        use super::{
            DeclaredVolumeCapabilities, EntryKind, EntryStat, LinkByHandleSpelling, ObjectIdentity,
            ResourceError,
        };
        use std::ffi::CString;
        use std::fs::File;
        use std::io;
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        use std::path::Path;

        fn cstr(name: &[u8]) -> io::Result<CString> {
            CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
        }

        /// Portable pointer to `errno`. `readdir`/`fpathconf` report
        /// end-of-stream and error identically, so errno must be cleared before
        /// the call and inspected after.
        fn errno_location() -> *mut libc::c_int {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            unsafe {
                libc::__error()
            }
            #[cfg(target_os = "linux")]
            unsafe {
                libc::__errno_location()
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux")))]
            unsafe {
                libc::__error()
            }
        }

        fn stat_to_entry(st: &libc::stat) -> EntryStat {
            let kind = match st.st_mode & libc::S_IFMT {
                libc::S_IFREG => EntryKind::Regular,
                libc::S_IFDIR => EntryKind::Directory,
                libc::S_IFLNK => EntryKind::Symlink,
                _ => EntryKind::Other,
            };
            EntryStat::new(
                kind,
                ObjectIdentity {
                    device: st.st_dev as u64,
                    object: st.st_ino as u128,
                },
                if st.st_size < 0 { 0 } else { st.st_size as u64 },
            )
        }

        fn fstat_raw(fd: i32) -> io::Result<libc::stat> {
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            let rc = unsafe { libc::fstat(fd, &mut st) };
            if rc < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(st)
        }

        /// Identity of an open file object (`st_dev` + `st_ino`), read from the
        /// descriptor itself — never from a pathname.
        pub fn file_identity(file: &File) -> io::Result<ObjectIdentity> {
            Ok(stat_to_entry(&fstat_raw(file.as_raw_fd())?).identity())
        }

        /// Flushes file contents. On macOS plain `fsync(2)` only pushes writes to
        /// the device without forcing a drive-cache flush, so `F_FULLFSYNC` is
        /// used first and `sync_all` is the documented fallback for filesystems
        /// that reject it. Returns whether the strong `F_FULLFSYNC` guarantee was
        /// established — the meaning of every `full_fsync` result field.
        ///
        /// On Linux `fsync(2)` is documented to write through / flush a disk
        /// cache when present; the flag is reported `false` because it names the
        /// macOS media fence specifically, NOT because the write is less durable
        /// (contract §11.3).
        #[cfg(target_os = "macos")]
        pub fn sync_file_contents(file: &File) -> io::Result<bool> {
            let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_FULLFSYNC) };
            if rc == 0 {
                return Ok(true);
            }
            file.sync_all()?;
            Ok(false)
        }

        #[cfg(not(target_os = "macos"))]
        pub fn sync_file_contents(file: &File) -> io::Result<bool> {
            file.sync_all()?;
            Ok(false)
        }

        /// A component swapped for a symlink (or something that is not a
        /// directory) between two steps is refused by `O_NOFOLLOW` /
        /// `O_DIRECTORY` with one of these errnos — never followed.
        pub fn is_redirect_refusal(err: &io::Error) -> bool {
            matches!(
                err.raw_os_error(),
                Some(libc::ELOOP) | Some(libc::ENOTDIR) | Some(libc::EMLINK)
            )
        }

        /// The platform refused a primitive as unavailable on this filesystem or
        /// for this object: contract class "capability absent" (`ENOTSUP`,
        /// `EOPNOTSUPP`, `EXDEV`, `EINVAL` on a flag, `ENOSYS`), plus the
        /// facade's own compile-time-absent marker.
        pub fn is_capability_absent(err: &io::Error) -> bool {
            if err.kind() == io::ErrorKind::Unsupported {
                return true;
            }
            // `ENOTSUP` and `EOPNOTSUPP` share one value on Linux and differ on
            // macOS; compared by value so both platforms read the same list.
            let absent = [
                libc::ENOTSUP,
                libc::EOPNOTSUPP,
                libc::EXDEV,
                libc::EINVAL,
                libc::ENOSYS,
            ];
            err.raw_os_error()
                .is_some_and(|code| absent.contains(&code))
        }

        pub fn resource_error(err: &io::Error) -> Option<ResourceError> {
            match err.raw_os_error() {
                Some(libc::ENOSPC) => Some(ResourceError::NoSpace),
                Some(libc::EDQUOT) => Some(ResourceError::Quota),
                Some(libc::EFBIG) => Some(ResourceError::FileTooLarge),
                _ => None,
            }
        }

        fn flock(fd: i32, op: i32) -> io::Result<()> {
            // SAFETY: `fd` is a live descriptor owned by the caller for the whole
            // call, and `flock` only manipulates kernel lock state for it.
            if unsafe { libc::flock(fd, op) } == 0 {
                Ok(())
            } else {
                Err(io::Error::last_os_error())
            }
        }

        /// Class N: non-blocking SHARED presence on this open file description.
        pub fn lock_shared(file: &File) -> io::Result<()> {
            flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB)
        }

        /// Class N: non-blocking EXCLUSIVE presence on this open file
        /// description. Conversion from shared is documented as non-atomic on
        /// every Unix; only a successful acquisition is a proof point.
        pub fn lock_exclusive(file: &File) -> io::Result<()> {
            flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB)
        }

        pub fn unlock(file: &File) -> io::Result<()> {
            flock(file.as_raw_fd(), libc::LOCK_UN)
        }

        /// Whether a lock request was refused because another open file
        /// description holds a conflicting lock.
        pub fn lock_would_block(err: &io::Error) -> bool {
            matches!(
                err.raw_os_error(),
                Some(libc::EWOULDBLOCK) | Some(libc::EINTR)
            ) || err.kind() == io::ErrorKind::WouldBlock
        }

        /// An open directory descriptor. Dropping it closes the descriptor.
        pub struct Dir(OwnedFd);

        impl Dir {
            /// Class A: opens `path` as a directory without following a symlink
            /// standing at its final component, creating the leaf if absent.
            /// Used only to admit a governed root from a creating entry point.
            pub fn open_root(path: &Path) -> io::Result<Dir> {
                use std::os::unix::ffi::OsStrExt;

                let parent = path
                    .parent()
                    .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
                let name = path
                    .file_name()
                    .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;

                // The parent (Tauri's app-local-data directory) is trusted input,
                // not caller input; it is opened as a directory so the final
                // component can then be admitted with O_NOFOLLOW.
                std::fs::create_dir_all(parent)?;
                let parent_dir = Dir::open_trusted_dir(parent)?;
                let name = name.as_bytes();
                parent_dir.mkdir_child(name)?;
                parent_dir.open_child_nofollow(name)
            }

            /// M06 T1.3: opens an EXISTING directory for a read-only probe.
            ///
            /// Deliberately NOT `open_root`: that one `create_dir_all`s the parent
            /// and `mkdir`s the final component, so using it from diagnostics would
            /// let a read-only scan CREATE archive structure. This creates nothing
            /// and still refuses to follow a symlink at the final component, so a
            /// missing archive reports `NotFound` rather than being materialized.
            pub fn open_existing_nofollow(path: &Path) -> io::Result<Dir> {
                use std::os::unix::ffi::OsStrExt;

                let parent = path
                    .parent()
                    .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
                let name = path
                    .file_name()
                    .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
                let parent_dir = Dir::open_trusted_dir(parent)?;
                parent_dir.open_child_nofollow(name.as_bytes())
            }

            /// Opens a trusted directory path with `O_DIRECTORY`. Only used for the
            /// app-local-data parent, which the caller never influences.
            fn open_trusted_dir(path: &Path) -> io::Result<Dir> {
                use std::os::unix::ffi::OsStrExt;

                let c = cstr(path.as_os_str().as_bytes())?;
                let fd = unsafe {
                    libc::open(
                        c.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Dir(unsafe { OwnedFd::from_raw_fd(fd) }))
            }

            /// Class B: opens a child directory relative to this descriptor,
            /// refusing to follow a symlink. A component swapped for a symlink
            /// after this descriptor was admitted fails here with `ELOOP` rather
            /// than redirecting the write.
            pub fn open_child_nofollow(&self, name: &[u8]) -> io::Result<Dir> {
                let c = cstr(name)?;
                let fd = unsafe {
                    libc::openat(
                        self.0.as_raw_fd(),
                        c.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Dir(unsafe { OwnedFd::from_raw_fd(fd) }))
            }

            /// Creates a child directory relative to this descriptor. An existing
            /// entry is tolerated here and rejected by the subsequent `O_NOFOLLOW`
            /// open if it is not a real directory.
            pub fn mkdir_child(&self, name: &[u8]) -> io::Result<()> {
                let c = cstr(name)?;
                let rc = unsafe { libc::mkdirat(self.0.as_raw_fd(), c.as_ptr(), 0o755) };
                if rc < 0 {
                    let err = io::Error::last_os_error();
                    if err.kind() != io::ErrorKind::AlreadyExists {
                        return Err(err);
                    }
                }
                Ok(())
            }

            /// Class C: `fstatat` with `AT_SYMLINK_NOFOLLOW`. Returns `None` when
            /// absent; a symlink is reported as itself, never followed.
            pub fn stat_child_nofollow(&self, name: &[u8]) -> io::Result<Option<EntryStat>> {
                let c = cstr(name)?;
                let mut st: libc::stat = unsafe { std::mem::zeroed() };
                let rc = unsafe {
                    libc::fstatat(
                        self.0.as_raw_fd(),
                        c.as_ptr(),
                        &mut st,
                        libc::AT_SYMLINK_NOFOLLOW,
                    )
                };
                if rc < 0 {
                    let err = io::Error::last_os_error();
                    if err.kind() == io::ErrorKind::NotFound {
                        return Ok(None);
                    }
                    return Err(err);
                }
                Ok(Some(stat_to_entry(&st)))
            }

            /// Class D: exclusively creates a read/write file relative to this
            /// descriptor. The retained read side lets a purpose-bounded owner
            /// verify the exact bytes held by the descriptor without reopening a
            /// pathname.
            pub fn create_new_child(&self, name: &[u8]) -> io::Result<File> {
                let c = cstr(name)?;
                let fd = unsafe {
                    libc::openat(
                        self.0.as_raw_fd(),
                        c.as_ptr(),
                        libc::O_RDWR | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC,
                        0o644 as libc::c_uint,
                    )
                };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(unsafe { File::from_raw_fd(fd) })
            }

            /// Class D (anonymous): Linux `O_TMPFILE` — an unnamed regular file
            /// on this directory's filesystem. It has no pathname to swap, needs
            /// no cleanup (an unlinked inode dies with the process) and is
            /// later published by `publish_file_by_handle`. `O_EXCL` is
            /// deliberately NOT set: it would forbid the later `linkat`.
            ///
            /// macOS has no anonymous-inode create; the accepted macOS floor
            /// stages under a reserved private name instead.
            #[cfg(target_os = "linux")]
            pub fn create_anonymous_child(&self) -> io::Result<File> {
                let c = cstr(b".")?;
                let fd = unsafe {
                    libc::openat(
                        self.0.as_raw_fd(),
                        c.as_ptr(),
                        libc::O_TMPFILE | libc::O_RDWR | libc::O_CLOEXEC,
                        0o644 as libc::c_uint,
                    )
                };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(unsafe { File::from_raw_fd(fd) })
            }

            #[cfg(not(target_os = "linux"))]
            pub fn create_anonymous_child(&self) -> io::Result<File> {
                Err(io::Error::from(io::ErrorKind::Unsupported))
            }

            /// Class C: opens a child file for reading without following a
            /// symlink. Used to prove an existing CAS object really is corrupt
            /// before superseding it, and for every trusted read.
            pub fn open_child_read_nofollow(&self, name: &[u8]) -> io::Result<File> {
                let c = cstr(name)?;
                let fd = unsafe {
                    libc::openat(
                        self.0.as_raw_fd(),
                        c.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(unsafe { File::from_raw_fd(fd) })
            }

            /// Class I: controlled same-directory REPLACEMENT of a proven-
            /// mismatching regular file. On Unix the rename is pathname-bound
            /// (`renameat` within one descriptor, so it can never cross a
            /// filesystem); the retained staging handle is what the caller's
            /// class H′ check compares afterwards. Windows renames the staging
            /// handle itself.
            ///
            /// This CLOBBERS an existing destination and is therefore reserved
            /// for the CAS repair path. Create-only callers must use
            /// `promote_exclusive` / `publish_file_by_handle`.
            pub fn replace_within(
                &self,
                _staging: &File,
                from: &[u8],
                to: &[u8],
            ) -> io::Result<()> {
                self.rename_within(from, to)
            }

            fn rename_within(&self, from: &[u8], to: &[u8]) -> io::Result<()> {
                let from_c = cstr(from)?;
                let to_c = cstr(to)?;
                let rc = unsafe {
                    libc::renameat(
                        self.0.as_raw_fd(),
                        from_c.as_ptr(),
                        self.0.as_raw_fd(),
                        to_c.as_ptr(),
                    )
                };
                if rc < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }

            /// Class F (macOS, pathname-bound): promotes `from` to `to` ONLY IF
            /// `to` does not already exist, as a single atomic operation.
            ///
            /// An `fstatat` followed by `renameat` is a check-then-act race: two
            /// writers both observe an absent destination and both rename, so
            /// both report success and one payload is silently destroyed. macOS
            /// exposes `renameatx_np(RENAME_EXCL)`, which performs the existence
            /// test and the rename indivisibly (volume capability
            /// `VOL_CAP_INT_RENAME_EXCL`, probed by class O).
            ///
            /// Because the rename resolves the staging NAME, the caller retains
            /// the staged file handle across this call and verifies the
            /// published identity afterwards (class H′).
            ///
            /// Returns `Ok(false)` when the destination already existed.
            #[cfg(target_os = "macos")]
            pub fn promote_exclusive(&self, from: &[u8], to: &[u8]) -> io::Result<bool> {
                let from_c = cstr(from)?;
                let to_c = cstr(to)?;
                let rc = unsafe {
                    libc::renameatx_np(
                        self.0.as_raw_fd(),
                        from_c.as_ptr(),
                        self.0.as_raw_fd(),
                        to_c.as_ptr(),
                        libc::RENAME_EXCL,
                    )
                };
                if rc < 0 {
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() == Some(libc::EEXIST) {
                        return Ok(false);
                    }
                    return Err(err);
                }
                Ok(true)
            }

            /// Linux: the former named-temp `linkat` + `unlinkat` promotion is
            /// RETIRED for publication (contract §6 note on class F): it resolved
            /// the staging pathname in the publication call and could leave a
            /// second name for the published inode. Linux publishes regular
            /// files ONLY through `publish_file_by_handle`.
            #[cfg(not(target_os = "macos"))]
            pub fn promote_exclusive(&self, _from: &[u8], _to: &[u8]) -> io::Result<bool> {
                Err(io::Error::from(io::ErrorKind::Unsupported))
            }

            /// Class F / H (Linux, handle-bound): inserts the object held by
            /// `file` under `to` in this directory, create-only, without ever
            /// resolving a staging pathname. `EEXIST` ⇒ `Ok(false)`.
            ///
            /// The `AT_EMPTY_PATH` spelling is tried first (unprivileged since
            /// Linux 6.10 for a descriptor this process opened, or with
            /// `CAP_DAC_READ_SEARCH`); the documented no-capability refusal
            /// (`ENOENT`) selects the `/proc/self/fd/N` + `AT_SYMLINK_FOLLOW`
            /// spelling of the SAME primitive. There is no named-temp fallback.
            #[cfg(target_os = "linux")]
            pub fn publish_file_by_handle(&self, file: &File, to: &[u8]) -> io::Result<bool> {
                self.publish_file_by_handle_spelled(file, to, None)
                    .map(|(inserted, _)| inserted)
            }

            /// `publish_file_by_handle` with an optional spelling preference
            /// established by the capability probe. Returns which spelling
            /// performed the insertion.
            #[cfg(target_os = "linux")]
            pub fn publish_file_by_handle_spelled(
                &self,
                file: &File,
                to: &[u8],
                preferred: Option<LinkByHandleSpelling>,
            ) -> io::Result<(bool, LinkByHandleSpelling)> {
                let to_c = cstr(to)?;
                let empty = cstr(b"")?;
                if preferred != Some(LinkByHandleSpelling::ProcSelfFd) {
                    let rc = unsafe {
                        libc::linkat(
                            file.as_raw_fd(),
                            empty.as_ptr(),
                            self.0.as_raw_fd(),
                            to_c.as_ptr(),
                            libc::AT_EMPTY_PATH,
                        )
                    };
                    if rc == 0 {
                        return Ok((true, LinkByHandleSpelling::EmptyPath));
                    }
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() == Some(libc::EEXIST) {
                        return Ok((false, LinkByHandleSpelling::EmptyPath));
                    }
                    // ENOENT is the documented refusal of AT_EMPTY_PATH without
                    // the capability on pre-6.10 kernels; anything else is a
                    // genuine failure of this spelling.
                    if err.raw_os_error() != Some(libc::ENOENT) {
                        return Err(err);
                    }
                }
                let proc_path = cstr(format!("/proc/self/fd/{}", file.as_raw_fd()).as_bytes())?;
                let rc = unsafe {
                    libc::linkat(
                        libc::AT_FDCWD,
                        proc_path.as_ptr(),
                        self.0.as_raw_fd(),
                        to_c.as_ptr(),
                        libc::AT_SYMLINK_FOLLOW,
                    )
                };
                if rc == 0 {
                    return Ok((true, LinkByHandleSpelling::ProcSelfFd));
                }
                let err = io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::EEXIST) {
                    return Ok((false, LinkByHandleSpelling::ProcSelfFd));
                }
                Err(err)
            }

            #[cfg(not(target_os = "linux"))]
            pub fn publish_file_by_handle(&self, _file: &File, _to: &[u8]) -> io::Result<bool> {
                Err(io::Error::from(io::ErrorKind::Unsupported))
            }

            #[cfg(not(target_os = "linux"))]
            pub fn publish_file_by_handle_spelled(
                &self,
                _file: &File,
                _to: &[u8],
                _preferred: Option<LinkByHandleSpelling>,
            ) -> io::Result<(bool, LinkByHandleSpelling)> {
                Err(io::Error::from(io::ErrorKind::Unsupported))
            }

            /// Class H (macOS): atomically creates `to` as a copy-on-write clone
            /// of the regular file selected by `source`'s retained descriptor.
            /// No source pathname is resolved by the publication syscall, so
            /// replacing a staging name cannot redirect which object is
            /// published. The destination must be absent.
            ///
            /// Darwin's `fclonefileat(2)` creates an independent inode whose
            /// bytes are an atomic snapshot of the source descriptor. It
            /// requires source and destination on one clone-capable volume
            /// (`VOL_CAP_INT_CLONE`, probed by class O). Every other target
            /// fails closed; there is deliberately no pathname-based fallback.
            #[cfg(target_os = "macos")]
            pub fn publish_open_file_clone_exclusive(
                &self,
                source: &File,
                to: &[u8],
            ) -> io::Result<bool> {
                let to_c = cstr(to)?;
                let rc = unsafe {
                    libc::fclonefileat(source.as_raw_fd(), self.0.as_raw_fd(), to_c.as_ptr(), 0)
                };
                if rc < 0 {
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() == Some(libc::EEXIST) {
                        return Ok(false);
                    }
                    return Err(err);
                }
                Ok(true)
            }

            #[cfg(not(target_os = "macos"))]
            pub fn publish_open_file_clone_exclusive(
                &self,
                _source: &File,
                _to: &[u8],
            ) -> io::Result<bool> {
                Err(io::Error::from(io::ErrorKind::Unsupported))
            }

            /// Class L: unlinks a child of this directory. Only ever called on
            /// this operation's own private artifact.
            pub fn unlink_child(&self, name: &[u8]) -> io::Result<()> {
                let c = cstr(name)?;
                let rc = unsafe { libc::unlinkat(self.0.as_raw_fd(), c.as_ptr(), 0) };
                if rc < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }

            /// Class L, identity-checked: unlinks `name` only while it still
            /// resolves to the object `owned` names. `Ok(false)` means the name
            /// was absent or foreign and was left untouched.
            pub fn unlink_child_if_identity(
                &self,
                name: &[u8],
                owned: ObjectIdentity,
            ) -> io::Result<bool> {
                match self.stat_child_nofollow(name)? {
                    Some(st) if st.identity() == owned && !st.is_directory() => {
                        self.unlink_child(name)?;
                        Ok(true)
                    }
                    _ => Ok(false),
                }
            }

            /// Class L, identity-checked, for an EMPTY directory this operation
            /// created.
            pub fn unlink_child_dir_if_identity(
                &self,
                name: &[u8],
                owned: ObjectIdentity,
            ) -> io::Result<bool> {
                match self.stat_child_nofollow(name)? {
                    Some(st) if st.identity() == owned && st.is_directory() => {
                        self.unlink_child_dir(name)?;
                        Ok(true)
                    }
                    _ => Ok(false),
                }
            }

            /// M05: raw descriptor, for `fstatfs`-style metadata queries only.
            pub fn as_raw_fd(&self) -> i32 {
                self.0.as_raw_fd()
            }

            /// Identity of this directory object.
            pub fn identity(&self) -> io::Result<ObjectIdentity> {
                Ok(stat_to_entry(&fstat_raw(self.0.as_raw_fd())?).identity())
            }

            /// Class E: creates a child directory **exclusively**. Unlike
            /// `mkdir_child` this does NOT tolerate `EEXIST` — a staging
            /// directory must never silently adopt another operation's tree.
            pub fn mkdir_child_exclusive(&self, name: &[u8]) -> io::Result<()> {
                let c = cstr(name)?;
                let rc = unsafe { libc::mkdirat(self.0.as_raw_fd(), c.as_ptr(), 0o700) };
                if rc < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }

            /// Class L: removes an EMPTY child directory (`AT_REMOVEDIR`). Only
            /// ever called on a staging directory this operation created.
            pub fn unlink_child_dir(&self, name: &[u8]) -> io::Result<()> {
                let c = cstr(name)?;
                let rc =
                    unsafe { libc::unlinkat(self.0.as_raw_fd(), c.as_ptr(), libc::AT_REMOVEDIR) };
                if rc < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }

            /// Enumerates entry names from THIS descriptor.
            ///
            /// `fdopendir` takes ownership of the descriptor it is handed, so a
            /// duplicate is passed and the original `Dir` stays usable.
            pub fn read_entry_names(&self) -> io::Result<Vec<Vec<u8>>> {
                let dup = unsafe { libc::dup(self.0.as_raw_fd()) };
                if dup < 0 {
                    return Err(io::Error::last_os_error());
                }
                let dirp = unsafe { libc::fdopendir(dup) };
                if dirp.is_null() {
                    let err = io::Error::last_os_error();
                    unsafe { libc::close(dup) };
                    return Err(err);
                }
                let mut names = Vec::new();
                loop {
                    // `readdir` reports end-of-stream and error identically
                    // (NULL), so errno is cleared first and checked after.
                    unsafe { *errno_location() = 0 };
                    let ent = unsafe { libc::readdir(dirp) };
                    if ent.is_null() {
                        let errno = unsafe { *errno_location() };
                        if errno != 0 {
                            let err = io::Error::from_raw_os_error(errno);
                            unsafe { libc::closedir(dirp) };
                            return Err(err);
                        }
                        break;
                    }
                    let name_ptr = unsafe { (*ent).d_name.as_ptr() };
                    let name = unsafe { std::ffi::CStr::from_ptr(name_ptr) }
                        .to_bytes()
                        .to_vec();
                    if name == b"." || name == b".." {
                        continue;
                    }
                    names.push(name);
                }
                unsafe { libc::closedir(dirp) };
                Ok(names)
            }

            /// The filesystem's maximum component length for THIS directory,
            /// via `fpathconf(_PC_NAME_MAX)`. Fails closed when unanswerable.
            pub fn name_max(&self) -> io::Result<u64> {
                unsafe { *errno_location() = 0 };
                let value = unsafe { libc::fpathconf(self.0.as_raw_fd(), libc::_PC_NAME_MAX) };
                if value < 0 {
                    let errno = unsafe { *errno_location() };
                    return Err(if errno != 0 {
                        io::Error::from_raw_os_error(errno)
                    } else {
                        // Indeterminate with errno unset: fail closed rather
                        // than inventing a limit.
                        io::Error::from(io::ErrorKind::Unsupported)
                    });
                }
                Ok(value as u64)
            }

            /// Available bytes on the filesystem holding this directory, read
            /// through the descriptor. `None` when unanswerable — callers fail
            /// closed.
            pub fn available_bytes(&self) -> Option<u64> {
                let mut st: libc::statfs = unsafe { std::mem::zeroed() };
                let rc = unsafe { libc::fstatfs(self.0.as_raw_fd(), &mut st) };
                if rc < 0 {
                    return None;
                }
                (st.f_bavail as u64).checked_mul(st.f_bsize as u64)
            }

            /// Class G: create-only promotion of a **directory** staged under
            /// `from` in this directory to `to` in this directory.
            ///
            /// No Unix renames a directory by descriptor and directories cannot
            /// be hard-linked, so this is pathname-bound on macOS
            /// (`renameatx_np(RENAME_EXCL)`) and Linux
            /// (`renameat2(RENAME_NOREPLACE)`); the caller retains the staging
            /// directory descriptor across the call and verifies the published
            /// identity afterwards (class H′). A plain `renameat` — which would
            /// silently REPLACE an existing generation — is never used.
            ///
            /// Returns `Ok(false)` when the destination already existed.
            #[cfg(target_os = "macos")]
            pub fn promote_dir_exclusive(
                &self,
                _staging: &Dir,
                from: &[u8],
                to: &[u8],
            ) -> io::Result<bool> {
                let from_c = cstr(from)?;
                let to_c = cstr(to)?;
                let rc = unsafe {
                    libc::renameatx_np(
                        self.0.as_raw_fd(),
                        from_c.as_ptr(),
                        self.0.as_raw_fd(),
                        to_c.as_ptr(),
                        libc::RENAME_EXCL,
                    )
                };
                if rc < 0 {
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() == Some(libc::EEXIST)
                        || err.raw_os_error() == Some(libc::ENOTEMPTY)
                    {
                        return Ok(false);
                    }
                    return Err(err);
                }
                Ok(true)
            }

            #[cfg(target_os = "linux")]
            pub fn promote_dir_exclusive(
                &self,
                _staging: &Dir,
                from: &[u8],
                to: &[u8],
            ) -> io::Result<bool> {
                rename_noreplace(self.0.as_raw_fd(), from, self.0.as_raw_fd(), to)
            }

            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            pub fn promote_dir_exclusive(
                &self,
                _staging: &Dir,
                _from: &[u8],
                _to: &[u8],
            ) -> io::Result<bool> {
                Err(io::Error::from(io::ErrorKind::Unsupported))
            }

            /// Class M: one no-replace move of `name` from this directory into
            /// `dest` as `item`, same volume. Never a copy, never a replacing
            /// rename. `Ok(false)` on collision; `EXDEV` surfaces as an error
            /// the caller classifies as a refusal. The caller retains the
            /// source object (opened no-follow) across the move for class H′.
            #[cfg(target_os = "macos")]
            pub fn move_exclusive_into(
                &self,
                name: &[u8],
                dest: &Dir,
                item: &[u8],
            ) -> io::Result<bool> {
                let from_c = cstr(name)?;
                let to_c = cstr(item)?;
                let rc = unsafe {
                    libc::renameatx_np(
                        self.0.as_raw_fd(),
                        from_c.as_ptr(),
                        dest.0.as_raw_fd(),
                        to_c.as_ptr(),
                        libc::RENAME_EXCL,
                    )
                };
                if rc < 0 {
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() == Some(libc::EEXIST)
                        || err.raw_os_error() == Some(libc::ENOTEMPTY)
                    {
                        return Ok(false);
                    }
                    return Err(err);
                }
                Ok(true)
            }

            #[cfg(target_os = "linux")]
            pub fn move_exclusive_into(
                &self,
                name: &[u8],
                dest: &Dir,
                item: &[u8],
            ) -> io::Result<bool> {
                rename_noreplace(self.0.as_raw_fd(), name, dest.0.as_raw_fd(), item)
            }

            #[cfg(not(any(target_os = "macos", target_os = "linux")))]
            pub fn move_exclusive_into(
                &self,
                _name: &[u8],
                _dest: &Dir,
                _item: &[u8],
            ) -> io::Result<bool> {
                Err(io::Error::from(io::ErrorKind::Unsupported))
            }

            /// Class K: syncs this directory so a namespace change is durable.
            pub fn sync(&self) -> io::Result<()> {
                let rc = unsafe { libc::fsync(self.0.as_raw_fd()) };
                if rc < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            }

            /// Class N open: the presence lock file, created if absent and
            /// opened relative to this admitted root with `O_NOFOLLOW`, so a
            /// symlink standing at the lock name is refused rather than followed
            /// (contract MB-03). Nothing is ever written to it.
            pub fn open_lock_file(&self, name: &[u8]) -> io::Result<File> {
                let c = cstr(name)?;
                let fd = unsafe {
                    libc::openat(
                        self.0.as_raw_fd(),
                        c.as_ptr(),
                        libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                        0o644 as libc::c_uint,
                    )
                };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(unsafe { File::from_raw_fd(fd) })
            }

            /// Class O evidence: the volume capabilities the platform DECLARES
            /// for this directory's volume. macOS reads `ATTR_VOL_CAPABILITIES`
            /// (`VOL_CAP_INT_RENAME_EXCL`, `VOL_CAP_INT_CLONE`, "declared AND
            /// valid"); Linux records the filesystem magic only. Never proof.
            #[cfg(target_os = "macos")]
            pub fn declared_volume_capabilities(&self) -> DeclaredVolumeCapabilities {
                #[repr(C, packed(4))]
                struct VolCapBuf {
                    length: u32,
                    caps: libc::vol_capabilities_attr_t,
                }
                let mut list: libc::attrlist = unsafe { std::mem::zeroed() };
                list.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
                list.volattr = libc::ATTR_VOL_INFO | libc::ATTR_VOL_CAPABILITIES;
                let mut buf: VolCapBuf = unsafe { std::mem::zeroed() };
                let rc = unsafe {
                    libc::fgetattrlist(
                        self.0.as_raw_fd(),
                        &mut list as *mut libc::attrlist as *mut libc::c_void,
                        &mut buf as *mut VolCapBuf as *mut libc::c_void,
                        std::mem::size_of::<VolCapBuf>(),
                        0,
                    )
                };
                let mut out = DeclaredVolumeCapabilities::default();
                if rc == 0 {
                    let caps = buf.caps;
                    let interfaces = caps.capabilities[libc::VOL_CAPABILITIES_INTERFACES];
                    let valid = caps.valid[libc::VOL_CAPABILITIES_INTERFACES];
                    let declared = |bit: libc::attrgroup_t| -> Option<bool> {
                        if valid & bit != 0 {
                            Some(interfaces & bit != 0)
                        } else {
                            Some(false)
                        }
                    };
                    out.rename_excl = declared(libc::VOL_CAP_INT_RENAME_EXCL);
                    out.clone = declared(libc::VOL_CAP_INT_CLONE);
                }
                let mut st: libc::statfs = unsafe { std::mem::zeroed() };
                if unsafe { libc::fstatfs(self.0.as_raw_fd(), &mut st) } == 0 {
                    let raw = unsafe {
                        std::slice::from_raw_parts(
                            st.f_fstypename.as_ptr() as *const u8,
                            st.f_fstypename.len(),
                        )
                    };
                    let len = raw
                        .iter()
                        .position(|b| *b == 0)
                        .unwrap_or(raw.len())
                        .min(16);
                    let mut name = [0u8; 16];
                    name[..len].copy_from_slice(&raw[..len]);
                    out.filesystem_name = Some(name);
                    out.filesystem_name_len = len;
                }
                out
            }

            #[cfg(not(target_os = "macos"))]
            pub fn declared_volume_capabilities(&self) -> DeclaredVolumeCapabilities {
                let mut out = DeclaredVolumeCapabilities::default();
                let mut st: libc::statfs = unsafe { std::mem::zeroed() };
                if unsafe { libc::fstatfs(self.0.as_raw_fd(), &mut st) } == 0 {
                    let magic = format!("magic:0x{:x}", st.f_type as u64);
                    let bytes = magic.as_bytes();
                    let len = bytes.len().min(16);
                    let mut name = [0u8; 16];
                    name[..len].copy_from_slice(&bytes[..len]);
                    out.filesystem_name = Some(name);
                    out.filesystem_name_len = len;
                }
                out
            }
        }

        /// `renameat2(RENAME_NOREPLACE)` through the raw syscall, so the
        /// primitive does not depend on the C library exposing a wrapper.
        /// `EEXIST`/`ENOTEMPTY` ⇒ occupied; `EINVAL`/`ENOSYS` (the filesystem
        /// or kernel lacks the flag) surface as errors the caller classifies as
        /// capability-absent. A plain `renameat` is never substituted.
        #[cfg(target_os = "linux")]
        fn rename_noreplace(from_fd: i32, from: &[u8], to_fd: i32, to: &[u8]) -> io::Result<bool> {
            let from_c = cstr(from)?;
            let to_c = cstr(to)?;
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    from_fd,
                    from_c.as_ptr(),
                    to_fd,
                    to_c.as_ptr(),
                    libc::RENAME_NOREPLACE as libc::c_uint,
                )
            };
            if rc < 0 {
                let err = io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::EEXIST)
                    || err.raw_os_error() == Some(libc::ENOTEMPTY)
                {
                    return Ok(false);
                }
                return Err(err);
            }
            Ok(true)
        }
    }

    #[cfg(windows)]
    use super::confined_windows_backend as backend;

    /// Every other target: the operation set compiles and every cell fails
    /// closed at runtime with `io::ErrorKind::Unsupported`, which callers report
    /// as `…-unsupported-platform`. Nothing here can mutate anything.
    #[cfg(not(any(unix, windows)))]
    mod backend {
        use super::{
            DeclaredVolumeCapabilities, EntryStat, LinkByHandleSpelling, ObjectIdentity,
            ResourceError,
        };
        use std::fs::File;
        use std::io;
        use std::path::Path;

        fn unsupported<T>() -> io::Result<T> {
            Err(io::Error::from(io::ErrorKind::Unsupported))
        }

        pub fn file_identity(_file: &File) -> io::Result<ObjectIdentity> {
            unsupported()
        }
        pub fn sync_file_contents(_file: &File) -> io::Result<bool> {
            unsupported()
        }
        pub fn is_redirect_refusal(_err: &io::Error) -> bool {
            false
        }
        pub fn is_capability_absent(err: &io::Error) -> bool {
            err.kind() == io::ErrorKind::Unsupported
        }
        pub fn resource_error(_err: &io::Error) -> Option<ResourceError> {
            None
        }
        pub fn lock_shared(_file: &File) -> io::Result<()> {
            unsupported()
        }
        pub fn lock_exclusive(_file: &File) -> io::Result<()> {
            unsupported()
        }
        pub fn unlock(_file: &File) -> io::Result<()> {
            unsupported()
        }
        pub fn lock_would_block(_err: &io::Error) -> bool {
            false
        }

        /// No directory object can be admitted on this target.
        pub struct Dir(());

        impl Dir {
            pub fn open_root(_path: &Path) -> io::Result<Dir> {
                unsupported()
            }
            pub fn open_existing_nofollow(_path: &Path) -> io::Result<Dir> {
                unsupported()
            }
            pub fn open_child_nofollow(&self, _name: &[u8]) -> io::Result<Dir> {
                unsupported()
            }
            pub fn mkdir_child(&self, _name: &[u8]) -> io::Result<()> {
                unsupported()
            }
            pub fn mkdir_child_exclusive(&self, _name: &[u8]) -> io::Result<()> {
                unsupported()
            }
            pub fn stat_child_nofollow(&self, _name: &[u8]) -> io::Result<Option<EntryStat>> {
                unsupported()
            }
            pub fn create_new_child(&self, _name: &[u8]) -> io::Result<File> {
                unsupported()
            }
            pub fn create_anonymous_child(&self) -> io::Result<File> {
                unsupported()
            }
            pub fn open_child_read_nofollow(&self, _name: &[u8]) -> io::Result<File> {
                unsupported()
            }
            pub fn replace_within(
                &self,
                _staging: &File,
                _from: &[u8],
                _to: &[u8],
            ) -> io::Result<()> {
                unsupported()
            }
            pub fn promote_exclusive(&self, _from: &[u8], _to: &[u8]) -> io::Result<bool> {
                unsupported()
            }
            pub fn publish_file_by_handle(&self, _file: &File, _to: &[u8]) -> io::Result<bool> {
                unsupported()
            }
            pub fn publish_file_by_handle_spelled(
                &self,
                _file: &File,
                _to: &[u8],
                _preferred: Option<LinkByHandleSpelling>,
            ) -> io::Result<(bool, LinkByHandleSpelling)> {
                unsupported()
            }
            pub fn publish_open_file_clone_exclusive(
                &self,
                _source: &File,
                _to: &[u8],
            ) -> io::Result<bool> {
                unsupported()
            }
            pub fn unlink_child(&self, _name: &[u8]) -> io::Result<()> {
                unsupported()
            }
            pub fn unlink_child_if_identity(
                &self,
                _name: &[u8],
                _owned: ObjectIdentity,
            ) -> io::Result<bool> {
                unsupported()
            }
            pub fn unlink_child_dir(&self, _name: &[u8]) -> io::Result<()> {
                unsupported()
            }
            pub fn unlink_child_dir_if_identity(
                &self,
                _name: &[u8],
                _owned: ObjectIdentity,
            ) -> io::Result<bool> {
                unsupported()
            }
            pub fn identity(&self) -> io::Result<ObjectIdentity> {
                unsupported()
            }
            pub fn read_entry_names(&self) -> io::Result<Vec<Vec<u8>>> {
                unsupported()
            }
            pub fn name_max(&self) -> io::Result<u64> {
                unsupported()
            }
            pub fn available_bytes(&self) -> Option<u64> {
                None
            }
            pub fn promote_dir_exclusive(
                &self,
                _staging: &Dir,
                _from: &[u8],
                _to: &[u8],
            ) -> io::Result<bool> {
                unsupported()
            }
            pub fn move_exclusive_into(
                &self,
                _name: &[u8],
                _dest: &Dir,
                _item: &[u8],
            ) -> io::Result<bool> {
                unsupported()
            }
            pub fn sync(&self) -> io::Result<()> {
                unsupported()
            }
            pub fn open_lock_file(&self, _name: &[u8]) -> io::Result<File> {
                unsupported()
            }
            pub fn declared_volume_capabilities(&self) -> DeclaredVolumeCapabilities {
                DeclaredVolumeCapabilities::default()
            }
        }
    }

    #[allow(unused_imports)]
    pub use backend::{
        file_identity, is_capability_absent, is_redirect_refusal, lock_exclusive, lock_shared,
        lock_would_block, resource_error, sync_file_contents, unlock, Dir,
    };
}

/// Flushes file contents through the platform's documented per-file fence
/// (class J). Re-exported from the facade so every governed content fence —
/// CAS blobs, generation members, asset copies, portable ZIPs, receipts —
/// shares ONE authority. The boolean is the `full_fsync` truth flag: true only
/// when the macOS `F_FULLFSYNC` media fence succeeded.
pub(crate) use confined::sync_file_contents;

/// Fills `buf` from the operating system's CSPRNG through the already-locked
/// `getrandom` crate (`getentropy(2)` on macOS, `getrandom(2)` on Linux,
/// `ProcessPrng` on Windows). Fails closed: callers decide whether a weaker
/// non-replaying seed is acceptable (session token) or not (run id).
pub(crate) fn fill_entropy(buf: &mut [u8]) -> Result<(), String> {
    getrandom::fill(buf).map_err(|err| format!("entropy-unavailable:{err}"))
}

/// Windows reserved device stems (contract §12): `CON PRN AUX NUL COM0–COM9
/// LPT0–LPT9`, refused ASCII-case-insensitively on EVERY platform, both as the
/// whole name and as the segment before the first `.` ("the name followed
/// immediately by an extension"). The superscript-digit variants are excluded
/// by the ASCII-only charsets already. Handed to the NT layer directly these
/// would be created as ordinary files that Win32 tooling cannot open; refusing
/// them at admission keeps every governed name portable and deterministic.
pub(crate) fn has_reserved_device_stem(name: &str) -> bool {
    fn stem_is_reserved(stem: &str) -> bool {
        let upper = stem.to_ascii_uppercase();
        match upper.as_str() {
            "CON" | "PRN" | "AUX" | "NUL" => true,
            _ => {
                (upper.starts_with("COM") || upper.starts_with("LPT"))
                    && upper.len() == 4
                    && upper.as_bytes()[3].is_ascii_digit()
            }
        }
    }
    if name.is_empty() {
        return false;
    }
    if stem_is_reserved(name) {
        return true;
    }
    match name.find('.') {
        Some(0) => false,
        Some(index) => stem_is_reserved(&name[..index]),
        None => false,
    }
}

fn temp_name() -> Vec<u8> {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{TEMP_PREFIX}{}-{counter}{TEMP_SUFFIX}", std::process::id()).into_bytes()
}

/// Exclusively creates this operation's private NAMED staging file, retrying
/// on a name collision with a fresh sequence value.
///
/// A single fixed name would wedge a destination permanently if a crash left a
/// stale artifact behind (PIDs are reused and the counter restarts at zero).
/// Only `AlreadyExists` is retried, and no artifact this operation did not
/// create is ever removed — stale-temp reclamation is deliberately not done
/// here.
fn create_private_temp(dir: &confined::Dir) -> Result<(Vec<u8>, std::fs::File), String> {
    create_private_temp_with(dir, temp_name)
}

/// `create_private_temp` with the name sequence injected, so the retry and
/// exhaustion behaviour can be tested deterministically instead of racing the
/// process-global counter.
fn create_private_temp_with<F>(
    dir: &confined::Dir,
    mut next_name: F,
) -> Result<(Vec<u8>, std::fs::File), String>
where
    F: FnMut() -> Vec<u8>,
{
    let mut last: Option<std::io::Error> = None;
    for _ in 0..TEMP_ATTEMPTS {
        let name = next_name();
        match dir.create_new_child(&name) {
            Ok(file) => return Ok((name, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => last = Some(err),
            Err(err) => return Err(format!("durable-write-temp-create-failed:{err}")),
        }
    }
    Err(format!(
        "durable-write-temp-name-exhausted:{}",
        last.map(|e| e.to_string())
            .unwrap_or_else(|| "collision".to_string())
    ))
}

/// Asserts that a validated component list names exactly one canonical CAS
/// blob: `assets/<aa>/sha256-<64 lowercase hex>` with `<aa>` equal to the
/// first two hex digits. Anything else — packages, manifests, snapshots, any
/// other archive path, wrong shard, wrong case, wrong depth — is refused.
fn assert_cas_blob_shape(components: &[Vec<u8>]) -> Result<(), &'static str> {
    const OUTSIDE: &str = "durable-write-path-outside-cas";
    if components.len() != 3 {
        return Err(OUTSIDE);
    }
    if components[0] != CAS_DIR.as_bytes() {
        return Err(OUTSIDE);
    }
    let shard = &components[1];
    if shard.len() != 2
        || !shard
            .iter()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(OUTSIDE);
    }
    let name = &components[2];
    let Some(hex) = name.strip_prefix(b"sha256-") else {
        return Err(OUTSIDE);
    };
    if hex.len() != 64
        || !hex
            .iter()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(OUTSIDE);
    }
    if &hex[0..2] != shard.as_slice() {
        return Err(OUTSIDE);
    }
    Ok(())
}

/// Durably CREATES one canonical CAS blob beneath `root`. Never replaces.
///
/// This is the only write surface reachable from the renderer, and its
/// authority is deliberately NARROWER than the traversal machinery beneath it:
/// the sole production consumer is the saved-chat asset CAS, so the admitted
/// destinations are exactly `assets/<aa>/sha256-<hex>` and nothing else.
/// Package members, manifests and snapshots are refused here even though the
/// machinery could write them — a future durable package publication must
/// arrive as its own separately reviewed, purpose-bounded operation rather
/// than inheriting archive-wide reach from this one. Replacement authority
/// lives solely in `cas_repair_write_within_root`, which derives its own
/// destination.
pub fn durable_write_within_root(
    root: &Path,
    relative: &str,
    bytes: &[u8],
) -> Result<DurableWriteResult, String> {
    // DP-PRE-M05-ASSET-BOUND: refuse before any traversal, staging or write.
    if bytes.len() as u64 > GOVERNED_ASSET_BLOB_CAP_BYTES {
        return Ok(DurableWriteResult::blocked("durable-write-asset-too-large"));
    }
    // Reuse the same component validation the machinery applies, so traversal
    // and reserved-name refusals keep their specific codes, then narrow.
    let components = match validated_components(relative) {
        Ok(components) => components,
        Err(code) => return Ok(DurableWriteResult::blocked(code)),
    };
    if let Err(code) = assert_cas_blob_shape(&components) {
        return Ok(DurableWriteResult::blocked(code));
    }
    durable_write_impl(root, relative, bytes, ExistingPolicy::Fail)
}

/// Durably writes `bytes` to `relative` beneath `root` under `existing`.
///
/// Domain refusals (traversal, symlink, destination-exists, unproven
/// capability, publication identity mismatch) come back as `Ok(result)` with
/// `ok: false` and a blocker code; only infrastructure faults return `Err`.
/// Any failure up to and including the promotion leaves the canonical
/// destination exactly as it was, and removes only this operation's own temp
/// artifact — and only while that name still resolves to the object this
/// operation created.
///
/// After a successful promotion the destination HAS changed, so a failing
/// parent-directory sync does not become an error: it returns
/// `committed: true, durability_complete: false` with the detail attached, so
/// the caller can never read it as "nothing happened".
fn durable_write_impl(
    root: &Path,
    relative: &str,
    bytes: &[u8],
    existing: ExistingPolicy,
) -> Result<DurableWriteResult, String> {
    durable_write_impl_with(root, relative, bytes, existing, |dir| dir.sync())
}

/// The staged object of one durable write: either a reserved private NAME in
/// the destination directory (macOS, Windows, and the class I repair branch
/// everywhere) or an anonymous inode with no name at all (Linux create-only
/// publication, class D anonymous + class F by descriptor).
struct StagedFile {
    handle: std::fs::File,
    name: Option<Vec<u8>>,
}

/// Stages this operation's object per the platform realization.
fn stage_for(
    dir: &confined::Dir,
    existing: ExistingPolicy,
    report: &crate::archive_filesystem_capability::CapabilityReport,
) -> Result<StagedFile, String> {
    let anonymous = existing == ExistingPolicy::Fail
        && report.anonymous_file.is_proven()
        && report.link_by_handle.is_proven();
    if anonymous {
        let handle = dir
            .create_anonymous_child()
            .map_err(|err| format!("durable-write-temp-create-failed:{err}"))?;
        return Ok(StagedFile { handle, name: None });
    }
    let (name, handle) = create_private_temp(dir)?;
    Ok(StagedFile {
        handle,
        name: Some(name),
    })
}

/// Class L cleanup of a NAMED staging artifact, identity-checked: the name is
/// removed only while it still resolves to the object this operation created.
fn cleanup_staged(
    dir: &confined::Dir,
    staged_name: Option<&[u8]>,
    owned: confined::ObjectIdentity,
) {
    if let Some(name) = staged_name {
        let _ = dir.unlink_child_if_identity(name, owned);
    }
}

/// `durable_write_impl` with the post-promotion directory sync injected.
///
/// The seam exists so the committed-but-unfenced branch can be exercised by a
/// test; a real `fsync` on a directory descriptor cannot be made to fail on
/// demand. Production always passes the real sync.
fn durable_write_impl_with<F>(
    root: &Path,
    relative: &str,
    bytes: &[u8],
    existing: ExistingPolicy,
    sync_dir: F,
) -> Result<DurableWriteResult, String>
where
    F: Fn(&confined::Dir) -> std::io::Result<()>,
{
    use crate::archive_filesystem_capability as capability;
    use confined::Dir;

    let components = match validated_components(relative) {
        Ok(components) => components,
        Err(code) => return Ok(DurableWriteResult::blocked(code)),
    };

    // Admit the root once, as a descriptor. Everything below is relative to it.
    let mut dir =
        Dir::open_root(root).map_err(|err| format!("durable-write-root-open-failed:{err}"))?;

    // Class O: every filesystem-variable primitive this write relies on must
    // have been PROVEN on this root in this process. Compile-time arm
    // absence surfaces below as `Unsupported`; an unproven capability refuses
    // here, before any staging, mutating nothing.
    let required = match existing {
        ExistingPolicy::Fail => capability::file_publication_requirements(),
        ExistingPolicy::Replace => capability::controlled_replacement_requirements(),
    };
    let report = match capability::require(&dir, required) {
        Ok(report) => report,
        // A root this process cannot write is a permission condition and an
        // infrastructure fault (the accepted `Err` shape), never a capability
        // verdict.
        Err(refusal) if refusal.is_root_not_writable() => {
            return Err(format!("durable-write-root-open-failed:{}", refusal.detail));
        }
        Err(refusal) => {
            let mut result = DurableWriteResult::blocked("durable-write-capability-unproven");
            result.detail = Some(refusal.detail_text());
            return Ok(result);
        }
    };

    let (file_name, dir_names) = components.split_last().expect("validated non-empty");

    for name in dir_names {
        if let Err(err) = dir.mkdir_child(name) {
            return Err(format!("durable-write-parent-create-failed:{err}"));
        }
        // No-follow: a component swapped for a symlink / reparse point is
        // refused, never followed. This is the step the previous pathname
        // design could not do.
        dir = match dir.open_child_nofollow(name) {
            Ok(next) => next,
            Err(err) => {
                return if confined::is_redirect_refusal(&err) {
                    Ok(DurableWriteResult::blocked("durable-write-parent-symlink"))
                } else {
                    Err(format!("durable-write-parent-open-failed:{err}"))
                };
            }
        };
    }

    let mut replaced = false;
    match dir.stat_child_nofollow(file_name) {
        Ok(Some(st)) => {
            // A symlink or a non-regular entry at the destination is refused
            // under every policy: replacing it would write through the link.
            if confined::is_symlink(&st) {
                return Ok(DurableWriteResult::blocked(
                    "durable-write-destination-symlink",
                ));
            }
            if !confined::is_regular(&st) {
                return Ok(DurableWriteResult::blocked(
                    "durable-write-destination-not-regular-file",
                ));
            }
            if existing == ExistingPolicy::Fail {
                return Ok(DurableWriteResult::blocked(
                    "durable-write-destination-exists",
                ));
            }
            replaced = true;
        }
        Ok(None) => {}
        Err(err) => return Err(format!("durable-write-destination-stat-failed:{err}")),
    }

    // Stage inside the destination directory descriptor so the promotion is a
    // same-directory namespace insertion and can never degrade into a copy.
    let StagedFile {
        handle: mut staged_handle,
        name: staged_name,
    } = stage_for(&dir, existing, &report)?;
    let staged_name = staged_name.as_deref();
    let owned = match confined::file_identity(&staged_handle) {
        Ok(identity) => identity,
        Err(err) => {
            // The name was created by this operation an instant ago and no
            // identity could be read; a plain removal of the private name is
            // the only cleanup available and touches nothing foreign-shaped.
            if let Some(name) = staged_name {
                let _ = dir.unlink_child(name);
            }
            return Err(format!("durable-write-temp-identity-failed:{err}"));
        }
    };

    use std::io::Write;
    let full_fsync = match staged_handle
        .write_all(bytes)
        .and_then(|_| sync_file_contents(&staged_handle))
    {
        Ok(full_fsync) => full_fsync,
        Err(err) => {
            drop(staged_handle);
            cleanup_staged(&dir, staged_name, owned);
            return Err(format!("durable-write-temp-write-failed:{err}"));
        }
    };

    // Create-only promotion must be atomic: the earlier `stat_child_nofollow`
    // only narrows the window, it cannot close it. Two writers that both saw an
    // absent destination would both insert, both report success, and one
    // payload would be silently destroyed. The staged handle stays open across
    // the namespace operation so the object it names can be re-identified
    // afterwards (class H′) — a swap of the staging NAME between the fence and
    // a pathname-bound rename can then never be reported as success.
    match existing {
        ExistingPolicy::Fail => {
            let inserted = match staged_name {
                // Anonymous inode (Linux): the descriptor IS the source.
                None => dir
                    .publish_file_by_handle_spelled(&staged_handle, file_name, report.link_spelling)
                    .map(|(inserted, _)| inserted),
                // Named staging: macOS renames the name exclusively (H′
                // below proves the object); Windows renames the HANDLE.
                Some(name) => {
                    if cfg!(target_os = "macos") {
                        dir.promote_exclusive(name, file_name)
                    } else {
                        dir.publish_file_by_handle(&staged_handle, file_name)
                    }
                }
            };
            match inserted {
                Ok(true) => {}
                Ok(false) => {
                    drop(staged_handle);
                    cleanup_staged(&dir, staged_name, owned);
                    return Ok(DurableWriteResult::blocked(
                        "durable-write-destination-exists",
                    ));
                }
                Err(err) => {
                    drop(staged_handle);
                    cleanup_staged(&dir, staged_name, owned);
                    if err.kind() == std::io::ErrorKind::Unsupported {
                        return Ok(DurableWriteResult::blocked(
                            "durable-write-unsupported-platform",
                        ));
                    }
                    return Err(format!("durable-write-promote-failed:{err}"));
                }
            }
        }
        ExistingPolicy::Replace => {
            let name = staged_name.expect("repair stages under a name");
            if let Err(err) = dir.replace_within(&staged_handle, name, file_name) {
                drop(staged_handle);
                cleanup_staged(&dir, staged_name, owned);
                if err.kind() == std::io::ErrorKind::Unsupported {
                    return Ok(DurableWriteResult::blocked(
                        "durable-write-unsupported-platform",
                    ));
                }
                return Err(format!("durable-write-promote-failed:{err}"));
            }
        }
    }

    // Class H′: the object now under the final name must be the object that
    // was written and fenced. Windows staging handles are opened without
    // sharing, so the retained handle is released BEFORE the cross-check
    // open; the identity was recorded from it while it was held.
    drop(staged_handle);
    let published = match dir.stat_child_nofollow(file_name) {
        Ok(Some(st)) if st.identity() == owned && st.is_regular() => true,
        Ok(_) => false,
        Err(err) => return Err(format!("durable-write-publication-stat-failed:{err}")),
    };
    if !published {
        // The namespace insertion happened, but a foreign object now stands
        // under the final name. It is left for trusted classification, never
        // removed; only this operation's own staging name is cleaned, and
        // only while it still names the object this operation created.
        cleanup_staged(&dir, staged_name, owned);
        let mut result = DurableWriteResult::blocked("durable-write-publication-identity-mismatch");
        result.detail = Some(format!(
            "final name does not identify the fenced object: {}",
            String::from_utf8_lossy(file_name)
        ));
        return Ok(result);
    }
    // Named staging on macOS was moved by the rename; on Windows the handle
    // was renamed. Either way the staging name no longer resolves to the
    // object, and an identity-checked cleanup therefore touches nothing.
    cleanup_staged(&dir, staged_name, owned);

    // Past this point the destination HAS changed. A sync failure is reported
    // as an incomplete-durability commit, never as "nothing happened".
    let mut result = DurableWriteResult {
        schema: DURABLE_WRITE_SCHEMA,
        ok: false,
        committed: true,
        durability_complete: false,
        replaced,
        byte_length: bytes.len() as u64,
        full_fsync,
        blockers: vec![],
        detail: None,
    };
    match sync_dir(&dir) {
        Ok(()) => {
            result.ok = true;
            result.durability_complete = true;
        }
        Err(err) => {
            result
                .blockers
                .push(DurableWriteBlocker::new("durable-write-parent-sync-failed"));
            result.detail = Some(err.to_string());
        }
    }
    Ok(result)
}

/// Lowercase hex SHA-256 of `bytes`.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest.iter() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Normalizes a caller-asserted content hash to bare lowercase hex.
///
/// Accepts `sha256-<64 hex>` or a bare `<64 hex>`, both lowercase-normalized.
/// Anything else is rejected — this value is never used to build a path, only
/// to refuse a mismatch.
pub(crate) fn normalize_expected_sha(input: &str) -> Option<String> {
    let trimmed = input.trim().to_ascii_lowercase();
    let hex = trimmed.strip_prefix("sha256-").unwrap_or(&trimmed);
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(hex.to_string())
    } else {
        None
    }
}

/// Reads at most `limit + 1` bytes from a child file, so a wrong object cannot
/// force an unbounded allocation. Returns `None` when the child is absent.
fn read_child_bounded(
    dir: &confined::Dir,
    name: &[u8],
    limit: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut file = match dir.open_child_read_nofollow(name) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        // A symlink / reparse point standing at the destination is refused by
        // the no-follow open, never followed.
        Err(err) => return Err(format!("cas-repair-existing-open-failed:{err}")),
    };
    let buf = confined::read_bounded(&mut file, limit)
        .map_err(|err| format!("cas-repair-existing-read-failed:{err}"))?;
    Ok(Some(buf))
}

/// Repairs the content-addressed object for `bytes`.
///
/// THE CALLER SUPPLIES NO DESTINATION. This module hashes `bytes` itself and
/// derives `assets/<aa>/sha256-<hex>` from its own digest, so a caller cannot
/// redirect the write to another hash, another shard, a package member, a
/// manifest, a snapshot, or any other archive path. `expected_sha256`, when
/// present, can only cause a refusal.
///
/// Replacement happens only when an object is already standing at that exact
/// derived path AND is proven not to be the content its own name claims.
pub fn cas_repair_write_within_root(
    root: &Path,
    bytes: &[u8],
    expected_sha256: Option<&str>,
) -> Result<CasRepairResult, String> {
    use confined::Dir;

    // DP-PRE-M05-ASSET-BOUND: refuse before hashing, shard creation, the
    // existing-object read, or any replacement.
    if bytes.len() as u64 > GOVERNED_ASSET_BLOB_CAP_BYTES {
        return Ok(CasRepairResult::blocked("cas-repair-asset-too-large"));
    }

    let hex = sha256_hex(bytes);

    if let Some(asserted) = expected_sha256 {
        match normalize_expected_sha(asserted) {
            None => {
                return Ok(CasRepairResult::blocked(
                    "cas-repair-expected-sha-malformed",
                ))
            }
            // The bytes are the authority; a mismatching assertion is refused
            // rather than honoured.
            Some(normalized) if normalized != hex => {
                return Ok(CasRepairResult::blocked("cas-repair-expected-sha-mismatch"))
            }
            Some(_) => {}
        }
    }

    let shard = &hex[0..2];
    let basename = format!("sha256-{hex}");
    let relative = format!("{CAS_DIR}/{shard}/{basename}");
    let mut result = CasRepairResult::skeleton(basename.clone(), relative.clone());

    // Walk to the shard directory through admitted descriptors only.
    let mut dir =
        Dir::open_root(root).map_err(|err| format!("cas-repair-root-open-failed:{err}"))?;
    for name in [CAS_DIR.as_bytes(), shard.as_bytes()] {
        dir.mkdir_child(name)
            .map_err(|err| format!("cas-repair-shard-create-failed:{err}"))?;
        dir = match dir.open_child_nofollow(name) {
            Ok(next) => next,
            Err(err) => {
                return if confined::is_redirect_refusal(&err) {
                    Ok(CasRepairResult::blocked("cas-repair-shard-symlink"))
                } else {
                    Err(format!("cas-repair-shard-open-failed:{err}"))
                }
            }
        };
    }

    let basename_bytes = basename.as_bytes();
    match read_child_bounded(&dir, basename_bytes, bytes.len())? {
        None => {
            // Nothing to repair. Create it, but never silently "repair" an
            // absent object into existence without saying so.
            let write = durable_write_impl(root, &relative, bytes, ExistingPolicy::Fail)?;
            result.committed = write.committed;
            result.durability_complete = write.durability_complete;
            result.byte_length = write.byte_length;
            result.full_fsync = write.full_fsync;
            result.blockers = write.blockers;
            result.detail = write.detail;
            result.ok = write.ok;
            return Ok(result);
        }
        Some(existing) if existing.len() == bytes.len() && sha256_hex(&existing) == hex => {
            // The canonical object is already exactly right; touch nothing.
            result.ok = true;
            result.already_valid = true;
            result.byte_length = bytes.len() as u64;
            return Ok(result);
        }
        Some(_) => {}
    }

    // Proven mismatching: supersede it with the bytes this module hashed.
    let write = durable_write_impl(root, &relative, bytes, ExistingPolicy::Replace)?;
    result.committed = write.committed;
    result.durability_complete = write.durability_complete;
    result.repaired = write.committed;
    result.byte_length = write.byte_length;
    result.full_fsync = write.full_fsync;
    result.blockers = write.blockers;
    result.detail = write.detail;
    result.ok = write.ok;
    Ok(result)
}

/// Resolves the app-owned archive root. This must agree with the renderer's
/// `BaseDirectory::AppLocalData` (15) + `archive/...` convention, so it uses
/// Tauri's own resolver rather than rebuilding a path from the product name.
#[cfg(not(h2o_saved_chat_primitive_harness))]
pub(crate) fn archive_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("durable-write-app-local-data-unavailable:{err}"))?;
    Ok(base.join(ARCHIVE_ROOT))
}

/// Length of the raw invoke body WITHOUT materializing a copy, so an oversized
/// payload is refused before the `clone` in `body_bytes` doubles it.
#[cfg(not(h2o_saved_chat_primitive_harness))]
fn body_len(request: &tauri::ipc::Request<'_>) -> Result<usize, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => Ok(data.len()),
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(data)) => Ok(data.len()),
        _ => Err("durable-write-body-unexpected".to_string()),
    }
}

/// Extracts the raw invoke body as bytes, mirroring `plugin:fs|write_file`'s
/// marshaling so a multi-megabyte asset is not expanded into a JSON number
/// array.
#[cfg(not(h2o_saved_chat_primitive_harness))]
pub(crate) fn body_bytes(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => Ok(data.clone()),
        tauri::ipc::InvokeBody::Json(serde_json::Value::Array(data)) => data
            .iter()
            .map(|value| {
                value
                    .as_u64()
                    .filter(|byte| *byte <= u8::MAX as u64)
                    .map(|byte| byte as u8)
                    .ok_or_else(|| "durable-write-body-not-bytes".to_string())
            })
            .collect::<Result<Vec<u8>, String>>(),
        _ => Err("durable-write-body-unexpected".to_string()),
    }
}

/// Reads and parses the percent-encoded JSON `options` request header.
#[cfg(not(h2o_saved_chat_primitive_harness))]
fn parse_options_header<T: serde::de::DeserializeOwned>(raw: &[u8]) -> Result<T, String> {
    let decoded = percent_encoding::percent_decode(raw)
        .decode_utf8()
        .map_err(|_| "durable-write-options-not-utf8".to_string())?;
    serde_json::from_str(&decoded).map_err(|err| format!("durable-write-options-invalid:{err}"))
}

/// Required `options` header.
#[cfg(not(h2o_saved_chat_primitive_harness))]
pub(crate) fn required_options<T: serde::de::DeserializeOwned>(
    request: &tauri::ipc::Request<'_>,
) -> Result<T, String> {
    let raw = request
        .headers()
        .get("options")
        .ok_or_else(|| "durable-write-options-missing".to_string())?;
    parse_options_header(raw.as_ref())
}

/// Optional `options` header; an absent header yields the default.
#[cfg(not(h2o_saved_chat_primitive_harness))]
fn optional_options<T: serde::de::DeserializeOwned + Default>(
    request: &tauri::ipc::Request<'_>,
) -> Result<T, String> {
    match request.headers().get("options") {
        Some(raw) => parse_options_header(raw.as_ref()),
        None => Ok(T::default()),
    }
}

/// Durable archive write. CREATE-ONLY.
///
/// There is deliberately no way for a caller to request replacement of an
/// existing archive member here; an occupied destination is refused.
#[cfg(not(h2o_saved_chat_primitive_harness))]
#[tauri::command]
pub async fn h2o_archive_durable_write(
    app: tauri::AppHandle,
    gate: tauri::State<'_, crate::archive_instance_lock::ArchiveInstanceState>,
    request: tauri::ipc::Request<'_>,
) -> Result<DurableWriteResult, String> {
    // M06 T1.1: every trusted archive mutation participates in the in-process
    // gate for the duration of THIS invoke only. Held here, released on return.
    let _mutation = crate::archive_instance_lock::enter_mutation_for(&app, &gate)?;
    let options: DurableWriteOptions = required_options(&request)?;
    if body_len(&request)? as u64 > GOVERNED_ASSET_BLOB_CAP_BYTES {
        return Ok(DurableWriteResult::blocked("durable-write-asset-too-large"));
    }
    let bytes = body_bytes(&request)?;
    let root = archive_root(&app)?;
    durable_write_within_root(&root, &options.path, &bytes)
}

/// Content-addressed repair write.
///
/// Takes BYTES ONLY. The destination is derived inside this command from the
/// SHA-256 this command computes over those bytes, so the renderer has no way
/// to name, redirect or influence which file is written. The optional
/// `expectedSha256` header is a caller assertion that can only cause a refusal.
#[cfg(not(h2o_saved_chat_primitive_harness))]
#[tauri::command]
pub async fn h2o_archive_cas_repair_write(
    app: tauri::AppHandle,
    gate: tauri::State<'_, crate::archive_instance_lock::ArchiveInstanceState>,
    request: tauri::ipc::Request<'_>,
) -> Result<CasRepairResult, String> {
    let _mutation = crate::archive_instance_lock::enter_mutation_for(&app, &gate)?;
    let options: CasRepairOptions = optional_options(&request)?;
    if body_len(&request)? as u64 > GOVERNED_ASSET_BLOB_CAP_BYTES {
        return Ok(CasRepairResult::blocked("cas-repair-asset-too-large"));
    }
    let bytes = body_bytes(&request)?;
    let root = archive_root(&app)?;
    cas_repair_write_within_root(&root, &bytes, options.expected_sha256.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Hand-rolled scratch root, matching the crate's existing convention of
    /// PID-suffixed temp paths rather than pulling in a temp-dir dependency.
    fn scratch_base(name: &str) -> PathBuf {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "h2o-durable-write-{name}-{}-{counter}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch base");
        dir
    }

    /// Returns (base, root) where root is `<base>/archive`.
    fn scratch_root(name: &str) -> (PathBuf, PathBuf) {
        let base = scratch_base(name);
        let root = base.join(ARCHIVE_ROOT);
        (base, root)
    }

    fn blocker_codes<T: AsRef<[DurableWriteBlocker]>>(blockers: T) -> Vec<String> {
        blockers.as_ref().iter().map(|b| b.code.clone()).collect()
    }

    fn sha_hex(bytes: &[u8]) -> String {
        sha256_hex(bytes)
    }

    fn cas_relative(bytes: &[u8]) -> String {
        let hex = sha_hex(bytes);
        format!("{CAS_DIR}/{}/sha256-{hex}", &hex[0..2])
    }

    /// Any file under `dir` whose name carries the staging prefix.
    fn temp_artifacts(dir: &Path) -> Vec<PathBuf> {
        let mut found = vec![];
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            let Ok(entries) = fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if entry.file_name().to_string_lossy().starts_with(TEMP_PREFIX) {
                    found.push(path);
                }
            }
        }
        found
    }

    // ── Create-only durable write ──────────────────────────────────────────

    /// T02 (contract §12): Windows reserved device stems are refused on
    /// every platform, as the whole name and as the segment before the first
    /// `.`; ordinary names and names merely CONTAINING a stem are not.
    #[test]
    fn reserved_device_stems_are_refused_on_every_platform() {
        for refused in [
            "CON",
            "con",
            "Con",
            "PRN",
            "AUX",
            "NUL",
            "COM0",
            "com1",
            "COM9",
            "LPT0",
            "lpt5",
            "LPT9",
            "CON.h2ochat",
            "nul.h2ochat.zip",
            "com7.g0123.h2ochat",
            "AUX.tmp-0",
        ] {
            assert!(
                has_reserved_device_stem(refused),
                "{refused} must be refused"
            );
        }
        for admitted in [
            "",
            "CONSOLE",
            "console.h2ochat",
            "COM10",
            "LPT",
            "COMX",
            "nulls",
            "prn-1",
            "chat.CON",
            ".CON",
            "a.NUL.b",
            "round-trip.h2ochat",
            "com",
            "lpt10.h2ochat",
        ] {
            assert!(
                !has_reserved_device_stem(admitted),
                "{admitted} must be admitted"
            );
        }
    }

    /// T02 (contract §11.3): the wire schema of a durable-write result is
    /// unchanged — no field was added to express platform durability and
    /// `fullFsync` keeps its macOS-fence meaning.
    #[test]
    fn durable_write_result_wire_keys_are_unchanged() {
        let blocked = serde_json::to_value(DurableWriteResult::blocked("x")).unwrap();
        let mut keys: Vec<_> = blocked.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "blockers",
                "byteLength",
                "committed",
                "durabilityComplete",
                "fullFsync",
                "ok",
                "replaced",
                "schema",
            ]
        );
        let repair = serde_json::to_value(CasRepairResult::blocked("x")).unwrap();
        let mut keys: Vec<_> = repair.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "alreadyValid",
                "blockers",
                "byteLength",
                "committed",
                "durabilityComplete",
                "fullFsync",
                "ok",
                "path",
                "repaired",
                "schema",
                "sha256",
            ]
        );
    }

    /// T02 (class L): identity-checked cleanup removes a name only while it
    /// still resolves to the object this operation created; a foreign object
    /// standing under that name is left byte-for-byte untouched.
    #[test]
    fn identity_checked_cleanup_never_removes_a_foreign_object() {
        let (base, root) = scratch_root("identity-cleanup");
        let dir = confined::Dir::open_root(&root).expect("root");
        let owned_file = dir.create_new_child(b"owned").expect("owned");
        let owned = confined::file_identity(&owned_file).expect("identity");
        drop(owned_file);
        // Swap the name for a different object of the same kind.
        fs::remove_file(root.join("owned")).unwrap();
        fs::write(root.join("owned"), b"foreign-bytes").unwrap();
        assert_eq!(
            dir.unlink_child_if_identity(b"owned", owned).unwrap(),
            false
        );
        assert_eq!(fs::read(root.join("owned")).unwrap(), b"foreign-bytes");
        // The identity-matching case does remove, exactly once.
        let again = dir.create_new_child(b"mine").expect("mine");
        let mine = confined::file_identity(&again).expect("identity");
        drop(again);
        assert_eq!(dir.unlink_child_if_identity(b"mine", mine).unwrap(), true);
        assert!(!root.join("mine").exists());
        assert_eq!(dir.unlink_child_if_identity(b"mine", mine).unwrap(), false);
        // Directories: same rule.
        dir.mkdir_child_exclusive(b"stage").expect("stage");
        let stage = dir.open_child_nofollow(b"stage").expect("open stage");
        let stage_identity = stage.identity().expect("identity");
        drop(stage);
        fs::remove_dir(root.join("stage")).unwrap();
        fs::create_dir(root.join("stage")).unwrap();
        fs::write(root.join("stage").join("foreign"), b"x").unwrap();
        assert_eq!(
            dir.unlink_child_dir_if_identity(b"stage", stage_identity)
                .unwrap(),
            false
        );
        assert!(root.join("stage").join("foreign").exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn writes_exact_bytes_and_leaves_no_temp_artifact() {
        let (base, root) = scratch_root("happy");
        let relative = cas_relative(b"happy");
        let result = durable_write_within_root(&root, &relative, b"hello").expect("write");

        assert!(result.ok);
        assert!(result.committed);
        assert!(result.durability_complete);
        assert!(!result.replaced);
        assert_eq!(result.byte_length, 5);
        assert_eq!(fs::read(root.join(&relative)).unwrap(), b"hello");
        assert!(temp_artifacts(&root).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    /// Machinery-level: the internal impl (which the CAS repair path drives
    /// with derived destinations) can create arbitrary-depth ancestors. The
    /// renderer-reachable command cannot reach such paths — see the authority
    /// matrix test below.
    #[test]
    fn machinery_creates_nested_directories() {
        let (base, root) = scratch_root("nested");
        let result = durable_write_impl(
            &root,
            "packages/a.h2ochat/nested/deeper/manifest.json",
            b"{}",
            ExistingPolicy::Fail,
        )
        .expect("write");
        assert!(result.ok);
        assert!(root
            .join("packages/a.h2ochat/nested/deeper/manifest.json")
            .is_file());
        let _ = fs::remove_dir_all(&base);
    }

    /// The renderer-reachable create surface admits exactly one shape:
    /// `assets/<aa>/sha256-<64 lowercase hex>` with a matching shard. Every
    /// other archive destination the machinery could write is refused here.
    #[test]
    fn create_only_command_admits_only_canonical_cas_blobs() {
        let (base, root) = scratch_root("authority");
        let hex = sha_hex(b"authority-probe");
        let refused: Vec<String> = vec![
            "packages/a.h2ochat/manifest.json".to_string(),
            "packages/a.h2ochat/snapshot.json".to_string(),
            format!("packages/a.h2ochat/assets/sha256-{hex}.png"),
            "manifest.json".to_string(),
            "snapshot.json".to_string(),
            "assets".to_string(),
            "assets/aa".to_string(),
            "assets/aa/blob".to_string(),
            format!("assets/zz/sha256-{hex}"),
            // A VALID-hex shard that simply is not hex[0..2] — this is the
            // entry that reaches the shard-match comparison itself (a non-hex
            // shard like "zz" is refused earlier by the hex check).
            format!(
                "assets/{}/sha256-{hex}",
                if &hex[0..2] == "00" { "11" } else { "00" }
            ),
            format!("assets/AA/sha256-{hex}"),
            format!("assets/{}/sha256-{}", &hex[0..2], hex.to_uppercase()),
            format!("assets/{}/sha256-{}", &hex[0..2], &hex[0..40]),
            format!("assets/{}/extra/sha256-{hex}", &hex[0..2]),
            format!("assets/{}/{hex}", &hex[0..2]),
        ];
        for relative in &refused {
            let result = durable_write_within_root(&root, relative, b"x").expect("call");
            assert!(!result.ok, "{relative} must be refused");
            assert!(!result.committed, "{relative} must not commit");
            assert_eq!(
                blocker_codes(&result.blockers),
                vec!["durable-write-path-outside-cas".to_string()],
                "{relative}"
            );
            assert!(
                !root.join(relative).exists(),
                "{relative} must not be created"
            );
        }
        // Nothing was created at all — no shard dirs, no packages dir.
        assert!(!root.join("packages").exists());

        let admitted = cas_relative(b"authority-probe");
        let result = durable_write_within_root(&root, &admitted, b"x").expect("write");
        assert!(result.ok, "the canonical CAS shape must remain admitted");
        assert!(root.join(&admitted).is_file());
        let _ = fs::remove_dir_all(&base);
    }

    /// The reservation must be EXACT for the two M06 identities and PREFIX for
    /// the staging families -- and each must stay in its own shape. A prefix
    /// reservation for `.h2o-archive.lock` would silently seize unrelated
    /// neighbouring names; an exact reservation for `.h2o-durable-` would let
    /// every minted staging name through.
    #[test]
    fn m06_identities_reserve_exact_components_not_prefix_families() {
        // Exact identities are reserved.
        assert!(is_reserved_component(".h2o-archive.lock"));
        assert!(is_reserved_component(".h2o-reclaim"));

        // ...and do NOT over-reserve names that merely begin the same way.
        for neighbour in [
            ".h2o-archive.lock.bak",
            ".h2o-archive.locked",
            ".h2o-reclaimed",
            ".h2o-reclaim-notes",
        ] {
            assert!(
                !is_reserved_component(neighbour),
                "{neighbour} must NOT be reserved: exact-component authority, \
                 not a prefix family"
            );
        }

        // The staging families stay prefix-shaped, because they mint
        // `<prefix><unique>` names.
        assert!(is_reserved_component(".h2o-durable-1-0.tmp"));
        assert!(is_reserved_component(".h2o-genstage-0011"));

        // Ordinary archive content is untouched by the reservation.
        for ordinary in ["packages", "assets", "chat.g0.h2ochat", "sha256-ab"] {
            assert!(!is_reserved_component(ordinary), "{ordinary}");
        }
    }

    /// The reserved lock component must never drift from the file T1.1 creates.
    #[test]
    fn the_reserved_lock_component_is_the_one_t11_actually_creates() {
        assert_eq!(
            ARCHIVE_LOCK_COMPONENT,
            crate::archive_instance_lock::ARCHIVE_LOCK_NAME,
            "reservation and lock authority must share ONE literal"
        );
    }

    /// Neither reserved identity can be classified as a CAS object: the CAS
    /// shape is exactly `assets/<aa>/sha256-<64 lowercase hex>`.
    #[test]
    fn reserved_identities_can_never_be_cas_objects() {
        for reserved in RESERVED_EXACT_COMPONENTS {
            for shape in [
                vec![reserved.as_bytes().to_vec()],
                vec![CAS_DIR.as_bytes().to_vec(), reserved.as_bytes().to_vec()],
                vec![
                    CAS_DIR.as_bytes().to_vec(),
                    b"ab".to_vec(),
                    reserved.as_bytes().to_vec(),
                ],
            ] {
                assert_eq!(
                    assert_cas_blob_shape(&shape).err(),
                    Some("durable-write-path-outside-cas"),
                    "{reserved} must never satisfy the CAS blob shape"
                );
            }
        }
    }

    #[test]
    fn rejects_traversal_absolute_and_malformed_destinations() {
        let (base, root) = scratch_root("reject");
        let cases: Vec<(&str, &str)> = vec![
            ("", "durable-write-path-empty"),
            ("../escape", "durable-write-path-traversal"),
            ("assets/../../escape", "durable-write-path-traversal"),
            ("./assets/x", "durable-write-path-invalid"),
            ("with\0nul", "durable-write-path-invalid"),
            (".h2o-durable-1-0.tmp", "durable-write-path-reserved"),
            // M06 T1.2 reserved identities, and the preserved M05 staging one.
            (".h2o-archive.lock", "durable-write-path-reserved"),
            (".h2o-reclaim", "durable-write-path-reserved"),
            // A reserved EXACT component also seals everything beneath it,
            // because every component is validated independently.
            (".h2o-reclaim/run-1/receipt.json", "durable-write-path-reserved"),
            ("assets/.h2o-reclaim/x", "durable-write-path-reserved"),
            (".h2o-genstage-1/snapshot.json", "durable-write-path-reserved"),
        ];
        for (relative, expected) in cases {
            let result = durable_write_within_root(&root, relative, b"x").expect("call");
            assert!(!result.ok, "{relative} must be refused");
            assert!(!result.committed, "{relative} must not commit");
            assert_eq!(
                blocker_codes(&result.blockers),
                vec![expected.to_string()],
                "{relative}"
            );
        }

        let absolute = root.join("absolute.bin");
        let result =
            durable_write_within_root(&root, absolute.to_str().unwrap(), b"x").expect("call");
        assert!(!result.ok);
        assert_eq!(
            blocker_codes(&result.blockers),
            vec!["durable-write-path-not-relative".to_string()]
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn no_refused_destination_creates_anything_outside_the_root() {
        let (base, root) = scratch_root("outside");
        let witness = base.join("outside-witness.txt");
        let _ = fs::remove_file(&witness);

        let result =
            durable_write_within_root(&root, "../outside-witness.txt", b"x").expect("call");

        assert!(!result.ok);
        assert!(
            !witness.exists(),
            "traversal must not create a file outside the root"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// The generic write surface is create-only. There is no caller-reachable
    /// replacement authority at all.
    #[test]
    fn an_existing_destination_is_always_refused_and_never_replaced() {
        let (base, root) = scratch_root("create-only");
        let relative = cas_relative(b"create-only");
        durable_write_within_root(&root, &relative, b"first").expect("seed");

        let refused = durable_write_within_root(&root, &relative, b"second").expect("call");
        assert!(!refused.ok);
        assert!(!refused.committed, "a refusal must not commit");
        assert_eq!(
            blocker_codes(&refused.blockers),
            vec!["durable-write-destination-exists".to_string()]
        );
        assert_eq!(fs::read(root.join(&relative)).unwrap(), b"first");
        assert!(temp_artifacts(&root).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    /// A renderer cannot smuggle replacement in through the options header:
    /// the deserialized options type has no such field, so an `existing` key is
    /// simply not part of the contract and the write stays create-only.
    #[test]
    fn the_write_options_contract_exposes_no_replacement_field() {
        let relative = cas_relative(b"no-replace-field");
        let parsed: DurableWriteOptions =
            serde_json::from_str(&format!(r#"{{"path":"{relative}","existing":"replace"}}"#))
                .expect("options parse");
        assert_eq!(parsed.path, relative);

        // Proof by construction: the only public entry point takes no policy.
        let (base, root) = scratch_root("no-replace-field");
        durable_write_within_root(&root, &parsed.path, b"first").expect("seed");
        let second = durable_write_within_root(&root, &parsed.path, b"second").expect("call");
        assert!(!second.ok, "an `existing` key must not enable replacement");
        assert_eq!(fs::read(root.join(&parsed.path)).unwrap(), b"first");
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_persistent_symlinked_ancestor_and_a_symlinked_destination() {
        let (base, root) = scratch_root("symlink");
        let outside = base.join("outside");
        fs::create_dir_all(&outside).expect("outside dir");
        let victim = outside.join("victim.txt");
        fs::write(&victim, b"original").expect("victim");

        // Destination symlink standing at a canonical CAS name.
        let dest = cas_relative(b"symlink-dest");
        fs::create_dir_all(root.join(&dest).parent().unwrap()).expect("shard");
        std::os::unix::fs::symlink(&victim, root.join(&dest)).expect("file symlink");
        let result = durable_write_within_root(&root, &dest, b"pwned").expect("call");
        assert!(!result.ok);
        assert_eq!(
            blocker_codes(&result.blockers),
            vec!["durable-write-destination-symlink".to_string()]
        );
        assert_eq!(fs::read(&victim).unwrap(), b"original");

        // A symlinked SHARD directory is refused on the narrowed surface.
        let sharded = cas_relative(b"symlink-shard");
        let shard_parent = root.join(&sharded);
        std::os::unix::fs::symlink(&outside, shard_parent.parent().unwrap())
            .expect("shard symlink");
        let via_shard = durable_write_within_root(&root, &sharded, b"pwned").expect("call");
        assert!(!via_shard.ok);
        assert_eq!(
            blocker_codes(&via_shard.blockers),
            vec!["durable-write-parent-symlink".to_string()]
        );

        // Machinery-level: an arbitrary symlinked ancestor is refused too.
        std::os::unix::fs::symlink(&outside, root.join("hop")).expect("dir symlink");
        let via_dir = durable_write_impl(&root, "hop/planted.txt", b"pwned", ExistingPolicy::Fail)
            .expect("call");
        assert!(!via_dir.ok);
        assert_eq!(
            blocker_codes(&via_dir.blockers),
            vec!["durable-write-parent-symlink".to_string()]
        );
        assert!(!outside.join("planted.txt").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_standing_where_the_archive_root_belongs() {
        let base = scratch_base("root-symlink");
        let outside = base.join("outside");
        fs::create_dir_all(&outside).expect("outside");
        std::os::unix::fs::symlink(&outside, base.join(ARCHIVE_ROOT)).expect("root symlink");

        let root = base.join(ARCHIVE_ROOT);
        let relative = cas_relative(b"root-symlink");
        let result = durable_write_within_root(&root, &relative, b"x");

        assert!(
            result.is_err(),
            "a symlinked archive root must not be admitted"
        );
        assert!(
            !outside.join("assets").exists(),
            "nothing may be created through the link"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn refuses_a_directory_standing_where_the_file_belongs() {
        let (base, root) = scratch_root("dir-dest");
        let relative = cas_relative(b"dir-dest");
        fs::create_dir_all(root.join(&relative)).expect("dir");
        let result = durable_write_within_root(&root, &relative, b"x").expect("call");
        assert!(!result.ok);
        assert_eq!(
            blocker_codes(&result.blockers),
            vec!["durable-write-destination-not-regular-file".to_string()]
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_staging_write_leaves_the_canonical_destination_intact() {
        use std::os::unix::fs::PermissionsExt;

        let (base, root) = scratch_root("stage-fail");
        let bytes = b"stage-fail-payload";
        let relative = cas_relative(bytes);
        let shard = root.join(&relative);
        let shard = shard.parent().unwrap().to_path_buf();

        // A corrupt object stands at the canonical hash-derived path, so the
        // repair path will attempt a replacement — whose staging then fails.
        fs::create_dir_all(&shard).expect("shard");
        fs::write(root.join(&relative), b"corrupt-before").expect("corrupt seed");

        let original = fs::metadata(&shard).unwrap().permissions();
        let mut locked = original.clone();
        locked.set_mode(0o500);
        fs::set_permissions(&shard, locked).expect("lock");

        let result = cas_repair_write_within_root(&root, bytes, None);

        fs::set_permissions(&shard, original).expect("unlock");

        let err = result.expect_err("a staging failure must surface");
        assert!(
            err.contains("durable-write-temp"),
            "unexpected error: {err}"
        );
        // The canonical destination is exactly as it was: untouched, un-fixed.
        assert_eq!(fs::read(root.join(&relative)).unwrap(), b"corrupt-before");
        assert!(temp_artifacts(&root).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn zero_byte_writes_are_permitted_and_durable() {
        let (base, root) = scratch_root("empty");
        let relative = cas_relative(b"empty-tag");
        let result = durable_write_within_root(&root, &relative, b"").expect("write");
        assert!(result.ok);
        assert_eq!(result.byte_length, 0);
        assert_eq!(fs::read(root.join(&relative)).unwrap(), Vec::<u8>::new());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn contents_are_synced_and_the_parent_entry_is_synced() {
        let (base, root) = scratch_root("sync");
        let relative = cas_relative(b"sync-tag");
        let result = durable_write_within_root(&root, &relative, b"bytes").expect("write");
        assert!(result.ok);
        assert!(
            result.durability_complete,
            "the parent directory must be synced"
        );
        if cfg!(target_os = "macos") {
            assert!(
                result.full_fsync,
                "macOS write should establish the F_FULLFSYNC guarantee"
            );
        }
        let _ = fs::remove_dir_all(&base);
    }

    // ── Post-commit durability honesty (Y2) ────────────────────────────────

    /// A directory sync that fails AFTER the rename must not be reported as
    /// "nothing happened": the bytes really are in place.
    #[test]
    fn a_post_promotion_sync_failure_reports_committed_but_not_durable() {
        let (base, root) = scratch_root("post-sync-fail");
        let result = durable_write_impl_with(
            &root,
            "assets/aa/blob",
            b"committed",
            ExistingPolicy::Fail,
            |_| Err(std::io::Error::other("simulated directory sync failure")),
        )
        .expect("must not surface as Err");

        assert!(result.committed, "the rename succeeded, so it is committed");
        assert!(!result.durability_complete);
        assert!(!result.ok, "ok requires full durability");
        assert_eq!(
            blocker_codes(&result.blockers),
            vec!["durable-write-parent-sync-failed".to_string()]
        );
        assert!(result.detail.is_some(), "the cause must be reported");
        // The bytes are genuinely on disk — this is why Err would have lied.
        assert_eq!(fs::read(root.join("assets/aa/blob")).unwrap(), b"committed");
        let _ = fs::remove_dir_all(&base);
    }

    // ── Private temp handling (Y3) ─────────────────────────────────────────

    /// Deterministic name sequence, so these tests do not race the
    /// process-global counter against tests running in parallel.
    fn fixed_names(tag: &str, count: u32) -> Vec<String> {
        (0..count)
            .map(|i| format!("{TEMP_PREFIX}{tag}-{i}{TEMP_SUFFIX}"))
            .collect()
    }

    #[test]
    fn a_colliding_private_temp_name_is_retried_and_the_foreign_artifact_is_kept() {
        let (base, root) = scratch_root("temp-collision");
        let shard = root.join(CAS_DIR).join("aa");
        fs::create_dir_all(&shard).expect("shard");

        let names = fixed_names("collide", 2);
        // Occupy the first name the sequence will offer.
        let planted = shard.join(&names[0]);
        fs::write(&planted, b"stale").expect("plant");

        let dir = confined::Dir::open_root(&root).expect("root");
        let shard_dir = dir
            .open_child_nofollow(CAS_DIR.as_bytes())
            .expect("assets")
            .open_child_nofollow(b"aa")
            .expect("aa");

        let mut it = names.iter();
        let (used, _file) =
            create_private_temp_with(&shard_dir, || it.next().unwrap().as_bytes().to_vec())
                .expect("collision must be retried, not fatal");

        assert_eq!(
            String::from_utf8(used).unwrap(),
            names[1],
            "the retry must advance to a fresh name"
        );
        assert!(
            planted.exists(),
            "a temp artifact this operation did not create must never be removed"
        );
        assert_eq!(fs::read(&planted).unwrap(), b"stale");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn exhausting_the_bounded_temp_retries_fails_cleanly() {
        let (base, root) = scratch_root("temp-exhausted");
        let shard = root.join(CAS_DIR).join("aa");
        fs::create_dir_all(&shard).expect("shard");

        // Occupy every name the bounded retry will try.
        let names = fixed_names("exhaust", TEMP_ATTEMPTS);
        for name in &names {
            fs::write(shard.join(name), b"stale").expect("plant");
        }

        let dir = confined::Dir::open_root(&root).expect("root");
        let shard_dir = dir
            .open_child_nofollow(CAS_DIR.as_bytes())
            .expect("assets")
            .open_child_nofollow(b"aa")
            .expect("aa");

        let mut it = names.iter();
        let result = create_private_temp_with(&shard_dir, || {
            it.next()
                .map(|n| n.as_bytes().to_vec())
                .unwrap_or_else(|| b"overflow".to_vec())
        });

        let err = result.expect_err("exhaustion must surface");
        assert!(
            err.starts_with("durable-write-temp-name-exhausted:"),
            "unexpected error: {err}"
        );
        for name in &names {
            assert!(
                shard.join(name).exists(),
                "foreign temp artifacts must survive"
            );
        }
        let _ = fs::remove_dir_all(&base);
    }

    // ── CAS repair authority (Y4) ──────────────────────────────────────────

    #[test]
    fn cas_repair_derives_its_own_destination_from_the_bytes_it_hashed() {
        let (base, root) = scratch_root("cas-derive");
        let bytes = b"authentic asset bytes";
        let expected = cas_relative(bytes);

        let result = cas_repair_write_within_root(&root, bytes, None).expect("repair");
        assert!(result.ok);
        assert_eq!(result.path, expected, "destination must be hash-derived");
        assert_eq!(result.sha256, format!("sha256-{}", sha_hex(bytes)));
        assert_eq!(fs::read(root.join(&expected)).unwrap(), bytes);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cas_repair_replaces_only_a_proven_mismatching_object() {
        let (base, root) = scratch_root("cas-repair");
        let bytes = b"authentic asset bytes";
        let relative = cas_relative(bytes);
        fs::create_dir_all(root.join(&relative).parent().unwrap()).expect("shard");

        // Corrupt object standing at the canonical path.
        fs::write(root.join(&relative), b"planted garbage").expect("corrupt");
        let repaired = cas_repair_write_within_root(&root, bytes, None).expect("repair");
        assert!(repaired.ok);
        assert!(repaired.repaired, "a mismatching object must be repaired");
        assert!(!repaired.already_valid);
        assert_eq!(fs::read(root.join(&relative)).unwrap(), bytes);

        // A correct object is left completely alone.
        let again = cas_repair_write_within_root(&root, bytes, None).expect("repair");
        assert!(again.ok);
        assert!(again.already_valid, "a valid object must not be rewritten");
        assert!(!again.repaired);
        assert!(
            !again.committed,
            "nothing may be committed for a valid object"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// Create-only must be atomic, not check-then-act. Two writers racing for
    /// the same absent destination must not both commit: exactly one wins and
    /// the loser is refused, so no committed payload is ever silently
    /// destroyed. A single-threaded existence test cannot prove this.
    #[test]
    fn concurrent_create_only_writers_cannot_both_commit() {
        use std::sync::{Arc, Barrier};

        let (base, root) = scratch_root("create-only-race");
        let mut both_committed = 0u32;
        let mut refusals = 0u32;

        for round in 0..300u32 {
            let relative = cas_relative(format!("contended-{round}").as_bytes());
            let barrier = Arc::new(Barrier::new(2));
            let handles: Vec<_> = [b"payload-a".as_slice(), b"payload-b".as_slice()]
                .into_iter()
                .map(|payload| {
                    let barrier = Arc::clone(&barrier);
                    let root = root.clone();
                    let relative = relative.clone();
                    let payload = payload.to_vec();
                    std::thread::spawn(move || {
                        barrier.wait();
                        durable_write_within_root(&root, &relative, &payload)
                    })
                })
                .collect();

            let results: Vec<_> = handles
                .into_iter()
                .map(|h| h.join().expect("writer thread"))
                .collect();
            let committed = results
                .iter()
                .filter(|r| matches!(r, Ok(result) if result.committed))
                .count();
            let refused = results
                .iter()
                .filter(|r| {
                    matches!(r, Ok(result)
                        if !result.committed
                            && blocker_codes(&result.blockers)
                                .contains(&"durable-write-destination-exists".to_string()))
                })
                .count();
            if committed > 1 {
                both_committed += 1;
            }
            refusals += refused as u32;

            // Whoever won, the destination holds one intact payload.
            let landed = fs::read(root.join(&relative)).expect("destination exists");
            assert!(
                landed == b"payload-a" || landed == b"payload-b",
                "destination must hold exactly one writer's payload"
            );
        }

        assert_eq!(
            both_committed, 0,
            "two writers must never both commit to the same create-only destination"
        );
        assert!(
            refusals > 0,
            "the race was never actually contended; the test proved nothing"
        );
        assert!(
            temp_artifacts(&root).is_empty(),
            "no staging litter may remain"
        );
        let _ = fs::remove_dir_all(&base);
    }

    // ── DP-PRE-M05-ASSET-BOUND (32 MiB per ingested asset) ─────────────────

    /// Exact boundary: one byte under and exactly at the cap are accepted.
    #[test]
    fn assets_at_and_just_under_the_governed_cap_are_accepted() {
        let (base, root) = scratch_root("bound-accept");
        // Pin the VALUE, not just the symbol: every other assertion here is
        // relative to the constant, so a drift to 8 MiB or 64 MiB would leave
        // the whole suite green while silently changing governed behaviour.
        assert_eq!(
            GOVERNED_ASSET_BLOB_CAP_BYTES, 33_554_432,
            "DP-PRE-M05-ASSET-BOUND governs 32 MiB per ingested asset"
        );
        for len in [
            GOVERNED_ASSET_BLOB_CAP_BYTES - 1,
            GOVERNED_ASSET_BLOB_CAP_BYTES,
        ] {
            let bytes = vec![0u8; len as usize];
            let relative = cas_relative(&bytes);
            let result = durable_write_within_root(&root, &relative, &bytes).expect("write");
            assert!(result.ok, "{len} bytes must be accepted");
            assert!(result.committed);
            assert_eq!(result.byte_length, len);

            // The repair entry has its own guard and must accept the same
            // sizes; testing only refusal there leaves an off-by-one able to
            // make an exactly-at-cap object permanently unrepairable.
            let repaired = cas_repair_write_within_root(&root, &bytes, None).expect("repair");
            assert!(
                repaired.ok,
                "{len} bytes must be accepted by the repair entry too"
            );
            assert!(repaired.already_valid, "the object is already correct");
        }
        assert!(temp_artifacts(&root).is_empty());
        let _ = fs::remove_dir_all(&base);
    }

    /// Exact boundary: one byte over the cap is refused, by BOTH trusted
    /// entries, before anything is created and with no staging residue.
    #[test]
    fn an_asset_one_byte_over_the_governed_cap_is_refused_before_any_write() {
        let (base, root) = scratch_root("bound-refuse");
        let bytes = vec![0u8; (GOVERNED_ASSET_BLOB_CAP_BYTES + 1) as usize];
        let relative = cas_relative(&bytes);

        let created = durable_write_within_root(&root, &relative, &bytes).expect("call");
        assert!(!created.ok);
        assert!(!created.committed, "an oversized asset must never commit");
        assert_eq!(
            blocker_codes(&created.blockers),
            vec!["durable-write-asset-too-large".to_string()]
        );
        assert!(
            !root.join(&relative).exists(),
            "no CAS object may be created"
        );
        // Refused before traversal: not even the shard directory exists.
        assert!(!root.join(CAS_DIR).exists(), "no shard may be created");

        let repaired = cas_repair_write_within_root(&root, &bytes, None).expect("call");
        assert!(!repaired.ok);
        assert!(!repaired.repaired, "an oversized asset must never repair");
        assert!(!repaired.committed);
        assert_eq!(
            blocker_codes(&repaired.blockers),
            vec!["cas-repair-asset-too-large".to_string()]
        );
        assert!(!root.join(CAS_DIR).exists());
        assert!(
            temp_artifacts(&root).is_empty(),
            "no temp residue may remain"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// The bound is an INGEST ceiling, never a read ceiling: a historical
    /// object larger than the cap stays readable and verifiable.
    #[test]
    fn an_existing_oversized_object_remains_readable() {
        let (base, root) = scratch_root("bound-legacy-read");
        let bytes = vec![7u8; (GOVERNED_ASSET_BLOB_CAP_BYTES + 1) as usize];
        let relative = cas_relative(&bytes);

        // Stand a historical oversized object at its canonical path directly,
        // as an older build would have left it.
        fs::create_dir_all(root.join(&relative).parent().unwrap()).expect("shard");
        fs::write(root.join(&relative), &bytes).expect("legacy object");

        let dir = confined::Dir::open_root(&root).expect("root");
        let shard = dir
            .open_child_nofollow(CAS_DIR.as_bytes())
            .expect("assets")
            .open_child_nofollow(&relative.as_bytes()[CAS_DIR.len() + 1..CAS_DIR.len() + 3])
            .expect("shard");
        let name = relative.rsplit('/').next().unwrap().as_bytes();
        let read = read_child_bounded(&shard, name, bytes.len()).expect("read");
        assert_eq!(
            read.expect("present").len(),
            bytes.len(),
            "an oversized historical object must stay readable"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// A truncated object is shorter than the expected bytes; the bounded read
    /// must still classify it as mismatching rather than accepting it.
    #[test]
    fn cas_repair_rejects_a_truncated_object() {
        let (base, root) = scratch_root("cas-truncated");
        let bytes = b"a longer authentic payload";
        let relative = cas_relative(bytes);
        fs::create_dir_all(root.join(&relative).parent().unwrap()).expect("shard");
        fs::write(root.join(&relative), b"a lo").expect("truncate");

        let result = cas_repair_write_within_root(&root, bytes, None).expect("repair");
        assert!(result.repaired);
        assert_eq!(fs::read(root.join(&relative)).unwrap(), bytes);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cas_repair_refuses_an_expected_hash_that_does_not_match_the_bytes() {
        let (base, root) = scratch_root("cas-hash-mismatch");
        let bytes = b"authentic";
        let other = sha_hex(b"something else entirely");

        let mismatched =
            cas_repair_write_within_root(&root, bytes, Some(&format!("sha256-{other}")))
                .expect("call");
        assert!(!mismatched.ok);
        assert_eq!(
            blocker_codes(&mismatched.blockers),
            vec!["cas-repair-expected-sha-mismatch".to_string()]
        );
        // Critically: nothing was written anywhere, least of all at the hash
        // the caller named.
        assert!(!root.join(cas_relative(bytes)).exists());
        assert!(!root
            .join(format!("{CAS_DIR}/{}/sha256-{other}", &other[0..2]))
            .exists());

        for malformed in ["", "sha256-", "notahash", "sha256-XYZ", &"a".repeat(63)] {
            let result = cas_repair_write_within_root(&root, bytes, Some(malformed)).expect("call");
            assert!(!result.ok, "{malformed} must be refused");
            assert_eq!(
                blocker_codes(&result.blockers),
                vec!["cas-repair-expected-sha-malformed".to_string()],
                "{malformed}"
            );
        }
        let _ = fs::remove_dir_all(&base);
    }

    /// The caller has no destination argument at all, so a correct assertion
    /// changes nothing about where the object lands.
    #[test]
    fn cas_repair_cannot_be_redirected_to_another_object_shard_or_archive_path() {
        let (base, root) = scratch_root("cas-redirect");
        let bytes = b"the only bytes that matter";
        let hex = sha_hex(bytes);
        let canonical = cas_relative(bytes);

        // Seed unrelated archive state that must remain untouched.
        let pkg = "packages/chat-1.h2ochat";
        durable_write_impl(
            &root,
            &format!("{pkg}/manifest.json"),
            b"{\"real\":true}",
            ExistingPolicy::Fail,
        )
        .expect("manifest");
        durable_write_impl(
            &root,
            &format!("{pkg}/snapshot.json"),
            b"{\"snap\":1}",
            ExistingPolicy::Fail,
        )
        .expect("snapshot");
        durable_write_impl(
            &root,
            &format!("{pkg}/assets/sha256-x.png"),
            b"pkgasset",
            ExistingPolicy::Fail,
        )
        .expect("pkg asset");
        let decoy = b"decoy object";
        let decoy_rel = cas_relative(decoy);
        durable_write_within_root(&root, &decoy_rel, decoy).expect("decoy");

        // Every accepted call lands on the derived path and nowhere else.
        let with_assert = cas_repair_write_within_root(&root, bytes, Some(&hex)).expect("repair");
        assert!(with_assert.ok);
        assert_eq!(with_assert.path, canonical);

        // Unrelated archive state is byte-identical.
        assert_eq!(
            fs::read(root.join(format!("{pkg}/manifest.json"))).unwrap(),
            b"{\"real\":true}"
        );
        assert_eq!(
            fs::read(root.join(format!("{pkg}/snapshot.json"))).unwrap(),
            b"{\"snap\":1}"
        );
        assert_eq!(
            fs::read(root.join(format!("{pkg}/assets/sha256-x.png"))).unwrap(),
            b"pkgasset"
        );
        assert_eq!(fs::read(root.join(&decoy_rel)).unwrap(), decoy);

        // Only the canonical shard was touched under assets/.
        let shard = format!("{CAS_DIR}/{}", &hex[0..2]);
        assert!(root.join(&shard).is_dir());
        let _ = fs::remove_dir_all(&base);
    }

    /// The options contract carries no destination of any kind; an attempt to
    /// smuggle one in is simply not part of the type.
    #[test]
    fn the_cas_repair_options_contract_exposes_no_destination() {
        let parsed: CasRepairOptions = serde_json::from_str(
            r#"{"expectedSha256":"sha256-aa","path":"packages/x/manifest.json","shard":"zz"}"#,
        )
        .expect("options parse");
        assert_eq!(parsed.expected_sha256.as_deref(), Some("sha256-aa"));

        // An empty header is valid: bytes alone are sufficient.
        let empty: CasRepairOptions = serde_json::from_str("{}").expect("empty options");
        assert!(empty.expected_sha256.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn cas_repair_refuses_a_symlinked_shard() {
        let (base, root) = scratch_root("cas-shard-symlink");
        let outside = base.join("outside");
        fs::create_dir_all(&outside).expect("outside");
        let bytes = b"shard symlink probe";
        let hex = sha_hex(bytes);

        fs::create_dir_all(root.join(CAS_DIR)).expect("assets");
        std::os::unix::fs::symlink(&outside, root.join(format!("{CAS_DIR}/{}", &hex[0..2])))
            .expect("shard symlink");

        let result = cas_repair_write_within_root(&root, bytes, None).expect("call");
        assert!(!result.ok);
        assert_eq!(
            blocker_codes(&result.blockers),
            vec!["cas-repair-shard-symlink".to_string()]
        );
        assert!(
            fs::read_dir(&outside).unwrap().next().is_none(),
            "nothing may be written through the link"
        );
        let _ = fs::remove_dir_all(&base);
    }

    /// Whichever writer wins, the canonical object is verified rather than
    /// assumed — a valid winner dedupes, a corrupt winner is repaired.
    #[test]
    fn cas_repair_verifies_the_winner_of_a_concurrent_write() {
        let (base, root) = scratch_root("cas-race");
        let bytes = b"contended object";
        let relative = cas_relative(bytes);
        fs::create_dir_all(root.join(&relative).parent().unwrap()).expect("shard");

        // Valid winner already in place.
        fs::write(root.join(&relative), bytes).expect("winner");
        let valid = cas_repair_write_within_root(&root, bytes, None).expect("call");
        assert!(valid.already_valid);
        assert!(!valid.committed);

        // Corrupt winner in place.
        fs::write(root.join(&relative), b"corrupt winner").expect("bad winner");
        let corrupt = cas_repair_write_within_root(&root, bytes, None).expect("call");
        assert!(corrupt.repaired);
        assert_eq!(fs::read(root.join(&relative)).unwrap(), bytes);
        let _ = fs::remove_dir_all(&base);
    }

    // ── Race containment (T05) ─────────────────────────────────────────────

    /// The adversarial race the previous pathname design lost.
    ///
    /// An attacker thread continuously swaps an admitted ancestor directory for
    /// a symlink pointing outside the root while the writer loops. The test is
    /// only meaningful if the attacker actually mutated the path during the run,
    /// so successful swaps are counted and asserted — a passing run caused by an
    /// idle attacker thread is treated as a failure.
    #[cfg(unix)]
    #[test]
    fn concurrent_ancestor_swap_cannot_redirect_a_write_outside_the_root() {
        use std::sync::atomic::AtomicBool;
        use std::sync::Arc;

        let (base, root) = scratch_root("race");
        let outside = base.join("outside");
        fs::create_dir_all(&outside).expect("outside");
        fs::create_dir_all(root.join("hop")).expect("hop");

        let stop = Arc::new(AtomicBool::new(false));
        let swaps = Arc::new(AtomicU64::new(0));

        let attacker = {
            let stop = Arc::clone(&stop);
            let swaps = Arc::clone(&swaps);
            let root = root.clone();
            let outside = outside.clone();
            std::thread::spawn(move || {
                let hop = root.join("hop");
                let mut round = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    // A fresh stash name each round; reusing one name wedges the
                    // attacker after a single cycle and silently under-exercises
                    // the race.
                    let stash = root.join(format!("hop-real-{round}"));
                    round += 1;
                    let real_dir = matches!(
                        fs::symlink_metadata(&hop),
                        Ok(md) if md.is_dir() && !md.file_type().is_symlink()
                    );
                    if real_dir && fs::rename(&hop, &stash).is_ok() {
                        // Stand a symlink to the outside directory in its place.
                        if std::os::unix::fs::symlink(&outside, &hop).is_ok() {
                            swaps.fetch_add(1, Ordering::Relaxed);
                        }
                        std::thread::yield_now();
                        let _ = fs::remove_file(&hop);
                        if fs::rename(&stash, &hop).is_err() {
                            let _ = fs::remove_dir_all(&stash);
                        }
                    }
                    std::thread::yield_now();
                }
            })
        };

        let mut wrote = 0u64;
        for i in 0..4000u64 {
            let rel = format!("hop/blob-{i}");
            match durable_write_impl(&root, &rel, b"payload", ExistingPolicy::Fail) {
                Ok(result) if result.ok => wrote += 1,
                // Losing the race is fine; being redirected is not.
                Ok(_) => {}
                Err(_) => {}
            }
        }
        stop.store(true, Ordering::Relaxed);
        attacker.join().expect("attacker thread");

        let swap_count = swaps.load(Ordering::Relaxed);
        assert!(
            swap_count > 0,
            "the attacker never mutated the path; the race was not exercised"
        );

        // The only acceptable outcome: nothing was ever written through the link.
        // Verified to have teeth — the pre-T05 pathname algorithm, run against
        // this same attacker, wrote files into `outside` (scratchpad race-proof
        // probe: OLD escaped on 3 of 4 runs, NEW escaped on 0 of 4).
        let escaped: Vec<_> = fs::read_dir(&outside)
            .expect("outside readable")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            escaped.is_empty(),
            "writes escaped the archive root ({swap_count} swaps): {escaped:?}"
        );
        assert!(
            wrote > 0,
            "the writer never succeeded; the test proved nothing about containment"
        );

        let _ = fs::remove_dir_all(&base);
    }
}
