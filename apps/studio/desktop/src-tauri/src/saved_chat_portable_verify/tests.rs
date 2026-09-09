//! M10 P3.6a — session framing, caps and semantic delegation.
//!
//! Two distinct properties are under test here and they are kept apart on
//! purpose:
//!
//!   FRAMING — what this adapter genuinely owns. Every one of these must refuse
//!   before a single byte reaches the semantic verifier.
//!
//!   DELEGATION — that the session reaches the EXISTING verifier and returns its
//!   verdict unchanged. These reuse the canonical verifier fixtures rather than
//!   restating package semantics, because restating them here is exactly how a
//!   second verifier gets born.

use super::*;
use crate::saved_chat_package_verify::tests::{permanent_v3_fixture, OwnedPackage};

const PKG: &str = "fixture-chat.h2ochat";

fn new_registry() -> Registry {
    Registry::default()
}

fn open(registry: &Registry, basename: &str) -> u64 {
    let begun = begin(registry, basename, &[]);
    assert!(begun.ok, "begin refused: {:?}", begun.code);
    begun.token.expect("token")
}

/// Declare + write a member in one go, as a well-behaved client would.
fn put(registry: &Registry, token: u64, member: &str, bytes: &[u8]) -> AckResult {
    let declared = declare(registry, token, member, bytes.len() as u64);
    if !declared.ok {
        return declared;
    }
    write(registry, token, member, bytes)
}

/// Upload a canonical fixture package through the real session API.
fn upload(registry: &Registry, token: u64, pkg: &OwnedPackage) {
    assert!(put(registry, token, "manifest", &pkg.manifest).ok);
    if let Some(snapshot) = pkg.snapshot.as_ref() {
        assert!(put(registry, token, "snapshot", snapshot).ok);
    }
    if let Some(markdown) = pkg.markdown.as_ref() {
        assert!(put(registry, token, "markdown", markdown).ok);
    }
    if let Some(html) = pkg.html.as_ref() {
        assert!(put(registry, token, "html", html).ok);
    }
    // The declared PATH carries the extension; `asset_bodies` is keyed by sha.
    for descriptor in pkg.assets.iter() {
        let body = pkg
            .asset_bodies
            .iter()
            .find(|(sha, _)| sha == &descriptor.sha256)
            .map(|(_, body)| body.clone())
            .unwrap_or_default();
        // `assets/sha256-<hex>.<ext>` -> `asset:sha256-<hex>.<ext>`
        let key = format!(
            "asset:{}",
            descriptor
                .path
                .strip_prefix("assets/")
                .unwrap_or(descriptor.path.as_str())
        );
        assert!(put(registry, token, &key, &body).ok, "asset {key}");
    }
}

fn verify_fixture(registry: &Registry, pkg: &OwnedPackage, basename: &str) -> VerificationResult {
    let token = open(registry, basename);
    upload(registry, token, pkg);
    finish(registry, token)
}

// ── framing: member identity ───────────────────────────────────────────────

#[test]
fn member_keys_outside_the_canonical_domain_are_refused_before_any_byte() {
    for bad in [
        "chat.md",
        "assets/sha256-aa.png",
        "asset:sha256-ZZ.png",
        "asset:sha256-.png",
        "asset:sha256-",
        "manifest.json",
        "../manifest",
        "/manifest",
        "asset:sha256-c:/x.png",
        "snapshot\\..\\x",
    ] {
        assert!(
            parse_member_key(bad).is_err(),
            "member key must be refused: {bad}"
        );
    }
    // The claimed hash must be lowercase hex of exactly 64 characters.
    let hex = "a".repeat(64);
    assert!(parse_member_key(&format!("asset:sha256-{hex}.png")).is_ok());
    assert_eq!(
        parse_member_key(&format!("asset:sha256-{}.png", "A".repeat(64))),
        Err("portable-member-asset-hash-invalid")
    );
    assert_eq!(
        parse_member_key(&format!("asset:sha256-{hex}.PNG")),
        Err("portable-member-asset-ext-invalid")
    );
    assert_eq!(
        parse_member_key(&format!("asset:sha256-{hex}.{}", "p".repeat(17))),
        Err("portable-member-asset-ext-invalid")
    );
}

