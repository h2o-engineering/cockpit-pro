# Studio Platform Adapter

Status: Active (skeleton)
Owns: `H2O.Studio.platform` namespace, MV3 adapter implementation, selectors contract.
Contracts: see `src-surfaces-base/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md` (full surface area) and `STUDIO_PORTABILITY_CONTRACT.md` (rules).

Engineering Lane: `L-STUDIO-HOST-INTEGRATION` owns the environment-selection,
host messaging, IPC/command, filesystem, clipboard, and runtime-adapter
semantics in this folder. `selectors.contract.js` is colocated for proximity
but serves Reader/Renderer contracts; colocation does not transfer its feature
semantics. Application Shell owns placement geometry,
`L-RUNTIME-KERNEL-SCOPE-STU` owns Studio bootstrap, module admission,
readiness, registration, activation, and lifecycle, and Build & Delivery owns
packaging and artifact-delivery mechanics. Shared bridge files use temporary narrow leases
when another Lane must edit them; there is no co-primary ownership.

## What This Folder Is

The one place Studio code is allowed to touch platform APIs (`chrome.*`, `localStorage`, `indexedDB`, file dialogs, Tauri IPC, …). Everything else in `src-surfaces-base/studio/` calls through `H2O.Studio.platform.*` and `H2O.Studio.SELECTORS`.

This is the **skeleton** — namespace, MV3 adapter, selector contract, diagnostics. Feature call sites are NOT migrated yet; that happens in follow-up patches in the order specified by `STUDIO_PLATFORM_ADAPTER_GUIDE.md` (Migration Path section).

## Files

| File | Role |
|---|---|
| `index.js` | Creates `H2O.Studio.platform` namespace, registers fallback adapter, exposes `__registerAdapter` and `diagnose()`. Idempotent. Load first. |
| `platform.mv3.js` | Self-registering MV3 adapter. Binds when `chrome.runtime?.id` is present. Wraps `chrome.runtime.sendMessage`, `chrome.storage.local`, `chrome.storage.onChanged`, `localStorage`. |
| `selectors.contract.js` | `H2O.Studio.SELECTORS` — ChatGPT-compatible data-attribute selectors used by reader and decoration engines. |
| `README.md` | This file. |

## Public API

After load, the following is available on `window`:

```js
H2O.Studio.platform.env                        // { adapter, version, bootedAt, isExtension, isTauri, isDev }
H2O.Studio.platform.messaging.send(target, msg)// → Promise<response>
H2O.Studio.platform.messaging.on(target, fn)   // → unsubscribe()
H2O.Studio.platform.broadcast.emit(channel, p)      // → Promise<void>   (channel-based; uses 'h2o:studio:platform:broadcast:<channel>:v1')
H2O.Studio.platform.broadcast.on(channel, fn)       // → unsubscribe()
H2O.Studio.platform.broadcast.emitRaw(key, payload) // → Promise<void>   (writes to a specific key; for legacy wire-format interop)
H2O.Studio.platform.broadcast.onAnyChange(fn)       // → unsubscribe()   (fn(changes, area); for prefix-watching / legacy interop)
H2O.Studio.platform.storage.get(key)           // → Promise<any|null>
H2O.Studio.platform.storage.set(key, value)    // → Promise<void>
H2O.Studio.platform.storage.remove(key)        // → Promise<void>
H2O.Studio.platform.files                      // { available: false }   (placeholder)
H2O.Studio.platform.capture                    // { available: false }   (placeholder)
H2O.Studio.platform.auth                       // { available: false }   (placeholder)
H2O.Studio.platform.diagnose()                 // → health report
H2O.Studio.SELECTORS.sel.assistantTurn         // '[data-message-author-role="assistant"]'
H2O.Studio.SELECTORS.by.messageId(id)          // '[data-message-id="..."]'
```

## Allowed Usage Examples

```js
/* messaging — replaces chrome.runtime.sendMessage in feature code */
const response = await H2O.Studio.platform.messaging.send('capture', {
  ns: 'h2o-ext-archive:v1',
  op: 'fetchSnapshot',
  snapshotId: snap,
});

/* broadcast — replaces direct chrome.storage.local heartbeat writes */
await H2O.Studio.platform.broadcast.emit('library:refreshed', { reason: 'manual' });
const unsubscribe = H2O.Studio.platform.broadcast.on('library:refreshed', (payload, meta) => {
  // payload === { reason: 'manual' }
});

/* storage — low-level KV; prefer the future H2O.Studio.store for entities */
await H2O.Studio.platform.storage.set('studio:ui-prefs', { theme: 'dark' });
const prefs = await H2O.Studio.platform.storage.get('studio:ui-prefs');

/* selectors — replaces literal CSS strings in feature code */
const turn = document.querySelector(H2O.Studio.SELECTORS.sel.assistantTurn);
const byId = document.querySelector(H2O.Studio.SELECTORS.by.messageId(messageId));
```

