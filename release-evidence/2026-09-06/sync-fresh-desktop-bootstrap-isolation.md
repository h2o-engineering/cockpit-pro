# Fresh-Desktop Sync Bootstrap Runtime Isolation

Date: 2026-09-06
Lane: L-SYNC
Origin: Saved-Chat Recovery Center T07 cross-lane dependency correction
Branch: `work/sync-fresh-desktop-bootstrap-isolation-20260906`
Base: `755a1092b91ea6afa8905c97c1ddac2e1b4ee244` (main, clean)

## Bug Summary

A completely fresh Desktop identity — new Tauri bundle identifier, isolated
`app_local_data_dir()`, isolated fresh SQLite DB, and **no persisted**
`h2o:studio:sync:config:v1` — still imported shared production-derived Sync
data on first launch.

Saved-Chat T07 observed a disposable Desktop store come up with 41 chats /
28 snapshots matching the shared `chrome-latest.json` payload, with no
Recover-as-New action executed and with destination DB/archive/CAS isolation
proven correct.

## Root Cause

`src-surfaces-base/studio/sync/folder-sync.tauri.js` treated an **absent**
config as implicit historical opt-in to automatic sync:

```
defaultConfig()                       -> { mode: 'auto', folderPath: 'H2O Studio Sync' }
getConfig()  (raw absent)             -> returns that default verbatim
boot-time auto-start (module tail)    -> mode 'auto' + folderPath truthy -> startWatcher()
readOptionsForPath('H2O Studio Sync') -> relative -> { baseDir: BaseDirectory::Home (21) }
runWatcherTick -> scanFolderOnce      -> $HOME/H2O Studio Sync/chrome-latest.json
mode 'auto' + chrome-latest.json      -> runDesktopAutoImport
                                      -> importChromeLatestFromFile
                                      -> importChromeLatestBundle
                                      -> H2O.Studio.ingestion.importBundle(..., 'merge', ...)
```

The `mode: 'auto'` / `folderPath: SYNC_FOLDER_NAME` default was introduced by
`02a1e7a6` ("fix(sync): automate folder sync propagation", 2026-06-22), which
replaced the original `{ mode: 'off', folderPath: '' }` default. That commit's
own design record (`release-evidence/2026-06-22/folder-auto-sync-triggers.md`)
scopes the Phase 3 change to **persisted** configs:

> "Legacy persisted `mode: "manual"` configs without that marker migrate to
> effective `mode: "auto"` with the default `H2O Studio Sync` folder."

Absence was never in scope. Flipping `defaultConfig()` made every Desktop
identity with no persisted config — which is exactly what a fresh identity is —
silently auto-import whatever the shared HOME-relative sync folder held.

Address isolation was never the problem: `app_local_data_dir()` and the DB path
both follow the bundle identifier correctly. The unisolated input was the
Home-relative Sync bootstrap, which is deliberately **not** identifier-scoped.

## Files Changed

- `src-surfaces-base/studio/sync/folder-sync.tauri.js`
- `tools/validation/sync/validate-folder-sync-fresh-desktop-bootstrap-isolation.mjs` (new)
- `tools/validation/sync/validate-f19-desktop-chrome-propagation.mjs`
- `release-evidence/2026-09-06/sync-fresh-desktop-bootstrap-isolation.md` (this file)

## Correction

`defaultConfig()` returns `mode: 'off'`, `folderPath: ''` — restoring the
pre-Phase-3 default so that an absent config is explicitly *unconfigured*. The
Phase 3 marker (`phase3AutoSyncConfigVersion`) stays in the default object so
persisted-config version comparison is unchanged.

Nothing else moved. In particular the following are untouched and were proven
to still hold:

- `getConfig()` merges a persisted record over the default, so every persisted
  mode wins verbatim.
- The Phase 3 legacy migration still keys off a **persisted** `mode: 'manual'`
  without the version marker, and still migrates it to effective auto with the
  default sync folder.
- `if (merged.mode === 'auto' && !merged.folderPath) merged.folderPath = SYNC_FOLDER_NAME;`
  — an *explicit* auto choice still resolves the default sync folder.
