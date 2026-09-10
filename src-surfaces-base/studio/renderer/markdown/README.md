# Renderer Markdown semantic contract (T4)

Canonical contract for M03 P2 S2A T4. This directory holds the Renderer-owned
Markdown semantics. The contract itself (target, layers, payload conventions,
IR mapping) stays **engine-independent**, so it remains valid across an engine
bump or replacement. S1 admits one engine against that contract:
**markdown-it 15.0.1**, vendored and **unwired** — no delivery carrier, no load
admission and no production consumer.

## Target

**CommonMark 0.31.2**, plus the formal GFM scope:

- tables
- task-list items
- strikethrough
- extended autolink literals
- disallowed raw HTML (tagfilter) observable semantics

**Footnotes are outside T4.** Any further GitHub.com or remark extension is
outside T4 unless separately authorized.

## Acceptance rule

At final S2A acceptance: **formal CommonMark/GFM semantic failures = ZERO**.
A "known divergence" list is not an acceptable substitute for conformance
inside the declared scope. Anything outside the declared scope is out of scope,
not a tolerated gap.

## Source → IR contract

The contract is `Markdown source text → Render IR`, expressed only in Render IR
terms. It names no engine, no token type and no AST node shape, so an engine can
be admitted, replaced or bumped without renegotiating semantics.

Verbatim fallback principle: whatever a construct's semantics turn out to be,
the reader must never lose the author's characters. Text that cannot be given
richer semantics is carried through as literal semantic text rather than
dropped or reinterpreted.

## Semantic architecture — three layers

**Layer 1 — formal base.** CommonMark 0.31.2 plus the declared formal GFM scope
(tables, task-list items, strikethrough, extended autolink literals, raw-HTML /
tagfilter observable policy). This layer is cross-provider and is the contract
every surface shares. Formal-base semantic engine defects are **not accepted**:
the S2A target is zero semantic failures against it.

**Layer 2 — provider profile.** A provider may intentionally select different
behavior, but **only where direct, dated evidence supports it**, and doing so
never redefines the formal base. Example of the architecture rather than a
standing claim: a provider profile could configure single-tilde behavior
differently while the formal base retains formal support. Any provider
observation recorded here is dated evidence about one surface at one time, not a
permanent contract about that vendor's implementation.

**Layer 3 — H2O presentation and security.** S2B owns URL admission, DOM/native
rendering and presentation behavior.
`H2O.Studio.Renderer.sanitizerPolicy.classifyUrl` remains the final URL
admission authority.

## Declared-difference policy

A declared semantic difference may exist in exactly two classes:

- **`DIRECTLY_EVIDENCED_PROVIDER_PROFILE`** — a Layer 2 difference backed by
  direct dated evidence;
- **`EXPLICITLY_OUT_OF_SCOPE_FEATURE`** — a construct outside the declared T4
  scope, such as footnotes.

There is no "engine defect not yet observed" class. A formal-base failure cannot
be excused because a provider corpus has not happened to exercise it, and there
is no numeric divergence budget. Concrete divergence records are added with the
adapter and corpus validator only when real evidence exists — this contract
defines the classification rule, not a gap-management framework.

## Versioning

Render IR keeps `schemaVersion` **1**: T4 adds semantic kinds without changing
the document shape. The IR is transient and unwired, with no independently
versioned producer/consumer boundary, so the module version
(`0.2.0-m03-p2`) alone carries the additive change. There is no separate
vocabulary-version axis, and no version field is emitted into produced IR.

The two added kinds are `thematicBreak` (block separator, no payload) and
`hardBreak` (inline break, no payload, valid only inside an inline `children`
collection).

## Payload conventions

These use existing open payloads; they add no kinds.

| construct | convention |
|---|---|
| `heading` | `level` 1..6 |
| `list` | `ordered`; `start` when meaningful; `tight` |
| `listItem` | `checked` only for a task-list item |
| `table` | alignment array |
| `tableRow` | `header` boolean where the structure needs it |
| `codeBlock` | existing code/text payload; `language` from the first info word; full info string only where useful |
| link | `href`, optional `title` |
| image | `src`, `alt`, optional `title` |
| strikethrough | existing mark kind |

## Raw HTML

S2A **never** converts raw Markdown HTML into trusted DOM or HTML. Raw HTML is
represented as **literal semantic text**. There is no `markdownHtml` opaque kind
and no sanitizer call in S2A. Engine-specific html-node flattening belongs to
the adapter slice after engine selection.

## URL authority

The parser recognizes link and image syntax and the IR carries the
parser-delivered destination string as data. The parser and adapter are **not**
URL security authority, and URL classification is not part of Render IR.

Final URL admission is decided at the S2B sink by
`H2O.Studio.Renderer.sanitizerPolicy.classifyUrl`. No URL recognizer belongs in
S0.

## Slice boundary

