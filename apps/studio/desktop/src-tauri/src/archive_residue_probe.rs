//! M06 T1.3 — trusted READ-ONLY durable-temp residue probe.
//!
//! The renderer can enumerate `archive/packages` (that is where the generation
//! publisher's `.h2o-genstage-*` staging lives), but it holds no `read-dir`
//! grant under `archive/assets`, where the durable CAS writer creates its
//! `.h2o-durable-*.tmp` artifacts inside the shard directory. Widening the
//! renderer to reach them would hand it directory authority over the CAS, so
//! the trusted side answers the question instead.
//!
//! Scope: this module is PURPOSE-shaped, not path-shaped. It takes no caller
//! path, derives its own root from the Tauri app-local-data authority, walks
//! exactly `archive/assets/<aa>/`, and returns names plus archive-relative
//! paths. It has NO remove, rename, truncate, write, mkdir, quarantine or
//! purge authority, and it creates nothing — not even the archive directory,
//! which is why it uses `open_existing_nofollow` rather than `open_root`.

use std::path::Path;

use crate::archive_durable_write::{
    confined, ARCHIVE_ROOT, CAS_DIR, GENERATION_STAGING_PREFIX, TEMP_PREFIX, TEMP_SUFFIX,
};

/// The residue family this probe owns. The generation-staging family stays
/// with the JS inventory that can already see it.
pub const DURABLE_TEMP_KIND: &str = "durable-temp";

pub mod codes {
    /// The CAS root could not be opened, and it was not simply absent.
    pub const ASSETS_UNREADABLE: &str = "residue-probe-assets-unreadable";
    /// The CAS root listed, but one shard could not be walked.
    pub const SHARD_UNREADABLE: &str = "residue-probe-shard-unreadable";
    /// A shard-shaped name was not a real directory (symlink swap, or a file).
    pub const SHARD_NOT_A_DIRECTORY: &str = "residue-probe-shard-not-a-directory";
    /// A name could not be represented as text, so it cannot be reported.
    pub const NAME_UNREPRESENTABLE: &str = "residue-probe-name-unrepresentable";
    /// The app-local-data root is unavailable.
    pub const ROOT_UNAVAILABLE: &str = "residue-probe-root-unavailable";
    /// T3.3: the canonical packages directory could not be walked, and it was
    /// not simply absent. An incomplete walk, never an empty one.
    pub const PACKAGES_UNREADABLE: &str = "residue-probe-packages-unreadable";
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ResidueEntry {
    /// Archive-relative, e.g. `archive/assets/ab/.h2o-durable-1-0.tmp`.
    pub path: String,
    pub name: String,
    pub shard: String,
    pub kind: &'static str,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct DurableTempResidue {
    /// True ONLY when every shard that had to be walked was walked. A consumer
    /// must not read `count: 0` as "no residue" unless this is true.
    pub complete: bool,
    /// Archive-relative root this probe covers.
    pub root: String,
    pub kind: &'static str,
    /// Always equal to `entries.len()` — derived, never tracked separately.
    pub count: usize,
    pub entries: Vec<ResidueEntry>,
    pub blockers: Vec<String>,
}

impl DurableTempResidue {
    fn new() -> Self {
        DurableTempResidue {
            complete: true,
            root: format!("{ARCHIVE_ROOT}/{CAS_DIR}"),
            kind: DURABLE_TEMP_KIND,
            count: 0,
            entries: vec![],
            blockers: vec![],
        }
    }

    fn fail(&mut self, code: &str) {
        self.complete = false;
        let code = code.to_string();
        if !self.blockers.contains(&code) {
            self.blockers.push(code);
        }
    }

