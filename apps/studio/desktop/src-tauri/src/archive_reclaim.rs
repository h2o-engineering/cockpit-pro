//! M06 T3.1 — quarantine namespace and confined purge primitive.
//!
//! DORMANT. Nothing here is registered as a command, reachable from the
//! renderer, or wired to any UI. G02 remains the activation gate; this module
//! is the filesystem safety foundation the later destructive core will build
//! on, and it executes no reclamation run of its own.
//!
//! This is the ONLY module in M06 that holds physical delete authority, and
//! that authority is deliberately tiny: it can remove data that already lives
//! inside `archive/.h2o-reclaim`, and nothing else. There is no API here that
//! accepts a caller path, so "delete an arbitrary location" is not a refused
//! request — it is an unrepresentable one.
//!
//! Revision 2 removed destructive CAS reclamation from M06 entirely, and
//! withdrew both "destructive CAS collection" and "one-run CAS dwell" (§Q).
//! Accordingly there is NO CAS destructive target here: `QuarantineKind` has no
//! Cas/Asset/Sha variant, and a test fails if a future change adds one.
//!
//! T3.3 does open one CAS shard, because durable-temp residue physically lives
//! inside it. That handle is a rename SOURCE only, and it cannot reach a
//! canonical body: `quarantine_residue` refuses any source name that is not a
//! reserved trusted-writer component, and `sha256-<hex>` is not one. So
//! "quarantine a CAS object" is not a refused request — no argument value
//! expresses it.
//!
//! Confinement reuses the existing descriptor-relative primitives from
//! `archive_durable_write::confined` — no second confinement implementation is
//! introduced. Every step is `openat`/`unlinkat` relative to a held descriptor
//! with `O_NOFOLLOW`, so a symlink planted inside quarantine can have its own
//! entry removed but can never be traversed.

// DORMANT until G02: nothing in production calls this destructive authority
// yet, so the compiler correctly reports it as unused. The attribute records
// that dormancy deliberately rather than leaving build noise; it is removed
// when the activation task wires a caller.
#![allow(dead_code)]

use crate::archive_durable_write::{confined, RECLAIM_NAMESPACE_COMPONENT};
use crate::archive_instance_lock::ExclusiveOwnership;

/// Reserved sibling namespace INSIDE `.h2o-reclaim` holding evidence.
///
/// Receipts are required before or while destructive actions occur (§J), so
/// they must survive item purge. It is refused as a run name, which is what
/// keeps the ordinary item-purge path from ever addressing it.
pub const RECEIPTS_NAMESPACE: &str = "receipts";

/// Bound on quarantine tree depth while purging. A quarantined package is a
/// shallow tree; this only stops a pathological structure from recursing
/// without limit.
const MAX_PURGE_DEPTH: usize = 8;

pub mod codes {
    pub const COMPONENT_EMPTY: &str = "reclaim-component-empty";
    pub const COMPONENT_TRAVERSAL: &str = "reclaim-component-traversal";
    pub const COMPONENT_SEPARATOR: &str = "reclaim-component-separator";
    pub const COMPONENT_RESERVED: &str = "reclaim-component-reserved";
    pub const RUN_ID_EMPTY: &str = "reclaim-run-id-empty";
    pub const RUN_ID_PREFIXED: &str = "reclaim-run-id-already-prefixed";
    pub const RUN_ID_CHARSET: &str = "reclaim-run-id-charset";
    pub const RUN_CREATE_FAILED: &str = "reclaim-run-create-failed";
    pub const RECEIPTS_UNAVAILABLE: &str = "reclaim-receipts-unavailable";
    pub const RECEIPT_EXISTS: &str = "reclaim-receipt-exists";
    pub const EVIDENCE_WRITE_FAILED: &str = "reclaim-evidence-write-failed";
    pub const EVIDENCE_NOT_DURABLE: &str = "reclaim-evidence-not-durable";
    pub const QUARANTINE_RENAME_FAILED: &str = "reclaim-quarantine-rename-failed";
    pub const QUARANTINE_NOT_DURABLE: &str = "reclaim-quarantine-not-durable";
    pub const QUARANTINE_UNSUPPORTED_PLATFORM: &str =
        "reclaim-quarantine-unsupported-platform";
    /// T02: the no-replace move or the namespace fence is unproven on this
    /// root's filesystem (contract §10); environmental and retryable.
    pub const QUARANTINE_CAPABILITY_UNPROVEN: &str = "reclaim-quarantine-capability-unproven";
    /// T02: after the move, the object under the quarantine name is not the
    /// retained source object (class H′); the foreign occupant is left alone.
    pub const QUARANTINE_IDENTITY_MISMATCH: &str =
        "reclaim-quarantine-publication-identity-mismatch";
    pub const ROOT_UNAVAILABLE: &str = "reclaim-root-unavailable";
    pub const RUN_UNREADABLE: &str = "reclaim-run-unreadable";
    pub const ITEM_UNREADABLE: &str = "reclaim-item-unreadable";
    pub const PURGE_FAILED: &str = "reclaim-purge-failed";
    pub const DEPTH_EXCEEDED: &str = "reclaim-purge-depth-exceeded";
    /// T3.3: a residue quarantine was asked to move a source name that is not a
    /// reserved trusted-writer component. The structural CAS barrier.
    pub const RESIDUE_NOT_RESERVED: &str = "reclaim-residue-source-not-reserved";
    /// T02 RC-T02-02: a residue quarantine was asked to move a reserved EXACT
    /// infrastructure component — the presence lock or the quarantine
    /// namespace itself. Reserved, but never residue.
    pub const RESIDUE_SOURCE_INFRASTRUCTURE: &str = "reclaim-residue-source-infrastructure";
    /// T3.3: the named CAS shard could not be opened as a rename source.
    pub const SHARD_UNAVAILABLE: &str = "reclaim-shard-unavailable";
    /// T3.5: an entry inside the reclaim root is not a recognizable run
    /// namespace. Reported and left ALONE, never purged.
    pub const RUN_UNRECOGNIZED: &str = "reclaim-run-unrecognized";
    /// T3.5: a `run-` shaped entry that is not a real directory — a symlink or
    /// a file. `O_NOFOLLOW` refused to traverse it, so it is not a run.
    pub const RUN_NOT_A_DIRECTORY: &str = "reclaim-run-not-a-directory";
    /// T3.5: the reclaim root itself could not be enumerated.
    pub const RECLAIM_ROOT_UNREADABLE: &str = "reclaim-root-unreadable";
}

