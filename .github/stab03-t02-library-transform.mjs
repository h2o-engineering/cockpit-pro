#!/usr/bin/env node
import fs from 'node:fs';

const files = {
  workspace: 'src-surfaces-base/studio/S0F1b. 🎬 Library Workspace - Studio.js',
  index: 'src-surfaces-base/studio/S0F1c. 🎬 Library Index - Studio.js',
  insights: 'src-surfaces-base/studio/S0F1d. 🎬 Library Insights - Studio.js',
  services: 'src-surfaces-base/studio/S0F1k. 🎬 Library Canonical Services - Studio.js',
  tags: 'src-surfaces-base/studio/S0F5a. 🎬 Tags - Studio.js',
  title: 'src-surfaces-base/studio/S9D1a. 🎬 Auto Emoji Title - Studio.js',
};

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, text) { fs.writeFileSync(path, text); }
function replaceOnce(text, pattern, replacement, label) {
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`transform anchor not found: ${label}`);
  return next;
}

// S0F1b — layout writes through Library Store; localStorage remains read-only compatibility.
{
  let s = read(files.workspace);
  s = replaceOnce(
    s,
    /  \/\/ ── Layout persistence [^\n]*\n[\s\S]*?\n  \/\/ ── Model fetchers /,
`  // ── Layout persistence ─────────────────────────────────────────────────────
  let layoutStoreHydrationStarted = false;
  function getLibraryStore() {
    try { return H2O.Library?.Store || null; } catch { return null; }
  }
  function readLegacyLayout() {
    try {
      const raw = W.localStorage.getItem(LAYOUT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { err('loadLayout.legacy-read', e); return null; }
  }
  function hydrateLayoutFromStore() {
    if (layoutStoreHydrationStarted) return;
    layoutStoreHydrationStarted = true;
    const store = getLibraryStore();
    if (!store || typeof store.get !== 'function') return;
    Promise.resolve(store.get(LAYOUT_KEY)).then((stored) => {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
      cache.layout = { sidebarExpanded: true, view: 'saved', ...stored };
      emitUpdated('layout-store-hydrate', { layout: { ...cache.layout } });
    }).catch((e) => err('loadLayout.store-read', e));
  }
  function loadLayout() {
    if (!cache.layout) {
      const legacy = readLegacyLayout();
      cache.layout = legacy && typeof legacy === 'object'
        ? { sidebarExpanded: true, view: 'saved', ...legacy }
        : { sidebarExpanded: true, view: 'saved' };
    }
    hydrateLayoutFromStore();
    return cache.layout;
  }
  function saveLayout(patch) {
    try {
      const next = { ...loadLayout(), ...(patch || {}) };
      cache.layout = next;
      const store = getLibraryStore();
      if (!store || typeof store.set !== 'function') throw new Error('Library Store unavailable');
      Promise.resolve(store.set(LAYOUT_KEY, next)).catch((e) => err('saveLayout.store-write', e));
      step('saveLayout', JSON.stringify(next));
      return true;
    } catch (e) { err('saveLayout', e); return false; }
  }

  // ── Model fetchers `,
    'S0F1b layout persistence block'
  );
  write(files.workspace, s);
}

// S0F1c — frozen archive request goes through platform messaging.
{
  let s = read(files.index);
  s = replaceOnce(
    s,
    /  function callArchiveExportFullBundle\(\) \{[\s\S]*?\n  \}\n\n  function /,
`  function callArchiveExportFullBundle() {
    return new Promise((resolve) => {
      try {
        const messaging = H2O.Studio?.platform?.messaging || null;
        if (!messaging || typeof messaging.send !== 'function') { resolve(null); return; }
        const message = { type: ARCHIVE_MESSAGE_TYPE, req: { op: 'exportFullBundle', payload: {} } };
        Promise.resolve(messaging.send(ARCHIVE_MESSAGE_TYPE, message))
          .then((response) => resolve(response && response.ok ? response.result : null))
          .catch(() => resolve(null));
      } catch (e) {
        err('callArchiveExportFullBundle', e);
        resolve(null);
      }
    });
  }

  function `,
    'S0F1c callArchiveExportFullBundle'
  );
  write(files.index, s);
}

