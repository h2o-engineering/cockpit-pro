# Studio Edit Overlay Contract

Status: Active (Phase 5d-A)
Audience: Anyone implementing or reviewing edit-overlay code in
`src-surfaces-base/studio/overlay/` or `src-surfaces-base/studio/store/editOverlay.js`.
Companion: `STUDIO_STORAGE_CONTRACT.md`, `STUDIO_DEVELOPMENT_RULES.md`,
`STUDIO_PORTABILITY_CONTRACT.md`.

## Purpose

The Studio Ribbon's Phase 2 format and structure actions (heading, quote,
code block, callout, clean spacing, sections, dividers, TOC) need a place
to live. They cannot be embedded in `snap.messages[].text` because they
are *markup* transformations, not text-content edits. They also cannot
mutate the captured snapshot because saved snapshots must remain
re-exportable and bit-identical to what was captured.

This contract defines the **non-destructive overlay model** that holds
those operations.

## Authoring edit-override compatibility boundary

`overlay/edit-override-compat.studio.js` owns the page-lifetime projection
used by the synchronous Reader/Renderer `getEditOverride` hook. Its public
namespace is `H2O.Studio.authoring.editOverrideCompat` (schema
`h2o.studio.authoring-edit-override-compat`, version `1.0.0`). The API is
`configure({ getCurrentSnapshotId, applyOverlayOp })`,
`updateFromOverlay(snapshotId, overlay)`, `hydrate(snapshotId)`,
`get(snapshotId, turnIdx)`, `set(snapshotId, turnIdx, text)`, and
`removeSnapshot(snapshotId)`.

`get` and `set` return synchronously. `hydrate` and `removeSnapshot` return
Promises. The module projects active `text-replace` state through
`H2O.Studio.overlay.computeMessageState`; it hydrates and removes records only
through `H2O.Studio.store.editOverlay`. A `set` dispatches the existing
`text-replace` operation through its configured Authoring/Ribbon collaborator.
`updateFromOverlay` changes only the in-memory projection. The edit-overlay
Store remains the sole persistence authority, and captured snapshots remain
immutable.

## Hard invariants (Phase 2 and forever)

These rules are immutable for the lifetime of the overlay subsystem.
Violating any of them is a P0 bug regardless of which phase the code is
written in.

### Invariant 1 — Never mutate the original saved snapshot

The overlay applier, the overlay store, and any feature code that
interacts with overlays MUST NOT write to:

- `state.currentReaderSnapshot.messages` (in-memory)
- the captured snapshot file on disk (via `callArchive("captureSnapshot")`
  or any other channel)
- `snap.meta` fields that describe the captured turns

The overlay is applied as a render-time transformation pass over a
**read-only** view of the snapshot. If a feature genuinely needs to
change the captured text, it belongs in the legacy per-turn text-edit
flow (`persistEditToExtensionSnapshot`), not in the overlay subsystem.

### Invariant 2 — Overlays are additive, not destructive

`overlay.ops[]` is append-only history. Operations are never deleted,
even on undo. Each forward operation captures its full payload (and may
optionally carry an `inverse` payload as forward-compat metadata, used
by debugging tools but no longer required for undo correctness — see
"Phase 2d — undo / redo model" below).

Undo / redo work via the **reducer-filter active-set model** described
below: undo moves an op id from `undoStack` to `redoStack`; the reducer
simply stops applying that op. No information is lost.

### Invariant 3 — `turnIdx` is stable only within one saved snapshot

`turnIdx` (1-based ordinal across all turns) is the canonical anchor
because it is present on every turn regardless of `messageId` /
`turnId` presence. Operations target turns via `turnIdx` and treat
`messageId` / `turnId` as **best-effort hints** for cross-snapshot
rebase later (Phase 2e+). A `turnIdx` value from one snapshot must
NEVER be reused as a stable anchor across re-captures of the same chat.

### Invariant 4 — `baseDigest` is required and used for drift detection

Every `EditOverlay` record carries a `baseDigest` string computed via
`H2O.Studio.overlay.computeBaseDigest(snapshot.messages)`. At apply
time, the applier MUST recompute the digest from the current snapshot
and MUST refuse to apply when the digests differ. Drift detection is
the only safety mechanism against silently misaligning markup with the
wrong turns after a re-capture.

### Invariant 5 — Overlay rendering must no-op on drift

When drift is detected, `applyOverlay` returns
`{ applied: false, driftDetected: true, mutated: false, ... }` and the
reader renders exactly as it would without any overlay. A future phase
will add a rebase or invalidate UI; Phase 2a only emits
`evt:h2o:studio:overlay:drift-detected` and bails.

### Invariant 6 — Overlay ops are message-level only in Phase 2

Phase 2 op targets are limited to:

- `message` — a single turn identified by `turnIdx` (+ optional `messageId`)
- `section` — an overlay-minted span of turns
- `between-turns` — an insertion point between two turns
- `snapshot` — the entire snapshot (TOC position only)

**Selection-level editing (operating on a text range inside a message)
is explicitly out of scope for Phase 2** and is deferred to a later
phase. The Phase 2 ribbon defaults to message-level selection (clicking
a message in the reader selects it for the next action).

### Invariant 7 — Storage stays Studio-local

Overlay records live under the `h2o:studio:edit-overlay:` key prefix
exclusively. The prefs store's `isStudioKey` check enforces this. The
overlay subsystem MUST NOT write to:

- native engine keys (`h2o:prm:cgx:*`)
- session storage
- IndexedDB directly
- `chrome.*` APIs
- `localStorage` directly
- the file system via any path other than `H2O.Studio.platform.files` (deferred)

All writes route through `H2O.Studio.platform.storage`.

### Invariant 8 — Schema is versioned and migrations are explicit

Every record carries `schemaVersion: number`. The current version is
**1** (Phase 2a). A version bump requires:

1. A migration function that converts v(N-1) → v(N).
2. Documentation in this contract describing what changed.
3. A regression smoke confirming v(N-1) records round-trip cleanly after migration.

Phase 2a freezes v1 as: `{ id, schemaVersion, snapshotId, chatId,
baseDigest, createdAt, updatedAt, ops, undoStack, redoStack }`.

### Invariant 9 — No feature code touches `chrome.*`, `localStorage`, `indexedDB`, or `fetch`

The same rules as `STUDIO_DEVELOPMENT_RULES.md` apply to overlay code.
Feature files outside `studio/platform/` MUST go through
`H2O.Studio.platform.*` and `H2O.Studio.store.*`.

### Invariant 10 — Never throws

Both `applyOverlay` and the store's public methods catch all internal
errors and either return a benign outcome record (applier) or reject
the returned Promise with a real error (store). Synchronous throws from
feature code are forbidden — they would crash the reader render path.

## Allowed patterns (Phase 2a)

Overlay code may freely use:

- DOM read APIs on `studio.html`'s own document (`document.querySelector`,
  `getElementById`, etc.) — but **never** write to elements that belong
  to `snap.messages` content. The applier is allowed to insert *new*
  wrappers/elements, never modify existing ones.
- `H2O.events.emit` for `evt:h2o:studio:overlay:*` notifications.
- `H2O.Studio.platform.storage.{get,set,remove}` via the editOverlay store.
- `H2O.Studio.store.editOverlay.*`.
- `H2O.Studio.OverlayKeys` / `OverlayEvents` / `OverlayOpTypes` / `OverlayTargets`
  constants.
- Plain JS data manipulation, `Object.assign`, `Array.isArray`,
  `JSON.stringify`/`parse`, `Date.now`, `Promise`.

## Forbidden patterns

Forbidden anywhere in `studio/overlay/` and `studio/store/editOverlay.js`:

- `chrome.*`
- `localStorage`, `sessionStorage`, `indexedDB`, `idb-keyval`, `idb`
- Direct mutation of `snap.messages` or any array reachable from it.
- Direct mutation of DOM elements that belong to captured turn content.
- `MutationObserver` against non-`studio.html` documents.
- New global notification or toast surfaces.
- Imports from `src-surfaces-base/desk/` or content-script modules.
- Storage keys outside the `h2o:studio:` prefix.

## Phase 2a scope (what is and is not built)

### Is built

- `H2O.Studio.OverlayKeys`, `OverlayEvents`, `OverlayOpTypes`,
  `OverlayTargets` (frozen constants)
- `H2O.Studio.overlay.applyOverlay` (passive no-op + drift check)
- `H2O.Studio.overlay.computeBaseDigest`
- `H2O.Studio.overlay.createEmpty`
- `H2O.Studio.overlay.selfCheck`
- `H2O.Studio.store.editOverlay` (get/upsert/remove/list/subscribe/selfCheck)
- `H2O.Studio.RibbonBridge.getOverlay(snapshotId)` accessor
- One call from `studio.js`'s `buildReaderDOM` tail into the no-op applier
- Documentation (this file + `overlay/README.md`)

### Is NOT built

- Any operation that writes to DOM under input (the applier is a no-op
  in Phase 2a)
- Any ribbon action wiring beyond the existing Phase 1 actions
- Undo / redo handlers
- Copy / export integration with overlay
- Section grouping CSS
- Cross-context sync
- Rebase UI for drift

## Phase 2d — undo / redo model

Status: **Built**. Implemented across `overlay-applier.studio.js` (pure
helpers + reducer changes), `studio.js` (`RibbonBridge.undo/redo/getHistoryState`),
`ribbon/ribbon-shell.studio.js` (`undoCount`/`redoCount` context fields),
and `S0Y1a. 🎬 Studio Ribbon - Studio.js` (Home → Undo / Redo).

### The reducer-filter active-set model

1. **`overlay.ops` is append-only.** Forward operations are pushed onto
   `ops` by `appendOp` and never removed. Re-running `appendOp` for a
   later forward op grows `ops` monotonically.
2. **`overlay.undoStack` is the ordered active op-id set.** It contains
   the ids of ops that are currently visible. `appendOp` pushes the new
   op's id onto `undoStack` (and clears `redoStack`); `popUndo` pops the
   top id and pushes it onto `redoStack`; `popRedo` does the reverse.
3. **`overlay.redoStack` holds undone op ids.** Each id still references
   an op present in `overlay.ops`, so redo is a pure stack manipulation
   followed by a re-render — no replay, no inverse.
4. **Reducers iterate `overlay.ops` in original order**, but skip any op
   whose id is NOT in the active set. This preserves the "last op of a
   given (type, target) wins" semantics that existed before Phase 2d.

The active set is computed by `getActiveOpIdSet(overlay)`. Renderers
short-circuit ops outside the set via `isOpActive(active, op.id)` in
both `computeMessageState` and `computeStructureState`.

### Required migration rule (active-set legacy behaviour)

Existing overlays persisted before Phase 2d may have `undoStack` either
absent or shaped differently. The renderer MUST honour exactly this
rule:

- **`undoStack` is missing OR is not an array** → treat **all ops as
  active**. This is the legacy migration sentinel and preserves visual
  continuity for any persisted overlay from Phase 2a/2b/2c.
- **`undoStack` exists as an array** → respect it **exactly**, even when
  empty. An empty `undoStack` means "undo everything" — the user
  legitimately undid every op — and the renderer MUST display no ops in
  that case. Do NOT treat empty as all-active when `redoStack` exists.

`getActiveOpIdSet` returns `null` for the legacy all-active case and a
`{ [opId]: true }` lookup object for the explicit case. `isOpActive`
treats a `null` active set as "everything matches".

### Bridge API

`H2O.Studio.RibbonBridge` (declared in `studio.js`) exposes:

| Method | Returns | Behaviour |
|---|---|---|
| `undo()` | `Promise<{ ok, reason?, overlay?, outcome?, undoCount?, redoCount?, label? }>` | Pops `undoStack` top onto `redoStack`, persists, re-renders, republishes counts. Refuses safely on drift / no-undo / no-overlay / no-snapshot. |
| `redo()` | same shape | Mirror of undo: pops `redoStack` top, pushes onto `undoStack`. |
| `getHistoryState()` | `Promise<{ undoCount, redoCount, lastUndoLabel?, lastRedoLabel? }>` | Pure-read accessor. Empty stacks → `0` / `0` with no label fields. |

All three never throw. Drift detection uses the same `computeBaseDigest`
check as `applyOverlayOp`; on drift the stacks are not mutated.

### Ribbon context fields