/// What a quarantined item was, for later evidence.
///
/// There is deliberately NO CAS variant. M06 analyzes CAS read-only and never
/// reclaims it, so a destructive CAS target must not be expressible.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuarantineKind {
    /// A published generation package moved out of the canonical namespace.
    Generation,
    /// Reserved staging or temporary residue.
    StagingTemp,
    /// A non-VALID occupant removed from a canonical destination.
    Occupant,
}

/// One validated path component. Constructing this is the ONLY way to name
/// anything inside quarantine, so a separator, `..` or absolute path cannot
/// reach a syscall.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuarantineComponent(String);

impl QuarantineComponent {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let text = raw.trim();
        if text.is_empty() {
            return Err(codes::COMPONENT_EMPTY.to_string());
        }
        if text == "." || text == ".." {
            return Err(codes::COMPONENT_TRAVERSAL.to_string());
        }
        // Both separators are refused regardless of host platform, so a
        // Windows-style name cannot become a traversal on a future target.
        if text.contains('/') || text.contains('\\') || text.contains('\0') {
            return Err(codes::COMPONENT_SEPARATOR.to_string());
        }
        Ok(QuarantineComponent(text.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The canonical prefix every quarantine run directory carries.
pub const RUN_PREFIX: &str = "run-";

/// A quarantine run namespace. Callers supply an ID, never a directory name:
/// the `run-` component is derived here, so an arbitrary top-level name such as
/// `foo`, `tmp` or `receipts2` cannot become a run directory.
///
/// A run id is namespace and evidence identity ONLY. Nothing derives deletion
/// authority from its lexical or temporal ordering, and no wall clock is needed
/// to build one — generation belongs to the later execution layer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuarantineRunId(String);

impl QuarantineRunId {
    /// Validates a bounded run identity and derives `run-<id>`.
    pub fn parse(id: &str) -> Result<Self, String> {
        let text = id.trim();
        if text.is_empty() {
            return Err(codes::RUN_ID_EMPTY.to_string());
        }
        // The id must be a plain component in its own right, so every
        // traversal and separator refusal applies to it first.
        let component = QuarantineComponent::parse(text)?;
        // And it must not smuggle the prefix or a reserved sibling back in.
        if component.as_str().starts_with(RUN_PREFIX) {
            return Err(codes::RUN_ID_PREFIXED.to_string());
        }
        if component.as_str() == RECEIPTS_NAMESPACE
            || component.as_str() == RECLAIM_NAMESPACE_COMPONENT
        {
            return Err(codes::COMPONENT_RESERVED.to_string());
        }
        if !component
            .as_str()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(codes::RUN_ID_CHARSET.to_string());
        }
        Ok(QuarantineRunId(format!("{RUN_PREFIX}{}", component.as_str())))
    }

    /// The derived directory component, always `run-<id>`.
    pub fn component(&self) -> &str {
        &self.0
    }
}

/// A target that exists INSIDE quarantine: `<reclaim>/<run>/<item>`.
///
/// There is no constructor for `<reclaim>` alone or `<reclaim>/<run>` alone, so
/// the reclaim root and a whole run cannot be addressed by the item purge
/// primitive at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuarantineTarget {
    run: QuarantineRunId,
    item: QuarantineComponent,
    kind: QuarantineKind,
}

impl QuarantineTarget {
    /// `run_id` is an IDENTITY, not a directory name — the `run-` component is
    /// derived by `QuarantineRunId`. A caller therefore cannot address a
    /// non-run sibling of the reclaim root, including `receipts`.
    pub fn parse(run_id: &str, item: &str, kind: QuarantineKind) -> Result<Self, String> {
        let run = QuarantineRunId::parse(run_id)?;
        let item = QuarantineComponent::parse(item)?;
        Ok(QuarantineTarget { run, item, kind })
    }

    pub fn run_component(&self) -> &str {
        self.run.component()
    }

    pub fn kind(&self) -> QuarantineKind {
        self.kind
    }