- `readOptionsForPath` / `getHomeBaseDir` / `BaseDirectory::Home` semantics.
- Boot-time auto-start still starts the watcher for a configured notify/auto mode.
- No bundle-identifier check, environment flag, debug seam, alternate HOME
  handling, or second config schema was added.

`tools/validation/sync/validate-f19-desktop-chrome-propagation.mjs` carried
`assertContains(folderSyncFile, "mode: 'auto'", 'Desktop sync folder default
auto import mode')` — a bare-substring assertion whose only match in the module
was the defective default, so it pinned the defect. It was replaced with two
assertions on the surviving product truth (explicit auto resolves the default
folder; boot auto-starts for a configured notify/auto mode). This is the only
directly-coupled change outside the owner module.

## RED Proof

`tools/validation/sync/validate-folder-sync-fresh-desktop-bootstrap-isolation.mjs`
runs `folder-sync.tauri.js` in a Node VM with a synthetic Tauri fs, a synthetic
`chrome.storage.local`, a controlled clock and controlled timers. It never
touches the real HOME and carries no user payload data.

Against pristine `755a1092` the validator fails with **18** findings (exit 1),
reproducing the whole chain — see `## RED transcript` below.

## Regression Matrix

| Case | Scenario | Result |
| --- | --- | --- |
| A | Absent config -> effective off, watcher not running, no folder read, no auto-import, no synthetic persistence | PASS |
| B | Explicit persisted auto + configured folder -> watcher starts, `BaseDirectory::Home` scan, merge import | PASS |
| C | Explicit persisted manual -> remains manual, watcher off, no auto-import | PASS |
| D | Explicit persisted notify -> remains notify, watcher runs, queues rather than imports | PASS |
| E | Explicit persisted off -> remains off, watcher off | PASS |
| F | Legacy migration runs only on an actually persisted legacy config; absent config is not migrated and is not persisted | PASS |
| G | Ordinary `setConfig` still moves a fresh Desktop into explicitly configured states (and folder-only is not an opt-in) | PASS |
| H | Existing automatic-sync validators unchanged vs the `755a1092` baseline | PASS |

Cases B, C, D, E and F pass on the *pre-correction* source too — they are
genuine preservation baselines, not new behavior.

## Runtime Proof

Built through the canonical Desktop chain from this worktree:

```
H2O_EXT_DEV_VARIANT=production node tools/product/extensions/chatgpt/chrome/build-chrome-live-extension.mjs
cd apps/studio/desktop && npm run tauri:build -- --bundles app
cd apps/studio/desktop && npm run tauri:build -- --bundles app --config <overlay with identifier only>
```

The overlay used for the disposable candidate is exactly one field:

```json
{ "identifier": "org.h2o.studio.desktop.syncfresh01" }
```

Both builds consumed the same `apps/studio/desktop/dist`
(`sync/folder-sync.tauri.js` sha256
`a5fe39ed149e78423e9145c35f90443322d548ec332fd7d041701e45870b0548`, default
`mode: 'off'`). `productName` stays `H2O Studio` in both.

### Boundary

- fresh bundle identity `org.h2o.studio.desktop.syncfresh01`
- app-local store and WebKit store both confirmed **absent** before first launch
- **ordinary user HOME — deliberately not isolated**
- shared `$HOME/H2O Studio Sync/chrome-latest.json` present, 1022417 B,
  sha256 `deafbca3161b12b04c038018cf38becdf3acf1a9208cc0b531e3a7e773bbce17`
- no persisted `h2o:studio:sync:config:v1`
- zero Studio processes running at seal time
- production store + all nine sync-folder files sealed (sha256 + size + mtime)
  before each launch and re-sealed after
- no Saved-Chat Recover-as-New action at any point

### Launch 1 — absent config (the T07 boundary)

Ran 100 s (the defective build needed ~15 s: 5 s watcher interval + 1.5 s file
stability), then quit gracefully.

