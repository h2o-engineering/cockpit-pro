use super::*;
use std::fs;

fn temp_root(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "h2o-m06-t13-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&dir).expect("temp root");
    dir
}

fn shard(root: &std::path::Path, name: &str) -> std::path::PathBuf {
    let dir = root.join(CAS_DIR).join(name);
    fs::create_dir_all(&dir).expect("shard");
    dir
}

/// (A)(B)(C)(D)(G)(H) residue across several shards, with unrelated content.
#[test]
fn durable_temp_residue_is_found_across_shards_with_exact_paths() {
    let root = temp_root("found");
    let ab = shard(&root, "ab");
    let cd = shard(&root, "cd");
    let ef = shard(&root, "ef");

    fs::write(ab.join(".h2o-durable-9-1.tmp"), b"x").unwrap();
    fs::write(ab.join(".h2o-durable-9-0.tmp"), b"x").unwrap();
    fs::write(cd.join(".h2o-durable-7-0.tmp"), b"x").unwrap();

    // (G) ordinary CAS blobs are not residue.
    fs::write(ab.join(format!("sha256-{}", "ab".repeat(32))), b"blob").unwrap();
    fs::write(cd.join(format!("sha256-{}", "cd".repeat(32))), b"blob").unwrap();
    // (H)(I)(J) unrelated dotfiles and the reserved identities are not residue.
    fs::write(ef.join(".DS_Store"), b"x").unwrap();
    fs::write(ef.join(".h2o-archive.lock"), b"x").unwrap();
    fs::create_dir_all(ef.join(".h2o-reclaim")).unwrap();
    // Near-miss names that must NOT match the family.
    fs::write(ef.join(".h2o-durable-9-2"), b"x").unwrap();
    fs::write(ef.join("h2o-durable-9-3.tmp"), b"x").unwrap();

    let result = probe_durable_temp_within(&root);

    assert!(result.complete, "a clean walk is complete: {:?}", result.blockers);
    assert_eq!(result.count, 3);
    assert_eq!(result.count, result.entries.len(), "count is derived from the list");
    let paths: Vec<&str> = result.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "archive/assets/ab/.h2o-durable-9-0.tmp",
            "archive/assets/ab/.h2o-durable-9-1.tmp",
            "archive/assets/cd/.h2o-durable-7-0.tmp",
        ],
        "exact archive-relative paths, deterministically ordered"
    );
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted, "ordering must not depend on readdir order");
    assert!(result.entries.iter().all(|e| e.kind == DURABLE_TEMP_KIND));
    assert_eq!(result.root, "archive/assets");

    let _ = fs::remove_dir_all(&root);
}

/// (E) a complete walk that finds nothing reports an AUTHORITATIVE zero.
#[test]
fn a_complete_walk_with_no_residue_is_an_authoritative_zero() {
    let root = temp_root("zero");
    let ab = shard(&root, "ab");
    fs::write(ab.join(format!("sha256-{}", "ab".repeat(32))), b"blob").unwrap();

    let result = probe_durable_temp_within(&root);
    assert!(result.complete);
    assert_eq!(result.count, 0);
    assert!(result.entries.is_empty());
    assert!(result.blockers.is_empty());

    // An absent CAS root is also a proven absence, not a failure.
    let empty = temp_root("empty");
    let missing = probe_durable_temp_within(&empty);
    assert!(missing.complete, "a missing assets dir is proven absence");
    assert_eq!(missing.count, 0);

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&empty);
}

/// (F) an unwalkable shard can never yield an authoritative zero.
#[test]
fn an_unreadable_shard_cannot_produce_an_authoritative_zero() {
    let root = temp_root("blocked");
    let ab = shard(&root, "ab");
    fs::write(ab.join(".h2o-durable-1-0.tmp"), b"x").unwrap();

    // A symlink standing where a shard directory should be. O_NOFOLLOW must
    // refuse to traverse it, and the walk must then declare itself incomplete
    // rather than reporting only what it happened to see.
    let target = temp_root("elsewhere");
    std::os::unix::fs::symlink(&target, root.join(CAS_DIR).join("cd")).unwrap();

    let result = probe_durable_temp_within(&root);
    assert!(!result.complete, "a shard that was not traversed breaks completeness");
    assert!(result.blockers.contains(&codes::SHARD_NOT_A_DIRECTORY.to_string()));
    // Observed items are still reported.
    assert_eq!(result.count, 1);

    // And with NO observable residue the result is still not an authoritative zero.
    let root2 = temp_root("blocked-empty");
    fs::create_dir_all(root2.join(CAS_DIR)).unwrap();
    std::os::unix::fs::symlink(&target, root2.join(CAS_DIR).join("ab")).unwrap();
    let empty = probe_durable_temp_within(&root2);
    assert_eq!(empty.count, 0);
    assert!(!empty.complete, "count 0 from an incomplete walk is not authority");

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&root2);
    let _ = fs::remove_dir_all(&target);
}