// S0F1d — prefs to Library Store, C1 messaging port, D1 runtime.openUrl only.
{
  let s = read(files.insights);
  s = replaceOnce(
    s,
`  function loadPrefs() {
    try { return Object.assign({}, PREF_DEFAULTS, JSON.parse(W.localStorage.getItem(PREFS_KEY) || '{}')); }
    catch { return Object.assign({}, PREF_DEFAULTS); }
  }
  function savePrefs(p) { try { W.localStorage.setItem(PREFS_KEY, JSON.stringify(p || {})); } catch (e) { err('savePrefs', e); } }

  const prefs = loadPrefs();`,
`  let prefsStoreHydrationStarted = false;
  function getLibraryStore() {
    try { return H2O.Library?.Store || null; } catch { return null; }
  }
  function loadPrefs() {
    try { return Object.assign({}, PREF_DEFAULTS, JSON.parse(W.localStorage.getItem(PREFS_KEY) || '{}')); }
    catch { return Object.assign({}, PREF_DEFAULTS); }
  }
  function hydratePrefsFromStore(target) {
    if (prefsStoreHydrationStarted) return;
    prefsStoreHydrationStarted = true;
    const store = getLibraryStore();
    if (!store || typeof store.get !== 'function') return;
    Promise.resolve(store.get(PREFS_KEY)).then((stored) => {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
      Object.assign(target, PREF_DEFAULTS, stored);
    }).catch((e) => err('loadPrefs.store-read', e));
  }
  function savePrefs(p) {
    try {
      const store = getLibraryStore();
      if (!store || typeof store.set !== 'function') throw new Error('Library Store unavailable');
      Promise.resolve(store.set(PREFS_KEY, { ...(p || {}) })).catch((e) => err('savePrefs.store-write', e));
    } catch (e) { err('savePrefs', e); }
  }

  const prefs = loadPrefs();
  hydratePrefsFromStore(prefs);`,
    'S0F1d prefs block'
  );
  s = replaceOnce(
    s,
    /  function callArchiveMetadataFetch\(url\) \{[\s\S]*?\n  \}\n\n  function /,
`  function callArchiveMetadataFetch(url) {
    return new Promise((resolve) => {
      try {
        const messaging = H2O.Studio?.platform?.messaging || null;
        if (!messaging || typeof messaging.send !== 'function') { resolve(null); return; }
        const message = {
          type: 'h2o-ext-archive:v1',
          req: { op: 'fetchPageMetadata', payload: { url } },
        };
        Promise.resolve(messaging.send('h2o-ext-archive:v1', message))
          .then((response) => resolve(response && response.ok ? response.result : null))
          .catch(() => resolve(null));
      } catch (e) {
        err('callArchiveMetadataFetch', e);
        resolve(null);
      }
    });
  }

  function `,
    'S0F1d callArchiveMetadataFetch'
  );
  s = replaceOnce(
    s,
    /  function openOriginalUrl\(url, setStatus\) \{[\s\S]*?\n  \}\n\n  function /,
`  function openOriginalUrl(url, setStatus) {
    if (!url) return;
    try { setStatus?.('Opening original...'); } catch {}
    const runtime = H2O.Studio?.platform?.runtime || null;
    if (!runtime || typeof runtime.openUrl !== 'function') {
      try { setStatus?.('Could not open original: platform runtime unavailable'); } catch {}
      return;
    }
    Promise.resolve(runtime.openUrl(url)).then(
      () => { try { setStatus?.(''); } catch {} },
      (openErr) => {
        const msg = openErr?.message || openErr || 'unknown error';
        try { setStatus?.('Could not open original: ' + String(msg)); } catch {}
      }
    );
  }

  function `,
    'S0F1d openOriginalUrl'
  );
  write(files.insights, s);
}