    /// Archive-relative identity, for evidence only. Never used to open
    /// anything — every syscall is descriptor-relative.
    pub fn archive_relative_path(&self) -> String {
        format!(
            "{}/{}/{}/{}",
            crate::archive_durable_write::ARCHIVE_ROOT,
            RECLAIM_NAMESPACE_COMPONENT,
            self.run.component(),
            self.item.as_str()
        )
    }
}

/// An opaque capability handle for the quarantine namespace.
///
/// The inner descriptor is private and there is no constructor from a path, so
/// possessing a `ReclaimRoot` is proof that the namespace was derived beneath a
/// trusted archive root while exclusive ownership was held.
pub struct ReclaimRoot {
    dir: confined::Dir,
    /// The admitted archive root the namespace was derived beneath — retained
    /// as the RENAME SOURCE for capability-probe residue (RC-T02-02). Never
    /// re-derived from a path after admission.
    archive: confined::Dir,
}

impl ReclaimRoot {
    /// The admitted archive root as a rename SOURCE for `.h2o-probe-*` residue
    /// standing directly beneath it.
    ///
    /// Read/rename-source only, exactly like `open_packages_dir`: the only
    /// operation that consumes it is `quarantine_residue`, which refuses every
    /// non-reserved source name and both reserved exact infrastructure
    /// components (the presence lock and the quarantine namespace itself), so
    /// nothing canonical and nothing structural is nameable through it.
    pub(crate) fn archive_dir(&self) -> &confined::Dir {
        &self.archive
    }
}

/// Opens the canonical quarantine namespace.
///
/// The PRODUCTION destructive entry point. It accepts no filesystem root of any
/// kind: the archive root is derived internally through the existing
/// `archive_durable_write::archive_root` authority, so neither a caller nor the
/// renderer can influence where destruction is confined to. There is no second
/// archive-root implementation here.
///
/// Requires the P1 exclusive-ownership capability BY TYPE — there is no second
/// lock, and no way to reach this while another instance may be mutating the
/// archive. The namespace identity is the T1.2 canonical constant.
pub fn open_reclaim_root(
    app: &tauri::AppHandle,
    exclusive: &ExclusiveOwnership<'_>,
) -> Result<ReclaimRoot, String> {
    let archive_root = crate::archive_durable_write::archive_root(app)
        .map_err(|_| codes::ROOT_UNAVAILABLE.to_string())?;
    open_reclaim_root_within(exclusive, &archive_root)
}

/// The confinement mechanics, shared by the production constructor above and by
/// the disposable-root test seam below.
///
/// Private: production code cannot reach it, so the only production path to a
/// `ReclaimRoot` is through the canonical archive-root authority.
fn open_reclaim_root_within(
    _exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
) -> Result<ReclaimRoot, String> {
    let root = confined::Dir::open_existing_nofollow(archive_root)
        .map_err(|_| codes::ROOT_UNAVAILABLE.to_string())?;
    // Class O for class M: the no-replace move and the namespace fence must be
    // PROVEN on the ADMITTED archive root before the quarantine namespace is
    // even created. Contract §10 rule 1 runs the probe directly under the
    // governed root — so a probe that crashes leaves `.h2o-probe-*` where the
    // trusted residue scan reclaims it (RC-T02-02), never inside a run
    // namespace whose every entry recovery must be able to attribute. A root
    // this process cannot write is an infrastructure fault, not a verdict.
    match crate::archive_filesystem_capability::require(
        &root,
        crate::archive_filesystem_capability::move_requirements(),
    ) {
        Ok(_) => {}
        Err(refusal) if refusal.is_root_not_writable() => {
            return Err(codes::ROOT_UNAVAILABLE.to_string())
        }
        Err(_) => return Err(codes::QUARANTINE_CAPABILITY_UNPROVEN.to_string()),
    }
    let name = RECLAIM_NAMESPACE_COMPONENT.as_bytes();
    root.mkdir_child(name)
        .map_err(|_| codes::ROOT_UNAVAILABLE.to_string())?;
    let dir = root
        .open_child_nofollow(name)
        .map_err(|_| codes::ROOT_UNAVAILABLE.to_string())?;
    Ok(ReclaimRoot { dir, archive: root })
}

/// Opens the quarantine namespace WITHOUT creating it.
///
/// The recovery pass runs before a governed run has decided it will act, and a
/// truthful no-op must leave no `.h2o-reclaim` behind. `Ok(None)` therefore
/// means "there is no quarantine namespace", which is an absence this function
/// proved rather than one it manufactured.
pub(crate) fn open_reclaim_root_if_present(
    _exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
) -> Result<Option<ReclaimRoot>, String> {
    let root = match confined::Dir::open_existing_nofollow(archive_root) {
        Ok(dir) => dir,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(codes::ROOT_UNAVAILABLE.to_string()),
    };
    match root.open_child_nofollow(RECLAIM_NAMESPACE_COMPONENT.as_bytes()) {
        Ok(dir) => Ok(Some(ReclaimRoot { dir, archive: root })),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(codes::ROOT_UNAVAILABLE.to_string()),
    }
}

/// What the reclaim root holds, as TYPED run identities.
///
/// A caller cannot get a run out of here as a string: only names that survive
/// `QuarantineRunId::parse` AND are real non-symlink directories become runs.
/// Everything else is reported so it stays visible, and is never actionable.
pub struct RunListing {
    pub runs: Vec<QuarantineRunId>,
    /// Present, visible, and not a recognizable run. Evidence, never a target.
    pub unrecognized: Vec<String>,
    pub blockers: Vec<String>,
}

/// One recognized quarantine item, as a TYPED component.
pub struct ItemListing {
    pub items: Vec<QuarantineComponent>,
    pub unrecognized: Vec<String>,
    pub blockers: Vec<String>,
}

impl ReclaimRoot {
    /// Enumerates recognizable run namespaces, deterministically.
    ///
    /// The reserved `receipts` sibling is skipped by identity, not by luck:
    /// `QuarantineRunId::parse` refuses it outright, and it carries no `run-`
    /// prefix either. Evidence is therefore unreachable from any recovery that
    /// walks this listing.
    pub fn run_ids(&self, _exclusive: &ExclusiveOwnership<'_>) -> RunListing {
        let mut out = RunListing {
            runs: vec![],
            unrecognized: vec![],
            blockers: vec![],
        };
        let names = match self.dir.read_entry_names() {
            Ok(names) => names,
            Err(_) => {
                out.blockers.push(codes::RECLAIM_ROOT_UNREADABLE.to_string());
                return out;
            }
        };
        for raw in names {
            let Ok(name) = std::str::from_utf8(&raw).map(str::to_string) else {
                out.blockers.push(codes::RUN_UNRECOGNIZED.to_string());
                continue;
            };
            // The reserved evidence sibling: known, and deliberately not a run.
            if name == RECEIPTS_NAMESPACE {
                continue;
            }
            let Some(id) = name.strip_prefix(RUN_PREFIX) else {
                out.unrecognized.push(name);
                continue;
            };
            let Ok(run) = QuarantineRunId::parse(id) else {
                out.unrecognized.push(name);
                continue;
            };
            // It must BE a directory. A symlink here is refused, not followed.
            match self.dir.stat_child_nofollow(&raw) {
                Ok(Some(st)) if !confined::is_symlink(&st) && is_dir(&st) => out.runs.push(run),
                Ok(Some(_)) => {
                    out.unrecognized.push(name);
                    out.blockers.push(codes::RUN_NOT_A_DIRECTORY.to_string());
                }
                // Raced away between listing and stat: nothing to recover.
                Ok(None) => {}
                Err(_) => {
                    out.unrecognized.push(name);
                    out.blockers.push(codes::RUN_UNREADABLE.to_string());
                }
            }
        }
        out.runs.sort_by(|a, b| a.component().cmp(b.component()));
        out.unrecognized.sort();
        out.blockers.sort();
        out.blockers.dedup();
        out
    }