/// Non-shard names are unrelated content, not garbage and not an error.
#[test]
fn non_shard_names_are_unrelated_not_residue_and_not_a_failure() {
    let root = temp_root("nonshard");
    let assets = root.join(CAS_DIR);
    fs::create_dir_all(&assets).unwrap();
    fs::create_dir_all(assets.join("AB")).unwrap(); // uppercase: not canonical
    fs::create_dir_all(assets.join("abc")).unwrap(); // wrong length
    fs::create_dir_all(assets.join("zz")).unwrap(); // not hex
    fs::write(assets.join("notes.txt"), b"x").unwrap();
    // A durable-temp inside a NON-shard directory is out of the canonical
    // layout, so it is not claimed by this probe.
    fs::write(assets.join("abc").join(".h2o-durable-1-0.tmp"), b"x").unwrap();

    let result = probe_durable_temp_within(&root);
    assert!(result.complete, "unrelated names do not break the walk");
    assert_eq!(result.count, 0);
    assert!(result.blockers.is_empty());

    let _ = fs::remove_dir_all(&root);
}

/// (D) Ordering and count are established by `seal`, not by luck: readdir may
/// happen to return names already sorted, which would let an unsorted
/// implementation pass a filesystem-driven test. This drives `seal` directly
/// with deliberately out-of-order entries so the guarantee is proven.
#[test]
fn seal_sorts_deterministically_and_derives_the_count() {
    let entry = |shard: &str, name: &str| ResidueEntry {
        path: format!("archive/assets/{shard}/{name}"),
        name: name.to_string(),
        shard: shard.to_string(),
        kind: DURABLE_TEMP_KIND,
    };
    let mut residue = DurableTempResidue::new();
    residue.entries = vec![
        entry("cd", ".h2o-durable-7-0.tmp"),
        entry("ab", ".h2o-durable-9-1.tmp"),
        entry("ab", ".h2o-durable-9-0.tmp"),
    ];
    residue.count = 999; // whatever was there before must not survive
    let sealed = residue.seal();

    assert_eq!(
        sealed.entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
        vec![
            "archive/assets/ab/.h2o-durable-9-0.tmp",
            "archive/assets/ab/.h2o-durable-9-1.tmp",
            "archive/assets/cd/.h2o-durable-7-0.tmp",
        ],
        "seal must impose a total order regardless of input order"
    );
    assert_eq!(sealed.count, 3, "count is derived from the list, not carried");
}

/// (P) the probe module exposes no destructive vocabulary at all.
#[test]
fn the_probe_carries_no_destructive_capability() {
    /* Scanned in CODE. T3.3's scan documents WHY a genuine staging entry is a
       directory — the publisher creates it with `mkdir_child_exclusive` — and
       banning that sentence would ban an accurate explanation rather than a
       capability. The ban on the call itself is unchanged, and the positive
       allowlist below is strictly stronger than the token ban was. */
    let source: String = include_str!("../archive_residue_probe.rs")
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let source = source.as_str();

    /* Every confined primitive this module invokes, in code. The set is
       READ-ONLY: open, list, stat. Anything that creates, writes, renames or
       removes is absent — and a new one appearing here fails the assertion
       rather than slipping past a token blacklist. */
    let mut used: Vec<&str> = [
        "open_root(", "open_existing_nofollow(", "open_child_nofollow(",
        "open_child_read_nofollow(", "read_entry_names(", "stat_child_nofollow(",
        "mkdir_child(", "mkdir_child_exclusive(", "create_new_child(",
        "unlink_child(", "unlink_child_dir(", "rename_within(",
        "promote_exclusive(", "promote_dir_exclusive(", "sync(",
    ]
    .into_iter()
    .filter(|call| source.contains(call))
    .collect();
    used.sort();
    assert_eq!(
        used,
        vec![
            "open_child_nofollow(",
            "open_existing_nofollow(",
            "read_entry_names(",
            "stat_child_nofollow(",
        ],
        "the residue module may only OPEN, LIST and STAT"
    );

    for forbidden in [
        "unlinkat",
        "remove_file",
        "remove_dir",
        "renameat",
        "std::fs::rename",
        "O_CREAT",
        "O_TRUNC",
        "O_WRONLY",
        "O_RDWR",
        "mkdirat",
        "mkdir_child",
        "open_root(",
    ] {
        assert!(
            !source.contains(forbidden),
            "read-only probe must not reference {forbidden}"
        );
    }
}

/// (O) the command takes no caller-supplied path — structurally, not by check.
#[test]
fn the_command_accepts_no_caller_supplied_path() {
    let source = include_str!("../archive_residue_probe.rs");
    let start = source
        .find("pub async fn h2o_archive_durable_temp_residue")
        .expect("command present");
    let signature = &source[start..start + 160];
    assert!(
        signature.contains("app: tauri::AppHandle"),
        "the app handle is the only input"
    );
    for path_shaped in ["path:", "relative:", "root:", "options:", "request:"] {
        assert!(
            !signature.contains(path_shaped),
            "command must not accept {path_shaped} — it derives its own root"
        );
    }
}

// ── M06 T3.3 — the trusted two-family destructive-side scan ────────────────

fn packages(root: &std::path::Path) -> std::path::PathBuf {
    let dir = root.join("packages");
    fs::create_dir_all(&dir).expect("packages");
    dir
}

fn ids(scan: &TrustedResidueScan) -> Vec<String> {
    scan.items
        .iter()
        .map(|i| format!("{}|{}", i.family().kind(), i.archive_relative_path()))
        .collect()
}

