# Studio Desktop Release Evidence Contract (M03 DP01)

Status: adopted semantic contract; DP02 Slice A implements an off-main Product
candidate only. It grants no RC designation, Release, publication, deployment,
activation, governed storage, or Product-main landing authority.

## Identity and authority

The component is `studio-desktop`; its version authority is
`apps/studio/desktop/package.json#version` (SemVer). The accepted identity chain
is Product source commit → `studio-desktop@<SemVer>` → governed build → digested
artifact → immutable numbered RC → HDA/Product Release → optional deployment →
optional activation/promotion. An RC is
`studio-desktop/v<SemVer>/rc.<positive-decimal-integer>`; the Release ID is
`studio-desktop/v<SemVer>`. There is no RC tag. The optional Release tag is
`component/studio-desktop/v<SemVer>`.

Evidence records facts and decisions; **its authority effect is NONE**.
HDA/Product alone designates an RC and decides Release and publication through
authoritative Management/HDA records. Git owns native commit/tree/ref/tag
objects. A GitHub Release is hosted presentation/distribution state, never
H2O Release authority. Tag creation, hosted Release and publication require
their own later decisions.

Studio Build & Delivery owns the release-evidence schema, build/artifact/RC
provenance, publication receipts and deployment/activation evidence. It is the
evidence recorder and primary and independent evidence/artifact-copy custodian.
Repository owns Git/tag and GitHub Release provenance mechanics and Product/
Management repository recovery material, with **no artifact-byte custody**.
Filesystem owns physical placement policy. Workspace Control projects an
approved portable mapping and machine-local binding; neither becomes an
artifact/evidence semantic owner. T04 verification is assigned to a separate
Repository VER operator who did not produce the evidence, make the copy or its
Git bundles, or perform the tag/hosted operation under test. Verification
transfers no build/artifact/RC semantic ownership.

## Sealed objects and append-only index

The top level is an **append-only Release Evidence Index**. Every evidence
payload is RFC 8785 UTF-8 JSON Canonicalization Scheme (JCS) data. SHA-256 of
the exact canonical UTF-8 payload gives the external object ID
`obj:sha256:<64-lowercase-hex>`. Object and index digests are **not fields of
their own hashed payload**. Raw input must already equal its canonical bytes;
duplicate-key or otherwise noncanonical raw JSON is rejected.

| Object/event | Schema ID |
|---|---|
| Governed build | `h2o.studio.release-evidence.build.v1` |
| Artifact | `h2o.studio.release-evidence.artifact.v1` |
| Decision reference | `h2o.studio.release-evidence.decision-reference.v1` |
| Numbered RC | `h2o.studio.release-evidence.rc.v1` |
| Git tag observation | `h2o.studio.release-evidence.tag-event.v1` |
| GitHub Release observation | `h2o.studio.release-evidence.github-event.v1` |
| Publication action | `h2o.studio.release-evidence.publication-event.v1` |
| Deployment or activation, distinct event types | `h2o.studio.release-evidence.delivery-event.v1` |
| Index entry | `h2o.studio.release-evidence.index-entry.v1` |
| Independent copy attestation | `h2o.studio.release-evidence.copy-attestation.v1` |

All sealed objects are immutable. An index entry has ID
`<releaseId>/index/<positive-integer-sequence>/sha256:<entryDigest>`. Sequence
starts at 1 with a null predecessor; each later entry binds the preceding
entry's `sha256:<digest>`. Gaps, duplicate sequences, forks, predecessor
mismatches and overwrites fail. Entries bind child schema, semantic ID and
content object ID. Supersession, rejection and withdrawal append new entries;
prior observations remain historical. Current state is resolved from the
verified predecessor chain **and sealed HDA/Product decision references**,
never a bare disposition string, filename order or a mutable `latest.json`.
Every entry retains `authorityEffect: "NONE"`.

Decision references use explicit kinds `RC_DESIGNATION`, `RC_REJECTION`,
`RELEASE_APPROVAL`, `RELEASE_SUPERSESSION`, `RELEASE_WITHDRAWAL`,
`PUBLICATION_DECISION` and `TAG_CREATION`. RC rejection binds its exact RC
object; Release supersession and withdrawal bind the exact predecessor Release
approval or supersession decision object. The sealed reference includes
`targetObjectId`, which must equal the index entry's `supersedesObjectId`.
`reject` requires an `RC_REJECTION` child, `withdraw` requires a
`RELEASE_WITHDRAWAL` child, and Release-level `supersede` requires a
`RELEASE_SUPERSESSION` child. A technical evidence supersession may replace
only evidence of the same technical schema and semantic identity; it cannot
change RC/Release disposition. Missing, mismatched or unsealed decisions fail
closed. Neither a decision-reference object nor its index entry grants the
decision it records; the cited Management/HDA record remains authoritative.

Every T03 test fixture carries `synthetic: true` and `authorityEffect: "NONE"`.
Real/effective validation rejects any synthetic object or index entry. Such
fixtures never prove actual RC designation, Release, tag, publication,
deployment or activation.

