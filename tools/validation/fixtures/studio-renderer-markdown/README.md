# Renderer Markdown conformance corpus (T4)

`markdown-conformance.v1.json` is the engine-agnostic corpus for M03 P2 S2A T4.
It freezes *semantics* — `Markdown source → Render IR` — before any engine is
admitted, so the same file can measure whichever engine is eventually selected.

```sh
node tools/validation/studio/validate-studio-markdown-legacy-freeze.mjs
```

Each case carries an `id`, a `category`, a one-line `requirement`, the Markdown
`source`, and `expect.blocks`: a Render IR projection of kinds and salient
payload. Projections deliberately omit render keys (projection-local and
transient) and contain no engine token or AST forms — the validator asserts
that, so the corpus cannot acquire an engine dependency by accident.

| category | meaning |
|---|---|
| `FORMAL_COMMONMARK` | CommonMark 0.31.2 semantics |
| `FORMAL_GFM` | the declared formal GFM scope |
| `H2O_POLICY` | H2O decisions: raw HTML literal, URL authority, verbatim fallback |
| `CURRENT_BEHAVIOR_MIGRATION` | where today's bespoke parsers diverge from T4 |

`CURRENT_BEHAVIOR_MIGRATION` cases are the interesting ones: their `expect` is
the **T4 target**, not current behavior, and each `note` records the divergence
the adapter must close — h4-h6 headings, single-tilde strikethrough, bare
autolink literals, and hard breaks.

This corpus is representative, not exhaustive. It fixes the format and the
decisions that shape the adapter; expanding to the full formal example set
belongs to the engine adapter slice, and adding cases must not require changing
the format.

Scope reminders encoded in the file itself: CommonMark `0.31.2`, `gfmScope`
(tables, task-list items, strikethrough, extended autolink literals, tagfilter
observable semantics), and `outOfScope` (footnotes, GitHub alerts, mermaid, math
extensions, other extensions). Footnotes are outside T4, so no footnote kind
exists in the Render IR kind set.