    /// Deterministic order and a derived count. Called on EVERY return path.
    fn seal(mut self) -> Self {
        self.entries.sort_by(|a, b| a.path.cmp(&b.path));
        self.count = self.entries.len();
        self
    }
}

/// A canonical CAS shard is exactly two lowercase hex digits. Anything else is
/// not a shard, so it cannot hold CAS residue and is not walked.
fn is_shard_name(name: &[u8]) -> bool {
    name.len() == 2
        && name
            .iter()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// The established durable-temp family: `.h2o-durable-<...>.tmp`. A CAS blob is
/// `sha256-<hex>` and cannot match, so ordinary content is never residue.
fn is_durable_temp(name: &[u8]) -> bool {
    name.starts_with(TEMP_PREFIX.as_bytes()) && name.ends_with(TEMP_SUFFIX.as_bytes())
}

/// Walks `<archive_root>/assets/<aa>/` read-only and reports durable-temp
/// residue. Separated from the command so it is directly testable against a
/// disposable root.
pub fn probe_durable_temp_within(archive_root: &Path) -> DurableTempResidue {
    let mut out = DurableTempResidue::new();

    let assets_path = archive_root.join(CAS_DIR);
    let assets = match confined::Dir::open_existing_nofollow(&assets_path) {
        Ok(dir) => dir,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // No CAS directory at all: an absence this probe genuinely proved,
            // so zero here IS authoritative.
            return out.seal();
        }
        Err(_) => {
            out.fail(codes::ASSETS_UNREADABLE);
            return out.seal();
        }
    };

    let shards = match assets.read_entry_names() {
        Ok(names) => names,
        Err(_) => {
            out.fail(codes::ASSETS_UNREADABLE);
            return out.seal();
        }
    };

    for shard in shards {
        // Not shard-shaped: cannot be a CAS shard, so it holds no CAS residue.
        // Classified as unrelated, NOT as garbage and NOT as an error.
        if !is_shard_name(&shard) {
            continue;
        }
        let Ok(shard_text) = std::str::from_utf8(&shard).map(str::to_string) else {
            out.fail(codes::NAME_UNREPRESENTABLE);
            continue;
        };

        let dir = match assets.open_child_nofollow(&shard) {
            Ok(dir) => dir,
            Err(err) => {
                // Raced away between listing and opening: nothing there to
                // report, and nothing was skipped. A symlink / reparse point or
                // non-directory standing where a shard should be was refused by
                // the no-follow open, so this probe did NOT look inside — that
                // is an incomplete walk, not a zero.
                if err.kind() == std::io::ErrorKind::NotFound {
                } else if crate::archive_durable_write::confined::is_redirect_refusal(&err) {
                    out.fail(codes::SHARD_NOT_A_DIRECTORY)
                } else {
                    out.fail(codes::SHARD_UNREADABLE)
                }
                continue;
            }
        };

        let names = match dir.read_entry_names() {
            Ok(names) => names,
            Err(_) => {
                out.fail(codes::SHARD_UNREADABLE);
                continue;
            }
        };
        for name in names {
            if !is_durable_temp(&name) {
                continue;
            }
            let Ok(name_text) = std::str::from_utf8(&name).map(str::to_string) else {
                out.fail(codes::NAME_UNREPRESENTABLE);
                continue;
            };
            out.entries.push(ResidueEntry {
                path: format!("{ARCHIVE_ROOT}/{CAS_DIR}/{shard_text}/{name_text}"),
                name: name_text,
                shard: shard_text.clone(),
                kind: DURABLE_TEMP_KIND,
            });
        }
    }

    out.seal()
}

/// Read-only diagnostics command. Takes NO caller-supplied path: the only
/// input is the app handle, so there is structurally no way to point it at an
/// arbitrary location. Registering it is safe before G02 because it is
/// non-destructive — it cannot remove, rename or write anything.
#[tauri::command]
pub async fn h2o_archive_durable_temp_residue(
    app: tauri::AppHandle,
) -> Result<DurableTempResidue, String> {
    let root = crate::archive_durable_write::archive_root(&app)
        .map_err(|_| codes::ROOT_UNAVAILABLE.to_string())?;
    Ok(probe_durable_temp_within(&root))
}

// ── M06 T3.3 — trusted two-family residue scan ──────────────────────────────
//
// Everything above answers a DIAGNOSTIC question and is registered as a
// command. What follows answers a DESTRUCTIVE one and is NOT registered: it is
// the trusted enumeration a reclamation run uses to decide what may be acted
// on, and it runs only while exclusive ownership is already held.
//
// It lives HERE rather than in a second module so the durable-temp naming
// grammar and the CAS walk stay single-authority: the durable-temp half CALLS
// `probe_durable_temp_within` and adds only the entry-type gate the destructive
// path additionally requires. Nothing above this line changes shape, behavior
// or output — the command, `DurableTempResidue`, `ResidueEntry` and
// `probe_durable_temp_within` are the same values they were in T1.3.
//
// The renderer's packages inventory is NOT an input here. It can see
// `.h2o-genstage-*`, but a renderer assertion must never be able to nominate
// something for deletion, so the generation-staging half is walked trusted-side
// too.

/// The generation-staging residue family: the publisher's abandoned `begin`
/// staging tree, directly under the canonical packages directory.
pub const GENERATION_STAGING_KIND: &str = "generation-staging";

/// The canonical packages component. Named locally rather than widening a
/// preserved module's private constant for one string; `archive_reclaim`
/// already names the same component the same way.
const PACKAGES_DIR: &str = "packages";

/// Upper bound on a residue basename this scan will classify as ACTIONABLE.
///
/// Both trusted generators mint bounded names — `.h2o-genstage-` plus 18 hex
/// digits, and `.h2o-durable-<pid>-<counter>.tmp` — so this refuses nothing a
/// trusted writer can produce. It exists so a quarantine identity derived from
/// a name can never approach a filesystem component limit mid-run.
const MAX_RESIDUE_NAME: usize = 120;

pub mod reasons {
    /// A `.h2o-genstage-*` name that is not a real directory.
    pub const NOT_A_DIRECTORY: &str = "residue-staging-not-a-directory";
    /// A `.h2o-durable-*.tmp` name that is not a real regular file.
    pub const NOT_A_REGULAR_FILE: &str = "residue-temp-not-a-regular-file";
    /// The entry itself is a symlink. Never followed, never promoted.
    pub const SYMLINK: &str = "residue-entry-is-a-symlink";
    /// The name is unbounded, empty, or not separator-free printable ASCII.
    pub const NAME_SHAPE: &str = "residue-name-shape-rejected";
    /// The entry could not be stat'ed, so its type is unknown.
    pub const UNREADABLE: &str = "residue-entry-unreadable";
}

/// Which trusted writer produced a residue item. Generation staging and durable
/// temp are different source classes with different safety arguments, so the
/// distinction is TYPED and survives into evidence — never a free-form string
/// that a later reader could mis-parse into the wrong safety case.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum ResidueFamily {
    GenerationStaging,
    DurableTemp,
}

