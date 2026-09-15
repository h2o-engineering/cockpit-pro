/* H2O Studio Platform — Namespace Entry
 *
 * Creates `H2O.Studio.platform` with safe defaults and a registration helper.
 * Adapter modules (platform.mv3.js, future platform.tauri.js) self-register
 * by calling `H2O.Studio.platform.__registerAdapter(impl)`.
 *
 * Idempotent: re-loading this script does not overwrite an already-installed
 * platform or adapter.
 *
 * Contract: see surfaces/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md.
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};

  if (H2O.Studio.platform && H2O.Studio.platform.__installed) {
    return;
  }

  var BOOT_AT = Date.now();
  var WARNINGS = [];

  function noopAsync() { return Promise.resolve(); }
  function noopUnsub() { return function () {}; }
  function unavailableAsync(name) {
    return function () {
      return Promise.reject(new Error('H2O.Studio.platform.' + name + ' unavailable (no adapter bound)'));
    };
  }
  function resolveAssetAgainstDocument(path) {
    var raw = String(path == null ? '' : path).trim();
    if (!raw) return '';
    try {
      var base = '';
      if (global.document && typeof global.document.baseURI === 'string') {
        base = global.document.baseURI;
      } else if (global.location && typeof global.location.href === 'string') {
        base = global.location.href;
      }
      if (base && typeof global.URL === 'function') {
        return new global.URL(raw, base).href;
      }
    } catch (_) { /* preserve the caller-supplied path below */ }
    return raw;
  }
  function inferenceUnavailableStatus() {
    return {
      ok: true,
      available: false,
      configured: false,
      provider: null,
      reason: 'provider-unavailable',
      message: 'AI provider unavailable',
      phase: '3d-a',
      network: false,
      adapter: current && current.name ? current.name : 'fallback',
    };
  }
  function inferenceRunUnavailable(request) {
    var req = (request && typeof request === 'object') ? request : {};
    return Promise.resolve({
      ok: false,
      requestId: req.requestId || null,
      action: req.action || null,
      reason: 'provider-unavailable',
      message: 'AI provider unavailable',
      status: inferenceUnavailableStatus(),
    });
  }
  function inferenceCancelUnavailable(requestId) {
    return Promise.resolve({
      ok: true,
      requestId: requestId || null,
      cancelled: false,
      reason: 'provider-unavailable',
      message: 'AI provider unavailable',
    });
  }
  function inferenceSelfCheck() {
    var status = inferenceUnavailableStatus();
    return {
      ok: true,
      phase: status.phase,
      available: status.available,
      configured: status.configured,
      provider: status.provider,
      reason: status.reason,
      message: status.message,
      network: status.network,
      adapter: status.adapter,
      hasGetStatus: true,
      hasRun: true,
      hasCancel: true,
    };
  }

  /* Fallback adapter: present from the moment index.js loads so feature code
   * never sees `undefined` on the platform surface. Each method either no-ops
   * (broadcast.emit, storage.set with same value) or returns a rejected
   * Promise with a clear message. Replaced when a real adapter registers.
   */
  var fallback = {
    name: 'fallback',
    version: '0.1.0',
    env: {
      adapter: 'fallback',
      version: '0.1.0',
      bootedAt: BOOT_AT,
      isExtension: false,
      isTauri: false,
      isDev: false,
    },
    messaging: {
      send: unavailableAsync('messaging.send'),
      on: noopUnsub,
    },
    broadcast: {
      emit: unavailableAsync('broadcast.emit'),
      on: noopUnsub,
      emitRaw: unavailableAsync('broadcast.emitRaw'),
      onAnyChange: noopUnsub,
    },
    storage: {
      get: function () { return Promise.resolve(null); },
      set: unavailableAsync('storage.set'),
      remove: unavailableAsync('storage.remove'),
    },
    runtime: {
      resolveAsset: resolveAssetAgainstDocument,
      openUrl: unavailableAsync('runtime.openUrl'),
    },
    files: { available: false },
    capture: { available: false },
    auth: { available: false },
    inference: {
      available: false,
      phase: '3d-a',
      getStatus: inferenceUnavailableStatus,
      run: inferenceRunUnavailable,
      cancel: inferenceCancelUnavailable,
      selfCheck: inferenceSelfCheck,
    },
    /* Phase 1b — one-shot text writes for actions like Studio Ribbon's
     * "Copy title". readText is intentionally not part of the contract
     * today; add it only when a feature genuinely needs paste support. */
    clipboard: {
      writeText: unavailableAsync('clipboard.writeText'),
    },
  };

  var current = fallback;

  function registerAdapter(impl) {
    if (!impl || typeof impl !== 'object') {
      WARNINGS.push('registerAdapter called with non-object');
      return false;
    }
    if (current && current.name !== 'fallback') {
      WARNINGS.push('adapter "' + current.name + '" already registered; ignoring "' + (impl.name || 'unknown') + '"');
      return false;
    }
    current = Object.assign({}, fallback, impl);
    current.env = Object.assign({}, fallback.env, impl.env || {});
    current.runtime = Object.assign({}, fallback.runtime, impl.runtime || {});
    /* STAB-03 D1 compatibility normalization. Older Tauri adapters expose
     * openUrl at the adapter top level; promote that existing capability into
     * the canonical runtime provider until caller migration retires the alias. */
    if ((!impl.runtime || typeof impl.runtime.openUrl !== 'function') &&
        typeof impl.openUrl === 'function') {
      current.runtime.openUrl = impl.openUrl;
    }
    /* Re-bind the public surface so existing references keep working. */
    platform.env = current.env;
    platform.messaging = current.messaging;
    platform.broadcast = current.broadcast;
    platform.storage = current.storage;
    platform.runtime = current.runtime;
    platform.files = current.files;
    platform.capture = current.capture;
    platform.auth = current.auth;
    /* STAB-03 D1 temporary compatibility alias. runtime.openUrl is the
     * canonical contract; this top-level alias exists only for pre-migration
     * callers and must not become a second durable feature-facing namespace. */
    platform.openUrl = current.runtime.openUrl;
    /* Phase 3d-A — passive AI inference contract. Defaults to unavailable
     * and never performs network/provider work unless a future adapter
     * explicitly replaces this surface. */
    platform.inference = current.inference || fallback.inference;
    /* Phase 1b — clipboard contract. Defaults to the fallback rejecter
     * if the adapter doesn't expose its own clipboard. */
    platform.clipboard = current.clipboard || fallback.clipboard;
    /* Tauri-specific extension: window namespace (setAlwaysOnTop, future
     * window operations). Same conditional-mirror pattern as openUrl so the
     * appearance store's feature-detect via `platform.window?.setAlwaysOnTop`
     * sees it on Tauri and stays undefined on MV3/fallback. */
    if (current.window && typeof current.window.setAlwaysOnTop === 'function') {
      platform.window = current.window;
    }
    /* Notify listeners that a real adapter is now bound. */
    try {
      if (H2O.events && typeof H2O.events.emit === 'function') {
        H2O.events.emit('evt:h2o:studio:platform:ready', { adapter: current.name, version: current.version });
      } else if (typeof global.dispatchEvent === 'function') {
        global.dispatchEvent(new global.CustomEvent('h2o:studio:platform:ready', { detail: { adapter: current.name, version: current.version } }));
      }
    } catch (e) {
      WARNINGS.push('platform:ready emit failed: ' + (e && e.message ? e.message : String(e)));
    }
    return true;
  }

  function diagnose() {
    var chromeRuntime = false;
    var chromeStorage = false;
    try { chromeRuntime = !!(global.chrome && global.chrome.runtime && global.chrome.runtime.id); } catch (e) { chromeRuntime = false; }
    try { chromeStorage = !!(global.chrome && global.chrome.storage && global.chrome.storage.local); } catch (e) { chromeStorage = false; }

    var broadcastReady = !!(platform.broadcast && platform.broadcast.emit && platform.broadcast.emit !== fallback.broadcast.emit);
    var storageReady = !!(platform.storage && platform.storage.set && platform.storage.set !== fallback.storage.set);
    var messagingReady = !!(platform.messaging && platform.messaging.send && platform.messaging.send !== fallback.messaging.send);
    var selectorsLoaded = !!(H2O.Studio && H2O.Studio.SELECTORS && typeof H2O.Studio.SELECTORS === 'object');
    var inferenceStatus = null;
    try {
      if (platform.inference && typeof platform.inference.getStatus === 'function') {
        inferenceStatus = platform.inference.getStatus();
      }
    } catch (e) {
      inferenceStatus = { available: false, reason: 'status-error', message: e && e.message ? e.message : String(e) };
    }

    return {
      adapter: current.name,
      adapterVersion: current.version,
      bootedAt: BOOT_AT,
      ageMs: Date.now() - BOOT_AT,
      chromeRuntime: chromeRuntime,
      chromeStorage: chromeStorage,
      broadcastReady: broadcastReady,
      storageReady: storageReady,
      messagingReady: messagingReady,
      inferenceReady: !!(inferenceStatus && inferenceStatus.available),
      inferenceStatus: inferenceStatus,
      selectorsLoaded: selectorsLoaded,
      warnings: WARNINGS.slice(),
    };
  }

  var platform = {
    __installed: true,
    __registerAdapter: registerAdapter,
    __warn: function (msg) { WARNINGS.push(String(msg)); },
    env: fallback.env,
    messaging: fallback.messaging,
    broadcast: fallback.broadcast,
    storage: fallback.storage,
    runtime: fallback.runtime,
    /* Temporary D1 compatibility alias; canonical callers use runtime.openUrl. */
    openUrl: fallback.runtime.openUrl,
    files: fallback.files,
    capture: fallback.capture,
    auth: fallback.auth,
    inference: fallback.inference,
    /* Phase 1b — clipboard contract. Starts at the fallback rejecter and
     * is re-bound by registerAdapter when a real adapter is installed. */
    clipboard: fallback.clipboard,
    diagnose: diagnose,
  };

  H2O.Studio.platform = platform;
})(typeof window !== 'undefined' ? window : globalThis);
