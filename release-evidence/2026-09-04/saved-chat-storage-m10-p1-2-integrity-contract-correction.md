# M10 P1.2 — Trusted integrity contract correction

Additive correction on top of the P1 checkpoint. It authorizes no operator
migration, no push, no merge, and no P2/P3/P4 work. The P1 record for
`797d80eb` is left intact as historical truth.

## Identity

**Parent P1 checkpoint:** `797d80ebada1274b187e743b710ee58c2903389a`
**Lane:** L-SAVED-CHAT-STORAGE · `work/saved-chat-storage`

## Correction A — trusted snapshotId

`ValidatedManifest.snapshot_id` is already established by
`saved_chat_package_verify::validate_manifest` and already proved equal to the
snapshot's own `snapshotId` by `validate_snapshot_cross_binding`. It reached
`archive_package_scan::verified_package` inside `VerifiedOccupant.manifest` and
was discarded there.

It is now carried into `VerifiedPackage.snapshot_id` directly from
`verified.manifest.snapshot_id`, beside `chat_id` — no second parse, no hash
substitute, no inference — and projected to the wire as `snapshotId` on verified
and legacy occupants. Indeterminate and reserved occupants carry none.

It is an identity fact only: no retention, reclamation, delete, quarantine,
ordering, contentHash or classification decision reads it.

## Correction B — granular verifier blocker

`(Outcome, &'static str)` became
`AdmissionFailure = (Outcome, &'static str, Option<&'static str>)`.

Elements `.0`/`.1` are the EXISTING coarse admission Outcome and code with
unchanged semantics; `.2` is the granular `saved_chat_package_verify` rule code,
present only when that verifier refused the package.

Three discards preserved, all of them genuine `saved_chat_package_verify` rule
failures reached through the same adapter:

| Site | Rule source |
| --- | --- |
| `validate_manifest` | manifest rules |
| `validate_snapshot_cross_binding` | v1/v2 cross-binding |
| `verify_package` | v3 semantic rules |

19 remaining coarse construction sites gained an explicit `None`. Failures the
adapter raises itself — directory member inventory, filesystem readability,
missing members — carry `None`, because they never reached the package verifier
and no granular code may be fabricated for them.

`OccupantClass::Indeterminate.verifier_blocker` now means exactly the rule-level
code, never the coarse admission string; `reason` continues to carry the broad
classification, so the two are complementary rather than redundant. Envelope
`blockers[]` carries the granular code, or is empty.

Observed effect: families that all collapsed to `generation-destination-corrupt`
are now distinguishable, e.g.
`generation-v3-snapshot-legacy-content-forbidden`,
`generation-v3-snapshot-messages-invalid`,
`generation-v3-manifest-file-inventory-invalid`,
`generation-manifest-chat-id-missing`.

## Coarse admission preservation

Proven unchanged for all three representative classes: granular verification
failure → `GenerationDestinationCorrupt` / `"generation-destination-corrupt"`;
partial → `GenerationPartial` / `"generation-partial"`; unreadable →
`GenerationOccupantUnreadable` / `"generation-occupant-unreadable"`. Publication
explicitly discards the granular element
(`Err((outcome, code, _granular)) => …`), and M07 handoff's wildcard `map_err`
is untouched.

## Schema

`h2o.savedChatArchiveIntegrity`, version `1` — unchanged. P1.2 completes the
originally approved schema-1 contract; no released consumer exists.

## Regression totals

| Suite | Result |
| --- | --- |
| Full lib | **629 passed / 0 failed / 5 ignored** (P1: 625) |
| M06 focused matrix | **168 / 0 / 5 — identical to P1** |
| `archive_occupant_quarantine` | **27 — identical to P1** |
| `archive_generation_publish` | **88** (P1: 87; +1 coarse-admission regression test) |
| `archive_transport_handoff` | **20 — identical to P1** |
| `archive_package_scan` | 20 (P1: 19) |
| `saved_chat_archive_integrity` | 14 (P1: 12) |
| `cargo check --offline --lib` | clean |
| Wire validator | **14 / 14** (P1: 12) |

JS/product non-regression unchanged: Archive Health UI 35, diagnostics 70,
coverage 20, reclamation activation 16, materializer 46, pack/reference smoke
ALL PASS. No JS implementation file was modified.

## Authority

One canonical semantic verifier, one admission adapter, one scanner, one hash
derivation, exactly one verification pass. Granular evidence is CARRIED, never
recomputed. Coarse admission authority still resides in
`archive_generation_publish`. The JS verifier still exists pending P3/P4.

P1.2 CREATES NO NEW INTEGRITY AUTHORITY. Operator migration not started;
P2/P3/P4 remain unauthorized.