    /// Opens an EXISTING run namespace. Open-only: unlike `create_run` this
    /// creates nothing, so recovery cannot manufacture the run it then acts on.
    pub fn open_run(
        &self,
        _exclusive: &ExclusiveOwnership<'_>,
        run: &QuarantineRunId,
    ) -> Result<Option<RunDir>, String> {
        let name = run.component().as_bytes();
        match self.dir.open_child_nofollow(name) {
            Ok(dir) => Ok(Some(RunDir { dir })),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(codes::RUN_UNREADABLE.to_string()),
        }
    }
}

impl RunDir {
    /// Enumerates the run's items as validated components, deterministically.
    ///
    /// A name that cannot be a `QuarantineComponent` is reported and left in
    /// place: the purge primitive cannot express it, so it is not a refused
    /// target but an inexpressible one.
    pub fn item_names(&self, _exclusive: &ExclusiveOwnership<'_>) -> ItemListing {
        let mut out = ItemListing {
            items: vec![],
            unrecognized: vec![],
            blockers: vec![],
        };
        let names = match self.dir.read_entry_names() {
            Ok(names) => names,
            Err(_) => {
                out.blockers.push(codes::RUN_UNREADABLE.to_string());
                return out;
            }
        };
        for raw in names {
            let Ok(name) = std::str::from_utf8(&raw).map(str::to_string) else {
                out.blockers.push(codes::ITEM_UNREADABLE.to_string());
                continue;
            };
            match QuarantineComponent::parse(&name) {
                Ok(component) if component.as_str() == name => out.items.push(component),
                // Trimmed or refused: the identity on disk is not the identity
                // the purge primitive would address, so it is not addressed.
                _ => out.unrecognized.push(name),
            }
        }
        out.items.sort_by(|a, b| a.as_str().cmp(b.as_str()));
        out.unrecognized.sort();
        out
    }
}

/// Test-only seam for disposable archive roots. Compiled out of production
/// entirely, so no shipped caller can name a filesystem root.
#[cfg(test)]
pub(crate) fn open_reclaim_root_for_test(
    exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
) -> Result<ReclaimRoot, String> {
    open_reclaim_root_within(exclusive, archive_root)
}

/// Directory test on an ALREADY `O_NOFOLLOW`-stat'd entry.
///
/// Derived here rather than added to `confined` so `archive_durable_write.rs`
/// stays byte-unchanged. It is a mode check on a stat the caller already took
/// with the confined primitive, not a second confinement implementation: it
/// opens nothing and resolves no path.
fn is_dir(st: &confined::EntryStat) -> bool {
    confined::is_directory(st)
}

/// The reclaim namespace for an execution run, derived from a trusted archive
/// root. Crate-internal: the only production caller is the T3.2 execution
/// authority, which itself derives the root from the canonical app authority.
pub(crate) fn open_reclaim_root_for_run(
    exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
) -> Result<ReclaimRoot, String> {
    open_reclaim_root_within(exclusive, archive_root)
}

/// Opens the canonical packages directory as the RENAME SOURCE.
///
/// Read/rename-source only: possessing this descriptor grants no delete
/// authority, because the only operation that consumes it is the atomic
/// non-replacing move into quarantine. Nothing here can unlink a package.
pub(crate) fn open_packages_dir(
    _exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
) -> Result<confined::Dir, String> {
    let root = confined::Dir::open_existing_nofollow(archive_root)
        .map_err(|_| codes::ROOT_UNAVAILABLE.to_string())?;
    root.open_child_nofollow(b"packages")
        .map_err(|_| codes::ROOT_UNAVAILABLE.to_string())
}

/// A run directory inside quarantine: `<reclaim>/run-<id>/`.
///
/// Opaque, and obtainable only from `ReclaimRoot::create_run`, so a run
/// destination cannot be named by a caller.
pub struct RunDir {
    dir: confined::Dir,
}

impl ReclaimRoot {
    /// Creates `run-<id>` and returns its descriptor. Create-only: an existing
    /// run directory is refused rather than reused, so two runs can never share
    /// a namespace.
    pub fn create_run(
        &self,
        _exclusive: &ExclusiveOwnership<'_>,
        run: &QuarantineRunId,
    ) -> Result<RunDir, String> {
        let name = run.component().as_bytes();
        self.dir
            .mkdir_child_exclusive(name)
            .map_err(|_| codes::RUN_CREATE_FAILED.to_string())?;
        let dir = self
            .dir
            .open_child_nofollow(name)
            .map_err(|_| codes::RUN_UNREADABLE.to_string())?;
        self.dir
            .sync()
            .map_err(|_| codes::EVIDENCE_NOT_DURABLE.to_string())?;
        Ok(RunDir { dir })
    }

