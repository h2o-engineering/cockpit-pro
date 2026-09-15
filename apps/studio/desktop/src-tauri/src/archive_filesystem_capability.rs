//! T02 — class O of the frozen cross-platform filesystem safety contract:
//! runtime filesystem capability detection for governed Saved-Chat roots.
//!
//! Three facts are kept apart and never interchanged (contract §10):
//!
//! * COMPILE-TIME PLATFORM SUPPORT — a `cfg` arm exists for a primitive
//!   class on this OS. Its absence is reported by the owning operation as
//!   `…-unsupported-platform` and is never evidence that a primitive works.
//! * RUNTIME FILESYSTEM CAPABILITY — a behavioural probe on the admitted
//!   governed root, in this process, proved the semantics. Its absence is
//!   `…-capability-unproven`: environmental, mutating nothing, retryable only
//!   after remount / relocation.
//! * NATIVE CERTIFICATION STATUS — Mission evidence recorded in Management;
//!   never queried at runtime and never a runtime gate.
//!
//! Rules implemented here:
//! 1. probes run in the reserved probe namespace `.h2o-probe-<pid>-<n>`
//!    directly under the governed root (a reserved component prefix, so no
//!    renderer path can name it and every scanner classifies residue as
//!    reserved infrastructure); the probe removes its own artifacts;
//! 2. a probe runs at most once per root identity per process and is
//!    re-run on the next admission after a failure — never on a timer; a
//!    stale positive can never select a weaker mechanism because every
//!    use-time refusal is still honoured as a refusal;
//! 3. nothing is inferred from `statfs` magic, volume names, OS versions,
//!    compilation or symbol presence — those are evidence detail only;
//! 4. no capability selects a fallback: the only "two spellings of one
//!    primitive" is the Linux descriptor-bound link (`AT_EMPTY_PATH` vs
//!    `/proc/self/fd`), both fd-bound.
//!
//! This module adds no command, no renderer input and no authority.

use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::archive_durable_write::confined::{self, LinkByHandleSpelling, ObjectIdentity};

/// The reserved probe namespace prefix (contract §10 rule 1, §12).
pub(crate) const PROBE_PREFIX: &str = ".h2o-probe-";

static PROBE_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The seven runtime capabilities of contract §10.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Capability {
    /// CAP-EXCL — sequential create-or-fail honoured (sanity only; atomicity is
    /// platform contract proven natively by T03 C01).
    Exclusive,
    /// CAP-XRENAME — no-replace rename collides on an existing entry.
    NoReplaceRename,
    /// CAP-TMPFILE — Linux anonymous publication staging.
    AnonymousFile,
    /// CAP-LINK-BY-FD — Linux descriptor-bound link insertion.
    LinkByHandle,
    /// CAP-DIRFSYNC / CAP-DIRFLUSH — the namespace fence is accepted on the root.
    DirectoryFence,
}

impl Capability {
    pub fn id(self) -> &'static str {
        match self {
            Capability::Exclusive => "CAP-EXCL",
            Capability::NoReplaceRename => "CAP-XRENAME",
            Capability::AnonymousFile => "CAP-TMPFILE",
            Capability::LinkByHandle => "CAP-LINK-BY-FD",
            Capability::DirectoryFence => {
                if cfg!(windows) {
                    "CAP-DIRFLUSH"
                } else {
                    "CAP-DIRFSYNC"
                }
            }
        }
    }
}

/// What one probe established.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CapabilityState {
    /// The behavioural probe passed on this root in this process.
    Proven,
    /// The probe failed or was refused; the detail names the observed refusal.
    Absent(String),
    /// The platform's realization does not use this capability.
    NotApplicable,
}

impl CapabilityState {
    pub fn is_proven(&self) -> bool {
        matches!(self, CapabilityState::Proven)
    }
}

