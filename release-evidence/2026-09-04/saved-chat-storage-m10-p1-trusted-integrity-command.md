# M10 P1 — Trusted read-only archive integrity command

Focused implementation-phase record for the P1 safety boundary only. It
authorizes no operator migration, no push, no merge, and no P2/P3/P4 work.

## Identity

**Mission:** M10 — Archive Integrity & Observability
**Phase:** P1 — expose existing trusted authority
**Lane:** L-SAVED-CHAT-STORAGE
**Worktree:** `worktrees/h2o-cp-saved-chat-storage`
**Branch:** `work/saved-chat-storage`
**Starting HEAD:** `58137fe33fd83a6d40dd97a92dd7a190c0fcde44`
**Starting tree:** `daa37b8fa3f25ce3cb54a6c733d6d9935c78cb67`

## Changed seam

| Path | Responsibility |
| --- | --- |
| `src/saved_chat_archive_integrity.rs` | NEW. Read-only projection of the existing trusted chain into one wire envelope. No authority of its own. |
| `src/saved_chat_archive_integrity/tests.rs` | NEW. Command behaviour and false-healthy divergence coverage. |
| `src/archive_package_scan.rs` | `OccupantClass::Indeterminate` gains `verifier_blocker: Option<&'static str>`; the existing `.map_err(\|(outcome, _)\| …)` discard is narrowed so the canonical code survives. |
| `src/archive_retention_plan.rs` | Pattern moved to future-additive `{ reason, .. }`. No decision logic changed. |
| `src/archive_occupant_quarantine.rs` | Pattern moved to future-additive `{ reason, .. }`. Eligibility still driven solely by `reason.is_occupant_remedy_class()`. |
| `src/lib.rs` | Module declared; command registered in BOTH the debug and release invoke handlers. |
| four `tests.rs` files | Compile-forced mechanical updates only. |
| `tools/validation/studio/validate-saved-chat-archive-integrity-contract-v1.mjs` | NEW. Focused wire-contract validator. |

## Command / wire contract

`h2o_saved_chat_archive_integrity` → `Result<ArchiveIntegrityResult, String>`,
taking ONLY `tauri::AppHandle`. Schema `h2o.savedChatArchiveIntegrity`, version
`1`. Composes exactly `archive_durable_write::archive_root`,
`archive_package_scan::scan_packages_within` and
`saved_chat_generation_policy::production_policy`.

`Err` means no trustworthy envelope could be formed at all; every observable
archive defect is a successful result inside the envelope. No `status`, `ok`,
health taxonomy, wall clock, random id, host path or chat content. Populations
are named `observed`, never `total`.

## Blocker granularity — narrow contract observation

The seam this phase captures is `verify_occupant_all_supported`, whose
vocabulary is the COARSE occupant-level outcome set
(`generation-destination-corrupt`, `generation-partial`,
`generation-occupant-unreadable`). The granular per-rule codes are collapsed one
layer deeper by a SECOND discard at `archive_generation_publish.rs:1760`
(`.map_err(|_| (Outcome::GenerationDestinationCorrupt, …))`). Surfacing those
would mean changing verifier behaviour, which P1 does not authorize; the codes
are therefore carried verbatim from the authorized seam and no code is renamed
or invented.

Envelope field names follow the ACTUAL Rust types: the snapshot identities are
`snapshotPhysicalSha256` / `logicalSnapshotSha256` with their byte lengths, and
`indeterminateByReason` covers all six canonical reasons including
`unexpectedOutcome`.

## M06 destructive safety

`verifier_blocker` is diagnostic evidence only. Neither
`archive_retention_plan.rs` nor `archive_occupant_quarantine.rs` names the
field; both match on `reason` alone.

| Suite | Result |
| --- | --- |
| M06 focused matrix (7 modules) | **168 passed, 0 failed, 5 helper-only ignored** — the accepted 166 baseline plus the 2 new targeted tests |
| `archive_occupant_quarantine` | **27 passed** — accepted 26 plus 1 new targeted test |
| Full lib | **625 passed, 0 failed, 5 ignored** |
| `cargo check --offline --lib` | clean |

Targeted blocker-seam protections: the canonical code survives verbatim into the
classification (compared against the verifier's own return, not a hard-coded
string); the whole retention plan is equal with `Some(..)` vs `None`; quarantine
eligibility and classification are identical across both.

## Operator migration

NOT started. The JS package-integrity computation remains in place and
unmodified; no renderer or tooling caller was repointed at the new command.
Archive Health UI (35 checks), reclamation activation (16), diagnostics (70),
materializer (46), coverage (20) and the Studio pack/reference smoke all pass
unchanged. P2/P3/P4 remain unauthorized.