impl ResidueFamily {
    pub fn kind(self) -> &'static str {
        match self {
            ResidueFamily::GenerationStaging => GENERATION_STAGING_KIND,
            ResidueFamily::DurableTemp => DURABLE_TEMP_KIND,
        }
    }

    /// The fixed-width, separator-free tag this family contributes to a
    /// quarantine identity. Fixed width is what makes the composed identity
    /// injective; see `archive_reclaim_execute::residue_target_component`.
    pub fn tag(self) -> &'static str {
        match self {
            ResidueFamily::GenerationStaging => "genstage",
            ResidueFamily::DurableTemp => "durtmp",
        }
    }
}

/// One residue item PROVEN to carry the exact trusted-writer shape: the right
/// name grammar in the right parent, of the right entry type, not a symlink.
///
/// Fields are private and there is no constructor outside this module, so a
/// caller cannot fabricate one — in particular it cannot name a canonical CAS
/// body, because nothing here will build an item whose name fails
/// `is_durable_temp` or the generation-staging prefix.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedResidueItem {
    family: ResidueFamily,
    /// The validated two-hex shard component. `Some` only for durable temp.
    shard: Option<String>,
    name: String,
    path: String,
}

impl TrustedResidueItem {
    pub fn family(&self) -> ResidueFamily {
        self.family
    }
    pub fn shard(&self) -> Option<&str> {
        self.shard.as_deref()
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    /// Archive-relative identity, for evidence and ordering. Never used to open
    /// anything: every syscall on this item is descriptor-relative.
    pub fn archive_relative_path(&self) -> &str {
        &self.path
    }
}

/// A name-matching entry that did NOT have the required trusted shape. It is
/// evidence, never a target.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct IndeterminateResidue {
    pub path: String,
    pub kind: &'static str,
    pub reason: &'static str,
}