- **S2A** — semantics: source → Render IR. No DOM, no sanitizer, no sink.
- **S2B** — the sink that renders IR, where `classifyUrl` is the URL authority.
- **S2C** — sanitized-HTML / `opaqueProviderBlock` controlled fallback.

## Legacy parser freeze

T4 has started, so neither bespoke Markdown implementation may receive new
behavior during the bounded dual-path window:

- Web: the Markdown functions in `renderer/chat-renderer.studio.js`
- Mobile: `apps/studio/mobile/src/renderer/parse.ts`

They keep working unchanged until the adapter replaces them. Semantic edits are
detected by
`tools/validation/studio/validate-studio-markdown-legacy-freeze.mjs`, which pins
per-function digests rather than whole-file hashes so unrelated edits elsewhere
in those files stay possible.

## Engine

Admitted engine: **markdown-it 15.0.1** (GOV Prompt 64 `ADMIT_WITH_CONDITIONS`;
licence/notice reconciled by GOV Prompt 69 `ADMIT_NOTICE_MODEL_WITH_CONDITIONS`).
Nothing in the contract above, the corpus, or the Render IR vocabulary depends on
that choice — the engine is measured against them, not the reverse.

The vendored artifact is the upstream browser bundle
`dist/browser/markdown-it.umd.min.js`, held byte-verbatim under
`vendor/markdown-it/` together with `PIN.json` and `THIRD_PARTY_NOTICES`.
The H2O bounded GFM closure (`h2o-gfm.v1.js`), the shared configuration
(`markdown-engine.v1.js`) and the IR adapter (`markdown-ir-adapter.v1.js`) are
first-party source and deliberately live **outside** the vendor directory.

### Minified upstream artifact exception

This admission carries `ADMIT_WITH_MINIFIED_UPSTREAM_ARTIFACT_EXCEPTION` for
markdown-it 15.0.1 under M03 P2 S2A T4:

- upstream **publishes no non-minified browser UMD** — the minified bundle is
  the only browser artifact shipped in the package;
- the **exact npm tarball and the exact artifact are pinned** in `PIN.json`
  (tarball integrity plus artifact SHA-256);
- vendor bytes are **byte-verbatim and never modified** — not rebuilt,
  re-minified, reformatted, or banner-stripped;
- the **exact upstream source is reviewable**: the pinned tarball ships the
  unminified `lib/` sources for the same version;
- **SPK62 adversarial and resource evidence passed** for the engine plus the
  bounded GFM closure;
- the **H2O GFM extension remains readable first-party source**, so the part of
  the pipeline H2O authors stays reviewable in the ordinary diff.

The exception is **scoped to this admission**. It is not repository-wide policy
and does not pre-admit any other minified vendor artifact.

### Licence classes in the vendored artifact

The browser artifact is **not MIT-only**. It physically incorporates **six**
projects across **two** permissive licence classes:

| project | version | SPDX |
|---|---|---|
| entities | 8.1.0 | BSD-2-Clause |
| linkify-it | 6.1.0 | MIT |
| markdown-it | 15.0.1 | MIT |
| mdurl | 2.1.0 | MIT |
| punycode.js | 2.3.1 | MIT |
| uc.micro | 3.0.0 | MIT |

`PIN.json`'s top-level `license: MIT` is the **markdown-it package licence**.
It must **not** be read as a claim that the complete physical artifact is
MIT-only — `incorporatedProjects` carries each project's actual licence, and
`entities` is BSD-2-Clause.

`argparse` 3.0.1 (PSF-2.0) is a markdown-it package dependency but is **not
incorporated** in the browser artifact (0 mapped sources, 0 byte markers), so it
appears in neither `PIN.json` nor `THIRD_PARTY_NOTICES`. Incorporation was
established by inspecting the artifact itself, never by reading a dependency
list.

### Host `atob` prerequisite

The engine requires a host **`atob`** at load time: the incorporated `entities`
decoder base64-decodes its packed entity trie during module initialisation.

Recorded as a future **Studio classic-script LOAD_ADMISSION prerequisite** — the
vendored UMD throws `atob is not defined` in a host that does not provide it,
so Stage B must admit it against a host that does. Browsers do.

Demonstrated separately: the **npm module path** markdown-it resolves for
Mobile fails the same way without `atob`, so this is a property of the
incorporated decoder rather than of the UMD packaging, and it is not specific to
the artifact Studio vendors. Whether the React Native / Hermes runtime supplies
`atob` is **UNMEASURED** here — no Hermes runtime execution was performed in S1 —
and remains a Stage-B question.

### Notice model

One deterministic `THIRD_PARTY_NOTICES` carries the complete relevant upstream
licence material for exactly those six projects, ASCII-ordered, each entry
recording project, incorporated version, SPDX identifier and verbatim upstream
copyright and licence text taken from that project's **own** pinned package.
There is deliberately **no standalone `LICENSE`** beside it, and no
notice-generation framework. `PIN.json` is **source-only** and is not delivered.