    /// Opens (creating if absent) the reserved receipts sibling.
    pub fn receipts_dir(&self, _exclusive: &ExclusiveOwnership<'_>) -> Result<ReceiptsDir, String> {
        let name = RECEIPTS_NAMESPACE.as_bytes();
        self.dir
            .mkdir_child(name)
            .map_err(|_| codes::RECEIPTS_UNAVAILABLE.to_string())?;
        let dir = self
            .dir
            .open_child_nofollow(name)
            .map_err(|_| codes::RECEIPTS_UNAVAILABLE.to_string())?;
        Ok(ReceiptsDir { dir })
    }
}

/// The reserved evidence namespace: `<reclaim>/receipts/`.
pub struct ReceiptsDir {
    dir: confined::Dir,
}

impl ReceiptsDir {
    /// Writes one evidence record CREATE-ONLY and makes it durable before
    /// returning, together with the directory entry.
    ///
    /// An existing name is refused: evidence is never replaced, so a colliding
    /// run cannot silently overwrite another run's audit trail.
    pub fn write_durable(
        &self,
        _exclusive: &ExclusiveOwnership<'_>,
        name: &QuarantineComponent,
        bytes: &[u8],
    ) -> Result<(), String> {
        use std::io::Write;
        let mut file = self
            .dir
            .create_new_child(name.as_str().as_bytes())
            .map_err(|err| {
                if err.kind() == std::io::ErrorKind::AlreadyExists {
                    codes::RECEIPT_EXISTS.to_string()
                } else {
                    codes::EVIDENCE_WRITE_FAILED.to_string()
                }
            })?;
        file.write_all(bytes)
            .map_err(|_| codes::EVIDENCE_WRITE_FAILED.to_string())?;
        // The record — through the ONE governed content fence authority
        // (`F_FULLFSYNC` on macOS; MB-04) — then the directory entry that
        // names it.
        crate::archive_durable_write::sync_file_contents(&file)
            .map_err(|_| codes::EVIDENCE_NOT_DURABLE.to_string())?;
        self.dir
            .sync()
            .map_err(|_| codes::EVIDENCE_NOT_DURABLE.to_string())?;
        Ok(())
    }
}

/// Atomically moves a verified generation OUT of the canonical packages
/// directory and into a run quarantine, without ever replacing an existing
/// quarantine entry.
///
/// This is the only path by which a canonical package may leave
/// `archive/packages`, and it is one `renameatx_np(RENAME_EXCL)` — never a
/// copy-then-unlink, and never a replacing rename. Both endpoints are
/// descriptor-relative; no path is constructed or followed.
///
/// Returns `Ok(false)` when the destination already exists, so a collision
/// fails closed instead of overwriting evidence.
pub fn quarantine_generation(
    _exclusive: &ExclusiveOwnership<'_>,
    packages: &confined::Dir,
    run: &RunDir,
    source: &QuarantineComponent,
    item: &QuarantineComponent,
) -> Result<bool, String> {
    quarantine_into_run(packages, run, source, item)
}

/// The single atomic non-replacing move into quarantine, shared by every
/// family (contract §6 class M): ONE no-replace move — `renameatx_np(RENAME_EXCL)`
/// on macOS, `renameat2(RENAME_NOREPLACE)` on Linux, a handle-bound
/// `ReplaceIfExists = FALSE` rename on Windows — and nothing else: no
/// copy-then-unlink, no replacing rename, no second mechanism to keep in step.
///
/// Both endpoints are descriptor-relative; no path is constructed or followed.
/// The source entry is opened no-follow and retained across the move so the
/// object that arrives under the quarantine name can be proven to be that
/// object (class H′); on divergence the foreign occupant is left alone and a
/// distinct refusal is reported. The move capability was proven on the
/// admitted archive root when the quarantine namespace was opened
/// (`reclaim-quarantine-capability-unproven` refuses there, before anything
/// exists); a use-time capability refusal is still honoured below.
fn quarantine_into_run(
    source_dir: &confined::Dir,
    run: &RunDir,
    source: &QuarantineComponent,
    item: &QuarantineComponent,
) -> Result<bool, String> {
    let from = source.as_str().as_bytes();
    let to = item.as_str().as_bytes();
    // Retain the source object across the move: a directory descriptor
    // admitted no-follow, a no-follow read handle for a durable-temp file, or
    // — for an entry that cannot be opened without following it (a symlink
    // occupant, moved AS AN ENTRY exactly as the accepted floor does) — its
    // no-follow identity, re-checked under the quarantine name afterwards.
    let owned = match source_dir.stat_child_nofollow(from) {
        Ok(Some(st)) if st.is_directory() => match source_dir.open_child_nofollow(from) {
            Ok(dir) => RetainedSource::Directory(dir),
            Err(_) => return Err(codes::QUARANTINE_RENAME_FAILED.to_string()),
        },
        Ok(Some(st)) if st.is_regular() => match source_dir.open_child_read_nofollow(from) {
            Ok(file) => RetainedSource::File(file),
            Err(_) => return Err(codes::QUARANTINE_RENAME_FAILED.to_string()),
        },
        Ok(Some(st)) => RetainedSource::Unopened(st.identity()),
        _ => return Err(codes::QUARANTINE_RENAME_FAILED.to_string()),
    };
    let owned_identity = match owned.identity() {
        Ok(identity) => identity,
        Err(_) => return Err(codes::QUARANTINE_RENAME_FAILED.to_string()),
    };
    match source_dir.move_exclusive_into(from, &run.dir, to) {
        Ok(true) => {}
        Ok(false) => return Ok(false),
        Err(err) if err.kind() == std::io::ErrorKind::Unsupported => {
            return Err(codes::QUARANTINE_UNSUPPORTED_PLATFORM.to_string())
        }
        Err(err) if confined::is_capability_absent(&err) => {
            return Err(codes::QUARANTINE_CAPABILITY_UNPROVEN.to_string())
        }
        Err(_) => return Err(codes::QUARANTINE_RENAME_FAILED.to_string()),
    }
    // Class H′ (Windows: the retained handle must be released before the
    // cross-check open; on Unix the descriptor is simply no longer needed).
    drop(owned);
    match run.dir.stat_child_nofollow(to) {
        Ok(Some(st)) if st.identity() == owned_identity => Ok(true),
        _ => Err(codes::QUARANTINE_IDENTITY_MISMATCH.to_string()),
    }
}

/// The source object retained across a quarantine move for class H′.
enum RetainedSource {
    Directory(confined::Dir),
    File(std::fs::File),
    /// A link or other entry that no-follow rules forbid opening: only its
    /// own no-follow identity can be retained.
    Unopened(confined::ObjectIdentity),
}

impl RetainedSource {
    fn identity(&self) -> std::io::Result<confined::ObjectIdentity> {
        match self {
            RetainedSource::Directory(dir) => dir.identity(),
            RetainedSource::File(file) => confined::file_identity(file),
            RetainedSource::Unopened(identity) => Ok(*identity),
        }
    }
}

/// M06 T3.3 — atomically moves proven staging/temp RESIDUE into a run
/// quarantine, through exactly the same primitive the generation move uses.
///
/// The structural CAS barrier lives here. The source name must be a reserved
/// trusted-writer component under the T1.2 authority — `.h2o-genstage-*` or
/// `.h2o-durable-*` — so a canonical `sha256-<hex>` body, a published
/// generation and a legacy package are all refused BEFORE any syscall, whatever
/// descriptor the caller holds. That is what makes it safe to hand this
/// function a CAS shard as the rename source.
pub fn quarantine_residue(
    _exclusive: &ExclusiveOwnership<'_>,
    source_dir: &confined::Dir,
    run: &RunDir,
    source: &QuarantineComponent,
    item: &QuarantineComponent,
) -> Result<bool, String> {
    if !crate::archive_durable_write::is_reserved_component(source.as_str()) {
        return Err(codes::RESIDUE_NOT_RESERVED.to_string());
    }
    // RC-T02-02: the archive root itself is now a rename source (probe
    // residue stands directly beneath it), and its two reserved EXACT
    // components — the presence lock and the quarantine namespace — are
    // infrastructure, never residue. Refused before any syscall, whatever
    // descriptor the caller holds.
    if crate::archive_durable_write::RESERVED_EXACT_COMPONENTS
        .iter()
        .any(|exact| *exact == source.as_str())
    {
        return Err(codes::RESIDUE_SOURCE_INFRASTRUCTURE.to_string());
    }
    quarantine_into_run(source_dir, run, source, item)
}

/// M06 T3.4 — atomically moves a proven non-VALID generation-path OCCUPANT out
/// of the canonical packages directory and into a run quarantine.
///
/// The same `RENAME_EXCL` move the generation and residue paths use; a separate
/// named entry point only so evidence semantics stay distinct and so the T3.2
/// generation call graph keeps its own pins.
///
/// Deliberately WITHOUT the reserved-name guard `quarantine_residue` carries:
/// an occupant is a canonical generation-path name, which is by definition not
/// a reserved component. Eligibility for this move is established upstream by
/// re-classification under exclusive ownership — a valid generation, a legacy
/// package and reserved infrastructure are all refused there.
///
/// This move is quarantine ONLY. Occupant quarantine dwells (§J), so nothing
/// here or in its caller purges what it moved.
pub fn quarantine_occupant(
    _exclusive: &ExclusiveOwnership<'_>,
    packages: &confined::Dir,
    run: &RunDir,
    source: &QuarantineComponent,
    item: &QuarantineComponent,
) -> Result<bool, String> {
    quarantine_into_run(packages, run, source, item)
}

/// Opens one canonical CAS shard as a rename SOURCE for durable-temp residue.
///
/// Read/rename-source only, exactly like `open_packages_dir`: holding this
/// descriptor grants no delete authority over anything inside it, because the
/// only operation that consumes it is `quarantine_residue` and that refuses
/// every non-reserved source name.
pub(crate) fn open_cas_shard_dir(
    _exclusive: &ExclusiveOwnership<'_>,
    archive_root: &std::path::Path,
    shard: &str,
) -> Result<confined::Dir, String> {
    // Re-checked at the point of use: exactly two lowercase hex digits, so no
    // other component of the CAS root is nameable through this function.
    if shard.len() != 2
        || !shard
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(codes::SHARD_UNAVAILABLE.to_string());
    }
    let root = confined::Dir::open_existing_nofollow(archive_root)
        .map_err(|_| codes::ROOT_UNAVAILABLE.to_string())?;
    let assets = root
        .open_child_nofollow(crate::archive_durable_write::CAS_DIR.as_bytes())
        .map_err(|_| codes::SHARD_UNAVAILABLE.to_string())?;
    assets
        .open_child_nofollow(shard.as_bytes())
        .map_err(|_| codes::SHARD_UNAVAILABLE.to_string())
}