// S0F1k — C1 messaging port and D1 runtime.openUrl canonical caller.
{
  let s = read(files.services);
  s = replaceOnce(
    s,
    /  \/\/ ── Native-link-opener adapter [^\n]*\n[\s\S]*?\n  \/\/ ── Current-chat provider /,
`  // ── Native-link-opener adapter ─────────────────────────────────────────────
  const nativeLinkOpener = Object.freeze({
    __canonicalName: 'native-link-opener',
    __surface: SURFACE,
    open(url, opts = {}) {
      const u = String(url || '');
      const runtime = H2O.Studio?.platform?.runtime || null;
      if (!runtime || typeof runtime.openUrl !== 'function') {
        const error = new Error('H2O.Studio.platform.runtime.openUrl unavailable');
        err('native-link-opener.runtime-open-url', error);
        return Promise.resolve(null);
      }
      return Promise.resolve(runtime.openUrl(u, { active: !(opts && opts.background) }))
        .catch((e) => { err('native-link-opener.runtime-open-url', e); return null; });
    },
    diagnose() {
      return {
        name: 'native-link-opener',
        surface: SURFACE,
        hasRuntimeOpenUrl: typeof H2O.Studio?.platform?.runtime?.openUrl === 'function',
        ok: true,
      };
    },
  });

  // ── Current-chat provider `,
    'S0F1k nativeLinkOpener'
  );
  s = replaceOnce(
    s,
    /  function sendRuntimeArchiveMessage\(op = STORAGE_BACKGROUND_DIAG_OP, payload = \{\}\) \{[\s\S]*?\n  \}\n\n  function /,
`  function sendRuntimeArchiveMessage(op = STORAGE_BACKGROUND_DIAG_OP, payload = {}) {
    const messaging = H2O.Studio?.platform?.messaging || null;
    if (!messaging || typeof messaging.send !== 'function') {
      return Promise.reject(new Error('platform messaging unavailable'));
    }
    const message = {
      type: STORAGE_ARCHIVE_MSG,
      req: { op: String(op || ''), payload: payload && typeof payload === 'object' ? payload : {} },
    };
    return Promise.resolve(messaging.send(STORAGE_ARCHIVE_MSG, message));
  }

  function `,
    'S0F1k sendRuntimeArchiveMessage'
  );
  write(files.services, s);
}

// S0F5a — tag prefs write only through existing Library Store; legacy read is compatibility-only.
{
  let s = read(files.tags);
  s = replaceOnce(
    s,
`  function loadPrefs() {
    try { return JSON.parse(W.localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
  }
  function savePrefs(p) {
    try { W.localStorage.setItem(PREFS_KEY, JSON.stringify(p || {})); } catch (e) { err('savePrefs', e); }
  }

  const prefs = loadPrefs();`,
`  let prefsStoreHydrationStarted = false;
  function loadPrefs() {
    try { return JSON.parse(W.localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
  }
  function hydratePrefsFromStore(target) {
    if (prefsStoreHydrationStarted) return;
    prefsStoreHydrationStarted = true;
    const store = getStore();
    if (!store || typeof store.get !== 'function') return;
    Promise.resolve(store.get(PREFS_KEY)).then((stored) => {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
      Object.assign(target, stored);
    }).catch((e) => err('loadPrefs.store-read', e));
  }
  function savePrefs(p) {
    try {
      const store = getStore();
      if (!store || typeof store.set !== 'function') throw new Error('Library Store unavailable');
      Promise.resolve(store.set(PREFS_KEY, { ...(p || {}) })).catch((e) => err('savePrefs.store-write', e));
    } catch (e) { err('savePrefs', e); }
  }

  const prefs = loadPrefs();
  hydratePrefsFromStore(prefs);`,
    'S0F5a prefs block'
  );
  write(files.tags, s);
}

