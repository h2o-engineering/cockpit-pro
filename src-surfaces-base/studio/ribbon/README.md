# Studio Ribbon

Phase: **1a — passive shell only**.

A OneNote-inspired tabbed action bar that sits above the Studio reader. Surfaces
edit/format/organize/view/export actions for the **currently opened chat**.

## Engineering Lane boundary

`L-STUDIO-APPLICATION-SHELL` owns the Ribbon host's structural placement and
geometry, including its relationship to Desktop chrome, `.wbShell`,
`.wbStage`, `.wbTop`, and the top safe area. The Lane does not own the meaning
of Ribbon actions.

Studio Authoring owns authoring/editing action semantics, Cockpit Library owns
Library organization/action semantics, Reader owns opened-conversation
consumption behavior, and Host Integration owns any Tauri/MV3 bridge behind a
host-backed action. `S0Y1a` Studio Ribbon, `studio.html`, `studio.css`, and
`studio.js` are shared hotspots: cross-Lane work uses one home semantic owner
plus a temporary narrow lease for the exact Ribbon slot or action wiring. No
shared file creates co-primary ownership.

## What this folder owns

- `ribbon-keys.js` — frozen constants (storage key strings, event names, tab ids,
  chat-type constants). No state, no DOM, no I/O.
- `ribbon-shell.studio.js` — passive tab/group/action registry + chat-type
  context tracker + UI-state persistence (active tab, collapsed) via
  `H2O.Studio.store.prefs`. **mount/unmount are no-op stubs in Phase 1a** —
  the surface module (`S0Y1a. 🎬 Studio Ribbon - Studio.js`) performs the
  actual DOM mount.

## What this folder does NOT do (Phase 1a)

- Does not mutate chat, snapshot, folder, label, tag, project, or category data.
- Does not write any storage key outside `h2o:studio:ribbon:*`.
- Does not call `chrome.*`, `localStorage`, `indexedDB`, or `fetch`.
- Does not reach into the ChatGPT replay DOM (`cgScroll`, `cgThread`, etc.).
- Does not duplicate Command Bar (system/diagnostics) or Side Actions
  Panel (user-facing per-chat persistent lists) responsibilities.

## Visibility model

The ribbon is visible only when the **currently opened context is a chat**:

| Route / state                                            | chatType  | ribbon |
| -------------------------------------------------------- | --------- | ------ |
| `#/read/<snapshotId>` with snapshot loaded               | `saved`   | shown  |
| `#/linked` with linked-reader placeholder shown in-page  | `indexed` | shown  |
| `#/saved`, `#/pinned`, `#/archive`, `#/linked` (list)    | `null`    | hidden |
| `#/library/*`, `#/settings`, `#/migrate/*`               | `null`    | hidden |
| Reader load failed (no snapshot)                         | `null`    | hidden |

`imported` and `readonly` chat-type constants are reserved for future phases
when the snapshot record carries a discriminator for them.

## Desktop/Tauri chrome invariant

Desktop/Tauri re-homes the ribbon into the app chrome row above `.wbShell`.
Any change to ribbon visibility must preserve the sidebar/topbar geometry rules
in `../STUDIO_DEVELOPMENT_RULES.md`:

- Showing or hiding a ribbon menu strip must not move the sidebar logo/title row.
- Hidden Library and hidden reader/chat ribbon menu strips use the same model:
  the desktop chrome is out of normal flow, while the sidebar and right pane own
  their own mac-safe empty space.
- Hidden reader/chat ribbon menu strips must also leave the reader title topbar
  below its mac-safe empty space; hiding the ribbon menu must not pull that
  titlebar up to the traffic-light row.
- Do not implement a hidden ribbon by adding a full-width transparent, blurred,
  glass, or separate strip above `.wbShell`; that breaks the sidebar background
  and divider continuity.
- Ribbon menu controls can sit in the draggable top strip, but buttons/inputs
  must remain `-webkit-app-region: no-drag`.

## Boot order

Loaded from `studio.html` in this sequence:

1. `dock/dock-keys.js` (existing)
2. **`ribbon/ribbon-keys.js`** (new)
3. `store/prefs.js` (existing)
4. `dock/dock-shell.studio.js` (existing)
5. **`ribbon/ribbon-shell.studio.js`** (new) — passive registry only
6. ... rest of Studio modules ...
7. `S0X1a. Command Bar - Studio.js`
8. `S0X1b. Library Commands (Command Bar Plugin) - Studio.js`
9. **`S0Y1a. 🎬 Studio Ribbon - Studio.js`** (new) — surface module: registers
   the 7 default tabs + placeholder actions, mounts DOM into `#studioRibbon`,
   listens for context changes from `studio.js`
10. ... `S0Z1*` sidebar modules, then `studio.js`

## State / prefs keys

Studio-local only (enforced by `H2O.Studio.store.prefs`):

- `h2o:studio:ribbon:active-tab:v1` — string id of the active tab, or `null`
- `h2o:studio:ribbon:collapsed:v1` — boolean

## Tab catalogue (Phase 1a placeholders)

All actions in Phase 1a are **disabled placeholders** with title `Coming soon`.

| Tab        | Groups (sample)                                                       |
| ---------- | --------------------------------------------------------------------- |
| Home       | Rename chat · Copy title · Undo/redo · Open original (indexed)        |
| Format     | Headings · Quote/Code/Callout · Clean spacing                         |
| Structure  | Section · Split · Collapse · Divider · TOC                            |
| AI Tools   | Summarize · Tasks · Tags · Rewrite · Study notes                      |
| Metadata   | Tags · Category · Project · Status · Source link                      |
| View       | Compact · Focus · Timestamps · MiniMap · Reading width                |
| Export     | Copy clean · Markdown · PDF · DOCX · Print                            |

For indexed (linked) chats only `Home`, `Metadata`, `View`, `Export` tabs are
shown; the other tabs are not rendered for that chat type.

## Contracts

- `src-surfaces-base/studio/STUDIO_ARCHITECTURE.md`
- `src-surfaces-base/studio/STUDIO_DEVELOPMENT_RULES.md`
- `src-surfaces-base/studio/STUDIO_PORTABILITY_CONTRACT.md`
- `src-surfaces-base/studio/STUDIO_STORAGE_CONTRACT.md`