/// The destructive-side residue authority for both established families.
pub struct TrustedResidueScan {
    /// True ONLY when every place that had to be walked was walked. A consumer
    /// MUST NOT read an empty `items` as "no residue" unless this is true.
    pub complete: bool,
    /// Deterministic: family rank, then archive-relative identity. Filesystem
    /// enumeration order is never action order.
    pub items: Vec<TrustedResidueItem>,
    pub indeterminate: Vec<IndeterminateResidue>,
    pub blockers: Vec<String>,
}

impl TrustedResidueScan {
    fn new() -> Self {
        TrustedResidueScan {
            complete: true,
            items: vec![],
            indeterminate: vec![],
            blockers: vec![],
        }
    }

    fn fail(&mut self, code: &str) {
        self.complete = false;
        let code = code.to_string();
        if !self.blockers.contains(&code) {
            self.blockers.push(code);
        }
    }

    fn indeterminate(&mut self, path: String, kind: &'static str, reason: &'static str) {
        self.indeterminate.push(IndeterminateResidue { path, kind, reason });
    }

    /// Deterministic ordering on EVERY return path.
    fn seal(mut self) -> Self {
        self.items
            .sort_by(|a, b| (a.family, &a.path).cmp(&(b.family, &b.path)));
        self.indeterminate.sort_by(|a, b| a.path.cmp(&b.path));
        self.blockers.sort();
        self.blockers.dedup();
        self
    }

    pub fn count_of(&self, family: ResidueFamily) -> usize {
        self.items.iter().filter(|i| i.family == family).count()
    }
}

/// A residue basename this scan is willing to turn into a quarantine identity.
///
/// Printable ASCII with no space and no separator, bounded in length. Every
/// trusted-generated name satisfies it; the point is that a FOREIGN name which
/// merely shares a reserved prefix cannot smuggle whitespace (which component
/// validation would trim, changing identity), a separator, or an unbounded
/// length into a destructive path.
fn residue_name_shape_ok(name: &[u8]) -> bool {
    !name.is_empty()
        && name.len() <= MAX_RESIDUE_NAME
        && name.iter().all(|b| b.is_ascii_graphic())
        && !name.iter().any(|b| *b == b'/' || *b == b'\\')
}

/// Walks `<archive_root>/packages/` for `.h2o-genstage-*`.
///
/// The publisher creates each staging entry with `mkdir_child_exclusive`, so a
/// genuine one is a DIRECTORY. A matching name that is a symlink, a regular
/// file or any other type was not produced by that path and is recorded as
/// indeterminate rather than silently treated as safe residue.
///
/// A non-matching name — a canonical generation, a legacy package, a corrupt
/// occupant, `.h2o-reclaim` — is skipped without inspection. It is not residue,
/// and this scan has no authority over it.
fn scan_generation_staging_within(archive_root: &Path, out: &mut TrustedResidueScan) {
    let packages_path = archive_root.join(PACKAGES_DIR);
    let dir = match confined::Dir::open_existing_nofollow(&packages_path) {
        Ok(dir) => dir,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // A proven absence: there is no packages directory, so there is no
            // generation-staging residue. Zero here IS authoritative.
            return;
        }
        Err(_) => {
            out.fail(codes::PACKAGES_UNREADABLE);
            return;
        }
    };
    let names = match dir.read_entry_names() {
        Ok(names) => names,
        Err(_) => {
            out.fail(codes::PACKAGES_UNREADABLE);
            return;
        }
    };
    for name in names {
        if !name.starts_with(GENERATION_STAGING_PREFIX.as_bytes()) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(&name).map(str::to_string) else {
            out.fail(codes::NAME_UNREPRESENTABLE);
            continue;
        };
        let path = format!("{ARCHIVE_ROOT}/{PACKAGES_DIR}/{text}");
        if !residue_name_shape_ok(&name) {
            out.indeterminate(path, GENERATION_STAGING_KIND, reasons::NAME_SHAPE);
            continue;
        }
        let st = match dir.stat_child_nofollow(&name) {
            Ok(Some(st)) => st,
            // Raced away between listing and stat: nothing to act on, and
            // nothing was skipped.
            Ok(None) => continue,
            Err(_) => {
                out.indeterminate(path, GENERATION_STAGING_KIND, reasons::UNREADABLE);
                continue;
            }
        };
        if confined::is_symlink(&st) {
            out.indeterminate(path, GENERATION_STAGING_KIND, reasons::SYMLINK);
            continue;
        }
        if !is_dir_stat(&st) {
            out.indeterminate(path, GENERATION_STAGING_KIND, reasons::NOT_A_DIRECTORY);
            continue;
        }
        out.items.push(TrustedResidueItem {
            family: ResidueFamily::GenerationStaging,
            shard: None,
            name: text,
            path,
        });
    }
}