## Forbidden in Studio Feature Code

Anything under `src-surfaces-base/studio/` outside this `platform/` folder must NOT use:

- `chrome.runtime`, `chrome.storage`, `chrome.tabs`, `chrome.runtime.getURL`
- `localStorage`, `sessionStorage`, `indexedDB`, `idb-keyval`, `idb`
- `GM_*` Tampermonkey APIs
- Hardcoded `chrome-extension://` URLs
- Hardcoded ChatGPT-attribute selectors like `[data-message-author-role="assistant"]` (use `H2O.Studio.SELECTORS.sel.*` or `.by.*` instead)
- Direct identity-provider SDK calls (Supabase, OAuth, etc.) — go through the identity surface

See `STUDIO_PORTABILITY_CONTRACT.md` for the full rule list and `STUDIO_DEVELOPMENT_RULES.md` for the pre-merge checklist.

## Diagnostics

```js
H2O.Studio.platform.diagnose()
/* returns:
{
  adapter: 'mv3' | 'fallback',
  adapterVersion: '0.1.0',
  bootedAt: 1715520000000,
  ageMs: 1234,
  chromeRuntime: true,
  chromeStorage: true,
  broadcastReady: true,
  storageReady: true,
  messagingReady: true,
  selectorsLoaded: true,
  warnings: [],
}
*/
```

Use this from the DevTools console of `studio.html` to confirm the adapter bound correctly. `adapter === 'fallback'` means no real adapter registered (something is wrong with the load order or the environment is unrecognized).

## How a Future Tauri Adapter Plugs In

Add a sibling file `platform.tauri.js` with the same self-registration pattern:

```js
(function (global) {
  var platform = global.H2O && global.H2O.Studio && global.H2O.Studio.platform;
  if (!platform || !platform.__registerAdapter) return;

  var isTauri = !!global.__TAURI__;
  if (!isTauri) return; // leave MV3 (or fallback) in place

  // Build adapter using Tauri invoke/listen, tauri-plugin-sql, dialog/fs, etc.
  var adapter = {
    name: 'tauri',
    version: '0.1.0',
    env: { adapter: 'tauri', version: '0.1.0', bootedAt: Date.now(), isExtension: false, isTauri: true, isDev: false },
    messaging: { send: function (target, msg) { return global.__TAURI__.invoke(target, msg); }, on: /* listen() */ },
    broadcast: { emit: /* Tauri event emit */, on: /* Tauri event listen */ },
    storage: { /* tauri-plugin-sql or fs */ },
    files: { /* tauri dialog/fs */ },
    capture: { /* native messaging bridge to slim capture extension */ },
    auth: { /* secret store */ },
  };
  platform.__registerAdapter(adapter);
})(typeof window !== 'undefined' ? window : globalThis);
```

Load it AFTER `index.js` and AFTER `platform.mv3.js` in `studio.html`. The first adapter whose environment check passes wins; the others no-op.

## Load Order

`studio.html` loads, in order:

1. `S0A2a. 🎬 Observer Hub - Studio.js`
2. `S0A1a. 🎬 H2O Core - Studio.js` — defines `H2O.events`
3. `platform/index.js` — creates `H2O.Studio.platform` (fallback adapter bound)
4. `platform/platform.mv3.js` — registers MV3 adapter if env matches
5. `platform/selectors.contract.js` — installs `H2O.Studio.SELECTORS`
6. (everything else)

Safe because: every feature module loads AFTER the platform; the platform never overwrites `H2O` or `H2O.Studio` if they already exist; if `chrome.*` is unavailable, the MV3 adapter no-ops and the fallback adapter handles calls with explicit rejections.

## Migration Status (as of this skeleton)

Not migrated yet (debts to pay down — see `STUDIO_PLATFORM_ADAPTER_GUIDE.md` "Migration Path"):

- `S0F1h` Library Sync still writes `h2o:library:cross-surface:broadcast:v1` directly via `chrome.storage.local.set`. The new `platform.broadcast.emit/on` uses a different key prefix (`h2o:studio:platform:broadcast:*`) and does not collide.
- `studio.js` still calls `chrome.runtime.sendMessage` (lines 848, ~4301) directly.
- `S0F0a` Library Surface Host wraps `chrome.runtime.sendMessage` directly (~line 320).
- `S3H1a` Highlights Engine still uses three storage paths (`chrome.storage` → `GM_*` → `localStorage`).
- `S9D1a` Auto Emoji Title dual-writes via `localStorage` and `chrome.storage`.
- Selector literals across `S1A1b`, `S1A2a`, `S2Z1a`, `S3H1a` are not yet replaced with `H2O.Studio.SELECTORS.*`.

These all continue to work unchanged. The platform skeleton exists so the *next* code added to Studio uses it.
