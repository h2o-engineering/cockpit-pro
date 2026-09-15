//! M06 T2.2 (Correction C) — trusted READ-ONLY canonical CAS inventory.
//!
//! Observes what CAS bodies actually exist so the retention engine can perform
//! read-only orphan ANALYSIS: observed objects minus trusted reference roots.
//!
//! Physical CAS reclamation is OUT of M06 (§H). This module therefore observes
//! and nothing else: it creates, renames, removes, truncates and writes
//! nothing, and it deliberately produces no notion of "collectible".
//!
//! Enumeration is descriptor-relative through the existing confined primitives,
//! non-creating, and refuses to follow symlinks. It reads no filesystem
//! timestamp. The canonical shape it recognises is exactly the one the durable
//! writer creates: `archive/assets/<aa>/sha256-<64 lowercase hex>`, with the
//! shard equal to the hash's first two hex digits.

use crate::archive_durable_write::{confined, ARCHIVE_ROOT, CAS_DIR};

pub mod codes {
    /// The CAS root existed but could not be enumerated.
    pub const ASSETS_UNREADABLE: &str = "cas-scan-assets-unreadable";
    /// A shard listed but could not be walked.
    pub const SHARD_UNREADABLE: &str = "cas-scan-shard-unreadable";
    /// A shard-shaped name was not a real directory (symlink or file).
    pub const SHARD_NOT_A_DIRECTORY: &str = "cas-scan-shard-not-a-directory";
    /// An entry could not be represented as text.
    pub const ENTRY_UNREPRESENTABLE: &str = "cas-scan-entry-unrepresentable";
}

/// An entry inside a canonical shard that is NOT a canonical CAS object.
///
/// Surfaced honestly rather than dropped: something unexplained in the CAS is
/// evidence, and it must never be silently treated as a collectible object.
#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct ForeignCasEntry {
    pub path: String,
    pub reason: &'static str,
}

#[derive(serde::Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct CasInventory {
    /// True only when every shard that had to be walked was walked.
    pub complete: bool,
    /// Bare lowercase hex of every canonical object observed, sorted and
    /// deduplicated.
    pub observed: Vec<String>,
    /// Entries inside shards that are not canonical CAS objects.
    pub foreign: Vec<ForeignCasEntry>,
    pub blockers: Vec<String>,
}

impl CasInventory {
    fn fail(&mut self, code: &str) {
        self.complete = false;
        let code = code.to_string();
        if !self.blockers.contains(&code) {
            self.blockers.push(code);
        }
    }

    fn seal(mut self) -> Self {
        self.observed.sort();
        self.observed.dedup();
        self.foreign.sort();
        self.foreign.dedup();
        self.blockers.sort();
        self.blockers.dedup();
        self
    }
}

/// A canonical shard is exactly two lowercase hex digits.
fn is_shard_name(name: &[u8]) -> bool {
    name.len() == 2
        && name
            .iter()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Enumerates canonical CAS bodies beneath `archive_root`. Read-only.
pub fn scan_cas_within(archive_root: &std::path::Path) -> CasInventory {
    let mut out = CasInventory {
        complete: true,
        ..CasInventory::default()
    };

    let assets_path = archive_root.join(CAS_DIR);
    let assets = match confined::Dir::open_existing_nofollow(&assets_path) {
        Ok(dir) => dir,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // No CAS at all: a proven absence, and nothing was created.
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
        let shard_text = match std::str::from_utf8(&shard) {
            Ok(text) => text.to_string(),
            Err(_) => {
                out.fail(codes::ENTRY_UNREPRESENTABLE);
                continue;
            }
        };
        if !is_shard_name(&shard) {
            // Not a canonical shard, so it holds no canonical objects. Recorded
            // as evidence; it is not an object and never becomes one.
            out.foreign.push(ForeignCasEntry {
                path: format!("{ARCHIVE_ROOT}/{CAS_DIR}/{shard_text}"),
                reason: "not-a-canonical-shard",
            });
            continue;
        }

        let dir = match assets.open_child_nofollow(&shard) {
            Ok(dir) => dir,
            Err(err) => {
                // A symlink / reparse point or non-directory standing where a
                // shard should be: never followed, and the walk is no longer
                // complete. A raced-away shard reports nothing.
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
        for raw in names {
            let name = match std::str::from_utf8(&raw) {
                Ok(text) => text.to_string(),
                Err(_) => {
                    out.fail(codes::ENTRY_UNREPRESENTABLE);
                    continue;
                }
            };
            let path = format!("{ARCHIVE_ROOT}/{CAS_DIR}/{shard_text}/{name}");

            // Identity shape comes from the existing canonical helper; this
            // module adds no second sha implementation.
            let Some(hex) = crate::archive_durable_write::normalize_expected_sha(&name) else {
                out.foreign.push(ForeignCasEntry {
                    path,
                    reason: "not-a-canonical-object-name",
                });
                continue;
            };
            // The writer derives the shard FROM the hash, so a body filed under
            // the wrong shard is not canonically addressable.
            if hex[0..2] != shard_text {
                out.foreign.push(ForeignCasEntry {
                    path,
                    reason: "shard-does-not-match-hash",
                });
                continue;
            }
            // A symlink is not a canonical object body and is never followed.
            match dir.stat_child_nofollow(raw.as_slice()) {
                Ok(Some(st)) if confined::is_regular(&st) => out.observed.push(hex),
                Ok(Some(_)) => out.foreign.push(ForeignCasEntry {
                    path,
                    reason: "not-a-regular-file",
                }),
                Ok(None) => {}
                Err(_) => out.fail(codes::SHARD_UNREADABLE),
            }
        }
    }

    out.seal()
}

/// Scans the application's canonical CAS. Internal trusted Rust: this module
/// registers no command.
pub fn scan_cas(app: &tauri::AppHandle) -> Result<CasInventory, String> {
    let root = crate::archive_durable_write::archive_root(app)?;
    Ok(scan_cas_within(&root))
}

#[cfg(test)]
mod tests;