/// (A)(AE) both families are enumerated completely and trusted-side, and a
/// canonical CAS body sharing the shard is never one of them.
#[test]
fn the_trusted_scan_enumerates_both_established_families() {
    let root = temp_root("t33-both");
    let pkgs = packages(&root);
    fs::create_dir_all(pkgs.join(".h2o-genstage-00ff01")).unwrap();
    fs::write(pkgs.join(".h2o-genstage-00ff01").join("snapshot.json"), b"{}").unwrap();
    fs::create_dir_all(pkgs.join(".h2o-genstage-00ff02")).unwrap();
    // A canonical generation, a legacy package and an occupant: not residue.
    fs::create_dir_all(pkgs.join(format!("chat_a.g{}.h2ochat", "ab".repeat(32)))).unwrap();
    fs::create_dir_all(pkgs.join("chat_a.h2ochat")).unwrap();
    fs::write(pkgs.join("corrupt.h2ochat"), b"junk").unwrap();

    let ab = shard(&root, "ab");
    fs::write(ab.join(".h2o-durable-9-0.tmp"), b"t").unwrap();
    fs::write(ab.join(format!("sha256-{}", "ab".repeat(32))), b"body").unwrap();
    let cd = shard(&root, "cd");
    fs::write(cd.join(".h2o-durable-9-0.tmp"), b"t").unwrap();

    let scan = scan_trusted_residue_within(&root);
    assert!(scan.complete, "{:?}", scan.blockers);
    assert!(scan.indeterminate.is_empty(), "{:?}", scan.indeterminate);
    assert_eq!(
        ids(&scan),
        vec![
            "generation-staging|archive/packages/.h2o-genstage-00ff01",
            "generation-staging|archive/packages/.h2o-genstage-00ff02",
            "durable-temp|archive/assets/ab/.h2o-durable-9-0.tmp",
            "durable-temp|archive/assets/cd/.h2o-durable-9-0.tmp",
        ]
    );
    assert_eq!(scan.count_of(ResidueFamily::GenerationStaging), 2);
    assert_eq!(scan.count_of(ResidueFamily::DurableTemp), 2);
    /* The same basename under two shards is TWO distinct items: this is the
       collision the quarantine identity has to survive. */
    assert_eq!(
        scan.items[2].name(),
        scan.items[3].name(),
        "the durable writer really can mint one basename per shard"
    );
    assert_ne!(scan.items[2].shard(), scan.items[3].shard());

    let _ = fs::remove_dir_all(&root);
}

/// (B) the durable-temp half CALLS the existing trusted probe rather than
/// re-implementing its grammar, and that probe's external contract is unchanged.
#[test]
fn the_durable_temp_half_reuses_the_existing_probe() {
    let source = include_str!("../archive_residue_probe.rs");
    let at = source.find("fn scan_durable_temp_within").expect("present");
    let body = &source[at..at + source[at..].find("\n}").unwrap()];
    assert!(
        body.contains("probe_durable_temp_within(archive_root)"),
        "the destructive side must consume the existing probe"
    );
    /* Exactly ONE grammar authority for each family name, in code, past the
       import that names them. Every constant comes from T1.2's shared list. */
    let code: String = source
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let body = &code[code.find("pub const DURABLE_TEMP_KIND").expect("past the imports")..];
    for grammar in ["TEMP_PREFIX", "TEMP_SUFFIX", "GENERATION_STAGING_PREFIX"] {
        assert_eq!(
            body.matches(grammar).count(),
            1,
            "exactly one authority decides the {grammar} family"
        );
    }

    // The T1.3 external contract is preserved, value for value.
    let root = temp_root("t33-contract");
    let ab = shard(&root, "ab");
    fs::write(ab.join(".h2o-durable-3-0.tmp"), b"t").unwrap();
    let probe = probe_durable_temp_within(&root);
    assert!(probe.complete);
    assert_eq!(probe.count, 1);
    assert_eq!(probe.kind, DURABLE_TEMP_KIND);
    assert_eq!(probe.root, "archive/assets");
    assert_eq!(probe.entries[0].path, "archive/assets/ab/.h2o-durable-3-0.tmp");
    assert_eq!(probe.entries[0].shard, "ab");
    let _ = fs::remove_dir_all(&root);
}

/// (D) an unwalkable location is INCOMPLETE, never an empty result. Both roots.
#[test]
fn an_incomplete_walk_can_never_present_as_zero_residue() {
    // A shard standing behind a symlink: O_NOFOLLOW refused to look inside.
    let root = temp_root("t33-blindshard");
    let real = root.join("elsewhere");
    fs::create_dir_all(&real).unwrap();
    fs::write(real.join(".h2o-durable-1-0.tmp"), b"hidden").unwrap();
    fs::create_dir_all(root.join(CAS_DIR)).unwrap();
    std::os::unix::fs::symlink(&real, root.join(CAS_DIR).join("ab")).unwrap();
    let scan = scan_trusted_residue_within(&root);
    assert!(!scan.complete, "an unwalked shard is not an empty shard");
    assert!(scan.items.is_empty(), "and nothing hidden behind it is a target");
    assert!(scan.blockers.contains(&codes::SHARD_NOT_A_DIRECTORY.to_string()));
    let _ = fs::remove_dir_all(&root);

    // The packages directory itself replaced by a file.
    let root = temp_root("t33-blindpkgs");
    fs::write(root.join("packages"), b"not a directory").unwrap();
    let scan = scan_trusted_residue_within(&root);
    assert!(!scan.complete);
    assert!(scan.items.is_empty());
    assert!(scan.blockers.contains(&codes::PACKAGES_UNREADABLE.to_string()));
    let _ = fs::remove_dir_all(&root);

    // A genuinely absent packages directory IS a proven zero.
    let root = temp_root("t33-nopkgs");
    let scan = scan_trusted_residue_within(&root);
    assert!(scan.complete, "proven absence is authoritative");
    assert!(scan.items.is_empty());
    let _ = fs::remove_dir_all(&root);
}