`H2O.Studio.ribbon`'s context gains `undoCount: number` and `redoCount:
number`. Both are coerced to non-negative integers (Number.NaN /
negative / undefined → `0`). They are republished by `studio.js` after:

- initial overlay load in `buildReaderDOM`
- `RibbonBridge.applyOverlayOp` (forward ops)
- `RibbonBridge.undo`
- `RibbonBridge.redo`

The shell's `setContext` includes both fields in its equality short-
circuit so paints only fire on real changes.

### Compliance notes for Phase 2d

- `overlay.ops` MUST NOT be mutated by undo or redo.
- Renderers MUST use `getActiveOpIdSet` + `isOpActive` (or equivalent
  filter) — they MUST NOT iterate `overlay.undoStack` to compute state,
  because doing so would lose the ops original ordering needed for
  last-wins semantics.
- Drift behaviour during undo / redo MUST match `applyOverlayOp` — same
  digest check, same refusal shape, same `evt:h2o:studio:overlay:drift-
  detected` semantics for downstream consumers.
- Status feedback strings exposed at the Home tab MUST exactly match:
  `"Undoing…"`, `"Undone: <label>"`, `"Nothing to undo"`, `"Redoing…"`,
  `"Redone: <label>"`, `"Nothing to redo"`,
  `"Snapshot has changed — overlay disabled until rebase"`.

### Out of scope for Phase 2d

- Keyboard shortcuts (Cmd-Z / Cmd-Shift-Z) — deferred to a future
  phase; would require touching the Studio keyboard router.
- Op coalescing / time-window batching — each ribbon click remains one
  undo step in V1.
- History compaction (dropping ops referenced by neither stack) —
  deferred; `overlay.ops` may grow unboundedly within a single editing
  session and that is accepted for V1.

## Phase 2e — overlay-aware Copy clean transcript

Status: **Built**. Implemented across
`overlay/overlay-serializer.studio.js` (new pure serializer module),
`studio.js` (`RibbonBridge.getCleanTranscript` evolved to async
object-returning shape), `studio.html` (one new script tag), and
`S0Y1a. 🎬 Studio Ribbon - Studio.js` (`copy-clean-transcript` handler
awaits the new shape).

### The serializer

`H2O.Studio.overlaySerializer.serialize(snap, overlay, opts)` is a pure
function: no DOM access, no storage access, no I/O. It produces a
Markdown-flavoured transcript using the existing Phase 2d-aware
reducers (`computeMessageState` + `computeStructureState`), so it
automatically honours `undoStack` membership. It never mutates `snap`
or `overlay`.

Options:

- `includeOverlay` (default `true`) — when `false`, returns text
  byte-identical to Phase 1b's raw format
  (`User:\n<text>\n\nA:\n<text>\n\nSystem:\n<text>`).
- `includeToc` (default `false`) — when `true` and at least one
  section exists, emits `## Contents\n- <title>\n...` at the top.
- `collapsedMode` (default `'include-marked'`) — controls collapsed-
  section output:
  - `'include-marked'`: include turns, append `[collapsed — N turns]`
    suffix to the section header.
  - `'include-silent'`: include turns, no marker.
  - `'omit'`: skip turns of collapsed sections, append
    `[collapsed — N turns hidden]` to the header.

Return shape: `{ text, opsApplied, structureApplied, tocIncluded,
collapsedSections, reason? }`. `opsApplied` counts per-message ops
that produced visible output; `structureApplied` is `true` when any
section header / page divider / TOC was emitted.

### Output mappings (Markdown-flavoured)

| Op | Output |
|---|---|
| `heading` H1 | `# <Role>:\n<body>` |
| `heading` H2 | `## <Role>:\n<body>` |
| `heading` H3 | `### <Role>:\n<body>` |
| `quote` | `<Role>:\n> <body line 1>\n> <body line 2>` (role outside quote, body lines prefixed) |
| `code` / `code-block` | `<Role>:\n` ` ```\n<body>\n``` ` (role outside fence) |
| `callout` (info/note/warning/tip) | `> [!info]\n> <Role>:\n> <body>` (role + body inside callout) |
| `clean-spacing` | text pass on body: 3+ consecutive `\n` collapse to 2 |
| `add-section` / `split-section` | `## <Section title>` inserted between turns |
| `page-divider` | `---` inserted between turns |
| `collapse-section` (default `include-marked`) | section header gets ` [collapsed — N turns]` suffix; turns still emitted |
| `toc` | omitted unless `includeToc: true` — then `## Contents\n- <title>\n...` at top |

Op stacking on a single message (outer → inner):
`callout > heading > code > quote > clean-spacing`. When both `code`
and `quote` are active on the same turn, `code` wins (more specific).
Inside a callout, the heading still decorates the role line that lives
inside the callout body.

### Bridge shape

`H2O.Studio.RibbonBridge.getCleanTranscript(opts?)` — async, returns
`Promise<{ text, overlayIncluded, overlaySkipped, reason? }>`:

| Field | Type | Meaning |
|---|---|---|
| `text` | string | The transcript. `''` on missing snapshot / empty messages. |
| `overlayIncluded` | boolean | True iff overlay decorations actually landed in the output (`opsApplied > 0 \|\| structureApplied \|\| tocIncluded`). |
| `overlaySkipped` | boolean | True iff `includeOverlay` was requested but the overlay path was bypassed for a safe fallback reason. |
| `reason` | string? | When `overlaySkipped`, one of: `'drift-detected'`, `'serializer-unavailable'`, `'store-unavailable'`, `'reducer-unavailable'`, `'serializer-error'`. |

Cases:

- Missing snapshot / empty `messages` → `{ text: '', overlayIncluded:
  false, overlaySkipped: false }`.
- `includeOverlay: false` → raw text, `overlayIncluded: false`,
  `overlaySkipped: false`.
- `includeOverlay: true` and no overlay record exists → raw text,
  `overlayIncluded: false`, `overlaySkipped: false` (nothing to skip).
- `includeOverlay: true`, overlay present, drift detected → raw text,
  `overlayIncluded: false`, `overlaySkipped: true`,
  `reason: 'drift-detected'`. The drift check uses the same
  `computeBaseDigest` precedent as `applyOverlayOp` / `undo` / `redo`.
- `includeOverlay: true`, overlay present, no drift → overlay-aware
  text, `overlayIncluded` reflects whether any decoration landed.

The bridge **never throws** — every internal branch catches; on
unreachable failures it resolves with the empty floor shape.

### Ribbon status feedback (Export → Copy → Copy clean transcript)

- `"Copying transcript…"` — pending.
- `"Transcript copied"` — success (overlay applied OR no overlay needed).
- `"Transcript copied (overlay skipped — snapshot changed)"` — drift
  fallback. Text on the clipboard is raw.
- `"No transcript content"` — empty snapshot.
- `"Transcript bridge unavailable"` — bridge method missing.
- `"Copy failed: <msg>"` — clipboard write failed.

### Compliance notes for Phase 2e

- The serializer MUST NOT touch `snap.messages` or any overlay field.
- The serializer MUST NOT read or write any storage; the bridge is
  responsible for fetching the overlay record.
- The serializer MUST NOT access the DOM.
- `includeOverlay: false` output MUST remain byte-identical to Phase
  1b's raw format (regression guard for any external consumer that
  pinned to that shape).
- The bridge MUST NOT throw under any input; on drift or any safe
  fallback it MUST return well-formed `{ text, overlayIncluded:false,
  overlaySkipped:true, reason }`.
- Status string `"Transcript copied (overlay skipped — snapshot changed)"`
  is the canonical surface for drift; do not paraphrase.

### Out of scope for Phase 2e

- Markdown file export (download as `.md`).
- PDF / DOCX export.
- AI-tools integration with the serializer output.
- "Copy raw" as a separate ribbon button — the option exists on the
  serializer + bridge as `{ includeOverlay: false }`; the catalogue
  slot can be added later without a contract change.
- "Copy visible only" as a separate ribbon button — the option exists
  on the serializer as `{ collapsedMode: 'omit' }`; no UI in V1.

## Phase 3a — Markdown export

Status: **Built**. Implemented across `platform/platform.mv3.js`
(`files.exportBlob` real implementation), `platform/platform.tauri.js`
(`files.exportBlob` native-first + Blob+anchor fallback),
`studio.js` (`RibbonBridge.exportMarkdown` + filename sanitizer +
header builder), and `S0Y1a. 🎬 Studio Ribbon - Studio.js`
(`Export → Markdown` handler).

### Bridge shape

`H2O.Studio.RibbonBridge.exportMarkdown(opts?)` — async, returns
`Promise<{ ok, reason?, filename?, bytes?, path?, overlayIncluded?,
overlaySkipped?, overlayReason?, fallback? }>`:

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | true when the file landed (either via native save or Blob+anchor fallback). |
| `reason` | string? | When `ok:false`, one of: `'no-snapshot'`, `'no-content'`, `'cancelled'` (user dismissed Tauri save dialog), `'export-failed'`, `'error'`. |
| `filename` | string | The suggested filename (`{stem}__{YYYY-MM-DD}.md`). |
| `bytes` | number | Size of the file written. |
| `path` | string? | Tauri-native save path when `plugin:fs|write_text_file` was used. |
| `overlayIncluded` | boolean | Pass-through from `getCleanTranscript`. |
| `overlaySkipped` | boolean | Pass-through (drift fallback triggered). |
| `overlayReason` | string? | Pass-through reason from `getCleanTranscript`. |
| `fallback` | string? | `'blob-anchor'` when the inline Blob+`<a download>` fallback was used (either because `platform.files.available` was false, or because the Tauri native save path fell back). |

Options:

- `includeOverlay` (default `true`) — pass-through to serializer.
- `includeToc` (default `false`) — pass-through.
- `collapsedMode` (default `'include-marked'`) — pass-through.

The bridge **never throws**. All branches resolve with a well-formed
result; even Blob construction or DOM creation failures resolve with
`{ ok: false, reason: 'error', error: '<msg>' }`.

### Filename format

```
{sanitized-title}__{YYYY-MM-DD}.md
```

Sanitization (`__ribbonBridge_sanitizeFilenameStem`):

- Replaces control chars (0x00–0x1F + 0x7F) and Windows-reserved
  punctuation (`/\:*?"<>|` and spaces) with `-`.
- Collapses whitespace runs to single spaces then to `-`; collapses
  runs of `-`; trims leading/trailing `-`.
- Truncates to 80 chars (cross-OS path safety).
- Prefixes Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`,
  `COM1-9`, `LPT1-9`) with `_`.

Filename fallbacks (`__ribbonBridge_buildMarkdownFilename`):

- Empty sanitized stem AND non-empty `chatId` → `chat-{chatId8}`.
- Empty sanitized stem AND no `chatId` → `studio-transcript`.
- Date from `snap.capturedAt` ISO prefix (YYYY-MM-DD); fallback to
  today's local date.

### File content layout

```markdown
# {snap.title}

_Captured: {YYYY-MM-DD}_
_Source: {originalUrl}_         (only when originalUrl present in ribbon context)
_Chat ID: {snap.chatId}_        (only when chatId present)

---

{Phase 2e serializer output}
```

Metadata lines are joined with `  \n` (two trailing spaces + newline)
so Markdown preserves them as visible line breaks within a single
paragraph. The horizontal rule (`---`) separates the doc header from
the conversation body. `originalUrl` is read from the live ribbon
context (`H2O.Studio.ribbon.getContext().originalUrl`) and only
included for indexed chats.

### Platform behaviour

- **MV3** (`platform.mv3.js`): `files.exportBlob` uses Blob +
  `URL.createObjectURL` + `<a download>`. No new permission required —
  this works in the Studio surface today (proof: existing
  `migrateDownloadJson`).
- **Tauri** (`platform.tauri.js`): `files.exportBlob` tries
  `plugin:dialog|save` then `plugin:fs|write_text_file`. If either
  plugin is missing from this build's Tauri capabilities OR rejects
  with a permission error, falls back to the Chromium-style
  Blob+`<a download>` (the Tauri webview is chromium-based and
  supports it). **No new Rust deps or capability changes required for
  Phase 3a.**
- **Fallback** (`platform/index.js`): defaults `files.available: false`.
  The bridge feature-detects and uses its inline Blob+anchor fallback
  whenever `platform.files.available !== true`.

### Cancellation

Tauri users who dismiss the save dialog get back `{ ok: false, reason:
'cancelled' }`. The ribbon handler surfaces this as `"Export cancelled"`
— informational, not styled as an error.

### Ribbon status feedback (Export → Download → Markdown)

- `"Preparing Markdown…"` — pending.
- `"Markdown saved: <filename>"` — overlay applied OR raw mode (no drift).
- `"Markdown saved (overlay skipped — snapshot changed)"` — drift fallback.
- `"Export cancelled"` — user dismissed Tauri save dialog.
- `"No transcript content"` — empty snapshot.
- `"No saved chat open"` — no current saved snapshot.
- `"Export bridge unavailable"` — bridge method missing.
- `"Export failed: <reason>"` — anything else.

### Compliance notes for Phase 3a

- `exportMarkdown` MUST NOT mutate `snap.messages` or the overlay record.
- The serializer is reused verbatim — no parallel formatting code.
- Filename sanitizer + header builder are pure helpers (no DOM, no I/O).
- Bridge MUST NOT throw under any input.
- The drift status string `"Markdown saved (overlay skipped — snapshot
  changed)"` mirrors the Phase 2e copy variant; do not paraphrase.
- No new storage keys, no overlay schema changes, no new op types.
- Adapters MUST keep their `files.available` flag honest: `true` only
  when `exportBlob` is callable.

### Out of scope for Phase 3a

- PDF / DOCX / HTML export.
- Markdown frontmatter (YAML at top) — a future `includeFrontmatter`
  option can add this without a contract change.
- Drift annotation inside the exported file — the status string flags
  it in the UI; the file itself stays clean.
- "Copy raw" or "Copy visible only" ribbon buttons (still V2+).
- Bulk export of multiple snapshots.

## Phase 3b — PDF / print via window.print()

Status: **Built**. Implemented across `studio.css` (new `@media print`
block), `studio.js` (`RibbonBridge.openPrintView` + pure helpers
`buildPrintHeaderEl` / `buildPdfFilename`), and
`S0Y1a. 🎬 Studio Ribbon - Studio.js` (`Export → PDF` and
`Export → Print view` handlers, both pointing at the same bridge).

### Strategy

Strategy A — **browser/Tauri-webview `window.print()` over the live
reader DOM**. The user clicks Export → PDF (or Print view); the bridge
injects a temporary `<header data-print-header>` element before
`.cgFrame`, swaps `document.title` for a useful PDF filename, calls
`window.print()`, and unwinds in `try/finally`. The browser's print
dialog offers "Save as PDF" as a destination on every modern OS
(Chrome, Edge, Firefox, Safari, Tauri webview).