/// The per-root capability report.
#[derive(Clone, Debug)]
pub struct CapabilityReport {
    pub root: ObjectIdentity,
    pub exclusive: CapabilityState,
    pub no_replace_rename: CapabilityState,
    pub anonymous_file: CapabilityState,
    pub link_by_handle: CapabilityState,
    /// Which fd-bound link spelling the probe proved (Linux only).
    pub link_spelling: Option<LinkByHandleSpelling>,
    pub directory_fence: CapabilityState,
    /// Declared / reported volume facts. Evidence only, never proof.
    pub evidence: Vec<String>,
}

impl CapabilityReport {
    pub fn state(&self, capability: Capability) -> &CapabilityState {
        match capability {
            Capability::Exclusive => &self.exclusive,
            Capability::NoReplaceRename => &self.no_replace_rename,
            Capability::AnonymousFile => &self.anonymous_file,
            Capability::LinkByHandle => &self.link_by_handle,
            Capability::DirectoryFence => &self.directory_fence,
        }
    }

    /// The first required capability that is not proven, if any.
    pub fn first_unproven(&self, required: &[Capability]) -> Option<(Capability, String)> {
        required.iter().find_map(|cap| match self.state(*cap) {
            CapabilityState::Proven => None,
            CapabilityState::Absent(detail) => Some((*cap, detail.clone())),
            CapabilityState::NotApplicable => {
                Some((*cap, "not-applicable-on-this-platform".to_string()))
            }
        })
    }
}

/// A refusal to rely on an unproven capability. The owning operation maps it
/// to its own `…-capability-unproven` code; `detail` carries the capability
/// id and the observed refusal for diagnosis.
///
/// `root_not_writable` marks the one case that is NOT a filesystem
/// capability fact: the process cannot create anything under the root at all
/// (permission denied / read-only filesystem), so no probe could be
/// conducted. The owning operation keeps its accepted infrastructure code for
/// that condition (`create-failed`, `publish-failed`, …) — it still mutates
/// nothing, and nothing weaker is selected.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityRefusal {
    pub capability: Capability,
    pub detail: String,
    pub root_not_writable: bool,
}

impl CapabilityRefusal {
    pub fn detail_text(&self) -> String {
        format!("{}:{}", self.capability.id(), self.detail)
    }

    /// True when the root could not be probed because it is not writable by
    /// this process — a permission condition, never a capability verdict.
    pub fn is_root_not_writable(&self) -> bool {
        self.root_not_writable
    }
}

/// Permission denied or a read-only filesystem: the root cannot be written by
/// this process, so no capability can be probed and none is claimed absent.
fn root_not_writable(err: &std::io::Error) -> bool {
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    #[cfg(unix)]
    {
        matches!(
            err.raw_os_error(),
            Some(libc::EROFS) | Some(libc::EACCES) | Some(libc::EPERM)
        )
    }
    #[cfg(windows)]
    {
        // ERROR_ACCESS_DENIED (5), ERROR_WRITE_PROTECT (19).
        matches!(err.raw_os_error(), Some(5) | Some(19))
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

/// The capabilities a create-only regular-file publication into an archive
/// directory needs on this platform (classes D, F/H, K).
pub fn file_publication_requirements() -> &'static [Capability] {
    #[cfg(target_os = "linux")]
    {
        &[
            Capability::Exclusive,
            Capability::AnonymousFile,
            Capability::LinkByHandle,
            Capability::DirectoryFence,
        ]
    }
    #[cfg(not(target_os = "linux"))]
    {
        &[
            Capability::Exclusive,
            Capability::NoReplaceRename,
            Capability::DirectoryFence,
        ]
    }
}

/// Class I (controlled replacement) needs a named exclusive temp and the
/// namespace fence; the replacing rename itself is platform contract.
pub fn controlled_replacement_requirements() -> &'static [Capability] {
    &[Capability::Exclusive, Capability::DirectoryFence]
}

