/* H2O Studio — Appearance Store
 *
 * Owns the live appearance state (theme/typography/font-size/content-width/
 * visibility toggles/always-on-top), persists every change through
 * H2O.Studio.platform.storage (same backend store/prefs.js uses), and
 * applies the current state to the document so a single CSS layer renders
 * the whole look.
 *
 * Apply mechanism (single source of truth — CSS handles the rest):
 *   <html data-h2o-theme="dark|light|sepia"
 *         data-h2o-typography="sans|serif|mono"
 *         data-h2o-plain-text="on|off"
 *         data-h2o-show-folders="on|off"
 *         data-h2o-show-notes="on|off">
 *   :root {
 *     --wb-appearance-font-size: 16px;
 *     --wb-appearance-content-width: 48rem;
 *   }
 *
 * Always-on-top is forwarded to H2O.Studio.platform.window.setAlwaysOnTop
 * when available (Tauri). On other adapters the toggle is reported as
 * unavailable so the panel hides it (no faked behavior).
 *
 * Public API (H2O.Studio.appearance):
 *   get(key)           — synchronous read (clamped, falls back to defaults)
 *   set(key, value)    — synchronous local update + apply + async persist
 *   getAll()           — { theme, typography, fontSize, contentWidth, ... }
 *   subscribe(fn)      — fn({ type:'change'|'ready', key, value })
 *   apply()            — re-apply current state to document (idempotent)
 *   isReady()          — true after boot hydration completes
 *   selfCheck()        — diagnostics
 *   alwaysOnTopAvailable() — boolean
 *
 * Loads AFTER appearance-keys.js, AFTER platform/* (so platform.storage and
 * platform.window are bound), and BEFORE appearance-panel.studio.js which
 * subscribes to changes and calls into the store.
 *
 * Contracts: src-surfaces-base/studio/STUDIO_DEVELOPMENT_RULES.md
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.appearance && H2O.Studio.appearance.__storeInstalled) return;
  if (!H2O.Studio.appearance || !H2O.Studio.appearance.keys) {
    try { console.warn('[H2O.Studio.appearance] keys not installed; skipping store'); } catch (_) {}
    return;
  }

  var KEYS = H2O.Studio.appearance.keys;
  var DEFAULTS = H2O.Studio.appearance.defaults;
  var THEMES = H2O.Studio.appearance.themes;
  var TYPOGRAPHIES = H2O.Studio.appearance.typographies;
  var BOUNDS = H2O.Studio.appearance.bounds;
  var EVENTS = H2O.Studio.appearance.events;

  var STORE_VERSION = '0.1.0';
  var SAVE_DEBOUNCE_MS = 250;

  /* ── State ─────────────────────────────────────────────────────────── */
  var cache = {};                                    /* key (logical) -> value */
  var subscribers = new Set();
  var errors = [];
  var ERR_MAX = 20;
  var hydrated = false;
  var saveTimer = null;
  var pendingFlush = new Set();
  var platformStorage = null;
  var hasPlatformStorage = false;
  var platformWindow = null;

  /* ── Logical <-> storage key map ──────────────────────────────────── */
  var LOGICAL_KEYS = Object.keys(DEFAULTS);
  var LOGICAL_TO_STORAGE = {};
  var STORAGE_TO_LOGICAL = {};
  LOGICAL_KEYS.forEach(function (logical) {
    var storageKey = KEYS[logical];
    if (!storageKey) return;
    LOGICAL_TO_STORAGE[logical] = storageKey;
    STORAGE_TO_LOGICAL[storageKey] = logical;
  });

  /* ── Helpers ───────────────────────────────────────────────────────── */
  function recordError(op, e) {
    try {
      var msg = String((e && (e.message || e.stack)) || e || '');
      errors.push({ t: Date.now(), op: String(op), e: msg });
      if (errors.length > ERR_MAX) errors.splice(0, errors.length - ERR_MAX);
    } catch (_) { /* swallow */ }
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!Number.isFinite(n)) return lo;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function coerce(logicalKey, value) {
    switch (logicalKey) {
      case 'theme':
        return THEMES.indexOf(value) >= 0 ? value : DEFAULTS.theme;
      case 'typography':
        return TYPOGRAPHIES.indexOf(value) >= 0 ? value : DEFAULTS.typography;
      case 'fontSize':
        return Math.round(clamp(value, BOUNDS.fontSize.min, BOUNDS.fontSize.max));
      case 'contentWidth':
        return Math.round(clamp(value, BOUNDS.contentWidth.min, BOUNDS.contentWidth.max));
      case 'showFolders':
      case 'showNotes':
      case 'plainText':
      case 'alwaysOnTop':
        return value === true || value === 'true' || value === 1;
      case 'presentationProfile':
        /* M04 P2 T4 (HDA decision D): a string is preserved exactly — an
         * unknown profile id or '' included — because the Renderer owns the
         * profile domain and resolves the effective profile / fallback per
         * render; nothing is validated or resolved here and no effective
         * fallback is ever persisted. Any non-string means the default; the
         * typeof test invokes no String()/toString/valueOf conversion. */
        return typeof value === 'string' ? value : DEFAULTS.presentationProfile;
      default:
        return value;
    }
  }

  function detectPlatform() {
    try {
      var platform = H2O.Studio && H2O.Studio.platform;
      if (!platform) return;
      if (platform.storage) {
        var env = platform.env || {};
        var real = env.adapter && env.adapter !== 'fallback';
        platformStorage = platform.storage;
        hasPlatformStorage = !!real;
      }
      if (platform.window && typeof platform.window.setAlwaysOnTop === 'function') {
        platformWindow = platform.window;
      }
    } catch (e) { recordError('detectPlatform', e); }
  }

  function notify(event) {
    /* In-module subscribers. */
    subscribers.forEach(function (fn) {
      try { fn(event); } catch (e) { recordError('subscriber', e); }
    });
    /* Also fire a window-level event so non-store consumers can listen
     * without holding a subscription handle (matches the H2O.events bus
     * pattern used elsewhere in Studio). */
    try {
      var detail = { type: event.type, key: event.key || null, value: event.value };
      global.dispatchEvent(new CustomEvent(EVENTS.changed, { detail: detail }));
    } catch (_) { /* swallow */ }
  }

  /* ── Persistence ──────────────────────────────────────────────────── */
  function scheduleFlush() {
    if (!hasPlatformStorage || !platformStorage) return;
    if (saveTimer) return;
    try {
      saveTimer = setTimeout(function () { saveTimer = null; flush(); }, SAVE_DEBOUNCE_MS);
    } catch (e) { saveTimer = null; recordError('scheduleFlush', e); }
  }

  function flush() {
    if (!hasPlatformStorage || !platformStorage) return;
    var keys = Array.from(pendingFlush);
    pendingFlush.clear();
    keys.forEach(function (logical) {
      var storageKey = LOGICAL_TO_STORAGE[logical];
      if (!storageKey) return;
      try {
        var p = platformStorage.set(storageKey, cache[logical]);
        if (p && typeof p.catch === 'function') {
          p.catch(function (e) { recordError('flush:' + logical, e); });
        }
      } catch (e) { recordError('flush:' + logical, e); }
    });
  }

  /* ── Apply to document ─────────────────────────────────────────────── */
  function apply() {
    var doc = global.document;
    if (!doc || !doc.documentElement) return;
    var root = doc.documentElement;
    try {
      root.setAttribute('data-h2o-theme', String(get('theme')));
      root.setAttribute('data-h2o-typography', String(get('typography')));
      root.setAttribute('data-h2o-plain-text', get('plainText') ? 'on' : 'off');
      root.setAttribute('data-h2o-show-folders', get('showFolders') ? 'on' : 'off');
      root.setAttribute('data-h2o-show-notes', get('showNotes') ? 'on' : 'off');
      root.style.setProperty('--wb-appearance-font-size', String(get('fontSize')) + 'px');
      root.style.setProperty('--wb-appearance-content-width', String(get('contentWidth')) + 'rem');
    } catch (e) { recordError('apply', e); }
  }

  /* ── Always-on-top forwarding (Tauri-only) ─────────────────────────── */
  function pushAlwaysOnTop() {
    if (!platformWindow) return;
    var desired = !!cache.alwaysOnTop;
    try {
      var p = platformWindow.setAlwaysOnTop(desired);
      if (p && typeof p.catch === 'function') {
        p.catch(function (e) { recordError('alwaysOnTop', e); });
      }
    } catch (e) { recordError('alwaysOnTop', e); }
  }

  /* ── Public API ────────────────────────────────────────────────────── */
  function get(logicalKey) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, logicalKey)) return undefined;
    if (Object.prototype.hasOwnProperty.call(cache, logicalKey)) {
      return coerce(logicalKey, cache[logicalKey]);
    }
    return DEFAULTS[logicalKey];
  }

  function set(logicalKey, value) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, logicalKey)) {
      recordError('set:unknown', new Error('unknown appearance key: ' + logicalKey));
      return;
    }
    var coerced = coerce(logicalKey, value);
    var prev = Object.prototype.hasOwnProperty.call(cache, logicalKey) ? cache[logicalKey] : DEFAULTS[logicalKey];
    if (prev === coerced) return;
    cache[logicalKey] = coerced;
    pendingFlush.add(logicalKey);
    scheduleFlush();
    if (logicalKey === 'alwaysOnTop') pushAlwaysOnTop();
    apply();
    notify({ type: 'change', key: logicalKey, value: coerced });
  }

  function getAll() {
    var out = {};
    LOGICAL_KEYS.forEach(function (k) { out[k] = get(k); });
    return out;
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    subscribers.add(fn);
    return function () { subscribers.delete(fn); };
  }

  function isReady() { return hydrated; }

  function alwaysOnTopAvailable() { return !!platformWindow; }

  function selfCheck() {
    return {
      ok: errors.length === 0,
      version: STORE_VERSION,
      hydrated: hydrated,
      hasPlatformStorage: hasPlatformStorage,
      alwaysOnTopAvailable: !!platformWindow,
      state: getAll(),
      errors: errors.slice(),
    };
  }

  /* ── Boot hydration ────────────────────────────────────────────────── */
  function markReady() {
    if (hydrated) return;
    hydrated = true;
    notify({ type: 'ready', key: null, value: null });
    try {
      global.dispatchEvent(new CustomEvent(EVENTS.ready, { detail: { at: Date.now() } }));
    } catch (_) { /* swallow */ }
  }

  function bootHydrate() {
    detectPlatform();
    if (!hasPlatformStorage || !platformStorage) {
      /* No real storage adapter — apply defaults and mark ready. */
      apply();
      markReady();
      return;
    }
    var pending = LOGICAL_KEYS.length;
    if (pending === 0) { apply(); markReady(); return; }
    LOGICAL_KEYS.forEach(function (logical) {
      var storageKey = LOGICAL_TO_STORAGE[logical];
      function done() {
        pending -= 1;
        if (pending === 0) {
          apply();
          /* Surface the persisted always-on-top into the window once on boot.
           * Without this, restarting the app would forget the toggle. */
          if (cache.alwaysOnTop && platformWindow) pushAlwaysOnTop();
          markReady();
        }
      }
      try {
        var result = platformStorage.get(storageKey);
        if (result && typeof result.then === 'function') {
          result.then(function (value) {
            if (value !== undefined && value !== null) cache[logical] = coerce(logical, value);
            done();
          }, function (e) { recordError('boot:hydrate:' + logical, e); done(); });
        } else {
          if (result !== undefined && result !== null) cache[logical] = coerce(logical, result);
          done();
        }
      } catch (e) { recordError('boot:hydrate:' + logical, e); done(); }
    });
  }

  /* ── Install ───────────────────────────────────────────────────────── */
  H2O.Studio.appearance.__storeInstalled = true;
  H2O.Studio.appearance.get = get;
  H2O.Studio.appearance.set = set;
  H2O.Studio.appearance.getAll = getAll;
  H2O.Studio.appearance.subscribe = subscribe;
  H2O.Studio.appearance.apply = apply;
  H2O.Studio.appearance.isReady = isReady;
  H2O.Studio.appearance.alwaysOnTopAvailable = alwaysOnTopAvailable;
  H2O.Studio.appearance.selfCheck = selfCheck;

  /* Apply defaults synchronously so first paint already carries the data
   * attributes (no flash of un-themed content). bootHydrate then refines. */
  apply();

  /* Defer hydration to next tick so platform.tauri.js / platform.mv3.js
   * finish their adapter registration before we read storage env. */
  try {
    if (typeof global.queueMicrotask === 'function') {
      global.queueMicrotask(bootHydrate);
    } else {
      setTimeout(bootHydrate, 0);
    }
  } catch (e) { recordError('boot:schedule', e); bootHydrate(); }
})(typeof window !== 'undefined' ? window : this);
