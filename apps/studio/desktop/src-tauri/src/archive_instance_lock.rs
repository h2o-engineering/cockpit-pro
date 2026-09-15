//! M06 T1.1 — archive instance-presence lock and in-process mutation gate.
//!
//! Two separate authorities, deliberately not merged:
//!
//! 1. **Instance presence** — an OS-backed `flock(2)` on one file under the
//!    archive root. Every M06-aware instance holds it SHARED for its whole
//!    lifetime. A future reclamation preflight converts that same descriptor to
//!    EXCLUSIVE; success is positive proof that no other participating instance
//!    is executing against this archive root.
//!
//! 2. **In-process mutation gate** — an `RwLock` every trusted archive-mutating
//!    command execution enters on the shared side. A future reclamation takes
//!    the exclusive side to hold new mutations off.
//!
//! Why one descriptor: `flock` scopes a lock to an *open file description*, so
//! two `open()` calls in one process contend with each other. An instance that
//! opened a second descriptor to ask for EXCLUSIVE would be refused by its own
//! SHARED lock and could never reclaim. So the instance converts the
//! description it already holds, and thereby contends only with *other*
//! instances.
//!
//! Conversion is NOT atomic. macOS `flock(2)` states plainly:
//!
//! > A shared lock may be upgraded to an exclusive lock, and vice versa …
//! > this results in the previous lock being released and the new lock applied
//! > (possibly after other processes have gained and released the lock).
//!
//! So a *failed* upgrade must never be read as "the shared lock survived", and
//! a downgrade must never be read as uninterrupted participation. Only a
//! *successful* acquisition is a proof point. Every transition therefore runs
//! with the in-process mutation gate held exclusively, and presence is tracked
//! as an explicit state whose unknown/failed value keeps mutation closed until
//! shared participation has been positively re-established.
//!
//! Scope: this module adds no destructive capability. It cannot unlink, rename
//! or purge anything, and it registers no command. See
//! `docs/systems/archive/saved-chat-reclamation.md` §D, §I, AC-M06-03,
//! AC-M06-05.

use std::path::Path;
use std::sync::RwLock;

/// The instance-presence lock file, directly under the archive root.
///
/// Dot-leading, so package discovery (which requires a literal leading dot to
/// match) never sees it, and it does not end in `.h2ochat`, so it can never be
/// mistaken for a generation. The renderer holds no archive write capability,
/// so nothing renderer-side can create, replace or remove it.
pub const ARCHIVE_LOCK_NAME: &str = ".h2o-archive.lock";

/// Stable, narrow refusals. Every one of these is ENVIRONMENTAL and RETRYABLE:
/// none of them means a package is invalid, corrupt, hash-mismatched, or
/// permanently blocked. Callers must map them to the retryable family.
pub mod codes {
    /// Another participating instance holds presence; exclusive was refused.
    pub const INSTANCE_LOCK_BUSY: &str = "archive-instance-lock-busy";
    /// The lock file or its directory could not be opened/created.
    pub const INSTANCE_LOCK_UNAVAILABLE: &str = "archive-instance-lock-unavailable";
    /// This platform has no supported presence primitive — fail closed.
    pub const INSTANCE_LOCK_UNSUPPORTED: &str = "archive-instance-lock-unsupported-platform";
    /// T02 (contract §10 CAP-PRESENCE): the lock file's filesystem gives
    /// per-process rather than per-open-object lock semantics (e.g. an NFS
    /// `flock` emulation), so presence cannot be proven there — fail closed.
    pub const INSTANCE_LOCK_UNSUPPORTED_FILESYSTEM: &str =
        "archive-instance-lock-unsupported-filesystem";
    /// A different archive root was presented than the one enrolled at setup.
    pub const INSTANCE_LOCK_ROOT_MISMATCH: &str = "archive-instance-lock-root-mismatch";
    /// The in-process mutation gate is held exclusively right now.
    pub const MUTATION_GATE_BUSY: &str = "archive-mutation-gate-busy";
    /// The gate was poisoned by a panicking holder.
    pub const MUTATION_GATE_UNAVAILABLE: &str = "archive-mutation-gate-unavailable";
}