| Observable | Result |
| --- | --- |
| `chats` / `snapshots` / `folders` / `import_batches` | 0 / 0 / 0 / 0 |
| `h2o:studio:sync:config:v1` | absent — no synthetic config persisted |
| `h2o:studio:sync:ledger:v1` | absent — ledger did not advance |
| `h2o:prm:cgx:fldrs:state:data:v1` (written only by a chrome-latest import) | absent |
| total `kv_store` rows | 4 (bookkeeping only) |
| open handles under `$HOME/H2O Studio Sync` while running | 0 |
| open handles under the production store while running | 0 |
| production store (4 digests + full recursive metadata tree) | byte- and mtime-identical |
| shared sync folder (9 files) | byte- and mtime-identical |

Production `studio-v1.db-shm` mtime stayed at `2026-09-06T17:55:31Z` across the
launch. In the T07 run against the defective build the equivalent mtime advanced
at launch; here it does not move at all.

### RED runtime reference

The disposable identity built from the defective source in T07
(`org.h2o.studio.desktop.scrct07`, same HOME, same shared `chrome-latest.json`,
also with no persisted config) holds **41 chats / 28 snapshots / 6 folders** and
carries `h2o:prm:cgx:fldrs:state:data:v1` (3416 B), 7 `kv_store` rows.

### Launch 2 — explicitly persisted auto (preservation)

Same build, same identity, same HOME, same shared file. The only change was
writing an actually-persisted config into the store's `kv_store` while the app
was closed:

```json
{"schemaVersion":1,"mode":"auto","folderPath":"H2O Studio Sync","phase3AutoSyncConfigVersion":1,"updatedAt":"2026-09-06T16:20:00.000Z"}
```

| Observable | Launch 1 (absent) | Launch 2 (persisted auto) |
| --- | --- | --- |
| `chats` | 0 | **41** |
| `snapshots` | 0 | **28** |
| `folders` | 0 | **6** |
| `h2o:prm:cgx:fldrs:state:data:v1` | absent | present (3416 B) |

Identical bytes, identical HOME, identical source file; the single variable is
whether a config is persisted. Automatic sync is fully intact for an explicit
opt-in and completely inert without one.

The shared `chrome-latest.json` and the whole production store were again
byte- and mtime-identical after launch 2 — the import is read-only on the
source folder.

### Honest limitation

`h2o:studio:sync:ledger:v1` is absent after **both** the defective T07 run and
the corrected launch 2. `appendLedgerEntry` for the chrome-latest path runs only
`if (result.ok)`, and this propagation returns a not-ok result (deferral
warnings) while still merging rows. "The ledger does not advance" therefore
holds, but it is a weak discriminator in the live runtime — the decisive
observables are the row counts and the Chrome folder-state key.

## Ordinary Desktop Surface

- The retained ordinary candidate carries `CFBundleIdentifier
  org.h2o.studio.desktop` and `CFBundleName H2O Studio` — the ordinary product
  identity, produced by the canonical `npm run tauri:build` chain with no
  overlay.
- The disposable candidate differs from it by exactly one config field
  (`identifier`); both embed the same `dist`.
- The diff adds no `process.env` read, no `H2O_*` flag, no debug/test-mode
  branch, no bundle-identifier check, no acceptance-only UI and no second config
  schema (verified by grep over the added lines).
- `setConfig` is untouched. Ordinary Sync configuration through
  `H2O.Studio.sync.setConfig` / `H2O.Studio.sync.folder.setConfig` still moves a
  fresh Desktop into auto / manual / notify / off, still stamps the Phase 3
  marker, still starts and stops the watcher immediately (validator case G), and
  the resulting persisted auto config imports normally in the live runtime
  (launch 2).

## Retained Artifacts

`runtime/sync-fresh-desktop-bootstrap-isolation-20260906/`

- `ordinary/H2O Studio.app` — identifier `org.h2o.studio.desktop`,
  exec sha256 `ec06f63aa8ed3adeebd06fbb04ab0bcf6c77cea0aa90fbfab5f965ef880c27a6`
  (the corrected candidate for Saved-Chat T07 retest)
