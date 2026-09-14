# Studio Renderer semantic ingress fixtures

`semantic-ingress-cases.v1.json` holds the surface-neutral conformance cases for
M03 semantic ingress: owner-defined content mapped into the transient Render IR
v1 contract.

```sh
node tools/validation/studio/validate-studio-semantic-ingress-v1.mjs
```

Each case declares a `sourceKind` (`normalizedStudioSnapshot` or
`savedChatSnapshotV3`), the owner `input`, and an `expect` block. For accepted
inputs `expect` is the full conformance projection of the produced conversation:
per message the canonical `role`, resolved `dir`, owner reference, and the
ordered blocks with their semantic payload. For refused inputs `expect` carries
`ok: false` and an `errorMatch` substring, which is how fail-closed behaviour
(unknown role, unsanitized HTML, v3 legacy scalar bodies, wrong schema version)
is pinned.

Render keys are deliberately absent from every expectation. They are
projection-local and transient, so they are never part of the cross-surface
contract; a Mobile implementation is expected to derive its own. Everything the
expectations do assert is plain JSON, so the same file can drive Web/Studio and
Mobile conformance without a shared harness.

The Saved-Chat v3 inputs mirror Storage-owned semantics only. This directory
does not define the v3 package schema, serialization, hashes, or asset identity.