/// True for every refusal this module can produce. Used by callers (and by the
/// tests) to assert the whole vocabulary stays in the retryable family.
pub fn is_retryable_environmental(code: &str) -> bool {
    matches!(
        code,
        codes::INSTANCE_LOCK_BUSY
            | codes::INSTANCE_LOCK_UNAVAILABLE
            | codes::INSTANCE_LOCK_UNSUPPORTED
            | codes::INSTANCE_LOCK_UNSUPPORTED_FILESYSTEM
            | codes::INSTANCE_LOCK_ROOT_MISMATCH
            | codes::MUTATION_GATE_BUSY
            | codes::MUTATION_GATE_UNAVAILABLE
    )
}

// ── Instance presence (OS-backed) ───────────────────────────────────────────

mod presence {
    //! T02: one platform-neutral presence module over the `confined` facade
    //! (class N). The lock file is opened RELATIVE to the admitted archive
    //! root with a no-follow open (contract MB-03), so a symlink standing at
    //! the lock name or at the archive root is refused rather than followed;
    //! nothing is ever written to it. `flock` on Unix, `LockFileEx` on
    //! Windows; every platform's conversion is non-atomic and only a
    //! SUCCESSFUL acquisition is a proof point.
    use super::codes;
    use crate::archive_durable_write::confined;
    use std::fs::File;
    use std::path::Path;

    /// A held presence handle. Dropping it closes the handle, which releases
    /// the lock — including on abnormal process exit, because the kernel
    /// closes handles for us. That is what makes crash release work without
    /// any journal or stale-lock heuristic.
    pub struct Presence {
        file: File,
    }

    fn lock_error(err: &std::io::Error) -> String {
        if confined::lock_would_block(err) {
            codes::INSTANCE_LOCK_BUSY.to_string()
        } else if err.kind() == std::io::ErrorKind::Unsupported {
            codes::INSTANCE_LOCK_UNSUPPORTED.to_string()
        } else {
            codes::INSTANCE_LOCK_UNAVAILABLE.to_string()
        }
    }

    fn open_error(err: &std::io::Error) -> String {
        if err.kind() == std::io::ErrorKind::Unsupported {
            codes::INSTANCE_LOCK_UNSUPPORTED.to_string()
        } else {
            codes::INSTANCE_LOCK_UNAVAILABLE.to_string()
        }
    }

    impl Presence {
        /// Admits the archive root, opens (creating if needed) the lock file
        /// relative to it, takes SHARED presence, and PROVES the lock
        /// semantics (contract §10 CAP-PRESENCE): while shared is held on this
        /// handle, an exclusive request on a SECOND handle to the same file in
        /// this process must be refused. If it succeeds the filesystem locks
        /// per process (an `flock` emulation), presence cannot be proven, and
        /// every trusted mutation on this root refuses. Non-blocking
        /// throughout: a would-block is reported, never waited on.
        pub fn acquire_shared(root: &Path) -> Result<Presence, String> {
            let dir = confined::Dir::open_root(root).map_err(|err| open_error(&err))?;
            let file = dir
                .open_lock_file(super::ARCHIVE_LOCK_NAME.as_bytes())
                .map_err(|err| open_error(&err))?;
            confined::lock_shared(&file).map_err(|err| lock_error(&err))?;
            let probe = dir
                .open_lock_file(super::ARCHIVE_LOCK_NAME.as_bytes())
                .map_err(|err| open_error(&err))?;
            match confined::lock_exclusive(&probe) {
                Ok(()) => {
                    let _ = confined::unlock(&probe);
                    drop(probe);
                    return Err(codes::INSTANCE_LOCK_UNSUPPORTED_FILESYSTEM.to_string());
                }
                Err(err) if confined::lock_would_block(&err) => {}
                Err(err) => return Err(lock_error(&err)),
            }
            drop(probe);
            Ok(Presence { file })
        }

