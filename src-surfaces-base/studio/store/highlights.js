/* H2O Studio Store — Highlights Entity
 *
 * Owns Highlights persistence on the Studio side. After Phase A1 there is
 * a single active backend (chrome.storage.local) and a single canonical
 * key. Legacy fallbacks (localStorage mirror, GM_*, alias keys, migration
 * flag) have been removed in favor of clean architecture.
 *
 * Active storage path:
 *   chrome.storage.local  ←  H2O.Studio.store.highlights  ←  S3H1a feature code
 *
 * Cross-context sync:
 *   chrome.storage.onChanged via H2O.Studio.platform.broadcast.onAnyChange
 *   when available; falls back to direct chrome.storage.onChanged.
 *   Studio and native 3H1a share the same canonical chrome.storage.local
 *   key and stay in sync via these change events.
 *
 * Wire format (must match native 3H1a):
 *   key  : 'h2o:prm:cgx:nlnhghlghtr:state:inline_highlights:v3'
 *   shape: { itemsByAnswer: { [answerId]: Item[] },
 *            convoId?: string,
 *            _meta?: { currentColor?: string } }
 *   debounce: 250ms
 *   schemaVersion: 3
 *
 * UI prefs (KEY_CFG_UI_V1) are NOT owned by this store. They remain in
 * S3H1a's CFG_loadUiConfig / CFG_saveUiConfig (separate concern).
 *
 * Contracts: surfaces/studio/store/README.md
 *            surfaces/studio/STUDIO_STORAGE_CONTRACT.md
 *            surfaces/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  var store = H2O.Studio.store;
  if (!store || typeof store.__registerEntity !== 'function') {
    /* store/index.js didn't load — fail closed but don't throw. */
    try { console.warn('[H2O.Studio.store.highlights] H2O.Studio.store not present; entity not registered'); }
    catch (_) { /* ignore */ }
    return;
  }
  if (store.highlights && store.highlights.__installed) {
    return;
  }

  /* ── Constants ────────────────────────────────────────────────────── */
  var NS_DISK = 'h2o:prm:cgx:nlnhghlghtr';
  var KEY_DISK_CANON = NS_DISK + ':state:inline_highlights:v3';
  var SCHEMA_VERSION = 3;
  var SAVE_DEBOUNCE_MS = 250;

  /* ── State ────────────────────────────────────────────────────────── */
  var state = {
    cache: null,                /* canonical blob; null until init() */
    ready: false,
    pending: false,             /* dirty + scheduled save */
    saveTimer: null,
    lastSavedAt: null,
    lastFlushAt: null,           /* most recent writeCanonical completion */
    lastReloadedAt: null,
    lastWriteAt: null,           /* most recent update/set/remove call */
    writesSinceBoot: 0,
    savesSinceBoot: 0,
    unsubBroadcast: null,
    errors: [],
    errMax: 20,
    warnings: [],
    warnMax: 20,
    subscribers: new Set(),
    preciseWriteInFlight: false,
    inFlightSave: null,
  };

  function recordWrite(/* op */) {
    state.writesSinceBoot += 1;
    state.lastWriteAt = Date.now();
  }

  function recordWarning(msg) {
    try {
      state.warnings.push({ t: Date.now(), msg: String(msg) });
      if (state.warnings.length > state.warnMax) {
        state.warnings.splice(0, state.warnings.length - state.warnMax);
      }
    } catch (_) { /* swallow */ }
  }

  function recordError(op, e) {
    try {
      state.errors.push({ t: Date.now(), op: String(op), e: String((e && e.stack) || e || '') });
      if (state.errors.length > state.errMax) {
        state.errors.splice(0, state.errors.length - state.errMax);
      }
    } catch (_) { /* swallow */ }
  }

  /* ── Capability detection ─────────────────────────────────────────── */
  function hasChromeStorage() {
    try {
      return !!(global.chrome && global.chrome.storage && global.chrome.storage.local
        && typeof global.chrome.storage.local.get === 'function'
        && typeof global.chrome.storage.local.set === 'function');
    } catch (_) { return false; }
  }
  function getPlatformBroadcast() {
    var p = global.H2O && global.H2O.Studio && global.H2O.Studio.platform && global.H2O.Studio.platform.broadcast;
    if (!p || typeof p.onAnyChange !== 'function') return null;
    var env = global.H2O && global.H2O.Studio && global.H2O.Studio.platform && global.H2O.Studio.platform.env;
    if (env && env.adapter === 'fallback') return null;
    return p;
  }

  /* ── Helpers ──────────────────────────────────────────────────────── */
  function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }
  function asStoreObj(v) { return isPlainObject(v) ? v : {}; }
  function clone(obj) {
    try { return JSON.parse(JSON.stringify(obj || {})); }
    catch (_) { return {}; }
  }
  function ensureShape(obj) {
    var blob = isPlainObject(obj) ? clone(obj) : {};
    if (!isPlainObject(blob.itemsByAnswer)) blob.itemsByAnswer = {};
    if (!isPlainObject(blob._meta)) blob._meta = {};
    return blob;
  }
  function countItems(blob) {
    var total = 0;
    var iba = asStoreObj(asStoreObj(blob).itemsByAnswer);
    var keys = Object.keys(iba);
    for (var i = 0; i < keys.length; i += 1) {
      var arr = iba[keys[i]];
      if (Array.isArray(arr)) total += arr.length;
    }
    return total;
  }

  /* Non-destructive merge: last-write-wins by per-item `ts`. Mirrors
   * native 3H1a's _mergeStore semantics so cross-tab races stay
   * byte-identical between Studio and native. */
  function mergeBlob(a, b, oldValue) {
    if (!isPlainObject(a) && !isPlainObject(b)) return null;
    if (!isPlainObject(a)) return clone(b);
    if (!isPlainObject(b)) return clone(a);
    var out = clone(a);
    out.itemsByAnswer = asStoreObj(out.itemsByAnswer);
    var srcItems = asStoreObj(b.itemsByAnswer);
    var keys = Object.keys(srcItems);
    for (var i = 0; i < keys.length; i += 1) {
      var ans = keys[i];
      var srcList = srcItems[ans];
      if (!Array.isArray(srcList) || !srcList.length) continue;
      var prevList = Array.isArray(out.itemsByAnswer[ans]) ? out.itemsByAnswer[ans].slice() : [];
      var byId = Object.create(null);
      for (var j = 0; j < prevList.length; j += 1) {
        var p = prevList[j];
        var pid = (p && p.id != null) ? String(p.id) : '';
        if (pid) byId[pid] = p;
      }
      for (var k = 0; k < srcList.length; k += 1) {
        var item = srcList[k];
        if (!isPlainObject(item)) continue;
        var iid = item.id != null ? String(item.id) : '';
        if (!iid) { prevList.push(item); continue; }
        var prevTs = Number(byId[iid] && byId[iid].ts || 0);
        var nextTs = Number(item.ts || 0);
        if (!byId[iid] || nextTs >= prevTs) byId[iid] = item;
      }
      var mergedIds = Object.keys(byId);
      var merged = [];
      for (var m = 0; m < mergedIds.length; m += 1) merged.push(byId[mergedIds[m]]);
      for (var n = 0; n < prevList.length; n += 1) {
        var it = prevList[n];
        if (!(it && it.id != null)) merged.push(it);
      }
      out.itemsByAnswer[ans] = merged;
    }
    /* A hard delete has no tombstone. The storage change's old/new pair is
     * sufficient to remove an item that has not gained a newer local ts. */
    var oldItems = asStoreObj(asStoreObj(oldValue).itemsByAnswer);
    Object.keys(oldItems).forEach(function (ans) {
      var before = Array.isArray(oldItems[ans]) ? oldItems[ans] : [];
      var after = Array.isArray(srcItems[ans]) ? srcItems[ans] : [];
      var retained = new Set(after.map(function (it) { return String(it && it.id || ''); }));
      var removed = new Map();
      before.forEach(function (it) {
        var id = String(it && it.id || '');
        if (id && !retained.has(id)) removed.set(id, Number(it.ts || 0));
      });
      if (!removed.size || !Array.isArray(out.itemsByAnswer[ans])) return;
      out.itemsByAnswer[ans] = out.itemsByAnswer[ans].filter(function (it) {
        var id = String(it && it.id || '');
        return !removed.has(id) || Number(it.ts || 0) > removed.get(id);
      });
    });
    if (!isPlainObject(out._meta)) out._meta = {};
    var srcMeta = isPlainObject(b._meta) ? b._meta : {};
    if (!out._meta.currentColor && srcMeta.currentColor) out._meta.currentColor = String(srcMeta.currentColor);
    if (!out.convoId && b.convoId) out.convoId = String(b.convoId);
    return out;
  }

  /* ── Low-level disk I/O ───────────────────────────────────────────── */
  /* Read the canonical key from chrome.storage.local. No localStorage
   * fallback — chrome.storage.local is the single backend. Errors surface
   * in diagnose().errors rather than silently degrading to localStorage. */
  function readCanonical() {
    return new Promise(function (resolve) {
      if (!hasChromeStorage()) {
        recordWarning('chrome.storage unavailable on read');
        resolve(null);
        return;
      }
      try {
        global.chrome.storage.local.get([KEY_DISK_CANON], function (r) {
          var v = r && r[KEY_DISK_CANON];
          resolve(isPlainObject(v) ? v : null);
        });
      } catch (e) {
        recordError('readCanonical.chrome.throw', e);
        resolve(null);
      }
    });
  }

  function readCanonicalStrict() {
    return new Promise(function (resolve, reject) {
      if (!hasChromeStorage()) { reject(new Error('Highlights storage unavailable')); return; }
      try {
        global.chrome.storage.local.get([KEY_DISK_CANON], function (record) {
          var err = global.chrome && global.chrome.runtime && global.chrome.runtime.lastError;
          if (err) { reject(new Error(String(err.message || err))); return; }
          var value = record && record[KEY_DISK_CANON];
          resolve(isPlainObject(value) ? value : null);
        });
      } catch (e) { reject(e); }
    });
  }

  /* Write the canonical blob to chrome.storage.local. No localStorage
   * mirror — chrome.storage.local is the single backend. */
  function writeCanonical(blob) {
    var safe = ensureShape(blob);
    safe._meta.source = 'studio';
    return new Promise(function (resolve) {
      if (!hasChromeStorage()) {
        recordWarning('chrome.storage unavailable on write');
        state.lastSavedAt = Date.now();
        state.lastFlushAt = state.lastSavedAt;
        state.savesSinceBoot += 1;
        resolve();
        return;
      }
      try {
        var obj = {};
        obj[KEY_DISK_CANON] = safe;
        global.chrome.storage.local.set(obj, function () {
          var err = global.chrome && global.chrome.runtime && global.chrome.runtime.lastError;
          if (err) recordError('writeCanonical.chrome', err);
          state.lastSavedAt = Date.now();
          state.lastFlushAt = state.lastSavedAt;
          state.savesSinceBoot += 1;
          resolve();
        });
      } catch (e) {
        recordError('writeCanonical.chrome.throw', e);
        state.lastSavedAt = Date.now();
        state.lastFlushAt = state.lastSavedAt;
        state.savesSinceBoot += 1;
        resolve();
      }
    });
  }

  function writeCanonicalStrict(blob) {
    var safe = ensureShape(blob);
    safe._meta.source = 'studio';
    return new Promise(function (resolve, reject) {
      if (!hasChromeStorage()) { reject(new Error('Highlights storage unavailable')); return; }
      try {
        var record = {};
        record[KEY_DISK_CANON] = safe;
        global.chrome.storage.local.set(record, function () {
          var err = global.chrome && global.chrome.runtime && global.chrome.runtime.lastError;
          if (err) { reject(new Error(String(err.message || err))); return; }
          state.lastSavedAt = Date.now();
          state.lastFlushAt = state.lastSavedAt;
          state.savesSinceBoot += 1;
          resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  function trackSave(promise) {
    state.inFlightSave = promise;
    promise.then(function () {
      if (state.inFlightSave === promise) state.inFlightSave = null;
    }, function () {
      if (state.inFlightSave === promise) state.inFlightSave = null;
    });
    return promise;
  }

  function scheduleSave() {
    state.pending = true;
    if (state.saveTimer) return;
    state.saveTimer = global.setTimeout(function () {
      state.saveTimer = null;
      if (!state.pending || state.cache == null) return;
      state.pending = false;
      trackSave(writeCanonical(state.cache)).catch(function (e) { recordError('scheduleSave.write', e); });
    }, SAVE_DEBOUNCE_MS);
  }

  /* ── Cross-tab listener ───────────────────────────────────────────── */
  function bindBroadcast() {
    if (state.unsubBroadcast) return true;
    var pb = getPlatformBroadcast();
    if (pb) {
      try {
        state.unsubBroadcast = pb.onAnyChange(handleChange);
        return true;
      } catch (e) {
        recordError('bindBroadcast.platform', e);
        /* fall through to direct chrome.storage.onChanged */
      }
    }
    if (hasChromeStorage() && global.chrome.storage.onChanged
        && typeof global.chrome.storage.onChanged.addListener === 'function') {
      try {
        var listener = function (changes, area) { handleChange(changes, area); };
        global.chrome.storage.onChanged.addListener(listener);
        state.unsubBroadcast = function () {
          try { global.chrome.storage.onChanged.removeListener(listener); }
          catch (_) { /* ignore */ }
        };
        return true;
      } catch (e) { recordError('bindBroadcast.chrome', e); }
    }
    return false;
  }

  function handleChange(changes, area) {
    if (area !== 'local') return;
    if (!changes || !Object.prototype.hasOwnProperty.call(changes, KEY_DISK_CANON)) return;
    var rec = changes[KEY_DISK_CANON];
    var next = rec && rec.newValue;
    if (!isPlainObject(next)) return;
    /* Merge incoming non-destructively to honor per-item last-write-wins. */
    var merged = mergeBlob(state.cache || {}, next, rec && rec.oldValue);
    if (merged) state.cache = merged;
    state.lastReloadedAt = Date.now();
    notifySubscribers({ source: 'cross-tab' });
  }

  function notifySubscribers(change) {
    state.subscribers.forEach(function (fn) {
      try { fn(change || {}); } catch (e) { recordError('notifySubscribers', e); }
    });
  }

  /* ── Public API ───────────────────────────────────────────────────── */
  function init() {
    if (state.ready) return Promise.resolve(state.cache);
    return readCanonical().then(function (blob) {
      state.cache = ensureShape(blob || {});
      state.lastReloadedAt = Date.now();
      bindBroadcast();
      state.ready = true;
      return state.cache;
    }).catch(function (e) {
      recordError('init', e);
      state.cache = ensureShape({});
      state.ready = true;
      return state.cache;
    });
  }

  function dispose() {
    if (state.unsubBroadcast) {
      try { state.unsubBroadcast(); } catch (_) { /* ignore */ }
      state.unsubBroadcast = null;
    }
    if (state.saveTimer) {
      try { global.clearTimeout(state.saveTimer); } catch (_) { /* ignore */ }
      state.saveTimer = null;
    }
    state.ready = false;
  }

  function isReady() { return !!state.ready; }

  /* Returns the LIVE in-memory cache reference (not a clone) for byte-parity
   * with the legacy UTIL_storage.readSync() contract in S3H1a. Feature code
   * MUST NOT mutate the returned object directly — use setForAnswer /
   * removeForAnswer / update / setCurrentColor for mutations. */
  function getAll() {
    if (state.cache == null) state.cache = ensureShape({});
    return state.cache;
  }

  function getForAnswer(answerId) {
    var id = String(answerId == null ? '' : answerId).trim();
    if (!id || !state.cache) return [];
    var iba = asStoreObj(state.cache.itemsByAnswer);
    var list = iba[id];
    return Array.isArray(list) ? clone(list) : [];
  }

  function setForAnswer(answerId, items) {
    var id = String(answerId == null ? '' : answerId).trim();
    if (!id) { recordError('setForAnswer', new Error('empty answerId')); return; }
    if (!state.cache) state.cache = ensureShape({});
    var iba = state.cache.itemsByAnswer = asStoreObj(state.cache.itemsByAnswer);
    if (Array.isArray(items) && items.length) {
      iba[id] = clone(items);
    } else {
      delete iba[id];
    }
    recordWrite('setForAnswer');
    scheduleSave();
    notifySubscribers({ source: 'local', op: 'setForAnswer', answerId: id });
  }

  function removeForAnswer(answerId) {
    var id = String(answerId == null ? '' : answerId).trim();
    if (!id || !state.cache) return;
    var iba = asStoreObj(state.cache.itemsByAnswer);
    if (Object.prototype.hasOwnProperty.call(iba, id)) {
      delete iba[id];
      recordWrite('removeForAnswer');
      scheduleSave();
      notifySubscribers({ source: 'local', op: 'removeForAnswer', answerId: id });
    }
  }

  function update(updaterOrObj) {
    if (!state.cache) state.cache = ensureShape({});
    var next;
    if (typeof updaterOrObj === 'function') {
      var draft = clone(state.cache);
      var result;
      try { result = updaterOrObj(draft); }
      catch (e) { recordError('update.updater', e); return; }
      next = isPlainObject(result) ? result : draft;
    } else if (isPlainObject(updaterOrObj)) {
      next = updaterOrObj;
    } else {
      recordError('update', new Error('invalid argument: expected function or plain object'));
      return;
    }
    state.cache = ensureShape(next);
    recordWrite('update');
    scheduleSave();
    notifySubscribers({ source: 'local', op: 'update' });
  }

  function saveNow() {
    if (state.saveTimer) {
      try { global.clearTimeout(state.saveTimer); } catch (_) { /* ignore */ }
      state.saveTimer = null;
    }
    state.pending = false;
    if (state.cache == null) return Promise.resolve();
    return trackSave(writeCanonical(state.cache)).catch(function (e) { recordError('saveNow', e); });
  }

  function reloadStrict() {
    return readCanonicalStrict().then(function (blob) {
      state.cache = ensureShape(blob || {});
      state.lastReloadedAt = Date.now();
      notifySubscribers({ source: 'reload' });
      return clone(state.cache);
    });
  }

  /* Precise Dock writes read the canonical item again immediately before
   * mutation and publish the cache only after storage callback + readback. */
  async function applyExisting(request) {
    if (state.preciseWriteInFlight) return { ok: false, reason: 'busy' };
    state.preciseWriteInFlight = true;
    try {
      await init();
      if (state.inFlightSave) await state.inFlightSave;
      if (state.pending) await saveNow();
      var disk = await readCanonicalStrict();
      if (!isPlainObject(disk)) return { ok: false, reason: 'missing-store' };
      var draft = ensureShape(disk);
      var answerId = String(request && request.answerId || '').trim();
      var id = String(request && request.id || '').trim();
      var convoId = String(request && request.convoId || '').trim();
      var op = String(request && request.op || '');
      var list = asStoreObj(draft.itemsByAnswer)[answerId];
      if (!answerId || !id || !convoId || !Array.isArray(list) ||
          (op !== 'recolor' && op !== 'remove')) return { ok: false, reason: 'invalid-target' };
      var matches = list.filter(function (item) { return item && String(item.id || '') === id; });
      if (matches.length !== 1 || (matches[0].convoId && matches[0].convoId !== convoId)) {
        return { ok: false, reason: 'missing-or-foreign-item' };
      }
      if (typeof request.guard !== 'function' || request.guard() !== true) {
        return { ok: false, reason: 'stale-reader' };
      }
      var previous = matches[0];
      var nextTs = 0;
      if (op === 'recolor') {
        var color = String(request.color || '').trim().toLowerCase();
        if (!request.allowedColors || !request.allowedColors.includes(color)) {
          return { ok: false, reason: 'invalid-color' };
        }
        nextTs = Date.now();
        if (nextTs <= Number(previous.ts || 0)) return { ok: false, reason: 'clock-not-advanced' };
        previous.color = color;
        previous.ts = nextTs;
      } else {
        draft.itemsByAnswer[answerId] = list.filter(function (item) { return String(item && item.id || '') !== id; });
      }
      await writeCanonicalStrict(draft);
      var confirmed = await readCanonicalStrict();
      var confirmedList = confirmed && confirmed.itemsByAnswer && confirmed.itemsByAnswer[answerId];
      var confirmedItem = Array.isArray(confirmedList)
        ? confirmedList.find(function (item) { return item && String(item.id || '') === id; }) : null;
      if (!isPlainObject(confirmed) || !isPlainObject(confirmed._meta) || confirmed._meta.source !== 'studio' ||
          (op === 'recolor' && (!confirmedItem || confirmedItem.color !== request.color || confirmedItem.ts !== nextTs)) ||
          (op === 'remove' && confirmedItem)) throw new Error('Highlights persistence readback mismatch');
      state.cache = ensureShape(confirmed);
      state.lastReloadedAt = Date.now();
      recordWrite('applyExisting');
      notifySubscribers({ source: 'local', op: 'applyExisting', answerId: answerId });
      return { ok: true, item: confirmedItem ? clone(confirmedItem) : null };
    } catch (e) {
      recordError('applyExisting', e);
      try { await reloadStrict(); } catch (reloadError) { recordError('applyExisting.reload', reloadError); }
      return { ok: false, reason: 'persistence-failed' };
    } finally {
      state.preciseWriteInFlight = false;
    }
  }

  function reload() {
    return readCanonical().then(function (blob) {
      state.cache = ensureShape(blob || {});
      state.lastReloadedAt = Date.now();
      notifySubscribers({ source: 'reload' });
      return clone(state.cache);
    }).catch(function (e) {
      recordError('reload', e);
      return state.cache ? clone(state.cache) : ensureShape({});
    });
  }

  function getCurrentColor() {
    var c = state.cache && state.cache._meta && state.cache._meta.currentColor;
    return c ? String(c) : '';
  }

  function setCurrentColor(name) {
    if (!state.cache) state.cache = ensureShape({});
    if (!isPlainObject(state.cache._meta)) state.cache._meta = {};
    state.cache._meta.currentColor = String(name == null ? '' : name).trim().toLowerCase();
    recordWrite('setCurrentColor');
    scheduleSave();
    notifySubscribers({ source: 'local', op: 'setCurrentColor' });
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    state.subscribers.add(fn);
    return function () { state.subscribers.delete(fn); };
  }

  function diagnose() {
    var backend = hasChromeStorage() ? 'chrome.storage' : 'none';
    var cacheAnswers = state.cache ? Object.keys(asStoreObj(state.cache.itemsByAnswer)).length : 0;
    return {
      installed: true,
      ready: state.ready,
      schemaVersion: SCHEMA_VERSION,
      backend: backend,
      canonicalKey: KEY_DISK_CANON,
      crossTabBound: !!state.unsubBroadcast,
      cacheAnswers: cacheAnswers,
      cacheItems: state.cache ? countItems(state.cache) : 0,
      pendingSave: !!state.pending,
      saveDebounceMs: SAVE_DEBOUNCE_MS,
      lastSavedAt: state.lastSavedAt,
      lastFlushAt: state.lastFlushAt,
      lastReloadedAt: state.lastReloadedAt,
      lastWriteAt: state.lastWriteAt,
      writesSinceBoot: state.writesSinceBoot,
      savesSinceBoot: state.savesSinceBoot,
      subscribers: state.subscribers.size,
      errors: state.errors.slice(),
      warnings: state.warnings.slice(),
    };
  }

  /* ── Register & schedule init ─────────────────────────────────────── */
  var api = {
    __installed: true,
    __version: '0.2.0',
    init: init,
    dispose: dispose,
    isReady: isReady,
    getForAnswer: getForAnswer,
    setForAnswer: setForAnswer,
    removeForAnswer: removeForAnswer,
    getAll: getAll,
    update: update,
    saveNow: saveNow,
    reload: reload,
    reloadStrict: reloadStrict,
    applyExisting: applyExisting,
    getCurrentColor: getCurrentColor,
    setCurrentColor: setCurrentColor,
    subscribe: subscribe,
    diagnose: diagnose,
  };
  store.__registerEntity('highlights', api);

  /* Hydrate on next tick so the platform adapter has time to register.
   * init() only READS the canonical key — no mutation on boot. */
  global.setTimeout(function () {
    init().catch(function (e) { recordError('autoInit', e); });
  }, 0);
})(typeof window !== 'undefined' ? window : globalThis);