/// Create-only DIRECTORY publication (classes E, G, K).
pub fn directory_publication_requirements() -> &'static [Capability] {
    &[
        Capability::Exclusive,
        Capability::NoReplaceRename,
        Capability::DirectoryFence,
    ]
}

/// No-replace quarantine move (classes M, K).
pub fn move_requirements() -> &'static [Capability] {
    &[Capability::NoReplaceRename, Capability::DirectoryFence]
}

/// Durable create-only receipt (classes D, J, K).
pub fn receipt_requirements() -> &'static [Capability] {
    &[Capability::Exclusive, Capability::DirectoryFence]
}

static CACHE: Mutex<BTreeMap<ObjectIdentity, CapabilityReport>> = Mutex::new(BTreeMap::new());

fn probe_name(n: u64) -> Vec<u8> {
    format!("{PROBE_PREFIX}{}-{n}", std::process::id()).into_bytes()
}

fn next_probe_name() -> Vec<u8> {
    probe_name(PROBE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

fn absent(err: &std::io::Error) -> CapabilityState {
    CapabilityState::Absent(err.to_string())
}

/// Why a probe could not produce a report at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProbeFailure {
    /// The root cannot be written by this process (permission / read-only).
    RootNotWritable(String),
    /// The root object's identity or the probe itself was unavailable.
    Unavailable(String),
}

/// Runs every probe on `root` now, without consulting the cache.
pub fn probe_root(root: &confined::Dir) -> Result<CapabilityReport, ProbeFailure> {
    let identity = root.identity().map_err(|err| {
        ProbeFailure::Unavailable(format!("capability-probe-root-identity-unavailable:{err}"))
    })?;
    let declared = root.declared_volume_capabilities();
    let mut evidence = Vec::new();
    if let Some(name) = declared.filesystem_name_string() {
        evidence.push(format!("filesystem:{name}"));
    }
    if let Some(flag) = declared.rename_excl {
        evidence.push(format!("declared-rename-excl:{flag}"));
    }
    if let Some(flag) = declared.clone {
        evidence.push(format!("declared-clone:{flag}"));
    }

    // CAP-DIRFSYNC / CAP-DIRFLUSH: the fence must be accepted on the root
    // object before any publication may rely on it.
    let directory_fence = match root.sync() {
        Ok(()) => CapabilityState::Proven,
        Err(err) => absent(&err),
    };

    // CAP-EXCL: a second exclusive create of one private probe name must
    // collide.
    let excl_name = next_probe_name();
    let exclusive = match root.create_new_child(&excl_name) {
        Err(err) if root_not_writable(&err) => {
            return Err(ProbeFailure::RootNotWritable(err.to_string()));
        }
        Ok(first) => {
            let second = root.create_new_child(&excl_name);
            let state = match second {
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    CapabilityState::Proven
                }
                Err(err) => absent(&err),
                Ok(_) => CapabilityState::Absent("second-exclusive-create-succeeded".into()),
            };
            drop(first);
            state
        }
        Err(err) => absent(&err),
    };
    let _ = root.unlink_child(&excl_name);

    // CAP-XRENAME: probed on DIRECTORIES so every platform exercises the exact
    // create-only directory publication primitive (class G): a no-replace
    // rename onto an existing probe directory must collide, and onto an
    // absent name must succeed. macOS must additionally DECLARE the volume
    // capability (declared AND behavioural, contract §10).
    let no_replace_rename = probe_no_replace_rename(root, declared.rename_excl);

    // Linux-only: anonymous staging + descriptor-bound link.
    let (anonymous_file, link_by_handle, link_spelling) = probe_linux_file_publication(root);

    Ok(CapabilityReport {
        root: identity,
        exclusive,
        no_replace_rename,
        anonymous_file,
        link_by_handle,
        link_spelling,
        directory_fence,
        evidence,
    })
}