        /// Requests EXCLUSIVE on THIS handle, without blocking.
        ///
        /// Success is the proof point: no other open file description holds
        /// the lock, so no other participating instance is executing against
        /// this archive root. FAILURE PROVES NOTHING ABOUT THE PRIOR SHARED
        /// LOCK — the kernel releases it before applying the new type — so the
        /// caller MUST re-establish shared presence explicitly rather than
        /// assuming it survived.
        pub fn request_exclusive(&self) -> Result<(), String> {
            confined::lock_exclusive(&self.file).map_err(|err| lock_error(&err))
        }

        /// TEST-ONLY. Drops the lock on this handle while keeping the handle
        /// open, reproducing the state every platform documents
        /// mid-transition: "the previous lock being released and the new lock
        /// applied". Real code never calls this; it exists so the restoration
        /// path can be proven against the CONTRACT rather than against one
        /// platform's current behaviour.
        #[cfg(test)]
        pub fn force_unlock_for_test(&self) -> Result<(), String> {
            confined::unlock(&self.file).map_err(|_| codes::INSTANCE_LOCK_UNAVAILABLE.to_string())
        }

        /// Requests SHARED on THIS handle. Used both to establish normal
        /// participation and to RE-establish it after any exclusive attempt,
        /// successful or not. Never assumes a prior lock is still held.
        pub fn request_shared(&self) -> Result<(), String> {
            confined::lock_shared(&self.file).map_err(|err| lock_error(&err))
        }
    }
}

pub use presence::Presence;

// ── In-process mutation gate + presence state machine ───────────────────────

/// What this instance can currently prove about its OS-level presence.
///
/// `Unavailable` is not merely "an error happened": it is the honest state
/// after any transition whose outcome left shared participation unproven. While
/// it holds, trusted archive mutation stays closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceState {
    /// No presence established yet.
    None,
    /// Shared participation positively held.
    Shared,
    /// Exclusive ownership positively held (reclamation interval).
    Exclusive,
    /// Presence is NOT proven. Fail closed until shared is re-established.
    Unavailable,
}

/// Held for exactly one trusted mutating command execution.
///
/// Deliberately NOT held across IPC calls: a generation session spans BEGIN →
/// WRITE MEMBER → COMMIT as separate invokes, and holding a guard across them
/// would deadlock the session or leak on an abandoned one. Each invoke enters
/// and leaves the shared side on its own; session lifetime stays owned by the
/// publisher registry exactly as before.
pub struct MutationEntry<'a>(#[allow(dead_code)] std::sync::RwLockReadGuard<'a, ()>);

/// Exclusive reclamation ownership.
///
/// Holds the in-process mutation gate for the WHOLE interval — including both
/// non-atomic OS transitions — so this process cannot mutate the archive while
/// its presence is in flux. T1.1 provides the primitive; nothing reclaims yet.
pub struct ExclusiveOwnership<'a> {
    owner: &'a ArchiveInstanceState,
    _gate: Option<std::sync::RwLockWriteGuard<'a, ()>>,
}

impl ExclusiveOwnership<'_> {
    /// Ends exclusive ownership and positively re-establishes shared presence
    /// BEFORE normal mutation entry reopens. On failure the instance stays
    /// `Unavailable` and mutation stays closed.
    pub fn release(mut self) -> Result<(), String> {
        let result = self.owner.restore_shared();
        self._gate = None; // reopen the gate only after the state is settled
        result
    }
}

impl Drop for ExclusiveOwnership<'_> {
    fn drop(&mut self) {
        // Best effort on an un-released guard (e.g. a panicking caller). If
        // shared cannot be restored the state stays Unavailable, which keeps
        // mutation closed rather than silently resuming.
        if self._gate.is_some() {
            let _ = self.owner.restore_shared();
        }
    }
}

/// The process-wide archive mutation gate plus this instance's presence.
///
/// Lives in Tauri managed state so every command execution shares one gate.
pub struct ArchiveInstanceState {
    gate: RwLock<()>,
    inner: std::sync::Mutex<PresenceInner>,
}

