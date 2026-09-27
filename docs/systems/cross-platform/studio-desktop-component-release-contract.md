# Studio desktop component and release contract

Status: DP02 adopted; T05 non-public foundation. Component release, tag creation,
GitHub Release creation (including drafts), asset upload, deployment, and
activation each require later explicit authority. This document makes none of
those transitions.

<!-- T05-CONTRACT-FACTS-START -->
COMPONENT_ID=studio-desktop
DISPLAY_NAME=H2O Studio Desktop
NPM_ID=@h2o/studio-desktop
RUST_ID=h2o-studio-desktop
TAURI_ID=org.h2o.studio.desktop
VERSION_SOURCE=apps/studio/desktop/package.json#version
VERSION_SCHEME=SemVer
VERSION_SYNC_RULE=exact-equality-before-rc
COMPONENT_VERSION_FORMAT=studio-desktop@<SemVer>
RC_FORMAT=studio-desktop/v<SemVer>/rc.<positive-decimal-integer>
RELEASE_ID_FORMAT=studio-desktop/v<SemVer>
RELEASE_TAG_FORMAT=component/studio-desktop/v<SemVer>
RC_TAG=NONE
APP_DIGEST_METHOD=bundle-tree-sha256-v1
DMG_DIGEST_METHOD=sha256-file-v1
GITHUB_RELEASE_IS_AUTHORITY=NO
RELEASE_DECISION_AUTHORITY=HDA / Product
PUBLICATION_DECISION_AUTHORITY=HDA / Product
TAG_MECHANICS_OWNER=L-H2OCODE-REPOSITORY
GITHUB_RELEASE_MECHANICS_OWNER=L-H2OCODE-REPOSITORY
BUILD_DELIVERY_OWNER=L-DEVELOPER-BUILD-DELIVERY-SCOPE-STU
<!-- T05-CONTRACT-FACTS-END -->

## Component and version

The H2O release-semantic component ID is studio-desktop. H2O Studio Desktop is
its display name. The npm @h2o/studio-desktop, Rust h2o-studio-desktop, and Tauri
org.h2o.studio.desktop identifiers retain their native ecosystem roles. Their
names are not changed by this contract.

The authoritative version is apps/studio/desktop/package.json#version. Its
exact SemVer value is mirrored in src-tauri/tauri.conf.json#version and
src-tauri/Cargo.toml#package.version. The Desktop entry in package-lock.json and
the h2o-studio-desktop entry in src-tauri/Cargo.lock must also agree when those
generated representations apply. Exact equality is required before RC
eligibility. The current value is 0.1.0; this foundation does not change it.
An RC number does not automatically add a SemVer prerelease suffix. HDA/Product
decides any release-bearing version, including a prerelease version.

## Identity chain and binding

Product commit -> component version -> governed build -> digested artifact ->
immutable numbered RC -> HDA/Product Release -> optional deployment -> optional
activation/promotion. Each arrow requires its own fact or decision; it is not an
automatic state transition.

A source commit is a full 40-character Product Git SHA. A component version is
studio-desktop@<SemVer>. A governed build is one invocation of the existing
Desktop wrapper and has this logical key:

    studio-desktop/v<V>/build/<CHECKPOINT>/<SOURCE_SHA>/<BUILT_AT_UTC>/<OS>-<ARCH>/governed

It binds the component ID, exact synchronized version, source commit, governed
checkpoint, UTC build timestamp, OS/platform, architecture, release build
profile, governed state, and source clean/dirty state. The existing wrapper
stamps checkpoint, source commit, and time; build.rs verifies exact Git HEAD,
stamps profile and dirty state, and passes the governed stamp into Rust. The
runtime identity exposes app version, architecture, and governed state. This
source inspection does not attest any particular completed build. An actual RC
requires a release-profile, governed build from clean source.

An artifact key is the build key followed by
/artifact/<app|dmg>/sha256:<digest>. The current macOS artifact family contains
H2O Studio.app and a DMG. They have distinct keys and distinct digests even when
the DMG contains that app. Each artifact binds build key, kind, original path
or filename, content digest and method, source commit, component version,
platform, and architecture. A changed artifact receives a new digest and key.
RC- or Release-bound bytes cannot be replaced in place.