fn probe_no_replace_rename(
    root: &confined::Dir,
    declared_rename_excl: Option<bool>,
) -> CapabilityState {
    if cfg!(target_os = "macos") && declared_rename_excl == Some(false) {
        return CapabilityState::Absent("volume-does-not-declare-rename-excl".into());
    }
    let staging_name = next_probe_name();
    let occupied_name = next_probe_name();
    let free_name = next_probe_name();
    if let Err(err) = root.mkdir_child_exclusive(&staging_name) {
        return absent(&err);
    }
    let staging = match root.open_child_nofollow(&staging_name) {
        Ok(dir) => dir,
        Err(err) => {
            let _ = root.unlink_child_dir(&staging_name);
            return absent(&err);
        }
    };
    if let Err(err) = root.mkdir_child_exclusive(&occupied_name) {
        let _ = root.unlink_child_dir(&staging_name);
        return absent(&err);
    }
    // Onto an existing name: MUST collide (Ok(false)), never replace.
    let collision = root.promote_dir_exclusive(&staging, &staging_name, &occupied_name);
    let state = match collision {
        Ok(false) => {
            // Onto an absent name: MUST succeed, proving the flag is honoured
            // rather than merely refused.
            match root.promote_dir_exclusive(&staging, &staging_name, &free_name) {
                Ok(true) => {
                    let _ = root.unlink_child_dir(&free_name);
                    CapabilityState::Proven
                }
                Ok(false) => {
                    let _ = root.unlink_child_dir(&staging_name);
                    CapabilityState::Absent("no-replace-rename-refused-an-absent-name".into())
                }
                Err(err) => {
                    let _ = root.unlink_child_dir(&staging_name);
                    absent(&err)
                }
            }
        }
        Ok(true) => {
            // The occupant was replaced or the staging entry adopted its name:
            // exactly the behaviour create-only publication forbids.
            let _ = root.unlink_child_dir(&occupied_name);
            let _ = root.unlink_child_dir(&staging_name);
            CapabilityState::Absent("no-replace-rename-replaced-an-existing-entry".into())
        }
        Err(err) => {
            let _ = root.unlink_child_dir(&staging_name);
            absent(&err)
        }
    };
    drop(staging);
    let _ = root.unlink_child_dir(&occupied_name);
    state
}

#[cfg(target_os = "linux")]
fn probe_linux_file_publication(
    root: &confined::Dir,
) -> (
    CapabilityState,
    CapabilityState,
    Option<LinkByHandleSpelling>,
) {
    use std::io::Write;
    let file = match root.create_anonymous_child() {
        Ok(file) => file,
        Err(err) => {
            return (
                absent(&err),
                CapabilityState::Absent("anonymous-staging-unavailable".into()),
                None,
            )
        }
    };
    let mut file = file;
    if let Err(err) = file.write_all(b"h2o-probe") {
        return (
            absent(&err),
            CapabilityState::Absent("probe-write-failed".into()),
            None,
        );
    }
    let name = next_probe_name();
    let (link_state, spelling) = match root.publish_file_by_handle_spelled(&file, &name, None) {
        Ok((true, spelling)) => {
            // A second insertion under the same name must collide.
            let second = root.publish_file_by_handle_spelled(&file, &name, Some(spelling));
            let state = match second {
                Ok((false, _)) => CapabilityState::Proven,
                Ok((true, _)) => {
                    CapabilityState::Absent("second-link-under-an-occupied-name-succeeded".into())
                }
                Err(err) => absent(&err),
            };
            let _ = root.unlink_child(&name);
            (state, Some(spelling))
        }
        Ok((false, _)) => (
            CapabilityState::Absent("probe-name-unexpectedly-occupied".into()),
            None,
        ),
        Err(err) => (absent(&err), None),
    };
    (CapabilityState::Proven, link_state, spelling)
}

#[cfg(not(target_os = "linux"))]
fn probe_linux_file_publication(
    _root: &confined::Dir,
) -> (
    CapabilityState,
    CapabilityState,
    Option<LinkByHandleSpelling>,
) {
    (
        CapabilityState::NotApplicable,
        CapabilityState::NotApplicable,
        None,
    )
}