struct PresenceInner {
    presence: Option<Presence>,
    state: PresenceState,
    /// The canonical archive root this instance enrolled against, captured at
    /// setup. Recovery reuses THIS root; it is never recomputed from a caller,
    /// so a later invocation cannot silently rebind the instance to a
    /// different archive.
    root: Option<std::path::PathBuf>,
    /// True once startup participation has been ATTEMPTED (success or not).
    /// Recovery is gated on it, which is what keeps a later retry "recovery of
    /// failed startup participation" rather than first-time lazy enrolment.
    startup_attempted: bool,
}

impl Default for ArchiveInstanceState {
    fn default() -> Self {
        ArchiveInstanceState {
            gate: RwLock::new(()),
            inner: std::sync::Mutex::new(PresenceInner {
                presence: None,
                state: PresenceState::None,
                root: None,
                startup_attempted: false,
            }),
        }
    }
}

impl ArchiveInstanceState {
    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, PresenceInner>, String> {
        self.inner
            .lock()
            .map_err(|_| codes::INSTANCE_LOCK_UNAVAILABLE.to_string())
    }

    /// Establishes lifetime SHARED presence for this instance against `root`.
    ///
    /// Called at instance startup, not lazily on first mutation: the contract
    /// says every M06-aware instance participates for its lifetime, which is
    /// strictly stronger than "every instance that eventually mutates".
    /// Idempotent while shared presence is already proven.
    pub fn ensure_presence(&self, root: &Path) -> Result<(), String> {
        let mut inner = self.lock_inner()?;
        // Root identity is pinned on first enrolment. A later call naming a
        // DIFFERENT archive root is refused rather than rebinding this
        // instance's presence, which would silently move the protection to
        // another archive.
        match inner.root.as_deref() {
            Some(pinned) if pinned != root => {
                inner.state = PresenceState::Unavailable;
                return Err(codes::INSTANCE_LOCK_ROOT_MISMATCH.to_string());
            }
            Some(_) => {}
            None => inner.root = Some(root.to_path_buf()),
        }
        if inner.state == PresenceState::Shared {
            return Ok(());
        }
        if inner.presence.is_none() {
            match Presence::acquire_shared(root) {
                Ok(presence) => {
                    inner.presence = Some(presence);
                    inner.state = PresenceState::Shared;
                    return Ok(());
                }
                Err(err) => {
                    inner.state = PresenceState::Unavailable;
                    return Err(err);
                }
            }
        }
        // A descriptor exists but shared is unproven: re-request it explicitly.
        let restored = inner
            .presence
            .as_ref()
            .map(|p| p.request_shared())
            .unwrap_or_else(|| Err(codes::INSTANCE_LOCK_UNAVAILABLE.to_string()));
        match restored {
            Ok(()) => {
                inner.state = PresenceState::Shared;
                Ok(())
            }
            Err(err) => {
                inner.state = PresenceState::Unavailable;
                Err(err)
            }
        }
    }

    /// The root pinned at enrolment, if any.
    pub fn pinned_root(&self) -> Option<std::path::PathBuf> {
        self.lock_inner().ok().and_then(|inner| inner.root.clone())
    }

    /// Records that startup participation was attempted, whatever the outcome.
    fn mark_startup_attempted(&self, root: &Path) {
        if let Ok(mut inner) = self.lock_inner() {
            inner.startup_attempted = true;
            if inner.root.is_none() {
                inner.root = Some(root.to_path_buf());
            }
        }
    }

    /// Records a startup participation attempt against `root`, exactly as the
    /// Tauri setup hook does. Public so a test can reproduce the real startup
    /// sequence without constructing a Tauri app.
    pub fn record_startup_attempt(&self, root: &Path) {
        self.mark_startup_attempted(root);
    }

    fn startup_was_attempted(&self) -> bool {
        self.lock_inner().map(|i| i.startup_attempted).unwrap_or(false)
    }

    pub fn presence_state(&self) -> PresenceState {
        self.lock_inner()
            .map(|inner| inner.state)
            .unwrap_or(PresenceState::Unavailable)
    }