#[test]
fn member_path_cap_is_exact() {
    let at = "a".repeat(PORTABLE_MEMBER_PATH_CAP_BYTES);
    assert_eq!(parse_member_key(&at), Err("portable-member-key-invalid"));
    let over = "a".repeat(PORTABLE_MEMBER_PATH_CAP_BYTES + 1);
    assert_eq!(
        parse_member_key(&over),
        Err("portable-member-path-too-long")
    );
}

#[test]
fn basename_must_be_a_safe_non_reserved_package_name() {
    let registry = new_registry();
    for bad in [
        "",
        "not-a-package",
        "../escape.h2ochat",
        "dir/chat.h2ochat",
        "c:chat.h2ochat",
        ".h2ochat",
    ] {
        let begun = begin(&registry, bad, &[]);
        assert!(!begun.ok, "basename must be refused: {bad}");
        assert!(begun.token.is_none(), "a refused begin issues no token");
    }
    let over = format!("{}.h2ochat", "a".repeat(PORTABLE_BASENAME_CAP_BYTES));
    assert!(!begin(&registry, &over, &[]).ok, "basename cap is enforced");
}

// ── framing: declaration and append discipline ─────────────────────────────

#[test]
fn a_logical_member_is_declared_exactly_once_and_the_duplicate_takes_no_bytes() {
    let registry = new_registry();
    let token = open(&registry, PKG);
    assert!(declare(&registry, token, "manifest", 4).ok);
    let dup = declare(&registry, token, "manifest", 999);
    assert_eq!(dup.code, Some("portable-member-duplicate"));
    // The refused duplicate must not have replaced, extended or reset the
    // member already declared — the original 4-byte framing still governs.
    assert!(write(&registry, token, "manifest", b"abcd").ok);
    assert_eq!(
        write(&registry, token, "manifest", b"e").code,
        Some("portable-member-overrun")
    );
}

#[test]
fn a_member_arrives_as_sequential_chunks_and_members_may_interleave() {
    let registry = new_registry();
    let token = open(&registry, PKG);
    assert!(declare(&registry, token, "manifest", 6).ok);
    assert!(declare(&registry, token, "snapshot", 6).ok);
    // Interleaved, multi-chunk, no caller-supplied offset anywhere.
    assert!(write(&registry, token, "manifest", b"ab").ok);
    assert!(write(&registry, token, "snapshot", b"12").ok);
    assert!(write(&registry, token, "manifest", b"cd").ok);
    assert!(write(&registry, token, "snapshot", b"34").ok);
    assert!(write(&registry, token, "manifest", b"ef").ok);
    assert!(write(&registry, token, "snapshot", b"56").ok);
    // Both complete: the refusal that follows is semantic, not framing.
    let out = finish(&registry, token);
    assert_eq!(out.refusal.as_ref().map(|r| r.stage), Some("verifier"));
}

#[test]
fn undeclared_overrun_and_post_completion_writes_are_refused() {
    let registry = new_registry();
    let token = open(&registry, PKG);
    assert_eq!(
        write(&registry, token, "snapshot", b"x").code,
        Some("portable-member-undeclared")
    );
    assert!(declare(&registry, token, "snapshot", 2).ok);
    assert_eq!(
        write(&registry, token, "snapshot", b"xyz").code,
        Some("portable-member-overrun")
    );
    assert!(write(&registry, token, "snapshot", b"xy").ok);
    // Writing after the member is already complete is the same overrun.
    assert_eq!(
        write(&registry, token, "snapshot", b"z").code,
        Some("portable-member-overrun")
    );
}