**No new dependencies, no platform.files changes, no Tauri plugin/
capability changes, no JS PDF library, no Markdown→HTML conversion.**
The reader DOM with its existing Phase 2 overlay CSS IS the canonical
rendered view; print just hides the chrome and prints it.

### Bridge shape

`H2O.Studio.RibbonBridge.openPrintView(opts?)` — async, returns
`Promise<{ ok, reason?, filename?, overlayIncluded?, overlaySkipped?,
overlayReason? }>`:

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | true when the print dialog was opened (NOT a signal that the user saved/printed anything). |
| `reason` | string? | When `ok:false`, one of: `'no-snapshot'`, `'reader-unavailable'`, `'print-unavailable'`, `'print-in-progress'`, `'error'`. |
| `filename` | string | Suggested PDF filename (`.pdf` extension, sanitized from snap.title). Advisory only — browser save dialog generates its own from `document.title`. |
| `overlayIncluded` | boolean | True if the cached overlay has active ops at print time. |
| `overlaySkipped` | boolean | True if the overlay's baseDigest doesn't match the current snapshot (drift). |
| `overlayReason` | string? | `'drift-detected'` when applicable. |

Options:

- `includeHeader` (default `true`) — skip the on-demand header
  injection. The print stylesheet still hides chrome and shows the
  reader, but no title/date/source/chatId block at top.

The bridge **never throws**. All branches resolve with a well-formed
result; the `try/finally` around `window.print()` guarantees the
injected header is removed and `document.title` restored even if
`window.print()` itself throws synchronously.

### Temporary print header

The injected element is a `<header data-print-header>` with:

```html
<header data-print-header="true">
  <h1>{snap.title}</h1>
  <div class="wbPrintHeaderMeta">
    <span>Captured: 2026-05-24</span>
    [<span>Source: https://chatgpt.com/c/...</span>]   ← only when ctx.originalUrl present
    [<span>Chat ID: {snap.chatId}</span>]              ← only when chatId present
  </div>
</header>
```

The element is `display: none` on screen (so the live reader is
unaffected) and `display: block` in `@media print` (so it surfaces
only at print time). The bridge inserts it as the first child of
`.cgFrame` and removes it in `finally` immediately after
`window.print()` returns.

`document.title` is briefly set to `"{snap.title} — Studio"` for the
duration of `window.print()` and restored afterwards. This makes the
browser's "Save as PDF" dialog default to a sensible filename.

### Collapsed section behaviour

Collapsed sections are **un-hidden in print** by overriding the screen
rule `.is-in-collapsed-section { display: none }` with
`display: revert !important` inside `@media print`. The section header
keeps its `[collapsed — N turns]` suffix (populated by the applier),
so the reader can see that the section was collapsed in Studio.
Mirrors the Phase 2e/3a Markdown export `collapsedMode:
'include-marked'` default.

### Cancellation limitation (canonical)

`window.print()` is synchronous from JS and returns no signal whether
the user saved a file, sent to a printer, or dismissed the dialog.
The bridge resolves `{ ok: true, ... }` to mean **"we opened the
dialog"**, NOT "a file was saved". The ribbon status string is
honest about this:

- `Export → PDF`        →  `"Print dialog opened — choose Save as PDF"`
- `Export → Print view` →  `"Print dialog opened"`

Same constraint that Notion / GitHub / Google Docs all have. Do not
attempt to detect cancellation; do not chain a follow-up action on
"successful print"; do not surface a `"PDF saved: <filename>"`
status — we don't know if a file was actually saved.

### Concurrency

Only one print may be in flight at a time. A module-level
`__ribbonBridge_printInFlight` boolean coalesces concurrent calls
so the `document.title` stash/restore can't race. A second call
while one is open returns `{ ok: false, reason: 'print-in-progress' }`.

### Ribbon status feedback (Export → Download → PDF and Export → Print → Print view)

- `"Opening print dialog…"` — pending.
- `"Print dialog opened — choose Save as PDF"` — Export → PDF success.
- `"Print dialog opened"` — Print view success.
- `"Print dialog opened (overlay disabled — snapshot changed)"` — drift fallback for either action.
- `"No saved chat open"` — missing snapshot.
- `"Reader not mounted"` — `.cgFrame` not found.
- `"Print unavailable in this environment"` — no `window.print`.
- `"Print already in progress"` — second concurrent call.
- `"Print failed: <reason>"` — anything else.

### Compliance notes for Phase 3b

- `openPrintView` MUST NOT mutate `snap.messages` or the overlay record.
- The bridge MUST clean up the injected header AND restore
  `document.title` even if `window.print()` throws synchronously
  (verified by `try/finally`).
- The CSS rules MUST NOT affect screen rendering — only behaviour
  inside `@media print`. (Exception: the `[data-print-header] {
  display: none }` screen rule, which keeps the injected node hidden
  on screen.)
- Collapsed-section un-hiding in print MUST keep the section header's
  `[collapsed — N turns]` marker so the reader knows the section was
  collapsed in Studio.
- The bridge MUST NOT add any new platform.files method, any new
  Tauri plugin / capability, or any JS PDF library.
- The status string `"Print dialog opened (overlay disabled — snapshot
  changed)"` is the canonical drift surface; do not paraphrase.

### Out of scope for Phase 3b

- Programmatic detection of "user saved PDF vs cancelled" — impossible
  cross-browser.
- TOC with live page-number links — `target-counter()` is fragile
  across print engines; V1 prints TOC as a plain list of section titles.
- Custom paper sizes / multi-page layouts — let the OS print dialog
  drive.
- PDF metadata customization beyond `document.title`.
- "Print visible only" mode skipping collapsed content — the option
  exists on the serializer (`collapsedMode: 'omit'`) but no ribbon UI
  in Phase 3b.
- DOCX / direct JS PDF / Tauri-native PDF.

## Phase 3c-A — DOCX writer foundation (no ribbon yet)

Status: **Built** (writer-only slice). Phase 3c-A ships the pure
in-house DOCX writer that Phase 3c-B will compose with the ribbon.
**No `RibbonBridge.exportDocx`, no `Export → DOCX` handler, no
platform-adapter changes** in this slice — those land in Phase 3c-B.

### Strategy

Strategy B from the Phase 3c plan: **minimal in-house DOCX writer**
emitting a stored-mode (uncompressed) OOXML/WordprocessingML ZIP
container. **Zero new runtime dependencies, no vendor library, no
deflate code.** Valid DOCX files are accepted by Word, LibreOffice,
Pages without compression — file size grows ~10% over the JSON it
encodes, acceptable for V1.

### The writer module

`H2O.Studio.overlayDocxWriter` is a singleton installed by
`studio/overlay/overlay-docx-writer.studio.js`. Pure module: no DOM,
no storage, no I/O, no platform.files dependency. Reuses the Phase 2d-
aware reducers (`computeMessageState`, `computeStructureState`,
`findSectionContaining`) the Phase 2e serializer and the Phase 3a/3b
bridges already use, so it inherits the active-set filter
automatically.

Public API:

```ts
H2O.Studio.overlayDocxWriter.build(input) -> {
  blob: Blob,         // application/vnd.openxmlformats-officedocument.wordprocessingml.document
  bytes: Uint8Array,  // raw ZIP bytes (same data backing the Blob)
  size: number,
  opsApplied: number,       // count of active per-message ops emitted
  structureApplied: boolean,// true iff a section/divider/TOC was emitted
  tocIncluded: boolean,
  collapsedSections: number,
  reason?: string,          // 'writer-error' on internal failure
}

H2O.Studio.overlayDocxWriter.selfCheck() -> {
  ok, version, phase, docxMime,
  crc32Probe: { input, got, expected, ok },
  hasReducers, defaultIncludeOverlay, defaultIncludeToc,
  defaultCollapsedMode, errors,
}
```

`input` shape:

```ts
{
  snap: Snapshot,
  overlay: EditOverlay | null,
  headerMeta?: { title?, capturedDate?, originalUrl?, chatId? },
  opts?: {
    includeOverlay?: boolean,   // default true; when false, emit raw transcript only
    includeToc?: boolean,       // default false
    collapsedMode?: 'include-marked' | 'include-silent' | 'omit',  // default 'include-marked'
  }
}
```

The writer **never throws**. On internal error it falls back to a
minimal valid DOCX containing just the header block and resolves with
`reason: 'writer-error'`. The CRC32 self-check
(`crc32("abc") === 0x352441C2`) runs at probe time and surfaces via
`selfCheck().crc32Probe.ok`.

### DOCX ZIP entries emitted (exactly 5)

| Entry | Purpose |
|---|---|
| `[Content_Types].xml` | MIME-type map — declares `application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml` for `word/document.xml` and the corresponding type for `word/styles.xml`. |
| `_rels/.rels` | Root relationships — points at `word/document.xml`. |
| `word/_rels/document.xml.rels` | Document-scoped relationships — points at `word/styles.xml`. |
| `word/document.xml` | The body: paragraphs + runs. |
| `word/styles.xml` | Style declarations: `Title`, `Heading1-3`, `IntenseQuote`, `ListBullet`. No visual properties — consumer apps apply their theme. |

### ZIP encoding

- **Stored mode (method 0)** — no compression, no deflate code, no
  `CompressionStream` dependency.
- **General-purpose bit flag = 0** — no UTF-8 flag (all our entry names
  are pure ASCII).
- **Deterministic timestamps** — fixed DOS date 2020-01-01 00:00:00 so
  output bytes are reproducible across runs (test-friendly).
- **CRC32** — ISO/IEC 3309 standard (poly = 0xEDB88320 reflected,
  init = 0xFFFFFFFF, final XOR = 0xFFFFFFFF).
- **No ZIP64** — `.docx` files comfortably fit under the 4 GB ZIP-32
  limit for any realistic transcript.

### Op → DOCX mapping (mirrors Phase 2e + 3a)

Same body-walking semantics the Phase 2e serializer uses; emission is
OOXML paragraphs instead of Markdown lines.

| Op | DOCX output |
|---|---|
| `heading H1/H2/H3` | role-label paragraph styled `Heading1/2/3`; body as `Normal` paragraphs |
| `quote` | body paragraphs styled `IntenseQuote` |
| `code` / `code-block` | body runs with `<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>`; `\n` → `<w:br/>` |
| `callout` (info/note/warning/tip) | wraps role + body in `IntenseQuote` paragraphs with a leading **bold** `[!kind]` run |
| `clean-spacing` | text pass: collapse 3+ consecutive `\n` → 2 before run emission |
| `add-section` / `split-section` | `<w:p>` styled `Heading2` with section title |
| `collapse-section` (default `include-marked`) | section title appended with ` [collapsed — N turns]`; content still emitted |
| `page-divider` | `<w:p><w:r><w:br w:type="page"/></w:r></w:p>` (hard page break) |
| `toc` (when `includeToc: true`) | After header block: `Heading1` "Contents" + one `ListBullet` per section title |

Op stacking on a single message (outer → inner): `callout > heading >
code > quote > clean-spacing`. When both `code` and `quote` are active
on the same turn, `code` wins (same as Phase 2e).

### Header block (top of every DOCX)

```
[Title-styled paragraph]    snap.title
[italic run]                Captured: YYYY-MM-DD
[italic run, optional]      Source: <originalUrl>      ← only when present
[italic run, optional]      Chat ID: <chatId>          ← only when present
[empty spacer paragraph]
```

### XML safety

All user-supplied text passes through:
- `stripInvalidXmlChars` — removes XML 1.0-illegal control chars
  (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F, plus U+FFFE/U+FFFF) while
  preserving `\t`, `\n`, `\r`.
- `xmlEscape` — replaces `& < > " '` with their entity equivalents.
- Run text uses `<w:t xml:space="preserve">` so leading / trailing
  whitespace survives.
- Embedded `\n` becomes `<w:br/>` inside the run so newlines render
  as soft line breaks in Word.

### Compliance notes for Phase 3c-A

- The writer MUST NOT mutate `snap.messages` or the `overlay` record.
- The writer MUST be self-contained: no DOM, no storage, no
  `platform.files`, no `RibbonBridge`, no `H2O.events.emit`.
- The writer MUST reuse the existing applier reducers — do NOT
  duplicate `computeMessageState` / `computeStructureState` logic.
- The CRC32 implementation MUST use the ISO/IEC 3309 standard
  (poly = 0xEDB88320 reflected); `selfCheck().crc32Probe.ok` MUST be
  `true` for the writer to be considered healthy.
- ZIP output MUST be deterministic — same input → same bytes, every
  call (fixed DOS timestamp, no random ordering).
- The writer MUST NOT throw under any input. On internal failure, it
  returns a minimal valid DOCX with just the header block and
  `reason: 'writer-error'`.

### Out of scope for Phase 3c-A (deferred to Phase 3c-B)

- `RibbonBridge.exportDocx(opts?)` — the bridge method that composes
  the writer with `platform.files.exportBlob`.
- `ACTION_HANDLERS['export-docx']` ribbon wiring in S0Y1a.
- Status string canon for the `Export → DOCX` action.
- Tauri-adapter binary-write path (if needed; current `write_text_file`
  would corrupt DOCX bytes — Phase 3c-B will route to the inline
  Blob+anchor fallback OR add a `write_file` branch).
- Filename helper `_buildDocxFilename` — Phase 3c-B; trivial wrapper
  over Phase 3a's `_buildMarkdownFilename`.

### Out of scope for Phase 3c-A *and* Phase 3c-B

- Images, tables, hyperlinks, lists beyond `ListBullet`.
- Headers / footers.
- Custom fonts beyond Consolas for code runs.
- Themes beyond Word's defaults.
- ZIP64 / large-file extensions.
- DEFLATE compression (stored-mode only).
- Embedded TOC with live page numbers.
- DOCX → editable round-trip.