/// (E)(H) a `.h2o-genstage-*` NAME is not enough: the entry must be a real,
/// non-symlink directory, and a symlink is never followed or promoted.
#[test]
fn generation_staging_requires_the_exact_publisher_entry_type() {
    let root = temp_root("t33-stagetype");
    let pkgs = packages(&root);
    let decoy = root.join("decoy");
    fs::create_dir_all(&decoy).unwrap();
    fs::write(decoy.join("secret"), b"must survive").unwrap();

    fs::create_dir_all(pkgs.join(".h2o-genstage-real00")).unwrap();
    std::os::unix::fs::symlink(&decoy, pkgs.join(".h2o-genstage-link00")).unwrap();
    fs::write(pkgs.join(".h2o-genstage-file00"), b"not a directory").unwrap();
    // A name that shares the prefix but is unbounded.
    fs::create_dir_all(pkgs.join(format!(".h2o-genstage-{}", "z".repeat(200)))).unwrap();

    let scan = scan_trusted_residue_within(&root);
    assert!(scan.complete, "each entry's type was determined, so the walk is complete");
    assert_eq!(
        ids(&scan),
        vec!["generation-staging|archive/packages/.h2o-genstage-real00"],
        "only the real directory is actionable"
    );
    let reasons: Vec<&str> = scan.indeterminate.iter().map(|i| i.reason).collect();
    assert!(reasons.contains(&reasons::SYMLINK));
    assert!(reasons.contains(&reasons::NOT_A_DIRECTORY));
    assert!(reasons.contains(&reasons::NAME_SHAPE));
    assert_eq!(scan.indeterminate.len(), 3);
    assert!(decoy.join("secret").exists(), "the symlink target was never traversed");
    let _ = fs::remove_dir_all(&root);
}

/// (F)(H) a `.h2o-durable-*.tmp` NAME is not enough either: it must be a real,
/// non-symlink regular file inside a real shard.
#[test]
fn durable_temp_requires_the_exact_writer_entry_type() {
    let root = temp_root("t33-temptype");
    let ab = shard(&root, "ab");
    let decoy = root.join("decoy");
    fs::create_dir_all(&decoy).unwrap();
    fs::write(decoy.join("secret"), b"must survive").unwrap();

    fs::write(ab.join(".h2o-durable-1-0.tmp"), b"real").unwrap();
    std::os::unix::fs::symlink(&decoy, ab.join(".h2o-durable-2-0.tmp")).unwrap();
    fs::create_dir_all(ab.join(".h2o-durable-3-0.tmp")).unwrap();

    let scan = scan_trusted_residue_within(&root);
    assert!(scan.complete);
    assert_eq!(
        ids(&scan),
        vec!["durable-temp|archive/assets/ab/.h2o-durable-1-0.tmp"],
        "only the real regular file is actionable"
    );
    let reasons: Vec<&str> = scan.indeterminate.iter().map(|i| i.reason).collect();
    assert!(reasons.contains(&reasons::SYMLINK));
    assert!(reasons.contains(&reasons::NOT_A_REGULAR_FILE));
    assert!(decoy.join("secret").exists(), "the symlink target was never traversed");
    let _ = fs::remove_dir_all(&root);
}

/// (G) foreign entries that merely resemble a residue name are not residue.
#[test]
fn foreign_lookalikes_are_never_classified_as_residue() {
    let root = temp_root("t33-foreign");
    let pkgs = packages(&root);
    for name in [
        ".h2o-genstag-00ff01",
        "h2o-genstage-00ff01",
        ".h2o-genstage",
        ".h2o-durable-1-0.tmp",
        ".DS_Store",
    ] {
        fs::create_dir_all(pkgs.join(name)).unwrap();
    }
    let ab = shard(&root, "ab");
    for name in [
        ".h2o-durabl-1-0.tmp",
        "h2o-durable-1-0.tmp",
        ".h2o-durable-1-0.tmp.bak",
        ".h2o-genstage-00ff01",
        format!("sha256-{}", "ab".repeat(32)).as_str(),
    ] {
        fs::write(ab.join(name), b"x").unwrap();
    }
    // Not a shard at all: never walked, never residue.
    let deep = root.join(CAS_DIR).join("zzz");
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join(".h2o-durable-1-0.tmp"), b"x").unwrap();

    let scan = scan_trusted_residue_within(&root);
    assert!(scan.complete);
    /* Not one of these is residue. The reserved prefix carries its trailing
       separator — `.h2o-genstage-` — so even `.h2o-genstage` misses it; a
       durable-temp name is only residue inside a CAS shard and a staging name
       only inside packages; a suffixed `.bak` fails the exact `.tmp` ending;
       and `zzz` is not a shard, so it is never walked. */
    assert!(ids(&scan).is_empty(), "{:?}", ids(&scan));
    assert!(scan.indeterminate.is_empty(), "{:?}", scan.indeterminate);
    assert!(deep.join(".h2o-durable-1-0.tmp").exists(), "a non-shard is never walked");
    let _ = fs::remove_dir_all(&root);
}