/// The cached report for `root`, probing on first admission of this root
/// identity in this process. A report with any absent capability is re-probed
/// on the next admission (the environment may have changed); a fully proven
/// report is reused.
pub fn report_for(root: &confined::Dir) -> Result<CapabilityReport, ProbeFailure> {
    let identity = root.identity().map_err(|err| {
        ProbeFailure::Unavailable(format!("capability-probe-root-identity-unavailable:{err}"))
    })?;
    if let Ok(cache) = CACHE.lock() {
        if let Some(report) = cache.get(&identity) {
            let fully_proven = [
                &report.exclusive,
                &report.no_replace_rename,
                &report.directory_fence,
                &report.anonymous_file,
                &report.link_by_handle,
            ]
            .iter()
            .all(|state| !matches!(state, CapabilityState::Absent(_)));
            if fully_proven {
                return Ok(report.clone());
            }
        }
    }
    let report = probe_root(root)?;
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(identity, report.clone());
    }
    Ok(report)
}

/// Requires every capability in `required` to be proven on `root`. On a
/// refusal the caller mutates nothing and reports `…-capability-unproven`.
pub fn require(
    root: &confined::Dir,
    required: &[Capability],
) -> Result<CapabilityReport, CapabilityRefusal> {
    let report = match report_for(root) {
        Ok(report) => report,
        Err(ProbeFailure::RootNotWritable(detail)) => {
            return Err(CapabilityRefusal {
                capability: Capability::Exclusive,
                detail,
                root_not_writable: true,
            })
        }
        Err(ProbeFailure::Unavailable(detail)) => {
            return Err(CapabilityRefusal {
                capability: Capability::Exclusive,
                detail,
                root_not_writable: false,
            })
        }
    };
    if let Some((capability, detail)) = report.first_unproven(required) {
        return Err(CapabilityRefusal {
            capability,
            detail,
            root_not_writable: false,
        });
    }
    Ok(report)
}

/// macOS CAP-CLONE, per (staging root, final root) pair: the volume must
/// DECLARE `VOL_CAP_INT_CLONE` and a probe inode must clone from the staging
/// root into the final root create-only (a second clone under the same name
/// must collide). On every other platform the portable ZIP is published by
/// a different class and this returns `NotApplicable`.
pub fn probe_clone_pair(staging: &confined::Dir, final_dir: &confined::Dir) -> CapabilityState {
    if !cfg!(target_os = "macos") {
        return CapabilityState::NotApplicable;
    }
    let declared = final_dir.declared_volume_capabilities();
    if declared.clone == Some(false) {
        return CapabilityState::Absent("volume-does-not-declare-clone".into());
    }
    use std::io::Write;
    let source_name = next_probe_name();
    let mut source = match staging.create_new_child(&source_name) {
        Ok(file) => file,
        Err(err) => return absent(&err),
    };
    if let Err(err) = source.write_all(b"h2o-probe") {
        let _ = staging.unlink_child(&source_name);
        return absent(&err);
    }
    let target_name = next_probe_name();
    let state = match final_dir.publish_open_file_clone_exclusive(&source, &target_name) {
        Ok(true) => match final_dir.publish_open_file_clone_exclusive(&source, &target_name) {
            Ok(false) => CapabilityState::Proven,
            Ok(true) => {
                CapabilityState::Absent("second-clone-under-an-occupied-name-succeeded".into())
            }
            Err(err) => absent(&err),
        },
        Ok(false) => CapabilityState::Absent("probe-name-unexpectedly-occupied".into()),
        Err(err) => absent(&err),
    };
    let _ = final_dir.unlink_child(&target_name);
    drop(source);
    let _ = staging.unlink_child(&source_name);
    state
}