/// Makes a completed quarantine rename DURABLE.
///
/// The no-replace move is atomic but not durable: after it returns, a crash
/// can still leave the directory entries unwritten. The namespace transition spans
/// TWO directories — the source loses an entry and the destination gains one —
/// so both must be synchronized before anything may claim the move survived a
/// crash boundary, and before the item is purged.
///
/// `source` is whichever canonical namespace the entry left: `archive/packages`
/// for a generation or generation-staging move, one `archive/assets/<aa>` shard
/// for a durable-temp move. One barrier serves both, so the two families cannot
/// drift apart on durability.
///
/// The run directory's own entry inside `.h2o-reclaim` was already made durable
/// by `create_run`, so a crash cannot leave a quarantined item parented by a
/// directory that does not exist.
///
/// Both handles are the descriptors already held for the move; nothing is
/// reopened and no path is resolved.
pub fn durable_quarantine_transition(
    _exclusive: &ExclusiveOwnership<'_>,
    source: &confined::Dir,
    run: &RunDir,
) -> Result<(), String> {
    // Destination first: the entry that must exist after a crash.
    run.dir
        .sync()
        .map_err(|_| codes::QUARANTINE_NOT_DURABLE.to_string())?;
    // Then the source, whose entry removal must not be lost.
    source
        .sync()
        .map_err(|_| codes::QUARANTINE_NOT_DURABLE.to_string())?;
    Ok(())
}

