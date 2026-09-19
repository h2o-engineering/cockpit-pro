/* H2O Studio Platform — MV3 Adapter
 *
 * Self-registering MV3/Chrome-extension implementation of the platform
 * adapter surface declared in surfaces/studio/STUDIO_PLATFORM_ADAPTER_GUIDE.md.
 *
 * Detects MV3 (`chrome.runtime?.id`) at load time. If absent, this script
 * silently no-ops and leaves the fallback adapter in place.
 *
 * Conservative wrappers only. This module does NOT migrate existing call
 * sites; existing direct chrome.* usage elsewhere in Studio remains.
 *
 * Broadcast key prefix: `h2o:studio:platform:broadcast:` (intentionally
 * separate from `h2o:library:cross-surface:broadcast:*` used by S0F1h
 * Library Sync, so the legacy sync path is undisturbed).
 */
(function (global) {
  'use strict';

  var platform = global.H2O && global.H2O.Studio && global.H2O.Studio.platform;
  if (!platform || !platform.__registerAdapter) {
    /* index.js didn't load — nothing to register against. */
    return;
  }

  var chromeApi = null;
  try { chromeApi = global.chrome; } catch (e) { chromeApi = null; }

  var hasRuntime = !!(chromeApi && chromeApi.runtime && chromeApi.runtime.id);
  var hasStorage = !!(chromeApi && chromeApi.storage && chromeApi.storage.local);

  if (!hasRuntime && !hasStorage) {
    /* Not running inside an MV3 extension page. Leave fallback in place. */
    platform.__warn('platform.mv3: chrome.runtime / chrome.storage unavailable; adapter not registered');
    return;
  }

  var ADAPTER_NAME = 'mv3';
  var ADAPTER_VERSION = '0.1.0';
  var BROADCAST_PREFIX = 'h2o:studio:platform:broadcast:';
  var MESSAGE_TIMEOUT_MS = 12000;

  /* ───────────────────────── messaging ───────────────────────── */

  function messagingSend(target, message) {
    return new Promise(function (resolve, reject) {
      if (!hasRuntime) return reject(new Error('chrome.runtime unavailable'));
      var settled = false;
      var timer = 0;
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(value);
      }
      try {
        timer = setTimeout(function () {
          finish(reject, new Error('chrome.runtime.sendMessage timed out for ' + String(target || 'message')));
        }, MESSAGE_TIMEOUT_MS);
        /* `target` is informational today (used by Tauri to pick a command).
         * In MV3 the bg.js service worker routes by message envelope. */
        chromeApi.runtime.sendMessage(message, function (response) {
          var err = chromeApi.runtime && chromeApi.runtime.lastError;
          if (err) return finish(reject, new Error(err.message || String(err)));
          finish(resolve, response);
        });
      } catch (e) {
        finish(reject, e);
      }
    });
  }

  function messagingOn(target, fn) {
    if (!hasRuntime || typeof fn !== 'function') return function () {};
    var listener = function (msg, sender, sendResponse) {
      try {
        var result = fn(msg, sender);
        if (result && typeof result.then === 'function') {
          result.then(function (r) { sendResponse(r); }, function () { sendResponse(undefined); });
          return true; /* async response */
        }
        if (result !== undefined) sendResponse(result);
      } catch (e) {
        /* Swallow listener errors; do not break the message pipeline. */
        platform.__warn('messaging.on handler threw: ' + (e && e.message ? e.message : String(e)));
      }
      return undefined;
    };
    chromeApi.runtime.onMessage.addListener(listener);
    return function () {
      try { chromeApi.runtime.onMessage.removeListener(listener); } catch (e) { /* ignore */ }
    };
  }

  /* ───────────────────────── broadcast ───────────────────────── */

  function broadcastKey(channel) { return BROADCAST_PREFIX + String(channel) + ':v1'; }

  function broadcastEmit(channel, payload) {
    return new Promise(function (resolve, reject) {
      if (!hasStorage) {
        try {
          global.dispatchEvent(new global.CustomEvent('h2o:studio:platform:broadcast:' + channel, { detail: payload }));
          return resolve();
        } catch (e) { return reject(e); }
      }
      var record = { ts: Date.now(), payload: payload };
      try {
        var obj = {};
        obj[broadcastKey(channel)] = record;
        chromeApi.storage.local.set(obj, function () {
          var err = chromeApi.runtime && chromeApi.runtime.lastError;
          if (err) return reject(new Error(err.message || String(err)));
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function broadcastOn(channel, fn) {
    if (typeof fn !== 'function') return function () {};
    var key = broadcastKey(channel);
    if (hasStorage && chromeApi.storage.onChanged && chromeApi.storage.onChanged.addListener) {
      var listener = function (changes, area) {
        if (area !== 'local') return;
        if (!Object.prototype.hasOwnProperty.call(changes, key)) return;
        var next = changes[key] && changes[key].newValue;
        if (next && typeof next === 'object') {
          try { fn(next.payload, { ts: next.ts }); } catch (e) {
            platform.__warn('broadcast.on handler threw: ' + (e && e.message ? e.message : String(e)));
          }
        }
      };
      chromeApi.storage.onChanged.addListener(listener);
      return function () {
        try { chromeApi.storage.onChanged.removeListener(listener); } catch (e) { /* ignore */ }
      };
    }
    /* Fallback to window CustomEvent. */
    var winEvent = 'h2o:studio:platform:broadcast:' + channel;
    var winHandler = function (e) {
      try { fn(e && e.detail, { ts: Date.now() }); } catch (err) { /* swallow */ }
    };
    global.addEventListener(winEvent, winHandler);
    return function () { global.removeEventListener(winEvent, winHandler); };
  }

  /* ── Legacy / interop transports ──
   * emitRaw and onAnyChange let feature code preserve wire-format
   * compatibility with non-Studio surfaces (e.g., the native chatgpt.com
   * content scripts that already write to specific chrome.storage keys).
   * Useful for migrations like S0F1h Library Sync, which broadcasts on
   * `h2o:library:cross-surface:broadcast:v1` and listens for the native
   * counterpart on `:native:v1`. The platform adapter remains the only
   * place that touches chrome.* — feature code never imports chrome.
   */

  function broadcastEmitRaw(key, payload) {
    return new Promise(function (resolve, reject) {
      if (!hasStorage) return reject(new Error('chrome.storage unavailable'));
      try {
        var obj = {};
        obj[String(key)] = payload;
        chromeApi.storage.local.set(obj, function () {
          var err = chromeApi.runtime && chromeApi.runtime.lastError;
          if (err) return reject(new Error(err.message || String(err)));
          resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function broadcastOnAnyChange(fn) {
    if (typeof fn !== 'function') return function () {};
    if (!hasStorage || !chromeApi.storage.onChanged || !chromeApi.storage.onChanged.addListener) {
      return function () {};
    }
    var listener = function (changes, area) {
      try { fn(changes, area); } catch (e) {
        platform.__warn('broadcast.onAnyChange handler threw: ' + (e && e.message ? e.message : String(e)));
      }
    };
    chromeApi.storage.onChanged.addListener(listener);
    return function () {
      try { chromeApi.storage.onChanged.removeListener(listener); } catch (e) { /* ignore */ }
    };
  }

  /* ───────────────────────── storage ─────────────────────────
   * Low-level, localStorage-backed. This is intentionally simple: it is the
   * building block under a future H2O.Studio.store façade, not a replacement
   * for S0F1e Library Store (which remains the authority for general KV).
   * Async API so the Tauri adapter (which will be truly async) can swap in.
   */

  var ls = null;
  try { ls = global.localStorage; } catch (e) { ls = null; }

  function storageGet(key) {
    return new Promise(function (resolve) {
      if (!ls) return resolve(null);
      try {
        var raw = ls.getItem(String(key));
        if (raw == null) return resolve(null);
        /* Best-effort JSON decode; fall back to raw string. */
        try { resolve(JSON.parse(raw)); } catch (e) { resolve(raw); }
      } catch (e) {
        resolve(null);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise(function (resolve, reject) {
      if (!ls) return reject(new Error('localStorage unavailable'));
      try {
        var serialized = typeof value === 'string' ? value : JSON.stringify(value);
        ls.setItem(String(key), serialized);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  function storageRemove(key) {
    return new Promise(function (resolve, reject) {
      if (!ls) return reject(new Error('localStorage unavailable'));
      try {
        ls.removeItem(String(key));
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ───────────────────────── runtime URL / navigation (STAB-03 D1) ── */

  function runtimeResolveAsset(path) {
    var raw = String(path == null ? '' : path).trim();
    if (!raw) return '';
    if (!hasRuntime || !chromeApi.runtime || typeof chromeApi.runtime.getURL !== 'function') {
      return raw;
    }
    try {
      return chromeApi.runtime.getURL(raw.replace(/^\/+/, ''));
    } catch (_) {
      return raw;
    }
  }

  function runtimeOpenUrl(url, opts) {
    var safeUrl = String(url == null ? '' : url).trim();
    if (!safeUrl) {
      return Promise.reject(new Error('platform.runtime.openUrl: empty url'));
    }
    var options = (opts && typeof opts === 'object') ? opts : {};
    var tabs = chromeApi && chromeApi.tabs;
    if (tabs && typeof tabs.create === 'function') {
      return new Promise(function (resolve, reject) {
        try {
          tabs.create({ url: safeUrl, active: options.active !== false }, function (tab) {
            var err = chromeApi.runtime && chromeApi.runtime.lastError;
            if (err) return reject(new Error(err.message || String(err)));
            resolve(tab || { ok: true, url: safeUrl });
          });
        } catch (e) {
          reject(e);
        }
      });
    }
    try {
      if (typeof global.open === 'function') {
        var opened = global.open(safeUrl, options.target || '_blank', 'noopener,noreferrer');
        if (opened) return Promise.resolve(opened);
      }
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.reject(new Error('platform.runtime.openUrl: MV3/browser open primitive unavailable'));
  }

  /* ───────────────────────── runtime identity (C5-C) ─────────────────
   * Loaded-runtime facts only: the extension id and the loaded manifest's
   * name / version / version_name, read here so feature code never touches
   * chrome.runtime. version_name is passed through as an opaque loaded
   * fact. Nothing is derived from these strings — build channel, variant,
   * Lane, BTP role, source commit and checkpoint are Build & Delivery facts
   * an MV3 page cannot know, so they are simply absent from the record. */
  var LOADED_RUNTIME_IDENTITY_SCHEMA = 'h2o.studio.platform.loaded-runtime-identity.v1';

  function loadedFact(value) {
    return (typeof value === 'string' && value !== '') ? value : null;
  }

  function runtimeGetLoadedRuntimeIdentity() {
    return new Promise(function (resolve) {
      var runtimeId = null;
      var manifest = null;
      if (hasRuntime) {
        try { runtimeId = loadedFact(chromeApi.runtime.id); } catch (_) { runtimeId = null; }
        try {
          manifest = (typeof chromeApi.runtime.getManifest === 'function') ? chromeApi.runtime.getManifest() : null;
        } catch (_) { manifest = null; }
      }
      if (!manifest || typeof manifest !== 'object') manifest = {};
      resolve(Object.freeze({
        schema: LOADED_RUNTIME_IDENTITY_SCHEMA,
        adapter: ADAPTER_NAME,
        available: runtimeId !== null,
        reason: runtimeId !== null ? null : 'chrome-runtime-unavailable',
        runtimeId: runtimeId,
        displayName: loadedFact(manifest.name),
        version: loadedFact(manifest.version),
        versionName: loadedFact(manifest.version_name),
        desktopBuildIdentity: null,
        desktopBuildIdentityError: null,
      }));
    });
  }

  /* ───────────────────────── files (Phase 3a) ─────────────────────────
   * exportBlob downloads a Blob via the standard browser Blob +
   * URL.createObjectURL + <a download> dance. Mirrors the long-standing
   * migrateDownloadJson pattern in studio.js, generalised behind the
   * platform.files contract so Studio Ribbon's Phase 3a Markdown export
   * (and any later text/json/csv export) can route through one seam.
   *
   * Resolves with { ok: true, suggestedName } on success. Rejects with a
   * descriptive Error on missing inputs / DOM-unavailable / Blob-URL
   * failure. The bridge layer translates rejection into a benign
   * { ok: false, reason } result so the ribbon never sees a throw.
   *
   * No new permissions are needed — `<a download>` works in the Studio
   * surface today (Studio's existing migrateDownloadJson is proof). */
  function filesExportBlob(opts) {
    return new Promise(function (resolve, reject) {
      try {
        if (!opts || typeof opts !== 'object') {
          return reject(new Error('platform.files.exportBlob: missing opts'));
        }
        var blob = opts.blob;
        var suggestedName = String(opts.suggestedName || '').trim() || 'download.bin';
        if (!blob || typeof blob !== 'object' || typeof blob.size !== 'number') {
          return reject(new Error('platform.files.exportBlob: opts.blob must be a Blob'));
        }
        if (typeof global.URL === 'undefined' || typeof global.URL.createObjectURL !== 'function') {
          return reject(new Error('platform.files.exportBlob: URL.createObjectURL unavailable'));
        }
        if (typeof global.document === 'undefined' || typeof global.document.createElement !== 'function') {
          return reject(new Error('platform.files.exportBlob: document unavailable'));
        }
        var url = global.URL.createObjectURL(blob);
        var a = global.document.createElement('a');
        a.href = url;
        a.download = suggestedName;
        try {
          global.document.body.appendChild(a);
          a.click();
        } catch (e) {
          try { global.URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
          return reject(e);
        }
        /* Cleanup on the next tick so the click has a chance to fire the
         * browser's download flow before we revoke the URL. 200ms matches
         * the migrateDownloadJson precedent. */
        setTimeout(function () {
          try { global.document.body.removeChild(a); } catch (_) { /* ignore */ }
          try { global.URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
        }, 200);
        resolve({ ok: true, suggestedName: suggestedName });
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ───────────────────────── files.importFile (C5-C) ─────────────────
   * One UTF-8 text file, picked through a transient hidden <input type="file">
   * and read here with the browser File API. The caller receives the
   * already-read text plus host-neutral facts; the browser File never leaves
   * this adapter. Cancellation — the picker's `cancel` event, or a change
   * event that carries no file — resolves null and is not an error. JSON
   * parsing, bundle/schema recognition and every migration decision stay
   * with the caller (Saved Chats / C5-B); this seam only delivers text. */
  var LOCAL_FILE_SCHEMA = 'h2o.studio.platform.local-file.v1';

  function utf8ByteLength(text) {
    try {
      if (typeof global.TextEncoder === 'function') return new global.TextEncoder().encode(text).length;
    } catch (_) { /* fall through */ }
    try { return unescape(encodeURIComponent(text)).length; } catch (_) { return text.length; }
  }

  function normalizeLocalFileRecord(name, size, type, text) {
    var s = String(text == null ? '' : text);
    var bytes = (typeof size === 'number' && isFinite(size) && size >= 0) ? Math.floor(size) : utf8ByteLength(s);
    return Object.freeze({
      schema: LOCAL_FILE_SCHEMA,
      name: String(name == null ? '' : name),
      size: bytes,
      type: String(type == null ? '' : type),
      text: s,
    });
  }

  function importAcceptList(opts) {
    var out = [];
    function push(list, prefix) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i += 1) {
        var raw = String(list[i] == null ? '' : list[i]).trim();
        if (!raw) continue;
        out.push(prefix ? prefix + raw.replace(/^\.+/, '') : raw);
      }
    }
    push(opts.mimeTypes, '');
    push(opts.extensions, '.');
    return out.join(',');
  }

  function readFileText(file) {
    if (typeof file.text === 'function') {
      return Promise.resolve(file.text());
    }
    return new Promise(function (resolve, reject) {
      if (typeof global.FileReader !== 'function') {
        return reject(new Error('platform.files.importFile: FileReader unavailable'));
      }
      var reader = new global.FileReader();
      reader.onload = function () { resolve(String(reader.result == null ? '' : reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error('platform.files.importFile: read failed')); };
      reader.readAsText(file, 'utf-8');
    });
  }

  function filesImportFile(opts) {
    var options = (opts && typeof opts === 'object') ? opts : {};
    return new Promise(function (resolve, reject) {
      var doc = global.document;
      if (!doc || typeof doc.createElement !== 'function' || !doc.body) {
        return reject(new Error('platform.files.importFile: document unavailable'));
      }
      var input = doc.createElement('input');
      input.type = 'file';
      input.multiple = false;
      var accept = importAcceptList(options);
      if (accept) input.accept = accept;
      input.setAttribute('data-h2o-platform-import-file', '1');
      input.style.display = 'none';
      var settled = false;
      function finish(fn, value) {
        if (settled) return;
        settled = true;
        try { if (input.parentNode) input.parentNode.removeChild(input); } catch (_) { /* ignore */ }
        fn(value);
      }
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return finish(resolve, null);
        readFileText(file).then(function (text) {
          finish(resolve, normalizeLocalFileRecord(file.name, file.size, file.type, text));
        }, function (e) {
          finish(reject, e);
        });
      });
      input.addEventListener('cancel', function () { finish(resolve, null); });
      try {
        doc.body.appendChild(input);
        input.click();
      } catch (e) {
        finish(reject, e);
      }
    });
  }

  var files = {
    available: true,
    exportBlob: filesExportBlob,
    importFile: filesImportFile,
    /* exportJson / importJson remain placeholders. Add when a feature
     * genuinely needs them — importJson in particular would carry Saved
     * Chats parsing semantics that do not belong in this adapter. */
  };

  /* ───────────────────────── placeholders ───────────────────────── */

  var capture = {
    available: false,
    reason: 'platform.capture interface stub; will route to S0D3a / S0D3e in a later patch',
  };

  var auth = {
    available: false,
    reason: 'platform.auth interface stub; identity surface remains the owner of auth flows',
  };

  /* ───────────────────────── clipboard ───────────────────────── */
  /* Phase 1b — one-shot text writes for Studio Ribbon actions. MV3
   * extension pages have access to navigator.clipboard.writeText when the
   * `clipboardWrite` permission is granted. Returns a rejected Promise
   * with a clear message if navigator.clipboard is unavailable (e.g. an
   * older browser, or the page was not loaded in a secure context). */
  function clipboardWriteText(text) {
    var s = String(text == null ? '' : text);
    try {
      var nav = global.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        return nav.clipboard.writeText(s);
      }
    } catch (e) {
      return Promise.reject(e);
    }
    return Promise.reject(new Error('platform.clipboard.writeText: navigator.clipboard.writeText unavailable in this context'));
  }

  /* ───────────────────────── register ───────────────────────── */

  var adapter = {
    name: ADAPTER_NAME,
    version: ADAPTER_VERSION,
    env: {
      adapter: ADAPTER_NAME,
      version: ADAPTER_VERSION,
      bootedAt: Date.now(),
      isExtension: true,
      isTauri: false,
      isDev: !!(global.location && /[?&]h2oDev=1\b/.test(global.location.search || '')),
    },
    messaging: { send: messagingSend, on: messagingOn },
    broadcast: {
      emit: broadcastEmit,
      on: broadcastOn,
      emitRaw: broadcastEmitRaw,
      onAnyChange: broadcastOnAnyChange,
    },
    storage: { get: storageGet, set: storageSet, remove: storageRemove },
    runtime: {
      resolveAsset: runtimeResolveAsset,
      openUrl: runtimeOpenUrl,
      getLoadedRuntimeIdentity: runtimeGetLoadedRuntimeIdentity,
    },
    files: files,
    capture: capture,
    auth: auth,
    clipboard: { writeText: clipboardWriteText },
  };

  platform.__registerAdapter(adapter);
})(typeof window !== 'undefined' ? window : globalThis);