#[test]
fn an_underrun_member_refuses_at_finish_and_never_reaches_the_verifier() {
    let registry = new_registry();
    let token = open(&registry, PKG);
    assert!(declare(&registry, token, "manifest", 8).ok);
    assert!(write(&registry, token, "manifest", b"abc").ok);
    let out = finish(&registry, token);
    assert!(!out.verified);
    let refusal = out.refusal.expect("refusal");
    assert_eq!(refusal.stage, "adapter");
    assert_eq!(refusal.code, "portable-member-incomplete");
}

#[test]
fn finish_without_a_manifest_is_an_adapter_refusal() {
    let registry = new_registry();
    let token = open(&registry, PKG);
    assert!(put(&registry, token, "snapshot", b"{}").ok);
    let out = finish(&registry, token);
    let refusal = out.refusal.expect("refusal");
    assert_eq!(refusal.stage, "adapter");
    assert_eq!(refusal.code, "portable-manifest-missing");
}

// ── framing: caps, at the limit and one past it ────────────────────────────

#[test]
fn chunk_cap_is_exact() {
    let registry = new_registry();
    let token = open(&registry, PKG);
    let cap = CHUNK_CAP_BYTES as usize;
    assert!(declare(&registry, token, "html", cap as u64 + 1).ok);
    assert!(
        write(&registry, token, "html", &vec![0u8; cap]).ok,
        "a chunk exactly at the cap is accepted"
    );
    assert_eq!(
        write(&registry, token, "html", &vec![0u8; cap + 1]).code,
        Some("portable-chunk-too-large")
    );
}

#[test]
fn per_member_caps_are_exact() {
    for (member, cap) in [
        ("manifest", PORTABLE_MANIFEST_CAP_BYTES),
        ("snapshot", SNAPSHOT_CAP_BYTES),
        ("markdown", PORTABLE_MARKDOWN_CAP_BYTES),
        ("html", PORTABLE_HTML_CAP_BYTES),
    ] {
        let registry = new_registry();
        let token = open(&registry, PKG);
        assert!(
            declare(&registry, token, member, cap).ok,
            "{member} at its cap is admissible"
        );
        let over = new_registry();
        let over_token = open(&over, PKG);
        assert_eq!(
            declare(&over, over_token, member, cap + 1).code,
            Some("portable-member-too-large"),
            "{member} one byte past its cap is refused"
        );
    }
    // Assets use the governed blob ceiling.
    let registry = new_registry();
    let token = open(&registry, PKG);
    let key = format!("asset:sha256-{}.png", "a".repeat(64));
    assert!(declare(&registry, token, &key, ASSET_CAP_BYTES).ok);
    let over = new_registry();
    let over_token = open(&over, PKG);
    assert_eq!(
        declare(&over, over_token, &key, ASSET_CAP_BYTES + 1).code,
        Some("portable-member-too-large")
    );
}

#[test]
fn asset_and_member_count_caps_are_exact() {
    let registry = new_registry();
    let token = open(&registry, PKG);
    for index in 0..PORTABLE_ASSET_COUNT_CAP {
        let key = format!("asset:sha256-{:064x}.png", index);
        assert!(declare(&registry, token, &key, 0).ok, "asset {index}");
    }
    let over = format!("asset:sha256-{:064x}.png", PORTABLE_ASSET_COUNT_CAP);
    assert_eq!(
        declare(&registry, token, &over, 0).code,
        Some("portable-asset-count-exceeded")
    );
    // 1020 assets + the four canonical members = 1024, the member ceiling.
    for member in ["manifest", "snapshot", "markdown", "html"] {
        assert!(declare(&registry, token, member, 0).ok, "{member}");
    }
    let extra = format!("asset:sha256-{:064x}.png", PORTABLE_ASSET_COUNT_CAP + 1);
    assert_eq!(
        declare(&registry, token, &extra, 0).code,
        Some("portable-member-count-exceeded"),
        "the member ceiling binds once the canonical inventory is present"
    );
}