## Phase 3c-B — DOCX export bridge + ribbon wiring

Status: **Built**. Implemented across `studio.js`
(`RibbonBridge.exportDocx` + `_buildDocxFilename`),
`S0Y1a. 🎬 Studio Ribbon - Studio.js`
(`Export → DOCX` handler), and `platform/platform.tauri.js` (binary-safe
write path for non-text MIMEs).

### Bridge shape

`H2O.Studio.RibbonBridge.exportDocx(opts?)` — async, returns
`Promise<{ ok, reason?, filename?, bytes?, path?, overlayIncluded?,
overlaySkipped?, overlayReason?, fallback? }>`. Mirrors the Phase 3a
`exportMarkdown` shape exactly so the ribbon handler reads the same
fields.

| Field | Type | Meaning |
|---|---|---|
| `ok` | boolean | true when the file landed (native save OR Blob+anchor fallback). |
| `reason` | string? | When `ok:false`, one of: `'no-snapshot'`, `'no-content'`, `'cancelled'` (Tauri save dialog dismissed), `'export-failed'`, `'writer-unavailable'`, `'error'`. |
| `filename` | string | `{stem}__{YYYY-MM-DD}.docx` (reuses Phase 3a sanitizer). |
| `bytes` | number | Size of the file written. |
| `path` | string? | Tauri-native save path when `plugin:fs|write_file` was used. |
| `overlayIncluded` | boolean | True if any per-message op, structure marker, or TOC was emitted. |
| `overlaySkipped` | boolean | True if the overlay's `baseDigest` doesn't match the current snapshot (drift). |
| `overlayReason` | string? | `'drift-detected'` when applicable. |
| `fallback` | string? | `'blob-anchor'` when the inline Blob+anchor fallback was used. |

Options: `includeOverlay` (default `true`), `includeToc` (default
`false`), `collapsedMode` (default `'include-marked'`) — all pass-through
to the writer.

The bridge **never throws**. Try/catch around every internal branch;
last-resort floor resolves with `{ ok: false, reason: 'error' }`.

### Tauri binary-safe write path

The Phase 3a Tauri `filesExportBlob` used `plugin:fs|write_text_file`
exclusively. This is correct for `text/*` MIMEs (Markdown export) but
**corrupts binary bytes** because `blob.text()` decodes invalid UTF-8
sequences as U+FFFD, and re-encoding loses the original bytes.

Phase 3c-B adds MIME detection inside `filesExportBlob`:

- **Text MIMEs** (`text/*`) — unchanged: routes through
  `plugin:fs|write_text_file`. Phase 3a Markdown export path is
  preserved byte-for-byte (regression guard).
- **Non-text MIMEs** (DOCX, ZIP, PDF, anything not `text/*`) — new
  path: converts `blob` to a `number[]` byte array and invokes
  `plugin:fs|write_file` (binary). Same `tauri-plugin-fs` plugin
  already used; no new Rust dependency.

**Fallback chain on Tauri** (mirrors Phase 3a graceful degradation):
1. If `plugin:dialog|save` is unavailable / rejects → Blob+anchor.
2. If the user dismisses the save dialog → `{ ok: false, reason: 'cancelled' }`.
3. If `plugin:fs|write_file` is unavailable / rejects (typically:
   capability not allow-listed) → Blob+anchor.
4. If the Tauri webview itself can't `URL.createObjectURL` → `{ ok: false, reason: 'export-failed' }`.

Phases 3a and 3c-B add no Tauri capability changes; the binary path
either works via the existing `plugin:fs|*` allow-list, or it
gracefully falls back to Blob+anchor (loses native save dialog on
desktop but the user still gets the file).

### Ribbon status feedback (Export → Download → DOCX)

- `"Preparing DOCX…"` — pending.
- `"DOCX saved: <filename>"` — overlay applied OR raw mode (no drift).
- `"DOCX saved (overlay skipped — snapshot changed)"` — drift fallback.
- `"Export cancelled"` — user dismissed Tauri save dialog.
- `"No transcript content"` — empty snapshot.
- `"No saved chat open"` — no current saved snapshot.
- `"DOCX writer unavailable"` — `overlayDocxWriter` missing or
  `selfCheck().ok === false`.
- `"Export bridge unavailable"` — bridge method missing.
- `"Export failed: <reason>[: <error>]"` — anything else.

### Compliance notes for Phase 3c-B

- `exportDocx` MUST NOT mutate `snap.messages` or the overlay record.
- The bridge MUST NOT throw under any input.
- The bridge MUST reuse the existing helpers: Phase 3a's
  `_buildMarkdownFilename` (via `_buildDocxFilename`), Phase 3a's
  drift-detection precedent (via `computeBaseDigest`), Phase 3a's
  inline Blob+anchor fallback pattern.
- The Tauri text path for `text/*` MIMEs MUST remain byte-identical to
  Phase 3a so Markdown export is unchanged.
- The binary write path MUST NOT introduce any new Rust dependency,
  new Tauri plugin, or new capability allow-list entry. Acceptance of
  `plugin:fs|write_file` depends on the existing capability — if not
  allow-listed, the rejection-and-fallback chain handles it.
- The status string `"DOCX saved (overlay skipped — snapshot changed)"`
  is the canonical drift surface; do not paraphrase.

### Out of scope for Phase 3c-B

- DOCX writer feature additions (images, tables, etc.) — see Phase 3c-A
  "out of scope" list.
- Programmatic detection of "user kept the file vs deleted it" — outside
  any browser/OS contract.
- Hot-swapping the DOCX MIME to `application/zip` for download — keep
  the proper MIME so OS file-association maps to Word/LibreOffice.
- Adding `plugin:fs|write_file` to Tauri capabilities — the existing
  fallback chain handles its absence.

## Phase 4-1 — Message-level character formatting

Status: **Built** (first Phase 4 slice). The character-formatting
toolset for the Format → Font ribbon group:
**Bold / Italic / Underline / Strikethrough / Clear formatting.**

### Scope

This slice ships the **OneNote-style block-level** character formatting
controls. **All four toggles apply to the entire selected message
(turn).** Inline text-range selection is explicitly out of scope for
Phase 4-1 and is deferred to a later Phase 4 slice (4e in the design
plan). The existing `selectedTurnIdx` / `selectedMessageId` context
fields drive the selection model; no DOM range tracking, no
ContentEditable, no span ops.

### New op types (5)

| Op type | Payload | Reducer field |
|---|---|---|
| `bold` | `{ enabled: bool }` | `bold: bool` |
| `italic` | `{ enabled: bool }` | `italic: bool` |
| `underline` | `{ enabled: bool }` | `underline: bool` |
| `strikethrough` | `{ enabled: bool }` | `strikethrough: bool` |
| `clear-formatting` | `{}` | (resets ALL per-message fields to default) |

### Reducer state shape (extended)

```ts
{
  // Phase 2b — unchanged
  heading: { level: 1|2|3 }|null,
  quote: boolean,
  code: boolean,
  callout: { kind: 'info'|'note'|'warning'|'tip' }|null,
  cleanSpacing: boolean,

  // Phase 4-1 — new
  bold: boolean,
  italic: boolean,
  underline: boolean,
  strikethrough: boolean,
}
```

### `clear-formatting` semantics

When the reducer encounters an active `clear-formatting` op targeting a
specific `turnIdx`, **the per-message state resets to its default at
that point in op order.** All ten fields (Phase 2b + Phase 4-1) snap
back to default. Subsequent active ops on the same turn apply normally
on top of the cleared state.

This composes cleanly with the Phase 2d reducer-filter active-set undo /
redo:

- Apply Bold → state has `bold: true`.
- Apply Clear formatting → state resets; `bold: false` again.
- Undo (pops `clear-formatting` off `undoStack`) → reducer no longer
  sees the clear-formatting op; `bold: true` returns automatically.
- Redo → `clear-formatting` is back in `undoStack`; state resets again.

**No special-case undo logic required.** The reducer-filter model
handles `clear-formatting` like any other op.

### Op stacking (outer → inner)

The 4 character toggles wrap the BODY text, applied innermost (before
heading / quote / code / callout decorations wrap the role label or
the body block):

```
1. callout       (wraps role + body in IntenseQuote)
2. heading       (decorates role-label paragraph style)
3. code          (body uses Consolas; code wins over quote)
4. quote         (body uses IntenseQuote)
5. clean-spacing (text pass on body)
6. char format   (bold/italic/underline/strike on body runs — innermost)
```

**Code wins over character formatting** in two specific cases:
- **Markdown serializer**: when `state.code === true`, the character
  wrappers (`**`, `*`, `<u>`, `~~`) are skipped on the body text. The
  fenced code block stays literal so `` ```const x = **42** ``  ` doesn't
  get its `**` re-interpreted as bold.
- **DOCX writer**: when `state.code === true`, the body run gets both
  the Consolas `<w:rFonts/>` AND any active character formatting
  fragments — Word's code-style font composes cleanly with `<w:b/>` etc.

### Export mappings

| Op | Markdown | DOCX `<w:rPr>` | Screen / Print CSS |
|---|---|---|---|
| `bold` | `**text**` | `<w:b/>` | `font-weight: 700` |
| `italic` | `*text*` | `<w:i/>` | `font-style: italic` |
| `underline` | `<u>text</u>` (raw HTML — Markdown has no native underline) | `<w:u w:val="single"/>` | `text-decoration-line: underline` |
| `strikethrough` | `~~text~~` | `<w:strike/>` | `text-decoration-line: line-through` |
| `clear-formatting` | (reducer-only — no output) | (reducer-only) | (no class applied) |

Composed `underline + strikethrough` renders both decoration lines via
a combined `text-decoration-line: underline line-through` rule.

### Ribbon UI (Format tab)

New "Font" group between "Headings" and "Blocks":

```
Format tab:
  Headings: H1 H2 H3
  Font:     B  I  U  S  Clear      ← Phase 4-1
  Blocks:   Quote Code Callout
  Cleanup:  Clean spacing
```

### Enable rule (Phase 4-1 buttons)

All 5 Font-group actions share the existing `formatActionsIsEnabled`
gate (Phase 2b precedent):

- `ctx.chatType === 'saved'`
- `ctx.snapshotId` non-empty
- `Number.isFinite(ctx.selectedTurnIdx) && ctx.selectedTurnIdx > 0`
- `H2O.Studio.RibbonBridge.applyOverlayOp` is a function
- `H2O.Studio.store.editOverlay.upsert` is a function

When disabled, the buttons show `"Coming soon"` tooltip (Phase 1a
default). When clicked without a selected turn at click time, the
status is `"Select a message first"` (Phase 2b precedent).

### Status string canon (Phase 4-1)

| State | Text |
|---|---|
| Bold pending | `"Applying bold…"` / `"Removing bold…"` |
| Bold success | `"Bold applied"` / `"Bold removed"` |
| Bold failure | `"Bold failed: <reason>"` |
| Italic | `"Applying italic…"` / `"Italic applied"` / `"Italic removed"` / `"Italic failed: <reason>"` |
| Underline | `"Applying underline…"` / `"Underline applied"` / `"Underline removed"` / `"Underline failed: <reason>"` |
| Strikethrough | `"Applying strikethrough…"` / `"Strikethrough applied"` / `"Strikethrough removed"` / `"Strikethrough failed: <reason>"` |
| Clear formatting | `"Clearing formatting…"` → `"Formatting cleared"` / `"Clear formatting failed: <reason>"` |
| No turn selected | `"Select a message first"` (reuses Phase 2b canon) |
| Drift | `"Snapshot has changed — overlay disabled until rebase"` (reuses Phase 2b drift canon via `runOverlayOp`) |

### Compliance notes for Phase 4-1

- All 4 toggles and `clear-formatting` MUST NOT mutate `snap.messages`.
- The applier MUST NOT modify children or text content of the turn
  element — only the new `data-overlay-bold|italic|underline|strikethrough`
  attributes on the `[data-turn]` wrapper.
- `clear-formatting` MUST reset only the per-message fields. Structure
  state (sections / dividers / TOC) is untouched.
- Markdown export of underline MUST emit inline HTML `<u>...</u>`
  (Markdown has no portable underline syntax).
- DOCX `<w:rPr>` MUST compose Consolas font + character toggles when
  both code and character formatting are active on the same turn —
  do not skip character formatting inside code blocks in the DOCX
  output.
- Markdown serializer MUST skip character wrappers when `state.code`
  is set — the fenced code block stays literal.
- Each new op type MUST follow the existing per-message `buildToggleHandler`
  pattern in S0Y1a — no parallel mechanism.
- The reducer-filter active-set model MUST handle these ops without
  any framework changes (Phase 2d invariant).

### Out of scope for Phase 4-1 (deferred to later Phase 4 slices)

- **Inline text-range selection** — selecting a word/phrase inside a
  message. Phase 4e in the original Phase 4 design plan.
- **Font family / font size** — needs inline selection.
- **Lists / alignment / indent** — Phase 4c slice (delivered in Phase 4-3).
- **Visual tags (To Do / Important / Question / etc.)** — Phase 4d slice (delivered in Phase 4-4).
- **Format painter** — requires inline selection.
- **Clipboard cut/paste of formatted spans** — not in scope.
- **Subscript / superscript** — inherently inline; deferred.

## Phase 4-2 — Text Color + Highlight integration

Status: **Built**. Second Phase 4 slice. **Dual-path architecture**:

- **Text color** = new message-level overlay op (`text-color`), follows
  the Phase 4-1 pattern exactly.
