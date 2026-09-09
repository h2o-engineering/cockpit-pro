/* H2O Studio Sync — Manual Folder Bundle Importer (Desktop / Tauri)
 *
 * M2d-1a — first stage of Browser Studio → Desktop Studio auto-sync.
 * Provides a Desktop-only namespace H2O.Studio.sync with MANUAL scan +
 * import APIs over a user-chosen folder containing MV3 Studio full-bundle
 * JSON files. No watcher yet; no auto-import yet — those land in M2d-1b/c.
 *
 * Desktop-only: gates on Tauri detection at load; silently no-ops on
 * MV3 / web. Reuses H2O.Studio.ingestion.{dryRunImportBundle, importBundle}
 * (M2b-1/2) end-to-end — this module is purely the "find + dedupe + read
 * the file" glue layer in front of the existing importer.
 *
 * Storage:
 *   Config:  chrome.storage.local['h2o:studio:sync:config:v1']
 *            { schemaVersion, mode, folderPath, updatedAt }
 *   Ledger:  chrome.storage.local['h2o:studio:sync:ledger:v1']
 *            { schemaVersion, updatedAt, entries: [{fingerprint, …}] }
 *   (Both are SQLite-backed on Desktop via the kv_store shim.)
 *
 * Safety invariants:
 *   - merge-only import (cannot delete or overwrite Desktop data)
 *   - SHA256 fingerprint dedupes — re-scans skip already-imported files
 *   - 100 MB file-size cap; oversized files are reported, never read fully
 *   - Files matching *.crdownload / *.partial / leading-dot are skipped
 *   - Schema-validated via dryRunImportBundle before any write
 *   - No file deletion / move — Desktop is read-only on the source folder
 *
 * Contracts:
 *   - Uses tauri-plugin-fs (added to Cargo + capabilities in this stage)
 *   - File system access scoped to $DOWNLOAD/** + $HOME/** per
 *     apps/studio/desktop/src-tauri/capabilities/default.json
 *   - Future M2d-1b will add a tauri-plugin-fs-watch-based auto-detector
 *
 * Public API: H2O.Studio.sync.{
 *   getConfig, setConfig, getLedger, clearLedger,
 *   scanFolderOnce, importFromFile, diagnose
 * }
 */