The DMG builder currently prints a SHA-256 of its final file. There is no
existing frozen .app bundle-tree digest. Before an .app enters an RC, compute
bundle-tree-sha256-v1 over its directory, or adopt a separately approved
deterministic digest method. For v1, recursively visit the root and descendants
in relative-path code-point order without following symlinks. Hash UTF-8 lines,
each the JSON array [relative POSIX path, type, mode masked to 0777, value].
Type is d for directory, f for regular file, or l for symlink. Value is empty
for a directory, SHA-256 hex of file bytes for a file, or the symlink target
string for a symlink. Include the root as ".". Other file types fail closed.
The digest is SHA-256 of those lines. The optional validator RC mode implements
this read-only calculation; no build or asset publication is performed.

## RC, Release, tag, and GitHub mapping

RC IDs use studio-desktop/v<SemVer>/rc.<positive-decimal-integer>, starting at
1 without leading zero. Studio Build & Delivery assembles the exact build and
artifact set; HDA/Product decides RC designation. The binding is immutable.
Reverification is allowed, but correction or rejection requires a new RC
number. Historical internal uses of "RC" do not become this contract's RCs.

The H2O Release ID is studio-desktop/v<SemVer>. HDA/Product approves the exact
RC, version, source commit, and artifacts; a candidate can remain unreleased.
The Release can exist without a GitHub Release or deployment. One Release tag,
component/studio-desktop/v<SemVer>, may point to the approved source commit
after separate authorization. There is no RC tag. Tag metadata should reference
the Release decision and frozen artifact manifest. Never retarget, rewrite,
or reuse a tag to correct a mistake; quarantine it from publication and seek
an explicit HDA/Product correction decision. Historical Product tags keep their
existing meanings.

A GitHub Release is hosted presentation and distribution of an already-approved
H2O Release. It is not H2O release authority. A future draft is unpublished
preparation, not approval; even creating a draft requires separate exact
authorization. Publication requires an approved H2O Release, matching immutable
tag and source commit, verified frozen assets, approved notes and asset set,
and an exact HDA/Product publication decision. The DMG is the current macOS
distribution asset. The .app is separately tracked as a build artifact;
publishing it separately requires approved packaging and digest identity.
Withdrawal or correction is recorded by HDA/Product and reflected by Repository
without silently replacing approved bytes or moving the tag.

Studio Build & Delivery owns component, version, build, artifact, RC, and
software delivery semantics. HDA/Product owns release-bearing version decisions,
RC designation, the H2O Release decision, and publication decisions.
L-H2OCODE-REPOSITORY owns Git tag and GitHub Release mechanics. It does not
decide whether H2O has released a component.

Deployment means technical installation of an exact artifact at a destination.
Activation/promotion means making an installed Desktop build current there.
A Release implies neither deployment nor activation; deployment does not imply
activation. M02 establishes no fleet registry or deployment ID format. This
software-delivery meaning is separate from Studio runtime admission and
saved-chat data activation.

## Read-only validation and operator boundary

Run the source validator directly:

    node tools/validation/release/validate-studio-desktop-component-release-contract.mjs

For a future exact RC input, pass --rc-manifest PATH. The input must use schema
h2o.studio.desktop-rc.v1 and bind componentVersionId, rcId, version, full
sourceCommit, build key/checkpoint/builtAt/os/architecture/profile/governed/
sourceDirty, and at least one artifact with kind/path/key/digest/digestMethod/
sourceCommit/version/os/architecture. The validator recomputes actual file or
bundle digests and fails closed on mismatch. An absent RC input is not a failed
RC. RC manifest validation checks claims and bytes; it cannot by itself attest
that the built binary embeds the claimed identity. That readback and the build
checkpoint evidence remain separate RC designation prerequisites. The validator
never creates a tag, GitHub draft or published Release,
uploads an asset, deploys, or activates.

A future publication operator must read back an exact HDA/Product Release and
publication decision, the authorized tag/commit, the frozen artifact manifest
and actual digests before any hosted operation. This T05 foundation stops
before that operation.

The existing versions.csv, userscript release/version commands and
scriptId-version tags, version dashboard, stage-only publisher receipts, and
historical Product tags coexist. The stage-only Studio Launcher/Dev Controls
publisher is a different generated-delivery surface and does not create a
Studio desktop Release. M05 must decide any future freeze or retirement; T05
does neither.