- **Highlight** = control surface for the EXISTING
  `H2O.IHighlighter` + `H2O.Studio.store.highlights` system. The
  Ribbon adds buttons that call into the existing public APIs; **NO
  parallel storage, NO duplicate schema, NO overlay op for highlights**.

### Text color — overlay op model

| Aspect | Value |
|---|---|
| Op type | `text-color` |
| Payload | `{ kind: 'red' \| 'green' \| 'blue' \| 'orange' \| 'gray' \| null }` |
| Target | `{ kind: 'message', turnIdx, messageId? }` (same as Phase 4-1 character toggles) |
| Reducer state field | `textColor: { kind } \| null` |
| DOM attribute | `data-overlay-text-color="red\|green\|blue\|orange\|gray"` on `[data-turn]` |
| Last-op-wins | Yes (mirrors the Phase 2b `callout` precedent) |
| `clear-formatting` reset | Yes — `defaultMessageState()` sets `textColor = null` so Phase 4-1's clear-formatting wipes it for free |
| Undo / redo | Free via Phase 2d reducer-filter active-set |

#### Palette (5 semantic colors + clear)

Five mid-saturation tones picked for legibility on both light and dark
themes. The hex values are **pinned in three places** — the CSS screen
rules, the CSS print rules, and the DOCX writer's `TEXT_COLOR_HEX` map.
The DOCX consumer apps (Word, LibreOffice, Pages) render without our
CSS, so these values must look reasonable on a white page.

| Kind | Hex |
|---|---|
| `red` | `#C53030` |
| `green` | `#2F855A` |
| `blue` | `#2C5282` |
| `orange` | `#C05621` |
| `gray` | `#4A5568` |
| `null` | (clears the attribute; no `<w:color/>` emitted) |

#### Text color — export mappings

| Channel | text-color output |
|---|---|
| Markdown | **No output.** Markdown has no portable color syntax; documenting the lossy mapping is preferable to emitting raw HTML `<span style="color:...">` that would break round-trip. |
| DOCX | `<w:color w:val="C53030"/>` (etc.) inside the body run's `<w:rPr>`. Composes with the Phase 4-1 character toggles (`<w:b/>`, `<w:i/>`, `<w:u w:val="single"/>`, `<w:strike/>`) and the Consolas `<w:rFonts/>` for code runs. |
| Screen CSS | `.wbReader [data-turn][data-overlay-text-color="<kind>"] [data-message-author-role] { color: <hex>; }` |
| Print CSS | Same selectors inside `@media print`, with `!important` to override the global black-text reset. |

### Highlight — bridge to existing system (NO parallel state)

The existing highlight system has 4 components:

| Component | Owner | Role |
|---|---|---|
| `S3H1a. 🎬 Highlights Engine - Studio.js` | native runtime + Studio | Public API `H2O.IHighlighter.*` |
| `S1A3a. 🎬 Highlight Dots - Studio.js` | runtime | MiniMap dots / visual layer |
| `store/highlights.js` | Studio | Canonical persistence (`H2O.Studio.store.highlights`) |
| `dock/tabs/highlights.tab.studio.js` | Studio | Read-only Dock tab |

**Phase 4-2 adds Ribbon control buttons that bridge to the existing
APIs. Nothing in this system is duplicated, mirrored, or shadowed.**

#### Highlight storage facts (unchanged, documented)

- **Storage key**: `h2o:prm:cgx:nlnhghlghtr:state:inline_highlights:v3`
- **Backend**: `chrome.storage.local` (synced cross-context via
  `chrome.storage.onChanged`)
- **Schema version**: 3
- **Blob shape**: `{ itemsByAnswer: { [answerId]: Item[] }, convoId?, _meta?: { currentColor? } }`
- **Item shape**: `{ id, color, anchors: { xpath, textPos, textQuote }, ts, pairNo }`
- **Selection scope**: span / inline (XPath + TextPosition + TextQuote anchoring)
- **Color storage**: name token (e.g. `"gold"`, `"red"`), not hex
- **Palette**: 8 colors (blue, red, green, gold, sky, pink, purple, orange); customizable via S3H1a's UI prefs at `h2o:prm:cgx:nlnhghlghtr:cfg:ui:v1` (separate localStorage key, NOT in the canonical blob)

#### Ribbon actions (read these as bindings, not new code)

| Ribbon action | Existing API called | Selection scope |
|---|---|---|
| **8 brush swatches** (Blue / Red / Green / Gold / Sky / Pink / Purple / Orange) | `H2O.IHighlighter.setCurrentColor(name)` | Global brush — affects the next highlight created (anywhere). Doesn't require a selected turn. |
| **Clear** (Highlights on this message) | `H2O.Studio.store.highlights.removeForAnswer(selectedMessageId)` | The selected assistant turn |
| **Hide / Show** (visibility toggle) | `H2O.IHighlighter.setEnabled(on)` + `getEnabled()` | Global visibility |

The Ribbon **does NOT** expose a "create highlight" button. Inline
text-range selection isn't supported by the Ribbon; users still
create highlights via S3H1a's popup or keyboard shortcuts.

The Ribbon **does NOT** export highlights to Markdown / DOCX / PDF.
Highlights weren't in any export path before Phase 4-2; that's a
separate future feature.

#### Compliance notes (highlight bridge)

- Ribbon code MUST call only the documented public APIs
  (`H2O.IHighlighter.{setCurrentColor, getCurrentColor, setEnabled,
  getEnabled}` and `H2O.Studio.store.highlights.removeForAnswer`).
- Ribbon code MUST NOT read or write `chrome.storage.local` directly.
- Ribbon code MUST NOT create a parallel highlight schema in
  `editOverlay` records or anywhere else.
- Ribbon code MUST NOT modify the canonical key
  `h2o:prm:cgx:nlnhghlghtr:state:inline_highlights:v3` outside of the
  documented store API methods.
- Ribbon code MUST NOT touch the UI-prefs key
  `h2o:prm:cgx:nlnhghlghtr:cfg:ui:v1` (owned by S3H1a's `CFG_*`
  functions).
- The `@match https://chatgpt.com/*` userscript header on S3H1a is
  Tampermonkey metadata only — `<script>`-loaded execution in
  studio.html runs the engine inside Studio too, and the
  `STATE.installed` self-guard makes it idempotent.

### Ribbon status canon (Phase 4-2)

#### Text color
- Pending: `"Applying text color (<color>)…"` / `"Clearing text color…"`
- Success: `"Text color: <color>"` / `"Text color cleared"`
- Drift: `"Snapshot has changed — overlay disabled until rebase"` (reuses Phase 2b drift canon via `runOverlayOp`)
- Fail: `"Text color failed: <reason>"`
- No selected turn: `"Select a message first"`

#### Highlight brush
- Success: `"Brush: <color>"`
- Engine missing: `"Highlight bridge unavailable"`

#### Clear highlights on message
- Pending: `"Clearing highlights…"`
- Success: `"Highlights cleared on this message"`
- No-op (no items on this answer): `"No highlights on this message"`
- Engine missing: `"Highlight store unavailable"`
- No selection: `"Select a message first"`
- Fail: `"Clear highlights failed: <reason>"`

#### Visibility toggle
- Success: `"Highlights hidden"` (when toggling off) / `"Highlights shown"` (when toggling on)
- Engine missing: `"Highlight bridge unavailable"`
- Fail: `"Visibility toggle failed: <reason>"`

### Format tab layout after Phase 4-2

```
Format tab:
  Headings:   H1  H2  H3
  Font:       B  I  U  S  Clear                                ← Phase 4-1
  Text Color: Red  Green  Blue  Orange  Gray  None             ← Phase 4-2 (overlay op)
  Highlight:  Blue Red Green Gold Sky Pink Purple Orange | Clear | Hide  ← Phase 4-2 (existing-system bridge)
  Blocks:     Quote  Code  Callout
  Cleanup:    Clean spacing
```

### Out of scope for Phase 4-2

- **Highlight creation from the Ribbon** — requires inline selection.
- **Highlight export** to Markdown / DOCX / PDF — separate future phase.
- **Recolor message** via the Ribbon — `H2O.IHighlighter.recolorTurnHighlights`
  exists but is not exposed in Phase 4-2; could be a future Phase 4-N
  addition without contract changes.
- **Markdown export of text-color** — intentionally lossy.
- **Palette customization** from the Ribbon — palette CRUD lives in
  S3H1a's UI prefs and the Dock tab; the Ribbon uses the 8 fixed
  default color NAMES (color customization still works for the user;
  the Ribbon's swatch label just doesn't update).

## Phase 4-3 — Message-level paragraph controls

Phase 4-3 is the third Phase 4 slice — paragraph-level decorations
applied to the entire selected message body. All three are overlay ops
(no bridge to an external system, unlike highlights). Inline text-range
selection is **not** part of Phase 4-3 and is deferred to a later slice.

### Op model

Three new op types extend `H2O.Studio.OverlayOpTypes`:

| Op type  | Payload                                  | Reducer field        | Default |
|----------|------------------------------------------|----------------------|---------|
| `list`   | `{ kind: 'bullet' \| 'numbered' \| null }` | `state.list`         | `null`  |
| `align`  | `{ value: 'left' \| 'center' \| 'right' \| null }` | `state.align` | `null`  |
| `indent` | `{ level: number }` — absolute 0..3        | `state.indent`       | `0`     |

| Field    | Value                                                             |
|----------|-------------------------------------------------------------------|
| Target   | `{ kind: 'message', turnIdx, messageId? }` (same as Phase 4-1/4-2) |
| Wins     | Last active op of (type, target) wins (Phase 2b precedent)        |
| Undo/redo | Phase 2d active-set filter applies for free                      |
| `clear-formatting` reset | Yes — `defaultMessageState()` sets all three to defaults |

Defensive reducer normalization: unknown `list.kind` / `align.value`
collapses to `null`; out-of-range `indent.level` clamps to `[0, 3]`.

### DOM dispatch

The applier toggles three `data-overlay-*` attributes on the `[data-turn]`
wrapper:

```
data-overlay-list="bullet|numbered"
data-overlay-align="left|center|right"
data-overlay-indent="1|2|3"     (absent when state.indent === 0)
```

Pattern matches Phase 2b/Phase 4-1/Phase 4-2: applier sets/removes the
attribute; CSS rules in `studio.css` select on the attribute. The applier
NEVER touches the turn element's children or text content — the same
invariant from Phase 2b applies unchanged.

### Markdown export mapping (lossy by design)

| Op state                              | Markdown output                              |
|---------------------------------------|----------------------------------------------|
| `list = { kind: 'bullet' }`           | Per `\n`-split line, prefix `- ` (one bullet per line) |
| `list = { kind: 'numbered' }`         | Per `\n`-split line, prefix `1. `, `2. `, `3. `, ... (renumbered each turn) |
| `align = 'left' \| 'center' \| 'right'` | **No output** — intentionally lossy (no portable Markdown syntax) |
| `indent = 1..3`                       | **No output** — intentionally lossy (no portable Markdown syntax) |

When list is active and character formatting (Phase 4-1) is also on, the
serializer wraps each line individually so the Markdown is syntactically
clean (`- **line1**\n- **line2**`, not `- **line1\n- line2**`). When
`state.code === true` (fenced code block), the list prefix is skipped so
the fenced code stays literal — same precedent as character formatting.

### DOCX export mapping (lossless for align/indent)

| Op state         | DOCX emission                                                   |
|------------------|----------------------------------------------------------------|
| `list = bullet`  | Body paragraphs use `<w:pStyle w:val="ListBullet"/>`, one paragraph per `\n`-split line |
| `list = numbered`| Body paragraphs use `<w:pStyle w:val="ListNumber"/>`, one paragraph per `\n`-split line |
| `align`          | `<w:jc w:val="left|center|right"/>` inside `<w:pPr>` on each body paragraph |
| `indent = 1`     | `<w:ind w:left="720"/>` (720 twips = ~0.5 inch)                |
| `indent = 2`     | `<w:ind w:left="1440"/>`                                       |
| `indent = 3`     | `<w:ind w:left="2160"/>`                                       |

Composition order inside `<w:pPr>`: `pStyle → jc → ind`. The role-label
paragraph keeps its own style (heading or none) and does **not** receive
align/indent — they decorate body paragraphs only, mirroring the Phase
4-1 character-formatting precedent that keeps the role label visually
distinct.

When `state.code` is set, the list pStyle is skipped (code stays plain
paragraph) but align/indent still compose into pPr. When `state.callout`
is set, the callout's IntenseQuote pStyle wins over the list pStyle —
callout is more specific (Phase 2b precedent).

A new `ListNumber` style declaration is added to `word/styles.xml`
alongside the existing `ListBullet`. Word + LibreOffice render
`ListNumber` as decimal numbering using their default numbering
definition; consumers may supply their own `numPr` — the writer keeps
the styles minimal.

### Screen + print CSS mapping

```
[data-overlay-list="bullet"]   → display: list-item; list-style: disc inside
[data-overlay-list="numbered"] → display: list-item; list-style: decimal inside
[data-overlay-align="left"]    → text-align: left
[data-overlay-align="center"]  → text-align: center
[data-overlay-align="right"]   → text-align: right
[data-overlay-indent="1"]      → padding-left: 1em
[data-overlay-indent="2"]      → padding-left: 2em
[data-overlay-indent="3"]      → padding-left: 3em
```

Print rules mirror screen with `!important` to win against the print
reset block.

### Screen-list single-marker limitation (intentional)

The message body is ONE DOM element from the reader's perspective, so
`display: list-item` renders ONE bullet/number for the entire message
(whole body = one list item). Splitting a single message into multiple
list items on screen would require contentEditable or per-line DOM
restructuring — both explicitly out of scope for Phase 4-3.