/// (AA) enumeration order is a stable trusted identity sort, never filesystem
/// order: the same set built in the opposite order plans identically.
#[test]
fn the_trusted_scan_order_is_deterministic_not_filesystem_order() {
    let names = ["00ff01", "00ff02", "00ff03", "00ff04", "00ff05"];
    let shards = ["ab", "cd", "ef", "01", "fe"];

    let forward = temp_root("t33-order-f");
    let fp = packages(&forward);
    for n in names {
        fs::create_dir_all(fp.join(format!(".h2o-genstage-{n}"))).unwrap();
    }
    for sh in shards {
        fs::write(shard(&forward, sh).join(".h2o-durable-5-0.tmp"), b"t").unwrap();
    }

    let reverse = temp_root("t33-order-r");
    let rp = packages(&reverse);
    for n in names.iter().rev() {
        fs::create_dir_all(rp.join(format!(".h2o-genstage-{n}"))).unwrap();
    }
    for sh in shards.iter().rev() {
        fs::write(shard(&reverse, sh).join(".h2o-durable-5-0.tmp"), b"t").unwrap();
    }

    let a = scan_trusted_residue_within(&forward);
    let b = scan_trusted_residue_within(&reverse);
    assert_eq!(ids(&a), ids(&b), "insertion order must not reach action order");
    assert_eq!(
        ids(&a),
        vec![
            "generation-staging|archive/packages/.h2o-genstage-00ff01",
            "generation-staging|archive/packages/.h2o-genstage-00ff02",
            "generation-staging|archive/packages/.h2o-genstage-00ff03",
            "generation-staging|archive/packages/.h2o-genstage-00ff04",
            "generation-staging|archive/packages/.h2o-genstage-00ff05",
            "durable-temp|archive/assets/01/.h2o-durable-5-0.tmp",
            "durable-temp|archive/assets/ab/.h2o-durable-5-0.tmp",
            "durable-temp|archive/assets/cd/.h2o-durable-5-0.tmp",
            "durable-temp|archive/assets/ef/.h2o-durable-5-0.tmp",
            "durable-temp|archive/assets/fe/.h2o-durable-5-0.tmp",
        ],
        "family rank, then trusted archive identity"
    );
    // And re-running against one root is stable.
    assert_eq!(ids(&scan_trusted_residue_within(&forward)), ids(&a));

    let _ = fs::remove_dir_all(&forward);
    let _ = fs::remove_dir_all(&reverse);
}

/// (AL) the residue authority contains no timestamp, age or wall-clock notion.
#[test]
fn residue_identity_uses_no_time_authority() {
    let code: String = include_str!("../archive_residue_probe.rs")
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    /* Exact identifier tokens, not substrings: `age` lives inside `package`
       and `age_` inside `package_scan`, both of which this module says
       legitimately. A substring ban would pressure someone into renaming
       accurate code rather than removing a real capability. */
    let tokens: std::collections::BTreeSet<&str> = code
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|t| !t.is_empty())
        .collect();
    for forbidden in [
        "st_mtime", "st_ctime", "st_birthtime", "st_atime", "SystemTime",
        "Instant", "UNIX_EPOCH", "elapsed", "modified", "created", "age",
        "max_age", "older_than", "stale_after", "now", "timestamp",
    ] {
        assert!(!tokens.contains(forbidden), "no time authority: {forbidden}");
    }
    /* RC-T02-01 (HDA-authorized assertion amendment, 2026-09-15): entry-type
       classification lives behind the confined `EntryStat` facade, so the
       former literal pin on `st_mode & libc::S_IFMT` no longer describes this
       module. The accepted invariant is preserved and asserted directly: the
       ONLY thing this module consumes from a no-follow inspection is the
       entry's TYPE — no raw stat metadata, no object identity, no size and no
       libc authority. `kind` stays allowed because `std::io::Error::kind` is
       error classification, not metadata authority. */
    assert!(code.contains("stat_child_nofollow"), "type comes from the no-follow inspection");
    assert!(code.contains("is_directory()"), "type is read through the facade");
    for forbidden in [
        "libc", "stat", "fstat", "statfs", "metadata", "st_mode", "st_size", "st_dev",
        "st_ino", "st_nlink", "st_uid", "st_gid", "st_blocks", "identity", "size",
        "ObjectIdentity", "file_identity", "available_bytes", "name_max",
    ] {
        assert!(!tokens.contains(forbidden), "no metadata authority: {forbidden}");
    }
}

/// (C) the destructive scan is not a command and takes no renderer input.
#[test]
fn the_trusted_scan_is_not_a_registered_command() {
    let source = include_str!("../archive_residue_probe.rs");
    let at = source.find("pub fn scan_trusted_residue_within").expect("present");
    let before = &source[..at];
    assert!(
        !before.trim_end().ends_with("#[tauri::command]"),
        "the destructive-side scan must not be a command"
    );
    let code: String = source
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        code.matches("#[tauri::command]").count(),
        1,
        "only the T1.3 read-only diagnostics command exists here"
    );
    let sig = &source[at..at + 120];
    for forbidden in ["request", "options", "ProjectionInput", "String", "Vec<"] {
        assert!(!sig.contains(forbidden), "scan must not accept {forbidden}");
    }
    let lib = include_str!("../lib.rs");
    assert!(!lib.contains("scan_trusted_residue_within"), "not registered");
}

// ── T02 RC-T02-02 — capability-probe residue (contract §10 rule 1, C24) ─────