    pub fn has_presence(&self) -> bool {
        self.presence_state() == PresenceState::Shared
    }

    /// Enters the shared side for ONE mutating command execution.
    ///
    /// Refuses unless shared presence is POSITIVELY proven, so an instance
    /// whose presence is unknown cannot mutate the archive. Never blocks.
    pub fn enter_mutation(&self) -> Result<MutationEntry<'_>, String> {
        match self.presence_state() {
            PresenceState::Shared => {}
            PresenceState::None | PresenceState::Unavailable => {
                return Err(codes::INSTANCE_LOCK_UNAVAILABLE.to_string())
            }
            // Reclamation owns the archive; new mutation waits.
            PresenceState::Exclusive => return Err(codes::MUTATION_GATE_BUSY.to_string()),
        }
        match self.gate.try_read() {
            Ok(guard) => Ok(MutationEntry(guard)),
            Err(std::sync::TryLockError::WouldBlock) => Err(codes::MUTATION_GATE_BUSY.to_string()),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                Err(codes::MUTATION_GATE_UNAVAILABLE.to_string())
            }
        }
    }

    /// Acquires exclusive reclamation ownership. Reserved for the future
    /// reclamation preflight; T1.1 adds no caller that reclaims.
    ///
    /// Order matters. The in-process gate is taken FIRST and held across both
    /// non-atomic OS transitions, so this process cannot mutate the archive
    /// while its own presence is momentarily released by the kernel.
    pub fn try_acquire_exclusive(&self) -> Result<ExclusiveOwnership<'_>, String> {
        let gate = match self.gate.try_write() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => {
                return Err(codes::MUTATION_GATE_BUSY.to_string())
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(codes::MUTATION_GATE_UNAVAILABLE.to_string())
            }
        };

        let mut inner = self.lock_inner()?;
        if inner.presence.is_none() {
            inner.state = PresenceState::Unavailable;
            return Err(codes::INSTANCE_LOCK_UNAVAILABLE.to_string());
        }

        // The transition begins: from here until it settles, presence is NOT
        // proven, because the kernel releases the old lock before applying the
        // new one.
        inner.state = PresenceState::Unavailable;

        let requested = inner
            .presence
            .as_ref()
            .map(|p| p.request_exclusive())
            .unwrap_or_else(|| Err(codes::INSTANCE_LOCK_UNAVAILABLE.to_string()));

        match requested {
            Ok(()) => {
                inner.state = PresenceState::Exclusive;
                drop(inner);
                Ok(ExclusiveOwnership {
                    owner: self,
                    _gate: Some(gate),
                })
            }
            Err(err) => {
                // The upgrade failed, which says NOTHING about the prior shared
                // lock. Re-establish it explicitly before this instance is
                // allowed to mutate again.
                let restored = inner
                    .presence
                    .as_ref()
                    .map(|p| p.request_shared())
                    .unwrap_or_else(|| Err(codes::INSTANCE_LOCK_UNAVAILABLE.to_string()));
                inner.state = match restored {
                    Ok(()) => PresenceState::Shared,
                    // Cannot prove participation: stay closed.
                    Err(_) => PresenceState::Unavailable,
                };
                Err(err)
            }
        }
    }

    /// TEST-ONLY. Simulates a transition that released the lock and then failed,
    /// exactly as `flock(2)` documents, and runs the production recovery path.
    #[cfg(test)]
    pub fn simulate_failed_transition_for_test(&self) -> Result<(), String> {
        {
            let inner = self.lock_inner()?;
            if let Some(presence) = inner.presence.as_ref() {
                presence.force_unlock_for_test()?;
            }
        }
        // Production recovery: re-establish shared explicitly.
        self.restore_shared()
    }

    /// TEST-ONLY. Releases the lock WITHOUT recovering, so a test can observe
    /// what an unrestored instance looks like from another process.
    #[cfg(test)]
    pub fn force_unlock_without_restore_for_test(&self) -> Result<(), String> {
        let inner = self.lock_inner()?;
        match inner.presence.as_ref() {
            Some(presence) => presence.force_unlock_for_test(),
            None => Err(codes::INSTANCE_LOCK_UNAVAILABLE.to_string()),
        }
    }

    /// Positively re-establishes shared presence. Used when exclusive ownership
    /// ends and after a failed transition.
    fn restore_shared(&self) -> Result<(), String> {
        let mut inner = self.lock_inner()?;
        let restored = inner
            .presence
            .as_ref()
            .map(|p| p.request_shared())
            .unwrap_or_else(|| Err(codes::INSTANCE_LOCK_UNAVAILABLE.to_string()));
        match restored {
            Ok(()) => {
                inner.state = PresenceState::Shared;
                Ok(())
            }
            Err(err) => {
                inner.state = PresenceState::Unavailable;
                Err(err)
            }
        }
    }
}

