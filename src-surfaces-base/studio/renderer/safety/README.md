# Renderer sanitization boundary — v1/v2 contract

Canonical contract for M03 P1 S1A. This directory holds the Renderer-owned
runtime safety boundary. **No v2 implementation exists yet**: this file records
the contract that the subsequent implementation must obey.

## 1. v1 compatibility surface

`H2O.Studio.html.sanitize`
(`src-surfaces-base/studio/platform/html-sanitizer.js`, version
`0.1.0-phase-c-c3.1`) is the current Storage-compatible v1 surface. It is
unchanged by M03 and stays where it is.

The frozen obligation is **behavioral, not source-byte identity**. Renderer must
not change the projector-observable outputs of:

- `sanitizeHtml`
- `escapeHtml`
- `extractTextFromHtml`

for projector-relevant input, because those bytes feed Saved-Chat
snapshot/projector content and therefore projection `contentHash` and archive
freshness.

Explicitly **not** frozen: the module's physical path as an eternal authority
rule, its internal implementation bytes, `sanitizeUrl`, `isSafeUrl`,
`diagnose()` and its `mode`, and incidental source formatting.

Evidence: `tools/validation/studio/validate-html-sanitizer-v1-compat.mjs` over
`tools/validation/fixtures/studio-renderer-sanitizer/`. That evidence is a
representative corpus, not a proof of exhaustive equivalence.

## 2. v1 purpose

v1 remains available for Saved-Chat projection and package generation. That
persistence role is separate from Renderer runtime security, and the two must
not be conflated: v1 keeps serving Storage after Renderer moves to v2.

## 3. v2 ownership

Renderer owns the new runtime safety boundary. Proposed namespace direction:
`H2O.Studio.Renderer.htmlSanitizer`. No further API detail is claimed here.

## 4. v2 structure

Accepted architecture:

- a DOM-free policy module;
- a thin real-DOM sanitization adapter;
- a pinned mature DOM-aware sanitizer engine.

Current selected implementation candidate: **DOMPurify 3.4.15**. It is not
vendored, installed, or depended on yet; dependency, licence and repository
admission are preflighted in the implementation prompt, not here.

## 5. Policy / engine versioning

Policy version and sanitizer-engine version are **distinct and independently
versioned**. A policy change must be explicit and testable on its own, without
an engine bump, and an engine bump must not silently move policy.

## 6. Owner-sanitized HTML

Saved-Chat `sanitized: true` is an **ingress admission signal**, not a Renderer
DOM trust grant. Renderer v2 re-sanitizes before any live DOM sink unless a
future explicit version-aware trust contract proves equivalence. The M03
semantic ingress layer already treats such content as opaque rather than
trusted.

## 7. Provider HTML

Provider `outerHTML` can only ever be bounded content input. It never regains
transcript / turn / message structural authority.

## 8. Fail closed

If v2 is unavailable or fails, Renderer preserves the canonical safe fallback.
It must never mount unsafe HTML as a degraded path.

## 9. Storage boundary

Renderer v2 must not modify Saved-Chat schema, serializer, package generation,
hashes, freshness semantics, CAS, or durable identity. No Storage semantic
change is authorized by M03.

## 10. Migration

Staged direction, in order:

1. v1 behavioral freeze (this checkpoint);
2. v2 implemented **unwired**;
3. focused security acceptance;
4. narrow Shell/Build/Runtime admission leases;
5. controlled Renderer consumer migration;
6. later semantic HTML ContentRenderer;
7. v1 remains for Storage until Storage separately migrates.

There is no flag day. Storage stays on v1 across every step above; any future
change to shared v1 semantics remains cross-Lane gated with
`L-STORAGE-SAVED-CHATS`.

## Trusted Types

Trusted Types is an architectural seam for later v2/sink work. It is recorded
here as direction only and is not implemented at this checkpoint.