/// (RC-02 I.1)(I.2)(I.6)(H) valid probe residue in BOTH archive-owned probe
/// locations — directly under the admitted root and under `packages`, the two
/// places the capability layer actually writes — is discovered as the typed
/// third family, with both entry types a probe can leave; canonical content,
/// reserved infrastructure and the two established families are untouched.
#[test]
fn capability_probe_residue_is_found_in_both_archive_owned_probe_locations() {
    let root = temp_root("rc02-found");
    let pkgs = packages(&root);
    // A crashed exclusive-create / link / clone probe leaves a regular file; a
    // crashed no-replace-rename probe leaves a directory.
    fs::write(root.join(".h2o-probe-4242-1"), b"probe").unwrap();
    fs::create_dir_all(root.join(".h2o-probe-4242-0")).unwrap();
    fs::create_dir_all(pkgs.join(".h2o-probe-4242-2")).unwrap();
    fs::write(pkgs.join(".h2o-probe-77-0"), b"probe").unwrap();
    // The established families still report exactly as before.
    fs::create_dir_all(pkgs.join(".h2o-genstage-00ff01")).unwrap();
    let ab = shard(&root, "ab");
    fs::write(ab.join(".h2o-durable-9-0.tmp"), b"t").unwrap();
    // (I.6) canonical Saved-Chat content and reserved infrastructure are never
    // probe residue: a generation, a legacy package, an occupant, a CAS body,
    // the presence lock, the quarantine namespace, an unrelated dotfile.
    fs::create_dir_all(pkgs.join(format!("chat_a.g{}.h2ochat", "ab".repeat(32)))).unwrap();
    fs::create_dir_all(pkgs.join("chat_a.h2ochat")).unwrap();
    fs::write(pkgs.join("corrupt.h2ochat"), b"junk").unwrap();
    fs::write(ab.join(format!("sha256-{}", "ab".repeat(32))), b"body").unwrap();
    fs::write(root.join(".h2o-archive.lock"), b"").unwrap();
    fs::create_dir_all(root.join(".h2o-reclaim").join("run-1")).unwrap();
    fs::write(root.join(".DS_Store"), b"x").unwrap();
    // No probe ever runs inside a CAS shard or inside the quarantine
    // namespace, so a probe-shaped name there is not this family's residue.
    fs::write(ab.join(".h2o-probe-4242-3"), b"x").unwrap();
    fs::write(root.join(".h2o-reclaim").join("run-1").join(".h2o-probe-4242-4"), b"x").unwrap();

    let scan = scan_trusted_residue_within(&root);
    assert!(scan.complete, "{:?}", scan.blockers);
    assert!(scan.indeterminate.is_empty(), "{:?}", scan.indeterminate);
    assert_eq!(
        ids(&scan),
        vec![
            "generation-staging|archive/packages/.h2o-genstage-00ff01",
            "durable-temp|archive/assets/ab/.h2o-durable-9-0.tmp",
            "capability-probe|archive/.h2o-probe-4242-0",
            "capability-probe|archive/.h2o-probe-4242-1",
            "capability-probe|archive/packages/.h2o-probe-4242-2",
            "capability-probe|archive/packages/.h2o-probe-77-0",
        ]
    );
    assert_eq!(scan.count_of(ResidueFamily::CapabilityProbe), 4);
    assert_eq!(scan.count_of(ResidueFamily::GenerationStaging), 1);
    assert_eq!(scan.count_of(ResidueFamily::DurableTemp), 1);
    /* (I.2) the typed set: family, kind, tag and a TYPED location, no shard. */
    let probes: Vec<&TrustedResidueItem> = scan
        .items
        .iter()
        .filter(|i| i.family() == ResidueFamily::CapabilityProbe)
        .collect();
    assert_eq!(probes.len(), 4);
    assert!(probes.iter().all(|i| i.family().kind() == CAPABILITY_PROBE_KIND));
    assert!(probes.iter().all(|i| i.family().tag() == "probe"));
    assert!(probes.iter().all(|i| i.shard().is_none()));
    assert_eq!(
        probes.iter().map(|i| i.probe_location()).collect::<Vec<_>>(),
        vec![
            Some(ProbeLocation::ArchiveRoot),
            Some(ProbeLocation::ArchiveRoot),
            Some(ProbeLocation::Packages),
            Some(ProbeLocation::Packages),
        ]
    );
    assert!(scan.items.iter().filter(|i| i.family() != ResidueFamily::CapabilityProbe).all(|i| i.probe_location().is_none()));
    /* The shard and quarantine lookalikes were neither classified nor touched. */
    assert!(ab.join(".h2o-probe-4242-3").exists());
    assert!(root.join(".h2o-reclaim").join("run-1").join(".h2o-probe-4242-4").exists());

    let _ = fs::remove_dir_all(&root);
}