#[test]
fn package_total_cap_is_exact_and_charged_at_declaration() {
    let registry = new_registry();
    let token = open(&registry, PKG);
    // Reserve the total in asset-sized declarations without sending any bytes:
    // the ceiling must bind on the DECLARED length, not on what arrives.
    let per = ASSET_CAP_BYTES;
    let whole = PORTABLE_PACKAGE_TOTAL_CAP_BYTES / per;
    for index in 0..whole {
        let key = format!("asset:sha256-{:064x}.bin", index);
        assert!(declare(&registry, token, &key, per).ok, "asset {index}");
    }
    let remainder = PORTABLE_PACKAGE_TOTAL_CAP_BYTES - whole * per;
    assert!(
        declare(&registry, token, "html", remainder).ok,
        "exactly at the total"
    );
    assert_eq!(
        declare(&registry, token, "manifest", 1).code,
        Some("portable-package-total-exceeded"),
        "one byte past the package total is refused"
    );
}

// ── session lifecycle ──────────────────────────────────────────────────────

#[test]
fn only_one_session_is_live_and_a_live_one_is_never_evicted() {
    let registry = new_registry();
    let first = open(&registry, PKG);
    let second = begin(&registry, "other-chat.h2ochat", &[]);
    assert!(!second.ok);
    assert_eq!(second.code, Some("portable-session-busy"));
    // The refused begin must not have disturbed the live session.
    assert!(declare(&registry, first, "manifest", 2).ok);
    assert!(write(&registry, first, "manifest", b"{}").ok);
}

#[test]
fn an_idle_session_is_reclaimed_lazily_at_begin() {
    let registry = new_registry();
    let stale = open(&registry, PKG);
    // Age the session past the idle window without a timer thread.
    {
        let map = registry.lock_map();
        let session = map.get(&stale).expect("session");
        let mut inner = session.inner.lock().unwrap();
        inner.touched_at = Instant::now() - SESSION_IDLE_TIMEOUT - Duration::from_secs(1);
    }
    let fresh = begin(&registry, "other-chat.h2ochat", &[]);
    assert!(fresh.ok, "an idle session is swept, not treated as busy");
    assert_eq!(
        declare(&registry, stale, "manifest", 1).code,
        Some("portable-session-unknown"),
        "the reclaimed token is gone"
    );
}

#[test]
fn tokens_stay_inside_the_range_javascript_represents_exactly() {
    // The token crosses an IPC boundary as a JSON number. A 64-bit value would
    // be rounded in the renderer, so every later call would name a session that
    // does not exist — and the abandoned one would hold the single slot.
    for _ in 0..64 {
        let registry = new_registry();
        let token = open(&registry, PKG);
        assert!(token > 0, "a token is never zero");
        assert!(
            token <= (1u64 << 53) - 1,
            "token {token} is outside the exactly-representable range"
        );
        assert_eq!(
            token as f64 as u64, token,
            "token survives a JSON round trip"
        );
    }
}

#[test]
fn unknown_tokens_and_tokens_after_finish_are_refused() {
    let registry = new_registry();
    assert_eq!(
        declare(&registry, 42, "manifest", 1).code,
        Some("portable-session-unknown")
    );
    assert_eq!(
        write(&registry, 42, "manifest", b"x").code,
        Some("portable-session-unknown")
    );
    let token = open(&registry, PKG);
    assert!(put(&registry, token, "manifest", b"{}").ok);
    let _ = finish(&registry, token);
    // finish destroys the session unconditionally, verified or not.
    assert_eq!(
        declare(&registry, token, "snapshot", 1).code,
        Some("portable-session-unknown")
    );
    assert_eq!(
        finish(&registry, token).refusal.expect("refusal").code,
        "portable-session-unknown"
    );
}