**Markdown and DOCX exports do split per `\n` and emit a proper
multi-item list.** The per-line list-item rendering lives in the export
paths, not in the reader. Users see "one bullet per message" in the
reader; their exported `.md` / `.docx` shows "one bullet per line."

This trade-off is documented because it's surprising — but the
alternative (contentEditable + line-level state) is a much larger
project, and the export-side fidelity is what users actually need from
"add a list" most of the time.

### Ribbon UI (Format → Paragraph group)

```
Paragraph:  Bullet  Numbered  |  Left  Center  Right  |  Indent  Outdent
```

Seven actions, all gated by the same `formatActionsIsEnabled` rule as
the Phase 4-1 / Phase 4-2 Font + Text Color groups (saved-reader with a
selected turn and the bridge installed).

| Action       | Op submitted                            | Toggle/delta behaviour |
|--------------|----------------------------------------|------------------------|
| Bullet       | `list` payload `{ kind: 'bullet' }`    | Toggle: same kind twice clears (`kind: null`) |
| Numbered     | `list` payload `{ kind: 'numbered' }`  | Toggle: same kind twice clears |
| Left         | `align` payload `{ value: 'left' }`    | Toggle: same value twice clears |
| Center       | `align` payload `{ value: 'center' }`  | Toggle: same value twice clears |
| Right        | `align` payload `{ value: 'right' }`   | Toggle: same value twice clears |
| Indent       | `indent` payload `{ level: cur + 1 }`  | Delta: clamps at level 3 (status "Already at maximum indent") |
| Outdent      | `indent` payload `{ level: cur - 1 }`  | Delta: clamps at level 0 (status "Already at no indent") |

Toggles read current state via `H2O.Studio.RibbonBridge.getMessageStateForTurn`
(synchronous) before submitting. Deltas read `state.indent`, clamp the
new level to 0..3, submit the absolute new level — the reducer also
clamps so two sources of truth converge.

### Ribbon status canon (Phase 4-3)

| Action / outcome                | Status text                          |
|--------------------------------|--------------------------------------|
| Apply bullet list              | `Bullet list applied`                |
| Apply numbered list            | `Numbered list applied`              |
| Remove list (toggle off)       | `List removed`                       |
| Align left/center/right        | `Aligned left` / `Aligned center` / `Aligned right` |
| Clear alignment (toggle off)   | `Alignment cleared`                  |
| Indent (new level 1..3)        | `Indented (level N)`                 |
| Indent at max                  | `Already at maximum indent`          |
| Outdent (new level 0..2)       | `Outdented (level N)`                |
| Outdent at zero                | `Already at no indent`               |
| Bridge drift                   | (existing drift hint flows through)  |

### Combinations matrix

| Combo                       | Screen + DOCX outcome |
|-----------------------------|-----------------------|
| `bold` + `list = bullet`    | Each line is a bullet item with bold content (Markdown wraps per-line) |
| `code` + `list`             | Code wins — list pStyle skipped; code stays literal |
| `callout` + `list`          | Callout wins — IntenseQuote pStyle keeps; list pStyle skipped inside callout |
| `quote` + `list`            | List wins (list more specific than quote when both present) |
| `align` + `indent`          | Composes — both `<w:jc>` and `<w:ind>` in same `<w:pPr>` |
| `align = center` + `list`   | List item rendered with `text-align: center` (DOCX + screen) |
| `clear-formatting`          | All three Phase 4-3 fields reset to defaults (null/null/0) |
| Phase 2d undo               | Active-set filter applies; undoing the last `list` op restores prior `state.list` |

### Format tab layout after Phase 4-3

```
Format tab:
  Headings:   H1  H2  H3
  Font:       B  I  U  S  Clear                                          ← Phase 4-1
  Text Color: Red  Green  Blue  Orange  Gray  None                       ← Phase 4-2 (overlay op)
  Highlight:  Blue Red Green Gold Sky Pink Purple Orange | Clear | Hide  ← Phase 4-2 (existing-system bridge)
  Paragraph:  Bullet  Numbered  |  Left  Center  Right  |  Indent  Outdent ← Phase 4-3
  Blocks:     Quote  Code  Callout
  Cleanup:    Clean spacing
```

### Compliance notes for Phase 4-3

- No new storage keys. No new schema. No schema migration.
- No `chrome.*` / `localStorage` / `indexedDB` / `fetch` introduced.
- No contentEditable / inline text-range selection.
- No snapshot mutation. The applier still only toggles `data-overlay-*`
  attributes on `[data-turn]` wrappers.
- No platform-adapter changes; ribbon uses existing `runOverlayOp`
  bridge plumbing.
- No new Tauri capability, no new Rust dep, no plugin install.
- The 3 new op types pass through Phase 2d's active-set undo/redo
  unchanged because the reducer iterates ops in original order and
  applies the same "last active op of (type, target) wins" rule.

### Out of scope for Phase 4-3 (deferred to later Phase 4 slices)

- **Inline list items** (multiple bullets per message on screen) —
  requires contentEditable or per-line state.
- **Multi-level nested lists** — single-level only; nesting needs
  inline structure.
- **Custom list start numbers / formats** — `ListNumber` uses Word's
  default decimal numbering definition.
- **Right-to-left text direction** — `<w:bidi/>` not emitted; only LTR.
- **Justify alignment** — three modes only (left/center/right).
- **Negative outdent below 0** or **hanging indent** — clamped to 0..3
  positive integers.
- **Per-line list character formatting in DOCX** when char-format is
  also active — currently the run-property fragment applies to each
  line's runs uniformly; mixed formatting per line still requires
  inline selection.

## Phase 4-4 — OneNote-style visual tags

Phase 4-4 is the fourth Phase 4 slice — six OneNote-style visual tags
that decorate selected saved-reader messages with a glyph row and a
colored left-edge stripe.

### What this is NOT (read before reading anything else)

**Phase 4-4 visual tags are NOT Library metadata tags.**

- They do NOT write to `H2O.Studio.store.tags.*` or any tag-store API.
- They do NOT bind to chats. The tag persists per `(snapshotId, turnIdx)`
  on the overlay record, NOT to the snapshot's metadata or the Library's
  per-chat tag index.
- They do NOT show up anywhere else in the app — not in Library search,
  not in the Metadata tab's tag chips, not in folder sidebars.
- The Format-tab group is intentionally labelled **"Annotate"** (not
  "Tags") to keep the distinction visible in the UI.

These are decorative overlay annotations — render-time only, scoped to
the snapshot, undoable via Phase 2d's active-set, and exported through
the same overlay-aware paths as every other Phase 4 op.

### Op model

A single op type `visual-tag` carries a kind-discriminator + boolean.

| Op type      | Payload                                            | Reducer field       |
|--------------|----------------------------------------------------|---------------------|
| `visual-tag` | `{ kind: 'todo'\|'important'\|'question'\|'definition'\|'warning'\|'idea', enabled: boolean }` | `state.visualTags[kind] = !!enabled` |

| Field | Value |
|-------|-------|
| Target | `{ kind: 'message', turnIdx, messageId? }` (Phase 4-1 precedent) |
| Wins | Last active op of (`type='visual-tag'`, target, `payload.kind`) wins |
| Undo/redo | Phase 2d active-set filter applies for free; each tag click is one undoStack entry |
| `clear-formatting` reset | Yes — `defaultMessageState()` resets all six booleans |

Defensive reducer normalization: unknown `payload.kind` is a no-op (the
switch-case never touches state). This makes the op forward-compat with
any future kinds that older builds might encounter.

### Reducer state

```js
state.visualTags = {
  todo:       false,
  important:  false,
  question:   false,
  definition: false,
  warning:    false,
  idea:       false,
}
```

Six independent booleans so multiple tags can stack on one message
(OneNote precedent — a single paragraph can carry many tags).

### Canonical kind order, glyphs, hex

Used by the applier, serializer, DOCX writer, and CSS rules. Order is
fixed so DOM attribute strings + exports are deterministic regardless
of the order ops were submitted.

| Kind | Label | Glyph | Hex (no `#`) | CSS stripe priority |
|------|-------|-------|--------------|---------------------|
| `todo` | To Do | ☐ U+2610 | `3B82F6` (blue) | 4 |
| `important` | Important | ❗ U+2757 | `DC2626` (red) | 5 |
| `question` | Question | ❓ U+2753 | `7C3AED` (purple) | 3 |
| `definition` | Definition | 📖 U+1F4D6 | `0891B2` (teal) | 2 |
| `warning` | Warning | ⚠ U+26A0 | `D97706` (amber) | 6 (highest) |
| `idea` | Idea | 💡 U+1F4A1 | `CA8A04` (gold) | 1 (lowest) |

`warning` wins the cascade-collapse rule for the left-edge stripe when
multiple tags are active.

### DOM dispatch

The applier toggles two `data-overlay-*` attributes on the `[data-turn]`
wrapper:

```
data-overlay-visual-tags        — e.g. "todo important warning"
data-overlay-visual-tag-glyphs  — e.g. "☐ ❗ ⚠"
```

Both are built in canonical kind order (see table above), regardless of
op submission order. Both are removed atomically when zero tags active.

The pre-composed glyph string lets CSS render every active tag's icon
in ONE `::before` pseudo-element — the CSS-only single-pseudo limitation
is solved without any DOM injection. The applier still NEVER touches
the turn element's children.

### Markdown export mapping

A single bracketed prefix is prepended to the FIRST body line when any
visual tag is active:

```
[tags: To Do, Important]
```

- Labels use the human form, canonical order.
- Skipped entirely when zero tags active (zero extra characters in the
  output — important for clean diff-mode review).
- The prefix sits at the head of the body BEFORE list/code/quote/callout
  wraps, so per-line bullets and code fences still compose correctly.
- Future-compat: a "tag importer" could parse the bracketed prefix and
  restore overlay ops on read.

### DOCX export mapping

A leading **bold colored run** is prepended to the FIRST body paragraph
(or first body line in multi-line list/quote/plain branches):

```xml
<w:r>
  <w:rPr><w:b/><w:color w:val="DC2626"/></w:rPr>
  <w:t xml:space="preserve">☐ ❗ </w:t>
</w:r>
```

- Glyphs concatenated with spaces, in canonical order.
- Run color = the first canonical-order active kind's hex value.
- Composes with Phase 2b code (`Consolas` rFonts) and Phase 4-1
  character formatting in adjacent runs — they live in different `<w:r>`
  elements so the rPr fragments don't bleed.
- Emitted on the first body paragraph ONLY. Multi-paragraph messages
  show one glyph row at the top (matching the on-screen treatment via
  CSS `::before`).
- Inside `callout`, the leading run lives at the head of the first
  IntenseQuote body paragraph, after the `[!kind]` callout marker.

### Screen + print CSS mapping

```
[data-overlay-visual-tag-glyphs]::before { content: attr(...); ... }
[data-overlay-visual-tags~="warning"]    { box-shadow: inset 3px 0 0 #D97706; }
... (one rule per kind, priority order ensures warning wins cascade)
```

Print rules mirror screen with `!important` overrides; Chromium honors
`box-shadow` in print by default.

### Ribbon UI

```
Format tab:
  Headings:   H1  H2  H3
  Font:       B  I  U  S  Clear
  Text Color: Red  Green  Blue  Orange  Gray  None
  Highlight:  Blue Red Green Gold Sky Pink Purple Orange | Clear | Hide
  Paragraph:  Bullet  Numbered  |  Left  Center  Right  |  Indent  Outdent
  Blocks:     Quote  Code  Callout
  Annotate:   To Do  Important  Question  Definition  Warning  Idea  |  Clear tags  ← Phase 4-4
  Cleanup:    Clean spacing
```

**Group label is "Annotate" (NOT "Tags")** — see "What this is NOT" above.

| Action id | Behaviour |
|-----------|-----------|
| `visual-tag-todo` ... `visual-tag-idea` | Toggle one kind on/off via `visual-tag` op |
| `visual-tag-clear` | Loop active kinds; submit `enabled:false` op per kind |

All seven use `formatActionsIsEnabled` (saved-reader + selected turn +
bridge installed). Toggle handlers read current state via
`H2O.Studio.RibbonBridge.getMessageStateForTurn(turnIdx).visualTags[kind]`.

**Clear tags submits N ops (one per active kind), not one composite op.**
This means undoing "Clear tags" restores tags one at a time. Documented
here so users + reviewers don't expect single-undo behaviour. The
trade-off is reducer simplicity: a single composite payload would
require a special-case "__all__" sentinel that the reducer would have
to interpret, which we explicitly chose to avoid.

### Status string canon (Phase 4-4)

| Outcome | Status |
|---------|--------|
| Toggle on | `<Label> tag applied` |
| Toggle off | `<Label> tag removed` |
| Clear tags (≥1 active) | `All tags removed` |
| Clear tags (none active) | `No tags to remove` |
| Missing selection | `Select a message first` |
| Bridge drift | (existing drift hint flows through `runOverlayOp`) |
| Failure | `<Label> tag failed` / `Clear tags failed` |

### Compliance notes for Phase 4-4

- **No new storage keys.** No new schema. No schema migration.
- **No `H2O.Studio.store.tags.*` writes.** No `H2O.Library.Tags.*`
  writes. No `H2O.Studio.store.chats` metadata writes.
- No `chrome.*` / `localStorage` / `sessionStorage` / `indexedDB` /
  `fetch(` introduced.
- No `contentEditable` / inline text-range selection.
- No snapshot mutation. The applier still only toggles `data-overlay-*`
  attributes on `[data-turn]` wrappers.
- No platform-adapter changes; ribbon uses the existing `runOverlayOp`
  bridge plumbing.
