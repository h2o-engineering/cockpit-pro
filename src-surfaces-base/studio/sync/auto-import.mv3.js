/* H2O Studio Sync — Chrome sync-folder export connector (R3 Phase 1 + 2)
 *
 * MV3 / Chrome-only manual export of an h2o.studio.fullBundle.v2 payload
 * into the user-selected sync folder as `chrome-latest.json` (staged via
 * `chrome-latest.json.tmp` then renamed). Naming mirrors the existing
 * Desktop-side auto-export shape (`H2O.Studio.sync.autoImport.*` is the
 * Chrome-side analogue of `autoExport.*`).
 *
 * R3 phase 2 — opt-in event-triggered export. When BOTH
 * `sync.chromeAutoImport` AND `sync.chromeAutoImport.eventTrigger` are
 * ON (via `H2O.flags.set(...)` or `autoImport.enable()`), a small
 * whitelist of safe library-save events triggers a debounced
 * `exportNow()` automatically. The user-gesture requirement still
 * applies — but since the listener fires inside an event handler in the
 * extension page (Studio Launcher), Chrome treats that as user gesture
 * activation for File System Access readwrite re-prompts. There is no
 * polling, no background-only daemon, no auto-write outside the gesture
 * stack.
 *
 * Sanctioned by the R3 amendment to docs/systems/library/desktop-chrome-
 * sync-r2d-gate.md:
 *   - Chrome must not write `latest.json`. Chrome writes only
 *     `chrome-latest.json` and `chrome-latest.json.tmp`.
 *   - All file-system writes happen from a Window-context extension page
 *     under a user gesture. The MV3 service worker is the bundle
 *     PRODUCER (via chrome.runtime.sendMessage → existing background
 *     `exportFullBundle` op) but never the file WRITER.
 *   - readwrite permission is requested per export call.
 *   - Behind a feature flag (`sync.chromeAutoImport`) that defaults OFF
 *     in prod. Flag-off path is a no-op with a clear status; users fall
 *     back to the existing manual `#/migrate/export` download workflow.
 *
 * Reuses the directory handle already persisted by folder-import.mv3.js
 * (IndexedDB `h2o.studio.sync.folder.mv3` → store `handles` → key
 * `sync-folder`) — Chrome cannot acquire a second handle without
 * disrupting the existing R2D import flow.
 *
 * Safety invariants:
 *   - no Desktop/Tauri behavior (Tauri detection bails early)
 *   - no background polling, no automatic write on boot or on event
 *   - no bidirectional sync — write is strictly Chrome → chrome-latest.json
 *   - no schema or wire-format change — bundle shape is the existing
 *     h2o.studio.fullBundle.v2 produced verbatim by the SW
 *   - no Native UI change (only a Studio Settings button is added by
 *     studio.js; this module is the API behind it)
 *   - flag-off is a hard guard at the top of exportNow(); no write code
 *     executes when the flag is false
 *
 * Public API:
 *   H2O.Studio.sync.autoImport.exportNow(options?)
 *   H2O.Studio.sync.autoImport.isEnabled()
 *   H2O.Studio.sync.autoImport.enable()
 *   H2O.Studio.sync.autoImport.disable()
 *   H2O.Studio.sync.autoImport.status()
 *   H2O.Studio.sync.autoImport.diagnose()
 */
