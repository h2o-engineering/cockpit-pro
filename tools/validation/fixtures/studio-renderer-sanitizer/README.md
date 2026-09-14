# Studio Renderer sanitizer v1 compatibility fixtures

`v1-compatibility-cases.json` pins the projector-observable output bytes of the
shared interim sanitizer `H2O.Studio.html.sanitize`
(`src-surfaces-base/studio/platform/html-sanitizer.js`) for M03 P1 S1A.

```sh
node tools/validation/studio/validate-html-sanitizer-v1-compat.mjs
```

Every `expect` value was captured verbatim from the current v1 implementation at
`capturedFromVersion`. They are recordings, not judgements: they are not
hand-written, not "improved", and a case whose output looks surprising is
pinning real current behavior on purpose. Regenerate them only as part of a
governed, cross-Lane-agreed change to v1 semantics.

Only three functions are covered, because only these three feed Saved-Chat
snapshot/projector content and therefore projection `contentHash` and archive
freshness:

- `sanitizeHtml`
- `escapeHtml`
- `extractTextFromHtml`

`sanitizeUrl`, `isSafeUrl` and `diagnose()` are deliberately outside the frozen
surface, as is the SHA of the module and its physical path.

## Scope limitation

This corpus is compatibility **evidence** over representative projector-relevant
inputs — plain text, safe and nested markup, dangerous elements, event
attributes, `javascript:`/`vbscript:`/`data:text/html` URIs, entities, malformed
markup, text-extraction shapes, and empty input. It is not a proof of exhaustive
equivalence for every possible input string. A v2 engine passing this corpus has
demonstrated compatibility on these cases only.

The separate `tools/validation/studio/validate-html-sanitizer.mjs` covers the
security/property behavior of the interim v1 and is not replaced by this corpus.

## `sanitizer-cases.v1.json` - Renderer sanitizer v2 evidence

A separate corpus for the Renderer-owned v2 boundary. It does not duplicate the
v1 file and is not interchangeable with it: v1 pins exact projector output
bytes, while v2 pins security properties.

```sh
node tools/validation/studio/validate-studio-sanitizer-v2-policy.mjs
node tools/validation/studio/validate-studio-sanitizer-v2-vendor-pin.mjs
node tools/validation/studio/validate-studio-sanitizer-v2-dom.mjs
```

`cases[]` carry `mustContain` / `mustNotContain` substring expectations plus an
idempotence flag. Substrings are deliberate: exact serialization is a
browser/engine detail, whereas what survives and what must be gone is the
contract, and the same file can therefore drive more than one engine or browser.
`urlCases[]` carry the contextual URI verdicts, including the digit-bearing
custom schemes (`h2o:`, `h2oapp:`, `x2y:`) that an engine default has been
observed to retain.

Tier 1 (`-policy`, `-vendor-pin`) runs with no DOM and proves policy decisions,
API shape, fail-closed behavior and vendor integrity. Tier 2 (`-dom`) is the
real-browser oracle and is the only tier that can prove parser-dependent
properties: mutation-XSS, namespace confusion, DOM clobbering, fragment identity
and actual non-execution. Tier 2 reports `SKIP` - never `PASS` - when Playwright
is unavailable, and never causes Tier 1 to fail. Point it at an install with
`H2O_PLAYWRIGHT_MODULE`; Playwright is not a repository dependency.