- No new Tauri capability, no new Rust dep, no plugin install.
- The new `visual-tag` op passes through Phase 2d's active-set undo/redo
  unchanged — reducer iterates ops in original order and applies the
  same "last active op of (type, target, kind) wins" rule.

### Out of scope for Phase 4-4 (deferred to later phases)

- **Custom tag definitions** — palette is fixed at 6 kinds.
- **Tag rename / recolor from the Ribbon** — palette colors are
  hardcoded in three places (applier, DOCX writer, CSS) to keep them
  visually consistent across surfaces; a future slice could expose a
  palette-editing UI without contract changes.
- **Library-tag binding** — explicitly NOT in scope. If a future feature
  wants to bridge visual-tag → metadata-tag, it must do so via the
  Library's existing public APIs from a NEW ribbon action; it must NOT
  collapse the two storage layers.
- **Inline tag attribution** (tag a word / phrase, not the whole turn) —
  requires inline selection (Phase 4e).
- **PDF / DOCX tag-as-comment** annotations — current Phase 4-4 emits
  visible glyph runs; "comments" are a different OOXML feature and
  out of scope.
- **Tag-filtered reader view** ("show only To Do") — out of scope; the
  user can already scroll/search.

## Phase 5b-1 — inline Bold / Italic (reader-only)

Phase 5b-1 is the first inline (sub-message text-range) formatting slice.
It adds **inline Bold and Italic only** for a selected text range inside a
single saved-reader message, built on the Phase 5a passive selection
anchors. Reader-only: **no export support yet** (Markdown/DOCX/PDF do not
render inline B/I in this slice). No underline / strikethrough / color
inline yet. No contentEditable. No snapshot mutation.

### Relationship to Phase 4-1 (message-level Bold/Italic)

Phase 4-1 bold/italic are **whole-turn** booleans (`data-overlay-bold` on
the turn wrapper, CSS bolds the entire body). Phase 5b-1 is a separate,
**range-scoped** layer. The two coexist as independent decoration
channels:

- The ribbon's B / I buttons are now **selection-aware**: with a valid
  inline selection on the selected turn they submit an `inline-format`
  op; otherwise they preserve the Phase 4-1 message-level toggle exactly.

### Op model

| Field | Value |
|-------|-------|
| `type` | `inline-format` |
| `target` | `{ kind: 'inline', turnIdx, messageId, anchor: { textQuote, textPos, xpath } }` (anchor is the verbatim Phase 5a capture anchor) |
| `payload` | `{ style: 'bold' \| 'italic', enabled: boolean }` |
| `inverse` | `{ style, enabled: <prev coverage> }` (forward-compat metadata) |

`target.anchor.textPos = { start, end }` are integer offsets into the
**message element's flattened text** (the same coordinate space Phase 5a
captured against). All inline ops on a message share that space, so the
reducer can operate purely on integers.

### Interval reducer (`computeInlineState`)

`H2O.Studio.overlay.computeInlineState(overlay, turnIdx)` reduces active
`inline-format` ops into two merged, sorted, non-overlapping integer
interval sets:

```
{ bold: [[start,end], …], italic: [[start,end], …] }
```

- `enabled:true` → `unionInterval` the anchor's `[start,end)` into the set.
- `enabled:false` → `subtractInterval` (may split an interval).
- Active-set aware (Phase 2d): ops not in `undoStack` are skipped, so
  undo/redo works with zero new machinery.
- `clear-formatting` (Phase 4-1 message reset) **also clears inline
  intervals** for the turn at its point in op order.

Pure interval helpers exposed: `mergeIntervals`, `unionInterval`,
`subtractInterval`, `intervalsCover` (the last is used by the ribbon to
decide toggle-off vs toggle-on for a selected range).

### Render strategy (idempotent, reader-only)

`studio.js` runs an inline render pass immediately after every
`ov.applyOverlay` call (initial reader mount, after a forward op, and
after undo/redo). The pass:

1. **Unwraps** every prior `[data-overlay-inline]` element in scope
   (hoist children + `normalize()`), giving a clean slate.
2. **Skips on drift** — if `overlay.baseDigest !== computeBaseDigest(snap)`
   it returns without wrapping (mirrors the applier's no-op-on-drift
   invariant).
3. For each `[data-turn]`, reduces `computeInlineState`, then for each
   interval resolves a live `Range` via the Phase 5a `posToRange`
   (offset-based; text content is invariant under wrapping so offsets
   stay valid across successive wraps) and wraps it in
   `<strong data-overlay-inline="bold">` / `<em data-overlay-inline="italic">`.
4. Wrapping is **per-text-node** (the highlighter's proven `splitText`
   technique — never `surroundContents`), skips slices already inside a
   same-style wrapper, and supports bold⊗italic overlap via clean
   nesting.
5. **Counts skipped** intervals (unresolved / length-mismatch) without
   throwing.