/// Enters the shared mutation side using the app's managed state.
///
/// Presence is established at instance startup, so this does NOT lazily create
/// participation: an instance whose startup participation failed is refused
/// here rather than quietly becoming a participant at first mutation.
#[cfg(not(h2o_saved_chat_primitive_harness))]
pub fn enter_mutation_for<'a>(
    app: &tauri::AppHandle,
    state: &'a tauri::State<'_, ArchiveInstanceState>,
) -> Result<MutationEntry<'a>, String> {
    // RECOVERY, not lazy enrolment. Startup already attempted participation; if
    // that attempt lost a race with a reclamation-exclusive owner, the instance
    // would otherwise stay unusable until an app restart. So a later ordinary
    // mutation makes ONE inline re-acquisition attempt.
    //
    // Deliberately bounded: no timer, no polling, no background task, no
    // renderer involvement. It runs only when startup already tried and
    // presence is not proven, and it reuses the root pinned at setup so this
    // can never rebind the instance to a different archive.
    let current = crate::archive_durable_write::archive_root(app).ok();
    enter_mutation_recovering(state, current.as_deref())
}

/// The production mutation-entry authority, with the app-path lookup lifted out
/// so it is exercisable directly. `enter_mutation_for` is a thin wrapper around
/// this; tests drive THIS function rather than a private test-only helper.
pub fn enter_mutation_recovering<'a>(
    state: &'a ArchiveInstanceState,
    current_root: Option<&Path>,
) -> Result<MutationEntry<'a>, String> {
    // Root identity is checked on EVERY mutation entry, not only during
    // recovery. If the app's canonical archive root no longer matches the one
    // this instance enrolled against, the presence we hold protects a different
    // archive than the one about to be mutated — fail closed rather than
    // rebind, whatever the current presence state says.
    if let (Some(pinned), Some(current)) = (state.pinned_root(), current_root) {
        if current != pinned.as_path() {
            return Err(codes::INSTANCE_LOCK_ROOT_MISMATCH.to_string());
        }
    }

    if state.startup_was_attempted() {
        match state.presence_state() {
            PresenceState::None | PresenceState::Unavailable => {
                if let Some(pinned) = state.pinned_root() {
                    // A failure here leaves presence Unavailable; the refusal
                    // below is then the same narrow retryable environmental one.
                    let _ = state.ensure_presence(&pinned);
                }
            }
            _ => {}
        }
    }
    state.enter_mutation()
}

/// Establishes this instance's lifetime participation. Called once from the
/// Tauri setup hook, before any command can run.
#[cfg(not(h2o_saved_chat_primitive_harness))]
pub fn establish_startup_presence(
    app: &tauri::AppHandle,
    state: &ArchiveInstanceState,
) -> Result<(), String> {
    let root = crate::archive_durable_write::archive_root(app)?;
    // Record the attempt BEFORE its outcome: a failed startup must still count
    // as "this instance tried to enrol", which is what later distinguishes
    // recovery from first-time lazy participation.
    state.mark_startup_attempted(&root);
    state.ensure_presence(&root)
}

#[cfg(test)]
#[path = "archive_instance_lock/tests.rs"]
mod tests;