#[test]
fn abort_destroys_the_session_and_is_idempotent() {
    let registry = new_registry();
    let token = open(&registry, PKG);
    assert!(abort(&registry, token).ok);
    // An already-absent token is still a successful abort, so a client
    // `finally` can call it without knowing what happened.
    assert!(abort(&registry, token).ok);
    assert!(abort(&registry, 999_999).ok);
    // And the slot is genuinely free again.
    assert!(begin(&registry, PKG, &[]).ok);
}

// ── semantic delegation ────────────────────────────────────────────────────

#[test]
fn canonical_fixtures_reach_the_existing_verifier_and_keep_its_verdict() {
    for gzip in [false, true] {
        let pkg = permanent_v3_fixture(gzip);
        let expected = verify_package(
            PackageMembers {
                manifest: &pkg.manifest,
                snapshot: pkg.snapshot.as_deref(),
                markdown: pkg.markdown.as_deref(),
                html: pkg.html.as_deref(),
                assets: &pkg.assets,
                unexpected_members: &[],
            },
            &pkg.chat_id,
            VerificationAdmission::AllSupported,
        )
        .expect("canonical fixture verifies directly");

        let registry = new_registry();
        let basename = format!("{}.h2ochat", pkg.chat_id);
        let out = verify_fixture(&registry, &pkg, &basename);

        assert!(out.verified, "gzip={gzip} refusal={:?}", out.refusal);
        assert_eq!(out.schema, VERIFICATION_SCHEMA);
        assert_eq!(out.schema_version, VERIFICATION_SCHEMA_VERSION);
        assert_eq!(out.chat_id.as_deref(), Some(pkg.chat_id.as_str()));
        assert_eq!(out.package_dir_name.as_deref(), Some(basename.as_str()));
        assert_eq!(out.construction_family.as_deref(), Some("v3"));
        assert_eq!(out.name_classification, Some("legacy"));
        // Bare lowercase hex on the wire, exactly like the trusted archive side.
        let hash = out.content_hash.clone().expect("contentHash");
        assert_eq!(hash, expected.content_hash.trim_start_matches("sha256-"));
        assert!(!hash.starts_with("sha256-"));
        assert!(hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()));
        for sha in out.asset_shas.clone().expect("assetShas") {
            assert!(!sha.starts_with("sha256-"), "asset shas are bare too");
        }
        assert_eq!(
            out.logical_snapshot_byte_length,
            Some(expected.logical_snapshot_byte_length)
        );
    }
}

#[test]
fn a_generation_basename_is_classified_and_binds_the_verification() {
    let pkg = permanent_v3_fixture(false);
    let expected = verify_package(
        PackageMembers {
            manifest: &pkg.manifest,
            snapshot: pkg.snapshot.as_deref(),
            markdown: None,
            html: None,
            assets: &pkg.assets,
            unexpected_members: &[],
        },
        &pkg.chat_id,
        VerificationAdmission::AllSupported,
    )
    .expect("fixture verifies");
    let hex = expected.content_hash.trim_start_matches("sha256-");

    let registry = new_registry();
    let basename = format!("{}.g{hex}.h2ochat", pkg.chat_id);
    let out = verify_fixture(&registry, &pkg, &basename);
    assert!(out.verified, "{:?}", out.refusal);
    assert_eq!(out.name_classification, Some("generation"));

    // Identity comes from the BASENAME, never from the manifest's own claim: a
    // package renamed to another chat must be refused, not silently accepted.
    let foreign = new_registry();
    let out = verify_fixture(&foreign, &pkg, "someone-elses-chat.h2ochat");
    assert!(!out.verified);
    assert_eq!(out.refusal.expect("refusal").stage, "verifier");
}