A range-returning resolver `H2O.Studio.inlineSelection.resolveToRange(anchor, rootEl)`
was added (Phase 5a's `resolve()` returns only metadata). It reuses the
same three-tier strategy (textQuote → textPos → xpath).

### Selection handling (ribbon)

Clicking a ribbon button blurs the reader and collapses
`window.getSelection()`. studio.js therefore snapshots the **last
successful** `capture()` on `selectionchange` into a held value
(`getHeldCapture()`), never overwriting it with a failure. The B / I
handler validates the held capture's `selectedTurnIdx` matches the
ribbon's selected turn before using it; otherwise it falls back to
message-level.

### Drift / degraded behaviour

- Overlay-level `baseDigest` drift → the whole applier (and the inline
  pass) no-ops; inline ops ride along untouched in the log.
- A single interval that fails to resolve (offset/length mismatch) is
  **skipped and counted**; the op is never deleted (overlay
  "never-destroy-ops" invariant).
- No offset rebasing in 5b-1.

### Status strings

- `Bold applied to selection` / `Bold removed from selection`
- `Italic applied to selection` / `Italic removed from selection`
- Message-level fallback strings (`Bold applied`, `Bold removed`, …)
  unchanged.

### Out of scope for 5b-1

- **Export** (Markdown `**`/`*`, DOCX run-segmentation, PDF/print spans)
  — deferred to a later 5b/5d slice. Inline B/I is reader-only here.
- **Underline / Strikethrough / Color inline** — message-level only for
  now.
- **Rich-turn full parity** — canonical reader DOM is the primary target;
  rich-turns resolve via textQuote where possible and skip otherwise.
- **contentEditable**, **multi-message ranges**, **offset rebasing**.

### Compliance notes for 5b-1

- No new storage keys. No schema migration. The `inline-format` op rides
  the existing EditOverlay op stream + Phase 2d active-set undo/redo.
- No snapshot mutation. The render pass mutates only the live reader DOM
  (rebuilt from snapshot on every mount; injected spans are disposable).
- No `chrome.*` / `localStorage` / `sessionStorage` / `indexedDB` /
  `fetch`. No provider/network work.
- No highlight-system changes; inline spans coexist with `<mark>` spans.

## Phase 5c-1 — inline Underline / Strikethrough / range Clear (reader-only)

Phase 5c-1 extends the Phase 5b-1 inline model with two more boolean
character styles and a range-scoped clear. **Reader-only — no export.**
**No inline text color** (that is Phase 5c-2). No new op type — reuses
`inline-format`.

### Op model (extends 5b-1)

`inline-format` payload gains two boolean styles + one clear style:

| Payload | Reducer field | Reduction |
|---------|---------------|-----------|
| `{ style:'underline', enabled }` | `underline: [[s,e]…]` | union (true) / subtract (false) |
| `{ style:'strikethrough', enabled }` | `strikethrough: [[s,e]…]` | union / subtract |
| `{ style:'clear-inline' }` | — | subtract anchor `[s,e)` from **all four** boolean sets (bold/italic/underline/strikethrough), range-scoped |

Target shape unchanged: `{ kind:'inline', turnIdx, messageId, anchor }`.

### Reducer (`computeInlineState` extended return)

```
{ bold:[[s,e]], italic:[[s,e]], underline:[[s,e]], strikethrough:[[s,e]] }
```

- Underline/Strikethrough use the same `unionInterval` / `subtractInterval`
  / `mergeIntervals` helpers + active-set filter as bold/italic.
- `clear-inline` subtracts the selected range from all four sets; intervals
  **outside** the range are preserved (split as needed). It does **not**
  touch message-level decorations.
- Message-level `clear-formatting` (Phase 4-1, `target.kind:'message'`)
  still wipes **all** inline interval sets for the turn.

### Render (studio.js render pass)

- The styles loop now wraps four channels in a fixed order
  (bold → italic → underline → strikethrough) so DOM nesting is
  deterministic and the unwrap-then-rewrap pass stays idempotent.
- Tag map: `underline → <u data-overlay-inline="underline">`,
  `strikethrough → <s data-overlay-inline="strikethrough">`.
- **Underline + strikethrough combine** via nested `<u><s>` — CSS uses
  `text-decoration-line` (not the shorthand), so each element contributes
  its own line and both render together.
- Per-text-node wrapping with same-style skip-guard (5b-1) unchanged;
  drift / unresolved-anchor skip unchanged.

### Ribbon

- **U / S buttons** are now inline-aware (reuse `buildFontHandler`): valid
  held inline selection on the selected turn → `inline-format` toggle
  (off when the range is already fully covered); otherwise → existing
  Phase 4-1 message-level toggle.
- **Clear formatting** is selection-aware: valid held inline selection →
  `inline-format { style:'clear-inline' }` (range-scoped); otherwise →
  existing whole-turn `clear-formatting` reset.

### Status strings

`Underline applied to selection` / `Underline removed from selection`,
`Strikethrough applied to selection` / `… removed from selection`,
`Inline formatting cleared`. Message-level fallback strings unchanged.

### Out of scope for 5c-1

- **Inline text color** (Phase 5c-2 — value/paint model).
- **Export** (Markdown/DOCX/PDF) — deferred to 5d run-segmentation.
- contentEditable, snapshot mutation, new storage keys.

### Compliance notes for 5c-1

- No new op type; no `overlay-keys.js` change. Reuses `inline-format`.
- No snapshot mutation; render pass touches only the live reader DOM.
- No `chrome.*` / `localStorage` / `sessionStorage` / `indexedDB` /
  `fetch`; no platform/Tauri/MV3/tooling changes.

## Phase 5c-2 — inline Text Color (reader-only)

Phase 5c-2 adds a fifth inline channel — **text color** — for a selected
text range. Unlike the four boolean inline styles (bold/italic/underline/
strikethrough), color is a **value/paint** model: each segment carries a
`kind`, and overlapping paints resolve **last-wins**. **Reader-only — no
export.** No new op type — reuses `inline-format`.

### Op model

`inline-format` payload gains a value-carrying style:
```
{ style: 'text-color', kind: 'red'|'green'|'blue'|'orange'|'gray'|null }
```
- `kind: <name>` → paint that color over the anchor range (last-wins).
- `kind: null` → clear color over the range (the "None" swatch).
- No `enabled` field — `kind:null` is the clear signal.

Target shape unchanged: `{ kind:'inline', turnIdx, messageId, anchor }`.

### Reducer — cut-then-paint

`computeInlineState` return shape gains a fifth key:
```
{ bold:[[s,e]], italic:[[s,e]], underline:[[s,e]], strikethrough:[[s,e]],
  textColor:[ { start, end, kind }, … ] }   // sorted, non-overlapping
```

New pure helpers (exposed on `H2O.Studio.overlay`):
- `cutColorSegments(segments, s, e)` — remove `[s,e)` from every segment,
  splitting as needed (color analogue of `subtractInterval`, preserves `kind`).
- `paintColor(segments, s, e, kind)` — `cut` then append `{start:s,end:e,kind}`,
  sort by `start`, coalesce adjacent same-kind. Yields last-wins.
- `colorAt(segments, s, e)` — the single kind if `[s,e)` is uniformly one
  color, else null (color analogue of `intervalsCover`; optional active-swatch).

Reducer branch: `text-color` with a known kind paints; with `null`/unknown
cuts. **`clear-inline` (5c-1)** now also cuts color segments over the range
(in addition to subtracting the four boolean sets). **Message-level
`clear-formatting`** resets `textColor` to `[]` alongside the boolean sets.

Active-set undo/redo applies for free — undone color ops aren't seen by the
reducer, so the segment set recomputes correctly.

### Rendering (value-aware spans)

- Color segments render as
  `<span data-overlay-inline="text-color" data-overlay-inline-color="red">`.
- `wrapRange(range, 'text-color', kind)` uses `<span>` + sets both attributes.
- **Value-aware skip-guard:** a slice is skipped only when already inside a
  `[data-overlay-inline-color="<kind>"]` of the SAME color — so a same-color
  re-render does not duplicate, while red→blue re-wraps correctly after the
  unwrap-then-rewrap pass.
- Color is applied **after** the four boolean channels (innermost `<span>`),
  giving deterministic nesting + idempotent re-render.
- The all-empty early-out guard now also checks `textColor.length`, so a
  color-only message still renders.
- Stale-anchor / baseDigest-drift skip behaviour unchanged.

### CSS

Five screen rules pin the inline color hex to the Phase 4-2 palette
(`red #C53030, green #2F855A, blue #2C5282, orange #C05621, gray #4A5568`).
The inline span (element-level) overrides the message-level
`data-overlay-text-color` body color over its range by specificity.

### Ribbon

The Text Color swatches become inline-aware (reuse the held-capture
routing): valid held inline selection → `inline-format { style:'text-color',
kind }`; None → `kind:null` (clear over range); no inline selection →
existing Phase 4-2 message-level `text-color` op unchanged. Clicking a color
always paints (last-wins, no toggle-off-on-same-color — matches message-level).

### Status strings

`Text color: red (selection)` … `Text color: gray (selection)`,
`Text color cleared (selection)`. Message-level fallback strings unchanged.

### Interactions

- **Message-level text color** (turn attribute, whole body) + inline color
  span compose; inline overrides over its range by specificity.
- **Highlight spans** (`<mark>`, background) are independent of color
  (foreground); the inline unwrap pass only removes `[data-overlay-inline]`,
  never `<mark>`.

### Out of scope for 5c-2

- **Export** (Markdown lossy; DOCX `<w:color>` via 5d run-segmentation;
  PDF/print color CSS) — deferred to 5d.
- contentEditable, snapshot mutation, new storage keys, `overlay-keys.js`
  change, platform/Tauri/MV3/tooling changes.

### Compliance notes for 5c-2

- No new op type; no `overlay-keys.js` change. Reuses `inline-format`.
- No snapshot mutation; render pass touches only the live reader DOM.
- No `chrome.*` / `localStorage` / `sessionStorage` / `indexedDB` / `fetch`;
  no serializer/DOCX-writer changes; no platform changes.

## Phase 5d-1 — inline export: Markdown / Copy clean transcript

Phase 5d-1 is the first inline-export slice. It teaches the Markdown
serializer (which also backs **Copy clean transcript**) to represent
inline Bold / Italic / Underline / Strikethrough on selected ranges.
**Text color stays intentionally lossy in Markdown.** DOCX (5d-2) and
PDF/print (5d-A) inline export are **deferred** — not in this slice.

### Shared inline-run segmenter

`H2O.Studio.overlay.buildInlineRuns(bodyText, messageState, inlineState, opts)`
→ `{ ok, runs:[{ text, bold, italic, underline, strikethrough, textColor }], reason? }`.

- **Pure** (no DOM, no I/O, never throws). Folds message-level character
  formatting (treated as a full-range `[0,len)` base layer) + the inline
  interval/segment state from `computeInlineState` into a single ordered
  list of **non-overlapping runs**, each with a flat style tuple. This
  guarantees well-formed output even for overlapping/crossing inline
  ranges.
- Designed to be reused by the DOCX writer in 5d-2 (run segmentation) —
  the same boundary/segment math.

### Coordinate-space reconciliation (degrade-safe)

Inline offsets are in the message's **flattened rendered-text** space; the
serializer body is the **trimmed** raw `msg.text`. The serializer passes
`opts.offsetAdjust` = the count of leading whitespace trimmed from the
raw text, so offsets rebase onto the body. If ANY rebased endpoint falls
outside `[0, bodyText.length]`, `buildInlineRuns` returns `ok:false` and
the serializer **falls back to its existing message-level path** — never
emitting corrupted markup. Inline export is additionally **skipped** when:

- `state.code` is set (fenced code stays literal — inline suppressed),
- `state.cleanSpacing` changed the body (coordinate base shifts),
- there are no inline ranges for the turn.

### Markdown mapping

| Run style | Markdown |
|-----------|----------|
| bold | `**text**` |
| italic | `*text*` |
| underline | `<u>text</u>` (inline HTML; Markdown has no native underline) |
| strikethrough | `~~text~~` |
| text color | **no output (lossy, documented)** |

Each run is wrapped independently in the fixed nesting order (bold
innermost → strikethrough outermost), matching the Phase 4-1 whole-body
wrapper order. Wrapping is applied **per line within a run** so markers
never span newlines — this keeps output well-formed and lets the Phase
4-3 list per-line prefixer work unchanged. Crossing/overlapping ranges
produce balanced-per-run markers (occasionally redundant adjacent
markers, which renderers collapse) rather than improper nesting.

### Interaction with existing formatting

- **Message-level B/I/U/S** is folded into the segmenter (full-range base
  layer), so it is no longer double-applied; output is equivalent.
- **When no inline ranges exist**, the serializer uses its existing
  message-level path **byte-for-byte** (no behavioral change; existing
  2e/3a output unchanged).
- **Lists** — runs are produced first (newline-aware), then the per-line
  `- ` / `N. ` prefix is applied; the per-line message-level re-wrap is
  skipped when inline runs were used.
- **Quote / Callout** — applied around the already-marked body.
- **Visual tags** — the `[tags: …]` prefix is prepended AFTER inline
  segmentation (unstyled), so offsets stay aligned.
- **Copy clean transcript** flows through the same `serialize`, so it
  gains inline markers automatically.

### Out of scope for 5d-1

- DOCX inline export (5d-2 run-segmentation, incl. `<w:color>`).
- PDF/print inline export + print CSS (5d-A).
- A non-lossy Markdown color mapping (e.g. `<span style="color:…">`) —
  not implemented; would need explicit approval.
- contentEditable, snapshot mutation, new storage keys, ribbon/DOM/render
  changes, platform/Tauri/MV3/tooling changes.

### Compliance notes for 5d-1

- No new op type; no `overlay-keys.js` change. Reuses `inline-format` +
  `computeInlineState`.
- No snapshot mutation; serializer is pure (no DOM, no storage).
- No `chrome.*` / `localStorage` / `sessionStorage` / `indexedDB` /
  `fetch`; no DOCX-writer/CSS/ribbon/studio.js changes.

## Phase 5d-2 — inline export: DOCX

Phase 5d-2 brings DOCX export to parity with the reader + Markdown by
serializing inline Bold / Italic / Underline / Strikethrough / Text Color
as **segmented `<w:r>` runs**. It reuses the committed shared segmenter
`H2O.Studio.overlay.buildInlineRuns` (Phase 5d-1). **No Markdown / PDF /
print / Ribbon changes.**

### Run segmentation

- `emitTurnXml(turn, state, inlineState)` now receives the inline state
  (computed in `build()` via `computeInlineState(overlay, turnIdx)`).
- When the turn has inline ranges (and is **not** code or clean-spacing),
  it calls `buildInlineRuns(body, state, inlineState, { offsetAdjust })`,
  where `offsetAdjust` = the leading-whitespace delta from the raw
  `turn.source.text` (now retained by `buildRawTurns`). This reconciles
  the inline anchor offsets (flattened rendered-text space) onto the
  trimmed DOCX body, identical to the Phase 5d-1 serializer.
- The returned runs are split by line (`splitRunsByLine`) into a per-body-
  line array of sub-runs so **paragraph count is unchanged** (one
  paragraph per body line, including blank lines). Each sub-run is emitted
  as its own `<w:r>` via `emitRunsXml` → `runXml`, preserving
  `xml:space="preserve"`; empty runs are skipped.

### Per-run rPr mapping

`runRPr(run)` builds the run's `<w:rPr>` from its flat flags in the fixed
order **b → i → strike → u → color** (identical to `charFormatRPr`):

| Run flag | OOXML |
|----------|-------|
| bold | `<w:b/>` |
| italic | `<w:i/>` |
| strikethrough | `<w:strike/>` |
| underline | `<w:u w:val="single"/>` |
| textColor | `<w:color w:val="HEX"/>` (`TEXT_COLOR_HEX`; unknown → omitted) |

`combineRProps(baseRProps, runRPr(run))` keeps any paragraph-invariant
base (e.g. a font face) first, then the per-run character props. Because
`buildInlineRuns` folds message-level formatting into the runs as a
full-range base layer, the writer does **NOT** additionally apply the
message-level `charRPr` to body runs when inline is used (avoids
double-application).

### Paragraph-path interactions (all preserved)

- **plain / quote / callout / bullet / numbered list** — runs emitted
  inside the existing per-line paragraphs; pStyle (`IntenseQuote`,
  `ListBullet`, `ListNumber`) unchanged.
- **align / indent** — `<w:pPr>` (`<w:jc>` / `<w:ind>`) unchanged
  (paragraph-level); runs nest inside.
- **visual-tag leading run** — unchanged; still the first run on the
  first body line.
- **code blocks** — inline **suppressed**; the existing single Consolas
  run with message-level `charRPr` is preserved (code stays literal).
- **heading** — role-label paragraph unchanged; only body runs segmented.

### Degradation rules

- `buildInlineRuns` returns `ok:false` (offset out-of-range / can't
  reconcile) → `useInline=false` → existing single-run-per-line path
  (message-level `charRPr`). Never corrupted XML.
- No inline ranges for the turn → existing output **byte-for-byte**
  (existing Phase 3c DOCX behavior unchanged).
- `state.code` or `state.cleanSpacing` → inline suppressed.

### Out of scope for 5d-2

- Markdown / Copy clean transcript (delivered in 5d-1; unchanged here).
- PDF / print inline CSS (5d-A, deferred).
- contentEditable, snapshot mutation, new storage keys, ribbon/DOM/render
  changes, platform/Tauri/MV3/tooling changes.

### Compliance notes for 5d-2

- No new op type; no `overlay-keys.js` change. Reuses `inline-format` +
  `computeInlineState` + the committed `buildInlineRuns`.
- No snapshot mutation; the writer is pure (no DOM, no storage, no I/O).
- No `chrome.*` / `localStorage` / `sessionStorage` / `indexedDB` /
  `fetch`; no serializer/CSS/ribbon/studio.js/platform changes.
- ZIP stays stored-mode (method 0); CRC32 + XML-validity unaffected.

## Phase 5d-A — inline export: PDF / Print

Phase 5d-A completes the Phase 5d inline-export arc by ensuring inline
formatting survives the PDF / Print path. **CSS-only** — no JS, no
serializer/DOCX/ribbon changes.

### Why it's CSS-only

The PDF/Print bridge (`RibbonBridge.openPrintView`) prints the **live
reader DOM** via `window.print()`. That DOM already contains the inline
spans injected by the Phase 5b-1/5c-1/5c-2 render pass:

```
<strong data-overlay-inline="bold">…</strong>
<em     data-overlay-inline="italic">…</em>
<u      data-overlay-inline="underline">…</u>
<s      data-overlay-inline="strikethrough">…</s>
<span   data-overlay-inline="text-color" data-overlay-inline-color="red|green|blue|orange|gray">…</span>
```

So inline formatting is already *structurally* present in print. The only
gap was that the `@media print` block had **no rules** for
`[data-overlay-inline]`, so the print resets (notably the black-text
reset) could flatten inline color, and decoration/weight relied on UA
defaults. 5d-A adds the missing `@media print` rules.

### Rules added (in the existing `@media print` block)

| Selector (inside `[data-message-author-role]`) | Declaration |
|------------------------------------------------|-------------|
| `[data-overlay-inline="bold"]` | `font-weight: 700 !important` |
| `[data-overlay-inline="italic"]` | `font-style: italic !important` |
| `[data-overlay-inline="underline"]` | `text-decoration-line: underline !important` |
| `[data-overlay-inline="strikethrough"]` | `text-decoration-line: line-through !important` |
| `[data-overlay-inline="text-color"][data-overlay-inline-color="red"]` | `color: #C53030 !important` + `print-color-adjust: exact` + `-webkit-print-color-adjust: exact` |
| …green `#2F855A`, blue `#2C5282`, orange `#C05621`, gray `#4A5568` | same pattern |

`!important` wins against the `@media print` body/black-text resets;
`print-color-adjust: exact` (+ `-webkit-` prefix) prevents the print
pipeline from stripping the foreground color. Hex pinned to the DOCX
`TEXT_COLOR_HEX` map → identical PDF + DOCX + screen rendering.

### Interactions / non-disturbance

- Mirrors the committed screen selectors exactly (element-level spans
  inside `[data-message-author-role]`), placed right after the existing
  Phase 4-2 **message-level** text-color print rules — which are left
  untouched (message-level uses `[data-turn][data-overlay-text-color=…]`,
  a distinct selector).
- Underline + strikethrough on the same range nest as `<u><s>`; each
  contributes its own `text-decoration-line`, so both print.

### Out of scope for 5d-A

- Any JS / print-bridge change (none needed — print already uses the live
  DOM).
- Markdown / DOCX changes (delivered in 5d-1 / 5d-2; untouched).
- Ribbon / reader-render / platform / storage changes.

### Compliance notes for 5d-A

- CSS-only; no snapshot mutation, no JS, no storage, no new keys.
- No `chrome.*` / `localStorage` / `sessionStorage` / `indexedDB` /
  `fetch`. No serializer/DOCX-writer/ribbon/studio.js/platform changes.

## Compliance checklist (per-PR; Phase 2a and beyond)

- [ ] No `chrome.*` reference in the diff outside `studio/platform/`.
- [ ] No `localStorage`/`sessionStorage`/`indexedDB`/`idb` reference outside `studio/platform/`.
- [ ] No mutation of `snap.messages` or `state.currentReaderSnapshot.messages` in overlay code.
- [ ] No mutation of captured DOM elements in the applier.
- [ ] Every storage key starts with `h2o:studio:`.
- [ ] Every overlay record passed to `upsert` has `baseDigest` set.
- [ ] `applyOverlay` returns within ≤1 ms on null/empty/drift inputs.
- [ ] `applyOverlay` does not throw — all branches catch.
- [ ] `schemaVersion` matches the current version.

## Cross-document map

- `STUDIO_STORAGE_CONTRACT.md` — overall persistence façade rules; the
  `editOverlay` entity slot is listed there for completeness.
- `STUDIO_DEVELOPMENT_RULES.md` — Studio-wide development rules
  (chrome.*/localStorage/etc bans). Overlay inherits all of those.
- `STUDIO_PORTABILITY_CONTRACT.md` — Tauri-readiness rules. Overlay is
  Tauri-ready: all I/O routes through `platform.storage`.
- `overlay/README.md` — Phase 2a scope and load order.