/// TEST-ONLY: forgets every cached report so a test can observe a fresh probe.
#[cfg(test)]
pub(crate) fn clear_cache_for_test() {
    if let Ok(mut cache) = CACHE.lock() {
        cache.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scratch(name: &str) -> std::path::PathBuf {
        let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "h2o-fs-capability-{name}-{}-{counter}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("scratch root");
        root
    }

    #[test]
    fn the_probe_namespace_is_a_reserved_component_prefix() {
        assert!(crate::archive_durable_write::is_reserved_component(
            std::str::from_utf8(&probe_name(7)).unwrap()
        ));
        assert!(crate::archive_durable_write::RESERVED_COMPONENT_PREFIXES.contains(&PROBE_PREFIX));
    }

    #[test]
    fn a_probe_leaves_no_artifact_behind_and_reports_platform_shaped_states() {
        let base = scratch("probe-clean");
        let root_path = base.join("archive");
        let root = confined::Dir::open_root(&root_path).expect("root");
        let report = probe_root(&root).expect("probe");
        let leftovers: Vec<_> = std::fs::read_dir(&root_path)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert!(leftovers.is_empty(), "probe residue: {leftovers:?}");
        if cfg!(target_os = "linux") {
            assert_ne!(report.anonymous_file, CapabilityState::NotApplicable);
            assert_ne!(report.link_by_handle, CapabilityState::NotApplicable);
        } else {
            assert_eq!(report.anonymous_file, CapabilityState::NotApplicable);
            assert_eq!(report.link_by_handle, CapabilityState::NotApplicable);
        }
        // Whatever the host filesystem, the report never claims a capability
        // without a proven or explicitly absent state.
        for state in [
            &report.exclusive,
            &report.no_replace_rename,
            &report.directory_fence,
        ] {
            assert!(matches!(
                state,
                CapabilityState::Proven | CapabilityState::Absent(_)
            ));
        }
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn a_fully_proven_report_is_cached_per_root_identity() {
        let base = scratch("probe-cache");
        let root_path = base.join("archive");
        let root = confined::Dir::open_root(&root_path).expect("root");
        clear_cache_for_test();
        let first = report_for(&root).expect("first");
        let second = report_for(&root).expect("second");
        assert_eq!(first.root, second.root);
        assert_eq!(first.exclusive, second.exclusive);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn required_capabilities_are_platform_shaped_and_never_empty() {
        assert!(!file_publication_requirements().is_empty());
        assert!(file_publication_requirements().contains(&Capability::DirectoryFence));
        assert!(directory_publication_requirements().contains(&Capability::NoReplaceRename));
        assert!(move_requirements().contains(&Capability::NoReplaceRename));
        if cfg!(target_os = "linux") {
            assert!(file_publication_requirements().contains(&Capability::LinkByHandle));
        } else {
            assert!(file_publication_requirements().contains(&Capability::NoReplaceRename));
        }
    }

    #[test]
    fn first_unproven_names_the_capability_and_its_detail() {
        let report = CapabilityReport {
            root: ObjectIdentity {
                device: 1,
                object: 2,
            },
            exclusive: CapabilityState::Proven,
            no_replace_rename: CapabilityState::Absent("EINVAL".into()),
            anonymous_file: CapabilityState::NotApplicable,
            link_by_handle: CapabilityState::NotApplicable,
            link_spelling: None,
            directory_fence: CapabilityState::Proven,
            evidence: vec![],
        };
        let (cap, detail) = report
            .first_unproven(directory_publication_requirements())
            .expect("xrename absent");
        assert_eq!(cap, Capability::NoReplaceRename);
        assert_eq!(detail, "EINVAL");
        assert!(report.first_unproven(receipt_requirements()).is_none());
        let refusal = CapabilityRefusal {
            capability: cap,
            detail,
            root_not_writable: false,
        };
        assert_eq!(refusal.detail_text(), "CAP-XRENAME:EINVAL");
        assert!(!refusal.is_root_not_writable());
    }
}