- `disposable-syncfresh01/H2O Studio.app` — identifier
  `org.h2o.studio.desktop.syncfresh01`,
  exec sha256 `266972c8d17de9b688c266bb9a5c330d856648c2e0e6a5dd082331ad3cd0c804`
  (the runtime-proof candidate)

## Validation

Passed:

- `node --check src-surfaces-base/studio/sync/folder-sync.tauri.js`
- `node --check tools/validation/sync/validate-f19-desktop-chrome-propagation.mjs`
- `node --check tools/validation/sync/validate-folder-sync-fresh-desktop-bootstrap-isolation.mjs`
- `node tools/validation/sync/validate-folder-sync-fresh-desktop-bootstrap-isolation.mjs` (new; RED at base, GREEN here)
- `node tools/validation/sync/validate-f19-desktop-chrome-propagation.mjs`
- `node tools/validation/sync/validate-f19-chrome-desktop-propagation.mjs`
- `node tools/validation/sync/validate-f19-sync-hardening.mjs`
Two baseline-controlled sweeps, each run against a detached `755a1092`
worktree and against this tree, **both producing identical results**:

1. all 29 validators that VM-execute `folder-sync.tauri.js`
2. all 99 `validate-f19-*` + `validate-folder-sync-*` validators

Pre-existing failures, identical in both trees and unrelated to this change:

- 9 label / tag / category allowlist and receipt-hash drift validators
  (`validate-labels-tags-categories-phase{7,13,17,22,30,31,32,35,38}-*.mjs`)
- `validate-f19-chrome-desktop-library-parity.mjs` — `studio.html: missing
  Studio shell cache bust`
- `validate-f19-shell-row-ux.mjs`
- `validate-folder-sync-rc-smoke-runner.mjs`
- `validate-folder-sync-readiness-design-audit.mjs`

## RED transcript

Against pristine `755a1092`, `validate-folder-sync-fresh-desktop-bootstrap-isolation.mjs`
exits 1 with:

```
- defaultConfig() must default to mode 'off'
- defaultConfig() must default to an empty folderPath
- defaultConfig() must not seed the shared HOME-relative sync folder
- A: absent config must resolve to effective mode off (expected "off", got "auto")
- A: absent config must resolve to an empty folderPath (expected "", got "H2O Studio Sync")
- A: absent config must not start the watcher (expected false, got true)
- A: absent config must leave the watcher mode off (expected "off", got "auto")
- A: absent config must leave the watcher folderPath empty (expected "", got "H2O Studio Sync")
- A: absent config must not read the shared HOME-relative sync folder (expected 0, got 3)
- A: absent config must not read the shared chrome-latest.json (expected 0, got 4)
- A: absent config must not run an automatic import (expected 0, got 1)
- A: absent config must report auto-import disabled (expected false, got true)
- A: absent config must report effective mode off (expected "off", got "auto")
- A: absent config must leave the sync ledger empty (expected 0, got 1)
- G: fresh Desktop must start unconfigured (expected false, got true)
- G: naming a folder without choosing a mode must leave sync off (expected "off", got "auto")
- G: naming a folder without choosing a mode must not start the watcher (expected false, got true)
```

## Saved-Chat T07 Consumption

- Retest against `runtime/sync-fresh-desktop-bootstrap-isolation-20260906/ordinary/H2O Studio.app`,
  or rebuild from commit on `work/sync-fresh-desktop-bootstrap-isolation-20260906`.
- A fresh Desktop identity now comes up with an **empty** store. The
  "41 chats / 28 snapshots on first launch" tell is gone; treat any non-zero
  first-launch row count as a new finding.
- If T07 needs automatic Sync during a run, it must now configure it explicitly
  (`H2O.Studio.sync.setConfig({ mode: 'auto', folderPath: 'H2O Studio Sync' })`);
  it is no longer implicit.
- No Saved-Chat Lane state, branch, or management record was touched.

## Remaining Limitations

- The `chrome-latest.json` propagation still returns a not-ok result while
  merging rows, so the folder-sync ledger is not appended on that path. That
  predates this change and is out of scope here.
- Nine pre-existing label/tag/category validator failures at `755a1092` remain
  open and are unrelated to this correction.