/// (RC-02 I.4)(B)(C) the family is recognized by the exact minted grammar
/// `.h2o-probe-<digits>-<digits>` and nothing wider: a reserved-prefix name
/// that deviates is INDETERMINATE (reported, never actionable), an entry of a
/// type no probe creates is indeterminate, and names outside the reserved
/// prefix are simply unrelated.
#[test]
fn capability_probe_lookalikes_are_indeterminate_or_unrelated_never_actionable() {
    let root = temp_root("rc02-lookalike");
    let pkgs = packages(&root);
    let malformed = [
        ".h2o-probe-x",
        ".h2o-probe-1",
        ".h2o-probe-1-2-3",
        ".h2o-probe--2",
        ".h2o-probe-1-",
        ".h2o-probe-1-2a",
        ".h2o-probe-1-٢",
        ".h2o-probe-",
    ];
    for name in malformed {
        fs::write(root.join(name), b"x").unwrap();
    }
    fs::create_dir_all(pkgs.join(".h2o-probe-1-2-3")).unwrap();
    // Over the bounded name length, even with the right digit grammar.
    let long = format!(".h2o-probe-1-{}", "9".repeat(MAX_RESIDUE_NAME));
    fs::write(root.join(&long), b"x").unwrap();
    // Outside the reserved prefix: unrelated, not even indeterminate.
    for name in ["h2o-probe-1-2", ".h2o-prob-1-2", ".h2o-probe", ".h2o_probe-1-2", ".H2O-PROBE-1-2"] {
        fs::write(root.join(name), b"x").unwrap();
    }
    // An entry type no probe creates: a FIFO under a well-formed name.
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let fifo = std::ffi::CString::new(root.join(".h2o-probe-5-5").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "fixture fifo");
    }

    let scan = scan_trusted_residue_within(&root);
    assert!(scan.complete, "{:?}", scan.blockers);
    assert!(ids(&scan).is_empty(), "nothing here is actionable: {:?}", ids(&scan));
    assert_eq!(scan.count_of(ResidueFamily::CapabilityProbe), 0);
    let mut expected: Vec<(String, &str)> = malformed
        .iter()
        .map(|n| (format!("archive/{n}"), reasons::NAME_SHAPE))
        .collect();
    expected.push((format!("archive/{long}"), reasons::NAME_SHAPE));
    expected.push(("archive/packages/.h2o-probe-1-2-3".to_string(), reasons::NAME_SHAPE));
    #[cfg(unix)]
    expected.push(("archive/.h2o-probe-5-5".to_string(), reasons::PROBE_ENTRY_TYPE));
    expected.sort();
    let mut reported: Vec<(String, &str)> = scan
        .indeterminate
        .iter()
        .map(|i| (i.path.clone(), i.reason))
        .collect();
    reported.sort();
    assert_eq!(reported, expected);
    assert!(scan.indeterminate.iter().all(|i| i.kind == CAPABILITY_PROBE_KIND));
    /* The grammar itself, directly. */
    assert!(is_capability_probe_residue(b".h2o-probe-1-0"));
    assert!(is_capability_probe_residue(b".h2o-probe-4294967295-18446744073709551615"));
    for bad in malformed {
        assert!(!is_capability_probe_residue(bad.as_bytes()), "{bad}");
    }
    assert!(!is_capability_probe_residue(long.as_bytes()));
    assert!(!is_capability_probe_residue(b"h2o-probe-1-0"));
    assert!(!is_capability_probe_residue(b".h2o-probe-1-0/x"));

    let _ = fs::remove_dir_all(&root);
}

/// (RC-02 I.5)(C) a symlink wearing a well-formed probe name is never followed:
/// it is indeterminate in either location, and whatever it points at — a
/// canonical directory, a canonical file, a target outside the archive — is
/// neither classified nor inspected through it.
#[cfg(unix)]
#[test]
fn capability_probe_symlink_lookalikes_are_never_followed() {
    let root = temp_root("rc02-symlink");
    let pkgs = packages(&root);
    let generation = pkgs.join(format!("chat_a.g{}.h2ochat", "ab".repeat(32)));
    fs::create_dir_all(&generation).unwrap();
    fs::write(generation.join("manifest.json"), b"{}").unwrap();
    let outside = root.parent().unwrap().join("rc02-outside-target");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret"), b"outside").unwrap();
    // Root: a link to a canonical directory; packages: links to a canonical
    // file and to a directory outside the archive entirely.
    std::os::unix::fs::symlink(&generation, root.join(".h2o-probe-8-0")).unwrap();
    std::os::unix::fs::symlink(generation.join("manifest.json"), pkgs.join(".h2o-probe-8-1")).unwrap();
    std::os::unix::fs::symlink(&outside, pkgs.join(".h2o-probe-8-2")).unwrap();
    // A dangling link: still a link, still never followed.
    std::os::unix::fs::symlink(root.join("nowhere"), root.join(".h2o-probe-8-3")).unwrap();
    // One genuine item beside them, so the walk demonstrably continued.
    fs::write(root.join(".h2o-probe-9-0"), b"probe").unwrap();

    let scan = scan_trusted_residue_within(&root);
    assert!(scan.complete, "{:?}", scan.blockers);
    assert_eq!(ids(&scan), vec!["capability-probe|archive/.h2o-probe-9-0"]);
    let mut links: Vec<(String, &str)> = scan
        .indeterminate
        .iter()
        .map(|i| (i.path.clone(), i.reason))
        .collect();
    links.sort();
    assert_eq!(
        links,
        vec![
            ("archive/.h2o-probe-8-0".to_string(), reasons::SYMLINK),
            ("archive/.h2o-probe-8-3".to_string(), reasons::SYMLINK),
            ("archive/packages/.h2o-probe-8-1".to_string(), reasons::SYMLINK),
            ("archive/packages/.h2o-probe-8-2".to_string(), reasons::SYMLINK),
        ]
    );
    assert!(generation.join("manifest.json").exists(), "the canonical target is untouched");
    assert!(outside.join("secret").exists(), "the outside target is untouched");
    assert!(root.join(".h2o-probe-8-0").symlink_metadata().unwrap().file_type().is_symlink());

    let _ = fs::remove_dir_all(&outside);
    let _ = fs::remove_dir_all(&root);
}