/// The outcome of one bounded purge. Partial failure is reported, never
/// rounded up into success.
#[derive(serde::Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct PurgeOutcome {
    /// True only when the target is gone AND nothing was left behind.
    pub converged: bool,
    /// Entries actually unlinked.
    pub removed: usize,
    /// True when the target was already absent — the idempotent re-run case.
    pub already_absent: bool,
    pub blockers: Vec<String>,
}

impl PurgeOutcome {
    fn fail(&mut self, code: &str) {
        self.converged = false;
        let code = code.to_string();
        if !self.blockers.contains(&code) {
            self.blockers.push(code);
        }
    }
}

/// Removes one quarantined item and everything beneath it.
///
/// Requires the P1 exclusive-ownership capability by type, so it cannot be
/// invoked while the archive may be concurrently mutated. It accepts NO path:
/// only the opaque quarantine handle and a validated `<run>/<item>` pair, so
/// the canonical archive root, `archive/packages`, `archive/assets`,
/// `.h2o-archive.lock` and the reclaim root itself are all unreachable — not by
/// refusal, but because no value of the argument types can name them.
///
/// Idempotent: an already-absent target converges without error, which is what
/// the crash-recovery model needs from a re-run.
pub fn purge_quarantined_item(
    _exclusive: &ExclusiveOwnership<'_>,
    root: &ReclaimRoot,
    target: &QuarantineTarget,
) -> PurgeOutcome {
    let mut out = PurgeOutcome {
        converged: true,
        ..PurgeOutcome::default()
    };

    let run_name = target.run.component().as_bytes();
    let run = match root.dir.stat_child_nofollow(run_name) {
        Ok(None) => {
            out.already_absent = true;
            return out;
        }
        Ok(Some(_)) => match root.dir.open_child_nofollow(run_name) {
            Ok(dir) => dir,
            Err(_) => {
                out.fail(codes::RUN_UNREADABLE);
                return out;
            }
        },
        Err(_) => {
            out.fail(codes::RUN_UNREADABLE);
            return out;
        }
    };

    let item_name = target.item.as_str().as_bytes();
    let st = match run.stat_child_nofollow(item_name) {
        Ok(None) => {
            out.already_absent = true;
            return out;
        }
        Ok(Some(st)) => st,
        Err(_) => {
            out.fail(codes::ITEM_UNREADABLE);
            return out;
        }
    };

    // A symlink standing as the item is unlinked as an ENTRY and never
    // followed, so whatever it pointed at is untouched.
    if confined::is_symlink(&st) || !is_dir(&st) {
        match run.unlink_child(item_name) {
            Ok(()) => out.removed += 1,
            Err(_) => out.fail(codes::PURGE_FAILED),
        }
        return out;
    }

    match run.open_child_nofollow(item_name) {
        Ok(dir) => purge_tree(&dir, &mut out, 0),
        Err(_) => {
            out.fail(codes::ITEM_UNREADABLE);
            return out;
        }
    }
    if out.converged {
        match run.unlink_child_dir(item_name) {
            Ok(()) => out.removed += 1,
            Err(_) => out.fail(codes::PURGE_FAILED),
        }
    }
    out
}

