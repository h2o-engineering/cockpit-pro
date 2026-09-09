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