// S9D1a — one Store write authority and platform/Sync broadcast boundary.
{
  let s = read(files.title);
  s = replaceOnce(
    s,
    /  function chromeStorageSet\(record\)\{[\s\S]*?\n  \}\n\n  async function writeSharedRecord\(key, value\)\{[\s\S]*?\n  \}\n\n  function broadcast\(reason, payload\)\{[\s\S]*?\n  \}/,
`  function getLibraryStore(){
    try { return W.H2O?.Library?.Store || null; } catch { return null; }
  }

  async function readSharedRecord(key){
    const k = String(key || "");
    if (!k) return {};
    try {
      const store = getLibraryStore();
      if (store && typeof store.get === "function") {
        const stored = await store.get(k);
        if (stored && typeof stored === "object" && !Array.isArray(stored)) return stored;
      }
    } catch {}
    try {
      const legacy = JSON.parse(localStorage.getItem(k) || "{}");
      return legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy : {};
    } catch { return {}; }
  }

  async function writeSharedRecord(key, value){
    const k = String(key || "");
    if (!k) return false;
    const store = getLibraryStore();
    if (!store || typeof store.set !== "function") throw new Error("Library Store unavailable");
    const record = value && typeof value === "object" ? value : {};
    await store.set(k, record);
    return true;
  }

  function broadcast(reason, payload){
    const body = {
      ts: Date.now(),
      surface: "studio",
      reason: String(reason || "studio-auto-emoji-title"),
      payload: payload && typeof payload === "object" ? payload : null,
    };
    let routed = false;
    try {
      const sync = W.H2O?.Library?.Sync;
      if (sync && typeof sync.broadcast === "function") {
        sync.broadcast(body.reason, body.payload);
        routed = true;
      }
    } catch {}
    if (!routed) {
      try {
        const emitRaw = W.H2O?.Studio?.platform?.broadcast?.emitRaw;
        if (typeof emitRaw === "function") {
          Promise.resolve(emitRaw(LIBRARY_SYNC_BROADCAST_KEY, body)).catch(() => {});
        }
      } catch {}
    }
    try {
      W.dispatchEvent(new CustomEvent("evt:h2o:library:cross-surface-sync", {
        detail: { reasons: [body.reason], t: body.ts, surface: "studio" },
      }));
    } catch {}
  }`,
    'S9D1a storage/broadcast helpers'
  );
  s = replaceOnce(
    s,
`    let prev = {};
    try { prev = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch {}
    const meta = {`,
`    const prev = await readSharedRecord(key);
    const meta = {`,
    'S9D1a persistInterfaceMeta read'
  );
  s = replaceOnce(
    s,
`      const key = \`${'${HEAT_OVERRIDE_KEY_PREFIX}${chatId}'}\`;
      try {
        if (level === "auto") localStorage.removeItem(key);
        else localStorage.setItem(key, level);
      } catch {}
      await persistInterfaceMeta(chatId, { heatOverride: level }, "studio-title-palette-heat");`,
`      const key = \`${'${HEAT_OVERRIDE_KEY_PREFIX}${chatId}'}\`;
      const store = getLibraryStore();
      if (!store || typeof store.set !== "function" || typeof store.del !== "function") throw new Error("Library Store unavailable");
      if (level === "auto") await store.del(key);
      else await store.set(key, level);
      await persistInterfaceMeta(chatId, { heatOverride: level }, "studio-title-palette-heat");`,
    'S9D1a heat persistence'
  );
  s = replaceOnce(
    s,
`      const key = \`${'${ROW_TINT_KEY_PREFIX}${chatId}'}\`;
      try {
        if (next < 0) localStorage.removeItem(key);
        else localStorage.setItem(key, String(next));
      } catch {}
      await persistInterfaceMeta(chatId, { rowTint: next }, "studio-title-palette-row-tint");`,
`      const key = \`${'${ROW_TINT_KEY_PREFIX}${chatId}'}\`;
      const store = getLibraryStore();
      if (!store || typeof store.set !== "function" || typeof store.del !== "function") throw new Error("Library Store unavailable");
      if (next < 0) await store.del(key);
      else await store.set(key, String(next));
      await persistInterfaceMeta(chatId, { rowTint: next }, "studio-title-palette-row-tint");`,
    'S9D1a row tint persistence'
  );
  write(files.title, s);
}

console.log('STAB03_T02_LIBRARY_TRANSFORM=PASS');