/// Depth-first removal beneath an already-opened, quarantine-owned directory.
/// Every step is descriptor-relative and `O_NOFOLLOW`, so no entry can redirect
/// the walk outside the tree it started in.
fn purge_tree(dir: &confined::Dir, out: &mut PurgeOutcome, depth: usize) {
    if depth >= MAX_PURGE_DEPTH {
        out.fail(codes::DEPTH_EXCEEDED);
        return;
    }
    let names = match dir.read_entry_names() {
        Ok(names) => names,
        Err(_) => {
            out.fail(codes::ITEM_UNREADABLE);
            return;
        }
    };
    for name in names {
        let st = match dir.stat_child_nofollow(&name) {
            Ok(Some(st)) => st,
            Ok(None) => continue,
            Err(_) => {
                out.fail(codes::ITEM_UNREADABLE);
                continue;
            }
        };
        if confined::is_symlink(&st) || !is_dir(&st) {
            match dir.unlink_child(&name) {
                Ok(()) => out.removed += 1,
                Err(_) => out.fail(codes::PURGE_FAILED),
            }
            continue;
        }
        match dir.open_child_nofollow(&name) {
            Ok(child) => {
                purge_tree(&child, out, depth + 1);
                drop(child);
                match dir.unlink_child_dir(&name) {
                    Ok(()) => out.removed += 1,
                    Err(_) => out.fail(codes::PURGE_FAILED),
                }
            }
            Err(_) => out.fail(codes::ITEM_UNREADABLE),
        }
    }
}

/// M06 T3.5 — deterministic PROCESS-CRASH injection for the convergence matrix.
///
/// TEST-ONLY, and shaped like the existing fault seam: in a release build `hit`
/// is an empty inlined function with no state, no env lookup and no branch, so
/// the shipped path is byte-for-byte the real one. There is no production crash
/// switch and no production environment-variable behaviour.
///
/// It differs from `fault` in kind, not degree. A fault makes a step RETURN an
/// error, which proves the in-process failure policy. This aborts the process
/// at that exact window, which is the only way to prove what a real crash
/// leaves on disk and that the OS — not any cleanup code of ours — releases the
/// archive lock. One shared seam serves the generation, staging, occupant and
/// recovery paths so their crash windows cannot drift apart.
pub(crate) mod crash {
    /// Every window where a crash would be dangerous if the ordering were wrong.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Point {
        AfterPlanDurableBeforeRename,
        AfterRenameBeforeNamespaceDurable,
        AfterNamespaceDurableBeforeReceipt,
        AfterReceiptBeforePurge,
        AfterPurgeBeforePurgeReceipt,
        BetweenGenerationItems,
        AfterGenerationStageBeforeStaging,
        AfterResidueRenameBeforeNamespaceDurable,
        AfterResidueNamespaceDurableBeforeReceipt,
        AfterResidueReceiptBeforePurge,
        BetweenStagingItems,
        AfterOccupantPlanDurableBeforeRename,
        AfterOccupantRenameBeforeNamespaceDurable,
        AfterOccupantNamespaceDurableBeforeReceipt,
        AfterRecoveryPurgeBeforeReceipt,
    }

    #[cfg(test)]
    impl Point {
        /// The wire name a child test process is given. Parsing is TOTAL: an
        /// unknown name arms nothing rather than guessing a window.
        pub fn parse(text: &str) -> Option<Point> {
            Some(match text {
                "plan-before-rename" => Point::AfterPlanDurableBeforeRename,
                "rename-before-durable" => Point::AfterRenameBeforeNamespaceDurable,
                "durable-before-receipt" => Point::AfterNamespaceDurableBeforeReceipt,
                "receipt-before-purge" => Point::AfterReceiptBeforePurge,
                "purge-before-receipt" => Point::AfterPurgeBeforePurgeReceipt,
                "between-generations" => Point::BetweenGenerationItems,
                "generations-before-staging" => Point::AfterGenerationStageBeforeStaging,
                "residue-rename-before-durable" => Point::AfterResidueRenameBeforeNamespaceDurable,
                "residue-durable-before-receipt" => {
                    Point::AfterResidueNamespaceDurableBeforeReceipt
                }
                "residue-receipt-before-purge" => Point::AfterResidueReceiptBeforePurge,
                "between-staging" => Point::BetweenStagingItems,
                "occupant-plan-before-rename" => Point::AfterOccupantPlanDurableBeforeRename,
                "occupant-rename-before-durable" => {
                    Point::AfterOccupantRenameBeforeNamespaceDurable
                }
                "occupant-durable-before-receipt" => {
                    Point::AfterOccupantNamespaceDurableBeforeReceipt
                }
                "recovery-purge-before-receipt" => Point::AfterRecoveryPurgeBeforeReceipt,
                _ => return None,
            })
        }
    }

    #[cfg(test)]
    thread_local! {
        /// (window, how many arrivals to let through first).
        static ARMED: std::cell::RefCell<Option<(Point, u32)>> =
            const { std::cell::RefCell::new(None) };
    }

    /// Arms ONE crash. `skip` lets a test land on the second or later arrival at
    /// the same window, which is how "between two items" is expressed without a
    /// second hook.
    #[cfg(test)]
    pub(crate) fn arm(point: Point, skip: u32) {
        ARMED.with(|a| *a.borrow_mut() = Some((point, skip)));
    }

    #[cfg(test)]
    pub(crate) fn clear() {
        ARMED.with(|a| *a.borrow_mut() = None);
    }

    /// Aborts the PROCESS. Deliberately `abort` and not `exit`: no destructor,
    /// no unwinding, no flush — nothing of ours gets a chance to tidy up, which
    /// is what makes the surviving state a genuine crash landing.
    #[cfg(test)]
    pub(crate) fn hit(point: Point) {
        let fire = ARMED.with(|a| match a.borrow_mut().as_mut() {
            Some((armed, remaining)) if *armed == point => {
                if *remaining == 0 {
                    true
                } else {
                    *remaining -= 1;
                    false
                }
            }
            _ => false,
        });
        if fire {
            std::process::abort();
        }
    }

    #[cfg(not(test))]
    #[inline(always)]
    pub(crate) fn hit(_point: Point) {}
}

#[cfg(test)]
mod tests;