/// Adds the entry-type gate on top of the EXISTING trusted durable-temp probe.
///
/// The probe above owns the shard shape, the name grammar and the walk, and is
/// called rather than re-implemented. Its completeness carries through
/// unchanged, so a shard standing behind a symlink — which `O_NOFOLLOW` refused
/// to traverse — still makes this scan incomplete, and the run then fails
/// closed instead of reading an unwalked shard as empty.
fn scan_durable_temp_within(archive_root: &Path, out: &mut TrustedResidueScan) {
    let probe = probe_durable_temp_within(archive_root);
    if !probe.complete {
        for blocker in &probe.blockers {
            out.fail(blocker);
        }
    }
    if probe.entries.is_empty() {
        return;
    }
    let assets = match confined::Dir::open_existing_nofollow(&archive_root.join(CAS_DIR)) {
        Ok(dir) => dir,
        Err(_) => {
            // The probe listed entries a moment ago, so failing to reopen the
            // CAS root now is an incomplete walk, never a zero.
            out.fail(codes::ASSETS_UNREADABLE);
            return;
        }
    };
    for entry in &probe.entries {
        if !residue_name_shape_ok(entry.name.as_bytes()) {
            out.indeterminate(entry.path.clone(), DURABLE_TEMP_KIND, reasons::NAME_SHAPE);
            continue;
        }
        let shard = match assets.open_child_nofollow(entry.shard.as_bytes()) {
            Ok(dir) => dir,
            Err(_) => {
                out.fail(codes::SHARD_UNREADABLE);
                continue;
            }
        };
        let st = match shard.stat_child_nofollow(entry.name.as_bytes()) {
            Ok(Some(st)) => st,
            Ok(None) => continue,
            Err(_) => {
                out.indeterminate(entry.path.clone(), DURABLE_TEMP_KIND, reasons::UNREADABLE);
                continue;
            }
        };
        if confined::is_symlink(&st) {
            out.indeterminate(entry.path.clone(), DURABLE_TEMP_KIND, reasons::SYMLINK);
            continue;
        }
        if !confined::is_regular(&st) {
            out.indeterminate(
                entry.path.clone(),
                DURABLE_TEMP_KIND,
                reasons::NOT_A_REGULAR_FILE,
            );
            continue;
        }
        out.items.push(TrustedResidueItem {
            family: ResidueFamily::DurableTemp,
            shard: Some(entry.shard.clone()),
            name: entry.name.clone(),
            path: entry.path.clone(),
        });
    }
}

/// Directory test on an ALREADY `O_NOFOLLOW`-stat'd entry. A mode check on a
/// stat the confined primitive already took — it opens nothing and resolves no
/// path, so it is not a second confinement implementation.
/// The only stat fields this probe ever consults are the TYPE bits: the
/// facade's `EntryStat::kind()` is derived from `st_mode & libc::S_IFMT` on
/// Unix (the file-attribute / reparse tag on Windows) and exposes no time,
/// owner or size authority to this module.
fn is_dir_stat(st: &crate::archive_durable_write::confined::EntryStat) -> bool {
    st.is_directory()
}

/// The complete trusted residue authority for BOTH established families.
///
/// Takes an archive root rather than a caller path: the destructive caller
/// derives that root from the canonical app authority under exclusive
/// ownership. Non-creating, descriptor-relative, `O_NOFOLLOW` throughout,
/// unbounded by any UI limit, and explicit about incompleteness — an unwalkable
/// location produces `complete: false`, never a smaller list.
pub fn scan_trusted_residue_within(archive_root: &Path) -> TrustedResidueScan {
    let mut out = TrustedResidueScan::new();
    scan_generation_staging_within(archive_root, &mut out);
    scan_durable_temp_within(archive_root, &mut out);
    out.seal()
}

#[cfg(test)]
mod tests;