/// (RC-02 I.7)(F) the family ranks after the two established families and,
/// within it, by trusted archive identity: creation order never reaches the
/// action order, and a re-scan is stable.
#[test]
fn capability_probe_order_is_deterministic_not_filesystem_order() {
    let names = [".h2o-probe-1-0", ".h2o-probe-1-1", ".h2o-probe-10-0", ".h2o-probe-2-0"];

    let forward = temp_root("rc02-order-f");
    let fp = packages(&forward);
    for n in names {
        fs::write(forward.join(n), b"p").unwrap();
        fs::create_dir_all(fp.join(n)).unwrap();
    }
    fs::create_dir_all(fp.join(".h2o-genstage-00ff01")).unwrap();
    fs::write(shard(&forward, "ab").join(".h2o-durable-5-0.tmp"), b"t").unwrap();

    let reverse = temp_root("rc02-order-r");
    let rp = packages(&reverse);
    fs::write(shard(&reverse, "ab").join(".h2o-durable-5-0.tmp"), b"t").unwrap();
    fs::create_dir_all(rp.join(".h2o-genstage-00ff01")).unwrap();
    for n in names.iter().rev() {
        fs::create_dir_all(rp.join(n)).unwrap();
        fs::write(reverse.join(n), b"p").unwrap();
    }

    let a = scan_trusted_residue_within(&forward);
    let b = scan_trusted_residue_within(&reverse);
    assert_eq!(ids(&a), ids(&b), "insertion order must not reach action order");
    assert_eq!(
        ids(&a),
        vec![
            "generation-staging|archive/packages/.h2o-genstage-00ff01",
            "durable-temp|archive/assets/ab/.h2o-durable-5-0.tmp",
            "capability-probe|archive/.h2o-probe-1-0",
            "capability-probe|archive/.h2o-probe-1-1",
            "capability-probe|archive/.h2o-probe-10-0",
            "capability-probe|archive/.h2o-probe-2-0",
            "capability-probe|archive/packages/.h2o-probe-1-0",
            "capability-probe|archive/packages/.h2o-probe-1-1",
            "capability-probe|archive/packages/.h2o-probe-10-0",
            "capability-probe|archive/packages/.h2o-probe-2-0",
        ],
        "family rank, then trusted archive identity"
    );
    assert_eq!(ids(&scan_trusted_residue_within(&forward)), ids(&a));

    let _ = fs::remove_dir_all(&forward);
    let _ = fs::remove_dir_all(&reverse);
}

/// (RC-02 I.8)(D)(E) the family extends the ONE scanner and ONE grammar
/// authority — no second scanner, no command, no destructive capability: the
/// probe walk is private, unregistered, and can only read.
#[test]
fn the_capability_probe_family_adds_no_command_and_no_destructive_capability() {
    let source = include_str!("../archive_residue_probe.rs");
    let code: String = source
        .lines()
        .map(str::trim_start)
        .filter(|l| !l.starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(code.matches("#[tauri::command]").count(), 1, "no command was added");
    assert!(code.contains("fn scan_capability_probe_within("));
    assert!(!code.contains("pub fn scan_capability_probe_within("), "not reachable outside");
    assert!(!code.contains("pub(crate) fn scan_capability_probe_within("));
    /* Exactly one trusted scan entry point folds all three families. */
    let at = code.find("pub fn scan_trusted_residue_within").expect("the one authority");
    let body = &code[at..at + code[at..].find("\n}").unwrap()];
    assert!(body.contains("scan_generation_staging_within(archive_root, &mut out)"));
    assert!(body.contains("scan_durable_temp_within(archive_root, &mut out)"));
    assert!(body.contains("scan_capability_probe_within(archive_root, &mut out)"));
    /* The probe walk reads only: no unlink, rename, move, create or write. */
    let at = code.find("fn scan_capability_probe_in(").expect("the probe walk");
    let end = code.find("fn is_dir_stat(").expect("the following item");
    let walk = &code[at..end];
    for forbidden in [
        "unlink", "remove", "rename", "move_exclusive_into", "promote", "create_new_child",
        "mkdir", "write", "purge", "quarantine", "std::fs::", "open_child_nofollow(",
    ] {
        assert!(!walk.contains(forbidden), "the probe walk must not {forbidden}");
    }
    assert!(walk.contains("stat_child_nofollow"), "no-follow inspection only");
    assert!(walk.contains("reasons::SYMLINK"), "links are reported, never followed");
    assert!(walk.contains("reasons::PROBE_ENTRY_TYPE"), "foreign entry types are reported");
    assert!(walk.contains("reasons::NAME_SHAPE"), "malformed lookalikes are reported");
    /* The grammar is the capability layer's own reserved prefix, not a
       second literal that could drift from it. */
    assert!(code.contains("use crate::archive_filesystem_capability::PROBE_PREFIX;"));
    assert_eq!(code.matches("\".h2o-probe-").count(), 0, "no second probe-prefix literal");
    let lib = include_str!("../lib.rs");
    assert!(!lib.contains("scan_capability_probe"), "not registered");
}