(function (global) {
  'use strict';

  /* ── Tauri detection — bail; this is Chrome/MV3 only ─────────────── */
  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* swallow */ }
    return false;
  }
  if (detectTauri()) return;

  /* ── Chrome runtime detection — bail otherwise ───────────────────── */
  function detectChromeRuntime() {
    try {
      return !!(global.chrome && global.chrome.runtime && global.chrome.runtime.id);
    } catch (_) { return false; }
  }
  if (!detectChromeRuntime()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  if (H2O.Studio.sync.autoImport && H2O.Studio.sync.autoImport.__installed) return;

  /* ── Constants — mirror folder-import.mv3.js storage location ─────── */
  var PHASE                = 'R3-phase1';
  var FULL_BUNDLE_SCHEMA   = 'h2o.studio.fullBundle.v2';
  var FOLDER_DELETE_REQUEST_SCHEMA = 'h2o.studio.folder-delete-request.v1';
  var FOLDER_RESTORE_REQUEST_SCHEMA = 'h2o.studio.folder-restore-request.v1';
  var CHAT_FOLDER_BINDING_REQUEST_SCHEMA = 'h2o.studio.chat-folder-binding-request.v1';
  var LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA = 'h2o.studio.library-metadata-mutation-request.v1';
  var FOLDER_DELETE_REQUEST_EXPORT_KEY = 'h2o:studio:folder-delete-requests:pending-export:v1';
  var FOLDER_DELETE_REQUEST_EXPORT_MIRROR_SCHEMA = 'h2o.studio.folder-delete-request.pending-export-mirror.v1';
  var FOLDER_RESTORE_REQUEST_EXPORT_KEY = 'h2o:studio:folder-restore-requests:pending-export:v1';
  var FOLDER_RESTORE_REQUEST_EXPORT_MIRROR_SCHEMA = 'h2o.studio.folder-restore-request.pending-export-mirror.v1';
  var CHAT_FOLDER_BINDING_REQUEST_EXPORT_KEY = 'h2o:studio:chat-folder-binding-requests:pending-export:v1';
  var CHAT_FOLDER_BINDING_REQUEST_EXPORT_MIRROR_SCHEMA = 'h2o.studio.chat-folder-binding-request.pending-export-mirror.v1';
  var LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_KEY = 'h2o:studio:library-metadata-mutation-requests:pending-export:v1';
  var LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA = 'h2o.studio.library-metadata-mutation-request.pending-export-mirror.v1';
  var FOLDER_STATE_KEY_LOCAL = 'h2o:prm:cgx:fldrs:state:data:v1';
  var EXPORT_COVERAGE_SCHEMA = 'h2o.studio.sync.chrome-export-coverage.v1';
  var EXPORT_COVERAGE_MISMATCH = 'chrome-export-source-coverage-mismatch';
  var EXPORT_COVERAGE_UNAVAILABLE = 'chrome-export-source-coverage-unavailable';
  var EXPORT_COVERAGE_MINIMAL_ROWS = 'chrome-export-source-coverage-minimal-rows-added';
  var EXPORT_SNAPSHOT_PAYLOAD_MISSING = 'chrome-export-snapshot-payload-missing';
  var EXPORT_SNAPSHOT_PAYLOAD_DOWNGRADED = 'chrome-export-snapshot-payload-downgraded';
  var CHROME_FILE          = 'chrome-latest.json';
  var CHROME_FILE_TMP      = 'chrome-latest.json.tmp';
  var MSG_ARCHIVE          = 'h2o-ext-archive:v1';
  var IDB_NAME             = 'h2o.studio.sync.folder.mv3';
  var IDB_STORE            = 'handles';
  var IDB_KEY              = 'sync-folder';
  var FLAG_KEY             = 'sync.chromeAutoImport';
  var EVENT_TRIGGER_FLAG_KEY = 'sync.chromeAutoImport.eventTrigger';
  var SMOKE_BRIDGE_OPT_IN_KEY = 'h2o:studio:smoke-bridge:enabled:v1';
  var SMOKE_CHROME_EXPORT_OPT_IN_KEY = 'h2o:studio:smoke-bridge:chrome-export-enabled:v1';
  var SMOKE_REQUIRED_VALUE = 'folder-sync-rc';
  var SETTINGS_KEY         = 'h2o:sync:chrome-auto-import:state:v1';
  var MAX_ERRORS           = 20;
  var CHROME_EXPORT_IN_FLIGHT_STALE_MS = 60000;
  /* R3 phase 2 — event-trigger wiring. The whitelist names below are
   * "post-write" library-state-changed signals; each fires AFTER a
   * library save has completed, not during. EVENT_TRIGGER_DEBOUNCE_MS
   * coalesces bursts (e.g. import-from-bridge writes 7 stores in quick
   * succession; one exportNow runs at the tail). */
  var EVENT_TRIGGER_NAMES = [
    'evt:h2o:library:cross-surface-sync',  /* Native broadcasted to Chrome Studio */
    'evt:h2o:library-index:updated',        /* Library Index refreshed after any source change */
    'evt:h2o:sync:chrome-auto-import:trigger', /* Explicit manual trigger for tests / future modules */
  ];
  var EVENT_TRIGGER_DEBOUNCE_MS = 2000;
  var DESKTOP_ORIGIN_IMPORT_EVENT_SOURCES = ['sync-folder-import'];

  /* ── State (in-memory only; persisted bits live in SETTINGS_KEY) ─── */
  var state = {
    installedAt: Date.now(),
    enabled: false,             /* mirrors the EVENT_TRIGGER_FLAG_KEY value; kept in sync via enable()/disable() */
    inFlight: false,
    inFlightStartedAt: 0,
    inFlightReason: '',
    inFlightOwner: '',
    lastStaleInFlightClearedAt: '',
    lastStaleInFlightClearedReason: '',
    lastExportAt: '',
    lastExportStatus: '',
    lastExportFile: '',
    lastExportBytes: 0,
    lastExportError: '',
    /* R3 phase 2 — event-trigger runtime state */
    listenersBound: false,
    listenerHandlers: Object.create(null),  /* eventName → handler ref, for removeEventListener */
    eventTriggerTimer: null,
    lastEventAt: 0,
    lastEventName: '',
    eventTriggerCount: 0,
    eventTriggerSuppressedCount: 0,
    lastEventTriggerSuppressedAt: 0,
    lastEventTriggerSuppressedName: '',
    lastEventTriggerSuppressedSource: '',
    lastEventTriggerSuppressedReason: '',
    lastSnapshotPayloadCoverage: null,
    lastNativeSnapshotPayloadPreflight: null,
    lastFolderDeleteRequestExport: null,
    lastFolderRestoreRequestExport: null,
    lastChatFolderBindingRequestExport: null,
    lastLibraryMetadataMutationRequestExport: null,
    errors: [],
  };

  /* ── Small helpers ────────────────────────────────────────────────── */
  function nowIso() {
    try { return new Date().toISOString(); }
    catch (_) { return String(Date.now()); }
  }
  function chromeExportPath(folderName) {
    var name = String(folderName || '').trim();
    return (name ? name + '/' : '') + CHROME_FILE;
  }
  function pushError(op, err) {
    try {
      state.errors.push({
        at: Date.now(),
        op: String(op || ''),
        error: String(err && (err.message || err)),
      });
      if (state.errors.length > MAX_ERRORS) {
        state.errors.splice(0, state.errors.length - MAX_ERRORS);
      }
    } catch (_) { /* ignore */ }
  }

  function getChromeStorageLocal() {
    try { return global.chrome && global.chrome.storage && global.chrome.storage.local; }
    catch (_) { return null; }
  }
  function readKv(key) {
    return new Promise(function (resolve) {
      var s = getChromeStorageLocal();
      if (!s || typeof s.get !== 'function') { resolve(null); return; }
      try {
        s.get([key], function (items) {
          resolve(items && Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null);
        });
      } catch (_) { resolve(null); }
    });
  }
  function writeKv(key, value) {
    return new Promise(function (resolve, reject) {
      var s = getChromeStorageLocal();
      if (!s || typeof s.set !== 'function') {
        reject(new Error('chrome.storage.local unavailable'));
        return;
      }
      try {
        var item = {}; item[key] = value;
        s.set(item, function () {
          var lastErr = global.chrome && global.chrome.runtime && global.chrome.runtime.lastError;
          if (lastErr) reject(new Error(String(lastErr.message || lastErr)));
          else resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  /* ── Feature flag (defaults OFF) ──────────────────────────────────── */
  /* The flag is read live on every exportNow() call so flipping it via
   * H2O.flags.set(...) takes effect immediately without a reload. */
  function readLocalStorageString(key) {
    try {
      return cleanString(global.localStorage && global.localStorage.getItem(key));
    } catch (_) {
      return '';
    }
  }

  function chromeExtensionSurface() {
    try {
      if (global.location && cleanString(global.location.protocol) === 'chrome-extension:') return true;
    } catch (_) { /* ignore */ }
    try {
      return !!(global.chrome && global.chrome.runtime && global.chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function publicReleaseFlagActive() {
    try {
      if (global.H2O_PUBLIC_RELEASE === true) return true;
      if (H2O.Studio && H2O.Studio.release && H2O.Studio.release.publicRelease === true) return true;
      if (H2O.Studio && H2O.Studio.config && H2O.Studio.config.publicRelease === true) return true;
    } catch (_) { /* ignore */ }
    try {
      if (readLocalStorageString('h2o:studio:public-release:v1') === 'true') return true;
    } catch (_) { /* ignore */ }
    try {
      var root = global.document && global.document.documentElement;
      if (root && root.getAttribute('data-h2o-public-release') === '1') return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  function masterFlagEnabled() {
    try {
      var flags = H2O.flags;
      if (flags && typeof flags.get === 'function') {
        return flags.get(FLAG_KEY, false) === true;
      }
    } catch (_) { /* fall through */ }
    return false;
  }
  function setMasterFlag(next) {
    try {
      var flags = H2O.flags;
      if (flags && typeof flags.set === 'function') {
        flags.set(FLAG_KEY, !!next);
        return true;
      }
    } catch (e) { pushError('setMasterFlag', e); }
    return false;
  }

  function smokeChromeExportEnabled() {
    return chromeExtensionSurface() &&
      !publicReleaseFlagActive() &&
      readLocalStorageString(SMOKE_BRIDGE_OPT_IN_KEY) === SMOKE_REQUIRED_VALUE &&
      readLocalStorageString(SMOKE_CHROME_EXPORT_OPT_IN_KEY) === SMOKE_REQUIRED_VALUE;
  }

  function flagEnabled() {
    return masterFlagEnabled() || smokeChromeExportEnabled();
  }

  function diagnoseChromeExportWriteGate() {
    var smokeBridgeOptIn = readLocalStorageString(SMOKE_BRIDGE_OPT_IN_KEY);
    var smokeExportOptIn = readLocalStorageString(SMOKE_CHROME_EXPORT_OPT_IN_KEY);
    var masterEnabled = masterFlagEnabled();
    var smokeSurface = chromeExtensionSurface();
    var publicReleaseBlocked = !publicReleaseFlagActive();
    var smokeEnabled = smokeChromeExportEnabled();
    var blockers = [];
    if (!masterEnabled && !smokeEnabled) blockers.push('chrome-export-flag-off');
    if (smokeExportOptIn === SMOKE_REQUIRED_VALUE && !smokeSurface) blockers.push('smoke-chrome-extension-surface-required');
    if (smokeExportOptIn === SMOKE_REQUIRED_VALUE && !publicReleaseBlocked) blockers.push('public-release-flag-active');
    if (smokeExportOptIn === SMOKE_REQUIRED_VALUE && smokeBridgeOptIn !== SMOKE_REQUIRED_VALUE) blockers.push('smoke-bridge-opt-in-required');
    return {
      schema: 'h2o.studio.sync.chrome-export-write-gate.v1',
      phase: PHASE,
      flagKey: FLAG_KEY,
      flagEnabled: masterEnabled,
      effectiveFlagEnabled: masterEnabled || smokeEnabled,
      eventTriggerFlagKey: EVENT_TRIGGER_FLAG_KEY,
      eventTriggerEnabled: eventTriggerFlagEnabled(),
      smokeBridgeOptInKey: SMOKE_BRIDGE_OPT_IN_KEY,
      smokeChromeExportOptInKey: SMOKE_CHROME_EXPORT_OPT_IN_KEY,
      smokeRequiredValue: SMOKE_REQUIRED_VALUE,
      smokeBridgeOptIn: smokeBridgeOptIn === SMOKE_REQUIRED_VALUE,
      smokeChromeExportOptIn: smokeExportOptIn === SMOKE_REQUIRED_VALUE,
      smokeChromeExportEnabled: smokeEnabled,
      chromeExtensionSurface: smokeSurface,
      publicReleaseBlocked: publicReleaseBlocked,
      blockers: blockers,
      enableForSmokeSnippet: "localStorage.setItem('" + SMOKE_BRIDGE_OPT_IN_KEY + "', '" + SMOKE_REQUIRED_VALUE + "'); localStorage.setItem('" + SMOKE_CHROME_EXPORT_OPT_IN_KEY + "', '" + SMOKE_REQUIRED_VALUE + "');",
      normalFlagSnippet: "H2O.flags.set('" + FLAG_KEY + "', true)",
      privacy: { redacted: true },
    };
  }

  function isFolderAutoSyncExport(options) {
    var opts = options && typeof options === 'object' ? options : {};
    return opts.folderAutoSync === true || opts.folderMutationAutoSync === true;
  }

  /* ── IndexedDB plumbing — read the existing folder handle ────────── */
  function openHandleDb() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) {
        reject(new Error('indexedDB unavailable'));
        return;
      }
      var req = global.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        try {
          var db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        } catch (e) { reject(e); }
      };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
      req.onsuccess = function () { resolve(req.result); };
    });
  }
  async function loadStoredHandleRow() {
    var db;
    try { db = await openHandleDb(); }
    catch (e) { pushError('idb.open', e); return null; }
    try {
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onerror = function () { reject(req.error || new Error('indexedDB get failed')); };
        req.onsuccess = function () { resolve(req.result || null); };
      });
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  /* ── Permission prompt — must run from a user gesture ─────────────── */
  async function ensureReadWritePermission(handle) {
    if (!handle) throw new Error('no sync-folder directory handle available');
    if (typeof handle.queryPermission !== 'function'
        || typeof handle.requestPermission !== 'function') {
      throw new Error('File System Access API unavailable on this handle');
    }
    var current;
    try { current = await queryReadWritePermission(handle); }
    catch (e) { pushError('queryPermission', e); current = 'prompt'; }
    if (current === 'granted') return 'granted';
    var asked;
    try { asked = await handle.requestPermission({ mode: 'readwrite' }); }
    catch (e) {
      pushError('requestPermission', e);
      throw new Error('readwrite permission request failed: ' + ((e && e.message) || e));
    }
    if (asked !== 'granted') {
      throw new Error('readwrite permission not granted (got "' + asked + '")');
    }
    return asked;
  }

  async function queryReadWritePermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return 'unknown';
    try { return await handle.queryPermission({ mode: 'readwrite' }); }
    catch (e) { pushError('queryReadWritePermission', e); return 'unknown'; }
  }

  function recordExportBlocked(payload) {
    var p = payload && typeof payload === 'object' ? payload : {};
    state.lastExportAt = String(p.startedAt || nowIso());
    state.lastExportStatus = String(p.status || 'chrome-to-desktop-export-blocked');
    state.lastExportFile = String(p.filename || '');
    state.lastExportBytes = Number(p.bytes || 0);
    state.lastExportError = String(p.error || '');
    return p;
  }

  function chromeExportInFlightAgeMs(now) {
    if (!state.inFlight || !state.inFlightStartedAt) return 0;
    return Math.max(0, Number(now || Date.now()) - Number(state.inFlightStartedAt || 0));
  }

  function chromeExportLockDiagnostics(extra) {
    var data = extra && typeof extra === 'object' ? extra : {};
    var memoryInFlight = Object.prototype.hasOwnProperty.call(data, 'memoryInFlight')
      ? data.memoryInFlight === true
      : state.inFlight === true;
    var ageMs = Object.prototype.hasOwnProperty.call(data, 'ageMs')
      ? Math.max(0, Number(data.ageMs) || 0)
      : chromeExportInFlightAgeMs();
    return {
      chromeExportInFlightPersisted: false,
      chromeExportInFlightMemory: memoryInFlight,
      chromeExportInFlightAgeMs: ageMs,
      chromeExportInFlightStaleMs: CHROME_EXPORT_IN_FLIGHT_STALE_MS,
      chromeExportStaleLockCleared: data.staleCleared === true,
      chromeExportLockOwner: cleanString(data.owner || state.inFlightOwner || 'auto-import.exportNow'),
      chromeExportLockReason: cleanString(data.reason || state.inFlightReason),
    };
  }

  function clearStaleChromeExportLock(reason) {
    if (!state.inFlight) return null;
    var ageMs = chromeExportInFlightAgeMs();
    if (!state.inFlightStartedAt || ageMs < CHROME_EXPORT_IN_FLIGHT_STALE_MS) {
      return { cleared: false, ageMs: ageMs };
    }
    var previous = {
      owner: state.inFlightOwner,
      reason: state.inFlightReason,
      ageMs: ageMs,
    };
    state.inFlight = false;
    state.inFlightStartedAt = 0;
    state.inFlightReason = '';
    state.inFlightOwner = '';
    state.lastStaleInFlightClearedAt = nowIso();
    state.lastStaleInFlightClearedReason = cleanString(reason || previous.reason || 'stale-export-lock');
    return Object.assign({ cleared: true }, previous);
  }

  function eventDetailSource(event) {
    try {
      if (!event || !event.detail || typeof event.detail !== 'object') return '';
      return cleanString(event.detail.source);
    } catch (_) {
      return '';
    }
  }

  function shouldSuppressEventTriggeredExport(eventName, event) {
    var name = cleanString(eventName);
    if (name !== 'evt:h2o:library:cross-surface-sync') return null;
    var source = eventDetailSource(event);
    if (DESKTOP_ORIGIN_IMPORT_EVENT_SOURCES.indexOf(source) === -1) return null;
    return {
      suppressed: true,
      eventName: name,
      source: source,
      reason: 'desktop-origin-import-event',
    };
  }

  function recordEventTriggerSuppressed(summary) {
    var data = summary && typeof summary === 'object' ? summary : {};
    state.eventTriggerSuppressedCount += 1;
    state.lastEventTriggerSuppressedAt = Date.now();
    state.lastEventTriggerSuppressedName = cleanString(data.eventName || state.lastEventName);
    state.lastEventTriggerSuppressedSource = cleanString(data.source);
    state.lastEventTriggerSuppressedReason = cleanString(data.reason || 'event-trigger-suppressed');
  }

  /* ── Service-worker round-trip to produce the bundle ──────────────── */
  /* Mirrors the existing folder-import.mv3.js callArchive helper: same
   * MSG_ARCHIVE envelope, same { op, payload, nsDisk } shape. The SW
   * already implements op === 'exportFullBundle' (per chrome-live-
   * background.mjs lines 6836-6837). */
  function callArchive(op, payload) {
    var message = { type: MSG_ARCHIVE, req: { op: op, payload: payload || {} } };
    return new Promise(function (resolve, reject) {
      try {
        var sendResult = global.chrome.runtime.sendMessage(message, function (response) {
          var lastErr = global.chrome && global.chrome.runtime && global.chrome.runtime.lastError;
          if (lastErr) { reject(new Error(String(lastErr.message || lastErr))); return; }
          if (!response || !response.ok) {
            reject(new Error((response && response.error) || ('Archive op failed: ' + op)));
            return;
          }
          resolve(response.result);
        });
        /* When sendMessage returns a Promise (some MV3 polyfills), use it. */
        if (sendResult && typeof sendResult.then === 'function') {
          sendResult.then(function (response) {
            if (!response || !response.ok) {
              reject(new Error((response && response.error) || ('Archive op failed: ' + op)));
              return;
            }
            resolve(response.result);
          }).catch(reject);
        }
      } catch (e) { reject(e); }
    });
  }

  /* ── Bundle shape validation — schema-only guard ──────────────────── */
  function validateBundleShape(bundle) {
    if (!bundle || typeof bundle !== 'object') {
      return { ok: false, error: 'bundle is not an object' };
    }
    var schema = String(bundle.schema || '').trim();
    if (schema !== FULL_BUNDLE_SCHEMA) {
      return { ok: false, error: 'unexpected bundle schema: "' + schema + '" (expected "' + FULL_BUNDLE_SCHEMA + '")' };
    }
    return { ok: true };
  }

  /* ── F19.5b export-source coverage ─────────────────────────────────
   * The Chrome Studio parity diagnostic reads H2O.LibraryIndex.getAll().
   * The legacy archive exporter reads transcript archive storage. F19.5
   * cannot treat those as equivalent unless chrome-latest.json covers the
   * same supported row set. We append minimal zero-snapshot records for
   * LibraryIndex-only rows so Desktop can materialize saved/linked row
   * parity without inventing transcript content. Public diagnostics are
   * count-only/redacted; raw ids/titles stay only inside the user-owned
   * transport bundle. */
  function cleanString(value) {
    return String(value == null ? '' : value).trim();
  }
  function isPlainObject(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
  }
  function nullableString(value) {
    var s = cleanString(value);
    return s || null;
  }

  function parseFolderDeleteRequestPayload(row) {
    var raw = row && row.rawTombstoneJson;
    if (!raw && row && row.raw_tombstone_json) raw = row.raw_tombstone_json;
    if (!raw && isPlainObject(row && row.payload)) raw = row.payload;
    if (!raw && isPlainObject(row)) raw = row;
    if (!raw) return null;
    try {
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return isPlainObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function sanitizeFolderDeleteRequestForExport(row) {
    var payload = parseFolderDeleteRequestPayload(row);
    if (!payload) return null;
    if (cleanString(payload.schema) !== FOLDER_DELETE_REQUEST_SCHEMA) return null;
    if (cleanString(payload.intent) !== 'folder-soft-delete-request') return null;
    if (cleanString(payload.status) !== 'pending') return null;
    if (payload.desktopApplyRequired !== true) return null;
    var folderId = cleanString(payload.folderId || payload.recordId);
    if (!folderId) return null;
    var requestId = cleanString(payload.requestId || payload.reviewId || (row && row.reviewId));
    if (!requestId) return null;
    return {
      schema: FOLDER_DELETE_REQUEST_SCHEMA,
      requestId: requestId,
      reviewId: cleanString(payload.reviewId || requestId) || requestId,
      recordKind: 'folder',
      intent: 'folder-soft-delete-request',
      classification: 'delete-request',
      folderId: folderId,
      folderName: nullableString(payload.folderName || payload.folderNameAtRequest),
      folderNameAtRequest: nullableString(payload.folderNameAtRequest || payload.folderName),
      normalizedNameAtRequest: nullableString(payload.normalizedNameAtRequest),
      requestedAt: cleanString(payload.requestedAt) || null,
      requestedBy: nullableString(payload.requestedBy || 'chrome-studio'),
      sourceSurface: nullableString(payload.sourceSurface || 'chrome-studio'),
      sourcePeerId: nullableString(payload.sourcePeerId || 'chrome-studio'),
      status: 'pending',
      reason: nullableString(payload.reason || 'user-requested-folder-delete'),
      noHardDelete: true,
      noChatDelete: true,
      desktopApplyRequired: true,
      noLocalApply: true,
      noFolderMutation: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      advisory: isPlainObject(payload.advisory) ? cloneJson(payload.advisory) : null,
      transportedAt: nowIso(),
    };
  }

  function parseFolderRestoreRequestPayload(row) {
    var raw = row && row.rawTombstoneJson;
    if (!raw && row && row.raw_tombstone_json) raw = row.raw_tombstone_json;
    if (!raw && isPlainObject(row && row.payload)) raw = row.payload;
    if (!raw && isPlainObject(row)) raw = row;
    if (!raw) return null;
    try {
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return isPlainObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function sanitizeFolderRestoreRequestForExport(row) {
    var payload = parseFolderRestoreRequestPayload(row);
    if (!payload) return null;
    if (cleanString(payload.schema) !== FOLDER_RESTORE_REQUEST_SCHEMA) return null;
    if (cleanString(payload.intent) !== 'folder-restore-request') return null;
    if (cleanString(payload.status) !== 'pending') return null;
    if (payload.desktopRestoreRequired !== true && payload.desktopApplyRequired !== true) return null;
    if (payload.noTombstoneApply !== true) return null;
    if (payload.noHardDelete !== true) return null;
    if (payload.noChatDelete !== true) return null;
    var folderId = cleanString(payload.folderId || payload.recordId);
    if (!folderId) return null;
    var requestId = cleanString(payload.requestId || payload.reviewId || (row && row.reviewId));
    if (!requestId) return null;
    return {
      schema: FOLDER_RESTORE_REQUEST_SCHEMA,
      requestId: requestId,
      reviewId: cleanString(payload.reviewId || requestId) || requestId,
      recordKind: 'folder',
      intent: 'folder-restore-request',
      classification: 'restore-request',
      folderId: folderId,
      folderName: nullableString(payload.folderName || payload.folderNameAtRequest),
      folderNameAtRequest: nullableString(payload.folderNameAtRequest || payload.folderName),
      tombstoneId: nullableString(payload.tombstoneId),
      receiptId: nullableString(payload.receiptId),
      requestedAt: cleanString(payload.requestedAt || payload.createdAt) || null,
      createdAt: cleanString(payload.createdAt || payload.requestedAt) || null,
      requestedBy: nullableString(payload.requestedBy || 'chrome-studio'),
      source: nullableString(payload.source || 'chrome-studio'),
      sourceSurface: nullableString(payload.sourceSurface || 'chrome-studio'),
      sourcePeerId: nullableString(payload.sourcePeerId || 'chrome-studio'),
      status: 'pending',
      reason: nullableString(payload.reason || 'user-requested-folder-restore'),
      desktopRestoreRequired: true,
      desktopApplyRequired: true,
      noLocalApply: true,
      noChromeRestoreAuthority: true,
      noTombstoneApply: true,
      noTombstoneCreate: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noFolderMutation: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      advisory: isPlainObject(payload.advisory) ? cloneJson(payload.advisory) : null,
      transportedAt: nowIso(),
    };
  }

  function folderDeleteRequestExportIdentity(request) {
    var row = isPlainObject(request) ? request : {};
    return cleanString(row.requestId || row.reviewId) + '|' + cleanString(row.folderId || row.recordId);
  }

  function folderRestoreRequestExportIdentity(request) {
    var row = isPlainObject(request) ? request : {};
    return cleanString(row.requestId || row.reviewId) + '|' + cleanString(row.folderId || row.recordId);
  }

  function parseChatFolderBindingRequestPayload(row) {
    var raw = row && row.rawTombstoneJson;
    if (!raw && row && row.raw_tombstone_json) raw = row.raw_tombstone_json;
    if (!raw && isPlainObject(row && row.payload)) raw = row.payload;
    if (!raw && isPlainObject(row)) raw = row;
    if (!raw) return null;
    try {
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return isPlainObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function sanitizeChatFolderBindingRequestForExport(row) {
    var payload = parseChatFolderBindingRequestPayload(row);
    if (!payload) return null;
    if (cleanString(payload.schema) !== CHAT_FOLDER_BINDING_REQUEST_SCHEMA) return null;
    if (cleanString(payload.intent) !== 'chat-folder-binding-request') return null;
    if (cleanString(payload.status) !== 'pending') return null;
    if (payload.desktopApplyRequired !== true) return null;
    if (payload.noChromeBindingAuthority !== true && payload.noChromeDestructiveBindingApply !== true) return null;
    if (payload.noHardDelete !== true || payload.noChatDelete !== true || payload.noSnapshotDelete !== true) return null;
    var requestId = cleanString(payload.requestId || payload.reviewId || (row && row.reviewId));
    var chatId = cleanString(payload.chatId || payload.conversationId || (row && row.recordId));
    var targetKind = cleanString(payload.targetKind || (payload.targetUnfiled === true ? 'unfiled' : 'folder')) || 'folder';
    var targetFolderId = cleanString(payload.targetFolderId);
    if (!requestId || !chatId) return null;
    if (targetKind !== 'unfiled' && !targetFolderId) return null;
    return {
      schema: CHAT_FOLDER_BINDING_REQUEST_SCHEMA,
      requestId: requestId,
      reviewId: cleanString(payload.reviewId || requestId) || requestId,
      recordKind: 'folderBinding',
      intent: 'chat-folder-binding-request',
      classification: 'binding-request',
      chatId: chatId,
      conversationId: cleanString(payload.conversationId || chatId) || chatId,
      expectedCurrentFolderId: nullableString(payload.expectedCurrentFolderId || payload.currentFolderId),
      targetFolderId: targetKind === 'unfiled' ? null : targetFolderId,
      targetKind: targetKind === 'unfiled' ? 'unfiled' : 'folder',
      targetUnfiled: targetKind === 'unfiled',
      requestedAt: cleanString(payload.requestedAt || payload.createdAt) || null,
      createdAt: cleanString(payload.createdAt || payload.requestedAt) || null,
      requestedBy: nullableString(payload.requestedBy || 'chrome-studio'),
      source: nullableString(payload.source || 'chrome-studio'),
      sourceSurface: nullableString(payload.sourceSurface || 'chrome-studio'),
      sourcePeerId: nullableString(payload.sourcePeerId || 'chrome-studio'),
      status: 'pending',
      reason: nullableString(payload.reason || 'user-requested-chat-folder-binding-change'),
      desktopApplyRequired: true,
      noLocalApply: true,
      noChromeBindingAuthority: true,
      noChromeDestructiveBindingApply: true,
      noDesktopCanonicalMutation: true,
      noTombstoneApply: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noFolderMutation: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      advisory: isPlainObject(payload.advisory) ? cloneJson(payload.advisory) : null,
      transportedAt: nowIso(),
    };
  }

  function chatFolderBindingRequestExportIdentity(request) {
    var row = isPlainObject(request) ? request : {};
    return cleanString(row.requestId || row.reviewId) + '|' + cleanString(row.chatId || row.conversationId || row.recordId);
  }

  function safeMetadataRequestHash(value) {
    var text = cleanString(value);
    if (!text) return '';
    if (!/^[a-z0-9][a-z0-9:._-]{3,180}$/i.test(text)) return '';
    return text;
  }

  function safeMetadataRequestId(value) {
    var text = cleanString(value);
    if (!text) return '';
    if (!/^[a-z0-9][a-z0-9:._/-]{0,180}$/i.test(text)) return '';
    return text.slice(0, 180);
  }

  function safeMetadataRequestName(value) {
    var text = cleanString(value);
    if (!text) return '';
    text = text.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
    return text.slice(0, 160);
  }

  var NON_DESTRUCTIVE_CLEAR_ALLOWLIST = new Set(['chat-category-clear', 'chat-label-unbind', 'chat-tag-unbind']);

  function normalizeLibraryMetadataMutationAction(input) {
    var source = isPlainObject(input) ? input : {};
    var action = cleanString(source.action || source.requestType || source.type).toLowerCase().replace(/_/g, '-');
    var kind = cleanString(source.metadataKind || source.kind || source.catalogKind).toLowerCase();
    if (!action && kind && cleanString(source.operation)) action = kind + '-' + cleanString(source.operation).toLowerCase();
    if (action === 'create-label') action = 'label-create';
    if (action === 'create-tag') action = 'tag-create';
    if (action === 'create-category') action = 'category-create';
    if (action === 'rename-label') action = 'label-rename';
    if (action === 'rename-tag') action = 'tag-rename';
    if (action === 'rename-category') action = 'category-rename';
    if (action === 'bind-label') action = 'chat-label-bind';
    if (action === 'bind-tag') action = 'chat-tag-bind';
    if (action === 'unbind-label') action = 'chat-label-unbind';
    if (action === 'unbind-tag') action = 'chat-tag-unbind';
    if (action === 'assign-category') action = 'chat-category-assign';
    if (action === 'set-classification') action = 'classification-set';
    return action;
  }

  function libraryMetadataMutationActionSpec(action) {
    var table = {
      'label-create': { metadataKind: 'label', subjectKind: 'catalog', operation: 'create', requiresName: true },
      'tag-create': { metadataKind: 'tag', subjectKind: 'catalog', operation: 'create', requiresName: true },
      'category-create': { metadataKind: 'category', subjectKind: 'catalog', operation: 'create', requiresName: true },
      'label-rename': { metadataKind: 'label', subjectKind: 'catalog', operation: 'rename', requiresId: true, requiresName: true },
      'tag-rename': { metadataKind: 'tag', subjectKind: 'catalog', operation: 'rename', requiresId: true, requiresName: true },
      'category-rename': { metadataKind: 'category', subjectKind: 'catalog', operation: 'rename', requiresId: true, requiresName: true },
      'chat-label-bind': { metadataKind: 'label', subjectKind: 'chat-label-binding', operation: 'bind', requiresChatId: true, requiresId: true },
      'chat-tag-bind': { metadataKind: 'tag', subjectKind: 'chat-tag-binding', operation: 'bind', requiresChatId: true, requiresId: true },
      'chat-label-unbind': { metadataKind: 'label', subjectKind: 'chat-label-binding', operation: 'unbind', requiresChatId: true, requiresId: true },
      'chat-tag-unbind': { metadataKind: 'tag', subjectKind: 'chat-tag-binding', operation: 'unbind', requiresChatId: true, requiresId: true },
      'chat-category-assign': { metadataKind: 'category', subjectKind: 'chat-category-assignment', operation: 'assign', requiresChatId: true, requiresId: true },
      'chat-category-clear': { metadataKind: 'category', subjectKind: 'chat-category-assignment', operation: 'clear', requiresChatId: true, requiresId: false },
      'classification-set': { metadataKind: 'classification', subjectKind: 'classification-signal', operation: 'set', requiresChatId: true, requiresId: true }
    };
    return table[action] || null;
  }

  function libraryMetadataMutationDeferredDestructiveAction(action) {
    var normalized = cleanString(action);
    return /(delete|remove|unbind|clear|purge|hard-delete)/i.test(normalized) &&
      !NON_DESTRUCTIVE_CLEAR_ALLOWLIST.has(normalized);
  }

  function parseLibraryMetadataMutationRequestPayload(row) {
    var raw = row && row.rawTombstoneJson;
    if (!raw && row && row.raw_tombstone_json) raw = row.raw_tombstone_json;
    if (!raw && isPlainObject(row) && cleanString(row.schema) === LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA) raw = row;
    if (!raw && isPlainObject(row && row.payload)) raw = row.payload;
    if (!raw && isPlainObject(row)) raw = row;
    if (!raw) return null;
    try {
      var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return isPlainObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function sanitizeLibraryMetadataMutationRequestForExport(row, diagnostics) {
    function invalid(code) {
      if (diagnostics && Array.isArray(diagnostics.invalidReasons)) {
        diagnostics.invalidReasons.push(cleanString(code) || 'library-metadata-mutation-request-export-invalid');
      }
      return null;
    }
    var payload = parseLibraryMetadataMutationRequestPayload(row);
    if (!payload) return invalid('library-metadata-mutation-request-export-payload-unreadable');
    if (cleanString(payload.schema) !== LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA) return invalid('library-metadata-mutation-request-export-schema-invalid');
    if (cleanString(payload.intent) !== 'library-metadata-mutation-request') return invalid('library-metadata-mutation-request-export-intent-invalid');
    if (cleanString(payload.status) !== 'pending') return invalid('library-metadata-mutation-request-export-status-not-pending');
    if (payload.desktopApplyRequired !== true || payload.noLocalApply !== true) return invalid('library-metadata-mutation-request-export-request-only-flags-invalid');
    if (payload.noChromeCanonicalMutation !== true || payload.noDesktopCanonicalMutation !== true) return invalid('library-metadata-mutation-request-export-authority-flags-invalid');
    if (payload.noHardDelete !== true || payload.noPurge !== true || payload.noChatDelete !== true ||
        payload.noSnapshotDelete !== true || payload.noAssetDelete !== true) return invalid('library-metadata-mutation-request-export-delete-safety-flags-invalid');
    if (payload.noLabelDelete !== true || payload.noTagDelete !== true ||
        payload.noCategoryDelete !== true || payload.noMetadataDelete !== true) return invalid('library-metadata-mutation-request-export-metadata-delete-safety-flags-invalid');
    var action = normalizeLibraryMetadataMutationAction(payload);
    if (libraryMetadataMutationDeferredDestructiveAction(action)) return invalid('library-metadata-mutation-request-export-destructive-action-deferred');
    var spec = libraryMetadataMutationActionSpec(action);
    if (!spec) return invalid('library-metadata-mutation-request-export-action-unsupported');
    var requestId = cleanString(payload.requestId || payload.reviewId);
    if (!requestId) return invalid('library-metadata-mutation-request-export-request-id-missing');
    var p = isPlainObject(payload.payload) ? payload.payload : {};
    var chatId = safeMetadataRequestId(p.chatId || p.conversationId);
    var entityId = safeMetadataRequestId(p.entityId || p.labelId || p.tagId || p.categoryId || p.classificationId);
    var displayName = safeMetadataRequestName(p.displayName);
    if (action === 'chat-category-clear') {
      entityId = '';
      displayName = '';
    }
    if (spec.requiresChatId && !chatId) return invalid('library-metadata-mutation-request-export-chat-id-required');
    if (spec.requiresId && !entityId) return invalid('library-metadata-mutation-request-export-entity-id-required');
    if (spec.requiresName && !displayName) return invalid('library-metadata-mutation-request-export-display-name-required');
    return {
      schema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA,
      version: cleanString(payload.version || '0.1.0-phase6'),
      phase: 'phase6-chrome-request-export',
      requestId: requestId,
      reviewId: cleanString(payload.reviewId || requestId) || requestId,
      idempotencyKey: cleanString(payload.idempotencyKey),
      intent: 'library-metadata-mutation-request',
      classification: 'metadata-request',
      requestType: action,
      action: action,
      operation: spec.operation,
      metadataKind: spec.metadataKind,
      subjectKind: spec.subjectKind,
      status: 'pending',
      createdAt: nullableString(payload.createdAt || payload.requestedAt),
      requestedAt: nullableString(payload.requestedAt || payload.createdAt),
      requestedBy: 'chrome-studio',
      source: 'chrome-studio',
      sourceSurface: 'chrome-studio',
      sourcePeerId: safeMetadataRequestId(payload.sourcePeerId || 'chrome-studio') || 'chrome-studio',
      expectedCurrentBasisHash: safeMetadataRequestHash(payload.expectedCurrentBasisHash),
      expectedCurrentBasis: isPlainObject(payload.expectedCurrentBasis) ? cloneJson(payload.expectedCurrentBasis) : null,
      payload: {
        chatId: chatId || null,
        conversationId: chatId || null,
        entityId: entityId || null,
        labelId: spec.metadataKind === 'label' ? entityId || null : null,
        tagId: spec.metadataKind === 'tag' ? entityId || null : null,
        categoryId: spec.metadataKind === 'category' && action !== 'chat-category-clear' ? entityId || null : null,
        classificationId: spec.metadataKind === 'classification' ? entityId || null : null,
        displayName: displayName || null
      },
      privacy: {
        rawChatContent: false,
        rawChatTitles: false,
        accountLinkedMetadata: false,
        displayNameIncluded: !!displayName,
        displayNameSource: displayName ? 'explicit-user-entered-metadata' : ''
      },
      desktopApplyRequired: true,
      desktopApply: false,
      noLocalApply: true,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutation: true,
      chromeAuthority: false,
      desktopAuthority: true,
      requestOnly: true,
      separateFromDesktopCanonicalLibraryMetadata: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true,
      advisory: {
        productSyncReady: false,
        desktopApplyDeferred: true,
        chromeCanonicalMutationAllowed: false,
        destructiveMetadataActionsDeferred: true
      },
      transportedAt: nowIso()
    };
  }

  function libraryMetadataMutationRequestExportIdentity(request) {
    var row = isPlainObject(request) ? request : {};
    return cleanString(row.requestId || row.reviewId) + '|' + cleanString(row.idempotencyKey);
  }

  function hiddenPendingFolderDeleteRowsFromState(stateInput) {
    var stateValue = isPlainObject(stateInput) ? stateInput : {};
    var bag = isPlainObject(stateValue.hiddenByChromePendingDelete) ? stateValue.hiddenByChromePendingDelete : {};
    return Object.keys(bag).sort().map(function (folderId) {
      var row = isPlainObject(bag[folderId]) ? bag[folderId] : { folderId: folderId };
      var id = cleanString(row.folderId || row.id || folderId);
      if (!id) return null;
      return {
        id: id,
        folderId: id,
        folderName: cleanString(row.folderName || row.name || row.title || id),
        name: cleanString(row.name || row.folderName || row.title || id),
        requestId: cleanString(row.requestId || row.reviewId),
        reviewId: cleanString(row.reviewId || row.requestId),
        requestedAt: cleanString(row.requestedAt || row.hiddenAt),
        reason: cleanString(row.reason || 'chrome-soft-delete-request-pending'),
        sourceSurface: 'chrome-studio',
      };
    }).filter(Boolean);
  }

  async function readChromePendingDeleteHiddenRowsForExport() {
    try {
      var chromeValue = await readKv(FOLDER_STATE_KEY_LOCAL);
      var localValue = null;
      try {
        var raw = global.localStorage && global.localStorage.getItem(FOLDER_STATE_KEY_LOCAL);
        localValue = raw ? JSON.parse(raw) : null;
      } catch (_) {
        localValue = null;
      }
      var byId = Object.create(null);
      hiddenPendingFolderDeleteRowsFromState(localValue).forEach(function (row) {
        byId[row.folderId] = row;
      });
      hiddenPendingFolderDeleteRowsFromState(chromeValue).forEach(function (row) {
        byId[row.folderId] = Object.assign({}, byId[row.folderId] || {}, row);
      });
      return Object.keys(byId).sort().map(function (folderId) { return byId[folderId]; });
    } catch (e) {
      pushError('folderDeleteRequests.pendingHidden.read', e);
      return [];
    }
  }

  async function repairPendingHiddenFolderDeleteRequestsForExport() {
    var result = {
      ok: true,
      status: 'pending-hidden-request-repair-checked',
      pendingDeleteHiddenCount: 0,
      existingExportableRequestCount: 0,
      repairedRequestCount: 0,
      hiddenWithoutExportableRequestCount: 0,
      blockers: [],
      warnings: [],
      rows: [],
    };
    try {
      var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
      if (!reviews || typeof reviews.listFolderDeleteRequests !== 'function' || typeof reviews.requestFolderDelete !== 'function') {
        result.ok = false;
        result.status = 'tombstone-review-store-unavailable';
        result.blockers.push('tombstone-review-store-unavailable');
        return result;
      }
      var hiddenRows = await readChromePendingDeleteHiddenRowsForExport();
      result.pendingDeleteHiddenCount = hiddenRows.length;
      if (!hiddenRows.length) return result;
      var pendingRows = await reviews.listFolderDeleteRequests({ status: 'pending', limit: 1000 });
      var requestByFolderId = Object.create(null);
      (Array.isArray(pendingRows) ? pendingRows : []).forEach(function (row) {
        var request = sanitizeFolderDeleteRequestForExport(row);
        if (request && request.folderId) requestByFolderId[request.folderId] = request;
      });
      result.existingExportableRequestCount = Object.keys(requestByFolderId).length;
      for (var i = 0; i < hiddenRows.length; i += 1) {
        var hidden = hiddenRows[i];
        if (requestByFolderId[hidden.folderId]) continue;
        result.hiddenWithoutExportableRequestCount += 1;
        var requestResult = await reviews.requestFolderDelete({
          folderId: hidden.folderId,
          id: hidden.folderId,
          folderName: hidden.folderName || hidden.name || hidden.folderId,
          name: hidden.name || hidden.folderName || hidden.folderId,
          sourceSurface: 'chrome-studio',
          requestId: hidden.requestId || hidden.reviewId || undefined,
          requestedAt: hidden.requestedAt || undefined,
        }, {
          sourceSurface: 'chrome-studio',
          reason: 'phase6b4c-repair-pending-hide-export-request',
        });
        var ok = requestResult && requestResult.ok === true;
        if (ok) {
          result.repairedRequestCount += 1;
          result.rows.push({
            folderId: hidden.folderId,
            folderName: hidden.folderName || hidden.name || '',
            requestId: cleanString(requestResult.requestId || requestResult.reviewId),
            status: cleanString(requestResult.status),
          });
        } else {
          result.warnings.push('pending-hide-without-exportable-delete-request');
          result.rows.push({
            folderId: hidden.folderId,
            folderName: hidden.folderName || hidden.name || '',
            status: cleanString(requestResult && requestResult.status) || 'request-repair-failed',
          });
        }
      }
      if (result.hiddenWithoutExportableRequestCount > 0 && result.repairedRequestCount < result.hiddenWithoutExportableRequestCount) {
        result.warnings.push('pending-hide-without-exportable-delete-request');
      }
      return result;
    } catch (e) {
      result.ok = false;
      result.status = 'pending-hidden-request-repair-failed';
      result.blockers.push('pending-hidden-request-repair-failed');
      result.error = String((e && e.message) || e);
      pushError('folderDeleteRequests.pendingHidden.repair', e);
      return result;
    }
  }

  async function readFolderDeleteRequestExportMirror() {
    var empty = {
      ok: true,
      schema: FOLDER_DELETE_REQUEST_EXPORT_MIRROR_SCHEMA,
      found: false,
      requestCount: 0,
      requests: [],
    };
    try {
      var mirror = await readKv(FOLDER_DELETE_REQUEST_EXPORT_KEY);
      if (!mirror || typeof mirror !== 'object') return empty;
      if (cleanString(mirror.schema) !== FOLDER_DELETE_REQUEST_EXPORT_MIRROR_SCHEMA) {
        return Object.assign({}, empty, { ok: false, found: true, warning: 'folder-delete-request-export-mirror-schema-invalid' });
      }
      var rows = Array.isArray(mirror.requests) ? mirror.requests : [];
      return {
        ok: true,
        schema: FOLDER_DELETE_REQUEST_EXPORT_MIRROR_SCHEMA,
        found: true,
        updatedAt: cleanString(mirror.updatedAt),
        requestCount: rows.length,
        requests: rows,
      };
    } catch (e) {
      pushError('folderDeleteRequests.exportMirror.read', e);
      return Object.assign({}, empty, {
        ok: false,
        found: false,
        warning: 'folder-delete-request-export-mirror-read-failed',
        error: String((e && e.message) || e),
      });
    }
  }

  async function readFolderRestoreRequestExportMirror() {
    var empty = {
      ok: true,
      schema: FOLDER_RESTORE_REQUEST_EXPORT_MIRROR_SCHEMA,
      found: false,
      requestCount: 0,
      requests: [],
    };
    try {
      var mirror = await readKv(FOLDER_RESTORE_REQUEST_EXPORT_KEY);
      if (!mirror || typeof mirror !== 'object') return empty;
      if (cleanString(mirror.schema) !== FOLDER_RESTORE_REQUEST_EXPORT_MIRROR_SCHEMA) {
        return Object.assign({}, empty, { ok: false, found: true, warning: 'folder-restore-request-export-mirror-schema-invalid' });
      }
      var rows = Array.isArray(mirror.requests) ? mirror.requests : [];
      return {
        ok: true,
        schema: FOLDER_RESTORE_REQUEST_EXPORT_MIRROR_SCHEMA,
        found: true,
        updatedAt: cleanString(mirror.updatedAt),
        requestCount: rows.length,
        requests: rows,
      };
    } catch (e) {
      pushError('folderRestoreRequests.exportMirror.read', e);
      return Object.assign({}, empty, {
        ok: false,
        found: false,
        warning: 'folder-restore-request-export-mirror-read-failed',
        error: String((e && e.message) || e),
      });
    }
  }

  async function readChatFolderBindingRequestExportMirror() {
    var empty = {
      ok: true,
      schema: CHAT_FOLDER_BINDING_REQUEST_EXPORT_MIRROR_SCHEMA,
      found: false,
      requestCount: 0,
      requests: [],
    };
    try {
      var mirror = await readKv(CHAT_FOLDER_BINDING_REQUEST_EXPORT_KEY);
      if (!mirror || typeof mirror !== 'object') return empty;
      if (cleanString(mirror.schema) !== CHAT_FOLDER_BINDING_REQUEST_EXPORT_MIRROR_SCHEMA) {
        return Object.assign({}, empty, { ok: false, found: true, warning: 'chat-folder-binding-request-export-mirror-schema-invalid' });
      }
      var rows = Array.isArray(mirror.requests) ? mirror.requests : [];
      return {
        ok: true,
        schema: CHAT_FOLDER_BINDING_REQUEST_EXPORT_MIRROR_SCHEMA,
        found: true,
        updatedAt: cleanString(mirror.updatedAt),
        requestCount: rows.length,
        requests: rows,
      };
    } catch (e) {
      pushError('chatFolderBindingRequests.exportMirror.read', e);
      return Object.assign({}, empty, {
        ok: false,
        found: false,
        warning: 'chat-folder-binding-request-export-mirror-read-failed',
        error: String((e && e.message) || e),
      });
    }
  }

  async function readLibraryMetadataMutationRequestExportMirror() {
    var empty = {
      ok: true,
      schema: LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA,
      found: false,
      requestCount: 0,
      requests: [],
    };
    try {
      var mirror = await readKv(LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_KEY);
      if (!mirror || typeof mirror !== 'object') return empty;
      if (cleanString(mirror.schema) !== LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA) {
        return Object.assign({}, empty, { ok: false, found: true, warning: 'library-metadata-mutation-request-export-mirror-schema-invalid' });
      }
      var rows = Array.isArray(mirror.requests) ? mirror.requests : [];
      return {
        ok: true,
        schema: LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA,
        found: true,
        updatedAt: cleanString(mirror.updatedAt),
        requestCount: rows.length,
        requests: rows,
      };
    } catch (e) {
      pushError('libraryMetadataMutationRequests.exportMirror.read', e);
      return Object.assign({}, empty, {
        ok: false,
        found: false,
        warning: 'library-metadata-mutation-request-export-mirror-read-failed',
        error: String((e && e.message) || e),
      });
    }
  }

  async function collectFolderDeleteRequestsForExport() {
    var result = {
      ok: true,
      schema: FOLDER_DELETE_REQUEST_SCHEMA + '.export.v1',
      requestCount: 0,
      skippedCount: 0,
      reviewRequestCount: 0,
      mirrorRequestCount: 0,
      staleMirrorSkippedCount: 0,
      pendingDeleteHiddenCount: 0,
      hiddenWithoutExportableRequestCount: 0,
      repairedHiddenRequestCount: 0,
      warnings: [],
      requests: [],
    };
    try {
      var pendingHiddenRepair = await repairPendingHiddenFolderDeleteRequestsForExport();
      result.pendingHiddenRepair = pendingHiddenRepair;
      result.pendingDeleteHiddenCount = Number(pendingHiddenRepair.pendingDeleteHiddenCount || 0);
      result.hiddenWithoutExportableRequestCount = Number(pendingHiddenRepair.hiddenWithoutExportableRequestCount || 0);
      result.repairedHiddenRequestCount = Number(pendingHiddenRepair.repairedRequestCount || 0);
      (pendingHiddenRepair.warnings || []).forEach(function (code) {
        if (result.warnings.indexOf(code) === -1) result.warnings.push(code);
      });
      var byIdentity = Object.create(null);
      function addRequest(row, source) {
        var request = sanitizeFolderDeleteRequestForExport(row);
        if (!request) {
          result.skippedCount += 1;
          return null;
        }
        var key = folderDeleteRequestExportIdentity(request);
        if (!key || key === '|') {
          result.skippedCount += 1;
          return null;
        }
        if (!byIdentity[key]) {
          request.exportSource = source;
          byIdentity[key] = request;
          result.requests.push(request);
        }
        return request;
      }
      var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
      var reviewStatusByIdentity = Object.create(null);
      if (!reviews || typeof reviews.listFolderDeleteRequests !== 'function') {
        result.storeAvailable = false;
      } else {
        result.storeAvailable = true;
        var allRows = await reviews.listFolderDeleteRequests({ limit: 1000 });
        (Array.isArray(allRows) ? allRows : []).forEach(function (row) {
          var payload = parseFolderDeleteRequestPayload(row);
          var status = cleanString((payload && payload.status) || row.status);
          var key = folderDeleteRequestExportIdentity({
            requestId: payload && (payload.requestId || payload.reviewId) || row.reviewId,
            reviewId: payload && (payload.reviewId || payload.requestId) || row.reviewId,
            folderId: payload && payload.folderId || row.recordId,
          });
          if (key && key !== '|') reviewStatusByIdentity[key] = status || 'unknown';
          if (status === 'pending') addRequest(row, 'review-store');
        });
        result.reviewRequestCount = result.requests.length;
      }
      var mirror = await readFolderDeleteRequestExportMirror();
      result.mirrorAvailable = mirror.found === true;
      result.mirrorOk = mirror.ok === true;
      result.mirrorRequestCount = Number(mirror.requestCount || 0);
      if (mirror.warning) result.warnings.push(mirror.warning);
      (Array.isArray(mirror.requests) ? mirror.requests : []).forEach(function (row) {
        var request = sanitizeFolderDeleteRequestForExport(row);
        if (!request) {
          result.skippedCount += 1;
          return;
        }
        var key = folderDeleteRequestExportIdentity(request);
        var knownStatus = reviewStatusByIdentity[key];
        if (knownStatus && knownStatus !== 'pending') {
          result.staleMirrorSkippedCount += 1;
          return;
        }
        addRequest(request, 'pending-export-mirror');
      });
      result.requestCount = result.requests.length;
      return result;
    } catch (e) {
      result.ok = false;
      result.warnings.push('folder-delete-request-export-failed');
      result.error = String((e && e.message) || e);
      pushError('folderDeleteRequests.export', e);
      return result;
    }
  }

  async function collectFolderRestoreRequestsForExport() {
    var result = {
      ok: true,
      schema: FOLDER_RESTORE_REQUEST_SCHEMA + '.export.v1',
      requestCount: 0,
      pendingRestoreRequestCount: 0,
      skippedCount: 0,
      purgedRestoreBlockedCount: 0,
      invalidCount: 0,
      reviewRequestCount: 0,
      mirrorRequestCount: 0,
      staleMirrorSkippedCount: 0,
      warnings: [],
      blockers: [],
      requests: [],
      noChromeRestoreAuthority: true,
      noTombstoneApply: true,
      noTombstoneCreate: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
    try {
      var byIdentity = Object.create(null);
      function addRequest(row, source) {
        var request = sanitizeFolderRestoreRequestForExport(row);
        if (!request) {
          result.skippedCount += 1;
          result.invalidCount += 1;
          return null;
        }
        var key = folderRestoreRequestExportIdentity(request);
        if (!key || key === '|') {
          result.skippedCount += 1;
          result.invalidCount += 1;
          return null;
        }
        if (!byIdentity[key]) {
          request.exportSource = source;
          byIdentity[key] = request;
          result.requests.push(request);
        }
        return request;
      }
      var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
      var reviewStatusByIdentity = Object.create(null);
      if (!reviews || typeof reviews.listFolderRestoreRequests !== 'function') {
        result.storeAvailable = false;
      } else {
        result.storeAvailable = true;
        var allRows = await reviews.listFolderRestoreRequests({ limit: 1000 });
        (Array.isArray(allRows) ? allRows : []).forEach(function (row) {
          var payload = parseFolderRestoreRequestPayload(row);
          var status = cleanString((payload && payload.status) || row.status);
          var key = folderRestoreRequestExportIdentity({
            requestId: payload && (payload.requestId || payload.reviewId) || row.reviewId,
            reviewId: payload && (payload.reviewId || payload.requestId) || row.reviewId,
            folderId: payload && payload.folderId || row.recordId,
          });
          if (key && key !== '|') reviewStatusByIdentity[key] = status || 'unknown';
          if (status === 'pending') addRequest(row, 'review-store');
        });
        result.reviewRequestCount = result.requests.length;
      }
      var mirror = await readFolderRestoreRequestExportMirror();
      result.mirrorAvailable = mirror.found === true;
      result.mirrorOk = mirror.ok === true;
      result.mirrorRequestCount = Number(mirror.requestCount || 0);
      if (mirror.warning) result.warnings.push(mirror.warning);
      (Array.isArray(mirror.requests) ? mirror.requests : []).forEach(function (row) {
        var request = sanitizeFolderRestoreRequestForExport(row);
        if (!request) {
          result.skippedCount += 1;
          result.invalidCount += 1;
          return;
        }
        var key = folderRestoreRequestExportIdentity(request);
        var knownStatus = reviewStatusByIdentity[key];
        if (knownStatus && knownStatus !== 'pending') {
          result.staleMirrorSkippedCount += 1;
          return;
        }
        addRequest(request, 'pending-export-mirror');
      });
      result.requestCount = result.requests.length;
      result.pendingRestoreRequestCount = result.requests.length;
      return result;
    } catch (e) {
      result.ok = false;
      result.warnings.push('folder-restore-request-export-failed');
      result.blockers.push('folder-restore-request-export-failed');
      result.error = String((e && e.message) || e);
      pushError('folderRestoreRequests.export', e);
      return result;
    }
  }

  async function collectChatFolderBindingRequestsForExport() {
    var result = {
      ok: true,
      schema: CHAT_FOLDER_BINDING_REQUEST_SCHEMA + '.export.v1',
      requestCount: 0,
      pendingRequestCount: 0,
      skippedCount: 0,
      invalidCount: 0,
      reviewRequestCount: 0,
      mirrorRequestCount: 0,
      staleMirrorSkippedCount: 0,
      warnings: [],
      blockers: [],
      requests: [],
      noChromeBindingAuthority: true,
      noChromeDestructiveBindingApply: true,
      noDesktopCanonicalMutation: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
    try {
      var byIdentity = Object.create(null);
      function addRequest(row, source) {
        var request = sanitizeChatFolderBindingRequestForExport(row);
        if (!request) {
          result.skippedCount += 1;
          result.invalidCount += 1;
          return null;
        }
        var key = chatFolderBindingRequestExportIdentity(request);
        if (!key || key === '|') {
          result.skippedCount += 1;
          result.invalidCount += 1;
          return null;
        }
        if (!byIdentity[key]) {
          request.exportSource = source;
          byIdentity[key] = request;
          result.requests.push(request);
        }
        return request;
      }
      var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
      var reviewStatusByIdentity = Object.create(null);
      if (!reviews || typeof reviews.listChatFolderBindingRequests !== 'function') {
        result.storeAvailable = false;
      } else {
        result.storeAvailable = true;
        var allRows = await reviews.listChatFolderBindingRequests({ limit: 1000 });
        (Array.isArray(allRows) ? allRows : []).forEach(function (row) {
          var payload = parseChatFolderBindingRequestPayload(row);
          var status = cleanString((payload && payload.status) || row.status);
          var key = chatFolderBindingRequestExportIdentity({
            requestId: payload && (payload.requestId || payload.reviewId) || row.reviewId,
            reviewId: payload && (payload.reviewId || payload.requestId) || row.reviewId,
            chatId: payload && (payload.chatId || payload.conversationId) || row.recordId,
          });
          if (key && key !== '|') reviewStatusByIdentity[key] = status || 'unknown';
          if (status === 'pending') addRequest(row, 'review-store');
        });
        result.reviewRequestCount = result.requests.length;
      }
      var mirror = await readChatFolderBindingRequestExportMirror();
      result.mirrorAvailable = mirror.found === true;
      result.mirrorOk = mirror.ok === true;
      result.mirrorRequestCount = Number(mirror.requestCount || 0);
      if (mirror.warning) result.warnings.push(mirror.warning);
      (Array.isArray(mirror.requests) ? mirror.requests : []).forEach(function (row) {
        var request = sanitizeChatFolderBindingRequestForExport(row);
        if (!request) {
          result.skippedCount += 1;
          result.invalidCount += 1;
          return;
        }
        var key = chatFolderBindingRequestExportIdentity(request);
        var knownStatus = reviewStatusByIdentity[key];
        if (knownStatus && knownStatus !== 'pending') {
          result.staleMirrorSkippedCount += 1;
          return;
        }
        addRequest(request, 'pending-export-mirror');
      });
      result.requestCount = result.requests.length;
      result.pendingRequestCount = result.requests.length;
      return result;
    } catch (e) {
      result.ok = false;
      result.warnings.push('chat-folder-binding-request-export-failed');
      result.blockers.push('chat-folder-binding-request-export-failed');
      result.error = String((e && e.message) || e);
      pushError('chatFolderBindingRequests.export', e);
      return result;
    }
  }

  async function collectLibraryMetadataMutationRequestsForExport() {
    var result = {
      ok: true,
      schema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA + '.export.v1',
      requestCount: 0,
      pendingRequestCount: 0,
      skippedCount: 0,
      invalidCount: 0,
      mirrorRequestCount: 0,
      warnings: [],
      blockers: [],
      requests: [],
      requestOnly: true,
      desktopApplyRequired: true,
      desktopApply: false,
      noLocalApply: true,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutation: true,
      chromeAuthority: false,
      desktopAuthority: true,
      separateFromDesktopCanonicalLibraryMetadata: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true,
      invalidReasons: [],
      invalidReasonCounts: {},
    };
    try {
      var byIdentity = Object.create(null);
      function addRequest(row) {
        var diagnostics = { invalidReasons: [] };
        var request = sanitizeLibraryMetadataMutationRequestForExport(row, diagnostics);
        if (!request) {
          result.skippedCount += 1;
          result.invalidCount += 1;
          diagnostics.invalidReasons.forEach(function (code) {
            if (!code) return;
            result.invalidReasons.push(code);
            result.invalidReasonCounts[code] = (result.invalidReasonCounts[code] || 0) + 1;
          });
          return null;
        }
        var key = libraryMetadataMutationRequestExportIdentity(request);
        if (!key || key === '|') {
          result.skippedCount += 1;
          result.invalidCount += 1;
          result.invalidReasons.push('library-metadata-mutation-request-export-identity-invalid');
          result.invalidReasonCounts['library-metadata-mutation-request-export-identity-invalid'] =
            (result.invalidReasonCounts['library-metadata-mutation-request-export-identity-invalid'] || 0) + 1;
          return null;
        }
        if (!byIdentity[key]) {
          request.exportSource = 'pending-export-mirror';
          byIdentity[key] = request;
          result.requests.push(request);
        }
        return request;
      }
      var mirror = await readLibraryMetadataMutationRequestExportMirror();
      result.mirrorAvailable = mirror.found === true;
      result.mirrorOk = mirror.ok === true;
      result.mirrorRequestCount = Number(mirror.requestCount || 0);
      if (mirror.warning) result.warnings.push(mirror.warning);
      (Array.isArray(mirror.requests) ? mirror.requests : []).forEach(function (row) {
        addRequest(row);
      });
      result.requestCount = result.requests.length;
      result.pendingRequestCount = result.requests.length;
      return result;
    } catch (e) {
      result.ok = false;
      result.warnings.push('library-metadata-mutation-request-export-failed');
      result.blockers.push('library-metadata-mutation-request-export-failed');
      result.error = String((e && e.message) || e);
      pushError('libraryMetadataMutationRequests.export', e);
      return result;
    }
  }

  function looksLikeOpaqueTitle(value, id) {
    var text = cleanString(value);
    var chatId = cleanString(id);
    if (!text) return true;
    if (chatId && text === chatId) return true;
    if (/^(imported chat|linked chat|untitled chat|link|chatgpt)$/i.test(text)) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) return true;
    if (/^[0-9a-f][0-9a-f-]{23,}$/i.test(text)) return true;
    if (/^(imported|chat|conversation)[-_:][a-z0-9-]{12,}$/i.test(text)) return true;
    return false;
  }

  function friendlyShellTitle(primary, id, fallback) {
    var values = Array.isArray(primary) ? primary : [primary];
    for (var i = 0; i < values.length; i += 1) {
      var title = cleanString(values[i]);
      if (title && !looksLikeOpaqueTitle(title, id)) return title;
    }
    return cleanString(fallback) || 'Imported chat';
  }

  function titleCandidatesFromLibraryRow(row) {
    var r = row && typeof row === 'object' ? row : {};
    var meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
    var source = r.source && typeof r.source === 'object' ? r.source : {};
    return [
      r.title,
      r.displayTitle,
      r.sourceTitle,
      r.pageTitle,
      r.chatTitle,
      r.originalTitle,
      r.name,
      meta.title,
      meta.displayTitle,
      meta.sourceTitle,
      meta.pageTitle,
      meta.chatTitle,
      meta.originalTitle,
      source.title,
      source.displayTitle,
      source.sourceTitle,
      source.pageTitle,
      source.chatTitle,
      source.originalTitle,
      r.filename,
      r.fileName,
      r.sourceLabel,
      meta.filename,
      meta.sourceLabel,
      source.filename,
      source.label
    ];
  }

  function boolValue(value) {
    return value === true || value === 1 || value === '1' || value === 'true';
  }

  function numericCount(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }

  function redactedHash(value) {
    var text = cleanString(value);
    if (!text) return '';
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return 'h:' + ('00000000' + hash.toString(16)).slice(-8);
  }

  function incrementCount(map, key) {
    if (!map) return;
    var k = cleanString(key) || 'unknown';
    map[k] = Number(map[k] || 0) + 1;
  }

  function normalizeDisplayClass(value) {
    var text = cleanString(value).toLowerCase();
    if (!text) return '';
    if (text === 'link' || text === 'linked') return 'link';
    if (text === 'saved') return 'saved';
    if (text === 'archive' || text === 'archived') return 'archived';
    if (text === 'imported' || text === 'placeholder') return text;
    return text;
  }

  function displayClass(row) {
    var r = row && typeof row === 'object' ? row : {};
    var badge = cleanString(r.badgeKind || r.badge || '');
    var explicit = normalizeDisplayClass(r.displayView);
    if (explicit) return explicit;
    if (/^link$/i.test(badge)) return 'link';
    if (/^saved$/i.test(badge)) return 'saved';
    if (/^archive$/i.test(badge)) return 'archived';
    return normalizeDisplayClass(r.view || r.status || r.kind || r.type);
  }

  function rowView(row) {
    return displayClass(row);
  }

  function extractChatGptConversationId(value) {
    var text = cleanString(value);
    if (!text) return '';
    var match = text.match(/(?:^|\/)c\/([^/?#]+)/i);
    return match && match[1] ? cleanString(match[1]) : '';
  }

  function rowId(row) {
    return cleanString(row && (row.chatId || row.id || row.externalId || row.conversationId))
      || extractChatGptConversationId(row && (row.href || row.url || row.sourceUrl || row.normalizedHref || row.linkSourceHref));
  }

  function addIdentityKey(keys, prefix, value) {
    var cleaned = cleanString(value);
    if (!cleaned) return;
    keys[prefix + ':' + cleaned] = true;
  }

  function libraryRowIdentityKeys(row) {
    var keys = Object.create(null);
    addIdentityKey(keys, 'chat', row && row.chatId);
    addIdentityKey(keys, 'chat', row && row.id);
    addIdentityKey(keys, 'chat', row && row.externalId);
    addIdentityKey(keys, 'chat', row && row.conversationId);
    addIdentityKey(keys, 'snapshot', row && row.snapshotId);
    addIdentityKey(keys, 'snapshot', row && row.lastSnapshotId);
    addIdentityKey(keys, 'snapshot', row && row.latestSnapshotId);
    addIdentityKey(keys, 'snapshot', row && row.snapshot_id);
    addIdentityKey(keys, 'chat', extractChatGptConversationId(row && row.href));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(row && row.url));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(row && row.sourceUrl));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(row && row.normalizedHref));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(row && row.linkSourceHref));
    return Object.keys(keys);
  }

  function bundleChatIdentityKeys(chat) {
    var keys = Object.create(null);
    var index = chat && chat.chatIndex && typeof chat.chatIndex === 'object' ? chat.chatIndex : {};
    addIdentityKey(keys, 'chat', chat && chat.chatId);
    addIdentityKey(keys, 'chat', index.chatId);
    addIdentityKey(keys, 'chat', index.id);
    addIdentityKey(keys, 'chat', index.externalId);
    addIdentityKey(keys, 'chat', index.conversationId);
    addIdentityKey(keys, 'snapshot', index.snapshotId);
    addIdentityKey(keys, 'snapshot', index.lastSnapshotId);
    addIdentityKey(keys, 'snapshot', index.latestSnapshotId);
    addIdentityKey(keys, 'snapshot', index.snapshot_id);
    addIdentityKey(keys, 'chat', extractChatGptConversationId(chat && chat.href));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(chat && chat.url));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(chat && chat.sourceUrl));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(index.href));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(index.url));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(index.sourceUrl));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(index.normalizedHref));
    addIdentityKey(keys, 'chat', extractChatGptConversationId(index.linkSourceHref));
    (Array.isArray(chat && chat.snapshots) ? chat.snapshots : []).forEach(function (snapshot) {
      addIdentityKey(keys, 'chat', snapshot && snapshot.chatId);
      addIdentityKey(keys, 'snapshot', snapshot && (snapshot.snapshotId || snapshot.id));
    });
    return Object.keys(keys);
  }

  function isSavedRow(row) {
    var view = rowView(row);
    if (view === 'saved') return true;
    if (view === 'link' || view === 'linked' || view === 'imported' || view === 'placeholder') return false;
    return boolValue(row && (row.saved || row.isSaved));
  }

  function isLinkedRow(row) {
    var view = rowView(row);
    if (view === 'link' || view === 'linked') return true;
    if (view === 'saved') return false;
    return boolValue(row && (row.linked || row.isLinked));
  }

  function isArchivedRow(row) {
    var view = rowView(row);
    return view === 'archived' || boolValue(row && (row.archived || row.isArchived));
  }

  function isImportedRow(row) {
    var view = rowView(row);
    var stateObj = row && row.state && typeof row.state === 'object' ? row.state : {};
    return view === 'imported' || boolValue(row && row.isImported) || boolValue(stateObj.isImported);
  }

  function isPinnedRow(row) {
    return boolValue(row && (row.pinned || row.isPinned));
  }

  function hasRealTranscriptEvidence(row) {
    return !!cleanString(row && (row.lastSnapshotId || row.snapshotId || row.snapshot_id || row.latestSnapshotId))
      || numericCount(row && row.messageCount) > 0
      || numericCount(row && row.turnCount) > 0
      || numericCount(row && row.userTurnCount) > 0
      || numericCount(row && row.assistantTurnCount) > 0;
  }

  function hasArchiveEvidence(row) {
    return hasRealTranscriptEvidence(row);
  }

  function rowPayloadClass(row) {
    var r = row && typeof row === 'object' ? row : {};
    var source = [
      r.transcriptEvidenceSource,
      r.captureSource,
      r.linkedFrom,
      r.sourceView,
      r.originalView,
      r.rawView,
      r.source && r.source.kind,
      r.source && r.source.source,
      r.meta && r.meta.importedFrom,
      r.meta && r.meta.captureSource
    ].map(cleanString).join(' ').toLowerCase();
    if (source.indexOf('save-to-folder') !== -1 || source.indexOf('native') !== -1) return 'native-save-to-folder';
    if (isImportedRow(row)) return 'imported-shell';
    if (hasArchiveEvidence(row)) return 'archive-backed';
    if (cleanString(r.sourceView || r.originalView || r.rawView)) return 'registry-repair';
    return 'saved-row';
  }

  function rowSourceKind(row) {
    var r = row && typeof row === 'object' ? row : {};
    var source = cleanString(r.sourceKind || r.sourceType || r.transcriptEvidenceSource || r.captureSource);
    if (source) return source;
    if (r.source && typeof r.source === 'object') {
      source = cleanString(r.source.kind || r.source.source || r.source.type);
      if (source) return source;
    }
    if (r.meta && typeof r.meta === 'object') {
      source = cleanString(r.meta.importedFrom || r.meta.captureSource || r.meta.sourceKind);
      if (source) return source;
    }
    return cleanString(r.sourceView || r.originalView || r.rawView || r.view || r.displayView || 'library-index');
  }

  function getLibraryIndexRows() {
    try {
      var idx = H2O.LibraryIndex || (H2O.Library && H2O.Library.Index) || null;
      if (!idx || typeof idx.getAll !== 'function') return null;
      var rows = idx.getAll();
      return Array.isArray(rows) ? rows.slice() : [];
    } catch (_) {
      return null;
    }
  }

  function ensureBundleChatArchive(bundle) {
    if (!bundle.chatArchive || typeof bundle.chatArchive !== 'object' || Array.isArray(bundle.chatArchive)) {
      bundle.chatArchive = { schema: 'h2o.chatArchive.bundle.v1', chats: [], catalogs: {} };
    }
    if (!Array.isArray(bundle.chatArchive.chats)) bundle.chatArchive.chats = [];
    if (!bundle.chatArchive.catalogs || typeof bundle.chatArchive.catalogs !== 'object' || Array.isArray(bundle.chatArchive.catalogs)) {
      bundle.chatArchive.catalogs = {};
    }
    return bundle.chatArchive;
  }

  function bundleChatId(chat) {
    return cleanString(chat && (chat.chatId || (chat.chatIndex && (chat.chatIndex.chatId || chat.chatIndex.id))));
  }

  function bundleChatIndex(chat) {
    return chat && chat.chatIndex && typeof chat.chatIndex === 'object' && !Array.isArray(chat.chatIndex)
      ? chat.chatIndex : {};
  }

  function bundleChatState(chat) {
    var index = bundleChatIndex(chat);
    return index.state && typeof index.state === 'object' && !Array.isArray(index.state)
      ? index.state : {};
  }

  function bundleChatDisplayClass(chat) {
    var index = bundleChatIndex(chat);
    return normalizeDisplayClass(index.displayView || index.badgeKind || index.view || index.kind || index.type);
  }

  function bundleChatSnapshotId(chat) {
    var index = bundleChatIndex(chat);
    var sid = cleanString(
      (chat && (chat.snapshotId || chat.lastSnapshotId || chat.latestSnapshotId))
      || index.snapshotId
      || index.lastSnapshotId
      || index.latestSnapshotId
      || index.snapshot_id
    );
    if (sid) return sid;
    var snapshots = Array.isArray(chat && chat.snapshots) ? chat.snapshots : [];
    for (var i = 0; i < snapshots.length; i += 1) {
      sid = cleanString(snapshots[i] && (snapshots[i].snapshotId || snapshots[i].id));
      if (sid) return sid;
    }
    return '';
  }

  function classifyUnindexedArchiveChat(chat) {
    var index = bundleChatIndex(chat);
    var stateObj = bundleChatState(chat);
    var view = bundleChatDisplayClass(chat);
    var hasSnapshots = Array.isArray(chat && chat.snapshots) && chat.snapshots.length > 0;
    var isArchived = view === 'archived' || stateObj.isArchived === true || index.archived === true || index.isArchived === true;
    var isLinked = view === 'link' || view === 'linked' || stateObj.isLinked === true || index.isLinked === true;
    var isImported = view === 'imported' || view === 'placeholder' || stateObj.isImported === true || index.isImported === true;
    var isSaved = !isLinked && (view === 'saved' || stateObj.isSaved === true || index.isSaved === true || (!isImported && hasSnapshots));
    var isPinned = stateObj.isPinned === true || index.pinned === true || index.isPinned === true;
    var rowClass = isArchived ? 'archived' : (isLinked ? 'link' : (isImported ? 'imported' : (isSaved ? 'saved' : 'unknown')));
    return {
      rowClass: rowClass,
      isSaved: !!isSaved,
      isLinked: !!isLinked,
      isPinned: !!isPinned,
      isArchived: !!isArchived,
      hasSnapshotId: !!bundleChatSnapshotId(chat),
      hasSnapshots: hasSnapshots
    };
  }

  function unindexedArchiveReason(chat, classification) {
    if (classification && classification.isArchived) return 'archived';
    if (bundleChatIdentityKeys(chat).length > 0) return 'not-indexed';
    return 'unknown-unindexed';
  }

  function buildUnindexedArchiveManifest(archiveChats, usedArchiveIndexes) {
    var rows = [];
    var reasonCounts = Object.create(null);
    (Array.isArray(archiveChats) ? archiveChats : []).forEach(function (chat, index) {
      if (usedArchiveIndexes && usedArchiveIndexes[index]) return;
      var identityKeys = bundleChatIdentityKeys(chat).sort();
      var rowHashSource = identityKeys.length > 0 ? identityKeys.join('|') : ('unindexed-archive-position:' + index);
      var classification = classifyUnindexedArchiveChat(chat);
      var reason = unindexedArchiveReason(chat, classification);
      incrementCount(reasonCounts, reason);
      rows.push({
        rowHash: redactedHash(rowHashSource),
        chatIdHash: redactedHash(bundleChatId(chat)),
        snapshotIdHash: redactedHash(bundleChatSnapshotId(chat)),
        rowClass: classification.rowClass,
        reason: reason,
        hasSnapshotId: classification.hasSnapshotId,
        hasSnapshots: classification.hasSnapshots,
        isSaved: classification.isSaved,
        isLinked: classification.isLinked,
        isPinned: classification.isPinned,
        isArchived: classification.isArchived
      });
    });
    return {
      schema: 'h2o.studio.sync.chrome-export-unindexed-rows.v1',
      count: rows.length,
      rows: rows,
      reasonCounts: reasonCounts,
      privacy: {
        redacted: true,
        rawIdsReturned: false,
        rawTitlesReturned: false,
        rawContentReturned: false
      }
    };
  }

  function countBundleViews(chats) {
    var counts = { saved: 0, linked: 0, pinned: 0, archived: 0 };
    (Array.isArray(chats) ? chats : []).forEach(function (chat) {
      var index = bundleChatIndex(chat);
      var stateObj = bundleChatState(chat);
      var view = bundleChatDisplayClass(chat);
      var hasSnapshots = Array.isArray(chat && chat.snapshots) && chat.snapshots.length > 0;
      var imported = view === 'imported' || view === 'placeholder' || stateObj.isImported === true || index.isImported === true;
      if (view === 'link' || view === 'linked' || stateObj.isLinked === true || index.isLinked === true) counts.linked += 1;
      else if (view === 'saved' || stateObj.isSaved === true || index.isSaved === true || (!imported && hasSnapshots)) counts.saved += 1;
      if (stateObj.isPinned === true || index.pinned === true || index.isPinned === true) counts.pinned += 1;
      if (stateObj.isArchived === true || index.archived === true || index.isArchived === true) counts.archived += 1;
    });
    return counts;
  }

  function countSnapshotRows(rows) {
    var counts = { total: 0, saved: 0, linked: 0, pinned: 0, archived: 0 };
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      counts.total += 1;
      if (isSavedRow(row)) counts.saved += 1;
      if (isLinkedRow(row)) counts.linked += 1;
      if (isPinnedRow(row)) counts.pinned += 1;
      if (isArchivedRow(row)) counts.archived += 1;
    });
    return counts;
  }

  function makeMissingRowTypeCounts(rows) {
    var out = {
      linkedOnly: 0,
      savedOnly: 0,
      registryOnly: 0,
      archiveBacked: 0,
      pinned: 0
    };
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      var saved = isSavedRow(row);
      var linked = isLinkedRow(row);
      var archiveBacked = hasArchiveEvidence(row);
      if (linked && !saved) out.linkedOnly += 1;
      if (saved && !linked) out.savedOnly += 1;
      if (!archiveBacked) out.registryOnly += 1;
      if (archiveBacked) out.archiveBacked += 1;
      if (isPinnedRow(row)) out.pinned += 1;
    });
    return out;
  }

  function makeExportClassCounts(rows) {
    var out = {
      saved: 0,
      link: 0,
      imported: 0,
      transcriptBacked: 0,
      registryOnly: 0,
      pinned: 0,
      archived: 0
    };
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (isSavedRow(row)) out.saved += 1;
      if (isLinkedRow(row)) out.link += 1;
      if (isImportedRow(row)) out.imported += 1;
      if (hasRealTranscriptEvidence(row)) out.transcriptBacked += 1;
      else out.registryOnly += 1;
      if (isPinnedRow(row)) out.pinned += 1;
      if (isArchivedRow(row)) out.archived += 1;
    });
    return out;
  }

  function transcriptEvidenceFromLibraryRow(row) {
    var snapshotId = cleanString(row && (row.lastSnapshotId || row.snapshotId || row.snapshot_id || row.latestSnapshotId));
    var messageCount = numericCount(row && row.messageCount);
    var turnCount = numericCount(row && row.turnCount);
    var userTurnCount = numericCount(row && row.userTurnCount);
    var assistantTurnCount = numericCount(row && row.assistantTurnCount);
    var snapshotCount = snapshotId ? Math.max(numericCount(row && row.snapshotCount), 1) : (messageCount || turnCount || userTurnCount || assistantTurnCount ? numericCount(row && row.snapshotCount) : 0);
    return {
      snapshotId: snapshotId,
      lastSnapshotId: snapshotId,
      latestSnapshotId: snapshotId,
      snapshotCount: snapshotCount,
      messageCount: messageCount,
      turnCount: turnCount,
      userTurnCount: userTurnCount,
      assistantTurnCount: assistantTurnCount,
      answerCount: numericCount(row && row.answerCount)
    };
  }

  function snapshotPayloadHasContent(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (Array.isArray(snapshot.messages) && snapshot.messages.length > 0) return true;
    var meta = snapshot.meta && typeof snapshot.meta === 'object' ? snapshot.meta : {};
    return Array.isArray(meta.richTurns) && meta.richTurns.length > 0;
  }

  function chatHasSnapshotPayload(chat, snapshotId) {
    var sid = cleanString(snapshotId);
    if (!sid) return false;
    var snapshots = Array.isArray(chat && chat.snapshots) ? chat.snapshots : [];
    return snapshots.some(function (snapshot) {
      return cleanString(snapshot && (snapshot.snapshotId || snapshot.id)) === sid
        && snapshotPayloadHasContent(snapshot);
    });
  }

  function snapshotBundlePayloadFromLoaded(loaded, evidence, row) {
    var snapshotId = cleanString((loaded && loaded.snapshotId) || (evidence && evidence.snapshotId));
    if (!snapshotId) return null;
    var messages = Array.isArray(loaded && loaded.messages) ? loaded.messages : [];
    var loadedMeta = loaded && loaded.meta && typeof loaded.meta === 'object' ? loaded.meta : {};
    var title = friendlyShellTitle(titleCandidatesFromLibraryRow(row), rowId(row), 'Imported chat');
    var meta = Object.assign({}, loadedMeta);
    if (!cleanString(meta.title) && title) meta.title = title;
    if (!cleanString(meta.displayTitle) && title) meta.displayTitle = title;
    if (!cleanString(meta.sourceTitle) && title) meta.sourceTitle = title;
    if (!cleanString(meta.pageTitle) && title) meta.pageTitle = title;
    if (!cleanString(meta.chatTitle) && title) meta.chatTitle = title;
    if (!cleanString(meta.originalTitle) && title) meta.originalTitle = title;
    return {
      snapshotId: snapshotId,
      createdAt: cleanString(loaded && loaded.createdAt) || cleanString(row && (row.updatedAt || row.savedAt || row.createdAt)),
      schemaVersion: Number((loaded && loaded.schemaVersion) || 1) || 1,
      messageCount: numericCount(loaded && loaded.messageCount) || numericCount(evidence && evidence.messageCount) || messages.length,
      digest: cleanString(loaded && loaded.digest),
      meta: meta,
      messages: messages
    };
  }

  function nativeSnapshotPayloadRequestsFromRows(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var out = [];
    var seen = Object.create(null);
    list.forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      if (rowPayloadClass(row) !== 'native-save-to-folder') return;
      if (!isSavedRow(row) || !hasRealTranscriptEvidence(row)) return;
      var evidence = transcriptEvidenceFromLibraryRow(row);
      var snapshotId = cleanString(evidence && evidence.snapshotId);
      var chatId = rowId(row);
      var key = snapshotId || chatId;
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push({
        requestId: 'chrome-export-native-payload-' + Date.now() + '-' + out.length,
        chatId: chatId,
        snapshotId: snapshotId,
        title: friendlyShellTitle(titleCandidatesFromLibraryRow(row), chatId, ''),
        href: cleanString(row && (row.href || row.url || row.sourceUrl)),
        folderId: cleanString(row && (row.folderId || row.folder_id)),
        messageCount: numericCount(evidence.messageCount),
        turnCount: numericCount(evidence.turnCount),
        userTurnCount: numericCount(evidence.userTurnCount),
        assistantTurnCount: numericCount(evidence.assistantTurnCount),
        answerCount: numericCount(evidence.answerCount)
      });
    });
    return out.slice(0, 12);
  }

  async function refreshNativeSnapshotPayloadsBeforeExport(reason) {
    var summary = {
      attempted: false,
      ok: true,
      reason: String(reason || ''),
      refreshCalled: false,
      waitCalled: false,
      requestCalled: false,
      requestedCount: 0,
      requestStatus: '',
      requestVerifiedCount: 0,
      requestListenerReached: false,
      requestResponseCount: 0,
      requestForwardedCount: 0,
      status: 'not-available',
      error: '',
    };
    try {
      var sync = global.H2O && global.H2O.Library && global.H2O.Library.Sync;
      if (!sync || (typeof sync.refreshNativeSnapshotPayloads !== 'function' && typeof sync.refreshNativeBroadcast !== 'function')) {
        state.lastNativeSnapshotPayloadPreflight = summary;
        return summary;
      }
      summary.attempted = true;
      summary.status = 'started';
      if (typeof sync.requestNativeSnapshotPayloads === 'function') {
        var requests = nativeSnapshotPayloadRequestsFromRows(getLibraryIndexRows() || []);
        summary.requestedCount = requests.length;
        if (requests.length) {
          summary.requestCalled = true;
          var requestResult = await sync.requestNativeSnapshotPayloads(requests, {
            reason: 'chrome-export-native-snapshot-payload-request:' + String(reason || 'manual')
          });
          summary.requestStatus = String(requestResult && requestResult.status || '');
          summary.requestVerifiedCount = Number(requestResult && requestResult.verifiedCount || 0) || 0;
          summary.requestListenerReached = requestResult && requestResult.listenerReached === true;
          summary.requestResponseCount = Number(requestResult && requestResult.responseCount || 0) || 0;
          summary.requestForwardedCount = Number(requestResult && requestResult.forwardedCount || 0) || 0;
        }
      }
      if (typeof sync.refreshNativeSnapshotPayloads === 'function') {
        summary.refreshCalled = true;
        await sync.refreshNativeSnapshotPayloads('chrome-export-preflight:' + String(reason || 'manual'));
      } else if (typeof sync.refreshNativeBroadcast === 'function') {
        summary.refreshCalled = true;
        await sync.refreshNativeBroadcast('chrome-export-preflight:' + String(reason || 'manual'));
      }
      if (typeof sync.waitForNativeSnapshotPayloadMaterialization === 'function') {
        summary.waitCalled = true;
        await sync.waitForNativeSnapshotPayloadMaterialization();
      }
      summary.status = 'completed';
    } catch (e) {
      summary.ok = false;
      summary.status = 'error';
      summary.error = String(e && (e.message || e) || 'native-snapshot-payload-preflight-error');
      pushError('native-snapshot-payload-preflight', e);
    }
    state.lastNativeSnapshotPayloadPreflight = summary;
    return summary;
  }

  async function hydrateSnapshotPayloadForRow(row, evidence) {
    var snapshotId = cleanString(evidence && evidence.snapshotId);
    var chatId = rowId(row);
    if (!snapshotId) {
      return {
        ok: false,
        payload: null,
        reason: 'snapshot-id-missing',
        loadSnapshotStatus: 'snapshot-id-missing',
        archiveIndexHasSnapshotId: false,
        archiveSnapshotCount: 0
      };
    }
    try {
      var loaded = await callArchive('loadSnapshot', { snapshotId: snapshotId });
      var payload = snapshotBundlePayloadFromLoaded(loaded, evidence, row);
      if (snapshotPayloadHasContent(payload)) {
        return {
          ok: true,
          payload: payload,
          reason: '',
          loadSnapshotStatus: 'loaded-by-snapshot-id',
          archiveIndexHasSnapshotId: true,
          archiveSnapshotCount: 0
        };
      }
      var headers = [];
      if (chatId) {
        try {
          var listed = await callArchive('listSnapshots', { chatId: chatId });
          headers = Array.isArray(listed) ? listed : [];
        } catch (listErr) {
          pushError('hydrateSnapshotPayloadForRow.listSnapshots', listErr);
        }
      }
      var archiveIndexHasSnapshotId = headers.some(function (header) {
        return cleanString(header && header.snapshotId) === snapshotId;
      });
      var latestSnapshotId = '';
      for (var h = 0; h < headers.length; h += 1) {
        latestSnapshotId = cleanString(headers[h] && headers[h].snapshotId);
        if (latestSnapshotId) break;
      }
      if (latestSnapshotId && latestSnapshotId !== snapshotId) {
        try {
          var latestLoaded = await callArchive('loadSnapshot', { snapshotId: latestSnapshotId });
          var repairedEvidence = Object.assign({}, evidence, {
            snapshotId: latestSnapshotId,
            lastSnapshotId: latestSnapshotId,
            latestSnapshotId: latestSnapshotId
          });
          var latestPayload = snapshotBundlePayloadFromLoaded(latestLoaded, repairedEvidence, row);
          if (snapshotPayloadHasContent(latestPayload)) {
            return {
              ok: true,
              payload: latestPayload,
              reason: '',
              loadSnapshotStatus: 'repaired-from-latest-snapshot',
              archiveIndexHasSnapshotId: archiveIndexHasSnapshotId,
              archiveSnapshotCount: headers.length,
              repairedFromSnapshotIdHash: redactedHash(snapshotId),
              repairedToSnapshotIdHash: redactedHash(latestSnapshotId)
            };
          }
        } catch (latestErr) {
          pushError('hydrateSnapshotPayloadForRow.loadLatestCandidate', latestErr);
        }
      }
      return {
        ok: false,
        payload: null,
        reason: headers.length === 0
          ? 'archive-index-empty'
          : (archiveIndexHasSnapshotId ? 'loadSnapshot-empty-payload' : 'archive-index-missing-snapshot-id'),
        loadSnapshotStatus: loaded ? 'empty-payload' : 'loadSnapshot-not-found',
        archiveIndexHasSnapshotId: archiveIndexHasSnapshotId,
        archiveSnapshotCount: headers.length
      };
    } catch (e) {
      pushError('hydrateSnapshotPayloadForRow', e);
      return {
        ok: false,
        payload: null,
        reason: 'loadSnapshot-error',
        loadSnapshotStatus: 'loadSnapshot-error',
        archiveIndexHasSnapshotId: false,
        archiveSnapshotCount: 0
      };
    }
  }

  function recordSnapshotPayloadMiss(payloadStats, row, evidence, hydrateResult, decision) {
    var result = hydrateResult && typeof hydrateResult === 'object' ? hydrateResult : {};
    var reason = cleanString(result.reason) || 'snapshot-payload-missing';
    incrementCount(payloadStats.missingSnapshotReasons, reason);
    incrementCount(payloadStats.missingSnapshotClasses, rowPayloadClass(row));
    if (payloadStats.missingSnapshotDetails.length < 10) {
      payloadStats.missingSnapshotDetails.push({
        rowClass: rowPayloadClass(row),
        rowSource: rowSourceKind(row),
        hasSnapshotId: !!cleanString(evidence && evidence.snapshotId),
        snapshotIdHash: redactedHash(evidence && evidence.snapshotId),
        chatIdHash: redactedHash(rowId(row)),
        loadSnapshotStatus: cleanString(result.loadSnapshotStatus || reason),
        archiveIndexHasSnapshotId: result.archiveIndexHasSnapshotId === true,
        archiveSnapshotCount: Number(result.archiveSnapshotCount || 0),
        decision: decision || 'block-export'
      });
    }
  }

  function downgradeProjectedChatForMissingPayload(projected, row, evidence, reason) {
    var id = rowId(row);
    var title = friendlyShellTitle(titleCandidatesFromLibraryRow(row), id, 'Imported chat');
    var href = cleanString(row && (row.href || row.url || row.sourceUrl || row.linkSourceHref || row.normalizedHref))
      || (id ? 'https://chatgpt.com/c/' + id : '');
    var next = cloneJson(projected) || {};
    var existingIndex = next.chatIndex && typeof next.chatIndex === 'object' && !Array.isArray(next.chatIndex)
      ? next.chatIndex : {};
    var existingState = existingIndex.state && typeof existingIndex.state === 'object' ? existingIndex.state : {};
    var existingMeta = existingIndex.meta && typeof existingIndex.meta === 'object' ? existingIndex.meta : {};
    var existingOrg = existingIndex.organization && typeof existingIndex.organization === 'object' ? existingIndex.organization : {};
    var snapshotId = cleanString(evidence && evidence.snapshotId);
    var sourceEvidence = {
      sourceSnapshotId: snapshotId,
      sourceLastSnapshotId: cleanString(evidence && evidence.lastSnapshotId),
      sourceSnapshotCount: numericCount(evidence && evidence.snapshotCount),
      sourceMessageCount: numericCount(evidence && evidence.messageCount),
      sourceTurnCount: numericCount(evidence && evidence.turnCount),
      sourceUserTurnCount: numericCount(evidence && evidence.userTurnCount),
      sourceAssistantTurnCount: numericCount(evidence && evidence.assistantTurnCount),
      sourceAnswerCount: numericCount(evidence && evidence.answerCount),
      f19SnapshotPayloadMissing: true,
      f19SnapshotPayloadDowngraded: true,
      f19SnapshotPayloadDowngradeReason: cleanString(reason) || 'snapshot-payload-missing'
    };
    next.snapshotId = '';
    next.lastSnapshotId = '';
    next.latestSnapshotId = '';
    next.snapshotCount = 0;
    next.messageCount = 0;
    next.turnCount = 0;
    next.userTurnCount = 0;
    next.assistantTurnCount = 0;
    next.answerCount = 0;
    next.snapshots = [];
    next.chatIndex = Object.assign({}, existingIndex, sourceEvidence, {
      id: id || cleanString(existingIndex.id),
      chatId: id || cleanString(existingIndex.chatId),
      title: title,
      displayTitle: title,
      sourceTitle: cleanString(existingIndex.sourceTitle) || title,
      pageTitle: cleanString(existingIndex.pageTitle) || title,
      chatTitle: cleanString(existingIndex.chatTitle) || title,
      originalTitle: cleanString(existingIndex.originalTitle) || title,
      href: href || cleanString(existingIndex.href),
      view: 'linked',
      displayView: 'link',
      badgeKind: 'Link',
      readerKind: 'placeholder',
      sourceView: cleanString(existingIndex.sourceView || existingIndex.originalView || existingIndex.rawView || existingIndex.view || 'saved'),
      originalView: cleanString(existingIndex.originalView || existingIndex.sourceView || existingIndex.rawView || existingIndex.view || 'saved'),
      rawView: cleanString(existingIndex.rawView || existingIndex.sourceView || existingIndex.originalView || existingIndex.view || 'saved'),
      sourceIsSaved: existingIndex.sourceIsSaved === false ? false : true,
      sourceIsLinked: existingIndex.sourceIsLinked === true || existingState.isLinked === true,
      snapshotId: '',
      lastSnapshotId: '',
      latestSnapshotId: '',
      snapshotCount: 0,
      messageCount: 0,
      turnCount: 0,
      userTurnCount: 0,
      assistantTurnCount: 0,
      answerCount: 0,
      state: Object.assign({}, existingState, {
        isSaved: false,
        isLinked: true,
        isImported: existingState.isImported === true || isImportedRow(row),
        isDeleted: false
      }),
      organization: Object.assign({}, existingOrg, {
        folderId: cleanString(existingOrg.folderId || existingOrg.folder_id || row && (row.folderId || row.folder_id))
      }),
      linkSourceHref: cleanString(existingIndex.linkSourceHref || href),
      meta: Object.assign({}, existingMeta, {
        title: title,
        displayTitle: title,
        sourceTitle: cleanString(existingMeta.sourceTitle) || title,
        pageTitle: cleanString(existingMeta.pageTitle) || title,
        chatTitle: cleanString(existingMeta.chatTitle) || title,
        originalTitle: cleanString(existingMeta.originalTitle) || title
      }, sourceEvidence, {
        snapshotId: '',
        lastSnapshotId: '',
        latestSnapshotId: '',
        snapshotCount: 0,
        messageCount: 0,
        turnCount: 0,
        userTurnCount: 0,
        assistantTurnCount: 0,
        answerCount: 0
      })
    });
    return next;
  }

  async function ensureSnapshotPayloadForProjectedChat(projected, row, payloadStats) {
    var evidence = transcriptEvidenceFromLibraryRow(row);
    var snapshotId = cleanString(evidence.snapshotId);
    if (!snapshotId || !isSavedRow(row) || !hasRealTranscriptEvidence(row)) return projected;
    payloadStats.required += 1;
    if (chatHasSnapshotPayload(projected, snapshotId)) {
      payloadStats.present += 1;
      return projected;
    }
    var hydrated = await hydrateSnapshotPayloadForRow(row, evidence);
    if (!hydrated || !hydrated.ok || !hydrated.payload) {
      payloadStats.hydrationMiss += 1;
      recordSnapshotPayloadMiss(payloadStats, row, evidence, hydrated, 'downgrade-to-metadata-only');
      payloadStats.downgraded += 1;
      return downgradeProjectedChatForMissingPayload(projected, row, evidence, hydrated && hydrated.reason);
    }
    var payload = hydrated.payload;
    if (cleanString(hydrated.loadSnapshotStatus) === 'repaired-from-latest-snapshot') {
      payloadStats.repaired += 1;
      snapshotId = cleanString(payload && payload.snapshotId) || snapshotId;
    }
    if (snapshotId) {
      var payloadMessageCount = numericCount(payload && payload.messageCount) || numericCount(evidence.messageCount);
      projected.snapshotId = snapshotId;
      projected.lastSnapshotId = snapshotId;
      projected.latestSnapshotId = snapshotId;
      projected.snapshotCount = Math.max(numericCount(evidence.snapshotCount), 1);
      projected.messageCount = payloadMessageCount;
      projected.turnCount = numericCount(evidence.turnCount);
      projected.userTurnCount = numericCount(evidence.userTurnCount);
      projected.assistantTurnCount = numericCount(evidence.assistantTurnCount);
      projected.answerCount = numericCount(evidence.answerCount);
      projected.chatIndex = projected.chatIndex && typeof projected.chatIndex === 'object'
        ? projected.chatIndex : {};
      projected.chatIndex.snapshotId = snapshotId;
      projected.chatIndex.lastSnapshotId = snapshotId;
      projected.chatIndex.latestSnapshotId = snapshotId;
      projected.chatIndex.snapshotCount = Math.max(numericCount(evidence.snapshotCount), 1);
      projected.chatIndex.messageCount = payloadMessageCount;
      projected.chatIndex.turnCount = numericCount(evidence.turnCount);
      projected.chatIndex.userTurnCount = numericCount(evidence.userTurnCount);
      projected.chatIndex.assistantTurnCount = numericCount(evidence.assistantTurnCount);
      projected.chatIndex.answerCount = numericCount(evidence.answerCount);
      projected.chatIndex.meta = projected.chatIndex.meta && typeof projected.chatIndex.meta === 'object'
        ? projected.chatIndex.meta : {};
      projected.chatIndex.meta.snapshotId = snapshotId;
      projected.chatIndex.meta.lastSnapshotId = snapshotId;
      projected.chatIndex.meta.latestSnapshotId = snapshotId;
      projected.chatIndex.meta.snapshotCount = Math.max(numericCount(evidence.snapshotCount), 1);
      projected.chatIndex.meta.messageCount = payloadMessageCount;
      projected.chatIndex.meta.turnCount = numericCount(evidence.turnCount);
      projected.chatIndex.meta.userTurnCount = numericCount(evidence.userTurnCount);
      projected.chatIndex.meta.assistantTurnCount = numericCount(evidence.assistantTurnCount);
      projected.chatIndex.meta.answerCount = numericCount(evidence.answerCount);
    }
    projected.snapshots = Array.isArray(projected.snapshots) ? projected.snapshots.slice() : [];
    var replaced = false;
    for (var i = 0; i < projected.snapshots.length; i += 1) {
      if (cleanString(projected.snapshots[i] && (projected.snapshots[i].snapshotId || projected.snapshots[i].id)) === snapshotId) {
        projected.snapshots[i] = Object.assign({}, projected.snapshots[i], payload);
        replaced = true;
        break;
      }
    }
    if (!replaced) projected.snapshots.push(payload);
    payloadStats.hydrated += 1;
    return projected;
  }

  function buildMinimalChatFromLibraryRow(row) {
    var id = rowId(row);
    if (!id) return null;
    var saved = isSavedRow(row);
    var linked = isLinkedRow(row);
    var archived = isArchivedRow(row);
    var imported = !saved && !linked && !archived && isImportedRow(row);
    var pinned = isPinnedRow(row);
    var title = friendlyShellTitle(titleCandidatesFromLibraryRow(row), id, linked && !saved ? 'Link' : 'Imported chat');
    var href = cleanString(row && (row.href || row.linkSourceHref || row.normalizedHref))
      || ('https://chatgpt.com/c/' + id);
    var view = linked && !saved ? 'linked' : (archived ? 'archived' : (imported ? 'imported' : 'saved'));
    var displayView = linked && !saved ? 'link' : view;
    var evidence = transcriptEvidenceFromLibraryRow(row);
    return {
      chatId: id,
      bootMode: linked && !saved ? 'linked' : (imported ? 'imported' : 'saved'),
      snapshotId: evidence.snapshotId,
      lastSnapshotId: evidence.lastSnapshotId,
      latestSnapshotId: evidence.latestSnapshotId,
      snapshotCount: evidence.snapshotCount,
      messageCount: evidence.messageCount,
      turnCount: evidence.turnCount,
      userTurnCount: evidence.userTurnCount,
      assistantTurnCount: evidence.assistantTurnCount,
      answerCount: evidence.answerCount,
      chatIndex: {
        id: id,
        chatId: id,
        title: title,
        displayTitle: title,
        sourceTitle: title,
        pageTitle: title,
        chatTitle: title,
        originalTitle: title,
        href: href,
        view: view,
        displayView: displayView,
        badgeKind: saved ? 'Saved' : (linked ? 'Link' : (archived ? 'Archive' : 'Imported')),
        readerKind: saved && hasRealTranscriptEvidence(row) ? 'reader' : 'placeholder',
        sourceView: cleanString(row && (row.sourceView || row.originalView || row.rawView || row.view)),
        originalView: cleanString(row && (row.originalView || row.sourceView || row.rawView || row.view)),
        rawView: cleanString(row && (row.rawView || row.sourceView || row.originalView || row.view)),
        sourceIsSaved: boolValue(row && (row.sourceIsSaved || row.isSaved)),
        sourceIsLinked: boolValue(row && (row.sourceIsLinked || row.isLinked)),
        snapshotId: evidence.snapshotId,
        lastSnapshotId: evidence.lastSnapshotId,
        latestSnapshotId: evidence.latestSnapshotId,
        snapshotCount: evidence.snapshotCount,
        messageCount: evidence.messageCount,
        turnCount: evidence.turnCount,
        userTurnCount: evidence.userTurnCount,
        assistantTurnCount: evidence.assistantTurnCount,
        answerCount: evidence.answerCount,
        state: {
          isSaved: saved,
          isLinked: linked,
          isImported: imported,
          isPinned: pinned,
          isArchived: archived,
          isDeleted: false
        },
        organization: {
          categoryId: cleanString(row && row.categoryId),
          folderId: cleanString(row && (row.folderId || row.folder_id))
        },
        linkSourceHref: cleanString(row && (row.linkSourceHref || row.normalizedHref || href)),
        linkedFrom: cleanString(row && row.linkedFrom),
        linkedAt: cleanString(row && row.linkedAt),
        f19MinimalLibraryIndexRow: true,
        meta: {
          title: title,
          displayTitle: title,
          sourceTitle: title,
          pageTitle: title,
          chatTitle: title,
          originalTitle: title,
          snapshotId: evidence.snapshotId,
          lastSnapshotId: evidence.lastSnapshotId,
          snapshotCount: evidence.snapshotCount,
          messageCount: evidence.messageCount,
          turnCount: evidence.turnCount,
          userTurnCount: evidence.userTurnCount,
          assistantTurnCount: evidence.assistantTurnCount,
          answerCount: evidence.answerCount
        }
      },
      migrated: false,
      snapshots: []
    };
  }

  function cloneJson(value) {
    if (typeof value === 'undefined') return undefined;
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { return null; }
  }

  function projectArchiveChatToLibraryRow(chat, row) {
    var projected = cloneJson(chat) || {};
    var minimal = buildMinimalChatFromLibraryRow(row);
    if (!minimal) return null;
    var existingIndex = projected.chatIndex && typeof projected.chatIndex === 'object' && !Array.isArray(projected.chatIndex)
      ? projected.chatIndex : {};
    projected.chatId = minimal.chatId;
    projected.chatIndex = Object.assign({}, existingIndex, minimal.chatIndex, {
      state: Object.assign({}, existingIndex.state || {}, minimal.chatIndex.state),
      organization: Object.assign({}, existingIndex.organization || {}, minimal.chatIndex.organization),
      f19LibraryIndexProjectedRow: true,
      f19MinimalLibraryIndexRow: existingIndex.f19MinimalLibraryIndexRow === true || false
    });
    if (!Array.isArray(projected.snapshots)) projected.snapshots = [];
    return projected;
  }

  function buildCoverageObject(snapshotRows, bundleChats, originalChatCount, missingRows, addedRows, unexportableRows, unindexedManifest, payloadStats) {
    payloadStats = payloadStats && typeof payloadStats === 'object' ? payloadStats : {};
    unindexedManifest = unindexedManifest && typeof unindexedManifest === 'object' ? unindexedManifest : buildUnindexedArchiveManifest([], {});
    var snapshotCounts = countSnapshotRows(snapshotRows);
    var bundleCounts = countBundleViews(bundleChats);
    var missingTypeCounts = makeMissingRowTypeCounts(missingRows);
    var snapshotClassCounts = makeExportClassCounts(snapshotRows);
    var addedMinimalClassCounts = makeExportClassCounts(addedRows);
    var unexportableClassCounts = makeExportClassCounts(unexportableRows);
    var downgradedCount = Number(payloadStats.downgraded || 0);
    var expectedSaved = Math.max(0, snapshotCounts.saved - downgradedCount);
    var expectedLinked = snapshotCounts.linked + downgradedCount;
    var blockers = [];
    var warnings = [];
    if (addedRows.length > 0) warnings.push(EXPORT_COVERAGE_MINIMAL_ROWS);
    if (downgradedCount > 0) warnings.push(EXPORT_SNAPSHOT_PAYLOAD_DOWNGRADED);
    if (Number(payloadStats.missing || 0) > 0) blockers.push(EXPORT_SNAPSHOT_PAYLOAD_MISSING);
    if (unexportableRows.length > 0
        || snapshotCounts.total !== bundleChats.length
        || expectedSaved !== bundleCounts.saved
        || expectedLinked !== bundleCounts.linked
        || snapshotCounts.pinned !== bundleCounts.pinned
        || snapshotCounts.archived !== bundleCounts.archived) {
      blockers.push(EXPORT_COVERAGE_MISMATCH);
    }
    return {
      schema: EXPORT_COVERAGE_SCHEMA,
      ok: blockers.length === 0,
      sourcePolicy: 'library-index-supported-rows',
      snapshotTotal: snapshotCounts.total,
      snapshotSaved: snapshotCounts.saved,
      snapshotLinked: snapshotCounts.linked,
      snapshotPinned: snapshotCounts.pinned,
      snapshotArchived: snapshotCounts.archived,
      bundleOriginalChatCount: originalChatCount,
      bundleChatCount: bundleChats.length,
      bundleSavedCount: bundleCounts.saved,
      bundleLinkedCount: bundleCounts.linked,
      bundlePinnedCount: bundleCounts.pinned,
      bundleArchivedCount: bundleCounts.archived,
      missingRowCount: missingRows.length,
      addedMinimalRowCount: addedRows.length,
      unindexedArchiveRowCount: Number(unindexedManifest.count || 0) || 0,
      unindexedRowManifestCount: Array.isArray(unindexedManifest.rows) ? unindexedManifest.rows.length : 0,
      unindexedRowReasonCounts: Object.assign({}, unindexedManifest.reasonCounts || {}),
      unindexedRows: Array.isArray(unindexedManifest.rows) ? unindexedManifest.rows.slice(0, 50) : [],
      unexportableRowCount: unexportableRows.length,
      snapshotPayloadRequiredCount: Number(payloadStats.required || 0),
      snapshotPayloadPresentCount: Number(payloadStats.present || 0),
      snapshotPayloadHydratedCount: Number(payloadStats.hydrated || 0),
      snapshotPayloadRepairedCount: Number(payloadStats.repaired || 0),
      snapshotPayloadHydrationMissCount: Number(payloadStats.hydrationMiss || 0),
      snapshotPayloadDowngradedCount: downgradedCount,
      snapshotPayloadMissingCount: Number(payloadStats.missing || 0),
      readerReadyPayloadMissingCount: Number(payloadStats.missing || 0),
      missingSnapshotClasses: Object.assign({}, payloadStats.missingSnapshotClasses || {}),
      missingSnapshotReasons: Object.assign({}, payloadStats.missingSnapshotReasons || {}),
      missingSnapshotDetails: (payloadStats.missingSnapshotDetails || []).slice(0, 10),
      effectiveSnapshotSaved: expectedSaved,
      effectiveSnapshotLinked: expectedLinked,
      missingRowTypeCounts: missingTypeCounts,
      snapshotExportClassCounts: snapshotClassCounts,
      addedMinimalRowTypeCounts: addedMinimalClassCounts,
      unexportableRowTypeCounts: unexportableClassCounts,
      supportedRowsRepresented: snapshotCounts.total === bundleChats.length,
      supportedStateRepresented: expectedSaved === bundleCounts.saved
        && expectedLinked === bundleCounts.linked
        && snapshotCounts.pinned === bundleCounts.pinned
        && snapshotCounts.archived === bundleCounts.archived,
      coverageDecision: blockers.length === 0
        ? (downgradedCount > 0 ? 'allow-export-with-metadata-only-downgrade' : 'allow-export')
        : 'block-export',
      blockers: blockers,
      warnings: warnings,
      privacy: {
        redacted: true,
        rawIdsReturned: false,
        rawTitlesReturned: false,
        rawContentReturned: false
      }
    };
  }

  async function alignBundleToLibraryIndex(bundle) {
    var rows = getLibraryIndexRows();
    if (!rows) {
      return {
        bundle: bundle,
        coverage: {
          schema: EXPORT_COVERAGE_SCHEMA,
          ok: false,
          sourcePolicy: 'library-index-supported-rows',
          snapshotTotal: 0,
          snapshotSaved: 0,
          snapshotLinked: 0,
          snapshotPinned: 0,
          snapshotArchived: 0,
          bundleOriginalChatCount: 0,
          bundleChatCount: 0,
          unindexedArchiveRowCount: 0,
          unindexedRowManifestCount: 0,
          unindexedRowReasonCounts: {},
          unindexedRows: [],
          bundleSavedCount: 0,
          bundleLinkedCount: 0,
          bundlePinnedCount: 0,
          bundleArchivedCount: 0,
          missingRowCount: 0,
          addedMinimalRowCount: 0,
          unexportableRowCount: 0,
          missingRowTypeCounts: makeMissingRowTypeCounts([]),
          blockers: [EXPORT_COVERAGE_UNAVAILABLE],
          warnings: [],
          privacy: { redacted: true, rawIdsReturned: false, rawTitlesReturned: false, rawContentReturned: false }
        }
      };
    }

    var chatArchive = ensureBundleChatArchive(bundle);
    var archiveChats = chatArchive.chats.slice();
    var originalChatCount = archiveChats.length;
    var archiveByKey = Object.create(null);
    archiveChats.forEach(function (chat, index) {
      bundleChatIdentityKeys(chat).forEach(function (key) {
        if (!archiveByKey[key]) archiveByKey[key] = { chat: chat, index: index };
      });
    });

    var missingRows = [];
    var addedRows = [];
    var unexportableRows = [];
    var payloadStats = {
      required: 0,
      present: 0,
      hydrated: 0,
      repaired: 0,
      hydrationMiss: 0,
      downgraded: 0,
      missing: 0,
      missingSnapshotClasses: Object.create(null),
      missingSnapshotReasons: Object.create(null),
      missingSnapshotDetails: []
    };
    var usedArchiveIndexes = Object.create(null);
    var projectedChats = [];
    for (var r = 0; r < rows.length; r += 1) {
      var row = rows[r];
      var id = rowId(row);
      if (!id) {
        unexportableRows.push(row);
        continue;
      }
      var matched = null;
      var keys = libraryRowIdentityKeys(row);
      for (var k = 0; k < keys.length; k += 1) {
        var candidate = archiveByKey[keys[k]];
        if (candidate && !usedArchiveIndexes[candidate.index]) {
          matched = candidate;
          break;
        }
      }
      if (matched) {
        var projected = projectArchiveChatToLibraryRow(matched.chat, row);
        if (!projected) {
          unexportableRows.push(row);
          continue;
        }
        projected = await ensureSnapshotPayloadForProjectedChat(projected, row, payloadStats);
        projectedChats.push(projected);
        usedArchiveIndexes[matched.index] = true;
        continue;
      }

      var minimal = buildMinimalChatFromLibraryRow(row);
      if (!minimal) {
        unexportableRows.push(row);
        continue;
      }
      minimal = await ensureSnapshotPayloadForProjectedChat(minimal, row, payloadStats);
      missingRows.push(row);
      projectedChats.push(minimal);
      addedRows.push(row);
    }

    var unindexedManifest = buildUnindexedArchiveManifest(archiveChats, usedArchiveIndexes);
    chatArchive.chats = projectedChats;

    chatArchive.chatCount = chatArchive.chats.length;
    bundle.summary = bundle.summary && typeof bundle.summary === 'object' && !Array.isArray(bundle.summary)
      ? bundle.summary : {};
    bundle.diagnostics = bundle.diagnostics && typeof bundle.diagnostics === 'object' && !Array.isArray(bundle.diagnostics)
      ? bundle.diagnostics : {};
    var coverage = buildCoverageObject(rows, chatArchive.chats, originalChatCount, missingRows, addedRows, unexportableRows, unindexedManifest, payloadStats);
    bundle.summary.chatCount = chatArchive.chats.length;
    bundle.summary.unindexedArchiveRowCount = coverage.unindexedArchiveRowCount;
    bundle.summary.unindexedRowManifestCount = coverage.unindexedRowManifestCount;
    bundle.summary.f19ChromeExportCoverageOk = coverage.ok === true;
    bundle.diagnostics.unindexedRows = unindexedManifest.rows.slice(0, 50);
    bundle.diagnostics.unindexedRowManifest = unindexedManifest;
    bundle.diagnostics.chromeExportCoverage = coverage;
    return { bundle: bundle, coverage: coverage };
  }

  /* ── Atomic-ish file write: write to .tmp, rename to final ────────── */
  /* FileSystemFileHandle.move() handles the rename atomically when the
   * browser supports it (Chromium 110+). When unavailable, fall back to
   * write-final + delete-tmp, which is non-atomic but matches the R3
   * gate's "atomic-ish from Desktop's perspective" — Desktop's scanNow
   * skips files with browser-partial-suffix extensions including .tmp,
   * so an interrupted write leaves a .tmp that Desktop will ignore. */
  async function writeBundleAtomic(dirHandle, json) {
    var bytes = json.length;
    /* 1. Write to .tmp. */
    var tmpHandle = await dirHandle.getFileHandle(CHROME_FILE_TMP, { create: true });
    var writable = await tmpHandle.createWritable();
    try {
      await writable.write(json);
    } finally {
      await writable.close();
    }
    /* 2. Rename .tmp → final. */
    if (typeof tmpHandle.move === 'function') {
      try {
        await tmpHandle.move(CHROME_FILE);
        return { bytes: bytes, atomicMethod: 'move' };
      } catch (e) {
        pushError('move', e);
        /* fall through to copy+delete */
      }
    }
    /* 3. Fallback: write final, then delete .tmp. */
    var finalHandle = await dirHandle.getFileHandle(CHROME_FILE, { create: true });
    var finalWritable = await finalHandle.createWritable();
    try {
      await finalWritable.write(json);
    } finally {
      await finalWritable.close();
    }
    try { await dirHandle.removeEntry(CHROME_FILE_TMP); }
    catch (e) { pushError('removeEntry.tmp', e); /* benign */ }
    return { bytes: bytes, atomicMethod: 'copy-then-delete' };
  }

  /* ── exportNow — the only write entry point ───────────────────────── */
  /*
   * O1-T19. Consulted before the flag gate, because a manual user gesture is
   * exactly the path that must NOT bypass generation authority: after the
   * standdown P01 no longer owns the data, and a button press does not change
   * who owns it.
   */
  async function generationPermitsP01Mutation() {
    var root = (typeof globalThis !== 'undefined' ? globalThis : this);
    var gate = root.H2O && root.H2O.Studio && root.H2O.Studio.sync &&
      root.H2O.Studio.sync.writerGeneration;
    if (!gate || typeof gate.p01MayMutate !== 'function') {
      /*
       * No gate surface at all: a pre-T19 runtime, and the compatibility
       * position is that P01 behaves exactly as it did before. This is a
       * statement about the BUILD, not the store - once a gate is installed
       * its observation governs, and an unreadable STORE still refuses.
       */
      return { permitted: true, reason: null };
    }
    try { return await gate.p01MayMutate(); }
    catch (_) { return { permitted: false, reason: 'generation-unobserved' }; }
  }

  function p01MutationAdmissionSurface() {
    var root = (typeof globalThis !== 'undefined' ? globalThis : this);
    var admission = root.H2O && root.H2O.Studio && root.H2O.Studio.sync &&
      root.H2O.Studio.sync.p01MutationAdmission;
    return admission && typeof admission.run === 'function'
      ? admission
      : null;
  }

  async function exportNowWithP01Admission(options) {
    var admission = p01MutationAdmissionSurface();
    if (!admission) {
      return {
        ok: false,
        skipped: true,
        reason: 'p01-mutation-admission-serialization-unavailable',
        generation: null
      };
    }
    try {
      return await admission.run({
        label: 'chrome-export-auto-import',
        generationCheck: generationPermitsP01Mutation,
        operation: function () { return exportNow(options); }
      });
    } catch (error) {
      return {
        ok: false,
        skipped: true,
        reason: String(error?.code || error?.message ||
          'p01-mutation-admission-serialization-unavailable'),
        generation: null
      };
    }
  }

  async function exportNow(options) {
    var opts = (options && typeof options === 'object') ? options : {};
    var reason = String(opts.reason || 'manual');
    var startedAt = nowIso();
    var exportPath = chromeExportPath('');
    var folderAutoSync = isFolderAutoSyncExport(opts);
    var writeGate = diagnoseChromeExportWriteGate();

    /* (1) Flag gate. */
    if (!flagEnabled() && !folderAutoSync) {
      var s1 = Object.assign({
        ok: false,
        reason: reason,
        startedAt: startedAt,
        completedAt: nowIso(),
        filename: '',
        transport: CHROME_FILE,
        direction: 'chrome-to-desktop',
        chromeWritesSyncFolder: false,
        path: exportPath,
        bytes: 0,
        flagEnabled: false,
        exportWriteGate: writeGate,
        blockers: ['chrome-export-flag-off'],
        status: 'chrome-to-desktop-export-flag-off',
        error: 'feature flag "' + FLAG_KEY + '" is OFF',
        enableForSmokeSnippet: writeGate.enableForSmokeSnippet,
        warnings: [],
      }, chromeExportLockDiagnostics({ memoryInFlight: state.inFlight === true, reason: reason }));
      state.lastExportAt = startedAt;
      state.lastExportStatus = 'flag-off';
      state.lastExportError = s1.error;
      return s1;
    }

    var staleLock = clearStaleChromeExportLock(reason);
    if (state.inFlight) {
      var blockedAgeMs = chromeExportInFlightAgeMs();
      return Object.assign({
        ok: false,
        reason: reason,
        startedAt: startedAt,
        completedAt: nowIso(),
        filename: '',
        transport: CHROME_FILE,
        direction: 'chrome-to-desktop',
        chromeWritesSyncFolder: false,
        path: exportPath,
        bytes: 0,
        flagEnabled: flagEnabled(),
        exportWriteGate: diagnoseChromeExportWriteGate(),
        folderAutoSync: folderAutoSync,
        status: 'chrome-to-desktop-export-in-flight',
        blockers: ['chrome-to-desktop-export-in-flight'],
        error: 'export already in flight',
        warnings: [],
      }, chromeExportLockDiagnostics({
        memoryInFlight: true,
        ageMs: blockedAgeMs,
        reason: state.inFlightReason || reason,
        owner: state.inFlightOwner || 'auto-import.exportNow',
      }));
    }
    state.inFlight = true;
    state.inFlightStartedAt = Date.now();
    state.inFlightReason = reason;
    state.inFlightOwner = 'auto-import.exportNow';
    var staleLockCleared = !!(staleLock && staleLock.cleared);
    var warnings = [];
    var errors = [];
    var blockers = [];
    var chromeExportCoverage = null;
    var nativeSnapshotPayloadPreflight = null;
    var bytes = 0;
    var atomicMethod = '';

    try {
      /* (2) Load directory handle. */
      var row = await loadStoredHandleRow();
      if (!row || !row.handle) {
        if (folderAutoSync) {
          return recordExportBlocked({
            ok: false,
            reason: reason,
            startedAt: startedAt,
            completedAt: nowIso(),
            filename: '',
            transport: CHROME_FILE,
            direction: 'chrome-to-desktop',
            chromeWritesSyncFolder: false,
            path: exportPath,
            bytes: 0,
            flagEnabled: flagEnabled(),
            exportWriteGate: diagnoseChromeExportWriteGate(),
            folderAutoSync: true,
            status: 'permission-required',
            blockers: ['sync-folder-not-connected', 'permission-required'],
            error: 'sync folder not connected — use Connect Folder first',
            warnings: [],
          });
        }
        throw new Error('sync folder not connected — use Connect Folder first');
      }
      var dirHandle = row.handle;
      exportPath = chromeExportPath(dirHandle && dirHandle.name);

      /* (3) readwrite permission (user gesture required). */
      if (folderAutoSync) {
        var writePermission = await queryReadWritePermission(dirHandle);
        if (writePermission !== 'granted') {
          return recordExportBlocked({
            ok: false,
            reason: reason,
            startedAt: startedAt,
            completedAt: nowIso(),
            filename: '',
            transport: CHROME_FILE,
            direction: 'chrome-to-desktop',
            chromeWritesSyncFolder: false,
            path: exportPath,
            bytes: 0,
            flagEnabled: flagEnabled(),
            exportWriteGate: diagnoseChromeExportWriteGate(),
            folderAutoSync: true,
            permission: writePermission,
            status: 'permission-required',
            blockers: ['permission-required'],
            error: 'readwrite permission not granted (got "' + writePermission + '")',
            warnings: [],
          });
        }
      } else {
        await ensureReadWritePermission(dirHandle);
      }

      /* (4) Pull any pending native Save-to-Folder snapshot payload into the
       * same archive backend export coverage reads. This is intentionally a
       * preflight only: if materialization fails, F19.7p payload coverage still
       * downgrades or blocks reader-ready rows instead of weakening safety. */
      nativeSnapshotPayloadPreflight = await refreshNativeSnapshotPayloadsBeforeExport(reason);

      /* (5) Produce bundle via service worker. */
      var bundle = await callArchive('exportFullBundle', {});

      /* (6) Align export source with the live Chrome Studio LibraryIndex.
       * F19.5 supported parity requires chrome-latest.json to cover the
       * same visible Library rows that the parity snapshot counts. */
      var aligned = await alignBundleToLibraryIndex(bundle);
      bundle = aligned.bundle || bundle;
      chromeExportCoverage = aligned.coverage || null;
      var folderDeleteRequestExport = await collectFolderDeleteRequestsForExport();
      var folderRestoreRequestExport = await collectFolderRestoreRequestsForExport();
      var chatFolderBindingRequestExport = await collectChatFolderBindingRequestsForExport();
      var libraryMetadataMutationRequestExport = await collectLibraryMetadataMutationRequestsForExport();
      bundle.folderDeleteRequests = folderDeleteRequestExport.requests || [];
      bundle.folderRestoreRequests = folderRestoreRequestExport.requests || [];
      bundle.chatFolderBindingRequests = chatFolderBindingRequestExport.requests || [];
      bundle.libraryMetadataMutationRequests = libraryMetadataMutationRequestExport.requests || [];
      state.lastFolderDeleteRequestExport = folderDeleteRequestExport;
      state.lastFolderRestoreRequestExport = folderRestoreRequestExport;
      state.lastChatFolderBindingRequestExport = chatFolderBindingRequestExport;
      state.lastLibraryMetadataMutationRequestExport = libraryMetadataMutationRequestExport;
      (folderDeleteRequestExport.warnings || []).forEach(function (code) {
        if (warnings.indexOf(code) === -1) warnings.push(code);
      });
      (folderRestoreRequestExport.warnings || []).forEach(function (code) {
        if (warnings.indexOf(code) === -1) warnings.push(code);
      });
      (folderRestoreRequestExport.blockers || []).forEach(function (code) {
        if (blockers.indexOf(code) === -1) blockers.push(code);
      });
      (chatFolderBindingRequestExport.warnings || []).forEach(function (code) {
        if (warnings.indexOf(code) === -1) warnings.push(code);
      });
      (chatFolderBindingRequestExport.blockers || []).forEach(function (code) {
        if (blockers.indexOf(code) === -1) blockers.push(code);
      });
      (libraryMetadataMutationRequestExport.warnings || []).forEach(function (code) {
        if (warnings.indexOf(code) === -1) warnings.push(code);
      });
      (libraryMetadataMutationRequestExport.blockers || []).forEach(function (code) {
        if (blockers.indexOf(code) === -1) blockers.push(code);
      });
      if (chromeExportCoverage) chromeExportCoverage.nativeSnapshotPayloadPreflight = nativeSnapshotPayloadPreflight;
      state.lastSnapshotPayloadCoverage = chromeExportCoverage;
      if (chromeExportCoverage) {
        (chromeExportCoverage.warnings || []).forEach(function (code) {
          if (warnings.indexOf(code) === -1) warnings.push(code);
        });
        (chromeExportCoverage.blockers || []).forEach(function (code) {
          if (blockers.indexOf(code) === -1) blockers.push(code);
        });
      }
      if (blockers.length > 0) {
        var blocked = Object.assign({
          ok: false,
          reason: reason,
          startedAt: startedAt,
          completedAt: nowIso(),
          filename: '',
          transport: CHROME_FILE,
          direction: 'chrome-to-desktop',
          chromeWritesSyncFolder: false,
          path: exportPath,
          bytes: 0,
          flagEnabled: flagEnabled(),
          exportWriteGate: diagnoseChromeExportWriteGate(),
          folderAutoSync: folderAutoSync,
          status: 'coverage-blocked',
          error: blockers[0],
          warnings: warnings,
          blockers: blockers,
          chromeExportCoverage: chromeExportCoverage,
          unindexedArchiveRowCount: chromeExportCoverage ? Number(chromeExportCoverage.unindexedArchiveRowCount || 0) : 0,
          unindexedRowManifestCount: chromeExportCoverage ? Number(chromeExportCoverage.unindexedRowManifestCount || 0) : 0,
          unindexedRowReasonCounts: chromeExportCoverage ? Object.assign({}, chromeExportCoverage.unindexedRowReasonCounts || {}) : {},
          unindexedRows: chromeExportCoverage && Array.isArray(chromeExportCoverage.unindexedRows)
            ? chromeExportCoverage.unindexedRows.slice(0, 50) : [],
        }, chromeExportLockDiagnostics({
          memoryInFlight: false,
          staleCleared: staleLockCleared,
          reason: reason,
          owner: 'auto-import.exportNow',
        }));
        state.lastExportAt = startedAt;
        state.lastExportStatus = 'coverage-blocked';
        state.lastExportFile = '';
        state.lastExportBytes = 0;
        state.lastExportError = blockers[0] || '';
        return blocked;
      }

      /* (6) Schema validation. */
      var v = validateBundleShape(bundle);
      if (!v.ok) throw new Error('bundle validation failed: ' + v.error);

      /* (7) Serialize. */
      var json = JSON.stringify(bundle);

      /* (8) Atomic-ish write. */
      var writeResult = await writeBundleAtomic(dirHandle, json);
      bytes = writeResult.bytes;
      atomicMethod = writeResult.atomicMethod;
      var completedAt = nowIso();

      var ok = Object.assign({
        ok: true,
        reason: reason,
        startedAt: startedAt,
        completedAt: completedAt,
        exportedAt: completedAt,
        filename: CHROME_FILE,
        transport: CHROME_FILE,
        direction: 'chrome-to-desktop',
        chromeWritesSyncFolder: true,
        path: exportPath,
        bytes: bytes,
        atomicMethod: atomicMethod,
        flagEnabled: flagEnabled(),
        exportWriteGate: diagnoseChromeExportWriteGate(),
        folderAutoSync: folderAutoSync,
        status: 'chrome-to-desktop-exported',
        blockers: blockers,
        warnings: warnings,
        folderDeleteRequestExport: {
          requestCount: Number(folderDeleteRequestExport.requestCount || 0),
          skippedCount: Number(folderDeleteRequestExport.skippedCount || 0),
          reviewRequestCount: Number(folderDeleteRequestExport.reviewRequestCount || 0),
          mirrorRequestCount: Number(folderDeleteRequestExport.mirrorRequestCount || 0),
          staleMirrorSkippedCount: Number(folderDeleteRequestExport.staleMirrorSkippedCount || 0),
          pendingDeleteHiddenCount: Number(folderDeleteRequestExport.pendingDeleteHiddenCount || 0),
          hiddenWithoutExportableRequestCount: Number(folderDeleteRequestExport.hiddenWithoutExportableRequestCount || 0),
          repairedHiddenRequestCount: Number(folderDeleteRequestExport.repairedHiddenRequestCount || 0),
          storeAvailable: folderDeleteRequestExport.storeAvailable === true,
          mirrorAvailable: folderDeleteRequestExport.mirrorAvailable === true,
          mirrorOk: folderDeleteRequestExport.mirrorOk === true,
          pendingHiddenRepair: folderDeleteRequestExport.pendingHiddenRepair || null,
          noApply: true,
          desktopApplyRequired: true,
        },
        folderRestoreRequestExport: {
          requestCount: Number(folderRestoreRequestExport.requestCount || 0),
          pendingRestoreRequestCount: Number(folderRestoreRequestExport.pendingRestoreRequestCount || 0),
          skippedCount: Number(folderRestoreRequestExport.skippedCount || 0),
          purgedRestoreBlockedCount: Number(folderRestoreRequestExport.purgedRestoreBlockedCount || 0),
          invalidCount: Number(folderRestoreRequestExport.invalidCount || 0),
          reviewRequestCount: Number(folderRestoreRequestExport.reviewRequestCount || 0),
          mirrorRequestCount: Number(folderRestoreRequestExport.mirrorRequestCount || 0),
          staleMirrorSkippedCount: Number(folderRestoreRequestExport.staleMirrorSkippedCount || 0),
          storeAvailable: folderRestoreRequestExport.storeAvailable === true,
          mirrorAvailable: folderRestoreRequestExport.mirrorAvailable === true,
          mirrorOk: folderRestoreRequestExport.mirrorOk === true,
          noApply: true,
          desktopRestoreRequired: true,
          noChromeRestoreAuthority: true,
          noTombstoneApply: true,
          noHardDelete: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
        },
        chatFolderBindingRequestExport: {
          requestCount: Number(chatFolderBindingRequestExport.requestCount || 0),
          pendingRequestCount: Number(chatFolderBindingRequestExport.pendingRequestCount || 0),
          skippedCount: Number(chatFolderBindingRequestExport.skippedCount || 0),
          invalidCount: Number(chatFolderBindingRequestExport.invalidCount || 0),
          reviewRequestCount: Number(chatFolderBindingRequestExport.reviewRequestCount || 0),
          mirrorRequestCount: Number(chatFolderBindingRequestExport.mirrorRequestCount || 0),
          staleMirrorSkippedCount: Number(chatFolderBindingRequestExport.staleMirrorSkippedCount || 0),
          storeAvailable: chatFolderBindingRequestExport.storeAvailable === true,
          mirrorAvailable: chatFolderBindingRequestExport.mirrorAvailable === true,
          mirrorOk: chatFolderBindingRequestExport.mirrorOk === true,
          noApply: true,
          desktopApplyRequired: true,
          noChromeBindingAuthority: true,
          noChromeDestructiveBindingApply: true,
          noDesktopCanonicalMutation: true,
          noHardDelete: true,
          noPurge: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
        },
        libraryMetadataMutationRequestExport: {
          requestCount: Number(libraryMetadataMutationRequestExport.requestCount || 0),
          pendingRequestCount: Number(libraryMetadataMutationRequestExport.pendingRequestCount || 0),
          skippedCount: Number(libraryMetadataMutationRequestExport.skippedCount || 0),
          invalidCount: Number(libraryMetadataMutationRequestExport.invalidCount || 0),
          mirrorRequestCount: Number(libraryMetadataMutationRequestExport.mirrorRequestCount || 0),
          mirrorAvailable: libraryMetadataMutationRequestExport.mirrorAvailable === true,
          mirrorOk: libraryMetadataMutationRequestExport.mirrorOk === true,
          noApply: true,
          requestOnly: true,
          desktopApplyRequired: true,
          desktopApply: false,
          noLocalApply: true,
          noChromeCanonicalMutation: true,
          noDesktopCanonicalMutation: true,
          chromeAuthority: false,
          desktopAuthority: true,
          separateFromDesktopCanonicalLibraryMetadata: true,
          noHardDelete: true,
          noPurge: true,
          noChatDelete: true,
          noSnapshotDelete: true,
          noAssetDelete: true,
          noLabelDelete: true,
          noTagDelete: true,
          noCategoryDelete: true,
          noMetadataDelete: true,
        },
        chromeExportCoverage: chromeExportCoverage,
        unindexedArchiveRowCount: chromeExportCoverage ? Number(chromeExportCoverage.unindexedArchiveRowCount || 0) : 0,
        unindexedRowManifestCount: chromeExportCoverage ? Number(chromeExportCoverage.unindexedRowManifestCount || 0) : 0,
        unindexedRowReasonCounts: chromeExportCoverage ? Object.assign({}, chromeExportCoverage.unindexedRowReasonCounts || {}) : {},
        unindexedRows: chromeExportCoverage && Array.isArray(chromeExportCoverage.unindexedRows)
          ? chromeExportCoverage.unindexedRows.slice(0, 50) : [],
      }, chromeExportLockDiagnostics({
        memoryInFlight: false,
        staleCleared: staleLockCleared,
        reason: reason,
        owner: 'auto-import.exportNow',
      }));
      state.lastExportAt = startedAt;
      state.lastExportStatus = 'ok';
      state.lastExportFile = CHROME_FILE;
      state.lastExportBytes = bytes;
      state.lastExportError = '';
      /* Best-effort persisted summary; never fails exportNow if write KO. */
      writeKv(SETTINGS_KEY, {
        version: 1,
        lastExportAt: startedAt,
        lastExportStatus: 'ok',
        lastExportFile: CHROME_FILE,
        lastExportBytes: bytes,
      }).catch(function (e) { pushError('writeKv.lastExport', e); });
      return ok;
    } catch (e) {
      pushError('exportNow', e);
      errors.push({ kind: 'export', error: String((e && e.message) || e) });
      var failedAt = nowIso();
      state.lastExportAt = startedAt;
      state.lastExportStatus = 'error';
      state.lastExportError = String((e && e.message) || e);
      return Object.assign({
        ok: false,
        reason: reason,
        startedAt: startedAt,
        completedAt: failedAt,
        filename: '',
        transport: CHROME_FILE,
        direction: 'chrome-to-desktop',
        chromeWritesSyncFolder: false,
        path: exportPath,
        bytes: bytes,
        atomicMethod: atomicMethod,
        flagEnabled: flagEnabled(),
        exportWriteGate: diagnoseChromeExportWriteGate(),
        folderAutoSync: folderAutoSync,
        status: 'chrome-to-desktop-export-failed',
        warnings: warnings,
        errors: errors,
        error: String((e && e.message) || e),
        blockers: ['chrome-to-desktop-export-failed'],
      }, chromeExportLockDiagnostics({
        memoryInFlight: false,
        staleCleared: staleLockCleared,
        reason: reason,
        owner: 'auto-import.exportNow',
      }));
    } finally {
      state.inFlight = false;
      state.inFlightStartedAt = 0;
      state.inFlightReason = '';
      state.inFlightOwner = '';
    }
  }

  /* ── Opt-in event-trigger: flag-backed (H2O.flags), with listener wiring ─── */
  /* The event-trigger opt-in is persisted via H2O.flags under
   * EVENT_TRIGGER_FLAG_KEY (`sync.chromeAutoImport.eventTrigger`),
   * which is the same persistence layer as the master flag
   * (`sync.chromeAutoImport`). Reads are live so flipping with
   * `H2O.flags.set(...)` takes effect immediately. enable()/disable()
   * additionally bind/unbind the actual DOM event listeners.
   *
   * The SETTINGS_KEY chrome.storage.local row is preserved for
   * read-only diagnostics (lastExportAt etc.) and back-compat with
   * R3 phase 1 callers; the opt-in boolean is no longer mirrored there. */
  function eventTriggerFlagEnabled() {
    try {
      var flags = H2O.flags;
      if (flags && typeof flags.get === 'function') {
        return flags.get(EVENT_TRIGGER_FLAG_KEY, false) === true;
      }
    } catch (_) { /* fall through */ }
    return false;
  }
  function setEventTriggerFlag(next) {
    try {
      var flags = H2O.flags;
      if (flags && typeof flags.set === 'function') {
        flags.set(EVENT_TRIGGER_FLAG_KEY, !!next);
      }
    } catch (e) { pushError('setEventTriggerFlag', e); }
  }

  function reconcileEventTriggerBinding(reason) {
    var enabled = eventTriggerFlagEnabled();
    state.enabled = enabled;
    if (enabled && !state.listenersBound) {
      bindEventListeners();
      if (state.listenersBound) state.lastEventTriggerReconcileReason = String(reason || 'reconcile');
    } else if (!enabled && state.listenersBound) {
      unbindEventListeners();
      state.lastEventTriggerReconcileReason = String(reason || 'reconcile');
    }
    return enabled;
  }

  function scheduleBootReconcile() {
    [0, 100, 500, 1500, 5000].forEach(function (delay) {
      try {
        global.setTimeout(function () {
          reconcileEventTriggerBinding('boot-reconcile:' + delay);
        }, delay);
      } catch (e) { pushError('boot-reconcile', e); }
    });
  }

  async function loadPersistedState() {
    try {
      var row = await readKv(SETTINGS_KEY);
      if (row && typeof row === 'object') {
        state.lastExportAt = String(row.lastExportAt || '');
        state.lastExportStatus = String(row.lastExportStatus || '');
        state.lastExportFile = String(row.lastExportFile || '');
        state.lastExportBytes = Number(row.lastExportBytes || 0);
      }
    } catch (e) { pushError('loadPersistedState', e); }
    /* Honor the flag-backed opt-in: if both flags are ON at boot, wire
     * the listeners so subsequent library-save events trigger exportNow.
     * Note this still requires the master FLAG_KEY to be ON — checked at
     * trigger time inside onTriggerEvent, not here, so flipping the
     * master flag at runtime takes effect on the next event without a
     * reload. */
    reconcileEventTriggerBinding('loadPersistedState');
  }

  function isEnabled() { return reconcileEventTriggerBinding('isEnabled'); }
  async function enableChromeExport() {
    setMasterFlag(true);
    return diagnoseChromeExportWriteGate();
  }
  async function disableChromeExport() {
    setMasterFlag(false);
    unbindEventListeners();
    setEventTriggerFlag(false);
    state.enabled = false;
    return diagnoseChromeExportWriteGate();
  }
  async function enable()  {
    setMasterFlag(true);
    setEventTriggerFlag(true);
    reconcileEventTriggerBinding('enable');
    return isEnabled();
  }
  async function disable() {
    unbindEventListeners();
    setMasterFlag(false);
    setEventTriggerFlag(false);
    state.enabled = false;
    return isEnabled();
  }

  /* ── Event-trigger listener plumbing ─────────────────────────────── */
  /* onTriggerEvent: load-bearing guard. Even with listeners bound, we
   * re-check both flags + folder-connected on every fire so a runtime
   * flag flip (without disable()) doesn't leak unwanted exports. */
  function onTriggerEvent(eventName, event) {
    state.lastEventAt = Date.now();
    state.lastEventName = String(eventName || '');
    state.eventTriggerCount += 1;
    var suppressed = shouldSuppressEventTriggeredExport(eventName, event);
    if (suppressed) {
      recordEventTriggerSuppressed(suppressed);
      return;
    }
    /* Hard gates — drop event without scheduling. */
    if (!flagEnabled())            return;
    if (!eventTriggerFlagEnabled()) return;
    /* Debounce: replace any pending trigger so a burst of writes
     * collapses to one export at the tail. */
    if (state.eventTriggerTimer) {
      global.clearTimeout(state.eventTriggerTimer);
      state.eventTriggerTimer = null;
    }
    state.eventTriggerTimer = global.setTimeout(function () {
      state.eventTriggerTimer = null;
      /* Folder-connected gate runs inside exportNow via the IDB handle
       * lookup; no need to short-circuit here. */
      exportNowWithP01Admission({ reason: 'event:' + eventName }).catch(function (e) {
        pushError('event-triggered-export', e);
      });
    }, EVENT_TRIGGER_DEBOUNCE_MS);
  }

  function trigger(options) {
    var opts = (options && typeof options === 'object') ? options : {};
    var name = String(opts.eventName || opts.reason || 'evt:h2o:sync:chrome-auto-import:trigger');
    reconcileEventTriggerBinding('trigger:' + name);
    onTriggerEvent(name, null);
    return {
      ok: true,
      eventName: name,
      eventTriggerEnabled: eventTriggerFlagEnabled(),
      eventTriggerListenersBound: state.listenersBound,
      eventTriggerCount: state.eventTriggerCount,
      lastEventAt: state.lastEventAt,
    };
  }

  function bindEventListeners() {
    if (state.listenersBound) return;
    if (typeof global.addEventListener !== 'function') {
      pushError('bindEventListeners', new Error('addEventListener unavailable'));
      return;
    }
    EVENT_TRIGGER_NAMES.forEach(function (name) {
      if (state.listenerHandlers[name]) return;
      var handler = function (event) { onTriggerEvent(name, event); };
      state.listenerHandlers[name] = handler;
      try { global.addEventListener(name, handler); }
      catch (e) { pushError('bindEventListeners:' + name, e); }
    });
    state.listenersBound = true;
  }
  function unbindEventListeners() {
    if (!state.listenersBound) return;
    EVENT_TRIGGER_NAMES.forEach(function (name) {
      var handler = state.listenerHandlers[name];
      if (!handler) return;
      try { global.removeEventListener(name, handler); }
      catch (e) { pushError('unbindEventListeners:' + name, e); }
      delete state.listenerHandlers[name];
    });
    state.listenersBound = false;
    if (state.eventTriggerTimer) {
      global.clearTimeout(state.eventTriggerTimer);
      state.eventTriggerTimer = null;
    }
  }

  /* ── status / diagnose ───────────────────────────────────────────── */
  async function status() {
    reconcileEventTriggerBinding('status');
    var handleRow = null;
    try { handleRow = await loadStoredHandleRow(); }
    catch (e) { pushError('status.loadHandle', e); }
    var folderName = handleRow && handleRow.handle && handleRow.handle.name ? handleRow.handle.name : '';
    var writeGate = diagnoseChromeExportWriteGate();
    var permission = handleRow && handleRow.handle
      ? await queryReadWritePermission(handleRow.handle)
      : 'not-checked';
    if (permission === 'unknown') permission = 'unavailable';
    var configured = (writeGate.flagEnabled === true || writeGate.smokeChromeExportOptIn === true) &&
      eventTriggerFlagEnabled() === true;
    var writeGateReady = writeGate.effectiveFlagEnabled === true;
    var prerequisitesSatisfied = writeGateReady &&
      !!(handleRow && handleRow.handle) && permission === 'granted';
    var schedulerActive = state.listenersBound === true;
    var effective = configured && prerequisitesSatisfied && schedulerActive;
    var ineffectiveReason = !configured ? 'not-configured'
      : (!writeGateReady ? String(writeGate.blockers && writeGate.blockers[0] || 'write-gate-blocked')
        : (!(handleRow && handleRow.handle) ? 'folder-not-connected'
        : (permission !== 'granted' ? (permission === 'prompt'
          ? 'permission-required' : 'permission-' + permission)
          : (!schedulerActive ? 'scheduler-not-running' : ''))));
    return {
      phase: PHASE,
      flagKey: FLAG_KEY,
      flagEnabled: writeGate.effectiveFlagEnabled === true,
      flagEnabledByMasterFlag: writeGate.flagEnabled === true,
      flagEnabledBySmokeBridge: writeGate.smokeChromeExportEnabled === true,
      eventTriggerFlagKey: EVENT_TRIGGER_FLAG_KEY,
      eventTriggerEnabled: eventTriggerFlagEnabled(),
      chromeExportWriteGate: writeGate,
      eventTriggerListenersBound: state.listenersBound,
      eventTriggerNames: EVENT_TRIGGER_NAMES.slice(),
      eventTriggerDebounceMs: EVENT_TRIGGER_DEBOUNCE_MS,
      eventTriggerCount: state.eventTriggerCount,
      lastEventAt: state.lastEventAt,
      lastEventName: state.lastEventName,
      desktopOriginImportEventSources: DESKTOP_ORIGIN_IMPORT_EVENT_SOURCES.slice(),
      eventTriggerSuppressedCount: state.eventTriggerSuppressedCount,
      lastEventTriggerSuppressedAt: state.lastEventTriggerSuppressedAt,
      lastEventTriggerSuppressedName: state.lastEventTriggerSuppressedName,
      lastEventTriggerSuppressedSource: state.lastEventTriggerSuppressedSource,
      lastEventTriggerSuppressedReason: state.lastEventTriggerSuppressedReason,
      lastEventTriggerReconcileReason: state.lastEventTriggerReconcileReason || '',
      folderConnected: !!(handleRow && handleRow.handle),
      folderName: folderName,
      permission: permission,
      permissionSource: handleRow && handleRow.handle ? 'live-query' : 'not-checked',
      configured: configured,
      effective: effective,
      prerequisitesSatisfied: prerequisitesSatisfied,
      schedulerActive: schedulerActive,
      ineffectiveReason: ineffectiveReason,
      lastExportAt: state.lastExportAt,
      lastExportStatus: state.lastExportStatus,
      lastExportFile: state.lastExportFile,
      lastExportBytes: state.lastExportBytes,
      lastExportError: state.lastExportError,
      lastSnapshotPayloadCoverage: state.lastSnapshotPayloadCoverage,
      lastNativeSnapshotPayloadPreflight: state.lastNativeSnapshotPayloadPreflight,
      lastFolderDeleteRequestExport: state.lastFolderDeleteRequestExport,
      lastFolderRestoreRequestExport: state.lastFolderRestoreRequestExport,
      lastChatFolderBindingRequestExport: state.lastChatFolderBindingRequestExport,
      lastLibraryMetadataMutationRequestExport: state.lastLibraryMetadataMutationRequestExport,
      inFlight: state.inFlight,
      chromeExportInFlightPersisted: false,
      chromeExportInFlightMemory: state.inFlight === true,
      chromeExportInFlightAgeMs: chromeExportInFlightAgeMs(),
      chromeExportInFlightStaleMs: CHROME_EXPORT_IN_FLIGHT_STALE_MS,
      chromeExportStaleLockCleared: false,
      chromeExportLastStaleLockClearedAt: state.lastStaleInFlightClearedAt,
      chromeExportLastStaleLockClearedReason: state.lastStaleInFlightClearedReason,
      chromeExportLockOwner: cleanString(state.inFlightOwner),
      chromeExportLockReason: cleanString(state.inFlightReason),
    };
  }
  async function diagnose() {
    var s = await status();
    return Object.assign({}, s, {
      installedAt: state.installedAt,
      installedAtIso: (function () { try { return new Date(state.installedAt).toISOString(); } catch (_) { return ''; } })(),
      filename: CHROME_FILE,
      tmpFilename: CHROME_FILE_TMP,
      msgEnvelope: MSG_ARCHIVE,
      idbName: IDB_NAME,
      idbStore: IDB_STORE,
      idbKey: IDB_KEY,
      settingsKey: SETTINGS_KEY,
      gateRef: 'R2D Gate R3 — Chrome to Desktop Export Gate',
      bidirectionalSync: false,
      polling: false,
      backgroundDaemon: false,
      writesLatestJson: false,
      errors: state.errors.slice(),
    });
  }

  function diagnoseSnapshotPayloadCoverage() {
    return state.lastSnapshotPayloadCoverage || null;
  }

  /* ── Public API ──────────────────────────────────────────────────── */
  var api = {
    __installed: true,
    __version: '0.1.0',
    exportNow: exportNowWithP01Admission,
    isEnabled: isEnabled,
    enableChromeExport: enableChromeExport,
    disableChromeExport: disableChromeExport,
    enable: enable,
    disable: disable,
    trigger: trigger,
    status: status,
    diagnose: diagnose,
    getAutomationSnapshot: status,
    diagnoseSnapshotPayloadCoverage: diagnoseSnapshotPayloadCoverage,
    diagnoseChromeExportWriteGate: diagnoseChromeExportWriteGate,
  };
  H2O.Studio.sync.autoImport = api;

  /* Best-effort hydration of persisted state. Never blocks API readiness;
   * if this fails the API still works (state.enabled stays false). */
  loadPersistedState().catch(function (e) { pushError('boot.loadPersistedState', e); });
  scheduleBootReconcile();
})(typeof window !== 'undefined' ? window : globalThis);