(function (global) {
  'use strict';

  /* ── Tauri detection — bail otherwise ─────────────────────────────── */
  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* swallow */ }
    return false;
  }
  if (!detectTauri()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.sync && H2O.Studio.sync.__installed) return;

  /* ── Constants ────────────────────────────────────────────────────── */
  var CONFIG_KEY = 'h2o:studio:sync:config:v1';
  var LEDGER_KEY = 'h2o:studio:sync:ledger:v1';
  var FULL_BUNDLE_SCHEMA = 'h2o.studio.fullBundle.v2';
  var PROPAGATION_SCHEMA = 'h2o.studio.sync.chrome-desktop-propagation.v1';
  var FOLDER_DELETE_REQUEST_SCHEMA = 'h2o.studio.folder-delete-request.v1';
  var FOLDER_RESTORE_REQUEST_SCHEMA = 'h2o.studio.folder-restore-request.v1';
  var CHAT_FOLDER_BINDING_REQUEST_SCHEMA = 'h2o.studio.chat-folder-binding-request.v1';
  var CHAT_FOLDER_BINDING_RECEIPT_SCHEMA = 'h2o.studio.chat-folder-binding-receipt.v1';
  /* F30 (folder-sync S1): inert sortOrder reorder request/receipt schema constants. Declared only —
     NOT wired into any validate/apply/receipt handler, request loop, or transport/import/export path.
     field-mismatch:sortOrder remains gated (blocked in the F11 render-only rebuild helper). */
  var FOLDER_SORTORDER_REORDER_REQUEST_SCHEMA = 'h2o.studio.folder-sortorder-reorder-request.v1';
  var FOLDER_SORTORDER_REORDER_RECEIPT_SCHEMA = 'h2o.studio.folder-sortorder-reorder-receipt.v1';
  var LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA = 'h2o.studio.library-metadata-mutation-request.v1';
  var LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA = 'h2o.studio.library-metadata-mutation-receipt.v1';
  var LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_KEY = 'h2o:studio:library-metadata-mutation-receipts:export:v1';
  var LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_MIRROR_SCHEMA = 'h2o.studio.library-metadata-mutation-receipt.export-mirror.v1';
  var F19_CHROME_DESKTOP_VERSION = '0.1.0-f19.2.b';
  var F19_DESKTOP_CHROME_VERSION = '0.1.0-f19.2.c';
  var FOLDER_SYNC_HEALTH_SCHEMA = 'h2o.studio.sync.folder-health.v1';
  var FOLDER_SYNC_HEALTH_VERSION = '0.1.0-phase3-health';
  var HEALTH_SCHEDULER_EXPECTATION_WINDOW_MS = 2 * 60 * 1000;
  var MAX_LEDGER_ENTRIES  = 100;
  var MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; /* 100 MB */
  var VALID_MODES = ['off', 'manual', 'notify', 'auto'];
  var SYNC_FOLDER_NAME = 'H2O Studio Sync';
  var PHASE3_AUTO_IMPORT_CONFIG_VERSION = 1;
  /* Filename glob patterns. The first matches MV3 exporter output
   * (h2o-studio-full-bundle__<extIdFirst8>__<isoTimestamp>.json); the
   * second leaves room for a future short-format file; the third
   * matches the Chrome auto-import.mv3.js opt-in export
   * (chrome-latest.json) sanctioned by R2D Gate R3. Routes through the
   * same importBundle merge-only path — no new merge mode, no schema
   * change. The .tmp staging variant (chrome-latest.json.tmp) is
   * filtered out by IGNORE_SUFFIXES below. */
  var FILENAME_PATTERNS = [
    /^h2o-studio-full-bundle.*\.json$/i,
    /^h2o-studio-sync.*\.json$/i,
    /^chrome-latest\.json$/i,
  ];
  var CHROME_LATEST_FILE = 'chrome-latest.json';
  var CHROME_DESKTOP_SUPPORTED_FIELDS = [
    'saved-chat-records',
    'linked-chat-records',
    'folder-metadata',
    'folder-delete-requests',
    'folder-restore-requests',
    'chat-folder-binding-requests',
    'library-metadata-mutation-requests',
    'category-metadata',
    'chat-category-bindings'
  ];
  var CHROME_DESKTOP_DEFERRED_CODES = {
    labels: 'library-propagation-labels-deferred',
    tags: 'library-propagation-tags-deferred',
    projects: 'library-propagation-projects-deferred',
    folderBindings: 'library-propagation-chat-folder-bindings-deferred',
    unsupportedStorage: 'library-propagation-unsupported-storage-deferred',
    sourceMetadataMissing: 'library-propagation-source-metadata-missing'
  };
  var F19_SYNC_HARDENING_CODES = {
    syncFolderMissing: 'sync-folder-missing',
    permissionDenied: 'permission-denied',
    transportFileMissing: 'transport-file-missing',
    transportFileMalformed: 'transport-file-malformed',
    transportSchemaUnsupported: 'transport-schema-unsupported',
    transportStale: 'transport-stale',
    duplicateImportIdempotent: 'duplicate-import-idempotent',
    localNewerConflict: 'local-newer-conflict',
    simultaneousUpdateConflict: 'simultaneous-update-conflict',
    deferredFieldPresent: 'deferred-field-present',
    unsupportedFieldPresent: 'unsupported-field-present',
    sourceMetadataMissing: 'source-metadata-missing',
    parityPeerSnapshotRequired: 'parity-peer-snapshot-required'
  };
  /* Browser partial-download suffixes to ignore until the rename completes. */
  var IGNORE_SUFFIXES = ['.crdownload', '.partial', '.download', '.tmp'];

  /* M2d-1b watcher tuning. The polling watcher fires every intervalMs;
   * each candidate must be seen across two ticks with the same size AND
   * ≥ FILE_STABLE_MIN_MS apart before it's emitted, to dodge browsers'
   * still-writing rename window even when the .crdownload extension
   * filter doesn't catch it. */
  var DEFAULT_INTERVAL_MS = 5000;
  var MIN_INTERVAL_MS = 1000;
  var MAX_INTERVAL_MS = 60000;
  var FILE_STABLE_MIN_MS = 1500;
  var MAX_LISTENERS = 64;

  /* Diagnostic-only sample cap for orphan-folder-binding visibility
   * (Phase D). Visibility only — never affects import behavior. */
  var MAX_ORPHAN_SAMPLE = 5;

  var state = {
    lastScanAt:   null,
    lastImportAt: null,
    errors:       [],
    warnings:     [],
    errMax:       20,
    warnMax:      20,
    /* Phase D — orphan-folder-binding visibility. Updated by importFromFile
     * after each completed import (even when result.ok === false), reset to
     * 0/[]/null on a fresh boot. These fields are read-only diagnostics. */
    lastImportOrphanBindings:      0,
    lastImportOrphanBindingSample: [],
    lastImportOrphanBindingsAt:    null,
    lastAutoImportAt:              null,
    lastAutoImportStatus:          '',
    lastAutoImportError:           '',
    lastAutoImportPath:            '',
    lastAutoImportBytes:           0,
    lastAutoImportReason:          '',
    lastImportedChromeExportedAt:  '',
    lastAutoImportConfigMode:      '',
    lastAutoImportEffectiveMode:   '',
    lastAutoImportConfigMigration: '',
    lastPostImportRefreshAt:       null,
    lastPostImportRefreshStatus:   '',
    lastPostImportRefreshError:    '',
    lastPostImportRefreshReason:   '',
    lastPostImportRefreshEvents:   [],
    lastPostImportRefreshMode:     '',
    lastPostImportRefreshChangedFolderCount: 0,
    lastFolderDeleteRequestImport: null,
    lastFolderDeleteRequestAutoApply: null,
    lastFolderRestoreRequestImport: null,
    lastFolderRestoreRequestAutoApply: null,
    lastChatFolderBindingRequestImport: null,
    lastChatFolderBindingRequestAutoApply: null,
    lastLibraryMetadataMutationRequestImport: null,
    lastLibraryMetadataMutationRequestAutoApply: null,
  };

  /* M2d-1b watcher state — runtime-only; never persisted. */
  var watcherState = {
    running:        false,
    intervalId:     null,
    intervalMs:     DEFAULT_INTERVAL_MS,
    scanInFlight:   false,
    lastScanAt:     null,
    lastEventAt:    null,
    sizeMap:        Object.create(null),  /* path → { size, firstSeenAtMs } */
    pending:        [],                    /* candidate objects (with fingerprint) */
    listeners:      new Set(),
    errors:         [],
    errMax:         20,
    lastError:      null,
    /* Cached config snapshot — updated by reconcileWatcherFromConfig + the
     * boot-time auto-start. Used so getWatcherState() can be synchronous. */
    folderPath:     '',
    mode:           'off',
  };
  function pushErr(op, e) {
    try {
      state.errors.push({ at: Date.now(), op: String(op), error: String((e && e.message) || e) });
      if (state.errors.length > state.errMax) state.errors.splice(0, state.errors.length - state.errMax);
    } catch (_) { /* ignore */ }
  }
  function pushWarn(op, msg) {
    try {
      state.warnings.push({ at: Date.now(), op: String(op), warn: String(msg) });
      if (state.warnings.length > state.warnMax) state.warnings.splice(0, state.warnings.length - state.warnMax);
    } catch (_) { /* ignore */ }
  }

  /* ── Tauri invoke (V2) ────────────────────────────────────────────── */
  function getInvoke() {
    try {
      var internals = global.__TAURI_INTERNALS__;
      if (internals && typeof internals.invoke === 'function') return internals.invoke.bind(internals);
    } catch (_) { /* ignore */ }
    try {
      var tauri = global.__TAURI__;
      if (tauri && tauri.core && typeof tauri.core.invoke === 'function') return tauri.core.invoke.bind(tauri.core);
      if (tauri && typeof tauri.invoke === 'function') return tauri.invoke.bind(tauri);
    } catch (_) { /* ignore */ }
    return null;
  }

  function getHomeBaseDir() {
    return 21;
  }

  function isAbsolutePath(path) {
    var text = String(path || '');
    return text.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(text);
  }

  function readOptionsForPath(path) {
    return isAbsolutePath(path) ? {} : { baseDir: getHomeBaseDir() };
  }

  /* ── chrome.storage.local KV helpers (SQLite-backed on Desktop) ──── */
  function readKv(key) {
    return new Promise(function (resolve) {
      try {
        if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) { resolve(null); return; }
        global.chrome.storage.local.get([key], function (items) {
          resolve(items && Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null);
        });
      } catch (_) { resolve(null); }
    });
  }
  function writeKv(key, value) {
    return new Promise(function (resolve, reject) {
      try {
        if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) {
          reject(new Error('chrome.storage.local unavailable'));
          return;
        }
        var item = {}; item[key] = value;
        global.chrome.storage.local.set(item, function () {
          var lastErr = global.chrome.runtime && global.chrome.runtime.lastError;
          if (lastErr) reject(new Error(String(lastErr.message || lastErr)));
          else resolve();
        });
      } catch (e) { reject(e); }
    });
  }

  /* ── Defaults ─────────────────────────────────────────────────────── */
  /* An ABSENT config means "never configured", not "historically opted in".
   * A fresh Desktop identity (new bundle id / new app-local store) has no
   * persisted CONFIG_KEY, so this default is what it boots with: it must be
   * unconfigured and non-mutating — no watcher, no source-folder read, no
   * automatic import. Seeding mode 'auto' + the shared HOME-relative
   * SYNC_FOLDER_NAME here made every fresh identity silently import whatever
   * $HOME/H2O Studio Sync/chrome-latest.json held.
   * Explicitly persisted configs are unaffected: getConfig() merges the
   * persisted record over this base, the Phase 3 legacy manual->auto
   * migration keys off a persisted mode, and an explicit 'auto' with no
   * folder still falls back to SYNC_FOLDER_NAME below. */
  function defaultConfig() {
    return {
      schemaVersion: 1,
      mode: 'off',
      folderPath: '',
      phase3AutoSyncConfigVersion: PHASE3_AUTO_IMPORT_CONFIG_VERSION,
      updatedAt: ''
    };
  }
  function defaultLedger() {
    return { schemaVersion: 1, updatedAt: '', entries: [] };
  }

  /* ── Config API ───────────────────────────────────────────────────── */
  async function getConfig() {
    var raw = await readKv(CONFIG_KEY);
    var base = defaultConfig();
    if (!raw || typeof raw !== 'object') {
      state.lastAutoImportConfigMode = '';
      state.lastAutoImportEffectiveMode = String(base.mode || '');
      state.lastAutoImportConfigMigration = '';
      return base;
    }
    var merged = Object.assign(base, raw);
    var rawMode = String(raw.mode || '').trim();
    var legacyManual = raw.phase3AutoSyncConfigVersion !== PHASE3_AUTO_IMPORT_CONFIG_VERSION
      && rawMode === 'manual';
    if (legacyManual) {
      merged.mode = 'auto';
      merged.phase3AutoSyncConfigVersion = PHASE3_AUTO_IMPORT_CONFIG_VERSION;
      merged.autoImportMigration = 'phase3-legacy-manual-to-auto';
    }
    if (VALID_MODES.indexOf(merged.mode) < 0) merged.mode = 'off';
    merged.folderPath = String(merged.folderPath || '').trim();
    if (merged.mode === 'auto' && !merged.folderPath) merged.folderPath = SYNC_FOLDER_NAME;
    state.lastAutoImportConfigMode = rawMode || '';
    state.lastAutoImportEffectiveMode = String(merged.mode || '');
    state.lastAutoImportConfigMigration = String(merged.autoImportMigration || '');
    return merged;
  }
  async function setConfig(patch) {
    var current = await getConfig();
    var next = Object.assign({}, current, (patch && typeof patch === 'object') ? patch : {});
    if (VALID_MODES.indexOf(next.mode) < 0) next.mode = 'off';
    next.folderPath = String(next.folderPath || '').trim();
    if (next.mode === 'auto' && !next.folderPath) next.folderPath = SYNC_FOLDER_NAME;
    next.schemaVersion = 1;
    next.phase3AutoSyncConfigVersion = PHASE3_AUTO_IMPORT_CONFIG_VERSION;
    delete next.autoImportMigration;
    next.updatedAt = new Date().toISOString();
    try { await writeKv(CONFIG_KEY, next); }
    catch (e) { pushErr('setConfig', e); throw e; }
    /* M2d-1b: auto-manage watcher based on mode + folderPath. In auto
     * mode the watcher imports stable chrome-latest.json candidates. */
    try { reconcileWatcherFromConfig(next, current); }
    catch (e) { pushWatcherErr('setConfig.reconcile', e); }
    return next;
  }

  /* ── Ledger API ───────────────────────────────────────────────────── */
  async function getLedger() {
    var raw = await readKv(LEDGER_KEY);
    var base = defaultLedger();
    if (!raw || typeof raw !== 'object') return base;
    return Object.assign(base, raw, {
      entries: Array.isArray(raw.entries) ? raw.entries : [],
    });
  }
  async function clearLedger() {
    var blank = defaultLedger();
    blank.updatedAt = new Date().toISOString();
    try { await writeKv(LEDGER_KEY, blank); }
    catch (e) { pushErr('clearLedger', e); throw e; }
    return blank;
  }
  async function appendLedgerEntry(entry) {
    var ledger = await getLedger();
    ledger.entries.push(entry);
    if (ledger.entries.length > MAX_LEDGER_ENTRIES) {
      ledger.entries = ledger.entries.slice(-MAX_LEDGER_ENTRIES);
    }
    ledger.updatedAt = new Date().toISOString();
    try { await writeKv(LEDGER_KEY, ledger); }
    catch (e) { pushErr('appendLedgerEntry', e); /* don't throw — caller already has the entry */ }
    return entry;
  }

  /* ── tauri-plugin-fs helpers ──────────────────────────────────────── */
  function fsReadDir(path) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable'));
    var options = readOptionsForPath(path);
    return invoke('plugin:fs|read_dir', { path: path, options: options }).catch(function (error) {
      if (Object.keys(options).length === 0) throw error;
      return invoke('plugin:fs|read_dir', { path: path });
    });
  }
  /* tauri-plugin-fs v2 ships two reader commands:
   *   plugin:fs|read_text_file  — Rust returns String
   *   plugin:fs|read_file       — Rust returns Vec<u8>  (number[] over JSON)
   * BUT some V2 builds / serialization paths surface read_text_file ALSO
   * as a byte array (Vec<u8> → number[]). Passing that array straight to
   * JSON.parse / TextEncoder.encode produces garbage ("[123,10,...]") and
   * the bundle import fails with json-parse-failed even on a valid file.
   * Defensive: try read_text_file, fall back to read_file on error, then
   * coerce whatever shape we got through decodeToText. */
  async function fsReadTextFile(path) {
    var invoke = getInvoke();
    if (!invoke) throw new Error('tauri invoke unavailable');
    var raw;
    var options = readOptionsForPath(path);
    try {
      raw = await invoke('plugin:fs|read_text_file', { path: path, options: options });
    } catch (textErr) {
      try {
        raw = await invoke('plugin:fs|read_file', { path: path, options: options });
      } catch (bytesErr) {
        if (Object.keys(options).length > 0) {
          try {
            raw = await invoke('plugin:fs|read_text_file', { path: path });
            return decodeToText(raw, path);
          } catch (_) { /* preserve original paired error below */ }
        }
        /* Surface the original text-read error since it's the canonical
         * path; include the bytes-read fallback error as context. */
        var msg = String((textErr && textErr.message) || textErr)
          + ' / fallback read_file failed: ' + String((bytesErr && bytesErr.message) || bytesErr);
        throw new Error(msg);
      }
    }
    return decodeToText(raw, path);
  }

  /* Coerce any tauri-plugin-fs read return into a UTF-8 string. Accepts:
   *   - string                  (read_text_file happy path)
   *   - Uint8Array               (raw byte view)
   *   - ArrayBuffer              (raw buffer)
   *   - number[]                 (Vec<u8> over JSON — most common alternate)
   *   - ArrayBufferView (other)  (DataView / Uint8ClampedArray)
   * Throws an informative Error for anything else so the caller can record
   * a useful diagnostic. */
  function decodeToText(raw, contextPath) {
    if (raw == null) {
      throw new Error('decodeToText: null/undefined response (path=' + String(contextPath || '') + ')');
    }
    if (typeof raw === 'string') return raw;
    if (raw instanceof Uint8Array) {
      return new TextDecoder('utf-8').decode(raw);
    }
    if (raw instanceof ArrayBuffer) {
      return new TextDecoder('utf-8').decode(new Uint8Array(raw));
    }
    if (Array.isArray(raw)) {
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i += 1) {
        var v = raw[i];
        if (typeof v !== 'number' || v < 0 || v > 255 || (v | 0) !== v) {
          throw new Error('decodeToText: array element ' + i + ' is not a byte (got ' + typeof v + ' = ' + JSON.stringify(v).slice(0, 32) + ')');
        }
        bytes[i] = v;
      }
      return new TextDecoder('utf-8').decode(bytes);
    }
    if (raw && typeof raw === 'object' && typeof raw.byteLength === 'number' && raw.buffer instanceof ArrayBuffer) {
      /* DataView, Uint8ClampedArray, Int8Array etc. */
      return new TextDecoder('utf-8').decode(new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength));
    }
    var ctor = (raw && raw.constructor && raw.constructor.name) || typeof raw;
    throw new Error('decodeToText: unsupported response type ' + ctor + ' (typeof=' + typeof raw + ')');
  }

  /* ── Filename matcher ─────────────────────────────────────────────── */
  function isCandidateFilename(name) {
    var s = String(name || '');
    if (!s) return false;
    if (s.charAt(0) === '.') return false; /* hidden files */
    var lower = s.toLowerCase();
    for (var i = 0; i < IGNORE_SUFFIXES.length; i += 1) {
      if (lower.indexOf(IGNORE_SUFFIXES[i], lower.length - IGNORE_SUFFIXES[i].length) !== -1) return false;
    }
    for (var j = 0; j < FILENAME_PATTERNS.length; j += 1) {
      if (FILENAME_PATTERNS[j].test(s)) return true;
    }
    return false;
  }

  /* ── Path join (cross-platform best-effort) ──────────────────────── */
  function joinPath(folder, name) {
    var f = String(folder || '');
    if (!f) return String(name || '');
    var last = f.charAt(f.length - 1);
    if (last === '/' || last === '\\') return f + name;
    var sep = (f.indexOf('\\') >= 0 && f.indexOf('/') < 0) ? '\\' : '/';
    return f + sep + name;
  }
  function basename(path) {
    var p = String(path || '');
    var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return (i >= 0) ? p.slice(i + 1) : p;
  }

  /* ── SHA256 via Web Crypto ────────────────────────────────────────── */
  async function sha256Hex(text) {
    if (!global.crypto || !global.crypto.subtle || typeof global.crypto.subtle.digest !== 'function') {
      throw new Error('crypto.subtle.digest unavailable');
    }
    var enc = new TextEncoder().encode(String(text || ''));
    var hash = await global.crypto.subtle.digest('SHA-256', enc);
    var bytes = new Uint8Array(hash);
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      var v = bytes[i].toString(16);
      if (v.length < 2) v = '0' + v;
      out += v;
    }
    return out;
  }

  /* ── scanFolderOnce ───────────────────────────────────────────────── */
  /* Lists folder, matches filenames, fingerprints each, dedupes against
   * ledger, dry-runs the candidate, and returns a list of import candidates.
   * Does NOT import. Failure cases for individual files become entries
   * with a `skipped` reason so the UI can surface them. */
  async function scanFolderOnce(folderPathArg) {
    var config = await getConfig();
    var folderPath = String(folderPathArg || config.folderPath || '').trim();
    if (!folderPath) return { ok: false, error: 'folderPath-required' };

    state.lastScanAt = new Date().toISOString();

    var entries;
    try { entries = await fsReadDir(folderPath); }
    catch (e) {
      pushErr('scan.readDir', e);
      return { ok: false, error: 'read-dir-failed', detail: String((e && e.message) || e), folderPath: folderPath };
    }

    var files = (Array.isArray(entries) ? entries : [])
      .filter(function (e) {
        /* tauri-plugin-fs returns { name, isDirectory, isFile, isSymlink, … }.
         * Defensive: accept anything where isDirectory !== true and the
         * name matches the candidate pattern. */
        if (!e || typeof e !== 'object') return false;
        if (e.isDirectory === true) return false;
        return isCandidateFilename(e.name);
      });

    var ledger = await getLedger();
    var seenFingerprints = Object.create(null);
    ledger.entries.forEach(function (le) { if (le && le.fingerprint) seenFingerprints[le.fingerprint] = true; });

    var ingestion = (H2O.Studio && H2O.Studio.ingestion) || null;
    var candidates = [];

    for (var i = 0; i < files.length; i += 1) {
      var f = files[i];
      var filePath = joinPath(folderPath, f.name);
      var fileText = null;
      try { fileText = await fsReadTextFile(filePath); }
      catch (e) {
        pushErr('scan.readFile', e);
        candidates.push({
          filename: f.name, path: filePath, skipped: 'read-failed',
          error: String((e && e.message) || e),
        });
        continue;
      }
      var sizeBytes = (typeof fileText === 'string') ? fileText.length : 0;
      if (sizeBytes > MAX_FILE_SIZE_BYTES) {
        candidates.push({ filename: f.name, path: filePath, sizeBytes: sizeBytes, skipped: 'too-large' });
        continue;
      }
      var fingerprint = '';
      try { fingerprint = await sha256Hex(fileText); }
      catch (e) {
        candidates.push({ filename: f.name, path: filePath, sizeBytes: sizeBytes, skipped: 'fingerprint-failed', error: String((e && e.message) || e) });
        continue;
      }
      if (seenFingerprints[fingerprint]) {
        candidates.push({ filename: f.name, path: filePath, sizeBytes: sizeBytes, fingerprint: fingerprint, skipped: 'already-imported' });
        continue;
      }
      var bundle;
      try { bundle = JSON.parse(fileText); }
      catch (e) {
        /* Helpful diagnostic: include type + 80-char preview so future
         * read-shape regressions are obvious in the candidate report. */
        var preview = '';
        try { preview = (typeof fileText === 'string') ? fileText.slice(0, 80) : ''; }
        catch (_) { /* ignore */ }
        candidates.push({
          filename: f.name, path: filePath, sizeBytes: sizeBytes, fingerprint: fingerprint,
          skipped: 'json-parse-failed',
          error: String((e && e.message) || e),
          rawType: typeof fileText,
          preview: preview,
        });
        continue;
      }
      var dry = null;
      if (ingestion && typeof ingestion.dryRunImportBundle === 'function') {
        try { dry = await ingestion.dryRunImportBundle(bundle); }
        catch (e) {
          candidates.push({ filename: f.name, path: filePath, sizeBytes: sizeBytes, fingerprint: fingerprint, skipped: 'dry-run-failed', error: String((e && e.message) || e) });
          continue;
        }
        if (dry && dry.ok === false) {
          candidates.push({ filename: f.name, path: filePath, sizeBytes: sizeBytes, fingerprint: fingerprint, skipped: 'dry-run-rejected', dryRun: dry });
          continue;
        }
      } else {
        pushWarn('scan', 'H2O.Studio.ingestion.dryRunImportBundle unavailable; including candidate without validation');
      }
      candidates.push({
        filename: f.name,
        path: filePath,
        sizeBytes: sizeBytes,
        fingerprint: fingerprint,
        exportedAt: (bundle && typeof bundle.exportedAt === 'string') ? bundle.exportedAt : '',
        dryRun: dry ? { ok: !!dry.ok, plan: dry.plan, sourceVersion: dry.sourceVersion } : null,
      });
    }

    return {
      ok: true,
      folderPath: folderPath,
      candidates: candidates,
      scannedFiles: files.length,
      ts: state.lastScanAt,
    };
  }

  /* ── Folder-only fast-path detector ────────────────────────────────
   *
   * Returns true when the parsed bundle clearly carries ONLY folder state
   * (no chats, no snapshots, no other entity sections). The folder-only
   * fast-path then routes through H2O.Studio.ingestion.importFolderStateOnly
   * (Phase A entry point), which skips the dryRunImportBundle full-bundle
   * validator (which would otherwise reject a folder-state payload because
   * it requires chatArchive.schema === 'h2o.chatArchive.bundle.v1').
   *
   * Three shapes are recognized — these mirror the input shapes
   * normalizeFolderStatePayload() inside import-bundle.tauri.js accepts:
   *
   *   (a) Raw folder-state:
   *         { folders: [...], items: { folderId: chatId[] }, ... }
   *       Recognized when `bundle.folders` is an array OR `bundle.items`
   *       is a plain object AND no `chatArchive.chats` are present.
   *
   *   (b) chromeStorageLocal wrapper containing only the folder-state key:
   *         { chromeStorageLocal: { 'h2o:prm:cgx:fldrs:state:data:v1': {...} } }
   *       Recognized when the wrapper carries the folder-state key AND
   *       no `chatArchive.chats` are present.
   *
   * Full bundles (schema=h2o.studio.fullBundle.v2 with non-empty
   * chatArchive.chats[]) return false even if they also carry folder
   * state — those continue to use the existing importBundle path so
   * chats / snapshots / catalogs are all processed end-to-end.
   *
   * Safety: this is a STRICT detector. When in doubt, return false so
   * the existing importBundle path runs. */
  var FOLDER_STATE_KEY_LOCAL = 'h2o:prm:cgx:fldrs:state:data:v1';
  function isFolderOnlyPayload(bundle) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return false;
    var chats = bundle.chatArchive && bundle.chatArchive.chats;
    if (Array.isArray(chats) && chats.length > 0) return false;
    /* Shape (a): raw folder-state object. */
    if (Array.isArray(bundle.folders)) return true;
    if (bundle.items && typeof bundle.items === 'object' && !Array.isArray(bundle.items)) return true;
    /* Shape (b): chromeStorageLocal wrapper with folder-state key. */
    var csl = bundle.chromeStorageLocal;
    if (csl && typeof csl === 'object' && !Array.isArray(csl)) {
      var folderState = csl[FOLDER_STATE_KEY_LOCAL];
      if (folderState && typeof folderState === 'object'
          && (Array.isArray(folderState.folders) || (folderState.items && typeof folderState.items === 'object'))) {
        return true;
      }
    }
    return false;
  }

  function cloneJson(value) {
    if (typeof value === 'undefined') return undefined;
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { return null; }
  }

  function addUnique(list, code) {
    var normalized = String(code || '').trim();
    if (normalized && list.indexOf(normalized) === -1) list.push(normalized);
  }

  function cleanString(value) {
    return String(value == null ? '' : value).trim();
  }

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function numberOrZero(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
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

  function safeMetadataRequestHash(value) {
    var text = cleanString(value).toLowerCase();
    return /^[a-f0-9]{64}$/.test(text) ? text : '';
  }

  var NON_DESTRUCTIVE_CLEAR_ALLOWLIST = new Set(['chat-category-clear', 'chat-label-unbind', 'chat-tag-unbind']);
  var APPLIED_LIBRARY_METADATA_MUTATION_REQUEST_ACTIONS = {
    'chat-category-assign': true,
    'chat-category-clear': true,
    'chat-label-bind': true,
    'chat-tag-bind': true,
    'chat-label-unbind': true,
    'chat-tag-unbind': true
  };

  function libraryMetadataMutationApplyRuntimeDiagnostic() {
    return {
      schema: 'h2o.studio.library-metadata-mutation.apply-runtime-diagnostic.v1',
      phase: 'phase14g-live-runtime-apply-consistency',
      sourceFile: 'sync/folder-sync.tauri.js',
      appliedRequestTypes: Object.keys(APPLIED_LIBRARY_METADATA_MUTATION_REQUEST_ACTIONS)
        .filter(function (action) { return APPLIED_LIBRARY_METADATA_MUTATION_REQUEST_ACTIONS[action] === true; })
        .sort(),
      nonDestructiveClearAllowlist: Array.from(NON_DESTRUCTIVE_CLEAR_ALLOWLIST).sort(),
      chatCategoryClear: {
        enabled: APPLIED_LIBRARY_METADATA_MUTATION_REQUEST_ACTIONS['chat-category-clear'] === true,
        exactAction: 'chat-category-clear',
        appliesVia: 'H2O.Studio.store.categories.clearChat(chatId)',
        verifiesCanonicalChatRowAfterClear: true,
        rejectsIfCategoryStillPresent: true,
        rejectsIfProjectionNotDecremented: true,
        duplicateDetectionUsesCurrentCanonicalState: true,
        staleAppliedReceiptDoesNotMaskCanonicalState: true,
        noDelete: true,
        noPurge: true,
        noChromeCanonicalMutation: true
      },
      chatLabelBind: {
        enabled: APPLIED_LIBRARY_METADATA_MUTATION_REQUEST_ACTIONS['chat-label-bind'] === true,
        exactAction: 'chat-label-bind',
        appliesVia: 'H2O.Studio.store.labels.bindChat(labelId, chatId)',
        verifiesCanonicalLabelBindingAfterBind: true,
        rejectsIfChatMissing: true,
        rejectsIfLabelMissing: true,
        rejectsIfProjectionNotIncremented: true,
        duplicateDetectionUsesCurrentCanonicalState: true,
        noDelete: true,
        noPurge: true,
        noChromeCanonicalMutation: true
      },
      chatTagBind: {
        enabled: APPLIED_LIBRARY_METADATA_MUTATION_REQUEST_ACTIONS['chat-tag-bind'] === true,
        exactAction: 'chat-tag-bind',
        appliesVia: 'H2O.Studio.store.tags.bindChat(tagId, chatId)',
        verifiesCanonicalTagBindingAfterBind: true,
        rejectsIfChatMissing: true,
        rejectsIfTagMissing: true,
        rejectsIfProjectionNotIncremented: true,
        duplicateDetectionUsesCurrentCanonicalState: true,
        noDelete: true,
        noPurge: true,
        noChromeCanonicalMutation: true
      },
      chatLabelUnbind: {
        enabled: APPLIED_LIBRARY_METADATA_MUTATION_REQUEST_ACTIONS['chat-label-unbind'] === true,
        exactAction: 'chat-label-unbind',
        appliesVia: 'H2O.Studio.store.labels.unbindChat(labelId, chatId)',
        verifiesCanonicalLabelBindingAfterUnbind: true,
        rejectsIfChatMissing: true,
        rejectsIfLabelMissing: true,
        noopIfAlreadyUnbound: true,
        rejectsIfProjectionNotDecremented: true,
        duplicateDetectionUsesCurrentCanonicalState: true,
        noDelete: true,
        noPurge: true,
        noChromeCanonicalMutation: true
      },
      chatTagUnbind: {
        enabled: APPLIED_LIBRARY_METADATA_MUTATION_REQUEST_ACTIONS['chat-tag-unbind'] === true,
        exactAction: 'chat-tag-unbind',
        appliesVia: 'H2O.Studio.store.tags.unbindChat(tagId, chatId)',
        verifiesCanonicalTagBindingAfterUnbind: true,
        rejectsIfChatMissing: true,
        rejectsIfTagMissing: true,
        noopIfAlreadyUnbound: true,
        rejectsIfProjectionNotDecremented: true,
        duplicateDetectionUsesCurrentCanonicalState: true,
        noDelete: true,
        noPurge: true,
        noChromeCanonicalMutation: true
      },
      receiptContract: {
        appliedRequiresPostWriteCanonicalVerification: true,
        appliedRequiresProjectionHashChangeForClear: true,
        appliedRequiresProjectionHashChangeForBind: true,
        skippedDuplicateRequiresCurrentCanonicalTargetReached: true,
        appliedReceiptCanonicalMismatchWarning: 'library-metadata-mutation-request-applied-receipt-canonical-mismatch'
      },
      productSyncReady: false
    };
  }

  function addHealthCode(list, code) {
    addUnique(list, cleanString(code));
  }

  function addHealthCodeFromHardening(list, code) {
    var normalized = cleanString(code);
    if (!normalized) return;
    if (normalized === F19_SYNC_HARDENING_CODES.syncFolderMissing ||
        normalized === 'sync-folder-missing' ||
        normalized === 'library-propagation-folder-required') {
      addHealthCode(list, 'no-folder-handle');
      return;
    }
    if (normalized === F19_SYNC_HARDENING_CODES.permissionDenied ||
        normalized === 'permission-denied') {
      addHealthCode(list, 'permission-required');
      return;
    }
    if (normalized === F19_SYNC_HARDENING_CODES.transportFileMissing ||
        normalized === 'library-propagation-read-failed') {
      addHealthCode(list, 'transport-file-missing');
      return;
    }
    if (normalized === F19_SYNC_HARDENING_CODES.transportFileMalformed ||
        normalized === F19_SYNC_HARDENING_CODES.transportSchemaUnsupported ||
        normalized === 'library-propagation-json-parse-failed' ||
        normalized === 'library-propagation-schema-invalid') {
      addHealthCode(list, 'transport-file-malformed');
      return;
    }
    if (normalized === F19_SYNC_HARDENING_CODES.transportStale ||
        normalized === 'library-propagation-transport-stale') {
      addHealthCode(list, 'stale-transport');
      return;
    }
    if (normalized === F19_SYNC_HARDENING_CODES.simultaneousUpdateConflict ||
        normalized === 'library-propagation-simultaneous-update-conflict') {
      addHealthCode(list, 'simultaneous-conflict');
      return;
    }
    addHealthCode(list, normalized);
  }

  function addHealthCodesFromList(list, codes) {
    var source = Array.isArray(codes) ? codes : [];
    for (var i = 0; i < source.length; i += 1) addHealthCodeFromHardening(list, source[i]);
  }

  function addHealthCodesFromError(list, value) {
    var text = cleanString(value).toLowerCase();
    if (!text) return;
    if (text.indexOf('permission') !== -1 || text.indexOf('denied') !== -1) {
      addHealthCode(list, 'permission-required');
    }
    if (text.indexOf('folder-required') !== -1 || text.indexOf('folder missing') !== -1 ||
        text.indexOf('sync-folder-missing') !== -1) {
      addHealthCode(list, 'no-folder-handle');
    }
    if (text.indexOf('read-failed') !== -1 || text.indexOf('transport-file-missing') !== -1) {
      addHealthCode(list, 'transport-file-missing');
    }
    if (text.indexOf('malformed') !== -1 || text.indexOf('schema') !== -1) {
      addHealthCode(list, 'transport-file-malformed');
    }
    if (text.indexOf('stale') !== -1) {
      addHealthCode(list, 'stale-transport');
    }
    if (text.indexOf('simultaneous') !== -1 || text.indexOf('conflict') !== -1) {
      addHealthCode(list, 'simultaneous-conflict');
    }
  }

  function folderHealthVerdict(blockers, warnings, pending, inFlight, disabled) {
    if (disabled) return 'disabled';
    if (Array.isArray(blockers) && blockers.length) return 'blocked';
    if (pending || inFlight) return 'syncing';
    if (Array.isArray(warnings) && warnings.indexOf('loop-suppressed') !== -1) return 'degraded';
    if (Array.isArray(warnings) && warnings.length) return 'warning';
    return 'healthy';
  }

  function folderHealthSummary(verdict) {
    if (verdict === 'healthy') return 'Folder sync is current and no blockers are active.';
    if (verdict === 'syncing') return 'Folder sync has pending or in-flight work.';
    if (verdict === 'blocked') return 'Folder sync is blocked; review blockers and permissions.';
    if (verdict === 'disabled') return 'Folder auto-sync is disabled on this surface.';
    if (verdict === 'degraded') return 'Folder sync is running with loop or refresh suppression active.';
    return 'Folder sync needs attention.';
  }

  function healthTimeMs(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    return parseTimeMs(value);
  }

  function healthEventTimeMs(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return healthTimeMs(value.at || value.detectedAt || value.updatedAt);
    }
    return healthTimeMs(value);
  }

  function isRecentHealthEvent(ms) {
    return !!(ms && Date.now() - ms >= 0 && Date.now() - ms <= HEALTH_SCHEDULER_EXPECTATION_WINDOW_MS);
  }

  function shouldReportDesktopSchedulerNotFired(autoExportRaw, autoExportDtc) {
    var raw = safeObject(autoExportRaw);
    var desktopToChrome = safeObject(autoExportDtc);
    if (desktopToChrome.pending || desktopToChrome.flushInFlight || raw.pending || raw.flushInFlight) return false;
    if (!(desktopToChrome.autoExportEnabled === true || raw.enabled === true || raw.folderMutationAutoSyncEnabled === true)) {
      return false;
    }
    var changeAt = healthEventTimeMs(raw.lastChange);
    if (!isRecentHealthEvent(changeAt)) return false;
    var scheduledAt = healthEventTimeMs(raw.lastScheduledAt || desktopToChrome.lastScheduledAt);
    var exportedAt = Math.max(
      healthEventTimeMs(raw.lastExportAt),
      healthEventTimeMs(raw.lastExportedAt),
      healthEventTimeMs(desktopToChrome.lastExportedAt)
    );
    return scheduledAt < changeAt && exportedAt < changeAt;
  }

  function normalizeUnindexedReason(value) {
    var text = cleanString(value);
    if (text === 'archived' || text === 'not-indexed' || text === 'unknown-unindexed') return text;
    return 'unknown-unindexed';
  }

  function sanitizeUnindexedManifestRow(entry) {
    var row = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    return {
      rowHash: cleanString(row.rowHash),
      chatIdHash: cleanString(row.chatIdHash),
      snapshotIdHash: cleanString(row.snapshotIdHash),
      rowClass: cleanString(row.rowClass || 'unknown') || 'unknown',
      reason: normalizeUnindexedReason(row.reason),
      hasSnapshotId: row.hasSnapshotId === true,
      hasSnapshots: row.hasSnapshots === true,
      isSaved: row.isSaved === true,
      isLinked: row.isLinked === true,
      isPinned: row.isPinned === true,
      isArchived: row.isArchived === true
    };
  }

  function sanitizeUnindexedManifestForChromeDesktop(bundle) {
    var diagnostics = bundle && bundle.diagnostics && typeof bundle.diagnostics === 'object' && !Array.isArray(bundle.diagnostics)
      ? bundle.diagnostics : {};
    var manifest = diagnostics.unindexedRowManifest && typeof diagnostics.unindexedRowManifest === 'object' && !Array.isArray(diagnostics.unindexedRowManifest)
      ? diagnostics.unindexedRowManifest : {};
    var sourceRows = Array.isArray(manifest.rows) ? manifest.rows
      : (Array.isArray(diagnostics.unindexedRows) ? diagnostics.unindexedRows : []);
    var rows = sourceRows.map(sanitizeUnindexedManifestRow);
    var reasonCounts = Object.create(null);
    rows.forEach(function (row) {
      var reason = normalizeUnindexedReason(row.reason);
      reasonCounts[reason] = Number(reasonCounts[reason] || 0) + 1;
    });
    return {
      schema: cleanString(manifest.schema || 'h2o.studio.sync.chrome-export-unindexed-rows.v1'),
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

  function sanitizeFolderDeleteRequestForChromeDesktop(row) {
    var request = safeObject(row);
    if (cleanString(request.schema) !== FOLDER_DELETE_REQUEST_SCHEMA) return null;
    if (cleanString(request.intent) !== 'folder-soft-delete-request') return null;
    if (cleanString(request.status) !== 'pending') return null;
    if (request.desktopApplyRequired !== true) return null;
    var folderId = cleanString(request.folderId || request.recordId);
    var requestId = cleanString(request.requestId || request.reviewId);
    if (!folderId || !requestId) return null;
    return {
      schema: FOLDER_DELETE_REQUEST_SCHEMA,
      requestId: requestId,
      reviewId: cleanString(request.reviewId || requestId) || requestId,
      recordKind: 'folder',
      intent: 'folder-soft-delete-request',
      classification: 'delete-request',
      folderId: folderId,
      folderName: cleanString(request.folderName || request.folderNameAtRequest) || null,
      folderNameAtRequest: cleanString(request.folderNameAtRequest || request.folderName) || null,
      normalizedNameAtRequest: cleanString(request.normalizedNameAtRequest) || null,
      requestedAt: cleanString(request.requestedAt) || null,
      requestedBy: cleanString(request.requestedBy || 'chrome-studio') || 'chrome-studio',
      sourceSurface: cleanString(request.sourceSurface || 'chrome-studio') || 'chrome-studio',
      sourcePeerId: cleanString(request.sourcePeerId || 'chrome-studio') || 'chrome-studio',
      status: 'pending',
      reason: cleanString(request.reason || 'user-requested-folder-delete') || 'user-requested-folder-delete',
      noHardDelete: true,
      noChatDelete: true,
      desktopApplyRequired: true,
      noLocalApply: true,
      noFolderMutation: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      advisory: request.advisory && typeof request.advisory === 'object' && !Array.isArray(request.advisory)
        ? cloneJson(request.advisory) : null,
      transportedAt: cleanString(request.transportedAt) || null,
    };
  }

  function sanitizeFolderDeleteRequestsForChromeDesktop(bundle, warnings) {
    if (!bundle || !Object.prototype.hasOwnProperty.call(bundle, 'folderDeleteRequests')) return [];
    if (!Array.isArray(bundle.folderDeleteRequests)) {
      addUnique(warnings, 'folder-delete-requests-section-invalid');
      return [];
    }
    var out = [];
    bundle.folderDeleteRequests.forEach(function (row) {
      var request = sanitizeFolderDeleteRequestForChromeDesktop(row);
      if (request) out.push(request);
      else addUnique(warnings, 'folder-delete-request-skipped-invalid');
    });
    return out;
  }

  function sanitizeFolderRestoreRequestForChromeDesktop(row) {
    var request = safeObject(row);
    if (cleanString(request.schema) !== FOLDER_RESTORE_REQUEST_SCHEMA) return null;
    if (cleanString(request.intent) !== 'folder-restore-request') return null;
    if (cleanString(request.status) !== 'pending') return null;
    if (request.desktopRestoreRequired !== true && request.desktopApplyRequired !== true) return null;
    var folderId = cleanString(request.folderId || request.recordId);
    var requestId = cleanString(request.requestId || request.reviewId);
    if (!folderId || !requestId) return null;
    return {
      schema: FOLDER_RESTORE_REQUEST_SCHEMA,
      requestId: requestId,
      reviewId: cleanString(request.reviewId || requestId) || requestId,
      recordKind: 'folder',
      intent: 'folder-restore-request',
      classification: 'restore-request',
      folderId: folderId,
      folderName: cleanString(request.folderName || request.folderNameAtRequest) || null,
      folderNameAtRequest: cleanString(request.folderNameAtRequest || request.folderName) || null,
      tombstoneId: cleanString(request.tombstoneId) || null,
      receiptId: cleanString(request.receiptId) || null,
      requestedAt: cleanString(request.requestedAt || request.createdAt) || null,
      createdAt: cleanString(request.createdAt || request.requestedAt) || null,
      requestedBy: cleanString(request.requestedBy || 'chrome-studio') || 'chrome-studio',
      source: cleanString(request.source || 'chrome-studio') || 'chrome-studio',
      sourceSurface: cleanString(request.sourceSurface || 'chrome-studio') || 'chrome-studio',
      sourcePeerId: cleanString(request.sourcePeerId || 'chrome-studio') || 'chrome-studio',
      status: 'pending',
      reason: cleanString(request.reason || 'user-requested-folder-restore') || 'user-requested-folder-restore',
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
      advisory: request.advisory && typeof request.advisory === 'object' && !Array.isArray(request.advisory)
        ? cloneJson(request.advisory) : null,
      transportedAt: cleanString(request.transportedAt || request.mirroredAt) || null,
    };
  }

  function sanitizeFolderRestoreRequestsForChromeDesktop(bundle, warnings) {
    if (!bundle || !Object.prototype.hasOwnProperty.call(bundle, 'folderRestoreRequests')) return [];
    if (!Array.isArray(bundle.folderRestoreRequests)) {
      addUnique(warnings, 'folder-restore-requests-section-invalid');
      return [];
    }
    var out = [];
    bundle.folderRestoreRequests.forEach(function (row) {
      var request = sanitizeFolderRestoreRequestForChromeDesktop(row);
      if (request) out.push(request);
      else addUnique(warnings, 'folder-restore-request-skipped-invalid');
    });
    return out;
  }

  function sanitizeChatFolderBindingRequestForChromeDesktop(row) {
    var request = safeObject(row);
    if (cleanString(request.schema) !== CHAT_FOLDER_BINDING_REQUEST_SCHEMA) return null;
    if (cleanString(request.recordKind) !== 'folderBinding') return null;
    if (cleanString(request.intent) !== 'chat-folder-binding-request') return null;
    if (cleanString(request.classification) !== 'binding-request') return null;
    if (cleanString(request.status) !== 'pending') return null;
    if (request.desktopApplyRequired !== true) return null;
    if (request.noLocalApply !== true) return null;
    var chatId = cleanString(request.chatId || request.conversationId || request.recordId);
    var requestId = cleanString(request.requestId || request.reviewId);
    if (!chatId || !requestId) return null;
    var targetKind = cleanString(request.targetKind || (request.targetUnfiled === true ? 'unfiled' : 'folder')) || 'folder';
    var targetUnfiled = targetKind === 'unfiled' || request.targetUnfiled === true;
    var targetFolderId = targetUnfiled ? '' : cleanString(request.targetFolderId || request.folderId);
    if (!targetUnfiled && !targetFolderId) return null;
    return {
      schema: CHAT_FOLDER_BINDING_REQUEST_SCHEMA,
      requestId: requestId,
      reviewId: cleanString(request.reviewId || requestId) || requestId,
      recordKind: 'folderBinding',
      intent: 'chat-folder-binding-request',
      classification: 'binding-request',
      chatId: chatId,
      conversationId: cleanString(request.conversationId || chatId) || chatId,
      expectedCurrentFolderId: cleanString(request.expectedCurrentFolderId || request.currentFolderId) || null,
      targetFolderId: targetUnfiled ? null : targetFolderId,
      targetKind: targetUnfiled ? 'unfiled' : 'folder',
      targetUnfiled: targetUnfiled,
      requestedAt: cleanString(request.requestedAt || request.createdAt) || null,
      createdAt: cleanString(request.createdAt || request.requestedAt) || null,
      requestedBy: cleanString(request.requestedBy || 'chrome-studio') || 'chrome-studio',
      source: cleanString(request.source || 'chrome-studio') || 'chrome-studio',
      sourceSurface: cleanString(request.sourceSurface || 'chrome-studio') || 'chrome-studio',
      sourcePeerId: cleanString(request.sourcePeerId || 'chrome-studio') || 'chrome-studio',
      status: 'pending',
      reason: cleanString(request.reason || 'user-requested-chat-folder-binding-change') || 'user-requested-chat-folder-binding-change',
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
      advisory: request.advisory && typeof request.advisory === 'object' && !Array.isArray(request.advisory)
        ? cloneJson(request.advisory) : null,
      transportedAt: cleanString(request.transportedAt || request.mirroredAt) || null,
    };
  }

  function sanitizeChatFolderBindingRequestsForChromeDesktop(bundle, warnings) {
    if (!bundle || !Object.prototype.hasOwnProperty.call(bundle, 'chatFolderBindingRequests')) return [];
    if (!Array.isArray(bundle.chatFolderBindingRequests)) {
      addUnique(warnings, 'chat-folder-binding-requests-section-invalid');
      return [];
    }
    var out = [];
    bundle.chatFolderBindingRequests.forEach(function (row) {
      var request = sanitizeChatFolderBindingRequestForChromeDesktop(row);
      if (request) out.push(request);
      else addUnique(warnings, 'chat-folder-binding-request-skipped-invalid');
    });
    return out;
  }

  function normalizeLibraryMetadataMutationRequestAction(input) {
    var source = safeObject(input);
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

  function libraryMetadataMutationRequestActionSpec(action) {
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

  function libraryMetadataMutationRequestDestructiveAction(action) {
    var normalized = cleanString(action);
    return /(delete|remove|unbind|clear|purge|hard-delete)/i.test(normalized) &&
      !NON_DESTRUCTIVE_CLEAR_ALLOWLIST.has(normalized);
  }

  function sanitizeLibraryMetadataMutationRequestForChromeDesktop(row) {
    var request = safeObject(row);
    if (cleanString(request.schema) !== LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA) return null;
    if (cleanString(request.intent) !== 'library-metadata-mutation-request') return null;
    if (cleanString(request.classification) !== 'metadata-request') return null;
    if (cleanString(request.status) !== 'pending') return null;
    if (request.desktopApplyRequired !== true || request.noLocalApply !== true) return null;
    if (request.noChromeCanonicalMutation !== true || request.noDesktopCanonicalMutation !== true) return null;
    if (request.chromeAuthority !== false || request.desktopAuthority !== true || request.requestOnly !== true) return null;
    if (request.separateFromDesktopCanonicalLibraryMetadata !== true) return null;
    if (request.noHardDelete !== true || request.noPurge !== true || request.noChatDelete !== true ||
        request.noSnapshotDelete !== true || request.noAssetDelete !== true) return null;
    if (request.noLabelDelete !== true || request.noTagDelete !== true ||
        request.noCategoryDelete !== true || request.noMetadataDelete !== true) return null;
    var privacy = safeObject(request.privacy);
    if (privacy.rawChatContent !== false || privacy.rawChatTitles !== false ||
        privacy.accountLinkedMetadata !== false) return null;
    var action = normalizeLibraryMetadataMutationRequestAction(request);
    if (libraryMetadataMutationRequestDestructiveAction(action)) return null;
    var spec = libraryMetadataMutationRequestActionSpec(action);
    if (!spec) return null;
    var requestId = safeMetadataRequestId(request.requestId || request.reviewId);
    if (!requestId) return null;
    var payload = safeObject(request.payload);
    var chatId = safeMetadataRequestId(payload.chatId || payload.conversationId);
    var entityId = safeMetadataRequestId(payload.entityId || payload.labelId || payload.tagId ||
      payload.categoryId || payload.classificationId);
    var displayName = safeMetadataRequestName(payload.displayName);
    if (action === 'chat-category-clear') {
      entityId = '';
      displayName = '';
    }
    if (spec.requiresChatId && !chatId) return null;
    if (spec.requiresId && !entityId) return null;
    if (spec.requiresName && !displayName) return null;
    return {
      schema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA,
      version: cleanString(request.version || '0.1.0-phase6'),
      phase: 'phase6-chrome-request-export',
      requestId: requestId,
      reviewId: safeMetadataRequestId(request.reviewId || requestId) || requestId,
      idempotencyKey: cleanString(request.idempotencyKey),
      intent: 'library-metadata-mutation-request',
      classification: 'metadata-request',
      requestType: action,
      action: action,
      operation: spec.operation,
      metadataKind: spec.metadataKind,
      subjectKind: spec.subjectKind,
      status: 'pending',
      createdAt: cleanString(request.createdAt || request.requestedAt) || null,
      requestedAt: cleanString(request.requestedAt || request.createdAt) || null,
      requestedBy: 'chrome-studio',
      source: 'chrome-studio',
      sourceSurface: 'chrome-studio',
      sourcePeerId: safeMetadataRequestId(request.sourcePeerId || 'chrome-studio') || 'chrome-studio',
      expectedCurrentBasisHash: safeMetadataRequestHash(request.expectedCurrentBasisHash),
      expectedCurrentBasis: safeObject(request.expectedCurrentBasis),
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
      transportedAt: cleanString(request.transportedAt || request.mirroredAt) || null,
    };
  }

  function sanitizeLibraryMetadataMutationRequestsForChromeDesktop(bundle, warnings) {
    if (!bundle || !Object.prototype.hasOwnProperty.call(bundle, 'libraryMetadataMutationRequests')) return [];
    if (!Array.isArray(bundle.libraryMetadataMutationRequests)) {
      addUnique(warnings, 'library-metadata-mutation-requests-section-invalid');
      return [];
    }
    var out = [];
    bundle.libraryMetadataMutationRequests.forEach(function (row) {
      var request = sanitizeLibraryMetadataMutationRequestForChromeDesktop(row);
      if (request) out.push(request);
      else addUnique(warnings, 'library-metadata-mutation-request-skipped-invalid');
    });
    return out;
  }

  function normalizeHardeningWarnings(warnings) {
    var out = Array.isArray(warnings) ? warnings.slice() : [];
    var legacyDeferred = [
      CHROME_DESKTOP_DEFERRED_CODES.labels,
      CHROME_DESKTOP_DEFERRED_CODES.tags,
      CHROME_DESKTOP_DEFERRED_CODES.projects,
      CHROME_DESKTOP_DEFERRED_CODES.folderBindings
    ];
    for (var i = 0; i < legacyDeferred.length; i += 1) {
      if (out.indexOf(legacyDeferred[i]) !== -1) addUnique(out, F19_SYNC_HARDENING_CODES.deferredFieldPresent);
    }
    if (out.indexOf(CHROME_DESKTOP_DEFERRED_CODES.unsupportedStorage) !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.unsupportedFieldPresent);
    }
    if (out.indexOf(CHROME_DESKTOP_DEFERRED_CODES.sourceMetadataMissing) !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.sourceMetadataMissing);
    }
    return out;
  }

  function normalizeHardeningBlockers(blockers) {
    var out = Array.isArray(blockers) ? blockers.slice() : [];
    if (out.indexOf('library-propagation-folder-required') !== -1 ||
        out.indexOf('library-propagation-path-required') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.syncFolderMissing);
    }
    if (out.indexOf('library-propagation-read-failed') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.transportFileMissing);
    }
    if (out.indexOf('library-propagation-json-parse-failed') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.transportFileMalformed);
    }
    if (out.indexOf('library-propagation-schema-invalid') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.transportSchemaUnsupported);
    }
    if (out.indexOf('library-propagation-transport-stale') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.transportStale);
    }
    if (out.indexOf('library-propagation-simultaneous-update-conflict') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.simultaneousUpdateConflict);
    }
    return out;
  }

  function parseTimeMs(value) {
    var clean = String(value || '').trim();
    if (!clean) return 0;
    var ms = Date.parse(clean);
    return isFinite(ms) ? ms : 0;
  }

  function latestPropagationLedgerEntry(ledger, mode) {
    var entries = Array.isArray(ledger && ledger.entries) ? ledger.entries : [];
    var latest = null;
    var latestMs = 0;
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      if (!entry || String(entry.mode || '') !== mode) continue;
      var ms = parseTimeMs(entry.bundleExportedAt || entry.importedAt || entry.detectedAt);
      if (!latest || ms >= latestMs) {
        latest = entry;
        latestMs = ms;
      }
    }
    return latest;
  }

  function classifyIncomingChromeTransport(bundle, ledger, fingerprint) {
    var blockers = [];
    var latest = latestPropagationLedgerEntry(ledger, 'f19-chrome-desktop');
    if (!latest || !bundle || typeof bundle !== 'object') return blockers;
    var incomingExportedAtMs = parseTimeMs(bundle.exportedAt);
    var latestExportedAtMs = parseTimeMs(latest.bundleExportedAt);
    var sameFingerprint = !!(fingerprint && latest.fingerprint && String(fingerprint) === String(latest.fingerprint));
    if (incomingExportedAtMs && latestExportedAtMs && incomingExportedAtMs < latestExportedAtMs && !sameFingerprint) {
      addUnique(blockers, 'library-propagation-transport-stale');
    }
    var previousExportId = String(bundle.previousExportId || '').trim();
    var latestExportId = String(latest.exportId || '').trim();
    if (previousExportId && latestExportId && previousExportId !== latestExportId && !sameFingerprint) {
      addUnique(blockers, 'library-propagation-simultaneous-update-conflict');
    }
    return blockers;
  }

  function hasAnyKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    for (var i = 0; i < keys.length; i += 1) {
      if (Object.prototype.hasOwnProperty.call(value, keys[i])) return true;
    }
    return false;
  }

  function countSnapshots(chats) {
    var total = 0;
    (Array.isArray(chats) ? chats : []).forEach(function (chat) {
      total += Array.isArray(chat && chat.snapshots) ? chat.snapshots.length : 0;
    });
    return total;
  }

  function countMinimalLibraryRows(chats) {
    var total = 0;
    (Array.isArray(chats) ? chats : []).forEach(function (chat) {
      var index = chat && chat.chatIndex && typeof chat.chatIndex === 'object' ? chat.chatIndex : {};
      if (index.f19MinimalLibraryIndexRow === true && !(Array.isArray(chat && chat.snapshots) && chat.snapshots.length > 0)) total += 1;
    });
    return total;
  }

  function countChatViews(chats) {
    var counts = { saved: 0, linked: 0, pinned: 0, archived: 0 };
    (Array.isArray(chats) ? chats : []).forEach(function (chat) {
      var index = chat && chat.chatIndex && typeof chat.chatIndex === 'object' ? chat.chatIndex : {};
      var stateObj = index.state && typeof index.state === 'object' ? index.state : {};
      var view = String(index.view || index.kind || index.type || '').toLowerCase();
      if (view === 'linked' || index.isLinked === true || stateObj.isLinked === true) counts.linked += 1;
      else counts.saved += 1;
      if (index.pinned === true || index.isPinned === true || stateObj.isPinned === true) counts.pinned += 1;
      if (index.archived === true || index.isArchived === true || stateObj.isArchived === true) counts.archived += 1;
    });
    return counts;
  }

  function sanitizeChatForChromeDesktop(chat, warnings) {
    var out = cloneJson(chat) || {};
    var chatIndex = out.chatIndex && typeof out.chatIndex === 'object' && !Array.isArray(out.chatIndex)
      ? out.chatIndex : null;
    if (chatIndex) {
      var org = chatIndex.organization && typeof chatIndex.organization === 'object' && !Array.isArray(chatIndex.organization)
        ? chatIndex.organization : null;
      if (org) {
        if (hasAnyKeys(org, ['labels', 'labelIds'])) addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.labels);
        if (hasAnyKeys(org, ['tags', 'tagIds'])) addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.tags);
        if (hasAnyKeys(org, ['projectId', 'projectIds', 'projects', 'gizmoId', 'workspaceId'])) {
          addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.projects);
        }
        var nextOrg = {};
        if (typeof org.categoryId !== 'undefined') nextOrg.categoryId = org.categoryId;
        if (typeof org.category_id !== 'undefined') nextOrg.category_id = org.category_id;
        if (typeof org.folderId !== 'undefined') nextOrg.folderId = org.folderId;
        if (typeof org.folder_id !== 'undefined') nextOrg.folder_id = org.folder_id;
        chatIndex.organization = nextOrg;
      }
    }
    return out;
  }

  function collectPerChatFolderBindings(chats) {
    var covered = Object.create(null);
    (Array.isArray(chats) ? chats : []).forEach(function (chat) {
      var index = chat && chat.chatIndex && typeof chat.chatIndex === 'object' ? chat.chatIndex : {};
      var org = index.organization && typeof index.organization === 'object' && !Array.isArray(index.organization)
        ? index.organization : {};
      var chatId = String((chat && chat.chatId) || index.chatId || index.id || '').trim();
      var folderId = String(org.folderId || org.folder_id || '').trim();
      if (!chatId || !folderId) return;
      covered[folderId + '\n' + chatId] = true;
    });
    return covered;
  }

  function folderStateForChromeDesktop(bundle, warnings, coveredPerChatBindings) {
    var source = bundle && bundle.chromeStorageLocal && bundle.chromeStorageLocal[FOLDER_STATE_KEY_LOCAL];
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    var folders = Array.isArray(source.folders) ? cloneJson(source.folders) : [];
    var items = source.items && typeof source.items === 'object' && !Array.isArray(source.items) ? source.items : {};
    var itemKeys = Object.keys(items);
    var covered = coveredPerChatBindings && typeof coveredPerChatBindings === 'object' ? coveredPerChatBindings : {};
    var hasUnsupportedLegacyBinding = false;
    for (var i = 0; i < itemKeys.length; i += 1) {
      var folderId = String(itemKeys[i] || '').trim();
      var chatIds = Array.isArray(items[itemKeys[i]]) ? items[itemKeys[i]] : [];
      for (var ci = 0; ci < chatIds.length; ci += 1) {
        var chatId = String(chatIds[ci] || '').trim();
        if (!chatId) continue;
        if (covered[folderId + '\n' + chatId] !== true) {
          hasUnsupportedLegacyBinding = true;
          break;
        }
      }
      if (hasUnsupportedLegacyBinding) break;
    }
    if (hasUnsupportedLegacyBinding) addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.folderBindings);
    return {
      schemaVersion: Number(source.schemaVersion || source.version || 1) || 1,
      exportedFrom: String(source.exportedFrom || source.source || 'chrome-studio'),
      exportedAt: String(source.exportedAt || source.updatedAt || ''),
      folders: folders,
      items: {}
    };
  }

  function buildChromeDesktopSupportedBundle(bundleInput) {
    var warnings = [];
    var blockers = [];
    var bundle = bundleInput && typeof bundleInput === 'object' && !Array.isArray(bundleInput)
      ? bundleInput : null;
    if (!bundle) {
      return { ok: false, blockers: ['library-propagation-bundle-invalid'], warnings: warnings };
    }
    if (String(bundle.schema || '').trim() !== FULL_BUNDLE_SCHEMA) {
      return { ok: false, blockers: ['library-propagation-schema-invalid'], warnings: warnings };
    }

    var chatArchive = bundle.chatArchive && typeof bundle.chatArchive === 'object' && !Array.isArray(bundle.chatArchive)
      ? bundle.chatArchive : {};
    var sourceCatalogs = chatArchive.catalogs && typeof chatArchive.catalogs === 'object' && !Array.isArray(chatArchive.catalogs)
      ? chatArchive.catalogs : {};
    var sourceChats = Array.isArray(chatArchive.chats) ? chatArchive.chats : [];
    var sourceCategories = Array.isArray(sourceCatalogs.categories) ? sourceCatalogs.categories : [];

    if (Array.isArray(sourceCatalogs.labels) && sourceCatalogs.labels.length > 0) {
      addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.labels);
    }
    if (Array.isArray(sourceCatalogs.tags) && sourceCatalogs.tags.length > 0) {
      addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.tags);
    }
    if (Array.isArray(bundle.libraryKv) && bundle.libraryKv.length > 0) {
      for (var kv = 0; kv < bundle.libraryKv.length; kv += 1) {
        var key = String(bundle.libraryKv[kv] && bundle.libraryKv[kv].key || '');
        if (key.indexOf(':labels:') !== -1) addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.labels);
        else addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.unsupportedStorage);
      }
    }
    if (bundle.chromeStorageLocal && typeof bundle.chromeStorageLocal === 'object' && !Array.isArray(bundle.chromeStorageLocal)) {
      Object.keys(bundle.chromeStorageLocal).forEach(function (key) {
        if (key !== FOLDER_STATE_KEY_LOCAL) addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.unsupportedStorage);
      });
    }
    if (bundle.projects || bundle.projectCatalog || bundle.workspaceProjects) {
      addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.projects);
    }
    if (!bundle.sourcePeerEnvelope && !bundle.sourceSyncPeerId) {
      addUnique(warnings, CHROME_DESKTOP_DEFERRED_CODES.sourceMetadataMissing);
    }

    var chats = sourceChats.map(function (chat) {
      return sanitizeChatForChromeDesktop(chat, warnings);
    });
    var chatViewCounts = countChatViews(chats);
    var categories = cloneJson(sourceCategories) || [];
    var folderState = folderStateForChromeDesktop(bundle, warnings, collectPerChatFolderBindings(chats));
    var chromeStorageLocal = {};
    if (folderState) chromeStorageLocal[FOLDER_STATE_KEY_LOCAL] = folderState;
    var unindexedManifest = sanitizeUnindexedManifestForChromeDesktop(bundle);
    var folderDeleteRequests = sanitizeFolderDeleteRequestsForChromeDesktop(bundle, warnings);
    var folderRestoreRequests = sanitizeFolderRestoreRequestsForChromeDesktop(bundle, warnings);
    var chatFolderBindingRequests = sanitizeChatFolderBindingRequestsForChromeDesktop(bundle, warnings);
    var libraryMetadataMutationRequests = sanitizeLibraryMetadataMutationRequestsForChromeDesktop(bundle, warnings);

    var supported = {
      schema: FULL_BUNDLE_SCHEMA,
      exportedAt: String(bundle.exportedAt || ''),
      exportId: String(bundle.exportId || ''),
      sequenceNumber: typeof bundle.sequenceNumber === 'number' ? bundle.sequenceNumber : null,
      previousExportId: bundle.previousExportId ? String(bundle.previousExportId) : null,
      contentSha256: bundle.contentSha256 ? String(bundle.contentSha256) : '',
      sourceSurfaceKind: String(bundle.sourceSurfaceKind || 'chrome-studio'),
      sourceAppKind: String(bundle.sourceAppKind || ''),
      sourceStoreKind: String(bundle.sourceStoreKind || ''),
      sourcePeerEnvelope: bundle.sourcePeerEnvelope && typeof bundle.sourcePeerEnvelope === 'object'
        ? cloneJson(bundle.sourcePeerEnvelope) : null,
      chatArchive: {
        schema: String(chatArchive.schema || 'h2o.chatArchive.bundle.v1'),
        exportedAt: String(chatArchive.exportedAt || bundle.exportedAt || ''),
        chats: chats,
        catalogs: {
          categories: categories,
          labels: []
        }
      },
      chromeStorageLocal: chromeStorageLocal,
      folderDeleteRequests: folderDeleteRequests,
      folderRestoreRequests: folderRestoreRequests,
      chatFolderBindingRequests: chatFolderBindingRequests,
      libraryMetadataMutationRequests: libraryMetadataMutationRequests,
      libraryKv: [],
      diagnostics: {
        unindexedRows: unindexedManifest.rows.slice(0, 50),
        unindexedRowManifest: unindexedManifest
      }
    };

    return {
      ok: true,
      bundle: supported,
      warnings: warnings,
      blockers: blockers,
      sourceSummary: {
        schema: FULL_BUNDLE_SCHEMA,
        direction: 'chrome-to-desktop',
        transport: 'chrome-latest.json',
        chatCount: chats.length,
        savedCount: chatViewCounts.saved,
        linkedCount: chatViewCounts.linked,
        pinnedCount: chatViewCounts.pinned,
        archivedCount: chatViewCounts.archived,
        snapshotCount: countSnapshots(chats),
        minimalRowCount: countMinimalLibraryRows(chats),
        unindexedArchiveRowCount: Number(unindexedManifest.count || 0),
        unindexedRowManifestCount: unindexedManifest.rows.length,
        unindexedRowReasonCounts: Object.assign({}, unindexedManifest.reasonCounts || {}),
        categoryCount: categories.length,
        folderCount: folderState && Array.isArray(folderState.folders) ? folderState.folders.length : 0,
        folderDeleteRequestCount: folderDeleteRequests.length,
        folderRestoreRequestCount: folderRestoreRequests.length,
        chatFolderBindingRequestCount: chatFolderBindingRequests.length,
        libraryMetadataMutationRequestCount: libraryMetadataMutationRequests.length,
        hasSourcePeerEnvelope: !!supported.sourcePeerEnvelope,
        hasExportId: !!supported.exportId,
        hasContentSha256: !!supported.contentSha256
      }
    };
  }

  function redactedImportSummary(result) {
    var r = result && typeof result === 'object' ? result : {};
    var written = r.written && typeof r.written === 'object' ? r.written : {};
    var skipped = r.skipped && typeof r.skipped === 'object' ? r.skipped : {};
    var denied = skipped.deniedByPolicy && typeof skipped.deniedByPolicy === 'object' ? skipped.deniedByPolicy : {};
    var folderMetadataFreshness = r.folderMetadataFreshness && typeof r.folderMetadataFreshness === 'object'
      ? r.folderMetadataFreshness : {};
    var chromeMinimalRows = r.chromeMinimalRows && typeof r.chromeMinimalRows === 'object' ? r.chromeMinimalRows : {};
    var chromeWeakRows = r.chromeWeakRows && typeof r.chromeWeakRows === 'object' ? r.chromeWeakRows : {};
    var chatWriteDiagnostics = Array.isArray(r.chatWriteDiagnostics)
      ? r.chatWriteDiagnostics.slice(0, 10).map(function (entry) {
        return {
          pathName: String(entry && entry.pathName || ''),
          action: String(entry && entry.action || ''),
          rowClass: String(entry && entry.rowClass || ''),
          hasChatId: !!(entry && entry.hasChatId),
          hasId: !!(entry && entry.hasId),
          hasHref: !!(entry && entry.hasHref),
          hasUrl: !!(entry && entry.hasUrl),
          hasNormalizedHref: !!(entry && entry.hasNormalizedHref),
          hasSnapshotId: !!(entry && entry.hasSnapshotId),
          isSaved: !!(entry && entry.isSaved),
          isLinked: !!(entry && entry.isLinked),
          isArchived: !!(entry && entry.isArchived),
          hasTranscriptEvidence: !!(entry && entry.hasTranscriptEvidence),
          weakClassifierRan: !!(entry && entry.weakClassifierRan),
          code: String(entry && entry.code || ''),
          reason: String(entry && entry.reason || ''),
          identityFieldNames: Array.isArray(entry && entry.identityFieldNames)
            ? entry.identityFieldNames.slice(0, 12).map(function (name) { return String(name); }) : []
        };
      }) : [];
    var errorKinds = Object.create(null);
    var minimalRowErrors = 0;
    var nonMinimalErrorCount = 0;
    (Array.isArray(r.errors) ? r.errors : []).forEach(function (entry) {
      var kind = String(entry && entry.kind || 'import-error');
      var code = String(entry && entry.code || kind);
      if (kind === 'chrome-minimal-row-import') minimalRowErrors += 1;
      else nonMinimalErrorCount += 1;
      errorKinds[code] = Number(errorKinds[code] || 0) + 1;
    });
    var warningKinds = Object.create(null);
    var minimalRowsMaterialized = 0;
    var minimalRowsExisting = 0;
    (Array.isArray(r.warnings) ? r.warnings : []).forEach(function (entry) {
      var kind = String(entry && entry.kind || 'warning');
      if (kind === 'chrome-minimal-row-materialized-via-store-upsert') minimalRowsMaterialized += 1;
      if (kind === 'chrome-minimal-row-materialized-via-shell-insert') minimalRowsMaterialized += 1;
      if (kind === 'chrome-minimal-row-materialize-existing') minimalRowsExisting += 1;
      warningKinds[kind] = Number(warningKinds[kind] || 0) + 1;
    });
    function countsObjectToRows(obj) {
      return Object.keys(obj).sort().map(function (code) {
        return { code: code, count: Number(obj[code] || 0) };
      });
    }
    return {
      ok: r.ok !== false,
      mode: String(r.mode || 'merge'),
      destinationBackend: String(r.destinationBackend || ''),
      written: {
        chats: Number(written.chats || 0),
        snapshots: Number(written.snapshots || 0),
        categories: Number(written.categories || 0),
        folders: Number(written.folders || 0),
        folderBindings: Number(written.folderBindings || 0),
        labelBindings: Number(written.labelBindings || 0),
        tagBindings: Number(written.tagBindings || 0)
      },
      skipped: {
        chats: Number(skipped.chats || 0),
        snapshots: Number(skipped.snapshots || 0),
        categories: Number(skipped.categories || 0),
        folders: Number(skipped.folders || 0),
        deniedStorageKeys: Number(denied.chromeStorageLocal || 0),
        deniedKvKeys: Number(denied.libraryKv || 0)
      },
      warningsCount: Array.isArray(r.warnings) ? r.warnings.length : 0,
      errorsCount: Array.isArray(r.errors) ? r.errors.length : 0,
      errorKinds: countsObjectToRows(errorKinds),
      redactedErrorCategories: countsObjectToRows(errorKinds),
      warningKinds: countsObjectToRows(warningKinds),
      minimalRowErrors: Math.max(minimalRowErrors, Number(chromeMinimalRows.failed || 0)),
      nonMinimalErrorCount: nonMinimalErrorCount,
      minimalRowsTotal: Number(chromeMinimalRows.total || 0),
      minimalRowsAttempted: Number(chromeMinimalRows.attempted || 0),
      minimalRowsMaterialized: Math.max(minimalRowsMaterialized, Number(chromeMinimalRows.materialized || 0)),
      minimalRowsExisting: Math.max(minimalRowsExisting, Number(chromeMinimalRows.existing || 0)),
      minimalRowsSkipped: Number(chromeMinimalRows.skipped || 0),
      minimalRowsFailed: Number(chromeMinimalRows.failed || 0),
      minimalRowsSatisfied: Math.max(minimalRowsMaterialized, Number(chromeMinimalRows.materialized || 0)) +
        Math.max(minimalRowsExisting, Number(chromeMinimalRows.existing || 0)),
      weakRowsAttempted: Number(chromeWeakRows.attempted || 0),
      weakRowsMaterialized: Number(chromeWeakRows.materialized || 0),
      weakRowsExisting: Number(chromeWeakRows.existing || 0),
      weakRowsSkipped: Number(chromeWeakRows.skipped || 0),
      weakRowsFailed: Number(chromeWeakRows.failed || 0),
      unindexedRowsReceived: Number(r.unindexedRowsReceived || 0),
      unindexedRowsMatched: Number(r.unindexedRowsMatched || 0),
      unindexedRowsArchived: Number(r.unindexedRowsArchived || 0),
      unindexedRowsMissing: Number(r.unindexedRowsMissing || 0),
      unindexedRowReasonCounts: r.unindexedRowReasonCounts && typeof r.unindexedRowReasonCounts === 'object'
        ? Object.assign({}, r.unindexedRowReasonCounts) : {},
      folderMetadataFreshness: {
        incoming: Number(folderMetadataFreshness.incoming || 0),
        created: Number(folderMetadataFreshness.created || 0),
        refreshed: Number(folderMetadataFreshness.refreshed || 0),
        skippedStale: Number(folderMetadataFreshness.skippedStale || 0),
        missingIncomingUpdatedAt: Number(folderMetadataFreshness.missingIncomingUpdatedAt || 0),
        missingExistingUpdatedAt: Number(folderMetadataFreshness.missingExistingUpdatedAt || 0)
      },
      chatWriteDiagnostics: chatWriteDiagnostics,
      libraryBulkMigration: Array.isArray(r.libraryBulkMigration)
        ? r.libraryBulkMigration.map(function (entry) {
          return {
            phase: String(entry && entry.phase || ''),
            ok: !!(entry && entry.ok === true),
            status: String(entry && entry.status || ''),
            blockers: Array.isArray(entry && entry.blockers) ? entry.blockers.slice() : [],
            warnings: Array.isArray(entry && entry.warnings) ? entry.warnings.slice() : []
          };
        }) : []
    };
  }

  function staleMinimalRowErrorsAreCovered(importSummary, sourceSummary) {
    var summary = importSummary && typeof importSummary === 'object' ? importSummary : {};
    var source = sourceSummary && typeof sourceSummary === 'object' ? sourceSummary : {};
    var target = Number(source.minimalRowCount || 0) ||
      Number(summary.minimalRowsAttempted || 0) ||
      Number(summary.minimalRowsTotal || 0) ||
      Number(summary.minimalRowErrors || 0);
    if (Number(summary.minimalRowsFailed || 0) > 0) return false;
    return target > 0 &&
      Number(summary.minimalRowErrors || 0) > 0 &&
      Number(summary.nonMinimalErrorCount || 0) === 0 &&
      Number(summary.minimalRowsSatisfied || 0) >= target;
  }

  function propagationResult(ok, fields) {
    var f = fields && typeof fields === 'object' ? fields : {};
    var blockers = normalizeHardeningBlockers(f.blockers);
    var warnings = normalizeHardeningWarnings(f.warnings);
    var status = String(f.status || (ok ? 'imported' : 'blocked'));
    var direction = String(f.direction || 'chrome-to-desktop');
    var transport = String(f.transport || 'chrome-latest.json');
    return {
      schema: PROPAGATION_SCHEMA,
      version: String(f.version || F19_CHROME_DESKTOP_VERSION),
      ok: ok === true && blockers.length === 0,
      direction: direction,
      transport: transport,
      status: status,
      supportedFields: CHROME_DESKTOP_SUPPORTED_FIELDS.slice(),
      deferredFields: warnings.filter(function (code) {
        return code === CHROME_DESKTOP_DEFERRED_CODES.labels ||
          code === CHROME_DESKTOP_DEFERRED_CODES.tags ||
          code === CHROME_DESKTOP_DEFERRED_CODES.projects ||
          code === CHROME_DESKTOP_DEFERRED_CODES.folderBindings;
      }),
      sourceSummary: f.sourceSummary || null,
      importSummary: f.importSummary || null,
      folderDeleteRequestImport: f.folderDeleteRequestImport || null,
      folderDeleteRequestAutoApply: f.folderDeleteRequestAutoApply || null,
      folderRestoreRequestImport: f.folderRestoreRequestImport || null,
      folderRestoreRequestAutoApply: f.folderRestoreRequestAutoApply || null,
      chatFolderBindingRequestImport: f.chatFolderBindingRequestImport || null,
      chatFolderBindingRequestAutoApply: f.chatFolderBindingRequestAutoApply || null,
      libraryMetadataMutationRequestImport: f.libraryMetadataMutationRequestImport || null,
      libraryMetadataMutationRequestAutoApply: f.libraryMetadataMutationRequestAutoApply || null,
      parity: f.parity || {
        snapshotCaptured: false,
        paritySnapshotHash: '',
        parityDiagnosticReady: !!(H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.libraryParity)
      },
      idempotency: f.idempotency || {
        fileFingerprintChecked: false,
        mergeOnly: true,
        existingRowsSkipped: true
      },
      hardening: {
        taxonomy: F19_SYNC_HARDENING_CODES,
        duplicateImportIdempotent: warnings.indexOf(F19_SYNC_HARDENING_CODES.duplicateImportIdempotent) !== -1,
        staleBlocked: blockers.indexOf(F19_SYNC_HARDENING_CODES.transportStale) !== -1,
        simultaneousConflictBlocked: blockers.indexOf(F19_SYNC_HARDENING_CODES.simultaneousUpdateConflict) !== -1,
        deferredFieldsExplicit: warnings.indexOf(F19_SYNC_HARDENING_CODES.deferredFieldPresent) !== -1,
        unsupportedFieldsExplicit: warnings.indexOf(F19_SYNC_HARDENING_CODES.unsupportedFieldPresent) !== -1,
        sourceMetadataChecked: warnings.indexOf(F19_SYNC_HARDENING_CODES.sourceMetadataMissing) !== -1
      },
      privacy: {
        redacted: true,
        rawIdsReturned: false,
        rawTitlesReturned: false,
        rawContentReturned: false
      },
      redactedErrorCategories: f.importSummary && Array.isArray(f.importSummary.redactedErrorCategories)
        ? f.importSummary.redactedErrorCategories.slice() : [],
      minimalRowsMaterialized: Number(f.importSummary && f.importSummary.minimalRowsMaterialized || 0),
      minimalRowsExisting: Number(f.importSummary && f.importSummary.minimalRowsExisting || 0),
      minimalRowsSatisfied: Number(f.importSummary && f.importSummary.minimalRowsSatisfied || 0),
      minimalRowsSkipped: Number(f.importSummary && f.importSummary.minimalRowsSkipped || 0),
      minimalRowsFailed: Number(f.importSummary && f.importSummary.minimalRowsFailed || 0),
      minimalRowErrors: Number(f.importSummary && f.importSummary.minimalRowErrors || 0),
      weakRowsAttempted: Number(f.importSummary && f.importSummary.weakRowsAttempted || 0),
      weakRowsMaterialized: Number(f.importSummary && f.importSummary.weakRowsMaterialized || 0),
      weakRowsExisting: Number(f.importSummary && f.importSummary.weakRowsExisting || 0),
      weakRowsSkipped: Number(f.importSummary && f.importSummary.weakRowsSkipped || 0),
      weakRowsFailed: Number(f.importSummary && f.importSummary.weakRowsFailed || 0),
      unindexedRowsReceived: Number(f.importSummary && f.importSummary.unindexedRowsReceived || 0),
      unindexedRowsMatched: Number(f.importSummary && f.importSummary.unindexedRowsMatched || 0),
      unindexedRowsArchived: Number(f.importSummary && f.importSummary.unindexedRowsArchived || 0),
      unindexedRowsMissing: Number(f.importSummary && f.importSummary.unindexedRowsMissing || 0),
      unindexedRowReasonCounts: f.importSummary && f.importSummary.unindexedRowReasonCounts &&
        typeof f.importSummary.unindexedRowReasonCounts === 'object'
        ? Object.assign({}, f.importSummary.unindexedRowReasonCounts) : {},
      sideEffects: {
        chromeStorageWritten: false,
        desktopSqliteMayWriteSupportedRows: ok === true && status !== 'already-imported',
        nativeCalled: false,
        f5Touched: false,
        relayTouched: false,
        outboxTouched: false
      },
      blockers: blockers,
      warnings: warnings,
      observedAt: new Date().toISOString()
    };
  }

  async function captureParityAfterImport() {
    try {
      var parity = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.libraryParity;
      if (!parity || typeof parity.captureSnapshot !== 'function') {
        return { snapshotCaptured: false, paritySnapshotHash: '', parityDiagnosticReady: false };
      }
      var snapshot = await parity.captureSnapshot();
      return {
        snapshotCaptured: !!(snapshot && snapshot.schema),
        paritySnapshotHash: await sha256Hex(JSON.stringify(snapshot || {})),
        parityDiagnosticReady: true,
        surface: String(snapshot && snapshot.surface || '')
      };
    } catch (e) {
      return {
        snapshotCaptured: false,
        paritySnapshotHash: '',
        parityDiagnosticReady: false,
        warning: 'library-propagation-parity-snapshot-failed'
      };
    }
  }

  async function ingestFolderDeleteRequestsFromChromeBundle(normalized, options) {
    var bundle = normalized && normalized.bundle && typeof normalized.bundle === 'object'
      ? normalized.bundle : null;
    var requests = bundle && Array.isArray(bundle.folderDeleteRequests)
      ? bundle.folderDeleteRequests : [];
    var result = {
      schema: FOLDER_DELETE_REQUEST_SCHEMA + '.transport-ingest.v1',
      ok: true,
      phase: 'phase4c.3a',
      status: requests.length ? 'folder-delete-request-import-pending' : 'no-folder-delete-requests',
      found: requests.length,
      inserted: 0,
      updated: 0,
      duplicatePending: 0,
      skipped: 0,
      invalid: 0,
      failed: 0,
      warnings: [],
      noApply: true,
      noHardDelete: true,
      noChatDelete: true,
      noFolderMutation: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      desktopApplyDeferred: true,
      tombstonePropagation: 'deferred',
    };
    if (!requests.length) {
      state.lastFolderDeleteRequestImport = result;
      return result;
    }
    var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
    if (!reviews || typeof reviews.ingestFolderDeleteRequests !== 'function') {
      result.ok = false;
      result.status = 'folder-delete-request-review-store-unavailable';
      result.failed = requests.length;
      result.warnings.push('tombstone-review-store-unavailable');
      state.lastFolderDeleteRequestImport = result;
      return result;
    }
    try {
      var importResult = await reviews.ingestFolderDeleteRequests(bundle, {
        source: 'chrome-latest.json',
        exportId: bundle.exportId || '',
        sequenceNumber: bundle.sequenceNumber,
        sourceSyncPeerId: cleanString(bundle.sourceSyncPeerId || ''),
        mode: options && options.mode,
      });
      result = Object.assign(result, importResult || {});
      result.noApply = true;
      result.noHardDelete = true;
      result.noChatDelete = true;
      result.noFolderMutation = true;
      result.noBindingMutation = true;
      result.noChatMutation = true;
      result.noSnapshotMutation = true;
      result.desktopApplyDeferred = true;
      result.tombstonePropagation = 'deferred';
      state.lastFolderDeleteRequestImport = result;
      return result;
    } catch (e) {
      result.ok = false;
      result.status = 'folder-delete-request-import-failed';
      result.failed = requests.length;
      result.warnings.push('folder-delete-request-import-failed');
      state.lastFolderDeleteRequestImport = result;
      pushErr('folderDeleteRequests.ingest', e);
      return result;
    }
  }

  function folderDeleteRequestIdentityMatchesRow(row, request) {
    var reviewId = cleanString(row && (row.reviewId || row.requestId));
    var requestId = cleanString(row && (row.requestId || row.reviewId));
    var recordId = cleanString(row && (row.recordId || row.folderId)).replace(/^folder:/, '');
    var targetRequestId = cleanString(request && (request.requestId || request.reviewId));
    var targetReviewId = cleanString(request && (request.reviewId || request.requestId));
    var targetFolderId = cleanString(request && request.folderId);
    var requestMatches = !targetRequestId || requestId === targetRequestId || reviewId === targetRequestId ||
      reviewId === targetReviewId || requestId === targetReviewId;
    var folderMatches = !targetFolderId || recordId === targetFolderId;
    return requestMatches && folderMatches;
  }

  async function findFolderDeleteRequestReviewForAutoApply(reviews, request, status) {
    if (!reviews || typeof reviews.listFolderDeleteRequests !== 'function') return null;
    var rows = await reviews.listFolderDeleteRequests({
      folderId: request.folderId,
      status: status || '',
      limit: 100,
    });
    var list = Array.isArray(rows) ? rows : [];
    return list.find(function (row) {
      return folderDeleteRequestIdentityMatchesRow(row, request);
    }) || null;
  }

  async function autoApplyFolderDeleteRequestsFromChromeBundle(normalized, importResult, options) {
    var bundle = normalized && normalized.bundle && typeof normalized.bundle === 'object'
      ? normalized.bundle : null;
    var sourceRequests = bundle && Array.isArray(bundle.folderDeleteRequests)
      ? bundle.folderDeleteRequests : [];
    var requests = sourceRequests.map(sanitizeFolderDeleteRequestForChromeDesktop).filter(function (request) {
      return !!request;
    });
    var result = {
      schema: FOLDER_DELETE_REQUEST_SCHEMA + '.desktop-auto-apply.v1',
      ok: true,
      phase: 'phase6b.4',
      status: requests.length ? 'folder-delete-request-auto-apply-pending' : 'no-folder-delete-requests',
      model: 'desktop-auto-apply-safe-chrome-soft-delete',
      found: sourceRequests.length,
      requestCount: requests.length,
      importedCount: numberOrZero(importResult && importResult.inserted) + numberOrZero(importResult && importResult.updated),
      desktopImportedFolderDeleteRequestCount: numberOrZero(importResult && importResult.inserted) + numberOrZero(importResult && importResult.updated),
      attemptedCount: 0,
      appliedCount: 0,
      alreadyAppliedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      receiptExportReadyCount: 0,
      appliedRequests: [],
      skippedRequests: [],
      failedRequests: [],
      warnings: [],
      blockers: [],
      desktopAppliedFolderDeleteRequestCount: 0,
      noChromePurgeAuthority: true,
      noChromeTombstoneApply: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noPurge: true,
    };
    if (!requests.length) {
      state.lastFolderDeleteRequestAutoApply = result;
      return result;
    }
    if (!importResult || importResult.ok === false) {
      result.ok = false;
      result.status = 'folder-delete-request-import-not-ok';
      result.blockers.push('folder-delete-request-import-not-ok');
      result.failedCount = requests.length;
      state.lastFolderDeleteRequestAutoApply = result;
      return result;
    }
    var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
    if (!reviews || typeof reviews.listFolderDeleteRequests !== 'function' || typeof reviews.applyFolderDeleteRequest !== 'function') {
      result.ok = false;
      result.status = 'folder-delete-request-auto-apply-unavailable';
      result.blockers.push('folder-delete-request-auto-apply-unavailable');
      result.failedCount = requests.length;
      state.lastFolderDeleteRequestAutoApply = result;
      return result;
    }
    for (var i = 0; i < requests.length; i += 1) {
      var request = requests[i];
      var row = null;
      try {
        row = await findFolderDeleteRequestReviewForAutoApply(reviews, request, 'pending');
        if (!row) {
          var resolved = await findFolderDeleteRequestReviewForAutoApply(reviews, request, 'resolved');
          if (resolved && cleanString(resolved.decision) === 'applied-folder-delete-request') {
            result.alreadyAppliedCount += 1;
            result.receiptExportReadyCount += 1;
            result.appliedRequests.push({
              requestId: request.requestId,
              reviewId: cleanString(resolved.reviewId || request.reviewId || request.requestId),
              folderId: request.folderId,
              status: 'already-applied',
            });
            continue;
          }
          result.skippedCount += 1;
          result.skippedRequests.push({
            requestId: request.requestId,
            reviewId: request.reviewId,
            folderId: request.folderId,
            status: 'pending-review-not-found',
          });
          addUnique(result.warnings, 'folder-delete-request-pending-review-not-found');
          continue;
        }
        result.attemptedCount += 1;
        var applyResult = await reviews.applyFolderDeleteRequest({
          reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
          requestId: request.requestId,
        }, {
          reason: 'phase6b4-auto-apply-chrome-soft-delete',
          deleteReason: 'phase6b4-auto-apply-chrome-soft-delete',
        });
        if (applyResult && applyResult.ok === true) {
          result.appliedCount += 1;
          result.receiptExportReadyCount += 1;
          result.appliedRequests.push({
            requestId: request.requestId,
            reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
            folderId: request.folderId,
            status: cleanString(applyResult.status) || 'folder-delete-request-applied',
            tombstoneId: cleanString(applyResult.tombstoneId),
          });
        } else if (applyResult && applyResult.alreadyApplied === true) {
          result.alreadyAppliedCount += 1;
          result.receiptExportReadyCount += 1;
          result.appliedRequests.push({
            requestId: request.requestId,
            reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
            folderId: request.folderId,
            status: 'already-applied',
          });
        } else {
          var applyBlockers = Array.isArray(applyResult && applyResult.blockers) ? applyResult.blockers.slice() : [];
          var applyStatus = cleanString(applyResult && applyResult.status) || 'folder-delete-request-apply-failed';
          var alreadyTombstoned = applyStatus === 'already-tombstoned' ||
            applyBlockers.some(function (code) {
              return cleanString(code && (code.code || code)) === 'already-tombstoned';
            });
          if (alreadyTombstoned) {
            result.alreadyAppliedCount += 1;
            result.receiptExportReadyCount += 1;
            result.appliedRequests.push({
              requestId: request.requestId,
              reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
              folderId: request.folderId,
              status: 'already-tombstoned',
              idempotent: true,
            });
            addUnique(result.warnings, 'folder-delete-request-already-tombstoned-idempotent');
            continue;
          }
          result.failedCount += 1;
          result.failedRequests.push({
            requestId: request.requestId,
            reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
            folderId: request.folderId,
            status: applyStatus,
            blockers: applyBlockers,
          });
          applyBlockers.forEach(function (code) {
            addUnique(result.blockers, code && (code.code || code));
          });
        }
      } catch (e) {
        result.failedCount += 1;
        result.failedRequests.push({
          requestId: request.requestId,
          reviewId: request.reviewId,
          folderId: request.folderId,
          status: 'folder-delete-request-auto-apply-threw',
        });
        addUnique(result.blockers, 'folder-delete-request-auto-apply-threw');
        pushErr('folderDeleteRequests.autoApply', e);
      }
    }
    result.desktopAppliedFolderDeleteRequestCount = result.appliedCount + result.alreadyAppliedCount;
    if (result.failedCount > 0) {
      result.ok = false;
      if (!result.blockers.length) result.blockers.push('folder-delete-request-auto-apply-failed');
      result.status = result.appliedCount || result.alreadyAppliedCount
        ? 'folder-delete-request-auto-apply-partial'
        : 'folder-delete-request-auto-apply-failed';
    } else if (result.appliedCount || result.alreadyAppliedCount) {
      result.status = 'folder-delete-request-auto-applied';
    } else {
      result.status = 'folder-delete-request-auto-apply-skipped';
    }
    state.lastFolderDeleteRequestAutoApply = result;
    return result;
  }

  async function ingestFolderRestoreRequestsFromChromeBundle(normalized, options) {
    var bundle = normalized && normalized.bundle && typeof normalized.bundle === 'object'
      ? normalized.bundle : null;
    var requests = bundle && Array.isArray(bundle.folderRestoreRequests)
      ? bundle.folderRestoreRequests : [];
    var result = {
      schema: FOLDER_RESTORE_REQUEST_SCHEMA + '.transport-ingest.v1',
      ok: true,
      phase: 'phase6c.3',
      status: requests.length ? 'folder-restore-request-import-pending' : 'no-folder-restore-requests',
      found: requests.length,
      inserted: 0,
      updated: 0,
      duplicatePending: 0,
      skipped: 0,
      invalid: 0,
      failed: 0,
      warnings: [],
      noApply: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noFolderMutation: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      desktopRestoreDeferred: true,
      desktopApplyDeferred: true,
    };
    if (!requests.length) {
      state.lastFolderRestoreRequestImport = result;
      return result;
    }
    var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
    if (!reviews || typeof reviews.ingestFolderRestoreRequests !== 'function') {
      result.ok = false;
      result.status = 'folder-restore-request-review-store-unavailable';
      result.failed = requests.length;
      result.warnings.push('tombstone-review-store-unavailable');
      state.lastFolderRestoreRequestImport = result;
      return result;
    }
    try {
      var importResult = await reviews.ingestFolderRestoreRequests(bundle, {
        source: 'chrome-latest.json',
        exportId: bundle.exportId || '',
        sequenceNumber: bundle.sequenceNumber,
        sourceSyncPeerId: cleanString(bundle.sourceSyncPeerId || ''),
        mode: options && options.mode,
      });
      result = Object.assign(result, importResult || {});
      result.noApply = true;
      result.noHardDelete = true;
      result.noChatDelete = true;
      result.noSnapshotDelete = true;
      result.noAssetDelete = true;
      result.noFolderMutation = true;
      result.noBindingMutation = true;
      result.noChatMutation = true;
      result.noSnapshotMutation = true;
      result.desktopRestoreDeferred = true;
      result.desktopApplyDeferred = true;
      state.lastFolderRestoreRequestImport = result;
      return result;
    } catch (e) {
      result.ok = false;
      result.status = 'folder-restore-request-import-failed';
      result.failed = requests.length;
      result.warnings.push('folder-restore-request-import-failed');
      state.lastFolderRestoreRequestImport = result;
      pushErr('folderRestoreRequests.ingest', e);
      return result;
    }
  }

  function folderRestoreRequestIdentityMatchesRow(row, request) {
    var reviewId = cleanString(row && (row.reviewId || row.requestId));
    var requestId = cleanString(row && (row.requestId || row.reviewId));
    var recordId = cleanString(row && (row.recordId || row.folderId)).replace(/^folder:/, '');
    var targetRequestId = cleanString(request && (request.requestId || request.reviewId));
    var targetReviewId = cleanString(request && (request.reviewId || request.requestId));
    var targetFolderId = cleanString(request && request.folderId);
    var requestMatches = !targetRequestId || requestId === targetRequestId || reviewId === targetRequestId ||
      reviewId === targetReviewId || requestId === targetReviewId;
    var folderMatches = !targetFolderId || recordId === targetFolderId;
    return requestMatches && folderMatches;
  }

  async function findFolderRestoreRequestReviewForAutoApply(reviews, request, status) {
    if (!reviews || typeof reviews.listFolderRestoreRequests !== 'function') return null;
    var rows = await reviews.listFolderRestoreRequests({
      folderId: request.folderId,
      status: status || '',
      limit: 100,
    });
    var list = Array.isArray(rows) ? rows : [];
    return list.find(function (row) {
      return folderRestoreRequestIdentityMatchesRow(row, request);
    }) || null;
  }

  function isPurgedFolderRestoreRequestForAutoApply(request) {
    var advisory = request && request.advisory && typeof request.advisory === 'object' && !Array.isArray(request.advisory)
      ? request.advisory : {};
    var status = cleanString((request && request.status) || advisory.status).toLowerCase();
    var source = cleanString((request && (request.source || request.sourceKind)) || advisory.sourceKind || advisory.stateSource).toLowerCase();
    return request && (request.phase6aPermanentlyPurged === true || request.permanentlySuppressed === true) ||
      advisory.phase6aPermanentlyPurged === true ||
      advisory.permanentlySuppressed === true ||
      status === 'purged' ||
      source === 'desktop-purged-folder-suppression';
  }

  async function autoApplyFolderRestoreRequestsFromChromeBundle(normalized, importResult, options) {
    var bundle = normalized && normalized.bundle && typeof normalized.bundle === 'object'
      ? normalized.bundle : null;
    var sourceRequests = bundle && Array.isArray(bundle.folderRestoreRequests)
      ? bundle.folderRestoreRequests : [];
    var requests = sourceRequests.map(sanitizeFolderRestoreRequestForChromeDesktop).filter(function (request) {
      return !!request;
    });
    var result = {
      schema: FOLDER_RESTORE_REQUEST_SCHEMA + '.desktop-auto-apply.v1',
      ok: true,
      phase: 'phase6c.3',
      status: requests.length ? 'folder-restore-request-auto-apply-pending' : 'no-folder-restore-requests',
      model: 'desktop-auto-apply-safe-chrome-folder-restore',
      found: sourceRequests.length,
      requestCount: requests.length,
      importedCount: numberOrZero(importResult && importResult.inserted) + numberOrZero(importResult && importResult.updated),
      desktopImportedFolderRestoreRequestCount: numberOrZero(importResult && importResult.inserted) + numberOrZero(importResult && importResult.updated),
      attemptedCount: 0,
      appliedCount: 0,
      alreadyAppliedCount: 0,
      purgedBlockedCount: 0,
      noActiveTombstoneBlockedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      receiptExportReadyCount: 0,
      appliedRequests: [],
      skippedRequests: [],
      failedRequests: [],
      warnings: [],
      blockers: [],
      desktopAppliedFolderRestoreRequestCount: 0,
      noChromeRestoreAuthority: true,
      noChromePurgeAuthority: true,
      noChromeTombstoneApply: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noPurge: true,
    };
    if (!requests.length) {
      state.lastFolderRestoreRequestAutoApply = result;
      return result;
    }
    if (!importResult || importResult.ok === false) {
      result.ok = false;
      result.status = 'folder-restore-request-import-not-ok';
      result.blockers.push('folder-restore-request-import-not-ok');
      result.failedCount = requests.length;
      state.lastFolderRestoreRequestAutoApply = result;
      return result;
    }
    var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
    if (!reviews || typeof reviews.listFolderRestoreRequests !== 'function' || typeof reviews.applyFolderRestoreRequest !== 'function') {
      result.ok = false;
      result.status = 'folder-restore-request-auto-apply-unavailable';
      result.blockers.push('folder-restore-request-auto-apply-unavailable');
      result.failedCount = requests.length;
      state.lastFolderRestoreRequestAutoApply = result;
      return result;
    }
    for (var i = 0; i < requests.length; i += 1) {
      var request = requests[i];
      var row = null;
      try {
        if (isPurgedFolderRestoreRequestForAutoApply(request)) {
          result.purgedBlockedCount += 1;
          result.skippedCount += 1;
          result.skippedRequests.push({
            requestId: request.requestId,
            reviewId: request.reviewId,
            folderId: request.folderId,
            status: 'folder-restore-request-blocked-purged',
          });
          addUnique(result.warnings, 'folder-restore-request-blocked-purged');
          continue;
        }
        row = await findFolderRestoreRequestReviewForAutoApply(reviews, request, 'pending');
        if (!row) {
          var resolved = await findFolderRestoreRequestReviewForAutoApply(reviews, request, 'resolved');
          var decision = cleanString(resolved && resolved.decision);
          if (resolved && (decision === 'applied-folder-restore-request' || decision === 'already-restored-folder-restore-request')) {
            result.alreadyAppliedCount += 1;
            result.receiptExportReadyCount += 1;
            result.appliedRequests.push({
              requestId: request.requestId,
              reviewId: cleanString(resolved.reviewId || request.reviewId || request.requestId),
              folderId: request.folderId,
              status: 'already-applied',
            });
            continue;
          }
          result.skippedCount += 1;
          result.skippedRequests.push({
            requestId: request.requestId,
            reviewId: request.reviewId,
            folderId: request.folderId,
            status: 'pending-review-not-found',
          });
          addUnique(result.warnings, 'folder-restore-request-pending-review-not-found');
          continue;
        }
        result.attemptedCount += 1;
        var applyResult = await reviews.applyFolderRestoreRequest({
          reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
          requestId: request.requestId,
        }, {
          reason: 'phase6c3-auto-apply-chrome-folder-restore',
        });
        if (applyResult && applyResult.ok === true) {
          if (applyResult.alreadyApplied === true) result.alreadyAppliedCount += 1;
          else result.appliedCount += 1;
          result.receiptExportReadyCount += 1;
          result.appliedRequests.push({
            requestId: request.requestId,
            reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
            folderId: request.folderId,
            status: cleanString(applyResult.status) || 'folder-restore-request-applied',
            tombstoneId: cleanString(applyResult.tombstoneId),
          });
        } else {
          var status = cleanString(applyResult && applyResult.status) || 'folder-restore-request-apply-failed';
          if (applyResult && applyResult.purgedBlocked === true) result.purgedBlockedCount += 1;
          if (applyResult && applyResult.noActiveTombstoneBlocked === true) result.noActiveTombstoneBlockedCount += 1;
          result.failedCount += 1;
          result.failedRequests.push({
            requestId: request.requestId,
            reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
            folderId: request.folderId,
            status: status,
            blockers: Array.isArray(applyResult && applyResult.blockers) ? applyResult.blockers.slice() : [],
          });
          (Array.isArray(applyResult && applyResult.blockers) ? applyResult.blockers : []).forEach(function (code) {
            addUnique(result.blockers, code && (code.code || code));
          });
        }
      } catch (e) {
        result.failedCount += 1;
        result.failedRequests.push({
          requestId: request.requestId,
          reviewId: request.reviewId,
          folderId: request.folderId,
          status: 'folder-restore-request-auto-apply-threw',
        });
        addUnique(result.blockers, 'folder-restore-request-auto-apply-threw');
        pushErr('folderRestoreRequests.autoApply', e);
      }
    }
    result.desktopAppliedFolderRestoreRequestCount = result.appliedCount + result.alreadyAppliedCount;
    if (result.failedCount > 0) {
      result.ok = false;
      if (!result.blockers.length) result.blockers.push('folder-restore-request-auto-apply-failed');
      result.status = result.appliedCount || result.alreadyAppliedCount
        ? 'folder-restore-request-auto-apply-partial'
        : 'folder-restore-request-auto-apply-failed';
    } else if (result.appliedCount || result.alreadyAppliedCount) {
      result.status = 'folder-restore-request-auto-applied';
    } else {
      result.status = 'folder-restore-request-auto-apply-skipped';
    }
    state.lastFolderRestoreRequestAutoApply = result;
    return result;
  }

  async function ingestChatFolderBindingRequestsFromChromeBundle(normalized, options) {
    var bundle = normalized && normalized.bundle && typeof normalized.bundle === 'object'
      ? normalized.bundle : null;
    var requests = bundle && Array.isArray(bundle.chatFolderBindingRequests)
      ? bundle.chatFolderBindingRequests : [];
    var result = {
      schema: CHAT_FOLDER_BINDING_REQUEST_SCHEMA + '.transport-ingest.v1',
      ok: true,
      phase: 'phase-b9',
      status: requests.length ? 'chat-folder-binding-request-import-pending' : 'no-chat-folder-binding-requests',
      found: requests.length,
      inserted: 0,
      updated: 0,
      duplicatePending: 0,
      skipped: 0,
      invalid: 0,
      failed: 0,
      warnings: [],
      noApply: true,
      noChromeBindingAuthority: true,
      noChromeDestructiveBindingApply: true,
      noDesktopCanonicalMutationFromChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noFolderMutation: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      desktopApplyDeferred: true,
    };
    if (!requests.length) {
      state.lastChatFolderBindingRequestImport = result;
      return result;
    }
    var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
    if (!reviews || typeof reviews.ingestChatFolderBindingRequests !== 'function') {
      result.ok = false;
      result.status = 'chat-folder-binding-request-review-store-unavailable';
      result.failed = requests.length;
      result.warnings.push('tombstone-review-store-unavailable');
      state.lastChatFolderBindingRequestImport = result;
      return result;
    }
    try {
      var importResult = await reviews.ingestChatFolderBindingRequests(bundle, {
        source: 'chrome-latest.json',
        exportId: bundle.exportId || '',
        sequenceNumber: bundle.sequenceNumber,
        sourceSyncPeerId: cleanString(bundle.sourceSyncPeerId || ''),
        mode: options && options.mode,
      });
      result = Object.assign(result, importResult || {});
      result.noApply = true;
      result.noChromeBindingAuthority = true;
      result.noChromeDestructiveBindingApply = true;
      result.noDesktopCanonicalMutationFromChrome = true;
      result.noHardDelete = true;
      result.noPurge = true;
      result.noChatDelete = true;
      result.noSnapshotDelete = true;
      result.noAssetDelete = true;
      result.noFolderMutation = true;
      result.noBindingMutation = true;
      result.noChatMutation = true;
      result.noSnapshotMutation = true;
      result.desktopApplyDeferred = true;
      state.lastChatFolderBindingRequestImport = result;
      return result;
    } catch (e) {
      result.ok = false;
      result.status = 'chat-folder-binding-request-import-failed';
      result.failed = requests.length;
      result.warnings.push('chat-folder-binding-request-import-failed');
      state.lastChatFolderBindingRequestImport = result;
      pushErr('chatFolderBindingRequests.ingest', e);
      return result;
    }
  }

  function chatFolderBindingRequestIdentityMatchesRow(row, request) {
    var reviewId = cleanString(row && (row.reviewId || row.requestId));
    var requestId = cleanString(row && (row.requestId || row.reviewId));
    var recordId = cleanString(row && (row.recordId || row.chatId || row.conversationId));
    var targetRequestId = cleanString(request && (request.requestId || request.reviewId));
    var targetReviewId = cleanString(request && (request.reviewId || request.requestId));
    var targetChatId = cleanString(request && (request.chatId || request.conversationId));
    var requestMatches = !targetRequestId || requestId === targetRequestId || reviewId === targetRequestId ||
      reviewId === targetReviewId || requestId === targetReviewId;
    var chatMatches = !targetChatId || recordId === targetChatId;
    return requestMatches && chatMatches;
  }

  async function findChatFolderBindingRequestReviewForAutoApply(reviews, request, status) {
    if (!reviews || typeof reviews.listChatFolderBindingRequests !== 'function') return null;
    var rows = await reviews.listChatFolderBindingRequests({
      chatId: request.chatId || request.conversationId,
      status: status || '',
      limit: 100,
    });
    var list = Array.isArray(rows) ? rows : [];
    return list.find(function (row) {
      return chatFolderBindingRequestIdentityMatchesRow(row, request);
    }) || null;
  }

  async function autoApplyChatFolderBindingRequestsFromChromeBundle(normalized, importResult, options) {
    var bundle = normalized && normalized.bundle && typeof normalized.bundle === 'object'
      ? normalized.bundle : null;
    var sourceRequests = bundle && Array.isArray(bundle.chatFolderBindingRequests)
      ? bundle.chatFolderBindingRequests : [];
    var requests = sourceRequests.map(sanitizeChatFolderBindingRequestForChromeDesktop).filter(function (request) {
      return !!request;
    });
    var result = {
      schema: CHAT_FOLDER_BINDING_REQUEST_SCHEMA + '.desktop-auto-apply.v1',
      ok: true,
      phase: 'phase-b9',
      status: requests.length ? 'chat-folder-binding-request-auto-apply-pending' : 'no-chat-folder-binding-requests',
      model: 'desktop-auto-apply-chrome-chat-folder-binding-request',
      found: sourceRequests.length,
      requestCount: requests.length,
      importedCount: numberOrZero(importResult && importResult.inserted) + numberOrZero(importResult && importResult.updated),
      desktopImportedChatFolderBindingRequestCount: numberOrZero(importResult && importResult.inserted) + numberOrZero(importResult && importResult.updated),
      attemptedCount: 0,
      appliedCount: 0,
      alreadyAppliedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      expectedCurrentFolderMismatchCount: 0,
      targetFolderMissingCount: 0,
      receiptExportReadyCount: 0,
      appliedRequests: [],
      skippedRequests: [],
      failedRequests: [],
      warnings: [],
      blockers: [],
      desktopAppliedChatFolderBindingRequestCount: 0,
      noChromeBindingAuthority: true,
      noChromeDestructiveBindingApply: true,
      noDesktopCanonicalMutationFromChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
    if (!requests.length) {
      state.lastChatFolderBindingRequestAutoApply = result;
      return result;
    }
    if (!importResult || importResult.ok === false) {
      result.ok = false;
      result.status = 'chat-folder-binding-request-import-not-ok';
      result.blockers.push('chat-folder-binding-request-import-not-ok');
      result.failedCount = requests.length;
      state.lastChatFolderBindingRequestAutoApply = result;
      return result;
    }
    var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
    if (!reviews || typeof reviews.listChatFolderBindingRequests !== 'function' ||
        typeof reviews.applyChatFolderBindingRequest !== 'function') {
      result.ok = false;
      result.status = 'chat-folder-binding-request-auto-apply-unavailable';
      result.blockers.push('chat-folder-binding-request-auto-apply-unavailable');
      result.failedCount = requests.length;
      state.lastChatFolderBindingRequestAutoApply = result;
      return result;
    }
    for (var i = 0; i < requests.length; i += 1) {
      var request = requests[i];
      var row = null;
      try {
        row = await findChatFolderBindingRequestReviewForAutoApply(reviews, request, 'pending');
        if (!row) {
          var resolved = await findChatFolderBindingRequestReviewForAutoApply(reviews, request, 'resolved');
          var decision = cleanString(resolved && resolved.decision);
          if (resolved && (
            decision === 'applied-chat-folder-binding-request' ||
            decision === 'already-applied-chat-folder-binding-request'
          )) {
            var resolvedApplyResult = await reviews.applyChatFolderBindingRequest({
              reviewId: cleanString(resolved.reviewId || request.reviewId || request.requestId),
              requestId: request.requestId,
            }, {
              reason: 'phase-b9-auto-apply-chrome-chat-folder-binding-request',
              reconcileResolvedCanonical: true,
            });
            if (!resolvedApplyResult || resolvedApplyResult.ok !== true) {
              var resolvedStatus = cleanString(resolvedApplyResult && resolvedApplyResult.status) || 'chat-folder-binding-request-resolved-reconcile-failed';
              if (resolvedStatus === 'expected-current-folder-mismatch') result.expectedCurrentFolderMismatchCount += 1;
              if (resolvedStatus === 'target-folder-missing') result.targetFolderMissingCount += 1;
              result.failedCount += 1;
              result.failedRequests.push({
                requestId: request.requestId,
                reviewId: cleanString(resolved.reviewId || request.reviewId || request.requestId),
                chatId: request.chatId,
                targetFolderId: request.targetFolderId,
                status: resolvedStatus,
                blockers: Array.isArray(resolvedApplyResult && resolvedApplyResult.blockers) ? resolvedApplyResult.blockers.slice() : [],
              });
              (Array.isArray(resolvedApplyResult && resolvedApplyResult.blockers) ? resolvedApplyResult.blockers : []).forEach(function (code) {
                addUnique(result.blockers, code && (code.code || code));
              });
              continue;
            }
            if (resolvedApplyResult.alreadyApplied === true) result.alreadyAppliedCount += 1;
            else result.appliedCount += 1;
            result.receiptExportReadyCount += 1;
            (Array.isArray(resolvedApplyResult.warnings) ? resolvedApplyResult.warnings : []).forEach(function (code) {
              addUnique(result.warnings, code && (code.code || code));
            });
            result.appliedRequests.push({
              requestId: request.requestId,
              reviewId: cleanString(resolved.reviewId || request.reviewId || request.requestId),
              chatId: request.chatId,
              targetFolderId: request.targetFolderId,
              status: cleanString(resolvedApplyResult.status) || 'already-applied',
              beforeFolderId: cleanString(resolvedApplyResult.beforeFolderId),
              afterFolderId: cleanString(resolvedApplyResult.afterFolderId),
              resolvedCanonicalReconciled: resolvedApplyResult.resolvedCanonicalReconciled === true,
              resolvedCanonicalVerified: resolvedApplyResult.resolvedCanonicalVerified === true,
            });
            continue;
          }
          result.skippedCount += 1;
          result.skippedRequests.push({
            requestId: request.requestId,
            reviewId: request.reviewId,
            chatId: request.chatId,
            targetFolderId: request.targetFolderId,
            status: 'pending-review-not-found',
          });
          addUnique(result.warnings, 'chat-folder-binding-request-pending-review-not-found');
          continue;
        }
        result.attemptedCount += 1;
        var applyResult = await reviews.applyChatFolderBindingRequest({
          reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
          requestId: request.requestId,
        }, {
          reason: 'phase-b9-auto-apply-chrome-chat-folder-binding-request',
        });
        if (applyResult && applyResult.ok === true) {
          if (applyResult.alreadyApplied === true) result.alreadyAppliedCount += 1;
          else result.appliedCount += 1;
          result.receiptExportReadyCount += 1;
          result.appliedRequests.push({
            requestId: request.requestId,
            reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
            chatId: request.chatId,
            targetFolderId: request.targetFolderId,
            status: cleanString(applyResult.status) || 'chat-folder-binding-request-applied',
            beforeFolderId: cleanString(applyResult.beforeFolderId),
            afterFolderId: cleanString(applyResult.afterFolderId),
          });
        } else {
          var status = cleanString(applyResult && applyResult.status) || 'chat-folder-binding-request-apply-failed';
          if (status === 'expected-current-folder-mismatch') result.expectedCurrentFolderMismatchCount += 1;
          if (status === 'target-folder-missing') result.targetFolderMissingCount += 1;
          result.failedCount += 1;
          result.failedRequests.push({
            requestId: request.requestId,
            reviewId: cleanString(row.reviewId || request.reviewId || request.requestId),
            chatId: request.chatId,
            targetFolderId: request.targetFolderId,
            status: status,
            blockers: Array.isArray(applyResult && applyResult.blockers) ? applyResult.blockers.slice() : [],
          });
          (Array.isArray(applyResult && applyResult.blockers) ? applyResult.blockers : []).forEach(function (code) {
            addUnique(result.blockers, code && (code.code || code));
          });
        }
      } catch (e) {
        result.failedCount += 1;
        result.failedRequests.push({
          requestId: request.requestId,
          reviewId: request.reviewId,
          chatId: request.chatId,
          targetFolderId: request.targetFolderId,
          status: 'chat-folder-binding-request-auto-apply-threw',
        });
        addUnique(result.blockers, 'chat-folder-binding-request-auto-apply-threw');
        pushErr('chatFolderBindingRequests.autoApply', e);
      }
    }
    result.desktopAppliedChatFolderBindingRequestCount = result.appliedCount + result.alreadyAppliedCount;
    if (result.failedCount > 0) {
      result.ok = false;
      if (!result.blockers.length) result.blockers.push('chat-folder-binding-request-auto-apply-failed');
      result.status = result.appliedCount || result.alreadyAppliedCount
        ? 'chat-folder-binding-request-auto-apply-partial'
        : 'chat-folder-binding-request-auto-apply-failed';
    } else if (result.appliedCount || result.alreadyAppliedCount) {
      result.status = 'chat-folder-binding-request-auto-applied';
    } else {
      result.status = 'chat-folder-binding-request-auto-apply-skipped';
    }
    state.lastChatFolderBindingRequestAutoApply = result;
    return result;
  }

  function summarizeLibraryMetadataMutationRequestsFromChromeBundle(normalized, options) {
    var bundle = normalized && normalized.bundle && typeof normalized.bundle === 'object'
      ? normalized.bundle : null;
    var sourceRequests = bundle && Array.isArray(bundle.libraryMetadataMutationRequests)
      ? bundle.libraryMetadataMutationRequests : [];
    var requests = sourceRequests.map(sanitizeLibraryMetadataMutationRequestForChromeDesktop).filter(function (request) {
      return !!request;
    });
    var result = {
      schema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA + '.desktop-import.v1',
      ok: true,
      phase: 'phase7-desktop-apply-receipts',
      status: sourceRequests.length ? 'library-metadata-mutation-requests-imported' : 'no-library-metadata-mutation-requests',
      section: 'libraryMetadataMutationRequests',
      found: sourceRequests.length,
      requestCount: requests.length,
      invalid: Math.max(0, sourceRequests.length - requests.length),
      failed: 0,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutationFromChrome: true,
      desktopAuthority: true,
      chromeAuthority: false,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true,
      warnings: [],
      blockers: [],
    };
    if (result.invalid > 0) result.warnings.push('library-metadata-mutation-request-skipped-invalid');
    state.lastLibraryMetadataMutationRequestImport = result;
    return result;
  }

  function libraryMetadataMutationReceiptId(request, status) {
    var requestId = safeMetadataRequestId(request && (request.requestId || request.reviewId)) || 'unknown';
    var cleanStatus = cleanString(status) || 'reviewed';
    return 'library-metadata-mutation-receipt:' + requestId + ':' + cleanStatus;
  }

  async function readLibraryMetadataMutationReceiptExportMirror() {
    var empty = {
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_MIRROR_SCHEMA,
      version: 1,
      updatedAt: '',
      receiptCount: 0,
      receipts: []
    };
    try {
      var mirror = await readKv(LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_KEY);
      if (!mirror || typeof mirror !== 'object' || Array.isArray(mirror)) return empty;
      if (cleanString(mirror.schema) !== LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_MIRROR_SCHEMA) return empty;
      return {
        schema: LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_MIRROR_SCHEMA,
        version: Number(mirror.version || 1) || 1,
        updatedAt: cleanString(mirror.updatedAt),
        receiptCount: Array.isArray(mirror.receipts) ? mirror.receipts.length : 0,
        receipts: Array.isArray(mirror.receipts) ? mirror.receipts.slice() : []
      };
    } catch (e) {
      pushErr('libraryMetadataMutationReceipts.read', e);
      return empty;
    }
  }

  async function upsertLibraryMetadataMutationReceipts(receipts) {
    var rows = Array.isArray(receipts) ? receipts.filter(function (row) {
      return row && typeof row === 'object' &&
        cleanString(row.schema) === LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA &&
        cleanString(row.receiptId);
    }) : [];
    if (!rows.length) return await readLibraryMetadataMutationReceiptExportMirror();
    var current = await readLibraryMetadataMutationReceiptExportMirror();
    var next = Array.isArray(current.receipts) ? current.receipts.slice() : [];
    rows.forEach(function (receipt) {
      var receiptId = cleanString(receipt.receiptId);
      next = next.filter(function (row) {
        return cleanString(row && row.receiptId) !== receiptId;
      });
      next.push(receipt);
    });
    if (next.length > 1000) next = next.slice(next.length - 1000);
    var mirror = {
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_MIRROR_SCHEMA,
      version: 1,
      updatedAt: new Date().toISOString(),
      receiptCount: next.length,
      receipts: next
    };
    await writeKv(LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_KEY, mirror);
    return mirror;
  }

  async function listLibraryMetadataMutationReceipts(options) {
    var opts = safeObject(options);
    var mirror = await readLibraryMetadataMutationReceiptExportMirror();
    var rows = Array.isArray(mirror.receipts) ? mirror.receipts.slice() : [];
    var status = cleanString(opts.status);
    if (status) rows = rows.filter(function (row) {
      return cleanString(row && row.status) === status;
    });
    var limit = numberOrZero(opts.limit) || 1000;
    if (limit > 0) rows = rows.slice(0, Math.min(limit, 1000));
    return rows.map(function (row) { return cloneJson(row); }).filter(Boolean);
  }

  async function captureLibraryMetadataMutationProjectionBasis(requestedBy) {
    try {
      var api = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.libraryMetadataExportProjection;
      if (!api || typeof api.buildDesktopCanonicalMetadataExport !== 'function') {
        return { available: false, projectionHash: '', counts: {}, warnings: ['library-metadata-export-projection-unavailable'] };
      }
      var projection = await api.buildDesktopCanonicalMetadataExport({
        requestedBy: cleanString(requestedBy) || 'phase7-desktop-apply-receipts'
      });
      var hashes = safeObject(projection && projection.hashes);
      return {
        available: true,
        schema: cleanString(projection && projection.schema),
        version: cleanString(projection && projection.version),
        phase: cleanString(projection && projection.phase),
        projectionHash: safeMetadataRequestHash(hashes.projection),
        counts: safeObject(projection && projection.counts),
        privacy: safeObject(projection && projection.privacy),
        safety: safeObject(projection && projection.safety),
        warnings: []
      };
    } catch (e) {
      pushErr('libraryMetadataMutationProjectionBasis.capture', e);
      return { available: false, projectionHash: '', counts: {}, warnings: ['library-metadata-export-projection-failed'] };
    }
  }

  function libraryMetadataMutationReceiptFromRequest(request, status, code, extra) {
    var cleanStatus = cleanString(status) || 'invalid';
    var now = new Date().toISOString();
    var payload = safeObject(request && request.payload);
    var requestId = safeMetadataRequestId(request && (request.requestId || request.reviewId)) || '';
    var action = normalizeLibraryMetadataMutationRequestAction(request || {});
    var data = safeObject(extra);
    return {
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA,
      version: '0.1.0-phase7',
      phase: 'phase7-desktop-apply-receipts',
      receiptId: libraryMetadataMutationReceiptId({ requestId: requestId }, cleanStatus),
      requestId: requestId,
      reviewId: safeMetadataRequestId(request && (request.reviewId || request.requestId)) || requestId,
      idempotencyKey: cleanString(request && request.idempotencyKey),
      requestAction: action,
      requestType: action,
      metadataKind: cleanString(request && request.metadataKind),
      subjectKind: cleanString(request && request.subjectKind),
      status: cleanStatus,
      reason: cleanString(code) || cleanStatus,
      code: cleanString(code) || cleanStatus,
      reviewedAt: now,
      appliedAt: cleanStatus === 'applied' ? now : null,
      source: {
        surface: 'desktop-studio',
        platformAdapter: 'tauri',
        authority: 'desktop',
        requestedBy: 'phase7-desktop-apply-receipts'
      },
      requestSource: {
        surface: cleanString(request && request.sourceSurface) || 'chrome-studio',
        peerId: safeMetadataRequestId(request && request.sourcePeerId) || 'chrome-studio'
      },
      target: {
        chatIdHash: cleanString(data.chatIdHash),
        entityIdHash: cleanString(data.entityIdHash),
        metadataKind: cleanString(request && request.metadataKind),
      },
      expectedCurrentBasisHash: safeMetadataRequestHash(request && request.expectedCurrentBasisHash),
      beforeProjectionHash: safeMetadataRequestHash(data.beforeProjectionHash),
      resultingCanonicalHash: safeMetadataRequestHash(data.resultingCanonicalHash || data.afterProjectionHash),
      beforeAssignmentHash: safeMetadataRequestHash(data.beforeAssignmentHash),
      afterAssignmentHash: safeMetadataRequestHash(data.afterAssignmentHash),
      counts: safeObject(data.counts),
      privacy: {
        redacted: true,
        hashOnly: true,
        rawChatIds: false,
        rawChatTitles: false,
        rawChatContent: false,
        rawLabelNames: false,
        rawTagNames: false,
        rawCategoryNames: false,
        rawColors: false,
        accountLinkedMetadata: false,
        displayNameIncluded: false,
        displayNameReceiptRedacted: !!payload.displayName
      },
      safety: {
        desktopAuthority: true,
        chromeAuthority: false,
        requestOnly: false,
        chromeCanonicalMutation: false,
        noChromeCanonicalMutation: true,
        noDesktopCanonicalMutationFromChrome: true,
        noHardDelete: true,
        noPurge: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true,
        noLabelDelete: true,
        noTagDelete: true,
        noCategoryDelete: true,
        noMetadataDelete: true,
        destructiveMetadataActionsDeferred: true
      },
      separateFromDesktopCanonicalLibraryMetadata: true,
      productSyncReady: false
    };
  }

  async function libraryMetadataMutationTargetHashes(payload) {
    var p = safeObject(payload);
    var chatId = safeMetadataRequestId(p.chatId || p.conversationId);
    var entityId = safeMetadataRequestId(p.entityId || p.labelId || p.tagId || p.categoryId || p.classificationId);
    return {
      chatIdHash: chatId ? await sha256Hex('chat:' + chatId) : '',
      entityIdHash: entityId ? await sha256Hex('entity:' + entityId) : ''
    };
  }

  function validateLibraryMetadataMutationRequestForDesktopApply(request, basis) {
    var blockers = [];
    var action = normalizeLibraryMetadataMutationRequestAction(request || {});
    var spec = libraryMetadataMutationRequestActionSpec(action);
    if (cleanString(request && request.schema) !== LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA) blockers.push('library-metadata-mutation-request-schema-invalid');
    if (cleanString(request && request.intent) !== 'library-metadata-mutation-request') blockers.push('library-metadata-mutation-request-intent-invalid');
    if (cleanString(request && request.status) !== 'pending') blockers.push('library-metadata-mutation-request-status-invalid');
    if (!safeMetadataRequestId(request && (request.requestId || request.reviewId))) blockers.push('library-metadata-mutation-request-id-required');
    if (!cleanString(request && request.idempotencyKey)) blockers.push('library-metadata-mutation-request-idempotency-key-required');
    if (cleanString(request && request.sourceSurface) !== 'chrome-studio') blockers.push('library-metadata-mutation-request-source-surface-invalid');
    if (request && (request.desktopApplyRequired !== true || request.noLocalApply !== true)) blockers.push('library-metadata-mutation-request-apply-flags-invalid');
    if (request && (request.noChromeCanonicalMutation !== true || request.noDesktopCanonicalMutation !== true)) blockers.push('library-metadata-mutation-request-mutation-flags-invalid');
    if (request && (request.noHardDelete !== true || request.noPurge !== true || request.noChatDelete !== true ||
        request.noSnapshotDelete !== true || request.noAssetDelete !== true ||
        request.noLabelDelete !== true || request.noTagDelete !== true ||
        request.noCategoryDelete !== true || request.noMetadataDelete !== true)) {
      blockers.push('library-metadata-mutation-request-safety-flags-invalid');
    }
    var privacy = safeObject(request && request.privacy);
    if (privacy.rawChatContent !== false || privacy.rawChatTitles !== false || privacy.accountLinkedMetadata !== false) {
      blockers.push('library-metadata-mutation-request-privacy-flags-invalid');
    }
    if (libraryMetadataMutationRequestDestructiveAction(action)) {
      return { ok: false, status: 'deferred', code: 'library-metadata-mutation-request-destructive-action-deferred' };
    }
    if (!spec) {
      return { ok: false, status: 'invalid', code: 'library-metadata-mutation-request-action-unsupported' };
    }
    if (blockers.length) {
      return { ok: false, status: 'invalid', code: blockers[0], blockers: blockers };
    }
    if (APPLIED_LIBRARY_METADATA_MUTATION_REQUEST_ACTIONS[action] !== true) {
      return { ok: false, status: 'deferred', code: 'library-metadata-mutation-request-action-deferred-phase7' };
    }
    var payload = safeObject(request && request.payload);
    var chatId = safeMetadataRequestId(payload.chatId || payload.conversationId);
    var categoryId = safeMetadataRequestId(payload.categoryId || payload.entityId);
    var labelId = safeMetadataRequestId(payload.labelId || payload.entityId);
    var tagId = safeMetadataRequestId(payload.tagId || payload.entityId);
    if (!chatId || (action === 'chat-category-assign' && !categoryId) ||
        ((action === 'chat-label-bind' || action === 'chat-label-unbind') && !labelId) ||
        ((action === 'chat-tag-bind' || action === 'chat-tag-unbind') && !tagId)) {
      return { ok: false, status: 'invalid', code: 'library-metadata-mutation-request-target-required' };
    }
    safeMetadataRequestHash(request && request.expectedCurrentBasisHash);
    safeMetadataRequestHash(basis && basis.projectionHash);
    return { ok: true, status: 'ready', code: 'library-metadata-mutation-request-ready' };
  }

  async function applyChatCategoryAssignLibraryMetadataRequest(request, beforeBasis) {
    var stores = H2O.Studio && H2O.Studio.store;
    var categories = stores && stores.categories;
    var chats = stores && stores.chats;
    if (!categories || typeof categories.assignChat !== 'function' || typeof categories.get !== 'function' ||
        !chats || typeof chats.get !== 'function') {
      return { status: 'deferred', code: 'library-metadata-mutation-request-desktop-store-unavailable' };
    }
    var payload = safeObject(request && request.payload);
    var chatId = safeMetadataRequestId(payload.chatId || payload.conversationId);
    var categoryId = safeMetadataRequestId(payload.categoryId || payload.entityId);
    var chatRow = await chats.get(chatId);
    if (!chatRow) return { status: 'rejected', code: 'library-metadata-mutation-request-chat-not-found' };
    var categoryRow = await categories.get(categoryId);
    if (!categoryRow) return { status: 'rejected', code: 'library-metadata-mutation-request-category-not-found' };
    var beforeCategoryId = cleanString(chatRow.categoryId || chatRow.category_id);
    var beforeAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      categoryHash: beforeCategoryId ? await sha256Hex('category:' + beforeCategoryId) : ''
    }));
    var afterAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      categoryHash: await sha256Hex('category:' + categoryId)
    }));
    if (beforeCategoryId === categoryId) {
      return {
        status: 'skipped_duplicate',
        code: 'library-metadata-mutation-request-already-applied-canonical',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var ok = await categories.assignChat(categoryId, chatId);
    if (ok !== true) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-category-assign-failed',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterBasis = await captureLibraryMetadataMutationProjectionBasis('phase7-desktop-apply-receipts-after-apply');
    return {
      status: 'applied',
      code: 'library-metadata-mutation-request-applied',
      beforeAssignmentHash: beforeAssignmentHash,
      afterAssignmentHash: afterAssignmentHash,
      beforeProjectionHash: beforeBasis.projectionHash,
      afterProjectionHash: afterBasis.projectionHash,
      counts: safeObject(afterBasis.counts)
    };
  }

  async function applyChatCategoryClearLibraryMetadataRequest(request, beforeBasis) {
    var stores = H2O.Studio && H2O.Studio.store;
    var categories = stores && stores.categories;
    var chats = stores && stores.chats;
    if (!categories || typeof categories.clearChat !== 'function' ||
        !chats || typeof chats.get !== 'function') {
      return { status: 'deferred', code: 'library-metadata-mutation-request-desktop-store-unavailable' };
    }
    var payload = safeObject(request && request.payload);
    var chatId = safeMetadataRequestId(payload.chatId || payload.conversationId);
    var chatRow = await chats.get(chatId);
    if (!chatRow) return { status: 'rejected', code: 'library-metadata-mutation-request-chat-not-found' };
    var beforeCategoryId = cleanString(chatRow.categoryId || chatRow.category_id);
    var beforeAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      categoryHash: beforeCategoryId ? await sha256Hex('category:' + beforeCategoryId) : ''
    }));
    var afterAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      categoryHash: ''
    }));
    if (!beforeCategoryId) {
      return {
        status: 'skipped_duplicate',
        code: 'library-metadata-mutation-request-already-cleared-canonical',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var ok = await categories.clearChat(chatId);
    if (ok !== true) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-category-clear-failed',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterBasis = await captureLibraryMetadataMutationProjectionBasis('phase13-chat-category-clear-after-apply');
    var afterChatRow = await chats.get(chatId);
    var afterCategoryId = cleanString(afterChatRow && (afterChatRow.categoryId || afterChatRow.category_id));
    if (afterCategoryId) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-category-clear-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: afterBasis.projectionHash,
        counts: safeObject(afterBasis.counts)
      };
    }
    var beforeAssignmentCount = numberOrZero(beforeBasis && beforeBasis.counts && beforeBasis.counts.chatCategoryAssignmentCount);
    var afterAssignmentCount = numberOrZero(afterBasis && afterBasis.counts && afterBasis.counts.chatCategoryAssignmentCount);
    if ((beforeAssignmentCount && afterAssignmentCount !== beforeAssignmentCount - 1) ||
        (beforeBasis.projectionHash && afterBasis.projectionHash && beforeBasis.projectionHash === afterBasis.projectionHash)) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-category-clear-projection-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: afterBasis.projectionHash,
        counts: safeObject(afterBasis.counts)
      };
    }
    return {
      status: 'applied',
      code: 'library-metadata-mutation-request-applied',
      beforeAssignmentHash: beforeAssignmentHash,
      afterAssignmentHash: afterAssignmentHash,
      beforeProjectionHash: beforeBasis.projectionHash,
      afterProjectionHash: afterBasis.projectionHash,
      counts: safeObject(afterBasis.counts)
    };
  }

  function labelRowsContainLabelId(rows, labelId) {
    var target = safeMetadataRequestId(labelId);
    if (!target || !Array.isArray(rows)) return false;
    for (var i = 0; i < rows.length; i += 1) {
      var row = safeObject(rows[i]);
      var id = safeMetadataRequestId(row.labelId || row.id);
      if (id === target) return true;
    }
    return false;
  }

  function tagRowsContainTagId(rows, tagId) {
    var target = safeMetadataRequestId(tagId);
    if (!target || !Array.isArray(rows)) return false;
    for (var i = 0; i < rows.length; i += 1) {
      var row = safeObject(rows[i]);
      var id = safeMetadataRequestId(row.tagId || row.id);
      if (id === target) return true;
    }
    return false;
  }

  async function applyChatLabelBindLibraryMetadataRequest(request, beforeBasis) {
    var stores = H2O.Studio && H2O.Studio.store;
    var labels = stores && stores.labels;
    var chats = stores && stores.chats;
    if (!labels || typeof labels.bindChat !== 'function' || typeof labels.get !== 'function' ||
        typeof labels.listForChat !== 'function' || !chats || typeof chats.get !== 'function') {
      return { status: 'deferred', code: 'library-metadata-mutation-request-desktop-store-unavailable' };
    }
    var payload = safeObject(request && request.payload);
    var chatId = safeMetadataRequestId(payload.chatId || payload.conversationId);
    var labelId = safeMetadataRequestId(payload.labelId || payload.entityId);
    var chatRow = await chats.get(chatId);
    if (!chatRow) return { status: 'rejected', code: 'library-metadata-mutation-request-chat-not-found' };
    var labelRow = await labels.get(labelId);
    if (!labelRow) return { status: 'rejected', code: 'library-metadata-mutation-request-label-not-found' };
    var beforeLabelRows = await labels.listForChat(chatId);
    var alreadyBound = labelRowsContainLabelId(beforeLabelRows, labelId);
    var beforeAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      labelHash: alreadyBound ? await sha256Hex('label:' + labelId) : ''
    }));
    var afterAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      labelHash: await sha256Hex('label:' + labelId)
    }));
    if (alreadyBound) {
      return {
        status: 'skipped_duplicate',
        code: 'library-metadata-mutation-request-already-bound-canonical',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var ok = await labels.bindChat(labelId, chatId);
    if (ok !== true) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-label-bind-failed',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterLabelRows = await labels.listForChat(chatId);
    if (!labelRowsContainLabelId(afterLabelRows, labelId)) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-label-bind-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterBasis = await captureLibraryMetadataMutationProjectionBasis('phase17-chat-label-bind-after-apply');
    var beforeBindingCount = Number(beforeBasis && beforeBasis.counts && beforeBasis.counts.chatLabelBindingCount);
    var afterBindingCount = Number(afterBasis && afterBasis.counts && afterBasis.counts.chatLabelBindingCount);
    if ((Number.isFinite(beforeBindingCount) && Number.isFinite(afterBindingCount) &&
          afterBindingCount !== beforeBindingCount + 1) ||
        (beforeBasis.projectionHash && afterBasis.projectionHash && beforeBasis.projectionHash === afterBasis.projectionHash)) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-label-bind-projection-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: afterBasis.projectionHash,
        counts: safeObject(afterBasis.counts)
      };
    }
    return {
      status: 'applied',
      code: 'library-metadata-mutation-request-applied',
      beforeAssignmentHash: beforeAssignmentHash,
      afterAssignmentHash: afterAssignmentHash,
      beforeProjectionHash: beforeBasis.projectionHash,
      afterProjectionHash: afterBasis.projectionHash,
      counts: safeObject(afterBasis.counts)
    };
  }

  async function applyChatTagBindLibraryMetadataRequest(request, beforeBasis) {
    var stores = H2O.Studio && H2O.Studio.store;
    var tags = stores && stores.tags;
    var chats = stores && stores.chats;
    if (!tags || typeof tags.bindChat !== 'function' || typeof tags.get !== 'function' ||
        typeof tags.listForChat !== 'function' || !chats || typeof chats.get !== 'function') {
      return { status: 'deferred', code: 'library-metadata-mutation-request-desktop-store-unavailable' };
    }
    var payload = safeObject(request && request.payload);
    var chatId = safeMetadataRequestId(payload.chatId || payload.conversationId);
    var tagId = safeMetadataRequestId(payload.tagId || payload.entityId);
    var chatRow = await chats.get(chatId);
    if (!chatRow) return { status: 'rejected', code: 'library-metadata-mutation-request-chat-not-found' };
    var tagRow = await tags.get(tagId);
    if (!tagRow) return { status: 'rejected', code: 'library-metadata-mutation-request-tag-not-found' };
    var beforeTagRows = await tags.listForChat(chatId);
    var alreadyBound = tagRowsContainTagId(beforeTagRows, tagId);
    var beforeAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      tagHash: alreadyBound ? await sha256Hex('tag:' + tagId) : ''
    }));
    var afterAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      tagHash: await sha256Hex('tag:' + tagId)
    }));
    if (alreadyBound) {
      return {
        status: 'skipped_duplicate',
        code: 'library-metadata-mutation-request-already-bound-canonical',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var ok = await tags.bindChat(tagId, chatId);
    if (ok !== true) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-tag-bind-failed',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterTagRows = await tags.listForChat(chatId);
    if (!tagRowsContainTagId(afterTagRows, tagId)) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-tag-bind-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterBasis = await captureLibraryMetadataMutationProjectionBasis('phase22-chat-tag-bind-after-apply');
    var beforeBindingCount = Number(beforeBasis && beforeBasis.counts && beforeBasis.counts.chatTagBindingCount);
    var afterBindingCount = Number(afterBasis && afterBasis.counts && afterBasis.counts.chatTagBindingCount);
    if ((Number.isFinite(beforeBindingCount) && Number.isFinite(afterBindingCount) &&
          afterBindingCount !== beforeBindingCount + 1) ||
        (beforeBasis.projectionHash && afterBasis.projectionHash && beforeBasis.projectionHash === afterBasis.projectionHash)) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-tag-bind-projection-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: afterBasis.projectionHash,
        counts: safeObject(afterBasis.counts)
      };
    }
    return {
      status: 'applied',
      code: 'library-metadata-mutation-request-applied',
      beforeAssignmentHash: beforeAssignmentHash,
      afterAssignmentHash: afterAssignmentHash,
      beforeProjectionHash: beforeBasis.projectionHash,
      afterProjectionHash: afterBasis.projectionHash,
      counts: safeObject(afterBasis.counts)
    };
  }

  async function applyChatLabelUnbindLibraryMetadataRequest(request, beforeBasis) {
    var stores = H2O.Studio && H2O.Studio.store;
    var labels = stores && stores.labels;
    var chats = stores && stores.chats;
    if (!labels || typeof labels.unbindChat !== 'function' || typeof labels.get !== 'function' ||
        typeof labels.listForChat !== 'function' || !chats || typeof chats.get !== 'function') {
      return { status: 'deferred', code: 'library-metadata-mutation-request-desktop-store-unavailable' };
    }
    var payload = safeObject(request && request.payload);
    var chatId = safeMetadataRequestId(payload.chatId || payload.conversationId);
    var labelId = safeMetadataRequestId(payload.labelId || payload.entityId);
    var chatRow = await chats.get(chatId);
    if (!chatRow) return { status: 'rejected', code: 'library-metadata-mutation-request-chat-not-found' };
    var labelRow = await labels.get(labelId);
    if (!labelRow) return { status: 'rejected', code: 'library-metadata-mutation-request-label-not-found' };
    var beforeLabelRows = await labels.listForChat(chatId);
    var wasBound = labelRowsContainLabelId(beforeLabelRows, labelId);
    var beforeAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      labelHash: wasBound ? await sha256Hex('label:' + labelId) : ''
    }));
    var afterAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      labelHash: ''
    }));
    if (!wasBound) {
      return {
        status: 'noop',
        code: 'library-metadata-mutation-request-already-unbound-canonical',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var ok = await labels.unbindChat(labelId, chatId);
    if (ok !== true) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-label-unbind-failed',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterLabelRows = await labels.listForChat(chatId);
    if (labelRowsContainLabelId(afterLabelRows, labelId)) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-label-unbind-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterBasis = await captureLibraryMetadataMutationProjectionBasis('operational2-chat-label-unbind-after-apply');
    var beforeBindingCount = Number(beforeBasis && beforeBasis.counts && beforeBasis.counts.chatLabelBindingCount);
    var afterBindingCount = Number(afterBasis && afterBasis.counts && afterBasis.counts.chatLabelBindingCount);
    if ((Number.isFinite(beforeBindingCount) && Number.isFinite(afterBindingCount) &&
          afterBindingCount !== beforeBindingCount - 1) ||
        (beforeBasis.projectionHash && afterBasis.projectionHash && beforeBasis.projectionHash === afterBasis.projectionHash)) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-label-unbind-projection-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: afterBasis.projectionHash,
        counts: safeObject(afterBasis.counts)
      };
    }
    return {
      status: 'applied',
      code: 'library-metadata-mutation-request-applied',
      beforeAssignmentHash: beforeAssignmentHash,
      afterAssignmentHash: afterAssignmentHash,
      beforeProjectionHash: beforeBasis.projectionHash,
      afterProjectionHash: afterBasis.projectionHash,
      counts: safeObject(afterBasis.counts)
    };
  }

  async function applyChatTagUnbindLibraryMetadataRequest(request, beforeBasis) {
    var stores = H2O.Studio && H2O.Studio.store;
    var tags = stores && stores.tags;
    var chats = stores && stores.chats;
    if (!tags || typeof tags.unbindChat !== 'function' || typeof tags.get !== 'function' ||
        typeof tags.listForChat !== 'function' || !chats || typeof chats.get !== 'function') {
      return { status: 'deferred', code: 'library-metadata-mutation-request-desktop-store-unavailable' };
    }
    var payload = safeObject(request && request.payload);
    var chatId = safeMetadataRequestId(payload.chatId || payload.conversationId);
    var tagId = safeMetadataRequestId(payload.tagId || payload.entityId);
    var chatRow = await chats.get(chatId);
    if (!chatRow) return { status: 'rejected', code: 'library-metadata-mutation-request-chat-not-found' };
    var tagRow = await tags.get(tagId);
    if (!tagRow) return { status: 'rejected', code: 'library-metadata-mutation-request-tag-not-found' };
    var beforeTagRows = await tags.listForChat(chatId);
    var wasBound = tagRowsContainTagId(beforeTagRows, tagId);
    var beforeAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      tagHash: wasBound ? await sha256Hex('tag:' + tagId) : ''
    }));
    var afterAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      tagHash: ''
    }));
    if (!wasBound) {
      return {
        status: 'noop',
        code: 'library-metadata-mutation-request-already-unbound-canonical',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var ok = await tags.unbindChat(tagId, chatId);
    if (ok !== true) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-tag-unbind-failed',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterTagRows = await tags.listForChat(chatId);
    if (tagRowsContainTagId(afterTagRows, tagId)) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-tag-unbind-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        counts: safeObject(beforeBasis.counts)
      };
    }
    var afterBasis = await captureLibraryMetadataMutationProjectionBasis('operational2-chat-tag-unbind-after-apply');
    var beforeBindingCount = Number(beforeBasis && beforeBasis.counts && beforeBasis.counts.chatTagBindingCount);
    var afterBindingCount = Number(afterBasis && afterBasis.counts && afterBasis.counts.chatTagBindingCount);
    if ((Number.isFinite(beforeBindingCount) && Number.isFinite(afterBindingCount) &&
          afterBindingCount !== beforeBindingCount - 1) ||
        (beforeBasis.projectionHash && afterBasis.projectionHash && beforeBasis.projectionHash === afterBasis.projectionHash)) {
      return {
        status: 'rejected',
        code: 'library-metadata-mutation-request-tag-unbind-projection-not-reflected',
        beforeAssignmentHash: beforeAssignmentHash,
        afterAssignmentHash: afterAssignmentHash,
        beforeProjectionHash: beforeBasis.projectionHash,
        afterProjectionHash: afterBasis.projectionHash,
        counts: safeObject(afterBasis.counts)
      };
    }
    return {
      status: 'applied',
      code: 'library-metadata-mutation-request-applied',
      beforeAssignmentHash: beforeAssignmentHash,
      afterAssignmentHash: afterAssignmentHash,
      beforeProjectionHash: beforeBasis.projectionHash,
      afterProjectionHash: afterBasis.projectionHash,
      counts: safeObject(afterBasis.counts)
    };
  }

  async function canonicalLibraryMetadataMutationDuplicateReceiptData(request, beforeBasis) {
    var stores = H2O.Studio && H2O.Studio.store;
    var chats = stores && stores.chats;
    if (!chats || typeof chats.get !== 'function') return null;
    var action = normalizeLibraryMetadataMutationRequestAction(request || {});
    if (action !== 'chat-category-assign' && action !== 'chat-category-clear' &&
        action !== 'chat-label-bind' && action !== 'chat-tag-bind' &&
        action !== 'chat-label-unbind' && action !== 'chat-tag-unbind') return null;
    var payload = safeObject(request && request.payload);
    var chatId = safeMetadataRequestId(payload.chatId || payload.conversationId);
    var categoryId = safeMetadataRequestId(payload.categoryId || payload.entityId);
    var labelId = safeMetadataRequestId(payload.labelId || payload.entityId);
    var tagId = safeMetadataRequestId(payload.tagId || payload.entityId);
    if (!chatId || (action === 'chat-category-assign' && !categoryId) ||
        ((action === 'chat-label-bind' || action === 'chat-label-unbind') && !labelId) ||
        ((action === 'chat-tag-bind' || action === 'chat-tag-unbind') && !tagId)) return null;
    var chatRow = await chats.get(chatId);
    if (!chatRow) return null;
    var beforeCategoryId = cleanString(chatRow.categoryId || chatRow.category_id);
    var targetReached = false;
    if (action === 'chat-label-bind' || action === 'chat-label-unbind') {
      var labels = stores && stores.labels;
      if (!labels || typeof labels.listForChat !== 'function') return null;
      if (action === 'chat-label-unbind') {
        if (typeof labels.get !== 'function') return null;
        var duplicateLabelRow = await labels.get(labelId);
        if (!duplicateLabelRow) return null;
      }
      var labelRows = await labels.listForChat(chatId);
      var hasLabel = labelRowsContainLabelId(labelRows, labelId);
      targetReached = action === 'chat-label-unbind' ? !hasLabel : hasLabel;
    } else if (action === 'chat-tag-bind' || action === 'chat-tag-unbind') {
      var tags = stores && stores.tags;
      if (!tags || typeof tags.listForChat !== 'function') return null;
      if (action === 'chat-tag-unbind') {
        if (typeof tags.get !== 'function') return null;
        var duplicateTagRow = await tags.get(tagId);
        if (!duplicateTagRow) return null;
      }
      var tagRows = await tags.listForChat(chatId);
      var hasTag = tagRowsContainTagId(tagRows, tagId);
      targetReached = action === 'chat-tag-unbind' ? !hasTag : hasTag;
    } else {
      targetReached = action === 'chat-category-clear'
        ? !beforeCategoryId
        : beforeCategoryId === categoryId;
    }
    if (!targetReached) return null;
    var beforeAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      categoryHash: beforeCategoryId ? await sha256Hex('category:' + beforeCategoryId) : '',
      labelHash: (action === 'chat-label-bind' || action === 'chat-label-unbind') ? await sha256Hex('label:' + labelId) : '',
      tagHash: (action === 'chat-tag-bind' || action === 'chat-tag-unbind') ? await sha256Hex('tag:' + tagId) : ''
    }));
    var afterAssignmentHash = await sha256Hex(JSON.stringify({
      chatHash: await sha256Hex('chat:' + chatId),
      categoryHash: action === 'chat-category-assign' && categoryId ? await sha256Hex('category:' + categoryId) : '',
      labelHash: action === 'chat-label-bind' ? await sha256Hex('label:' + labelId) : '',
      tagHash: action === 'chat-tag-bind' ? await sha256Hex('tag:' + tagId) : ''
    }));
    return {
      status: (action === 'chat-label-unbind' || action === 'chat-tag-unbind') ? 'noop' : 'skipped_duplicate',
      code: action === 'chat-category-clear'
        ? 'library-metadata-mutation-request-already-cleared-canonical'
        : (action === 'chat-label-bind' || action === 'chat-tag-bind'
          ? 'library-metadata-mutation-request-already-bound-canonical'
          : (action === 'chat-label-unbind' || action === 'chat-tag-unbind'
            ? 'library-metadata-mutation-request-already-unbound-canonical'
            : 'library-metadata-mutation-request-already-applied-canonical')),
      beforeAssignmentHash: beforeAssignmentHash,
      afterAssignmentHash: afterAssignmentHash,
      beforeProjectionHash: beforeBasis.projectionHash,
      afterProjectionHash: beforeBasis.projectionHash,
      counts: safeObject(beforeBasis.counts)
    };
  }

  async function autoApplyLibraryMetadataMutationRequestsFromChromeBundle(normalized, importResult, options) {
    var bundle = normalized && normalized.bundle && typeof normalized.bundle === 'object'
      ? normalized.bundle : null;
    var sourceRequests = bundle && Array.isArray(bundle.libraryMetadataMutationRequests)
      ? bundle.libraryMetadataMutationRequests : [];
    var requests = sourceRequests.map(sanitizeLibraryMetadataMutationRequestForChromeDesktop).filter(function (request) {
      return !!request;
    });
    var result = {
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA + '.desktop-auto-apply.v1',
      ok: true,
      phase: 'phase7-desktop-apply-receipts',
      status: requests.length ? 'library-metadata-mutation-request-auto-apply-pending' : 'no-library-metadata-mutation-requests',
      model: 'desktop-apply-chrome-library-metadata-mutation-request',
      found: sourceRequests.length,
      requestCount: requests.length,
      importedCount: numberOrZero(importResult && importResult.requestCount),
      attemptedCount: 0,
      appliedCount: 0,
      rejectedCount: 0,
      deferredCount: 0,
      skippedDuplicateCount: 0,
      noopCount: 0,
      staleBasisCount: 0,
      invalidCount: Math.max(0, sourceRequests.length - requests.length),
      failedCount: 0,
      receiptExportReadyCount: 0,
      appliedRequests: [],
      receiptStatuses: [],
      warnings: [],
      blockers: [],
      desktopAuthority: true,
      chromeAuthority: false,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutationFromChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true,
      destructiveMetadataActionsDeferred: true,
      productSyncReady: false
    };
    if (result.invalidCount > 0) addUnique(result.warnings, 'library-metadata-mutation-request-skipped-invalid');
    if (!requests.length) {
      state.lastLibraryMetadataMutationRequestAutoApply = result;
      return result;
    }
    if (!importResult || importResult.ok === false) {
      result.ok = false;
      result.status = 'library-metadata-mutation-request-import-not-ok';
      result.blockers.push('library-metadata-mutation-request-import-not-ok');
      result.failedCount = requests.length;
      state.lastLibraryMetadataMutationRequestAutoApply = result;
      return result;
    }
    var mirror = await readLibraryMetadataMutationReceiptExportMirror();
    var existingReceipts = Array.isArray(mirror.receipts) ? mirror.receipts : [];
    var receipts = [];
    var beforeBasis = await captureLibraryMetadataMutationProjectionBasis('phase7-desktop-apply-receipts-before-apply');
    for (var i = 0; i < requests.length; i += 1) {
      var request = requests[i];
      var targetHashes = await libraryMetadataMutationTargetHashes(request.payload);
      var alreadyApplied = existingReceipts.find(function (receipt) {
        return receipt && cleanString(receipt.status) === 'applied' && (
          cleanString(receipt.requestId) === cleanString(request.requestId) ||
          (cleanString(receipt.idempotencyKey) && cleanString(receipt.idempotencyKey) === cleanString(request.idempotencyKey))
        );
      });
      var canonicalDuplicate = await canonicalLibraryMetadataMutationDuplicateReceiptData(request, beforeBasis);
      if (canonicalDuplicate) {
        if (canonicalDuplicate.status === 'noop') result.noopCount += 1;
        result.skippedDuplicateCount += 1;
        var duplicateReceipt = libraryMetadataMutationReceiptFromRequest(
          request,
          canonicalDuplicate.status,
          canonicalDuplicate.code,
          Object.assign({}, targetHashes, canonicalDuplicate)
        );
        receipts.push(duplicateReceipt);
        result.receiptStatuses.push({ requestId: request.requestId, status: duplicateReceipt.status, code: duplicateReceipt.code });
        continue;
      }
      if (alreadyApplied) {
        addUnique(result.warnings, 'library-metadata-mutation-request-applied-receipt-canonical-mismatch');
      }
      var validation = validateLibraryMetadataMutationRequestForDesktopApply(request, beforeBasis);
      if (!validation.ok) {
        if (validation.status === 'deferred') result.deferredCount += 1;
        else if (validation.status === 'stale_basis') result.staleBasisCount += 1;
        else result.invalidCount += 1;
        var validationReceipt = libraryMetadataMutationReceiptFromRequest(
          request,
          validation.status,
          validation.code,
          Object.assign({}, targetHashes, {
            beforeProjectionHash: beforeBasis.projectionHash,
            resultingCanonicalHash: beforeBasis.projectionHash,
            counts: safeObject(beforeBasis.counts)
          })
        );
        receipts.push(validationReceipt);
        result.receiptStatuses.push({ requestId: request.requestId, status: validationReceipt.status, code: validationReceipt.code });
        continue;
      }
      result.attemptedCount += 1;
      try {
        var requestAction = cleanString(request.requestType || request.action);
        var applied = requestAction === 'chat-category-clear'
          ? await applyChatCategoryClearLibraryMetadataRequest(request, beforeBasis)
          : (requestAction === 'chat-label-bind'
            ? await applyChatLabelBindLibraryMetadataRequest(request, beforeBasis)
            : (requestAction === 'chat-tag-bind'
              ? await applyChatTagBindLibraryMetadataRequest(request, beforeBasis)
              : (requestAction === 'chat-label-unbind'
                ? await applyChatLabelUnbindLibraryMetadataRequest(request, beforeBasis)
                : (requestAction === 'chat-tag-unbind'
                  ? await applyChatTagUnbindLibraryMetadataRequest(request, beforeBasis)
                  : await applyChatCategoryAssignLibraryMetadataRequest(request, beforeBasis)))));
        if (applied.status === 'applied') result.appliedCount += 1;
        else if (applied.status === 'skipped_duplicate') result.skippedDuplicateCount += 1;
        else if (applied.status === 'noop') { result.noopCount += 1; result.skippedDuplicateCount += 1; }
        else if (applied.status === 'deferred') result.deferredCount += 1;
        else if (applied.status === 'stale_basis') result.staleBasisCount += 1;
        else result.rejectedCount += 1;
        var receipt = libraryMetadataMutationReceiptFromRequest(
          request,
          applied.status,
          applied.code,
          Object.assign({}, targetHashes, applied)
        );
        receipts.push(receipt);
        result.receiptStatuses.push({ requestId: request.requestId, status: receipt.status, code: receipt.code });
        if (applied.status === 'applied') {
          result.appliedRequests.push({
            requestId: request.requestId,
            requestType: request.requestType,
            resultingCanonicalHash: receipt.resultingCanonicalHash
          });
          beforeBasis = await captureLibraryMetadataMutationProjectionBasis('phase7-desktop-apply-receipts-after-step');
        }
      } catch (e) {
        result.failedCount += 1;
        addUnique(result.blockers, 'library-metadata-mutation-request-auto-apply-threw');
        pushErr('libraryMetadataMutationRequests.autoApply', e);
        var failureReceipt = libraryMetadataMutationReceiptFromRequest(
          request,
          'rejected',
          'library-metadata-mutation-request-auto-apply-threw',
          Object.assign({}, targetHashes, {
            beforeProjectionHash: beforeBasis.projectionHash,
            resultingCanonicalHash: beforeBasis.projectionHash,
            counts: safeObject(beforeBasis.counts)
          })
        );
        receipts.push(failureReceipt);
        result.receiptStatuses.push({ requestId: request.requestId, status: failureReceipt.status, code: failureReceipt.code });
      }
    }
    var receiptMirror = await upsertLibraryMetadataMutationReceipts(receipts);
    result.receiptExportReadyCount = receipts.length;
    result.receiptExportStoredCount = numberOrZero(receiptMirror.receiptCount);
    if (result.failedCount > 0) {
      result.ok = false;
      result.status = result.appliedCount ? 'library-metadata-mutation-request-auto-apply-partial' : 'library-metadata-mutation-request-auto-apply-failed';
      if (!result.blockers.length) result.blockers.push('library-metadata-mutation-request-auto-apply-failed');
    } else if (result.appliedCount) {
      result.status = 'library-metadata-mutation-request-auto-applied';
    } else if (result.deferredCount || result.rejectedCount || result.staleBasisCount || result.invalidCount || result.skippedDuplicateCount) {
      result.status = 'library-metadata-mutation-request-auto-apply-reviewed';
    } else {
      result.status = 'library-metadata-mutation-request-auto-apply-skipped';
    }
    state.lastLibraryMetadataMutationRequestAutoApply = result;
    return result;
  }

  async function importChromeLatestBundle(bundleInput, options) {
    var normalized = buildChromeDesktopSupportedBundle(bundleInput);
    if (!normalized.ok) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: normalized.blockers || ['library-propagation-bundle-invalid'],
        warnings: normalized.warnings || []
      });
    }
    var ingestion = (H2O.Studio && H2O.Studio.ingestion) || null;
    if (!ingestion || typeof ingestion.importBundle !== 'function') {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-ingestion-unavailable'],
        warnings: normalized.warnings,
        sourceSummary: normalized.sourceSummary
      });
    }
    var importOptions = Object.assign({}, options && typeof options === 'object' ? options : {}, {
      sourceSurface: 'chrome-studio',
      targetSurface: 'desktop-studio',
      transport: 'chrome-latest.json',
      f19ChromeDesktopPropagation: true,
      allowLibraryShimFallback: false,
      skipExistingFolderMetadata: true
    });
    var imported;
    try {
      imported = await ingestion.importBundle(normalized.bundle, 'merge', importOptions);
    } catch (e) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-import-threw'],
        warnings: normalized.warnings,
        sourceSummary: normalized.sourceSummary,
        importSummary: { ok: false, errorsCount: 1 }
      });
    }
    var warnings = normalized.warnings.slice();
    var blockers = [];
    var importSummary = redactedImportSummary(imported);
    var staleMinimalRowsCovered = staleMinimalRowErrorsAreCovered(importSummary, normalized.sourceSummary);
    if (staleMinimalRowsCovered) {
      importSummary.ok = true;
      importSummary.staleMinimalRowErrorsCovered = true;
      addUnique(warnings, 'chrome-minimal-row-stale-error-covered');
    }
    if (!imported || (imported.ok === false && !staleMinimalRowsCovered)) {
      var blockers = ['library-propagation-import-failed'];
      if (importSummary.minimalRowErrors > 0 &&
          (Number(importSummary.minimalRowsFailed || 0) > 0 ||
            Number(importSummary.minimalRowsSatisfied || 0) < (Number(normalized.sourceSummary && normalized.sourceSummary.minimalRowCount || 0) ||
              Number(importSummary.minimalRowsAttempted || 0) ||
              Number(importSummary.minimalRowsTotal || 0) ||
              Number(importSummary.minimalRowErrors || 0)))) {
        addUnique(blockers, 'chrome-minimal-row-import-unsupported');
      }
      return propagationResult(false, {
        status: 'blocked',
        blockers: blockers,
        warnings: warnings,
        sourceSummary: normalized.sourceSummary,
        importSummary: importSummary
      });
    }
    var folderDeleteRequestImport = await ingestFolderDeleteRequestsFromChromeBundle(normalized, options);
    (folderDeleteRequestImport.warnings || []).forEach(function (code) {
      addUnique(warnings, code);
    });
    var folderDeleteRequestAutoApply = await autoApplyFolderDeleteRequestsFromChromeBundle(normalized, folderDeleteRequestImport, options);
    (folderDeleteRequestAutoApply.warnings || []).forEach(function (code) {
      addUnique(warnings, code);
    });
    if (folderDeleteRequestAutoApply.ok === false) {
      var autoApplyBlockers = Array.isArray(folderDeleteRequestAutoApply.blockers) && folderDeleteRequestAutoApply.blockers.length
        ? folderDeleteRequestAutoApply.blockers
        : ['folder-delete-request-auto-apply-failed'];
      autoApplyBlockers.forEach(function (code) {
        addUnique(blockers, code);
      });
    }
    var folderRestoreRequestImport = await ingestFolderRestoreRequestsFromChromeBundle(normalized, options);
    (folderRestoreRequestImport.warnings || []).forEach(function (code) {
      addUnique(warnings, code);
    });
    var folderRestoreRequestAutoApply = await autoApplyFolderRestoreRequestsFromChromeBundle(normalized, folderRestoreRequestImport, options);
    (folderRestoreRequestAutoApply.warnings || []).forEach(function (code) {
      addUnique(warnings, code);
    });
    if (folderRestoreRequestAutoApply.ok === false) {
      var restoreAutoApplyBlockers = Array.isArray(folderRestoreRequestAutoApply.blockers) && folderRestoreRequestAutoApply.blockers.length
        ? folderRestoreRequestAutoApply.blockers
        : ['folder-restore-request-auto-apply-failed'];
      restoreAutoApplyBlockers.forEach(function (code) {
        addUnique(blockers, code);
      });
    }
    var chatFolderBindingRequestImport = await ingestChatFolderBindingRequestsFromChromeBundle(normalized, options);
    (chatFolderBindingRequestImport.warnings || []).forEach(function (code) {
      addUnique(warnings, code);
    });
    var chatFolderBindingRequestAutoApply = await autoApplyChatFolderBindingRequestsFromChromeBundle(normalized, chatFolderBindingRequestImport, options);
    (chatFolderBindingRequestAutoApply.warnings || []).forEach(function (code) {
      addUnique(warnings, code);
    });
    if (chatFolderBindingRequestAutoApply.ok === false) {
      var bindingAutoApplyBlockers = Array.isArray(chatFolderBindingRequestAutoApply.blockers) && chatFolderBindingRequestAutoApply.blockers.length
        ? chatFolderBindingRequestAutoApply.blockers
        : ['chat-folder-binding-request-auto-apply-failed'];
      bindingAutoApplyBlockers.forEach(function (code) {
        addUnique(blockers, code);
      });
    }
    var libraryMetadataMutationRequestImport = summarizeLibraryMetadataMutationRequestsFromChromeBundle(normalized, options);
    (libraryMetadataMutationRequestImport.warnings || []).forEach(function (code) {
      addUnique(warnings, code);
    });
    var libraryMetadataMutationRequestAutoApply = await autoApplyLibraryMetadataMutationRequestsFromChromeBundle(
      normalized,
      libraryMetadataMutationRequestImport,
      options
    );
    (libraryMetadataMutationRequestAutoApply.warnings || []).forEach(function (code) {
      addUnique(warnings, code);
    });
    if (libraryMetadataMutationRequestAutoApply.ok === false) {
      var metadataAutoApplyBlockers = Array.isArray(libraryMetadataMutationRequestAutoApply.blockers) && libraryMetadataMutationRequestAutoApply.blockers.length
        ? libraryMetadataMutationRequestAutoApply.blockers
        : ['library-metadata-mutation-request-auto-apply-failed'];
      metadataAutoApplyBlockers.forEach(function (code) {
        addUnique(blockers, code);
      });
    }
    try {
      if (H2O.LibraryIndex && typeof H2O.LibraryIndex.refresh === 'function') {
        await H2O.LibraryIndex.refresh('f19-chrome-desktop-import');
      }
    } catch (_) {
      addUnique(warnings, 'library-propagation-library-index-refresh-failed');
    }
    var parity = await captureParityAfterImport();
    if (parity.warning) addUnique(warnings, parity.warning);
    return propagationResult(true, {
      status: 'imported',
      blockers: blockers,
      warnings: warnings,
      sourceSummary: normalized.sourceSummary,
      importSummary: importSummary,
      folderDeleteRequestImport: folderDeleteRequestImport,
      folderDeleteRequestAutoApply: folderDeleteRequestAutoApply,
      folderRestoreRequestImport: folderRestoreRequestImport,
      folderRestoreRequestAutoApply: folderRestoreRequestAutoApply,
      chatFolderBindingRequestImport: chatFolderBindingRequestImport,
      chatFolderBindingRequestAutoApply: chatFolderBindingRequestAutoApply,
      libraryMetadataMutationRequestImport: libraryMetadataMutationRequestImport,
      libraryMetadataMutationRequestAutoApply: libraryMetadataMutationRequestAutoApply,
      parity: parity,
      idempotency: {
        fileFingerprintChecked: false,
        mergeOnly: true,
        existingRowsSkipped: true,
        protectedDomainFallbackDisabled: true
      }
    });
  }

  /* ── importFromFile ───────────────────────────────────────────────── */
  /* Read + fingerprint + dedupe + dry-run + importBundle('merge') in one
   * call. Returns { ok, status: 'imported' | 'already-imported' | error,
   * result, ledgerEntry, ... }. Mode is always 'manual' for M2d-1a.
   *
   * Folder-only payloads (detected via isFolderOnlyPayload) take a
   * fast-path through H2O.Studio.ingestion.importFolderStateOnly and
   * skip the full-bundle dry-run (which would reject the missing
   * chatArchive). Full bundles continue to dry-run + importBundle. The
   * result + ledger entry carry a `routedVia` field so diagnostics can
   * tell which path ran. */
  async function importFromFile(filePathArg, options) {
    var importOptions = (options && typeof options === 'object') ? options : {};
    var filePath = String(filePathArg || '').trim();
    if (!filePath) return { ok: false, error: 'path-required' };

    var fileText;
    try { fileText = await fsReadTextFile(filePath); }
    catch (e) {
      pushErr('import.readFile', e);
      return { ok: false, error: 'read-failed', detail: String((e && e.message) || e) };
    }
    var sizeBytes = (typeof fileText === 'string') ? fileText.length : 0;
    if (sizeBytes > MAX_FILE_SIZE_BYTES) return { ok: false, error: 'too-large', sizeBytes: sizeBytes };

    var fingerprint;
    try { fingerprint = await sha256Hex(fileText); }
    catch (e) { return { ok: false, error: 'fingerprint-failed', detail: String((e && e.message) || e) }; }

    var ledger = await getLedger();
    var existing = ledger.entries.filter(function (le) { return le && le.fingerprint === fingerprint; })[0];
    if (existing) {
      return { ok: true, status: 'already-imported', fingerprint: fingerprint, ledgerEntry: existing };
    }

    var bundle;
    try { bundle = JSON.parse(fileText); }
    catch (e) { return { ok: false, error: 'json-parse-failed', detail: String((e && e.message) || e) }; }

    var ingestion = (H2O.Studio && H2O.Studio.ingestion) || null;
    if (!ingestion || typeof ingestion.importBundle !== 'function') {
      return { ok: false, error: 'ingestion-unavailable' };
    }

    /* Folder-only fast-path: when the payload carries only folder state
     * (no chats), route through importFolderStateOnly. This skips the
     * full-bundle dry-run validator (which requires a chatArchive
     * section) and writes folders + folder_bindings + the fallback KV
     * mirror via the existing private importFolders + importFolderBindings
     * code paths. The folder-only entry point is Phase A's narrow API. */
    var folderOnly = isFolderOnlyPayload(bundle)
      && typeof ingestion.importFolderStateOnly === 'function';
    var routedVia = folderOnly ? 'importFolderStateOnly' : 'importBundle';

    /* Defensive dry-run before the actual write — gives early rejection
     * for parse errors that JSON.parse didn't catch and surfaces orphan
     * counts before write commits. Skipped on the folder-only fast-path
     * because dryRunImportBundle requires a chatArchive section. */
    if (!folderOnly && typeof ingestion.dryRunImportBundle === 'function') {
      var dry;
      try { dry = await ingestion.dryRunImportBundle(bundle); }
      catch (e) { return { ok: false, error: 'dry-run-failed', detail: String((e && e.message) || e), routedVia: routedVia }; }
      if (!dry || dry.ok === false) {
        return { ok: false, error: 'dry-run-rejected', dryRunReport: dry, routedVia: routedVia };
      }
    }

    var result;
    try {
      result = folderOnly
        ? await ingestion.importFolderStateOnly(bundle, importOptions)
        : await ingestion.importBundle(bundle, 'merge', importOptions);
    } catch (e) { return { ok: false, error: 'import-failed', detail: String((e && e.message) || e), routedVia: routedVia }; }

    state.lastImportAt = new Date().toISOString();

    /* Phase D — orphan-folder-binding visibility. Count warnings whose
     * `kind === "orphan-folder-binding"` and stash a small sample so
     * diagnose() can surface the latest count. Orphans are NOT errors:
     * the import path persists the binding row and emits the warning so
     * the missing chat ref can be resolved later (e.g. once the chat is
     * imported through a separate ingestion phase). This block is purely
     * additive — it never changes whether the import is treated as ok,
     * never deletes or rewrites bindings, never creates missing chats. */
    var orphanCount = 0;
    var orphanSample = [];
    try {
      var rawWarnings = (result && Array.isArray(result.warnings)) ? result.warnings : [];
      for (var wi = 0; wi < rawWarnings.length; wi += 1) {
        var w = rawWarnings[wi];
        if (w && w.kind === 'orphan-folder-binding') {
          orphanCount += 1;
          if (orphanSample.length < MAX_ORPHAN_SAMPLE) {
            /* Keep the original warning shape (kind/folderId/chatId?) —
             * caller may want to map back to the source binding. */
            orphanSample.push(w);
          }
        }
      }
    } catch (_) { /* visibility-only; never throw from the diagnostic path */ }
    state.lastImportOrphanBindings      = orphanCount;
    state.lastImportOrphanBindingSample = orphanSample;
    state.lastImportOrphanBindingsAt    = state.lastImportAt;

    var entry = {
      fingerprint: fingerprint,
      filename: basename(filePath),
      path: filePath,
      sizeBytes: sizeBytes,
      detectedAt: state.lastImportAt,
      importedAt: state.lastImportAt,
      mode: String(importOptions.mode || 'manual'),
      routedVia: routedVia,
      bundleExportedAt: (bundle && typeof bundle.exportedAt === 'string') ? bundle.exportedAt : '',
      resultSummary: result ? {
        ok: !!result.ok,
        written: result.written || null,
        skipped: result.skipped || null,
        warningsCount: Array.isArray(result.warnings) ? result.warnings.length : 0,
        errorsCount:   Array.isArray(result.errors)   ? result.errors.length   : 0,
        orphanFolderBindingsCount: orphanCount,
      } : null,
    };
    await appendLedgerEntry(entry);
    return {
      ok: !!(result && result.ok !== false),
      status: 'imported',
      fingerprint: fingerprint,
      routedVia: routedVia,
      orphanFolderBindings: orphanCount,
      result: result,
      ledgerEntry: entry,
    };
  }

  function duplicateChromeLatestBundleHasRequestLanes(bundle) {
    if (!bundle || typeof bundle !== 'object') return false;
    return (Array.isArray(bundle.folderDeleteRequests) && bundle.folderDeleteRequests.length > 0) ||
      (Array.isArray(bundle.folderRestoreRequests) && bundle.folderRestoreRequests.length > 0) ||
      (Array.isArray(bundle.chatFolderBindingRequests) && bundle.chatFolderBindingRequests.length > 0) ||
      (Array.isArray(bundle.libraryMetadataMutationRequests) && bundle.libraryMetadataMutationRequests.length > 0);
  }

  async function importChromeLatestFromFile(filePathArg, options) {
    var filePath = String(filePathArg || '').trim();
    if (!filePath) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-path-required']
      });
    }
    if (basename(filePath).toLowerCase() !== CHROME_LATEST_FILE) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-chrome-latest-filename-required']
      });
    }

    var fileText;
    try { fileText = await fsReadTextFile(filePath); }
    catch (e) {
      pushErr('importChromeLatest.readFile', e);
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-read-failed']
      });
    }

    var sizeBytes = (typeof fileText === 'string') ? fileText.length : 0;
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-file-too-large'],
        sourceSummary: { sizeBytes: sizeBytes }
      });
    }

    var fingerprint = '';
    try { fingerprint = await sha256Hex(fileText); }
    catch (e) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-fingerprint-failed']
      });
    }

    var ledger = await getLedger();
    var existing = ledger.entries.filter(function (le) { return le && le.fingerprint === fingerprint; })[0];
    if (existing) {
      var duplicateBundle = null;
      try { duplicateBundle = JSON.parse(fileText); } catch (_) { duplicateBundle = null; }
      if (duplicateChromeLatestBundleHasRequestLanes(duplicateBundle)) {
        var duplicateResult = await importChromeLatestBundle(duplicateBundle, Object.assign(
          {},
          options && typeof options === 'object' ? options : {},
          {
            fileFingerprint: fingerprint,
            mode: 'f19-chrome-desktop-duplicate-request-replay',
            duplicateReplay: true
          }
        ));
        duplicateResult.idempotency = Object.assign({}, duplicateResult.idempotency || {}, {
          fileFingerprintChecked: true,
          alreadyImported: true,
          duplicateRequestReplay: true,
          hardeningCode: F19_SYNC_HARDENING_CODES.duplicateImportIdempotent,
          mergeOnly: true,
          existingRowsSkipped: true,
          protectedDomainFallbackDisabled: true
        });
        addUnique(duplicateResult.warnings, F19_SYNC_HARDENING_CODES.duplicateImportIdempotent);
        return duplicateResult;
      }
      return propagationResult(true, {
        status: 'already-imported',
        warnings: [F19_SYNC_HARDENING_CODES.duplicateImportIdempotent],
        idempotency: {
          fileFingerprintChecked: true,
          alreadyImported: true,
          hardeningCode: F19_SYNC_HARDENING_CODES.duplicateImportIdempotent,
          mergeOnly: true,
          existingRowsSkipped: true,
          protectedDomainFallbackDisabled: true
        }
      });
    }

    var bundle;
    try { bundle = JSON.parse(fileText); }
    catch (e) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-json-parse-failed']
      });
    }

    var transportBlockers = classifyIncomingChromeTransport(bundle, ledger, fingerprint);
    if (transportBlockers.length > 0) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: transportBlockers,
        warnings: [],
        sourceSummary: {
          schema: String(bundle && bundle.schema || ''),
          direction: 'chrome-to-desktop',
          transport: CHROME_LATEST_FILE,
          hasExportId: !!(bundle && bundle.exportId),
          exportedAt: String(bundle && bundle.exportedAt || '')
        },
        idempotency: {
          fileFingerprintChecked: true,
          alreadyImported: false,
          mergeOnly: true,
          existingRowsSkipped: true,
          protectedDomainFallbackDisabled: true
        }
      });
    }

    var result = await importChromeLatestBundle(bundle, Object.assign(
      {},
      options && typeof options === 'object' ? options : {},
      { fileFingerprint: fingerprint, mode: 'f19-chrome-desktop' }
    ));
    result.idempotency = Object.assign({}, result.idempotency || {}, {
      fileFingerprintChecked: true,
      alreadyImported: false
    });
    if (result.ok) {
      state.lastImportAt = new Date().toISOString();
      await appendLedgerEntry({
        fingerprint: fingerprint,
        filename: CHROME_LATEST_FILE,
        path: filePath,
        sizeBytes: sizeBytes,
        detectedAt: state.lastImportAt,
        importedAt: state.lastImportAt,
        mode: 'f19-chrome-desktop',
        routedVia: 'importChromeLatestBundle',
        bundleExportedAt: (bundle && typeof bundle.exportedAt === 'string') ? bundle.exportedAt : '',
        exportId: (bundle && bundle.exportId) ? String(bundle.exportId) : '',
        sequenceNumber: typeof (bundle && bundle.sequenceNumber) === 'number' ? bundle.sequenceNumber : null,
        previousExportId: (bundle && bundle.previousExportId) ? String(bundle.previousExportId) : '',
        resultSummary: {
          ok: true,
          status: result.status,
          warningsCount: result.warnings.length,
          blockersCount: result.blockers.length,
          written: result.importSummary && result.importSummary.written ? result.importSummary.written : null,
          skipped: result.importSummary && result.importSummary.skipped ? result.importSummary.skipped : null
        }
      });
    }
    return result;
  }

  async function importChromeLatestFromFolder(folderPathArg, options) {
    var config = await getConfig();
    var folderPath = String(folderPathArg || config.folderPath || '').trim();
    if (!folderPath) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-folder-required']
      });
    }
    return importChromeLatestFromFile(joinPath(folderPath, CHROME_LATEST_FILE), options);
  }

  function exportLatestSyncBundleFunction() {
    try {
      return H2O.Studio && H2O.Studio.ingestion && H2O.Studio.ingestion.exportLatestSyncBundle;
    } catch (_) {
      return null;
    }
  }

  async function exportDesktopLatestForChrome(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var reason = String(opts.reason || 'desktop-folder-sync-now').trim() || 'desktop-folder-sync-now';
    var exporter = exportLatestSyncBundleFunction();
    if (typeof exporter !== 'function') {
      return propagationResult(false, {
        direction: 'desktop-to-chrome',
        transport: 'latest.json',
        version: F19_DESKTOP_CHROME_VERSION,
        status: 'desktop-to-chrome-export-unavailable',
        blockers: ['desktop-to-chrome-export-unavailable'],
        sourceSummary: {
          direction: 'desktop-to-chrome',
          transport: 'latest.json',
          exporterAvailable: false,
          apiHint: 'Use H2O.Studio.ingestion.exportLatestSyncBundle() after the exporter module loads.'
        }
      });
    }
    try {
      var raw = await exporter(Object.assign({}, opts, {
        direction: 'desktop-to-chrome',
        transport: 'latest.json',
        reason: reason,
        syncNow: true,
        syncNowFacade: 'H2O.Studio.sync.folder.syncNow'
      }));
      var ok = raw && raw.ok === true;
      var status = String(raw && raw.status || (ok ? 'latest-sync-bundle-written' : 'desktop-to-chrome-export-failed'));
      var blockers = ok ? [] : ['desktop-to-chrome-export-failed'];
      return Object.assign({}, raw || {}, {
        schema: PROPAGATION_SCHEMA,
        version: F19_DESKTOP_CHROME_VERSION,
        ok: ok,
        direction: 'desktop-to-chrome',
        transport: 'latest.json',
        status: status,
        blockers: blockers,
        warnings: normalizeHardeningWarnings(raw && raw.warnings),
        supportedFields: CHROME_DESKTOP_SUPPORTED_FIELDS.slice(),
        sourceSummary: {
          direction: 'desktop-to-chrome',
          transport: 'latest.json',
          exporterAvailable: true,
          status: status,
          path: String(raw && raw.path || ''),
          bytes: Number(raw && raw.bytes) || 0,
          exportedAt: String(raw && raw.exportedAt || ''),
          exportId: String(raw && raw.exportId || ''),
          sourceSurfaceKind: String(raw && raw.sourceSurfaceKind || ''),
          sourceStoreKind: String(raw && raw.sourceStoreKind || ''),
          folderCount: Number(raw && raw.folderCount) || null,
          folderDeleteReceiptCount: Number(raw && raw.folderDeleteReceiptCount) || 0,
          folderRestoreReceiptCount: Number(raw && raw.folderRestoreReceiptCount) || 0
        }
      });
    } catch (error) {
      return propagationResult(false, {
        direction: 'desktop-to-chrome',
        transport: 'latest.json',
        version: F19_DESKTOP_CHROME_VERSION,
        status: 'desktop-to-chrome-export-failed',
        blockers: ['desktop-to-chrome-export-failed'],
        sourceSummary: {
          direction: 'desktop-to-chrome',
          transport: 'latest.json',
          exporterAvailable: true,
          error: String(error && (error.message || error))
        }
      });
    }
  }

  async function folderSyncNow(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var direction = String(opts.direction || opts.syncDirection || 'chrome-to-desktop').trim().toLowerCase().replace(/_/g, '-');
    if (!direction || direction === 'chrome-to-desktop' || direction === 'chrome-to-desktop-import') {
      return importChromeLatestFromFolder(opts.folderPath || opts.path || null, Object.assign({}, opts, {
        direction: 'chrome-to-desktop',
        transport: CHROME_LATEST_FILE,
        reason: String(opts.reason || 'desktop-folder-sync-now')
      }));
    }
    if (direction === 'desktop-to-chrome' || direction === 'desktop-to-chrome-export') {
      return exportDesktopLatestForChrome(Object.assign({}, opts, {
        direction: 'desktop-to-chrome',
        reason: String(opts.reason || 'desktop-folder-sync-now')
      }));
    }
    return propagationResult(false, {
      direction: direction,
      transport: direction === 'desktop-to-chrome' ? 'latest.json' : '',
      status: 'blocked',
      blockers: ['library-propagation-direction-unsupported'],
      warnings: [],
      sourceSummary: {
        direction: direction,
        transport: direction === 'desktop-to-chrome' ? 'latest.json' : '',
        supportedDirection: 'chrome-to-desktop',
        apiHint: direction === 'desktop-to-chrome'
          ? 'Use H2O.Studio.sync.autoExport for Desktop -> Chrome latest.json export.'
          : 'Use H2O.Studio.sync.folder.syncNow({ direction: "chrome-to-desktop" }).'
      }
    });
  }

  /* ── M2d-1b: Polling watcher / Notify mode ───────────────────────── */

  function pushWatcherErr(op, e) {
    try {
      var entry = { at: Date.now(), op: String(op), error: String((e && e.message) || e || '') };
      watcherState.errors.push(entry);
      if (watcherState.errors.length > watcherState.errMax) {
        watcherState.errors.splice(0, watcherState.errors.length - watcherState.errMax);
      }
      watcherState.lastError = entry;
    } catch (_) { /* ignore */ }
  }

  function emitWatcherEvent(event) {
    try { watcherState.lastEventAt = (event && event.at) || new Date().toISOString(); }
    catch (_) { /* ignore */ }
    watcherState.listeners.forEach(function (fn) {
      try { fn(event); }
      catch (e) { pushWatcherErr('subscriber', e); }
    });
  }

  function dispatchPostImportRefreshEvent(name, detail, events, errors) {
    try {
      if (typeof global.dispatchEvent !== 'function' || typeof global.CustomEvent !== 'function') return false;
      global.dispatchEvent(new global.CustomEvent(name, { detail: detail }));
      events.push(name);
      return true;
    } catch (e) {
      errors.push(name + ':' + String((e && e.message) || e));
      pushErr('postImportRefresh.dispatch.' + name, e);
      return false;
    }
  }

  function folderRefreshCountsFromResult(result) {
    var importSummary = result && result.importSummary && typeof result.importSummary === 'object'
      ? result.importSummary
      : {};
    var freshness = importSummary.folderMetadataFreshness && typeof importSummary.folderMetadataFreshness === 'object'
      ? importSummary.folderMetadataFreshness
      : {};
    var created = Number(freshness.created || 0) || 0;
    var refreshed = Number(freshness.refreshed || 0) || 0;
    return {
      created: created,
      refreshed: refreshed,
      changedFolderCount: created + refreshed,
    };
  }

  function folderDisplayRowsFromModel(model) {
    var out = [];
    if (!model || typeof model !== 'object') return out;
    [
      model.canonicalRows,
      model.folderDisplayRows,
      model.rows,
      model.folders,
    ].forEach(function (list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (row) {
        if (row && typeof row === 'object') out.push(row);
      });
    });
    return out;
  }

  function folderRowId(row) {
    return String(row && (row.folderId || row.id || row.folder_id) || '').trim();
  }

  function folderRowName(row) {
    return String(row && (row.name || row.title || row.label) || '').trim().replace(/\s+/g, ' ');
  }

  function folderRowColor(row) {
    var meta = row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {};
    var color = String(row && (row.iconColor || row.color) || meta.iconColor || meta.color || '').trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : '';
  }

  function updateDesktopFolderRowNode(node, row) {
    if (!node || !row) return false;
    var folderId = folderRowId(row);
    var name = folderRowName(row);
    var color = folderRowColor(row);
    if (!folderId) return false;
    if (name) {
      try {
        node.setAttribute('data-h2o-folder-name', name);
        node.setAttribute('data-h2o-folder-normalized-name', name.toLowerCase());
        node.setAttribute('title', name);
        node.setAttribute('aria-label', name);
        var label = node.querySelector && node.querySelector('.wbSidebarSectionItemLabel');
        if (label) {
          if (label.children && label.children.length) label.children[0].textContent = name;
          else label.textContent = name;
        }
      } catch (_) { /* best effort */ }
    }
    try {
      if (color) {
        node.setAttribute('data-color', color);
        node.setAttribute('data-h2o-folder-color', color);
        node.style.setProperty('--wb-sidebar-item-color', color);
      } else {
        node.removeAttribute('data-color');
        node.removeAttribute('data-h2o-folder-color');
        node.style.removeProperty('--wb-sidebar-item-color');
      }
    } catch (_) { /* best effort */ }
    return true;
  }

  function applyTargetedDesktopFolderRows(model) {
    var doc = global.document;
    if (!doc || !doc.querySelectorAll) return { attempted: false, updated: 0 };
    var rows = folderDisplayRowsFromModel(model);
    var byId = Object.create(null);
    rows.forEach(function (row) {
      var id = folderRowId(row);
      if (id) byId[id] = row;
    });
    var updated = 0;
    var nodes = doc.querySelectorAll('[data-h2o-folder-sidebar-row="1"], .wbSidebarSectionItem--folders[data-section="folders"], .wbFolderItem[data-folder-id]');
    nodes.forEach(function (node) {
      var id = String(
        node.getAttribute('data-h2o-folder-id') ||
        node.getAttribute('data-folder-id') ||
        node.getAttribute('data-id') ||
        ''
      ).trim();
      if (!id || !byId[id]) return;
      if (updateDesktopFolderRowNode(node, byId[id])) updated += 1;
    });
    return { attempted: true, updated: updated };
  }

  async function refreshDesktopFolderUiAfterChromeImport(result, reason) {
    var cleanReason = String(reason || 'desktop-auto-import').trim() || 'desktop-auto-import';
    var at = new Date().toISOString();
    var status = String(result && result.status || (result && result.ok ? 'imported' : 'blocked'));
    var sourceSummary = result && result.sourceSummary && typeof result.sourceSummary === 'object'
      ? result.sourceSummary
      : {};
    var detail = {
      source: 'desktop-auto-import',
      reason: cleanReason,
      status: status,
      transport: CHROME_LATEST_FILE,
      exportedAt: String(result && result.exportedAt || sourceSummary.exportedAt || ''),
      t: Date.now(),
    };
    var events = [];
    var errors = [];
    var counts = folderRefreshCountsFromResult(result);
    var refreshMode = counts.changedFolderCount > 0 && counts.created === 0
      ? 'targeted-folder-refresh'
      : (counts.created > 0 ? 'sidebar-refresh' : 'no-folder-metadata-change');
    var displayModel = null;
    state.lastPostImportRefreshAt = at;
    state.lastPostImportRefreshReason = cleanReason;
    state.lastPostImportRefreshStatus = 'refresh-pending';
    state.lastPostImportRefreshError = '';
    state.lastPostImportRefreshEvents = [];
    state.lastPostImportRefreshMode = refreshMode;
    state.lastPostImportRefreshChangedFolderCount = counts.changedFolderCount;

    dispatchPostImportRefreshEvent('evt:h2o:folder-metadata:changed', Object.assign({}, detail, {
      refreshMode: refreshMode,
      changedFolderCount: counts.changedFolderCount,
      createdFolderCount: counts.created,
      refreshedFolderCount: counts.refreshed,
    }), events, errors);

    try {
      if (H2O.Library && H2O.Library.FolderParity && typeof H2O.Library.FolderParity.getDisplayModel === 'function') {
        displayModel = await H2O.Library.FolderParity.getDisplayModel({
          fresh: true,
          reason: 'desktop-auto-import-post-import-refresh:' + cleanReason,
        });
        events.push('H2O.Library.FolderParity.getDisplayModel');
      }
    } catch (e) {
      errors.push('FolderParity.getDisplayModel:' + String((e && e.message) || e));
      pushErr('postImportRefresh.folderParity.getDisplayModel', e);
    }

    if (refreshMode === 'targeted-folder-refresh') {
      try {
        var targeted = applyTargetedDesktopFolderRows(displayModel);
        events.push('targeted-folder-refresh:' + String(targeted.updated || 0));
        if (!targeted.attempted || targeted.updated === 0) {
          refreshMode = 'sidebar-refresh';
          state.lastPostImportRefreshMode = refreshMode;
        }
      } catch (e) {
        errors.push('targeted-folder-refresh:' + String((e && e.message) || e));
        pushErr('postImportRefresh.targetedFolderRows', e);
        refreshMode = 'sidebar-refresh';
        state.lastPostImportRefreshMode = refreshMode;
      }
    }

    if (refreshMode === 'sidebar-refresh') {
      try {
        if (H2O.Library && H2O.Library.SidebarSections && typeof H2O.Library.SidebarSections.refresh === 'function') {
          await H2O.Library.SidebarSections.refresh();
          events.push('H2O.Library.SidebarSections.refresh');
        } else {
          dispatchPostImportRefreshEvent('evt:h2o:folders:changed', Object.assign({}, detail, {
            refreshMode: 'full-refresh-fallback',
            changedFolderCount: counts.changedFolderCount,
          }), events, errors);
          refreshMode = 'full-refresh-fallback';
          state.lastPostImportRefreshMode = refreshMode;
        }
      } catch (e) {
        errors.push('SidebarSections.refresh:' + String((e && e.message) || e));
        pushErr('postImportRefresh.sidebarSections.refresh', e);
      }
    }

    state.lastPostImportRefreshAt = new Date().toISOString();
    state.lastPostImportRefreshEvents = events.slice(-12);
    state.lastPostImportRefreshError = errors.join(',');
    state.lastPostImportRefreshStatus = errors.length
      ? (events.length ? 'refreshed-with-warnings' : 'refresh-failed')
      : 'refreshed';
    return {
      status: state.lastPostImportRefreshStatus,
      at: state.lastPostImportRefreshAt,
      mode: state.lastPostImportRefreshMode,
      changedFolderCount: state.lastPostImportRefreshChangedFolderCount,
      events: state.lastPostImportRefreshEvents.slice(),
      error: state.lastPostImportRefreshError,
    };
  }

  async function runDesktopAutoImport(filePath, reason) {
    var cleanPath = String(filePath || '').trim();
    var cleanReason = String(reason || 'desktop-auto-import').trim() || 'desktop-auto-import';
    state.lastAutoImportAt = new Date().toISOString();
    state.lastAutoImportReason = cleanReason;
    state.lastAutoImportPath = cleanPath;
    state.lastAutoImportError = '';
    state.lastAutoImportStatus = 'import-pending';
    state.lastAutoImportBytes = 0;
    try {
      var result = await importChromeLatestFromFile(cleanPath, {
        trigger: 'desktop-auto-import',
        reason: cleanReason,
        autoImport: true,
      });
      state.lastAutoImportAt = new Date().toISOString();
      state.lastImportedChromeExportedAt = String(result && result.exportedAt || '');
      state.lastAutoImportStatus = String(result && result.status || (result && result.ok ? 'imported' : 'blocked'));
      state.lastAutoImportError = result && result.ok ? '' : String((result && (result.error || (result.blockers && result.blockers.join(',')))) || '');
      try {
        var ledger = await getLedger();
        var latest = latestPropagationLedgerEntry(ledger, 'f19-chrome-desktop');
        if (latest && latest.path === cleanPath) {
          state.lastAutoImportBytes = Number(latest.sizeBytes || 0);
        }
      } catch (_) { /* diagnostic-only */ }
      if (result && result.ok) {
        await refreshDesktopFolderUiAfterChromeImport(result, cleanReason);
      }
      return result;
    } catch (e) {
      state.lastAutoImportAt = new Date().toISOString();
      state.lastAutoImportStatus = 'desktop-auto-import-failed';
      state.lastAutoImportError = String((e && e.message) || e);
      pushErr('autoImport', e);
      return propagationResult(false, {
        status: state.lastAutoImportStatus,
        blockers: ['desktop-auto-import-failed'],
        sourceSummary: { path: cleanPath }
      });
    }
  }

  /* Single watcher tick: scan the configured folder once, walk candidates,
   * apply two-cycle file-stability check, emit 'new-candidate' for files
   * that are stable + not in the pending queue + not in the ledger, and
   * always emit 'scan-complete' at the end. Notify mode is detection-only;
   * auto mode imports stable chrome-latest.json through the guarded
   * Chrome->Desktop propagation path. */
  async function runWatcherTick() {
    if (watcherState.scanInFlight) return;       /* single-flight */
    watcherState.scanInFlight = true;
    try {
      var folderPath = String(watcherState.folderPath || '').trim();
      if (!folderPath) {
        pushWatcherErr('tick', 'folderPath empty');
        return;
      }
      var scan;
      try { scan = await scanFolderOnce(folderPath); }
      catch (e) {
        pushWatcherErr('tick.scan', e);
        emitWatcherEvent({ kind: 'error', at: new Date().toISOString(), op: 'scan', error: String((e && e.message) || e) });
        return;
      }
      watcherState.lastScanAt = new Date().toISOString();
      if (!scan || scan.ok === false) {
        var scanErr = (scan && scan.error) || 'scan-failed';
        pushWatcherErr('tick.scan', scanErr);
        emitWatcherEvent({ kind: 'error', at: watcherState.lastScanAt, op: 'scan', error: String(scanErr) });
        return;
      }
      var candidates = Array.isArray(scan.candidates) ? scan.candidates : [];
      var pendingFingerprints = Object.create(null);
      watcherState.pending.forEach(function (p) {
        if (p && p.fingerprint) pendingFingerprints[p.fingerprint] = true;
      });
      var newCandidateCount = 0;
      var stillPresentPaths = Object.create(null);
      for (var i = 0; i < candidates.length; i += 1) {
        var c = candidates[i];
        if (!c || !c.path) continue;
        /* scanFolderOnce already marks: already-imported / too-large /
         * json-parse-failed / dry-run-rejected / read-failed / etc. via
         * .skipped. Don't queue any of those — but DO clean up stale
         * sizeMap entries so re-detection works after a dismiss or after
         * a previously-failed file is replaced. */
        if (c.skipped) {
          /* If a previously-pending candidate is now in the ledger
           * (status 'already-imported'), the user must have imported it
           * since last tick — drop from pending queue. */
          if (c.skipped === 'already-imported' && c.fingerprint && pendingFingerprints[c.fingerprint]) {
            watcherState.pending = watcherState.pending.filter(function (p) { return p.fingerprint !== c.fingerprint; });
            delete pendingFingerprints[c.fingerprint];
          }
          delete watcherState.sizeMap[c.path];
          continue;
        }
        /* Live candidate (not in ledger, parses OK, dry-run OK). */
        var size = (typeof c.sizeBytes === 'number') ? c.sizeBytes : 0;
        var nowMs = Date.now();
        stillPresentPaths[c.path] = true;
        var seen = watcherState.sizeMap[c.path];
        if (!seen) {
          /* First time we've seen this path — record + wait for next tick. */
          watcherState.sizeMap[c.path] = { size: size, firstSeenAtMs: nowMs };
          continue;
        }
        if (seen.size !== size) {
          /* File is still growing; reset the stability clock. */
          watcherState.sizeMap[c.path] = { size: size, firstSeenAtMs: nowMs };
          continue;
        }
        if ((nowMs - seen.firstSeenAtMs) < FILE_STABLE_MIN_MS) {
          /* Stable size but hasn't waited long enough yet. */
          continue;
        }
        /* Stable + waited long enough. */
        if (c.fingerprint && pendingFingerprints[c.fingerprint]) {
          continue;  /* already queued */
        }
        if (watcherState.mode === 'auto' && String(c.filename || '').toLowerCase() === CHROME_LATEST_FILE) {
          var autoImportedAt = new Date().toISOString();
          var autoResult = await runDesktopAutoImport(c.path, 'watcher:auto:' + c.filename);
          delete watcherState.sizeMap[c.path];
          emitWatcherEvent({
            kind: autoResult && autoResult.ok ? 'auto-imported' : 'auto-import-blocked',
            at: autoImportedAt,
            candidate: c,
            result: autoResult,
          });
          continue;
        }
        var entry = {
          fingerprint: c.fingerprint,
          filename:    c.filename,
          path:        c.path,
          sizeBytes:   size,
          exportedAt:  c.exportedAt || '',
          dryRun:      c.dryRun || null,
          detectedAt:  new Date().toISOString(),
        };
        watcherState.pending.push(entry);
        if (c.fingerprint) pendingFingerprints[c.fingerprint] = true;
        newCandidateCount += 1;
        /* Reset sizeMap entry so a future dismiss + replace cycle
         * re-detects via fresh stability tracking. */
        delete watcherState.sizeMap[c.path];
        emitWatcherEvent({ kind: 'new-candidate', at: entry.detectedAt, candidate: entry });
      }
      /* Garbage-collect sizeMap entries for paths no longer in the folder
       * (file was deleted / renamed / moved away). */
      Object.keys(watcherState.sizeMap).forEach(function (path) {
        if (!stillPresentPaths[path]) delete watcherState.sizeMap[path];
      });
      emitWatcherEvent({
        kind: 'scan-complete',
        at: watcherState.lastScanAt,
        candidateCount: candidates.length,
        newCandidateCount: newCandidateCount,
      });
    } catch (e) {
      pushWatcherErr('tick', e);
    } finally {
      watcherState.scanInFlight = false;
    }
  }

  function startWatcher(opts) {
    var optsObj = (opts && typeof opts === 'object') ? opts : {};
    if (watcherState.running) {
      return { ok: true, started: false, alreadyRunning: true, intervalMs: watcherState.intervalMs };
    }
    var requested = (typeof optsObj.intervalMs === 'number' && isFinite(optsObj.intervalMs))
      ? Math.floor(optsObj.intervalMs) : DEFAULT_INTERVAL_MS;
    var intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, requested));
    watcherState.intervalMs = intervalMs;
    watcherState.running = true;
    watcherState.sizeMap = Object.create(null);  /* fresh stability state */
    watcherState.scanInFlight = false;
    var scanOnStart = optsObj.scanOnStart !== false;
    if (scanOnStart) {
      runWatcherTick().catch(function (e) { pushWatcherErr('startScan', e); });
    }
    watcherState.intervalId = global.setInterval(function () {
      runWatcherTick().catch(function (e) { pushWatcherErr('tick', e); });
    }, intervalMs);
    return { ok: true, started: true, intervalMs: intervalMs };
  }

  function stopWatcher() {
    if (!watcherState.running) {
      return { ok: true, stopped: false, alreadyStopped: true };
    }
    if (watcherState.intervalId != null) {
      try { global.clearInterval(watcherState.intervalId); } catch (_) { /* ignore */ }
      watcherState.intervalId = null;
    }
    watcherState.running = false;
    watcherState.sizeMap = Object.create(null);
    watcherState.scanInFlight = false;
    return { ok: true, stopped: true };
  }

  function getWatcherState() {
    return {
      running:        watcherState.running,
      intervalMs:     watcherState.intervalMs,
      folderPath:     watcherState.folderPath,
      mode:           watcherState.mode,
      lastScanAt:     watcherState.lastScanAt,
      lastEventAt:    watcherState.lastEventAt,
      pendingCount:   watcherState.pending.length,
      listenerCount:  watcherState.listeners.size,
      stableMs:       FILE_STABLE_MIN_MS,
      scanInFlight:   watcherState.scanInFlight,
      sizeMapTracking: Object.keys(watcherState.sizeMap).length,
      errorsCount:    watcherState.errors.length,
      lastError:      watcherState.lastError,
    };
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () { /* noop */ };
    if (watcherState.listeners.size >= MAX_LISTENERS) {
      pushWatcherErr('subscribe', 'listener cap reached (' + MAX_LISTENERS + '); ignoring new subscription');
      return function () { /* noop */ };
    }
    watcherState.listeners.add(fn);
    return function () { watcherState.listeners.delete(fn); };
  }

  function getPendingCandidates() {
    /* Defensive shallow copy — caller can mutate without affecting state. */
    return watcherState.pending.slice();
  }

  function dismissPending(fingerprint) {
    var fp = String(fingerprint || '').trim();
    if (!fp) return { ok: false, dismissed: false, error: 'fingerprint-required' };
    var before = watcherState.pending.length;
    watcherState.pending = watcherState.pending.filter(function (p) {
      return !p || p.fingerprint !== fp;
    });
    var dismissed = watcherState.pending.length !== before;
    if (dismissed) {
      emitWatcherEvent({
        kind: 'candidate-dismissed',
        at: new Date().toISOString(),
        fingerprint: fp,
      });
    }
    return { ok: true, dismissed: dismissed };
  }

  /* Called from setConfig + boot. Compares the next/prev config to decide
   * whether the watcher should be running with the right folder. Always
   * updates the cached config snapshot first so getWatcherState() reflects
   * reality immediately. */
  function reconcileWatcherFromConfig(next, prev) {
    watcherState.folderPath = String((next && next.folderPath) || '').trim();
    watcherState.mode       = String((next && next.mode) || 'off');
    var shouldRun = (watcherState.mode === 'notify' || watcherState.mode === 'auto')
                 && !!watcherState.folderPath;
    var folderPathChanged = !prev || (String(prev.folderPath || '') !== watcherState.folderPath);
    if (!shouldRun) {
      if (watcherState.running) {
        stopWatcher();
        watcherState.pending = [];   /* clear queue when stopping */
        emitWatcherEvent({ kind: 'scan-complete', at: new Date().toISOString(), candidateCount: 0, newCandidateCount: 0, stopped: true });
      }
      return;
    }
    if (watcherState.running) {
      if (folderPathChanged) {
        stopWatcher();
        watcherState.pending = [];
        startWatcher();
      }
      /* else: already running with the correct folder; nothing to do */
      return;
    }
    /* Not running, should be → start. */
    startWatcher();
  }

  /* ── Diagnose ─────────────────────────────────────────────────────── */
  function diagnose() {
    var ingestion = (H2O.Studio && H2O.Studio.ingestion) || null;
    return {
      installed: true,
      stage: 'M2d-1b',
      mode: 'manual+notify',
      keys: { config: CONFIG_KEY, ledger: LEDGER_KEY },
      limits: {
        maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
        maxLedgerEntries: MAX_LEDGER_ENTRIES,
        intervalMs: {
          min: MIN_INTERVAL_MS,
          max: MAX_INTERVAL_MS,
          default: DEFAULT_INTERVAL_MS,
        },
        fileStableMinMs: FILE_STABLE_MIN_MS,
        maxListeners: MAX_LISTENERS,
      },
      filenamePatterns: FILENAME_PATTERNS.map(function (r) { return r.toString(); }),
      ignoreSuffixes: IGNORE_SUFFIXES.slice(),
      ingestionAvailable: !!(ingestion && typeof ingestion.importBundle === 'function'),
      folderOnlyApiAvailable: !!(ingestion && typeof ingestion.importFolderStateOnly === 'function'),
      libraryMetadataMutationApplyRuntime: libraryMetadataMutationApplyRuntimeDiagnostic(),
      chromeDesktopPropagation: {
        schema: PROPAGATION_SCHEMA,
        version: F19_CHROME_DESKTOP_VERSION,
        transport: CHROME_LATEST_FILE,
        direction: 'chrome-to-desktop',
        supportedFields: CHROME_DESKTOP_SUPPORTED_FIELDS.slice(),
        deferredCodes: Object.assign({}, CHROME_DESKTOP_DEFERRED_CODES),
        hardeningTaxonomy: Object.assign({}, F19_SYNC_HARDENING_CODES),
        offlineRestartBehavior: {
          chromeOffline: 'chrome-latest.json remains pending until Desktop imports it',
          desktopOffline: 'Desktop ledger replays chrome-latest.json after restart',
          repeatedImport: F19_SYNC_HARDENING_CODES.duplicateImportIdempotent,
          staleTransport: F19_SYNC_HARDENING_CODES.transportStale,
          simultaneousUpdate: F19_SYNC_HARDENING_CODES.simultaneousUpdateConflict
        },
        guardedImportAvailable: !!(ingestion && typeof ingestion.importBundle === 'function')
      },
      state: {
        lastScanAt: state.lastScanAt,
        lastImportAt: state.lastImportAt,
        lastAutoImportAt: state.lastAutoImportAt,
        lastAutoImportStatus: state.lastAutoImportStatus,
        lastAutoImportError: state.lastAutoImportError,
        lastAutoImportPath: state.lastAutoImportPath,
        lastAutoImportBytes: state.lastAutoImportBytes,
        lastAutoImportReason: state.lastAutoImportReason,
        lastPostImportRefreshAt: state.lastPostImportRefreshAt,
        lastPostImportRefreshStatus: state.lastPostImportRefreshStatus,
        lastPostImportRefreshError: state.lastPostImportRefreshError,
        lastPostImportRefreshReason: state.lastPostImportRefreshReason,
        lastPostImportRefreshMode: state.lastPostImportRefreshMode,
        lastPostImportRefreshChangedFolderCount: state.lastPostImportRefreshChangedFolderCount,
        lastPostImportRefreshEvents: state.lastPostImportRefreshEvents.slice(),
        lastFolderDeleteRequestImport: state.lastFolderDeleteRequestImport ? {
          ok: state.lastFolderDeleteRequestImport.ok === true,
          phase: cleanString(state.lastFolderDeleteRequestImport.phase),
          status: cleanString(state.lastFolderDeleteRequestImport.status),
          found: numberOrZero(state.lastFolderDeleteRequestImport.found),
          inserted: numberOrZero(state.lastFolderDeleteRequestImport.inserted),
          updated: numberOrZero(state.lastFolderDeleteRequestImport.updated),
          duplicatePending: numberOrZero(state.lastFolderDeleteRequestImport.duplicatePending),
          skipped: numberOrZero(state.lastFolderDeleteRequestImport.skipped),
          invalid: numberOrZero(state.lastFolderDeleteRequestImport.invalid),
          failed: numberOrZero(state.lastFolderDeleteRequestImport.failed),
          noApply: state.lastFolderDeleteRequestImport.noApply === true,
          desktopApplyDeferred: state.lastFolderDeleteRequestImport.desktopApplyDeferred === true,
          tombstonePropagation: cleanString(state.lastFolderDeleteRequestImport.tombstonePropagation),
        } : null,
        lastFolderDeleteRequestAutoApply: state.lastFolderDeleteRequestAutoApply ? {
          ok: state.lastFolderDeleteRequestAutoApply.ok === true,
          phase: cleanString(state.lastFolderDeleteRequestAutoApply.phase),
          status: cleanString(state.lastFolderDeleteRequestAutoApply.status),
          model: cleanString(state.lastFolderDeleteRequestAutoApply.model),
          found: numberOrZero(state.lastFolderDeleteRequestAutoApply.found),
          requestCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.requestCount),
          importedCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.importedCount),
          attemptedCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.attemptedCount),
          appliedCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.appliedCount),
          alreadyAppliedCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.alreadyAppliedCount),
          skippedCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.skippedCount),
          failedCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.failedCount),
          receiptExportReadyCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.receiptExportReadyCount),
          desktopImportedFolderDeleteRequestCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.desktopImportedFolderDeleteRequestCount),
          desktopAppliedFolderDeleteRequestCount: numberOrZero(state.lastFolderDeleteRequestAutoApply.desktopAppliedFolderDeleteRequestCount),
          noChromePurgeAuthority: state.lastFolderDeleteRequestAutoApply.noChromePurgeAuthority === true,
          noChromeTombstoneApply: state.lastFolderDeleteRequestAutoApply.noChromeTombstoneApply === true,
          noHardDelete: state.lastFolderDeleteRequestAutoApply.noHardDelete === true,
          noChatDelete: state.lastFolderDeleteRequestAutoApply.noChatDelete === true,
          noSnapshotDelete: state.lastFolderDeleteRequestAutoApply.noSnapshotDelete === true,
          noAssetDelete: state.lastFolderDeleteRequestAutoApply.noAssetDelete === true,
        } : null,
        lastFolderRestoreRequestImport: state.lastFolderRestoreRequestImport ? {
          ok: state.lastFolderRestoreRequestImport.ok === true,
          phase: cleanString(state.lastFolderRestoreRequestImport.phase),
          status: cleanString(state.lastFolderRestoreRequestImport.status),
          found: numberOrZero(state.lastFolderRestoreRequestImport.found),
          inserted: numberOrZero(state.lastFolderRestoreRequestImport.inserted),
          updated: numberOrZero(state.lastFolderRestoreRequestImport.updated),
          duplicatePending: numberOrZero(state.lastFolderRestoreRequestImport.duplicatePending),
          skipped: numberOrZero(state.lastFolderRestoreRequestImport.skipped),
          invalid: numberOrZero(state.lastFolderRestoreRequestImport.invalid),
          failed: numberOrZero(state.lastFolderRestoreRequestImport.failed),
          noApply: state.lastFolderRestoreRequestImport.noApply === true,
          desktopApplyDeferred: state.lastFolderRestoreRequestImport.desktopApplyDeferred === true,
          desktopRestoreDeferred: state.lastFolderRestoreRequestImport.desktopRestoreDeferred === true,
        } : null,
        lastFolderRestoreRequestAutoApply: state.lastFolderRestoreRequestAutoApply ? {
          ok: state.lastFolderRestoreRequestAutoApply.ok === true,
          phase: cleanString(state.lastFolderRestoreRequestAutoApply.phase),
          status: cleanString(state.lastFolderRestoreRequestAutoApply.status),
          model: cleanString(state.lastFolderRestoreRequestAutoApply.model),
          found: numberOrZero(state.lastFolderRestoreRequestAutoApply.found),
          requestCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.requestCount),
          importedCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.importedCount),
          attemptedCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.attemptedCount),
          appliedCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.appliedCount),
          alreadyAppliedCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.alreadyAppliedCount),
          purgedBlockedCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.purgedBlockedCount),
          noActiveTombstoneBlockedCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.noActiveTombstoneBlockedCount),
          skippedCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.skippedCount),
          failedCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.failedCount),
          receiptExportReadyCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.receiptExportReadyCount),
          desktopImportedFolderRestoreRequestCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.desktopImportedFolderRestoreRequestCount),
          desktopAppliedFolderRestoreRequestCount: numberOrZero(state.lastFolderRestoreRequestAutoApply.desktopAppliedFolderRestoreRequestCount),
          noChromeRestoreAuthority: state.lastFolderRestoreRequestAutoApply.noChromeRestoreAuthority === true,
          noChromePurgeAuthority: state.lastFolderRestoreRequestAutoApply.noChromePurgeAuthority === true,
          noChromeTombstoneApply: state.lastFolderRestoreRequestAutoApply.noChromeTombstoneApply === true,
          noHardDelete: state.lastFolderRestoreRequestAutoApply.noHardDelete === true,
          noChatDelete: state.lastFolderRestoreRequestAutoApply.noChatDelete === true,
          noSnapshotDelete: state.lastFolderRestoreRequestAutoApply.noSnapshotDelete === true,
          noAssetDelete: state.lastFolderRestoreRequestAutoApply.noAssetDelete === true,
        } : null,
        lastChatFolderBindingRequestImport: state.lastChatFolderBindingRequestImport ? {
          ok: state.lastChatFolderBindingRequestImport.ok === true,
          phase: cleanString(state.lastChatFolderBindingRequestImport.phase),
          status: cleanString(state.lastChatFolderBindingRequestImport.status),
          found: numberOrZero(state.lastChatFolderBindingRequestImport.found),
          inserted: numberOrZero(state.lastChatFolderBindingRequestImport.inserted),
          updated: numberOrZero(state.lastChatFolderBindingRequestImport.updated),
          duplicatePending: numberOrZero(state.lastChatFolderBindingRequestImport.duplicatePending),
          skipped: numberOrZero(state.lastChatFolderBindingRequestImport.skipped),
          invalid: numberOrZero(state.lastChatFolderBindingRequestImport.invalid),
          failed: numberOrZero(state.lastChatFolderBindingRequestImport.failed),
          noApply: state.lastChatFolderBindingRequestImport.noApply === true,
          desktopApplyDeferred: state.lastChatFolderBindingRequestImport.desktopApplyDeferred === true,
          noChromeBindingAuthority: state.lastChatFolderBindingRequestImport.noChromeBindingAuthority === true,
          noChromeDestructiveBindingApply: state.lastChatFolderBindingRequestImport.noChromeDestructiveBindingApply === true,
          noHardDelete: state.lastChatFolderBindingRequestImport.noHardDelete === true,
          noChatDelete: state.lastChatFolderBindingRequestImport.noChatDelete === true,
          noSnapshotDelete: state.lastChatFolderBindingRequestImport.noSnapshotDelete === true,
          noAssetDelete: state.lastChatFolderBindingRequestImport.noAssetDelete === true,
        } : null,
        lastChatFolderBindingRequestAutoApply: state.lastChatFolderBindingRequestAutoApply ? {
          ok: state.lastChatFolderBindingRequestAutoApply.ok === true,
          phase: cleanString(state.lastChatFolderBindingRequestAutoApply.phase),
          status: cleanString(state.lastChatFolderBindingRequestAutoApply.status),
          model: cleanString(state.lastChatFolderBindingRequestAutoApply.model),
          found: numberOrZero(state.lastChatFolderBindingRequestAutoApply.found),
          requestCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.requestCount),
          importedCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.importedCount),
          attemptedCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.attemptedCount),
          appliedCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.appliedCount),
          alreadyAppliedCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.alreadyAppliedCount),
          expectedCurrentFolderMismatchCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.expectedCurrentFolderMismatchCount),
          targetFolderMissingCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.targetFolderMissingCount),
          skippedCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.skippedCount),
          failedCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.failedCount),
          receiptExportReadyCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.receiptExportReadyCount),
          desktopImportedChatFolderBindingRequestCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.desktopImportedChatFolderBindingRequestCount),
          desktopAppliedChatFolderBindingRequestCount: numberOrZero(state.lastChatFolderBindingRequestAutoApply.desktopAppliedChatFolderBindingRequestCount),
          noChromeBindingAuthority: state.lastChatFolderBindingRequestAutoApply.noChromeBindingAuthority === true,
          noChromeDestructiveBindingApply: state.lastChatFolderBindingRequestAutoApply.noChromeDestructiveBindingApply === true,
          noHardDelete: state.lastChatFolderBindingRequestAutoApply.noHardDelete === true,
          noChatDelete: state.lastChatFolderBindingRequestAutoApply.noChatDelete === true,
          noSnapshotDelete: state.lastChatFolderBindingRequestAutoApply.noSnapshotDelete === true,
          noAssetDelete: state.lastChatFolderBindingRequestAutoApply.noAssetDelete === true,
        } : null,
        lastLibraryMetadataMutationRequestImport: state.lastLibraryMetadataMutationRequestImport ? {
          ok: state.lastLibraryMetadataMutationRequestImport.ok === true,
          phase: cleanString(state.lastLibraryMetadataMutationRequestImport.phase),
          status: cleanString(state.lastLibraryMetadataMutationRequestImport.status),
          section: cleanString(state.lastLibraryMetadataMutationRequestImport.section),
          found: numberOrZero(state.lastLibraryMetadataMutationRequestImport.found),
          requestCount: numberOrZero(state.lastLibraryMetadataMutationRequestImport.requestCount),
          invalid: numberOrZero(state.lastLibraryMetadataMutationRequestImport.invalid),
          failed: numberOrZero(state.lastLibraryMetadataMutationRequestImport.failed),
          desktopAuthority: state.lastLibraryMetadataMutationRequestImport.desktopAuthority === true,
          chromeAuthority: state.lastLibraryMetadataMutationRequestImport.chromeAuthority === true,
          noChromeCanonicalMutation: state.lastLibraryMetadataMutationRequestImport.noChromeCanonicalMutation === true,
          noDesktopCanonicalMutationFromChrome: state.lastLibraryMetadataMutationRequestImport.noDesktopCanonicalMutationFromChrome === true,
          noHardDelete: state.lastLibraryMetadataMutationRequestImport.noHardDelete === true,
          noPurge: state.lastLibraryMetadataMutationRequestImport.noPurge === true,
          noChatDelete: state.lastLibraryMetadataMutationRequestImport.noChatDelete === true,
          noSnapshotDelete: state.lastLibraryMetadataMutationRequestImport.noSnapshotDelete === true,
          noAssetDelete: state.lastLibraryMetadataMutationRequestImport.noAssetDelete === true,
          noLabelDelete: state.lastLibraryMetadataMutationRequestImport.noLabelDelete === true,
          noTagDelete: state.lastLibraryMetadataMutationRequestImport.noTagDelete === true,
          noCategoryDelete: state.lastLibraryMetadataMutationRequestImport.noCategoryDelete === true,
          noMetadataDelete: state.lastLibraryMetadataMutationRequestImport.noMetadataDelete === true,
        } : null,
        lastLibraryMetadataMutationRequestAutoApply: state.lastLibraryMetadataMutationRequestAutoApply ? {
          ok: state.lastLibraryMetadataMutationRequestAutoApply.ok === true,
          phase: cleanString(state.lastLibraryMetadataMutationRequestAutoApply.phase),
          status: cleanString(state.lastLibraryMetadataMutationRequestAutoApply.status),
          model: cleanString(state.lastLibraryMetadataMutationRequestAutoApply.model),
          found: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.found),
          requestCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.requestCount),
          importedCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.importedCount),
          attemptedCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.attemptedCount),
          appliedCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.appliedCount),
          rejectedCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.rejectedCount),
          deferredCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.deferredCount),
          skippedDuplicateCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.skippedDuplicateCount),
          staleBasisCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.staleBasisCount),
          invalidCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.invalidCount),
          failedCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.failedCount),
          receiptExportReadyCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.receiptExportReadyCount),
          receiptExportStoredCount: numberOrZero(state.lastLibraryMetadataMutationRequestAutoApply.receiptExportStoredCount),
          desktopAuthority: state.lastLibraryMetadataMutationRequestAutoApply.desktopAuthority === true,
          chromeAuthority: state.lastLibraryMetadataMutationRequestAutoApply.chromeAuthority === true,
          noChromeCanonicalMutation: state.lastLibraryMetadataMutationRequestAutoApply.noChromeCanonicalMutation === true,
          noDesktopCanonicalMutationFromChrome: state.lastLibraryMetadataMutationRequestAutoApply.noDesktopCanonicalMutationFromChrome === true,
          noHardDelete: state.lastLibraryMetadataMutationRequestAutoApply.noHardDelete === true,
          noPurge: state.lastLibraryMetadataMutationRequestAutoApply.noPurge === true,
          noChatDelete: state.lastLibraryMetadataMutationRequestAutoApply.noChatDelete === true,
          noSnapshotDelete: state.lastLibraryMetadataMutationRequestAutoApply.noSnapshotDelete === true,
          noAssetDelete: state.lastLibraryMetadataMutationRequestAutoApply.noAssetDelete === true,
          noLabelDelete: state.lastLibraryMetadataMutationRequestAutoApply.noLabelDelete === true,
          noTagDelete: state.lastLibraryMetadataMutationRequestAutoApply.noTagDelete === true,
          noCategoryDelete: state.lastLibraryMetadataMutationRequestAutoApply.noCategoryDelete === true,
          noMetadataDelete: state.lastLibraryMetadataMutationRequestAutoApply.noMetadataDelete === true,
          productSyncReady: state.lastLibraryMetadataMutationRequestAutoApply.productSyncReady === true,
        } : null,
        errors: state.errors.slice(-5),
        warnings: state.warnings.slice(-5),
        /* Phase D — orphan-folder-binding visibility (visibility only,
         * does not change import semantics). 0 means the last import
         * produced no orphans (or no import has run since boot, in which
         * case lastImportOrphanBindingsAt is null). */
        lastImportOrphanBindings:      state.lastImportOrphanBindings,
        lastImportOrphanBindingSample: state.lastImportOrphanBindingSample.slice(),
        lastImportOrphanBindingsAt:    state.lastImportOrphanBindingsAt,
      },
      watcher: {
        running:        watcherState.running,
        intervalMs:     watcherState.intervalMs,
        folderPath:     watcherState.folderPath,
        mode:           watcherState.mode,
        lastScanAt:     watcherState.lastScanAt,
        lastEventAt:    watcherState.lastEventAt,
        pendingCount:   watcherState.pending.length,
        listenerCount:  watcherState.listeners.size,
        scanInFlight:   watcherState.scanInFlight,
        sizeMapTracking: Object.keys(watcherState.sizeMap).length,
        errors:         watcherState.errors.slice(-5),
        lastError:      watcherState.lastError,
      },
      desktopToChrome: {
        autoExportEnabled: !!(H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.autoExport &&
          H2O.Studio.sync.autoExport.diagnose && H2O.Studio.sync.autoExport.diagnose().desktopToChrome &&
          H2O.Studio.sync.autoExport.diagnose().desktopToChrome.autoExportEnabled),
        latestTransport: 'latest.json',
        lastExportStatus: (function () {
          try {
            var d = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.autoExport &&
              H2O.Studio.sync.autoExport.diagnose && H2O.Studio.sync.autoExport.diagnose();
            return d && d.desktopToChrome ? d.desktopToChrome.lastExportStatus : '';
          } catch (_) { return ''; }
        })(),
        lastExportedAt: (function () {
          try {
            var d = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.autoExport &&
              H2O.Studio.sync.autoExport.diagnose && H2O.Studio.sync.autoExport.diagnose();
            return d && d.desktopToChrome ? d.desktopToChrome.lastExportedAt : '';
          } catch (_) { return ''; }
        })(),
        lastExportBytes: (function () {
          try {
            var d = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.autoExport &&
              H2O.Studio.sync.autoExport.diagnose && H2O.Studio.sync.autoExport.diagnose();
            return d && d.desktopToChrome ? d.desktopToChrome.lastExportBytes : 0;
          } catch (_) { return 0; }
        })(),
      },
      chromeToDesktop: {
        chromeWritesSyncFolder: false,
        desktopReadsChromeLatestJson: true,
        autoImportEnabled: watcherState.mode === 'auto' && !!watcherState.folderPath,
        desktopAutoImportEnabled: watcherState.mode === 'auto' && !!watcherState.folderPath,
        lastImportStatus: state.lastAutoImportStatus,
        lastImportedAt: state.lastAutoImportAt,
        lastImportBytes: state.lastAutoImportBytes,
        lastImportPath: state.lastAutoImportPath,
        lastImportReason: state.lastAutoImportReason,
        lastImportError: state.lastAutoImportError,
        desktopLastImportStatus: state.lastAutoImportStatus,
        desktopLastImportedAt: state.lastAutoImportAt,
        desktopLastImportError: state.lastAutoImportError,
        postImportRefreshStatus: state.lastPostImportRefreshStatus,
        postImportRefreshAt: state.lastPostImportRefreshAt,
        postImportRefreshError: state.lastPostImportRefreshError,
        postImportRefreshMode: state.lastPostImportRefreshMode,
        postImportRefreshChangedFolderCount: state.lastPostImportRefreshChangedFolderCount,
        watcherRunning: watcherState.running,
        watcherMode: watcherState.mode,
        pendingActions: watcherState.pending.length,
      },
      desktopAutoImport: {
        autoImportEnabled: watcherState.mode === 'auto' && !!watcherState.folderPath,
        lastImportStatus: state.lastAutoImportStatus,
        lastAutoImportStatus: state.lastAutoImportStatus,
        lastImportedAt: state.lastAutoImportAt,
        lastAutoImportAt: state.lastAutoImportAt,
        lastImportError: state.lastAutoImportError,
        lastAutoImportError: state.lastAutoImportError,
        lastImportedChromeExportedAt: state.lastImportedChromeExportedAt,
        watcherMode: watcherState.mode,
        watcherRunning: watcherState.running,
        configuredMode: state.lastAutoImportConfigMode,
        effectiveMode: state.lastAutoImportEffectiveMode || watcherState.mode,
        configMigration: state.lastAutoImportConfigMigration,
        postImportRefresh: {
          status: state.lastPostImportRefreshStatus,
          at: state.lastPostImportRefreshAt,
          reason: state.lastPostImportRefreshReason,
          mode: state.lastPostImportRefreshMode,
          changedFolderCount: state.lastPostImportRefreshChangedFolderCount,
          error: state.lastPostImportRefreshError,
          events: state.lastPostImportRefreshEvents.slice(),
        },
      },
    };
  }

  function diagnoseHealth() {
    var raw = diagnose();
    var desktopToChromeRaw = safeObject(raw.desktopToChrome);
    var chromeToDesktopRaw = safeObject(raw.chromeToDesktop);
    var desktopAutoImportRaw = safeObject(raw.desktopAutoImport);
    var watcherRaw = safeObject(raw.watcher);
    var postImportRefresh = safeObject(desktopAutoImportRaw.postImportRefresh);
    var autoExportRaw = {};
    var foldersStoreDiag = {};
    var tombstoneStoreAvailable = false;
    try {
      var autoExport = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.autoExport;
      autoExportRaw = autoExport && typeof autoExport.diagnose === 'function' ? safeObject(autoExport.diagnose()) : {};
    } catch (_) {
      autoExportRaw = {};
    }
    try {
      var stores = H2O.Studio && H2O.Studio.store;
      var folderStore = stores && stores.folders;
      var tombstoneStore = stores && stores.tombstones;
      tombstoneStoreAvailable = !!(tombstoneStore && typeof tombstoneStore.createTombstone === 'function');
      foldersStoreDiag = folderStore && typeof folderStore.diagnose === 'function' ? safeObject(folderStore.diagnose()) : {};
    } catch (_) {
      foldersStoreDiag = {};
      tombstoneStoreAvailable = false;
    }
    var autoExportDtc = safeObject(autoExportRaw.desktopToChrome);
    var blockers = [];
    var warnings = [];
    var statusCodes = [];
    var desktopAutoImportEnabled = desktopAutoImportRaw.autoImportEnabled === true ||
      chromeToDesktopRaw.desktopAutoImportEnabled === true;
    var desktopAutoExportEnabled = autoExportDtc.autoExportEnabled === true ||
      desktopToChromeRaw.autoExportEnabled === true;
    var pending = !!(autoExportDtc.pending || watcherRaw.pendingCount || chromeToDesktopRaw.pendingActions);
    var inFlight = !!(autoExportDtc.flushInFlight || watcherRaw.scanInFlight);
    var disabled = !desktopAutoExportEnabled && !desktopAutoImportEnabled;
    var permission = watcherRaw.folderPath ? 'desktop-local-filesystem' : 'not-configured';

    if (!desktopAutoExportEnabled) addHealthCode(statusCodes, 'auto-export-disabled');
    if (!desktopAutoImportEnabled) addHealthCode(statusCodes, 'auto-import-disabled');
    if (!watcherRaw.folderPath) addHealthCode(blockers, 'no-folder-handle');
    if (watcherRaw.mode === 'off' && !desktopAutoImportEnabled) addHealthCode(statusCodes, 'auto-sync-disabled');
    if (shouldReportDesktopSchedulerNotFired(autoExportRaw, autoExportDtc)) {
      addHealthCode(warnings, 'scheduler-not-fired');
      addHealthCode(statusCodes, 'scheduler-not-fired');
    }
    addHealthCodesFromError(blockers, autoExportDtc.lastExportError || autoExportRaw.lastExportError);
    addHealthCodesFromError(blockers, chromeToDesktopRaw.desktopLastImportError || desktopAutoImportRaw.lastImportError);
    if (Array.isArray(watcherRaw.errors)) {
      for (var i = 0; i < watcherRaw.errors.length; i += 1) {
        addHealthCodesFromError(blockers, watcherRaw.errors[i] && (watcherRaw.errors[i].error || watcherRaw.errors[i].message || watcherRaw.errors[i]));
      }
    }
    if (watcherRaw.lastError) addHealthCodesFromError(blockers, watcherRaw.lastError.error || watcherRaw.lastError);
    if (state.warnings.length) addHealthCode(statusCodes, 'desktop-import-warning-present');

    var verdict = folderHealthVerdict(blockers, warnings, pending, inFlight, disabled && !blockers.length);
    return {
      schema: FOLDER_SYNC_HEALTH_SCHEMA,
      version: FOLDER_SYNC_HEALTH_VERSION,
      surface: 'desktop-studio',
      observedAt: new Date().toISOString(),
      verdict: verdict,
      summaryText: folderHealthSummary(verdict),
      blockers: blockers,
      warnings: warnings,
      statusCodes: statusCodes,
      privacy: {
        redacted: true,
        rawIdsReturned: false,
        rawTitlesReturned: false,
        rawContentReturned: false
      },
      desktopToChrome: {
        autoExportEnabled: desktopAutoExportEnabled,
        latestTransport: cleanString(desktopToChromeRaw.latestTransport || 'latest.json'),
        lastExportStatus: cleanString(autoExportDtc.lastExportStatus || desktopToChromeRaw.lastExportStatus),
        lastExportedAt: cleanString(autoExportDtc.lastExportedAt || desktopToChromeRaw.lastExportedAt),
        lastExportBytes: numberOrZero(autoExportDtc.lastExportBytes || desktopToChromeRaw.lastExportBytes),
        lastExportError: cleanString(autoExportDtc.lastExportError || autoExportRaw.lastExportError),
        lastImportStatus: '',
        lastAppliedExportedAt: '',
        lastPropagationMs: 0,
        pending: !!autoExportDtc.pending,
        inFlight: !!autoExportDtc.flushInFlight,
        permission: 'desktop-local-filesystem',
        noOpRefreshSuppressed: false,
        refreshSuppressedCount: 0,
        changedFolderCount: 0,
        changedFolderIds: [],
        changedFolderIdsRedacted: true
      },
      chromeToDesktop: {
        chromeWritesSyncFolder: !!chromeToDesktopRaw.chromeWritesSyncFolder,
        exportApiAvailable: false,
        permission: permission,
        lastExportStatus: '',
        lastExportedAt: cleanString(state.lastImportedChromeExportedAt),
        lastExportBytes: 0,
        lastExportError: '',
        desktopAutoImportEnabled: desktopAutoImportEnabled,
        desktopLastImportStatus: cleanString(chromeToDesktopRaw.desktopLastImportStatus || desktopAutoImportRaw.lastImportStatus),
        desktopLastImportedAt: cleanString(chromeToDesktopRaw.desktopLastImportedAt || desktopAutoImportRaw.lastImportedAt),
        desktopLastImportError: cleanString(chromeToDesktopRaw.desktopLastImportError || desktopAutoImportRaw.lastImportError),
        pending: numberOrZero(watcherRaw.pendingCount) > 0,
        inFlight: !!watcherRaw.scanInFlight
      },
      uiRefreshHealth: {
        postImportRefreshMode: cleanString(postImportRefresh.mode || chromeToDesktopRaw.postImportRefreshMode),
        renderRefreshCount: numberOrZero(postImportRefresh.events && postImportRefresh.events.length),
        cumulativeRenderRefreshCount: numberOrZero(postImportRefresh.events && postImportRefresh.events.length),
        refreshSuppressed: false,
        refreshSuppressedCount: 0,
        lastChangedFolderCount: numberOrZero(postImportRefresh.changedFolderCount || chromeToDesktopRaw.postImportRefreshChangedFolderCount),
        lastChangedFields: []
      },
      loopPrevention: {
        loopSuppressed: 0,
        duplicateSuppressed: 0,
        selfOriginSkipped: 0
      },
      tombstoneLocalDelete: {
        phase: 'desktop-local-soft-delete',
        tombstoneStoreAvailable: tombstoneStoreAvailable,
        activeTombstoneCount: numberOrZero(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).activeTombstoneCount),
        restoreAvailableCount: numberOrZero(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).restoreAvailableCount),
        affectedChatCount: numberOrZero(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).affectedChatCount),
        lastAffectedChatCount: numberOrZero(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).lastAffectedChatCount),
        lastBindingRestoreAttemptedCount: numberOrZero(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).lastBindingRestoreAttemptedCount),
        lastBindingRestoredCount: numberOrZero(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).lastBindingRestoredCount),
        lastBindingSkippedCount: numberOrZero(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).lastBindingSkippedCount),
        lastRestoreWarnings: Array.isArray(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).lastRestoreWarnings)
          ? safeObject(foldersStoreDiag.phase4aLocalSoftDelete).lastRestoreWarnings.slice(0, 20).map(function (code) { return cleanString(code); }).filter(Boolean)
          : [],
        purgeBlocked: true,
        hardDeleteBlocked: true,
        chatDeleteBlocked: true,
        chromeDeleteSync: 'deferred',
        tombstoneSync: 'deferred',
        lastOperation: cleanString(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).lastOperation),
        lastStatus: cleanString(safeObject(foldersStoreDiag.phase4aLocalSoftDelete).lastStatus)
      },
      watcher: {
        running: !!watcherRaw.running,
        mode: cleanString(watcherRaw.mode),
        intervalMs: numberOrZero(watcherRaw.intervalMs),
        pendingCount: numberOrZero(watcherRaw.pendingCount),
        scanInFlight: !!watcherRaw.scanInFlight,
        lastScanAt: watcherRaw.lastScanAt || null,
        lastEventAt: watcherRaw.lastEventAt || null
      },
      deferred: {
        deleteTombstone: 'deferred',
        webdav: 'deferred'
      }
    };
  }

  /* ── Register ────────────────────────────────────────────────────── */
  var existingSync = H2O.Studio.sync && typeof H2O.Studio.sync === 'object' ? H2O.Studio.sync : {};
  var desktopSyncApi = {
    __installed: true,
    __version: '0.2.0',
    /* M2d-1a manual API */
    getConfig:       getConfig,
    setConfig:       setConfig,
    getLedger:       getLedger,
    clearLedger:     clearLedger,
    scanFolderOnce:  scanFolderOnce,
    importFromFile:  importFromFile,
    importChromeLatestBundle:     importChromeLatestBundle,
    importChromeLatestFromFile:   importChromeLatestFromFile,
    importChromeLatestFromFolder: importChromeLatestFromFolder,
    chromeDesktopPropagationSchema: PROPAGATION_SCHEMA,
    chromeDesktopPropagationVersion: F19_CHROME_DESKTOP_VERSION,
    chromeDesktopHardeningTaxonomy: Object.assign({}, F19_SYNC_HARDENING_CODES),
    diagnose:        diagnose,
    diagnoseHealth:  diagnoseHealth,
    /* M2d-1b polling watcher + Notify-mode API */
    startWatcher:         startWatcher,
    stopWatcher:          stopWatcher,
    getWatcherState:      getWatcherState,
    subscribe:            subscribe,
    getPendingCandidates: getPendingCandidates,
    dismissPending:       dismissPending,
  };

  var folderApi = Object.assign({}, existingSync.folder && typeof existingSync.folder === 'object' ? existingSync.folder : {}, {
    __installed: true,
    __version: '0.1.0-f19.7.k',
    direction: 'chrome-to-desktop',
    transport: CHROME_LATEST_FILE,
    supportedDirections: ['chrome-to-desktop', 'desktop-to-chrome'],
    chromeWritesSyncFolder: false,
    desktopReadsChromeLatestJson: true,
    desktopWritesLatestJson: true,
    desktopToChromeTransport: 'latest.json',
    getConfig: getConfig,
    setConfig: setConfig,
    getLedger: getLedger,
    clearLedger: clearLedger,
    scanFolderOnce: scanFolderOnce,
    importFromFile: importFromFile,
    importChromeLatestBundle: importChromeLatestBundle,
    importChromeLatestFromFile: importChromeLatestFromFile,
    importChromeLatestFromFolder: importChromeLatestFromFolder,
    importChromeFromSyncFolder: importChromeLatestFromFolder,
    importChromeLatestFromSyncFolder: importChromeLatestFromFolder,
    listLibraryMetadataMutationReceipts: listLibraryMetadataMutationReceipts,
    libraryMetadataMutationReceiptSchema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA,
    libraryMetadataMutationReceiptExportKey: LIBRARY_METADATA_MUTATION_RECEIPT_EXPORT_KEY,
    syncNow: folderSyncNow,
    diagnose: diagnose,
    diagnoseHealth: diagnoseHealth,
    health: Object.assign({}, existingSync.folder && existingSync.folder.health &&
      typeof existingSync.folder.health === 'object' ? existingSync.folder.health : {}, {
      diagnose: diagnoseHealth,
    }),
    startWatcher: startWatcher,
    stopWatcher: stopWatcher,
    getWatcherState: getWatcherState,
    subscribe: subscribe,
    getPendingCandidates: getPendingCandidates,
    dismissPending: dismissPending,
  });

  /* ===================== Binding repair Desktop handler =====================
   * Scope: canonical Desktop SQLite folder_bindings apply ONLY. Dry-run by default; gated apply.
   * Emits CHAT_FOLDER_BINDING_RECEIPT_SCHEMA. Writes ONLY folder_bindings through store.folders
   * bindChat / unbindChat / moveCanonicalChatFolderBinding. NO folder/chat delete, NO purge, NO
   * tombstone mutation (passes skipBindingTombstone), NO mirror write-through, NO WebDAV/CAS,
   * NO productSyncReady flip, and NO F11 allowed-set change. Chrome/native/mobile remain
   * non-canonical proposers. */
  var CHAT_FOLDER_BINDING_REPAIR_APPLY_GATE = 'folder-sync-chat-folder-binding-repair-apply';
  var CHAT_FOLDER_BINDING_REPAIR_OPERATION_KIND = 'chat-folder-binding-repair';
  var CHAT_FOLDER_BINDING_REPAIR_INTENTS = ['bind', 'unbind', 'move'];
  var CHAT_FOLDER_BINDING_REPAIR_FORBIDDEN_KEYS = ['name', 'title', 'content'];

  function bindingRepairArr(v) { return Array.isArray(v) ? v : []; }
  function bindingRepairFolderId(row) { return cleanString(row && (row.folderId || row.folder_id || row.id)); }
  function bindingRepairChatId(row) { return cleanString(row && (row.chatId || row.chat_id || row.conversationId)); }
  function bindingRepairHasForbiddenKeys(obj) {
    if (!obj || typeof obj !== 'object') return false;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      if (CHAT_FOLDER_BINDING_REPAIR_FORBIDDEN_KEYS.indexOf(k) !== -1) return true;
      var v = obj[k];
      if (v && typeof v === 'object' && bindingRepairHasForbiddenKeys(v)) return true;
    }
    return false;
  }
  async function chatFolderBindingHashFromRows(rows) {
    var parts = bindingRepairArr(rows).map(function (row) {
      var chatId = bindingRepairChatId(row);
      var folderId = bindingRepairFolderId(row);
      return chatId && folderId ? chatId + '>' + folderId : '';
    }).filter(Boolean).sort();
    return 'sha256:' + await sha256Hex('chat-folder-binding-repair|' + parts.join('|'));
  }
  function bindingRepairConsumedLedger() {
    var d = H2O && H2O.Desktop && H2O.Desktop.Sync;
    if (d && typeof d.listConsumedOperations === 'function' &&
        typeof d.recordConsumedOperation === 'function') return d;
    return null;
  }
  async function bindingRepairDedupeKey(request) {
    var req = safeObject(request);
    try { return await sha256Hex(CHAT_FOLDER_BINDING_REPAIR_OPERATION_KIND + '|dedupe|' + cleanString(req.idempotencyKey)); }
    catch (e) { return ''; }
  }
  async function bindingRepairEventDigest(request) {
    var req = safeObject(request);
    try {
      return await sha256Hex(CHAT_FOLDER_BINDING_REPAIR_OPERATION_KIND + '|digest|' + cleanString(req.schema) + '|' +
        cleanString(req.idempotencyKey) + '|' + cleanString(req.basisBindingHash) + '|' + cleanString(req.requestedBindingHash));
    } catch (e) { return ''; }
  }
  async function bindingRepairAlreadyConsumed(request) {
    var ledger = bindingRepairConsumedLedger();
    if (!ledger) return { available: false, consumed: false, dedupeKey: '' };
    var dedupeKey = await bindingRepairDedupeKey(request);
    if (!dedupeKey) return { available: false, consumed: false, dedupeKey: '' };
    var listed = null;
    try { listed = await ledger.listConsumedOperations(); }
    catch (e) { return { available: false, consumed: false, dedupeKey: dedupeKey }; }
    var rows = listed && Array.isArray(listed.rows) ? listed.rows : [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      if (cleanString(row.operationKind) === CHAT_FOLDER_BINDING_REPAIR_OPERATION_KIND &&
          cleanString(row.dedupeKey).toLowerCase() === dedupeKey.toLowerCase()) {
        return { available: true, consumed: true, dedupeKey: dedupeKey };
      }
    }
    return { available: true, consumed: false, dedupeKey: dedupeKey };
  }
  async function bindingRepairRecordConsumed(request) {
    var ledger = bindingRepairConsumedLedger();
    if (!ledger) return { ok: false, reason: 'ledger-unavailable' };
    var dedupeKey = await bindingRepairDedupeKey(request);
    var eventDigest = await bindingRepairEventDigest(request);
    if (!dedupeKey || !eventDigest) return { ok: false, reason: 'digest-unavailable' };
    var res = null;
    try {
      res = await ledger.recordConsumedOperation({
        eventDigest: eventDigest,
        dedupeKey: dedupeKey,
        envelopeKind: 'applyEvent',
        operationKind: CHAT_FOLDER_BINDING_REPAIR_OPERATION_KIND,
        consumedStatus: 'consumed',
        reason: 'chat-folder-binding-repair-applied',
      });
    } catch (e) { return { ok: false, reason: 'record-threw' }; }
    return { ok: !!(res && res.ok), reason: (res && res.ok) ? 'recorded'
      : (res && Array.isArray(res.blockers) && res.blockers.length ? res.blockers.join(',') : 'record-failed') };
  }
  function validateChatFolderBindingRepairRequestForDesktopApply(request) {
    var blockers = [];
    var req = safeObject(request);
    var intent = cleanString(req.intent);
    if (cleanString(req.schema) !== CHAT_FOLDER_BINDING_REQUEST_SCHEMA) blockers.push('chat-folder-binding-request-schema-invalid');
    if (CHAT_FOLDER_BINDING_REPAIR_INTENTS.indexOf(intent) === -1) blockers.push('chat-folder-binding-request-intent-invalid');
    if (!cleanString(req.requestId || req.reviewId)) blockers.push('chat-folder-binding-request-id-required');
    if (!cleanString(req.sourcePeerId) && !cleanString(req.deviceId)) blockers.push('chat-folder-binding-request-peer-id-required');
    if (['chrome-extension', 'native-extension', 'mobile'].indexOf(cleanString(req.surfaceKind)) === -1) blockers.push('chat-folder-binding-request-surface-kind-invalid');
    if (!cleanString(req.chatId || req.conversationId)) blockers.push('chat-folder-binding-request-chat-id-required');
    if ((intent === 'bind' || intent === 'move') && !cleanString(req.targetFolderId || req.folderId)) {
      blockers.push('chat-folder-binding-request-target-folder-id-required');
    }
    if ((intent === 'move' || intent === 'unbind') && !cleanString(req.previousFolderId || req.expectedCurrentFolderId || req.currentFolderId)) {
      blockers.push('chat-folder-binding-request-previous-folder-id-required');
    }
    if (!cleanString(req.basisBindingHash)) blockers.push('chat-folder-binding-request-basis-hash-required');
    if (!cleanString(req.requestedBindingHash)) blockers.push('chat-folder-binding-request-requested-hash-required');
    if (!cleanString(req.createdAt) || Number.isNaN(Date.parse(cleanString(req.createdAt)))) blockers.push('chat-folder-binding-request-created-at-invalid');
    if (!cleanString(req.idempotencyKey)) blockers.push('chat-folder-binding-request-idempotency-key-required');
    if (req.desktopApplyRequired !== true || req.noLocalApply !== true) blockers.push('chat-folder-binding-request-apply-flags-invalid');
    if (req.noChromeCanonicalMutation !== true && req.noChromeBindingAuthority !== true) blockers.push('chat-folder-binding-request-chrome-authority-flag-required');
    if (req.noHardDelete !== true || req.noPurge !== true || req.noChatDelete !== true ||
        req.noFolderDelete !== true || req.noTombstoneMutation !== true) {
      blockers.push('chat-folder-binding-request-safety-flags-invalid');
    }
    var privacy = safeObject(req.privacy);
    if (privacy.rawFolderNames === true || privacy.rawChatTitles === true || privacy.rawChatContent === true) {
      blockers.push('chat-folder-binding-request-privacy-flags-invalid');
    }
    if (bindingRepairHasForbiddenKeys(req)) blockers.push('chat-folder-binding-request-redaction-violation');
    return { ok: blockers.length === 0, blockers: blockers };
  }
  async function chatFolderBindingCanonicalSnapshot() {
    var stores = H2O.Studio && H2O.Studio.store;
    var folders = stores && stores.folders;
    if (!folders || typeof folders.listCanonicalChatFolderBindings !== 'function') return null;
    // Ensure the boot/reload F15 settled-binding restart convergence has completed before reading canonical
    // truth, so a post-restart snapshot reflects the re-materialized folder_bindings and never a stale
    // pre-convergence read. One-shot + fail-safe: convergence is bounded and always resolves; a failure never
    // blocks the snapshot.
    if (typeof folders.whenF15SettledBindingRestartConvergenceReady === 'function') {
      try { await folders.whenF15SettledBindingRestartConvergenceReady('binding-snapshot'); } catch (e) {}
    }
    var visible = typeof folders.getAll === 'function' ? bindingRepairArr(await folders.getAll()) : [];
    var tomb = [];
    if (typeof folders.listRecentlyDeletedFolders === 'function') {
      try { tomb = bindingRepairArr(await folders.listRecentlyDeletedFolders({ limit: 1000 })); } catch (e) { tomb = []; }
    }
    var presentSet = Object.create(null);
    visible.forEach(function (row) { var id = bindingRepairFolderId(row); if (id) presentSet[id] = true; });
    var tombSet = Object.create(null);
    tomb.forEach(function (row) { var id = bindingRepairFolderId(row); if (id) tombSet[id] = true; });
    var rows = bindingRepairArr(await folders.listCanonicalChatFolderBindings());
    var bindingByChatId = Object.create(null);
    rows.forEach(function (row) {
      var chatId = bindingRepairChatId(row);
      var folderId = bindingRepairFolderId(row);
      if (chatId && folderId && typeof bindingByChatId[chatId] === 'undefined') bindingByChatId[chatId] = folderId;
    });
    return {
      rows: rows,
      bindingByChatId: bindingByChatId,
      presentFolderSet: presentSet,
      tombstonedFolderSet: tombSet,
      bindingHash: await chatFolderBindingHashFromRows(rows),
    };
  }
  async function chatFolderBindingRepairChatExists(chatId) {
    var stores = H2O.Studio && H2O.Studio.store;
    var chats = stores && stores.chats;
    if (!chats || typeof chats.get !== 'function') return true;
    try { return !!(await chats.get(chatId)); } catch (e) { return false; }
  }
  async function classifyChatFolderBindingRepairConflict(request, snapshot, ctx) {
    var req = safeObject(request);
    var snap = safeObject(snapshot);
    var intent = cleanString(req.intent);
    var chatId = cleanString(req.chatId || req.conversationId);
    var targetFolderId = cleanString(req.targetFolderId || req.folderId);
    var previousFolderId = cleanString(req.previousFolderId || req.expectedCurrentFolderId || req.currentFolderId);
    ctx = safeObject(ctx);
    var appliedKeys = safeObject(ctx.appliedKeys);
    var currentFolderId = cleanString(snap.bindingByChatId && snap.bindingByChatId[chatId]);
    if (appliedKeys[cleanString(req.idempotencyKey)]) {
      if ((intent === 'bind' || intent === 'move') && currentFolderId === targetFolderId) return 'duplicate';
      if (intent === 'unbind' && !currentFolderId) return 'duplicate';
    }
    if (cleanString(req.basisBindingHash) !== cleanString(snap.bindingHash)) {
      return ctx.priorAppliedInBatch ? 'superseded-concurrent' : 'stale-basis';
    }
    if (!(await chatFolderBindingRepairChatExists(chatId))) return 'orphan-chat-binding';
    var folderToCheck = intent === 'unbind' ? previousFolderId : targetFolderId;
    if (folderToCheck && snap.tombstonedFolderSet && snap.tombstonedFolderSet[folderToCheck]) return 'tombstoned-folder-binding';
    if ((intent === 'bind' || intent === 'move') && (!snap.presentFolderSet || !snap.presentFolderSet[targetFolderId])) return 'orphan-folder-binding';
    if ((intent === 'move' || intent === 'unbind') && previousFolderId && currentFolderId !== previousFolderId) {
      return 'previous-folder-mismatch';
    }
    if (intent === 'bind' && currentFolderId && currentFolderId !== targetFolderId) return 'duplicate-binding-resolved-primary-key';
    if ((intent === 'bind' || intent === 'move') && currentFolderId === targetFolderId) return 'already-targeted';
    if (intent === 'unbind' && !currentFolderId) return 'already-unbound';
    return null;
  }
  function buildChatFolderBindingRepairReceipt(request, status, reason, extra) {
    var req = safeObject(request);
    var data = safeObject(extra);
    var now = new Date().toISOString();
    var cleanStatus = cleanString(status) || 'rejected';
    return {
      schema: CHAT_FOLDER_BINDING_RECEIPT_SCHEMA,
      version: '0.1.0-binding-repair',
      phase: 'binding-mismatch-repair-desktop-apply',
      requestId: cleanString(req.requestId || req.reviewId),
      reviewId: cleanString(req.reviewId || req.requestId),
      idempotencyKeyPresent: !!cleanString(req.idempotencyKey),
      status: cleanStatus,
      reason: cleanString(reason) || cleanStatus,
      resultingBindingHash: cleanString(data.resultingBindingHash) || cleanString(req.basisBindingHash),
      canonicalAuthority: 'desktop-sqlite',
      noDestructiveMutation: true,
      noFolderDelete: true,
      noFolderPurge: true,
      noHardDelete: true,
      noChatDelete: true,
      noBindingDeleteBeyondRequestedUnbind: true,
      noTombstoneMutation: true,
      noMirrorWrite: true,
      noTransportWrite: true,
      noWebdavWrite: true,
      mirrorReprojection: 'deferred-to-binding-live-proof',
      bindingMismatchAllowed: false,
      canonicalBindingWriteCount: Number(data.canonicalBindingWriteCount) || 0,
      canonicalWriteCount: Number(data.canonicalBindingWriteCount) || 0,
      idempotencyPersisted: data.idempotencyPersisted === true,
      dryRun: data.dryRun === true,
      appliedAt: cleanStatus === 'applied' ? now : null,
      decidedAt: now,
      productSyncReady: false,
      privacy: { redacted: true, hashOnly: true },
      requestSource: {
        surface: cleanString(req.surfaceKind) || 'chrome-extension',
        peerIdPresent: !!cleanString(req.sourcePeerId || req.deviceId),
      },
    };
  }
  async function applyChatFolderBindingRepairRequest(request, options) {
    var opts = safeObject(options);
    var ctx = safeObject(opts.ctx);
    var dryRun = opts.apply !== true;
    var gateOk = cleanString(opts.gate) === CHAT_FOLDER_BINDING_REPAIR_APPLY_GATE;
    var validation = validateChatFolderBindingRepairRequestForDesktopApply(request);
    if (!validation.ok) {
      var invalidReason = validation.blockers.indexOf('chat-folder-binding-request-redaction-violation') !== -1
        ? 'privacy-redaction-violation' : 'invalid-request-envelope';
      return buildChatFolderBindingRepairReceipt(request, 'rejected', invalidReason, { dryRun: dryRun, canonicalBindingWriteCount: 0 });
    }
    var snapshot = ctx.snapshot || await chatFolderBindingCanonicalSnapshot();
    if (!snapshot) {
      return buildChatFolderBindingRepairReceipt(request, 'rejected', 'desktop-store-unavailable', { dryRun: dryRun, canonicalBindingWriteCount: 0 });
    }
    var persisted = await bindingRepairAlreadyConsumed(request);
    var consumedBeforeApply = persisted.consumed === true;
    var effCtx = ctx;
    if (consumedBeforeApply) {
      effCtx = Object.assign({}, ctx, { appliedKeys: Object.assign({}, ctx.appliedKeys) });
      effCtx.appliedKeys[cleanString(safeObject(request).idempotencyKey)] = true;
    }
    var conflict = await classifyChatFolderBindingRepairConflict(request, snapshot, effCtx);
    var acceptedNoWrite = conflict === 'already-targeted' || conflict === 'already-unbound';
    var acceptedPrimaryKeyMove = conflict === 'duplicate-binding-resolved-primary-key';
    if (conflict && !acceptedNoWrite && !acceptedPrimaryKeyMove) {
      var conflictStatus = conflict === 'duplicate' ? 'skipped' : 'rejected';
      return buildChatFolderBindingRepairReceipt(request, conflictStatus, conflict,
        { dryRun: dryRun, canonicalBindingWriteCount: 0, resultingBindingHash: snapshot.bindingHash });
    }
    if (dryRun) {
      return buildChatFolderBindingRepairReceipt(request, 'dry-run', 'dry-run-binding-repair-plan-ready',
        { dryRun: true, canonicalBindingWriteCount: 0, resultingBindingHash: snapshot.bindingHash });
    }
    if (!gateOk) {
      return buildChatFolderBindingRepairReceipt(request, 'rejected', 'apply-gate-required',
        { dryRun: false, canonicalBindingWriteCount: 0, resultingBindingHash: snapshot.bindingHash });
    }
    var stores = H2O.Studio && H2O.Studio.store;
    var folders = stores && stores.folders;
    if (!folders) {
      return buildChatFolderBindingRepairReceipt(request, 'rejected', 'desktop-store-unavailable', { dryRun: false, canonicalBindingWriteCount: 0 });
    }
    var req = safeObject(request);
    var intent = cleanString(req.intent);
    var chatId = cleanString(req.chatId || req.conversationId);
    var targetFolderId = cleanString(req.targetFolderId || req.folderId);
    var previousFolderId = cleanString(req.previousFolderId || req.expectedCurrentFolderId || req.currentFolderId);
    var currentFolderId = cleanString(snapshot.bindingByChatId && snapshot.bindingByChatId[chatId]);
    var writeCount = 0;
    var writeOk = true;
    var writeStatus = '';
    var writeOpts = {
      reason: 'binding-mismatch-repair-desktop-apply',
      assignedAt: Date.now(),
      expectedCurrentFolderId: previousFolderId || currentFolderId,
      skipBindingTombstone: true,
      suppressBindingSubscribers: false,
      // F15-settled routing: the normal binding repair write MUST update the F15-settled source-of-truth so a
      // later settlement/materialization/reconcile does NOT revert it. Force the F15-settled delegation and do
      // NOT allow the bare/legacy F7 fallback (no allowF7Fallback): if F15 delegation is unavailable/fails, the
      // write returns falsy and the handler safe-fails (rejected, zero ledger consume). Replaces the prior
      // bare-path write opts (explicitF7Fallback was a no-op key; the bare moveCanonicalChatFolderBinding path
      // is no longer the repair route).
      useF15FolderBindingDelegation: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
    };
    if (acceptedNoWrite) {
      writeStatus = conflict;
    } else if (intent === 'unbind') {
      if (typeof folders.unbindChat !== 'function') return buildChatFolderBindingRepairReceipt(request, 'rejected', 'canonical-binding-unbind-unavailable', { dryRun: false, canonicalBindingWriteCount: 0, resultingBindingHash: snapshot.bindingHash });
      writeOk = await folders.unbindChat(previousFolderId || currentFolderId, chatId, writeOpts);
      writeCount = writeOk ? 1 : 0;
      writeStatus = writeOk ? 'unbound' : 'canonical-binding-unbind-failed';
    } else if (intent === 'bind' || intent === 'move' || acceptedPrimaryKeyMove) {
      // F15-settled repair write for BOTH bind and move (rebind): bindChat with useF15FolderBindingDelegation
      // decomposes a rebind (unbind-old + bind-new) through the F15 settlement pipeline, updating the settled
      // source-of-truth. The bare moveCanonicalChatFolderBinding path is deliberately NOT used for the normal
      // repair write (that bare write did not settle and was reverted by later settlement/reconcile).
      if (typeof folders.bindChat !== 'function') return buildChatFolderBindingRepairReceipt(request, 'rejected', 'canonical-binding-bind-unavailable', { dryRun: false, canonicalBindingWriteCount: 0, resultingBindingHash: snapshot.bindingHash });
      writeOk = await folders.bindChat(targetFolderId, chatId, writeOpts);
      writeCount = writeOk ? 1 : 0;
      writeStatus = writeOk ? ((intent === 'move' || acceptedPrimaryKeyMove) ? 'moved' : 'bound') : 'canonical-binding-bind-failed';
    } else {
      writeOk = false;
      writeStatus = 'forbidden-intent';
    }
    if (!writeOk) {
      return buildChatFolderBindingRepairReceipt(request, 'rejected', writeStatus,
        { dryRun: false, canonicalBindingWriteCount: 0, resultingBindingHash: snapshot.bindingHash });
    }
    var after = await chatFolderBindingCanonicalSnapshot();
    var afterHash = after ? after.bindingHash : '';
    if (afterHash !== cleanString(req.requestedBindingHash) && !acceptedNoWrite) {
      return buildChatFolderBindingRepairReceipt(request, 'rejected', 'post-apply-binding-hash-mismatch',
        { dryRun: false, canonicalBindingWriteCount: writeCount, resultingBindingHash: afterHash || snapshot.bindingHash });
    }
    // DURABLE PERSISTENCE GATE (detection + safe-fail hardening; NOT the final Rust/competing-writer fix).
    // Runs AFTER the same-session post-apply-binding-hash-mismatch gate (which is preserved above) and BEFORE
    // any ledger consume / applied / idempotencyPersisted. A real canonical binding write must be durably
    // confirmed: a JS-reachable persistence fence + a FRESH canonical re-read whose hash equals
    // requestedBindingHash. If durability is false, unverifiable, missing, or does not match, return
    // rejected:persistence-verification-failure and consume NOTHING. Never treat uncertainty as success.
    if (!acceptedNoWrite) {
      var durableConfirmation = (folders && typeof folders.confirmCanonicalChatFolderBindingDurable === 'function')
        ? await folders.confirmCanonicalChatFolderBindingDurable({
          hashRows: chatFolderBindingHashFromRows,
          requestedBindingHash: cleanString(req.requestedBindingHash),
        })
        : { durable: false, unverifiable: true, matchesRequested: false, canonicalBindingHash: '', reason: 'durable-confirmation-helper-unavailable' };
      var durableOk = !!(durableConfirmation && durableConfirmation.durable === true &&
        durableConfirmation.unverifiable !== true && durableConfirmation.matchesRequested === true);
      if (!durableOk) {
        return buildChatFolderBindingRepairReceipt(request, 'rejected', 'persistence-verification-failure',
          { dryRun: false, canonicalBindingWriteCount: 0,
            resultingBindingHash: cleanString(durableConfirmation && durableConfirmation.canonicalBindingHash) || afterHash || snapshot.bindingHash,
            idempotencyPersisted: false });
      }
    }
    var recorded = acceptedNoWrite ? { ok: false } : (consumedBeforeApply
      ? { ok: true, reason: 'already-consumed-before-recovery' }
      : await bindingRepairRecordConsumed(request));
    var status = acceptedNoWrite ? 'skipped' : 'applied';
    var reason = acceptedNoWrite ? conflict : (acceptedPrimaryKeyMove ? 'duplicate-binding-resolved-primary-key' : 'binding-repair-applied');
    return buildChatFolderBindingRepairReceipt(request, status, reason,
      { dryRun: false, canonicalBindingWriteCount: acceptedNoWrite ? 0 : writeCount,
        resultingBindingHash: afterHash || snapshot.bindingHash, idempotencyPersisted: recorded.ok });
  }
  /* ===================== end binding repair Desktop handler ===================== */

  /* ===================== F32 (folder-sync S2): sortOrder reorder Desktop handler =====================
   * Scope: canonical Desktop SQLite sort_order apply ONLY. Dry-run by default; gated apply. Basis-gated,
   * idempotent (applies the FULL requested order; atomic-on-retry). Emits a receipt via
   * FOLDER_SORTORDER_REORDER_RECEIPT_SCHEMA. Writes ONLY sort_order via store.folders.patch (which routes
   * through recordWrite). NO folder_bindings, NO folder-row deletion, NO tombstone mutation, NO chat
   * mutation, NO folder delete/purge, NO F11 allowed-set change. Mirror re-projection is DEFERRED to a
   * separate S2b slice (the F11 render-only rebuild strips sortOrder, and no standalone sortOrder-
   * preserving projection is safely reusable here). Not auto-wired into any import loop; invoked
   * explicitly. Clones the metadata-mutation Desktop-apply idiom. */
  var FOLDER_SORTORDER_REORDER_APPLY_GATE = 'folder-sync-f32-sortorder-apply';
  var FOLDER_SORTORDER_REORDER_INTENT = 'folder-sortorder-reorder-request';
  var FOLDER_SORTORDER_REORDER_FORBIDDEN_KEYS = ['name', 'title', 'content'];

  function f32Arr(v) { return Array.isArray(v) ? v : []; }
  function f32StableHash(text) {
    var h = 0x811c9dc5; var s = String(text);
    for (var i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  function folderSortorderOrderingHash(orderedIds) {
    var ids = f32Arr(orderedIds).map(function (x) { return cleanString(x); }).filter(Boolean);
    return 'oh:' + f32StableHash(ids.join('>'));
  }

  /* F32b: persistent replay/idempotency via the EXISTING consumed-operation ledger
   * (H2O.Desktop.Sync.listConsumedOperations / recordConsumedOperation). Hash-only: the
   * idempotencyKey is SHA-256'd into the ledger dedupeKey + eventDigest; no raw ids are stored.
   * Degrades gracefully to caller-context-only when the ledger is absent. No new ledger substrate. */
  var FOLDER_SORTORDER_REORDER_OPERATION_KIND = 'folder-sortorder-reorder';
  function f32ConsumedLedger() {
    var d = H2O && H2O.Desktop && H2O.Desktop.Sync;
    if (d && typeof d.listConsumedOperations === 'function' &&
        typeof d.recordConsumedOperation === 'function') return d;
    return null;
  }
  async function f32ReorderDedupeKey(request) {
    var req = safeObject(request);
    try { return await sha256Hex(FOLDER_SORTORDER_REORDER_OPERATION_KIND + '|dedupe|' + cleanString(req.idempotencyKey)); }
    catch (e) { return ''; }
  }
  async function f32ReorderEventDigest(request) {
    var req = safeObject(request);
    try {
      return await sha256Hex(FOLDER_SORTORDER_REORDER_OPERATION_KIND + '|digest|' + cleanString(req.schema) + '|' +
        cleanString(req.idempotencyKey) + '|' + cleanString(req.basisOrderingHash) + '|' + cleanString(req.requestedOrderingHash));
    } catch (e) { return ''; }
  }
  async function f32ReorderAlreadyConsumed(request) {
    var ledger = f32ConsumedLedger();
    if (!ledger) return { available: false, consumed: false, dedupeKey: '' };
    var dedupeKey = await f32ReorderDedupeKey(request);
    if (!dedupeKey) return { available: false, consumed: false, dedupeKey: '' };
    var listed = null;
    try { listed = await ledger.listConsumedOperations(); }
    catch (e) { return { available: false, consumed: false, dedupeKey: dedupeKey }; }
    var rows = listed && Array.isArray(listed.rows) ? listed.rows : [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      if (cleanString(row.operationKind) === FOLDER_SORTORDER_REORDER_OPERATION_KIND &&
          cleanString(row.dedupeKey).toLowerCase() === dedupeKey.toLowerCase()) {
        return { available: true, consumed: true, dedupeKey: dedupeKey };
      }
    }
    return { available: true, consumed: false, dedupeKey: dedupeKey };
  }
  async function f32RecordReorderConsumed(request) {
    var ledger = f32ConsumedLedger();
    if (!ledger) return { ok: false, reason: 'ledger-unavailable' };
    var dedupeKey = await f32ReorderDedupeKey(request);
    var eventDigest = await f32ReorderEventDigest(request);
    if (!dedupeKey || !eventDigest) return { ok: false, reason: 'digest-unavailable' };
    var res = null;
    try {
      res = await ledger.recordConsumedOperation({
        eventDigest: eventDigest,
        dedupeKey: dedupeKey,
        envelopeKind: 'applyEvent',
        operationKind: FOLDER_SORTORDER_REORDER_OPERATION_KIND,
        consumedStatus: 'consumed',
        reason: 'folder-sortorder-reorder-applied',
      });
    } catch (e) { return { ok: false, reason: 'record-threw' }; }
    return { ok: !!(res && res.ok), reason: (res && res.ok) ? 'recorded'
      : (res && Array.isArray(res.blockers) && res.blockers.length ? res.blockers.join(',') : 'record-failed') };
  }
  function f32HasForbiddenKeys(obj) {
    if (!obj || typeof obj !== 'object') return false;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      if (FOLDER_SORTORDER_REORDER_FORBIDDEN_KEYS.indexOf(k) !== -1) return true;
      var v = obj[k];
      if (v && typeof v === 'object' && f32HasForbiddenKeys(v)) return true;
    }
    return false;
  }
  function f32PayloadIds(request) {
    return f32Arr(request && request.orderPayload)
      .map(function (e) { return cleanString(e && e.folderId); }).filter(Boolean);
  }

  function validateFolderSortorderReorderRequestForDesktopApply(request) {
    var blockers = [];
    var req = safeObject(request);
    if (cleanString(req.schema) !== FOLDER_SORTORDER_REORDER_REQUEST_SCHEMA) blockers.push('folder-sortorder-reorder-request-schema-invalid');
    if (cleanString(req.intent) !== FOLDER_SORTORDER_REORDER_INTENT) blockers.push('folder-sortorder-reorder-request-intent-invalid');
    if (!cleanString(req.requestId || req.reviewId)) blockers.push('folder-sortorder-reorder-request-id-required');
    if (!cleanString(req.sourcePeerId) && !cleanString(req.deviceId)) blockers.push('folder-sortorder-reorder-request-peer-id-required');
    if (['chrome-extension', 'native-extension', 'mobile'].indexOf(cleanString(req.surfaceKind)) === -1) blockers.push('folder-sortorder-reorder-request-surface-kind-invalid');
    if (!Array.isArray(req.orderPayload) || !req.orderPayload.length) blockers.push('folder-sortorder-reorder-request-order-payload-invalid');
    if (!cleanString(req.basisOrderingHash)) blockers.push('folder-sortorder-reorder-request-basis-hash-required');
    if (!cleanString(req.requestedOrderingHash)) blockers.push('folder-sortorder-reorder-request-requested-hash-required');
    if (!cleanString(req.createdAt)) blockers.push('folder-sortorder-reorder-request-created-at-required');
    if (!cleanString(req.idempotencyKey)) blockers.push('folder-sortorder-reorder-request-idempotency-key-required');
    if (req.desktopApplyRequired !== true || req.noLocalApply !== true) blockers.push('folder-sortorder-reorder-request-apply-flags-invalid');
    if (req.noChromeCanonicalMutation !== true) blockers.push('folder-sortorder-reorder-request-mutation-flags-invalid');
    if (req.noHardDelete !== true || req.noPurge !== true || req.noChatDelete !== true ||
        req.noFolderDelete !== true || req.noBindingMutation !== true || req.noTombstoneMutation !== true) {
      blockers.push('folder-sortorder-reorder-request-safety-flags-invalid');
    }
    var privacy = safeObject(req.privacy);
    if (privacy.rawFolderNames !== false || privacy.rawChatTitles !== false || privacy.rawChatContent !== false) {
      blockers.push('folder-sortorder-reorder-request-privacy-flags-invalid');
    }
    if (f32HasForbiddenKeys(req)) blockers.push('folder-sortorder-reorder-request-redaction-violation');
    return { ok: blockers.length === 0, blockers: blockers };
  }

  async function folderSortorderCanonicalSnapshot() {
    var stores = H2O.Studio && H2O.Studio.store;
    var folders = stores && stores.folders;
    if (!folders || typeof folders.getAll !== 'function') return null;
    var visible = f32Arr(await folders.getAll());
    var tomb = [];
    if (typeof folders.listRecentlyDeletedFolders === 'function') {
      try { tomb = f32Arr(await folders.listRecentlyDeletedFolders({ limit: 1000 })); } catch (e) { tomb = []; }
    }
    var idOf = function (row) { return cleanString(row && (row.id || row.folderId)); };
    var visibleIds = visible.map(idOf).filter(Boolean);
    var tombIds = tomb.map(idOf).filter(Boolean);
    var presentSet = Object.create(null); var sortOrderById = Object.create(null);
    visible.forEach(function (row) { var id = idOf(row); if (id) { presentSet[id] = true; sortOrderById[id] = Number(row && row.sortOrder) || 0; } });
    var tombSet = Object.create(null); tombIds.forEach(function (id) { tombSet[id] = true; });
    var knownSet = Object.create(null); visibleIds.concat(tombIds).forEach(function (id) { knownSet[id] = true; });
    return {
      visibleOrderIds: visibleIds, presentSet: presentSet, tombSet: tombSet, knownSet: knownSet,
      visibleSet: presentSet, sortOrderById: sortOrderById,
    };
  }

  function f32CurrentPayloadOrder(payloadIds, snapshot) {
    var snap = safeObject(snapshot);
    var s = snap.sortOrderById || Object.create(null);
    var visibleIndexById = Object.create(null);
    f32Arr(snap.visibleOrderIds).forEach(function (id, index) {
      var cleanId = cleanString(id);
      if (cleanId && typeof visibleIndexById[cleanId] === 'undefined') visibleIndexById[cleanId] = index;
    });
    return payloadIds.slice().sort(function (a, b) {
      var aid = cleanString(a); var bid = cleanString(b);
      var av = Number(s[aid]); var bv = Number(s[bid]);
      av = isFinite(av) ? av : 0; bv = isFinite(bv) ? bv : 0;
      if (av !== bv) return av - bv;
      var ai = typeof visibleIndexById[aid] === 'number' ? visibleIndexById[aid] : Number.MAX_SAFE_INTEGER;
      var bi = typeof visibleIndexById[bid] === 'number' ? visibleIndexById[bid] : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return aid < bid ? -1 : (aid > bid ? 1 : 0);
    });
  }

  /* Conflict precedence (existence-first, so real folder problems surface before basis):
   * duplicate -> unknown-folder -> tombstoned-folder -> missing-folder -> folder-not-in-catalog ->
   * basis (stale-basis / superseded-concurrent) -> null (accepted). */
  function classifyFolderSortorderReorderConflict(request, snapshot, ctx) {
    ctx = safeObject(ctx);
    var appliedKeys = safeObject(ctx.appliedKeys);
    if (appliedKeys[cleanString(request && request.idempotencyKey)]) return 'duplicate';
    var ids = f32PayloadIds(request);
    for (var i = 0; i < ids.length; i += 1) {
      var id = ids[i];
      if (!snapshot.knownSet[id]) return 'unknown-folder';
      if (snapshot.tombSet[id]) return 'tombstoned-folder';
      if (!snapshot.presentSet[id]) return 'missing-folder';
      if (!snapshot.visibleSet[id]) return 'folder-not-in-catalog';
    }
    var currentHash = folderSortorderOrderingHash(f32CurrentPayloadOrder(ids, snapshot));
    if (cleanString(request && request.basisOrderingHash) !== currentHash) {
      return ctx.priorAppliedInBatch ? 'superseded-concurrent' : 'stale-basis';
    }
    return null;
  }

  function buildFolderSortorderReorderReceipt(request, status, reason, extra) {
    var req = safeObject(request); var data = safeObject(extra); var now = new Date().toISOString();
    var cleanStatus = cleanString(status) || 'rejected';
    return {
      schema: FOLDER_SORTORDER_REORDER_RECEIPT_SCHEMA,
      version: '0.1.0-f32', phase: 'f32-sortorder-desktop-apply',
      requestId: cleanString(req.requestId || req.reviewId),
      reviewId: cleanString(req.reviewId || req.requestId),
      idempotencyKey: cleanString(req.idempotencyKey),
      status: cleanStatus,
      reason: cleanString(reason) || cleanStatus,
      resultingOrderingHash: cleanString(data.resultingOrderingHash) || cleanString(req.basisOrderingHash),
      canonicalAuthority: 'desktop-sqlite',
      noDestructiveMutation: true, noFolderDelete: true, noFolderPurge: true,
      noChatDelete: true, noBindingMutation: true, noTombstoneMutation: true,
      mirrorReprojection: 'deferred-to-s2b',
      canonicalWriteCount: Number(data.canonicalWriteCount) || 0,
      idempotencyPersisted: data.idempotencyPersisted === true,
      dryRun: data.dryRun === true,
      appliedAt: cleanStatus === 'applied' ? now : null,
      decidedAt: now,
      privacy: { redacted: true, hashOnly: true },
      requestSource: {
        surface: cleanString(req.surfaceKind) || 'chrome-extension',
        peerId: cleanString(req.sourcePeerId || req.deviceId),
      },
    };
  }

  async function applyFolderSortorderReorderRequest(request, options) {
    var opts = safeObject(options); var ctx = safeObject(opts.ctx);
    var dryRun = opts.apply !== true;
    var gateOk = cleanString(opts.gate) === FOLDER_SORTORDER_REORDER_APPLY_GATE;

    var validation = validateFolderSortorderReorderRequestForDesktopApply(request);
    if (!validation.ok) {
      var reason = validation.blockers.indexOf('folder-sortorder-reorder-request-redaction-violation') !== -1
        ? 'redaction-violation' : 'invalid-request-envelope';
      return buildFolderSortorderReorderReceipt(request, 'rejected', reason, { dryRun: dryRun, canonicalWriteCount: 0 });
    }
    var snapshot = ctx.snapshot || await folderSortorderCanonicalSnapshot();
    if (!snapshot) {
      return buildFolderSortorderReorderReceipt(request, 'rejected', 'desktop-store-unavailable', { dryRun: dryRun, canonicalWriteCount: 0 });
    }
    // F32b: persistent replay guard — a previously consumed idempotencyKey classifies as duplicate
    // (skipped, zero-write) even across a separate call, sourced from the consumed-operation ledger.
    var persisted = await f32ReorderAlreadyConsumed(request);
    var effCtx = ctx;
    if (persisted.consumed) {
      effCtx = Object.assign({}, ctx, { appliedKeys: Object.assign({}, ctx.appliedKeys) });
      effCtx.appliedKeys[cleanString(safeObject(request).idempotencyKey)] = true;
    }
    var conflict = classifyFolderSortorderReorderConflict(request, snapshot, effCtx);
    if (conflict) {
      var conflictStatus = conflict === 'duplicate' ? 'skipped' : 'rejected';
      return buildFolderSortorderReorderReceipt(request, conflictStatus, conflict,
        { dryRun: dryRun, canonicalWriteCount: 0, resultingOrderingHash: request.basisOrderingHash });
    }
    // accepted. DRY-RUN by default: plan only, ZERO writes.
    if (dryRun) {
      return buildFolderSortorderReorderReceipt(request, 'dry-run', 'dry-run-sortorder-reorder-plan-ready',
        { dryRun: true, canonicalWriteCount: 0, resultingOrderingHash: request.basisOrderingHash });
    }
    // GATED apply only.
    if (!gateOk) {
      return buildFolderSortorderReorderReceipt(request, 'rejected', 'apply-gate-required',
        { dryRun: false, canonicalWriteCount: 0, resultingOrderingHash: request.basisOrderingHash });
    }
    var stores = H2O.Studio && H2O.Studio.store; var folders = stores && stores.folders;
    if (!folders || typeof folders.patch !== 'function') {
      return buildFolderSortorderReorderReceipt(request, 'rejected', 'desktop-store-unavailable', { dryRun: false, canonicalWriteCount: 0 });
    }
    // Apply the FULL requested order to canonical sort_order (idempotent; atomic-on-retry). Writes ONLY
    // sort_order via store.folders.patch (-> UPDATE folders SET sort_order; recordWrite). No other writes.
    var order = f32PayloadIds(request); var writeCount = 0;
    for (var i = 0; i < order.length; i += 1) {
      await folders.patch(order[i], { sortOrder: i });
      writeCount += 1;
    }
    // Verify: recompute canonical ordering hash over the payload; emit applied only if it matches requested.
    var after = await folderSortorderCanonicalSnapshot();
    var afterHash = after ? folderSortorderOrderingHash(f32CurrentPayloadOrder(order, after)) : '';
    if (afterHash === cleanString(request.requestedOrderingHash)) {
      // F32b: record the consumed operation so a later separate call is a persistent no-op.
      var recorded = await f32RecordReorderConsumed(request);
      var appliedReceipt = buildFolderSortorderReorderReceipt(request, 'applied', 'sortorder-reorder-applied',
        { dryRun: false, canonicalWriteCount: writeCount, resultingOrderingHash: afterHash,
          idempotencyPersisted: recorded.ok });
      // S2b: sortOrder-preserving render-mirror re-projection. Runs ONLY here — strictly AFTER validation,
      // the canonical sort_order write, AND post-apply ordering-hash verification. It never leads canonical
      // (reads canonical via the store, writes ONLY the render mirror), is idempotent + bounded, and does
      // NOT reuse the F11 rebuild helper (which strips sortOrder). The projection function lives OUTSIDE this
      // handler region; the marker below is overridden only on this successful applied path.
      var s2bMirror = await s2bProjectSortOrderPreservingRenderMirror();
      appliedReceipt.mirrorReprojection = 'applied-sortorder-preserving-s2b';
      appliedReceipt.mirrorReprojectionResult = (s2bMirror && s2bMirror.status) ? s2bMirror.status : 'unknown';
      return appliedReceipt;
    }
    return buildFolderSortorderReorderReceipt(request, 'rejected', 'post-apply-ordering-hash-mismatch',
      { dryRun: false, canonicalWriteCount: writeCount, resultingOrderingHash: afterHash });
  }
  /* ===================== end F32 S2 sortOrder reorder handler ===================== */

  /* ===================== S2b: sortOrder-preserving render-mirror re-projection =====================
   * A NEW, focused projection (deliberately NOT the F11 render-mirror rebuild helper, which STRIPS
   * sortOrder). It is invoked ONLY by the F32 applied path, strictly after the canonical sort_order write +
   * post-apply hash verification. It reads canonical order from the store and writes ONLY the render mirror
   * (FOLDER_STATE_DATA_KEY) via writeKv, preserving each folder's sortOrder/sort_order and reordering the
   * mirror folders array to match canonical order. It never leads canonical, is idempotent (no write when the
   * mirror already preserves the canonical order) and bounded (a single mirror write; no new rows, no binding/
   * items/tombstone/chat/delete mutation, no transport/WebDAV/CAS, no productSyncReady flip). If the mirror is
   * absent it is a safe no-op (S2b preserves order on an existing render mirror; it does not materialize one). */
  var S2B_RENDER_MIRROR_STATE_KEY = 'h2o:prm:cgx:fldrs:state:data:v1';
  function s2bFolderIdOf(row) { return cleanString(row && (row.id || row.folderId)); }
  async function s2bCanonicalOrderForMirror() {
    var stores = H2O.Studio && H2O.Studio.store;
    var folders = stores && stores.folders;
    if (!folders || typeof folders.getAll !== 'function') return null;
    var rows = f32Arr(await folders.getAll());
    var sortOrderById = Object.create(null);
    var orderIndexById = Object.create(null);
    var ordered = rows.slice().sort(function (a, b) {
      return (Number(a && a.sortOrder) || 0) - (Number(b && b.sortOrder) || 0);
    });
    ordered.forEach(function (row, index) {
      var id = s2bFolderIdOf(row);
      if (!id) return;
      sortOrderById[id] = Number(row && row.sortOrder) || 0;
      if (typeof orderIndexById[id] === 'undefined') orderIndexById[id] = index;
    });
    return { sortOrderById: sortOrderById, orderIndexById: orderIndexById };
  }
  async function s2bProjectSortOrderPreservingRenderMirror() {
    var result = {
      schema: 'h2o.studio.folder-sortorder-mirror-reprojection.s2b.v1',
      ok: false, status: '', wrote: false, reusedF11RebuildHelper: false,
      sortOrderPreserving: true, mirrorNeverLeadsCanonical: true, renderMirrorOnly: true,
      projectedFolderCount: 0, reorderedMirror: false, canonicalNotInMirrorCount: 0,
      noBindingMutation: true, noTombstoneMutation: true, noFolderDelete: true, noChatDelete: true,
      noItemsMutation: true, noTransportWrite: true, noWebdavWrite: true, noChatSavingCas: true,
      productSyncReady: false,
    };
    try {
      var canon = await s2bCanonicalOrderForMirror();
      if (!canon) { result.ok = true; result.status = 'store-unavailable'; return result; }
      var raw = await readKv(S2B_RENDER_MIRROR_STATE_KEY);
      var current = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
      var mirrorFolders = current && Array.isArray(current.folders) ? current.folders.slice() : null;
      if (!mirrorFolders || !mirrorFolders.length) { result.ok = true; result.status = 'no-op-mirror-absent'; return result; }
      var changed = false;
      var nextFolders = mirrorFolders.map(function (row) {
        var id = s2bFolderIdOf(row);
        if (id && Object.prototype.hasOwnProperty.call(canon.sortOrderById, id)) {
          var so = canon.sortOrderById[id];
          if (Number(row.sortOrder) !== so || Number(row.sort_order) !== so) {
            changed = true; result.projectedFolderCount += 1;
            return Object.assign({}, row, { sortOrder: so, sort_order: so }); // PRESERVE (opposite of F11 strip)
          }
        } else if (id) {
          result.canonicalNotInMirrorCount += 0; // rows not in canonical are left untouched (bounded)
        }
        return row;
      });
      var big = Number.MAX_SAFE_INTEGER;
      var sortedFolders = nextFolders.slice().sort(function (a, b) {
        var ai = canon.orderIndexById[s2bFolderIdOf(a)]; var bi = canon.orderIndexById[s2bFolderIdOf(b)];
        ai = typeof ai === 'number' ? ai : big; bi = typeof bi === 'number' ? bi : big;
        return ai - bi;
      });
      for (var i = 0; i < sortedFolders.length; i += 1) {
        if (s2bFolderIdOf(sortedFolders[i]) !== s2bFolderIdOf(nextFolders[i])) { changed = true; result.reorderedMirror = true; break; }
      }
      if (!changed) { result.ok = true; result.status = 'no-op-mirror-already-preserves-sortorder'; return result; }
      var nextState = Object.assign({}, current, {
        folders: sortedFolders,
        updatedAt: new Date().toISOString(),
        s2bLastSortOrderPreservingProjection: {
          schema: result.schema, at: new Date().toISOString(),
          projectedFolderCount: result.projectedFolderCount, reorderedMirror: result.reorderedMirror,
          renderMirrorOnly: true, sortOrderPreserving: true, mirrorNeverLeadsCanonical: true,
          noBindingMutation: true, noTombstoneMutation: true, productSyncReady: false,
        },
      });
      await writeKv(S2B_RENDER_MIRROR_STATE_KEY, nextState);
      result.ok = true; result.wrote = true; result.status = 'projected';
      return result;
    } catch (e) {
      result.ok = false; result.status = 'mirror-unavailable'; result.error = e && e.message ? e.message : String(e);
      return result;
    }
  }
  /* ===================== end S2b sortOrder-preserving render-mirror re-projection ===================== */

  H2O.Studio.sync = Object.assign({}, existingSync, desktopSyncApi, {
    folder: folderApi,
    bindingRepair: {
      applyGate: CHAT_FOLDER_BINDING_REPAIR_APPLY_GATE,
      validate: validateChatFolderBindingRepairRequestForDesktopApply,
      classify: classifyChatFolderBindingRepairConflict,
      bindingHash: chatFolderBindingHashFromRows,
      buildReceipt: buildChatFolderBindingRepairReceipt,
      snapshot: chatFolderBindingCanonicalSnapshot,
      apply: applyChatFolderBindingRepairRequest,
    },
    sortOrderReorder: {
      applyGate: FOLDER_SORTORDER_REORDER_APPLY_GATE,
      validate: validateFolderSortorderReorderRequestForDesktopApply,
      classify: classifyFolderSortorderReorderConflict,
      orderingHash: folderSortorderOrderingHash,
      buildReceipt: buildFolderSortorderReorderReceipt,
      snapshot: folderSortorderCanonicalSnapshot,
      apply: applyFolderSortorderReorderRequest,
    },
  });

  /* Boot-time auto-start: if persisted/effective config has mode ∈
   * {notify, auto} AND folderPath set, kick the watcher after the
   * platform/stores have a chance to initialize. */
  global.setTimeout(function () {
    getConfig().then(function (cfg) {
      watcherState.folderPath = cfg.folderPath || '';
      watcherState.mode = cfg.mode || 'off';
      if (cfg.autoImportMigration) {
        var persisted = Object.assign({}, cfg, {
          updatedAt: new Date().toISOString(),
        });
        delete persisted.autoImportMigration;
        writeKv(CONFIG_KEY, persisted).catch(function (e) { pushWatcherErr('boot.config-migration', e); });
      }
      if ((cfg.mode === 'notify' || cfg.mode === 'auto') && cfg.folderPath) {
        startWatcher();
      }
    }).catch(function (e) { pushWatcherErr('boot', e); });
  }, 0);
})(typeof window !== 'undefined' ? window : globalThis);
