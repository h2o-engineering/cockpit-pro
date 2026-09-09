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

Selected engine: **DOMPurify 3.4.15**, now vendored byte-verbatim under
`vendor/dompurify/` with `PIN.json` and the elected Apache-2.0 `LICENSE`. See
*Engine admission* below.

## 5. Policy / engine versioning

Policy version and sanitizer-engine version are **distinct and independently
versioned**. A policy change must be explicit and testable on its own, without
an engine bump, and an engine bump must not silently move policy.

Current state: **policyVersion 2**, engine **DOMPurify 3.4.15** (unchanged).

The `.v1` in `sanitizer-policy.v1.js` is the *module-contract* version, matching
`render-ir.v1.js` and `saved-chat-package-v1.tauri.js`; the security policy the
module carries is versioned separately by `POLICY_VERSION`. The two are not
expected to move together.

### policyVersion 2 - pre-wiring URL hardening

Three admission rules were tightened before any wiring. Each narrows what
opaque provider/owner HTML can reach, and none is a behavioural change to
already-admitted content:

- **Schemeless relative URLs fail closed** (`./x`, `../x`, `/x`, `x.html`).
  They would resolve against the application origin, so admitting them would
  hand opaque HTML same-origin navigation capability.
- **Fragment-only URLs fail closed** (`#x`, `#/saved`, `#/read/...`). Studio
  routing is hash-driven, so admitting them would let provider content trigger
  application routing.
- **Image sources are https or constrained raster `data:` only.** `http:` is
  removed from image admission as mixed content and a passive tracking channel.
  Link `href` policy was deliberately *not* narrowed alongside it and still
  admits `http:`.

Retained unchanged: protocol-relative (`//host`) rejection, and rejection of
`h2o:`, `h2oapp:`, `x2y:`, `file:`, `filesystem:`, `chrome:`,
`chrome-extension:`, `tauri:`, `asset:`, `ipc:`, `ws:`, `wss:`, `ftp:` and every
unknown scheme. Rejected URI attributes are removed, never rewritten.

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

## Engine admission (scoped, not global policy)

DOMPurify 3.4.15 has been admitted **for this Renderer sanitizer only**.

Byte-verbatim vendoring was chosen because this Studio source surface has no
bundler: modules are admitted as explicit files and loaded as classic scripts.
Vendoring the exact `dist/purify.js`, pinned by SHA-256, is the form of
admission this surface can actually verify.

**This does not establish a repository-wide dependency policy.** The adjacent
`@supabase/supabase-js` model is a declared npm dependency consumed through a
different bundling mechanism; it is unaffected and is not being displaced.
Neither model is being promoted here to a global canonical governance rule -
this is a derived, surface-specific split, and describing it otherwise would
overstate it.

Ownership for this engine:

- **Renderer** owns selection, use, policy, and security regression evidence.
- **Build & Delivery** owns any later admission of these bytes into produced
  artifacts. Nothing under `vendor/` enters a delivery allowlist at this
  checkpoint.
- **Security-advisory ownership is provisionally Renderer-scoped**, because
  repository-wide advisory ownership is unassigned. That is a gap being covered
  locally, not a claim on the general responsibility.

Integrity is enforced by
`tools/validation/studio/validate-studio-sanitizer-v2-vendor-pin.mjs`: the
pinned SHA-256, the exact `PIN.json` field set, the preserved upstream licence
banner, a single engine copy, and no package dependency. Pinning the SHA of this
vendored third-party artifact is the opposite of the v1 obligation above, which
is behavioral and deliberately not SHA-pinned.

## Performance gate (not satisfied here)

Performance acceptance is **not** part of this unwired foundation, and nothing
in it should be read as clearing v2 for production load.

Whole-transcript synchronous sanitization must not be assumed acceptable. A
bounded spike observed roughly **22-28 ms for ~265 KB in Chromium**, scaling
roughly linearly. Those figures are *evidence from one spike on one machine* -
they are not permanent budgets, and they have not been reviewed as such.

A dedicated performance gate is required **before rich replay switches to v2**.
Defining it, and the budgets it enforces, belongs to that work; no performance
framework is created at this checkpoint. The policy's `maxInputBytes` is a
safety guard against absurd input, not a performance budget.

## Trusted Types

Trusted Types is an architectural seam for later v2/sink work. It is **not
implemented** at this checkpoint: no policy is created, no
`require-trusted-types-for` is added, and no CSP is modified. v2 works correctly
without it.

Hazards proven against 3.4.15, recorded so later work does not rediscover them:

- a caller-owned policy needs both `createHTML` and `createScriptURL`;
- the engine's internal policy creation can fail silently under enforcement and
  return an empty string;
- duplicate engine instances become dangerous under enforcement, which is why
  the adapter captures the UMD singleton instead of constructing a second
  instance via `DOMPurify(window)`;
- fragment output does not require a `TrustedHTML` string sink.

## Known engine behaviours this adapter defends against

Proven against 3.4.15 and enforced by validators, not by code review alone:

- **`setConfig()` is never called.** After `setConfig()`, per-call config is
  silently ignored, which can turn a requested `RETURN_DOM_FRAGMENT` into a
  String result without throwing. The complete frozen policy-derived config is
  passed to `sanitize()` on every call.
- **`ALLOW_UNKNOWN_PROTOCOLS: false` is not the protocol boundary.** The engine
  default retains digit-bearing schemes such as `h2o:`, `h2oapp:` and `x2y:`
  while stripping alphabetic unknown ones. The policy classifier is the source
  of truth for contextual URI decisions; `ALLOWED_URI_REGEXP` is a scheme-aware
  backstop written to stay compatible with ordinary non-URI attribute values
  such as `target`.
- **Rejected URI attributes are removed**, never rewritten to `#`, which would
  falsely present as a real link.
- **Fragments come from a foreign inert document.**
  `fragment.ownerDocument !== document` is valid and safe; modern insertion
  adopts it. The adapter checks the node type and never requires ownership by
  the live document.