#[test]
fn semantic_refusals_are_reported_as_verifier_refusals_with_the_real_code() {
    // A corrupt gzip member: framing is perfect, semantics are not. The stage
    // must say `verifier`, and the code must be the verifier's own — an adapter
    // failure never borrows a verifier blocker, and vice versa.
    let mut pkg = permanent_v3_fixture(true);
    let snapshot = pkg.snapshot.as_mut().expect("snapshot");
    let last = snapshot.len() - 1;
    snapshot[last] ^= 0xff;
    let direct = verify_package(
        PackageMembers {
            manifest: &pkg.manifest,
            snapshot: pkg.snapshot.as_deref(),
            markdown: None,
            html: None,
            assets: &pkg.assets,
            unexpected_members: &[],
        },
        &pkg.chat_id,
        VerificationAdmission::AllSupported,
    )
    .expect_err("corrupt gzip must refuse");

    let registry = new_registry();
    let out = verify_fixture(&registry, &pkg, &format!("{}.h2ochat", pkg.chat_id));
    assert!(!out.verified);
    let refusal = out.refusal.expect("refusal");
    assert_eq!(refusal.stage, "verifier");
    assert_eq!(refusal.code, direct);
    // A refused verification carries no identity facts to misread as partial
    // success.
    assert!(out.content_hash.is_none());
    assert!(out.chat_id.is_none());
}

#[test]
fn asset_bytes_are_hashed_from_what_actually_arrived_not_from_the_declared_name() {
    // The key's hash is a CLAIM. Corrupt the body and keep the name: the
    // adapter must hash the real bytes so the verifier sees the mismatch.
    let mut pkg = permanent_v3_fixture(false);
    assert!(!pkg.asset_bodies.is_empty(), "fixture carries an asset");
    pkg.asset_bodies[0].1[0] ^= 0xff;

    let registry = new_registry();
    let out = verify_fixture(&registry, &pkg, &format!("{}.h2ochat", pkg.chat_id));
    assert!(!out.verified, "a corrupt asset body must not verify");
    assert_eq!(out.refusal.expect("refusal").stage, "verifier");
}

#[test]
fn a_member_outside_the_canonical_inventory_reaches_the_verifier_as_unexpected() {
    // ZIP parsing is deliberately not native, so the entry inventory can only
    // come from the caller. Naming an extra persistent member must make the
    // verification STRICTER — it can never make an invalid package valid.
    let pkg = permanent_v3_fixture(false);
    let basename = format!("{}.h2ochat", pkg.chat_id);

    let clean = new_registry();
    assert!(verify_fixture(&clean, &pkg, &basename).verified);

    let registry = new_registry();
    let token = begin(&registry, &basename, &["stowaway.bin".to_string()])
        .token
        .expect("token");
    upload(&registry, token, &pkg);
    let out = finish(&registry, token);
    assert!(!out.verified, "an unexpected persistent member must refuse");
    let refusal = out.refusal.expect("refusal");
    assert_eq!(refusal.stage, "verifier");
    assert_eq!(refusal.code, "generation-package-unexpected-member");
}

#[test]
fn unexpected_member_names_are_bounded_and_path_safe() {
    let registry = new_registry();
    for bad in ["../escape", "/abs", String::new().as_str()] {
        let begun = begin(&registry, PKG, &[bad.to_string()]);
        assert!(!begun.ok, "unexpected member name must be refused: {bad}");
    }
    let over = "a".repeat(PORTABLE_MEMBER_PATH_CAP_BYTES + 1);
    assert!(!begin(&registry, PKG, &[over]).ok);
}

#[test]
fn the_adapter_writes_nothing_and_keeps_no_state_after_finish() {
    let registry = new_registry();
    let pkg = permanent_v3_fixture(false);
    let basename = format!("{}.h2ochat", pkg.chat_id);
    let first = verify_fixture(&registry, &pkg, &basename);
    assert!(first.verified);
    assert!(
        registry.lock_map().is_empty(),
        "finish destroys the session unconditionally"
    );
    // And the same package verifies identically again: no memoized verdict, no
    // persistent record, nothing carried between sessions.
    let second = verify_fixture(&registry, &pkg, &basename);
    assert_eq!(second.content_hash, first.content_hash);
}