## Build, artifact and decision bindings

Build evidence binds `studio-desktop`, synchronized SemVer, exact full Product
commit, checkpoint, UTC build time, target OS, architecture, `release` profile,
`governed=true`, `sourceDirty=false`, packaged-executable readback and an
independent executable SHA-256. A build pass alone does not designate an RC.
The existing Tauri command `h2o_studio_desktop_build_identity` and schema
`h2o.studio.desktop-build-identity.v1` remain unchanged for UI consumers.

The packaged executable separately supports exact invocation
`--h2o-build-identity-json`. It emits one JSON object of schema
`h2o.studio.release-evidence.packaged-build-identity.v1` with `schema`,
`componentId`, `componentVersion`, `sourceCommit`, `checkpoint`, `builtAtUtc`,
`targetOs`, `architecture`, `profile`, `governed`, `sourceDirty` and
`executableSha256`. The mode hashes the running executable read-only before
Tauri startup and exits nonzero if required stamped/readback data is missing
or inconsistent. Ordinary invocation still starts Tauri.

Artifacts have distinct executable, `.app` and DMG identities bound to one
build object, source commit, version and target OS/architecture. The executable
and DMG use `sha256-file-v1`; the `.app` uses
`bundle-tree-sha256-v1` (root `.`; relative POSIX paths; `lstat` without
following symlinks; directory/file/link types; mode masked with `0777`;
directory empty value, file SHA-256 or symlink target; Unicode code-point path
order; UTF-8 JSON-array lines terminated by newline). The executable may be
identified separately while its bytes reside inside the retained `.app`.
Compute final digests after every byte-mutating packaging, signing or
notarization operation. Changed bytes require new artifact identity/evidence;
RC/Release-bound bytes cannot be replaced in place.

RC evidence immutably binds build and exact executable/`.app`/DMG artifact
objects, source/version and an HDA/Product RC designation reference. An RC ID
cannot be rebound; correction takes a new number. Decision-reference evidence
contains `decisionAuthority: "HDA/Product"`, a stable Management `missions/`
or `plans/` record path, full commit and content digest, and the approved asset
set. A Release decision reference additionally binds the approved RC. Evidence
never replaces the decision. A Release may exist without a tag or GitHub
Release. Tag, hosted-state, publication, deployment and activation observations
have separate lifecycles and objects. The tag event binds the Release decision,
tag decision, tag/ref objects, target commit, operator and readback time. A
GitHub event binds numeric/node ID, draft/published state, tag/target,
created/published/updated and observation times, operator, Release/publication
decision references and each asset's ID, name, size, exposed digest when
available, independently approved digest and artifact object. Publication
needs a separate HDA/Product decision and a published hosted predecessor.
Withdrawal preserves history and prevents treating the Release as current.

## Logical storage and bounded recovery

Schemas/contracts belong in Product documentation and `tools/release/`.
Canonical index entries are proposed under Product Git
`release-evidence/studio-desktop/v<SemVer>/index/`; sealed objects under
`release-evidence/studio-desktop/v<SemVer>/objects/sha256/<prefix>/<digest>.json`.
The adopted logical byte-store ID is `h2o.studio.release-store.v1`, exposed as
`store://h2o.studio.release-store.v1/artifacts/sha256/<digest>/`. Its proposed
workspace-relative primary root is
`products/cockpit-pro/.h2o-studio-release-store/`.
**LIVE_PHYSICAL_STORE=NOT ESTABLISHED BY THIS IMPLEMENTATION.** No absolute
machine path, primary/independent device, copy operator or physical mapping is
approved by Slice A; no tool here resolves or creates the store.

DP01 requires primary plus one physically distinct/off-host independently
readable copy of exact executable/`.app`/DMG bytes and sealed evidence, with
Product/Management recovery bundles and fixity/copy attestation. Separate
Build & Delivery operators make the primary and independent artifact/evidence
copies; Repository produces/verifies only the Git bundle portion. Retain
RC/Release-bound evidence and exact bytes through explicit governed
disposition, with no automatic deletion. Recovery reuses M01 repository
reconstruction, restores bytes from a verified independent copy, rehashes
every object/artifact, rechecks current HDA/Product decisions, and requires
separate authority before republication.

Missing/altered evidence, source or digest mismatch, dirty/non-release build,
artifact substitution, broken predecessor, missing/corrupt independent copy,
withdrawn state, or synthetic data presented as real fails closed. Slice A
allows only disposable synthetic validation. T04 real-build and recovery proof,
physical storage and copy execution remain separately gated.
Copy attestation records claimed source/target locator, host, physical device
and failure-domain identities. Locators, devices and failure domains must each
differ. Source and target **may share one host** when their physical devices
and failure domains differ; different hosts alone do not prove independence.
The T03 validator checks these claims as schema data only. T04 must verify
actual device and failure-domain identity against Filesystem authority before
an independent copy can count for readiness. No current Mac or Intenso device
identifier is a universal schema constant.
