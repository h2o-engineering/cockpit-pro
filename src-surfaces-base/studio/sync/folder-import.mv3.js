/* H2O Studio Sync - Chrome sync-folder import connector (R2B)
 *
 * MV3/Chrome Studio-only manual import bridge for ~/H2O Studio Sync/latest.json.
 * The user chooses a sync folder once through the File System Access API; this
 * module stores that directory handle in IndexedDB and exposes a manual
 * syncNow() that reads latest.json and calls the existing full-bundle import
 * flow in merge mode.
 *
 * R2C adds opt-in auto-sync triggers while Studio is open/visible. This is
 * still not a background daemon: no interval polling, no folder writes.
 *
 * Safety invariants:
 *   - no Desktop/Tauri behavior
 *   - no background polling or interval auto-import
 *   - syncNow() defaults to Desktop -> Chrome import from latest.json
 *   - direction-specific Chrome -> Desktop export delegates to autoImport
 *     and writes only chrome-latest.json
 *   - no import format or archive schema changes
 */
(function (global) {
  'use strict';

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* swallow */ }
    return false;
  }
  if (detectTauri()) return;

  function detectChromeExtension() {
    try {
      return !!(global.chrome && global.chrome.runtime && global.chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }
  if (!detectChromeExtension()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};

  var PHASE = 'R2C';
  var MODE = 'manual-sync-folder-import';
  var FULL_BUNDLE_SCHEMA = 'h2o.studio.fullBundle.v2';
  var PROPAGATION_SCHEMA = 'h2o.studio.sync.chrome-desktop-propagation.v1';
  var F19_DESKTOP_CHROME_VERSION = '0.1.0-f19.2.c';
  var FOLDER_SYNC_HEALTH_SCHEMA = 'h2o.studio.sync.folder-health.v1';
  var FOLDER_SYNC_HEALTH_VERSION = '0.1.0-phase3-health';
  var FOLDER_DELETE_RECEIPT_SCHEMA = 'h2o.studio.folder-delete-receipt.v1';
  var FOLDER_RESTORE_RECEIPT_SCHEMA = 'h2o.studio.folder-restore-receipt.v1';
  var CHAT_FOLDER_BINDING_RECEIPT_SCHEMA = 'h2o.studio.chat-folder-binding-receipt.v1';
  var DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA = 'h2o.studio.chat-folder-bindings.desktop-canonical.v1';
  var DESKTOP_CANONICAL_LIBRARY_METADATA_SCHEMA = 'h2o.studio.library-metadata.desktop-canonical.v1';
  var LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA = 'h2o.studio.library-metadata-mutation-request.v1';
  var LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_KEY = 'h2o:studio:library-metadata-mutation-requests:pending-export:v1';
  var LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA = 'h2o.studio.library-metadata-mutation-request.pending-export-mirror.v1';
  var LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA = 'h2o.studio.library-metadata-mutation-receipt.v1';
  var LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_KEY = 'h2o:studio:library-metadata-mutation-receipts:chrome-imported:v1';
  var LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_MIRROR_SCHEMA = 'h2o.studio.library-metadata-mutation-receipt.chrome-imported-mirror.v1';
  var HEALTH_SCHEDULER_EXPECTATION_WINDOW_MS = 2 * 60 * 1000;
  var LATEST_FILE = 'latest.json';
  var CHROME_LATEST_FILE = 'chrome-latest.json';
  var FOLDER_STATE_KEY_LOCAL = 'h2o:prm:cgx:fldrs:state:data:v1';
  var MSG_ARCHIVE = 'h2o-ext-archive:v1';
  var IDB_NAME = 'h2o.studio.sync.folder.mv3';
  var IDB_STORE = 'handles';
  var IDB_KEY = 'sync-folder';
  var STATE_KEY = 'h2o:sync:folder-import:state:v1';
  var AUTO_SYNC_MIN_INTERVAL_MS = 30000;
  var AUTO_SYNC_DELAY_MS = 1000;
  var AUTO_SYNC_BOOT_DELAY_MS = 1500;
  var DESKTOP_LATEST_POLL_INTERVAL_MS = 5000;
  var CHROME_EXPORT_DEBOUNCE_MS = 2000;
  var CHROME_TARGETED_REFRESH_RETRY_MS = 250;
  var MAX_ERRORS = 20;
  var DESKTOP_CHROME_SUPPORTED_FIELDS = [
    'saved-chat-records',
    'linked-chat-records',
    'folder-metadata',
    'category-metadata',
    'chat-category-bindings',
    'desktop-canonical-library-metadata'
  ];
  var DESKTOP_CHROME_DEFERRED_CODES = {
    labels: 'library-propagation-labels-deferred',
    tags: 'library-propagation-tags-deferred',
    projects: 'library-propagation-projects-deferred',
    folderBindings: 'library-propagation-chat-folder-bindings-deferred',
    tombstones: 'library-propagation-tombstones-deferred',
    applyEvents: 'library-propagation-apply-events-deferred',
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
  var CHROME_EXPORT_IN_FLIGHT_STALE_MS = 60000;

  var state = {
    installedAt: Date.now(),
    loaded: false,
    loadPromise: null,
    handle: null,
    folderName: '',
    connectedAt: '',
    permission: 'unknown',
    lastFileName: '',
    lastFileLastModified: 0,
    lastFileSize: 0,
    lastAppliedExportId: '',
    lastAppliedExportedAt: '',
    lastAppliedAt: '',
    lastChecksum: '',
    lastSummarySignature: '',
    lastSyncStatus: '',
    lastSyncError: '',
    lastSyncResult: null,
    syncInFlight: false,
    autoSyncEnabled: true,
    autoSyncEventsBound: false,
    autoSyncTimer: null,
    desktopLatestPollTimer: null,
    desktopLatestPollRunning: false,
    desktopLatestPollSignature: '',
    lastDesktopLatestPollAt: '',
    lastDesktopLatestPollStatus: '',
    lastDesktopLatestPollError: '',
    lastDesktopLatestPollDetectedAt: '',
    lastDesktopLatestPollFileLastModified: 0,
    lastDesktopLatestPollFileSize: 0,
    autoSyncScheduledAt: 0,
    autoSyncScheduledReason: '',
    autoSyncRunning: false,
    lastAutoSyncAttemptAt: 0,
    lastAutoSyncAt: '',
    lastAutoSyncReason: '',
    lastAutoSyncStatus: '',
    lastAutoSyncError: '',
    chromeExportTimer: null,
    chromeExportPending: false,
    chromeExportInFlight: false,
    chromeExportInFlightStartedAt: 0,
    chromeExportInFlightReason: '',
    chromeExportInFlightOwner: '',
    chromeExportLastStaleLockClearedAt: '',
    chromeExportLastStaleLockClearedReason: '',
    chromeExportScheduledAt: 0,
    chromeExportScheduledReason: '',
    lastChromeExportAttemptAt: 0,
    lastChromeExportAt: '',
    lastChromeExportReason: '',
    lastChromeExportStatus: '',
    lastChromeExportError: '',
    lastChromeExportFile: '',
    lastChromeExportBytes: 0,
    lastChromeExportPermission: 'unknown',
    lastChromeExportBlockers: [],
    lastTransportConflictStatus: '',
    lastTransportConflictReason: '',
    lastTransportConflictDecision: '',
    lastTransportConflictSummary: null,
    lastDesktopToChromeExportWrittenAt: '',
    lastDesktopToChromeImportStartedAt: '',
    lastDesktopToChromeImportAppliedAt: '',
    lastDesktopToChromeRenderRefreshedAt: '',
    lastDesktopToChromeTotalPropagationMs: 0,
    lastDesktopToChromeRefreshMode: '',
    lastDesktopToChromeChangedFolderCount: 0,
    lastDesktopToChromeChangedFields: [],
    lastDesktopToChromeChangedFolderIds: [],
    lastDesktopToChromePostImportRefreshError: '',
    chromePostImportRefreshRetryTimer: null,
    chromePostImportRenderRefreshCount: 0,
    lastChromePostImportRenderRefreshCount: 0,
    lastChromePostImportRefreshMode: '',
    lastChromePostImportRefreshAt: '',
    lastChromePostImportRefreshError: '',
    lastChromePostImportRefreshSuppressed: false,
    chromePostImportRefreshSuppressedCount: 0,
    lastChromePostImportChangedFolderCount: 0,
    lastChromePostImportChangedFields: [],
    lastChromePostImportChangedFolderIds: [],
    lastFolderDeleteReceiptImport: null,
    lastFolderRestoreReceiptImport: null,
    lastChatFolderBindingReceiptImport: null,
    desktopVisibleFolderSet: null,
    desktopCanonicalRecentlyDeleted: null,
    desktopPurgedFolderSuppression: null,
    desktopCanonicalChatFolderBindings: null,
    desktopCanonicalLibraryMetadata: null,
    lastLibraryMetadataMutationRequestAt: '',
    lastLibraryMetadataMutationRequestStatus: '',
    libraryMetadataMutationRequestCreates: 0,
    libraryMetadataMutationRequestDuplicates: 0,
    lastLibraryMetadataMutationReceiptImport: null,
    libraryMetadataMutationReceiptImports: 0,
    libraryMetadataMutationReceiptResolvedRequests: 0,
    loopSuppressedCount: 0,
    duplicateSkippedCount: 0,
    selfOriginSkippedCount: 0,
    errors: [],
  };

  function nowIso() {
    try { return new Date().toISOString(); }
    catch (_) { return String(Date.now()); }
  }

  function cleanString(value) {
    return String(value == null ? '' : value).trim();
  }

  function syncFolderPath(fileName) {
    return (state.folderName ? state.folderName + '/' : '') + cleanString(fileName || '');
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

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function numberOrZero(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function pushError(op, error) {
    try {
      state.errors.push({
        at: Date.now(),
        op: cleanString(op),
        error: String(error && (error.message || error)),
      });
      if (state.errors.length > MAX_ERRORS) state.errors.splice(0, state.errors.length - MAX_ERRORS);
    } catch (_) { /* ignore */ }
  }

  function getChromeStorageLocal() {
    try {
      return global.chrome && global.chrome.storage && global.chrome.storage.local;
    } catch (_) {
      return null;
    }
  }

  function readKv(key) {
    return new Promise(function (resolve) {
      var storage = getChromeStorageLocal();
      if (!storage || typeof storage.get !== 'function') { resolve(null); return; }
      try {
        storage.get([key], function (items) {
          resolve(items && Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function writeKv(key, value) {
    return new Promise(function (resolve, reject) {
      var storage = getChromeStorageLocal();
      if (!storage || typeof storage.set !== 'function') {
        reject(new Error('chrome.storage.local unavailable'));
        return;
      }
      try {
        var item = {}; item[key] = value;
        storage.set(item, function () {
          var lastErr = global.chrome && global.chrome.runtime && global.chrome.runtime.lastError;
          if (lastErr) reject(new Error(String(lastErr.message || lastErr)));
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function openDb() {
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
        } catch (error) { reject(error); }
      };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
      req.onsuccess = function () { resolve(req.result); };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('indexedDB transaction failed')); };
      tx.onabort = function () { reject(tx.error || new Error('indexedDB transaction aborted')); };
    });
  }

  async function idbGet(key) {
    var db = await openDb();
    try {
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).get(key);
        req.onerror = function () { reject(req.error || new Error('indexedDB get failed')); };
        req.onsuccess = function () { resolve(req.result || null); };
      });
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  async function idbPut(key, value) {
    var db = await openDb();
    try {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      await txDone(tx);
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  async function idbDelete(key) {
    var db = await openDb();
    try {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      await txDone(tx);
    } finally {
      try { db.close(); } catch (_) { /* ignore */ }
    }
  }

  async function loadState() {
    var saved = safeObject(await readKv(STATE_KEY));
    state.connectedAt = cleanString(saved.connectedAt);
    state.folderName = cleanString(saved.folderName) || state.folderName;
    state.lastAppliedExportId = cleanString(saved.lastAppliedExportId);
    state.lastAppliedExportedAt = cleanString(saved.lastAppliedExportedAt);
    state.lastAppliedAt = cleanString(saved.lastAppliedAt);
    state.lastChecksum = cleanString(saved.lastChecksum);
    state.lastSummarySignature = cleanString(saved.lastSummarySignature);
    state.lastSyncStatus = cleanString(saved.lastSyncStatus);
    state.lastSyncError = cleanString(saved.lastSyncError);
    state.lastFileLastModified = numberOrZero(saved.lastFileLastModified);
    state.lastFileSize = numberOrZero(saved.lastFileSize);
    state.desktopLatestPollSignature = state.lastFileLastModified || state.lastFileSize
      ? String(state.lastFileLastModified) + ':' + String(state.lastFileSize)
      : '';
    state.autoSyncEnabled = Object.prototype.hasOwnProperty.call(saved, 'autoSyncEnabled')
      ? saved.autoSyncEnabled !== false
      : true;
    state.lastAutoSyncAttemptAt = numberOrZero(saved.lastAutoSyncAttemptAt);
    state.lastAutoSyncAt = cleanString(saved.lastAutoSyncAt);
    state.lastAutoSyncReason = cleanString(saved.lastAutoSyncReason);
    state.lastAutoSyncStatus = cleanString(saved.lastAutoSyncStatus);
    state.lastAutoSyncError = cleanString(saved.lastAutoSyncError);
    state.lastChromeExportAttemptAt = numberOrZero(saved.lastChromeExportAttemptAt);
    state.lastChromeExportAt = cleanString(saved.lastChromeExportAt);
    state.lastChromeExportReason = cleanString(saved.lastChromeExportReason);
    state.lastChromeExportStatus = cleanString(saved.lastChromeExportStatus);
    state.lastChromeExportError = cleanString(saved.lastChromeExportError);
    state.lastChromeExportFile = cleanString(saved.lastChromeExportFile);
    state.lastChromeExportBytes = numberOrZero(saved.lastChromeExportBytes);
    state.lastChromeExportPermission = cleanString(saved.lastChromeExportPermission) || state.lastChromeExportPermission;
    state.lastChromeExportBlockers = Array.isArray(saved.lastChromeExportBlockers)
      ? saved.lastChromeExportBlockers.map(cleanString).filter(Boolean).slice(0, 8)
      : [];
    state.chromeExportLastStaleLockClearedAt = cleanString(saved.chromeExportLastStaleLockClearedAt);
    state.chromeExportLastStaleLockClearedReason = cleanString(saved.chromeExportLastStaleLockClearedReason);
    state.desktopVisibleFolderSet = normalizeDesktopVisibleFolderSetSnapshot(saved.desktopVisibleFolderSet);
    state.desktopCanonicalRecentlyDeleted = normalizeDesktopCanonicalRecentlyDeletedSnapshot(saved.desktopCanonicalRecentlyDeleted);
    state.desktopPurgedFolderSuppression = normalizeDesktopPurgedFolderSuppressionSnapshot(saved.desktopPurgedFolderSuppression);
    state.desktopCanonicalChatFolderBindings = normalizeDesktopCanonicalChatFolderBindingSnapshot(saved.desktopCanonicalChatFolderBindings);
    state.desktopCanonicalLibraryMetadata = normalizeDesktopCanonicalLibraryMetadataSnapshot(saved.desktopCanonicalLibraryMetadata);
  }

  async function persistState(patch) {
    var chromeExportReady = !!state.handle && getChromeExportWriteGate().effectiveFlagEnabled === true;
    var next = Object.assign({
      schemaVersion: 1,
      phase: PHASE,
      mode: MODE,
      updatedAt: nowIso(),
      connected: !!state.handle,
      folderName: state.folderName,
      connectedAt: state.connectedAt,
      lastAppliedExportId: state.lastAppliedExportId,
      lastAppliedExportedAt: state.lastAppliedExportedAt,
      lastAppliedAt: state.lastAppliedAt,
      lastChecksum: state.lastChecksum,
      lastSummarySignature: state.lastSummarySignature,
      lastSyncStatus: state.lastSyncStatus,
      lastSyncError: state.lastSyncError,
      lastFileLastModified: state.lastFileLastModified,
      lastFileSize: state.lastFileSize,
      autoSyncEnabled: !!state.autoSyncEnabled,
      lastAutoSyncAttemptAt: state.lastAutoSyncAttemptAt,
      lastAutoSyncAt: state.lastAutoSyncAt,
      lastAutoSyncReason: state.lastAutoSyncReason,
      lastAutoSyncStatus: state.lastAutoSyncStatus,
      lastAutoSyncError: state.lastAutoSyncError,
      chromeExportPending: !!state.chromeExportPending,
      chromeExportInFlight: !!state.chromeExportInFlight,
      chromeExportInFlightStartedAt: state.chromeExportInFlightStartedAt,
      chromeExportInFlightReason: state.chromeExportInFlightReason,
      chromeExportInFlightOwner: state.chromeExportInFlightOwner,
      chromeExportLastStaleLockClearedAt: state.chromeExportLastStaleLockClearedAt,
      chromeExportLastStaleLockClearedReason: state.chromeExportLastStaleLockClearedReason,
      chromeExportScheduledAt: state.chromeExportScheduledAt,
      chromeExportScheduledReason: state.chromeExportScheduledReason,
      lastChromeExportAttemptAt: state.lastChromeExportAttemptAt,
      lastChromeExportAt: state.lastChromeExportAt,
      lastChromeExportReason: state.lastChromeExportReason,
      lastChromeExportStatus: state.lastChromeExportStatus,
      lastChromeExportError: state.lastChromeExportError,
      lastChromeExportFile: state.lastChromeExportFile,
      lastChromeExportBytes: state.lastChromeExportBytes,
      lastChromeExportPermission: state.lastChromeExportPermission,
      lastChromeExportBlockers: state.lastChromeExportBlockers.slice(),
      desktopVisibleFolderSet: state.desktopVisibleFolderSet,
      desktopCanonicalRecentlyDeleted: state.desktopCanonicalRecentlyDeleted,
      desktopPurgedFolderSuppression: state.desktopPurgedFolderSuppression,
      desktopCanonicalChatFolderBindings: state.desktopCanonicalChatFolderBindings,
      desktopCanonicalLibraryMetadata: state.desktopCanonicalLibraryMetadata,
      autoSyncMinIntervalMs: AUTO_SYNC_MIN_INTERVAL_MS,
      backgroundAutoImport: false,
      chromeWritesSyncFolder: state.lastChromeExportStatus === 'chrome-to-desktop-exported' || chromeExportReady,
    }, safeObject(patch));
    /* M2: File System Access permission is live browser state. Historical
     * rows may contain this field, but no write from this module preserves or
     * creates it; loadStoredHandle() always queries the handle instead. */
    delete next.permission;
    await writeKv(STATE_KEY, next);
  }

  async function loadStoredHandle() {
    if (state.loaded) return state.handle;
    if (state.loadPromise) return state.loadPromise;
    state.loadPromise = (async function () {
      await loadState();
      try {
        var row = await idbGet(IDB_KEY);
        if (row && row.handle) {
          state.handle = row.handle;
          state.folderName = cleanString(row.name || row.handle.name || state.folderName);
          state.connectedAt = cleanString(row.connectedAt || state.connectedAt);
          state.permission = await queryPermission(row.handle);
        }
      } catch (error) {
        pushError('load-folder-handle', error);
      }
      state.loaded = true;
      state.loadPromise = null;
      return state.handle;
    })();
    return state.loadPromise;
  }

  async function queryPermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return 'unknown';
    try {
      return await handle.queryPermission({ mode: 'read' });
    } catch (error) {
      pushError('query-permission', error);
      return 'unknown';
    }
  }

  async function queryReadWritePermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return 'unknown';
    try {
      return await handle.queryPermission({ mode: 'readwrite' });
    } catch (error) {
      pushError('query-readwrite-permission', error);
      return 'unknown';
    }
  }

  function documentIsVisible() {
    try {
      return !global.document || !global.document.visibilityState || global.document.visibilityState === 'visible';
    } catch (_) {
      return true;
    }
  }

  function objectProtocolOwnsAutomaticMutation() {
    return !!global.H2O?.Studio?.sync?.objectAutoReconcile;
  }

  function desktopLatestFileSignature(file) {
    return String(numberOrZero(file && file.lastModified)) + ':' + String(numberOrZero(file && file.size));
  }

  function isFastDesktopLatestChangeReason(reason) {
    var clean = cleanString(reason).toLowerCase();
    return clean.indexOf('desktop-latest-poll') !== -1
      || clean.indexOf('desktop-latest-changed') !== -1
      || clean.indexOf('folder-metadata-fast-import') !== -1;
  }

  function clearDesktopLatestPollTimer() {
    if (!state.desktopLatestPollTimer) return;
    try { global.clearInterval(state.desktopLatestPollTimer); }
    catch (_) { /* ignore */ }
    state.desktopLatestPollTimer = null;
  }

  async function pollDesktopLatestForChanges(reason) {
    var cleanReason = cleanString(reason) || 'desktop-latest-poll';
    if (objectProtocolOwnsAutomaticMutation()) return null;
    if (!state.autoSyncEnabled || !state.handle || !documentIsVisible()) return null;
    if (state.desktopLatestPollRunning || state.autoSyncRunning || state.syncInFlight) return null;
    state.desktopLatestPollRunning = true;
    state.lastDesktopLatestPollAt = nowIso();
    state.lastDesktopLatestPollStatus = 'polling';
    state.lastDesktopLatestPollError = '';
    try {
      var permission = await queryPermission(state.handle);
      state.permission = permission;
      if (permission !== 'granted') {
        state.lastDesktopLatestPollStatus = 'permission-required';
        state.lastDesktopLatestPollError = 'read permission not granted';
        return null;
      }
      var fileHandle;
      try {
        fileHandle = await state.handle.getFileHandle(LATEST_FILE, { create: false });
      } catch (missingError) {
        state.lastDesktopLatestPollStatus = 'latest-missing';
        state.lastDesktopLatestPollError = String(missingError && (missingError.message || missingError));
        return null;
      }
      var file = await fileHandle.getFile();
      var signature = desktopLatestFileSignature(file);
      var previous = cleanString(state.desktopLatestPollSignature);
      state.desktopLatestPollSignature = signature;
      state.lastDesktopLatestPollFileLastModified = numberOrZero(file.lastModified);
      state.lastDesktopLatestPollFileSize = numberOrZero(file.size);
      if (previous && previous === signature) {
        state.lastDesktopLatestPollStatus = 'unchanged';
        return null;
      }
      state.lastDesktopLatestPollDetectedAt = nowIso();
      state.lastDesktopLatestPollStatus = previous ? 'changed' : 'first-seen';
      return scheduleAutoSync(previous ? 'desktop-latest-poll-changed' : 'desktop-latest-poll-first-seen');
    } catch (error) {
      state.lastDesktopLatestPollStatus = 'poll-failed';
      state.lastDesktopLatestPollError = String(error && (error.message || error));
      pushError('desktop-latest-poll', error);
      return null;
    } finally {
      state.desktopLatestPollRunning = false;
    }
  }

  function startDesktopLatestPoller(reason) {
    if (objectProtocolOwnsAutomaticMutation()) return false;
    if (state.desktopLatestPollTimer || !state.autoSyncEnabled || !state.handle) return false;
    state.desktopLatestPollTimer = global.setInterval(function () {
      pollDesktopLatestForChanges('desktop-latest-poll:' + cleanString(reason || 'interval'))
        .catch(function (error) { pushError('desktop-latest-poll.interval', error); });
    }, DESKTOP_LATEST_POLL_INTERVAL_MS);
    global.setTimeout(function () {
      pollDesktopLatestForChanges('desktop-latest-poll:' + cleanString(reason || 'start'))
        .catch(function (error) { pushError('desktop-latest-poll.start', error); });
    }, 250);
    return true;
  }

  async function requestReadPermission(handle) {
    if (!handle) return 'denied';
    var current = await queryPermission(handle);
    if (current === 'granted') return 'granted';
    if (typeof handle.requestPermission !== 'function') return current || 'unknown';
    try {
      return await handle.requestPermission({ mode: 'read' });
    } catch (error) {
      pushError('request-permission', error);
      return 'denied';
    }
  }

  function clearAutoSyncTimer() {
    if (!state.autoSyncTimer) return;
    try { global.clearTimeout(state.autoSyncTimer); }
    catch (_) { /* ignore */ }
    state.autoSyncTimer = null;
  }

  function clearChromeExportTimer() {
    if (!state.chromeExportTimer) return;
    try { global.clearTimeout(state.chromeExportTimer); }
    catch (_) { /* ignore */ }
    state.chromeExportTimer = null;
  }

  function bindAutoSyncEvents() {
    if (state.autoSyncEventsBound) return;
    state.autoSyncEventsBound = true;
    try {
      global.addEventListener('focus', function () {
        pollDesktopLatestForChanges('desktop-latest-poll:window-focus').catch(function (error) { pushError('desktop-latest-poll.focus', error); });
        scheduleAutoSync('window-focus').catch(function (error) { pushError('auto-sync.focus', error); });
      });
    } catch (error) { pushError('bind.focus', error); }
    try {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'visible') {
          startDesktopLatestPoller('document-visible');
          pollDesktopLatestForChanges('desktop-latest-poll:document-visible').catch(function (error) { pushError('desktop-latest-poll.visibility', error); });
          scheduleAutoSync('document-visible').catch(function (error) { pushError('auto-sync.visibility', error); });
        } else {
          clearDesktopLatestPollTimer();
        }
      });
    } catch (error) { pushError('bind.visibilitychange', error); }
    startDesktopLatestPoller('bind-auto-sync-events');
  }

  function throttleRemainingMs(nowMs) {
    var last = numberOrZero(state.lastAutoSyncAttemptAt);
    if (!last) return 0;
    return Math.max(0, AUTO_SYNC_MIN_INTERVAL_MS - (nowMs - last));
  }

  function getPlatformMessaging() {
    try {
      var p = H2O.Studio && H2O.Studio.platform && H2O.Studio.platform.messaging;
      if (!p || typeof p.send !== 'function') return null;
      var env = H2O.Studio.platform && H2O.Studio.platform.env;
      if (env && env.adapter === 'fallback') return null;
      return p;
    } catch (_) {
      return null;
    }
  }

  async function callArchive(op, payload, nsDisk) {
    var message = { type: MSG_ARCHIVE, req: { op: op, payload: payload || {}, nsDisk: nsDisk } };
    var pm = getPlatformMessaging();
    var response = pm
      ? await pm.send('archive', message)
      : await global.chrome.runtime.sendMessage(message);
    if (!response || !response.ok) throw new Error((response && response.error) || ('Archive op failed: ' + op));
    return response.result;
  }

  async function sha256Hex(text) {
    try {
      if (!global.crypto || !global.crypto.subtle || typeof TextEncoder === 'undefined') return '';
      var bytes = new TextEncoder().encode(String(text || ''));
      var digest = await global.crypto.subtle.digest('SHA-256', bytes);
      return Array.prototype.map.call(new Uint8Array(digest), function (byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
    } catch (_) {
      return '';
    }
  }

  function summarySignature(bundle) {
    var summary = safeObject(bundle && bundle.summary);
    return [
      'exportedAt=' + cleanString(bundle && bundle.exportedAt),
      'chats=' + numberOrZero(summary.chatCount),
      'snapshots=' + numberOrZero(summary.snapshotCount),
      'turns=' + numberOrZero(summary.turnCount),
      'folders=' + numberOrZero(summary.folderCount),
      'labels=' + numberOrZero(summary.labelCount),
      'categories=' + numberOrZero(summary.categoryCount),
    ].join(';');
  }

  function validateBundle(bundle) {
    if (!bundle || typeof bundle !== 'object') throw new Error('bundle must be an object');
    if (bundle.schema !== FULL_BUNDLE_SCHEMA) {
      throw new Error('unsupported bundle schema: ' + cleanString(bundle.schema || '(missing)'));
    }
    if (!bundle.chatArchive || typeof bundle.chatArchive !== 'object') {
      throw new Error('missing chatArchive');
    }
    return bundle;
  }

  function cloneJson(value) {
    if (typeof value === 'undefined') return undefined;
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_) { return null; }
  }

  function addUnique(list, code) {
    var normalized = cleanString(code);
    if (normalized && list.indexOf(normalized) === -1) list.push(normalized);
  }

  function normalizeHardeningWarnings(warnings) {
    var out = Array.isArray(warnings) ? warnings.slice() : [];
    var legacyDeferred = [
      DESKTOP_CHROME_DEFERRED_CODES.labels,
      DESKTOP_CHROME_DEFERRED_CODES.tags,
      DESKTOP_CHROME_DEFERRED_CODES.projects,
      DESKTOP_CHROME_DEFERRED_CODES.folderBindings,
      DESKTOP_CHROME_DEFERRED_CODES.tombstones,
      DESKTOP_CHROME_DEFERRED_CODES.applyEvents
    ];
    for (var i = 0; i < legacyDeferred.length; i += 1) {
      if (out.indexOf(legacyDeferred[i]) !== -1) addUnique(out, F19_SYNC_HARDENING_CODES.deferredFieldPresent);
    }
    if (out.indexOf(DESKTOP_CHROME_DEFERRED_CODES.unsupportedStorage) !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.unsupportedFieldPresent);
    }
    if (out.indexOf(DESKTOP_CHROME_DEFERRED_CODES.sourceMetadataMissing) !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.sourceMetadataMissing);
    }
    return out;
  }

  function normalizeHardeningBlockers(blockers) {
    var out = Array.isArray(blockers) ? blockers.slice() : [];
    if (out.indexOf('library-propagation-folder-required') !== -1 ||
        out.indexOf('sync-folder-not-connected') !== -1 ||
        out.indexOf('sync-folder-missing') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.syncFolderMissing);
    }
    if (out.indexOf('sync-folder-reconnect-required') !== -1 ||
        out.indexOf('sync-folder-permission-denied') !== -1 ||
        out.indexOf('permission-denied') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.permissionDenied);
    }
    if (out.indexOf('library-propagation-read-failed') !== -1 ||
        out.indexOf('sync-folder-latest-missing') !== -1 ||
        out.indexOf('transport-file-missing') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.transportFileMissing);
    }
    if (out.indexOf('library-propagation-json-parse-failed') !== -1 ||
        out.indexOf('sync-folder-latest-malformed') !== -1 ||
        out.indexOf('transport-file-malformed') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.transportFileMalformed);
    }
    if (out.indexOf('library-propagation-schema-invalid') !== -1 ||
        out.indexOf('sync-folder-latest-schema-unsupported') !== -1 ||
        out.indexOf('transport-schema-unsupported') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.transportSchemaUnsupported);
    }
    if (out.indexOf('library-propagation-transport-stale') !== -1 ||
        out.indexOf('transport-stale') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.transportStale);
    }
    if (out.indexOf('library-propagation-simultaneous-update-conflict') !== -1 ||
        out.indexOf('simultaneous-update-conflict') !== -1) {
      addUnique(out, F19_SYNC_HARDENING_CODES.simultaneousUpdateConflict);
    }
    return out;
  }

  function parseTimeMs(value) {
    var clean = cleanString(value);
    if (!clean) return 0;
    var ms = Date.parse(clean);
    return isFinite(ms) ? ms : 0;
  }

  function addHealthCode(list, code) {
    addUnique(list, cleanString(code));
  }

  function addHealthCodeFromHardening(list, code) {
    var normalized = cleanString(code);
    if (!normalized) return;
    if (normalized === F19_SYNC_HARDENING_CODES.syncFolderMissing ||
        normalized === 'sync-folder-missing' ||
        normalized === 'sync-folder-not-connected') {
      addHealthCode(list, 'no-folder-handle');
      return;
    }
    if (normalized === F19_SYNC_HARDENING_CODES.permissionDenied ||
        normalized === 'permission-denied' ||
        normalized === 'sync-folder-permission-denied') {
      addHealthCode(list, 'permission-required');
      return;
    }
    if (normalized === F19_SYNC_HARDENING_CODES.transportFileMissing ||
        normalized === 'sync-folder-latest-missing') {
      addHealthCode(list, 'transport-file-missing');
      return;
    }
    if (normalized === F19_SYNC_HARDENING_CODES.transportFileMalformed ||
        normalized === F19_SYNC_HARDENING_CODES.transportSchemaUnsupported ||
        normalized === 'sync-folder-latest-malformed' ||
        normalized === 'sync-folder-latest-schema-unsupported') {
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
    if (text.indexOf('not connected') !== -1 || text.indexOf('folder-required') !== -1 ||
        text.indexOf('folder missing') !== -1 || text.indexOf('sync-folder-missing') !== -1) {
      addHealthCode(list, 'no-folder-handle');
    }
    if (text.indexOf('latest-missing') !== -1 || text.indexOf('transport-file-missing') !== -1) {
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

  function shouldReportChromeSchedulerNotFired(raw, desktopToChromeRaw, blockerFlags) {
    if (!blockerFlags || blockerFlags.schedulerNotFired !== true) return false;
    if (!raw || !raw.autoSyncEnabled || !raw.connected) return false;
    if (state.autoSyncTimer || state.autoSyncRunning || state.syncInFlight) return false;
    var expectedAt = Math.max(
      healthEventTimeMs(state.lastDesktopLatestPollDetectedAt),
      healthEventTimeMs(state.lastDesktopToChromeExportWrittenAt),
      healthEventTimeMs(desktopToChromeRaw && desktopToChromeRaw.lastDesktopLatestPollDetectedAt)
    );
    if (!isRecentHealthEvent(expectedAt)) return false;
    var scheduledAt = healthEventTimeMs(state.autoSyncScheduledAt);
    var attemptedAt = healthEventTimeMs(state.lastAutoSyncAttemptAt);
    return scheduledAt < expectedAt && attemptedAt < expectedAt;
  }

  function classifyIncomingDesktopTransport(bundle, checksum) {
    var blockers = [];
    if (!bundle || typeof bundle !== 'object') return blockers;
    var incomingExportedAtMs = parseTimeMs(bundle.exportedAt);
    var lastExportedAtMs = parseTimeMs(state.lastAppliedExportedAt);
    var sameChecksum = !!(checksum && state.lastChecksum && checksum === state.lastChecksum);
    if (incomingExportedAtMs && lastExportedAtMs && incomingExportedAtMs < lastExportedAtMs && !sameChecksum) {
      addUnique(blockers, 'library-propagation-transport-stale');
    }
    var previousExportId = cleanString(bundle.previousExportId);
    if (previousExportId && state.lastAppliedExportId && previousExportId !== state.lastAppliedExportId && !sameChecksum) {
      addUnique(blockers, 'library-propagation-simultaneous-update-conflict');
    }
    return blockers;
  }

  function normalizeConflictDecision(options) {
    return cleanString(options && options.conflictDecision).toLowerCase();
  }

  function resolveOperatorApprovedTransportBlockers(blockers, options) {
    var input = Array.isArray(blockers) ? blockers.slice() : [];
    var decision = normalizeConflictDecision(options);
    var approveMerge = decision === 'approve-merge';
    var approved = [];
    var remaining = [];
    for (var i = 0; i < input.length; i += 1) {
      var code = cleanString(input[i]);
      if (approveMerge && code === 'library-propagation-simultaneous-update-conflict') {
        approved.push(code);
      } else if (code) {
        remaining.push(code);
      }
    }
    return {
      blockers: remaining,
      conflictDecision: decision,
      conflictApproved: approved.length > 0,
      approvedBlockers: approved,
      warning: approved.length > 0 ? 'library-propagation-simultaneous-conflict-approved' : ''
    };
  }

  function folderMetadataRowId(row) {
    return cleanString(row && (row.folderId || row.id || row.folder_id));
  }

  function folderMetadataRowName(row) {
    return cleanString(row && (row.name || row.title || row.label));
  }

  function folderMetadataRowColor(row) {
    var meta = row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
      ? row.meta : {};
    return cleanString(row && (row.color || row.iconColor || meta.color || meta.iconColor)).toUpperCase();
  }

  function folderMetadataRowTimestampMs(row) {
    var meta = row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
      ? row.meta : {};
    return parseTimeMs(row && (row.updatedAt || row.updated_at || meta.updatedAt || meta.updated_at));
  }

  function normalizeFolderRecordId(value) {
    var text = cleanString(value);
    return text.indexOf('folder:') === 0 ? text.slice('folder:'.length) : text;
  }

  function folderMetadataRowsFromBundle(bundle) {
    var found = readDesktopChromeFolderStateSource(bundle);
    var source = found && found.source;
    var rows = [];
    if (source && typeof source === 'object' && !Array.isArray(source) && Array.isArray(source.folders)) {
      for (var i = 0; i < source.folders.length; i += 1) {
        var folder = sanitizeFolderForDesktopChrome(source.folders[i]);
        if (folder) rows.push(folder);
      }
    }
    return {
      sourceKind: cleanString(found && found.sourceKind),
      rows: rows
    };
  }

  function isFolderVisibleForParity(row) {
    var meta = row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {};
    if (!row || typeof row !== 'object') return false;
    if (row.hidden === true || meta.hidden === true) return false;
    if (row.hiddenByDesktopReceipt === true || meta.hiddenByDesktopReceipt === true) return false;
    if (row.deleted === true || meta.deleted === true) return false;
    if (cleanString(row.deletedAt || row.deleted_at || meta.deletedAt || meta.deleted_at)) return false;
    return !!folderMetadataRowId(row);
  }

  function isProtectedFolderForVisibleParity(row) {
    var meta = row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {};
    var id = normalizeFolderRecordId(folderMetadataRowId(row)).toLowerCase();
    var name = folderMetadataRowName(row).toLowerCase();
    return id === 'unfiled' ||
      id === '__unfiled__' ||
      name === 'unfiled' ||
      row?.isUnfiled === true ||
      row?.isSystem === true ||
      row?.protected === true ||
      row?.isProtected === true ||
      row?.protectedCanonicalFallback === true ||
      meta.isUnfiled === true ||
      meta.isSystem === true ||
      meta.protected === true ||
      meta.isProtected === true ||
      meta.protectedCanonicalFallback === true;
  }

  function isChromeCreatedFolderForVisibleParity(row) {
    var meta = row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {};
    var sourceKind = cleanString(row && (row.sourceKind || row.kind || meta.sourceKind || meta.kind)).toLowerCase();
    var source = cleanString(row && (row.source || meta.source)).toLowerCase();
    return sourceKind.indexOf('chrome') !== -1 ||
      source === 'chrome-studio' ||
      row?.createdBy === 'chrome-studio' ||
      meta.createdBy === 'chrome-studio';
  }

  function isPendingChromeCreatedForVisibleParity(row, snapshot) {
    if (!isChromeCreatedFolderForVisibleParity(row)) return false;
    var sourceExportedAtMs = parseTimeMs(snapshot && snapshot.sourceExportedAt);
    var rowUpdatedMs = folderMetadataRowTimestampMs(row);
    return !sourceExportedAtMs || (rowUpdatedMs && rowUpdatedMs > sourceExportedAtMs);
  }

  function summarizeVisibleParityFolder(row, extra) {
    var meta = row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? row.meta : {};
    return Object.assign({
      folderId: normalizeFolderRecordId(folderMetadataRowId(row)),
      id: normalizeFolderRecordId(folderMetadataRowId(row)),
      name: folderMetadataRowName(row),
      color: folderMetadataRowColor(row),
      source: cleanString(row && (row.source || meta.source)),
      sourceKind: cleanString(row && (row.sourceKind || row.kind || meta.sourceKind || meta.kind)),
      updatedAt: cleanString(row && (row.updatedAt || row.updated_at || meta.updatedAt || meta.updated_at)),
      hidden: !isFolderVisibleForParity(row),
      protected: isProtectedFolderForVisibleParity(row),
      chromeCreated: isChromeCreatedFolderForVisibleParity(row)
    }, extra || {});
  }

  function visibleParityRowMap(rows) {
    var map = Object.create(null);
    var list = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < list.length; i += 1) {
      if (!isFolderVisibleForParity(list[i])) continue;
      var id = normalizeFolderRecordId(folderMetadataRowId(list[i]));
      if (id && !map[id]) map[id] = list[i];
    }
    return map;
  }

  function normalizeDesktopVisibleFolderSetSnapshot(value) {
    var input = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!input) return null;
    var rows = Array.isArray(input.rows) ? input.rows : [];
    var safeRows = [];
    var ids = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] && typeof rows[i] === 'object' && !Array.isArray(rows[i]) ? rows[i] : null;
      var id = normalizeFolderRecordId(folderMetadataRowId(row));
      if (!row || !id || ids.indexOf(id) !== -1) continue;
      ids.push(id);
      safeRows.push({
        folderId: id,
        id: id,
        name: folderMetadataRowName(row),
        color: folderMetadataRowColor(row),
        iconColor: folderMetadataRowColor(row),
        source: cleanString(row.source),
        sourceKind: cleanString(row.sourceKind),
        updatedAt: cleanString(row.updatedAt),
        hidden: false
      });
    }
    ids.sort();
    safeRows.sort(function (a, b) {
      return cleanString(a.folderId).localeCompare(cleanString(b.folderId));
    });
    return {
      schema: 'h2o.studio.folder-visible-set.desktop.v1',
      source: cleanString(input.source || 'desktop-latest-visible-set'),
      status: cleanString(input.status || 'imported'),
      importedAt: cleanString(input.importedAt),
      sourceExportedAt: cleanString(input.sourceExportedAt),
      sourceKind: cleanString(input.sourceKind),
      desktopVisibleFolderIds: ids,
      desktopVisibleFolderCount: ids.length,
      rows: safeRows,
      noTombstoneApplyOnChrome: true,
      noTombstoneCreateOnChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true
    };
  }

  function buildDesktopVisibleFolderSetSnapshot(bundle, importedAt) {
    var rowsInfo = folderMetadataRowsFromBundle(bundle);
    var map = visibleParityRowMap(rowsInfo.rows);
    var ids = Object.keys(map).sort();
    var rows = ids.map(function (id) {
      return summarizeVisibleParityFolder(map[id], {
        hidden: false,
        protected: isProtectedFolderForVisibleParity(map[id])
      });
    });
    return normalizeDesktopVisibleFolderSetSnapshot({
      source: 'desktop-latest-visible-set',
      status: 'imported',
      importedAt: cleanString(importedAt) || nowIso(),
      sourceExportedAt: cleanString(bundle && bundle.exportedAt),
      sourceKind: rowsInfo.sourceKind,
      rows: rows
    });
  }

  function importDesktopVisibleFolderSetSnapshot(bundle, importedAt) {
    var snapshot = buildDesktopVisibleFolderSetSnapshot(bundle, importedAt);
    state.desktopVisibleFolderSet = snapshot;
    return snapshot;
  }

  function normalizeDesktopCanonicalRecentlyDeletedSnapshot(value) {
    var input = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!input) return null;
    var rows = Array.isArray(input.rows) ? input.rows : [];
    var safeRows = [];
    var ids = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] && typeof rows[i] === 'object' && !Array.isArray(rows[i]) ? rows[i] : null;
      var id = normalizeFolderRecordId(row && (row.folderId || row.id));
      if (!row || !id || ids.indexOf(id) !== -1) continue;
      var requestId = cleanString(row.requestId || row.reviewId);
      ids.push(id);
      safeRows.push({
        schema: 'h2o.studio.folder-recently-deleted.desktop-canonical.v1.row',
        tombstoneId: cleanString(row.tombstoneId),
        recordId: cleanString(row.recordId || ('folder:' + id)),
        folderId: id,
        id: id,
        folderName: cleanString(row.folderName || row.name || row.title || id),
        name: cleanString(row.name || row.folderName || row.title || id),
        deletedAt: cleanString(row.deletedAt),
        deleteReason: cleanString(row.deleteReason || row.reason),
        requestId: requestId,
        reviewId: cleanString(row.reviewId || requestId),
        source: 'desktop-canonical-recently-deleted',
        sourceKind: 'desktop-canonical-recently-deleted',
        status: 'deleted',
        companionStatusLabel: 'Deleted on Desktop',
        restoreEligible: row.restoreEligible !== false,
        restoreAvailable: row.restoreAvailable !== false,
        purgeEligible: row.purgeEligible !== false,
        desktopCanonicalRecentlyDeleted: true,
        desktopReceiptHidden: true,
        noChromeAuthority: true,
        noChromePurgeAuthority: true,
        noChromeTombstoneApply: true,
        noTombstoneApplyOnChrome: true,
        noTombstoneCreateOnChrome: true,
        noHardDelete: true,
        noPurge: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true
      });
    }
    ids.sort();
    safeRows.sort(function (a, b) {
      return cleanString(b.deletedAt).localeCompare(cleanString(a.deletedAt)) ||
        cleanString(a.folderName).localeCompare(cleanString(b.folderName));
    });
    return {
      schema: 'h2o.studio.folder-recently-deleted.desktop-canonical.v1',
      source: cleanString(input.source || 'desktop-canonical-recently-deleted'),
      status: cleanString(input.status || 'imported'),
      importedAt: cleanString(input.importedAt),
      sourceExportedAt: cleanString(input.sourceExportedAt),
      desktopCanonicalRecentlyDeletedFolderIds: ids,
      desktopCanonicalRecentlyDeletedCount: ids.length,
      rows: safeRows,
      desktopAuthority: true,
      chromeAuthority: false,
      noChromePurgeAuthority: true,
      noChromeTombstoneApply: true,
      noChromeTombstoneCreate: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true
    };
  }

  function buildDesktopCanonicalRecentlyDeletedSnapshot(bundle, importedAt) {
    var payload = safeObject(bundle && bundle.desktopCanonicalRecentlyDeleted);
    var rows = Array.isArray(payload.rows)
      ? payload.rows
      : (Array.isArray(bundle && bundle.desktopCanonicalRecentlyDeletedFolders)
        ? bundle.desktopCanonicalRecentlyDeletedFolders
        : null);
    if (!rows) return null;
    return normalizeDesktopCanonicalRecentlyDeletedSnapshot({
      source: 'desktop-canonical-recently-deleted',
      status: 'imported',
      importedAt: cleanString(importedAt) || nowIso(),
      sourceExportedAt: cleanString(bundle && bundle.exportedAt),
      rows: rows
    });
  }

  async function storeDesktopCanonicalRecentlyDeletedSnapshot(snapshotInput) {
    var snapshot = normalizeDesktopCanonicalRecentlyDeletedSnapshot(snapshotInput);
    var result = {
      schema: 'h2o.studio.folder-recently-deleted.desktop-canonical.chrome-import.v1',
      phase: 'phase6b.5',
      attempted: true,
      ok: true,
      status: 'desktop-canonical-recently-deleted-imported',
      desktopCanonicalRecentlyDeletedCount: snapshot ? numberOrZero(snapshot.desktopCanonicalRecentlyDeletedCount) : 0,
      changed: false,
      importedAt: snapshot ? cleanString(snapshot.importedAt) : '',
      sourceExportedAt: snapshot ? cleanString(snapshot.sourceExportedAt) : '',
      blockers: [],
      warnings: [],
      noChromePurgeAuthority: true,
      noChromeTombstoneApply: true,
      noTombstoneCreateOnChrome: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true
    };
    if (!snapshot) {
      result.ok = false;
      result.status = 'desktop-canonical-recently-deleted-missing';
      result.blockers.push('desktop-canonical-recently-deleted-missing');
      return result;
    }
    var current = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var existing = normalizeDesktopCanonicalRecentlyDeletedSnapshot(current.desktopCanonicalRecentlyDeleted);
    result.changed = JSON.stringify(safeObject(existing)) !== JSON.stringify(safeObject(snapshot));
    if (result.changed) {
      var next = cloneJson(current) || {};
      next.desktopCanonicalRecentlyDeleted = snapshot;
      next.updatedAt = nowIso();
      await writeKv(FOLDER_STATE_KEY_LOCAL, next);
    }
    state.desktopCanonicalRecentlyDeleted = snapshot;
    return result;
  }

  function normalizeDesktopCanonicalChatFolderBindingSnapshot(value) {
    var input = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!input) return null;
    var sourceRows = Array.isArray(input.bindings)
      ? input.bindings
      : (Array.isArray(input.rows) ? input.rows : []);
    var bindings = [];
    var seen = Object.create(null);
    var folderBindingCounts = {};
    var uniqueChats = Object.create(null);
    for (var i = 0; i < sourceRows.length; i += 1) {
      var row = sourceRows[i] && typeof sourceRows[i] === 'object' && !Array.isArray(sourceRows[i]) ? sourceRows[i] : null;
      var chatId = cleanString(row && (row.chatId || row.conversationId));
      var folderId = normalizeFolderRecordId(row && row.folderId);
      if (!row || !chatId || !folderId) continue;
      var key = chatId + '\u0000' + folderId;
      if (seen[key]) continue;
      seen[key] = true;
      uniqueChats[chatId] = true;
      folderBindingCounts[folderId] = (numberOrZero(folderBindingCounts[folderId]) || 0) + 1;
      bindings.push({
        schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA + '.row',
        chatId: chatId,
        conversationId: chatId,
        folderId: folderId,
        folderName: cleanString(row.folderName || row.name || folderId),
        source: 'desktop-canonical-chat-folder-bindings',
        sourceSurface: 'desktop-studio',
        authority: 'desktop',
        status: cleanString(row.status || row.state || 'active') || 'active',
        state: cleanString(row.state || row.status || 'active') || 'active',
        observedAt: cleanString(row.observedAt || row.updatedAt || input.exportedAt || input.sourceExportedAt),
        updatedAt: cleanString(row.updatedAt),
        noChromeDestructiveBindingApply: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noHardDelete: true,
        noPurge: true
      });
    }
    bindings.sort(function (a, b) {
      return cleanString(a.folderId).localeCompare(cleanString(b.folderId)) ||
        cleanString(a.chatId).localeCompare(cleanString(b.chatId));
    });
    return {
      schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA,
      source: cleanString(input.source || 'desktop-canonical-chat-folder-bindings'),
      status: cleanString(input.status || 'imported'),
      importedAt: cleanString(input.importedAt),
      sourceExportedAt: cleanString(input.sourceExportedAt || input.exportedAt),
      bindingCount: bindings.length,
      totalBindingCount: bindings.length,
      folderBindingCounts: folderBindingCounts,
      unfiledCount: Object.prototype.hasOwnProperty.call(input, 'unfiledCount') ? input.unfiledCount : null,
      missingFolderBindingCount: numberOrZero(input.missingFolderBindingCount),
      deletedFolderBindingCount: numberOrZero(input.deletedFolderBindingCount),
      fallbackUnfiledBindingCount: numberOrZero(input.fallbackUnfiledBindingCount),
      activeDanglingFolderBindingCount: numberOrZero(input.activeDanglingFolderBindingCount),
      activeDeletedFolderBindingExportedAsActive: input.activeDeletedFolderBindingExportedAsActive === true,
      deletedFolderBindingsExcludedFromActiveProjection: input.deletedFolderBindingsExcludedFromActiveProjection !== false,
      restoredFolderBindingCount: numberOrZero(input.restoredFolderBindingCount),
      bindings: bindings,
      rows: bindings,
      desktopAuthority: true,
      chromeAuthority: false,
      readOnlyProjection: true,
      noChromeDestructiveBindingApply: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true
    };
  }

  function buildDesktopCanonicalChatFolderBindingSnapshot(bundle, importedAt) {
    var payload = safeObject(bundle && bundle.desktopCanonicalChatFolderBindings);
    var rows = Array.isArray(payload.bindings)
      ? payload.bindings
      : (Array.isArray(payload.rows)
        ? payload.rows
        : (Array.isArray(bundle && bundle.chatFolderBindings) ? bundle.chatFolderBindings : null));
    if (!rows) return null;
    return normalizeDesktopCanonicalChatFolderBindingSnapshot({
      source: 'desktop-canonical-chat-folder-bindings',
      status: 'imported',
      importedAt: cleanString(importedAt) || nowIso(),
      sourceExportedAt: cleanString(bundle && bundle.exportedAt),
      unfiledCount: Object.prototype.hasOwnProperty.call(payload, 'unfiledCount') ? payload.unfiledCount : null,
      missingFolderBindingCount: payload.missingFolderBindingCount,
      deletedFolderBindingCount: payload.deletedFolderBindingCount,
      fallbackUnfiledBindingCount: payload.fallbackUnfiledBindingCount,
      activeDanglingFolderBindingCount: payload.activeDanglingFolderBindingCount,
      activeDeletedFolderBindingExportedAsActive: payload.activeDeletedFolderBindingExportedAsActive,
      deletedFolderBindingsExcludedFromActiveProjection: payload.deletedFolderBindingsExcludedFromActiveProjection,
      restoredFolderBindingCount: payload.restoredFolderBindingCount,
      bindings: rows
    });
  }

  async function storeDesktopCanonicalChatFolderBindingSnapshot(snapshotInput) {
    var snapshot = normalizeDesktopCanonicalChatFolderBindingSnapshot(snapshotInput);
    var result = {
      schema: DESKTOP_CANONICAL_CHAT_FOLDER_BINDING_SCHEMA + '.chrome-import.v1',
      phase: 'chat-folder-binding-b2',
      attempted: true,
      ok: true,
      status: 'desktop-canonical-chat-folder-bindings-imported',
      bindingCount: snapshot ? numberOrZero(snapshot.bindingCount) : 0,
      changed: false,
      importedAt: snapshot ? cleanString(snapshot.importedAt) : '',
      sourceExportedAt: snapshot ? cleanString(snapshot.sourceExportedAt) : '',
      blockers: [],
      warnings: [],
      readOnlyProjection: true,
      noChromeDestructiveBindingApply: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true
    };
    if (!snapshot) {
      result.ok = false;
      result.status = 'desktop-canonical-chat-folder-bindings-missing';
      result.blockers.push('desktop-canonical-chat-folder-bindings-missing');
      return result;
    }
    var current = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var existing = normalizeDesktopCanonicalChatFolderBindingSnapshot(current.desktopCanonicalChatFolderBindings);
    result.changed = JSON.stringify(safeObject(existing)) !== JSON.stringify(safeObject(snapshot));
    if (result.changed) {
      var next = cloneJson(current) || {};
      next.desktopCanonicalChatFolderBindings = snapshot;
      next.updatedAt = nowIso();
      await writeKv(FOLDER_STATE_KEY_LOCAL, next);
    }
    state.desktopCanonicalChatFolderBindings = snapshot;
    return result;
  }

  function safeMetadataHash(value) {
    var text = cleanString(value);
    if (!text) return '';
    if (!/^[a-z0-9][a-z0-9:._-]{3,180}$/i.test(text)) return '';
    return text;
  }

  function safeMetadataCode(value, fallback) {
    var text = cleanString(value);
    if (!/^[a-z0-9][a-z0-9:._-]{1,120}$/i.test(text)) return fallback || '';
    return text;
  }

  function sanitizeMetadataCatalogRows(rows, expectedKind) {
    var out = [];
    var seen = Object.create(null);
    var source = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < source.length; i += 1) {
      var row = source[i] && typeof source[i] === 'object' && !Array.isArray(source[i]) ? source[i] : null;
      if (!row) continue;
      var subjectHash = safeMetadataHash(row.subjectHash);
      if (!subjectHash || seen[subjectHash]) continue;
      seen[subjectHash] = true;
      out.push({
        subjectType: 'library.catalog',
        catalogKind: expectedKind,
        subjectHash: subjectHash,
        nameHash: safeMetadataHash(row.nameHash),
        colorHash: safeMetadataHash(row.colorHash),
        sourceHash: safeMetadataHash(row.sourceHash),
        parentHash: safeMetadataHash(row.parentHash),
        hasName: row.hasName === true,
        hasColor: row.hasColor === true,
        hasParent: row.hasParent === true,
        autoDerived: row.autoDerived === true,
        hasMetadata: row.hasMetadata === true
      });
    }
    out.sort(function (a, b) {
      return cleanString(a.subjectHash).localeCompare(cleanString(b.subjectHash));
    });
    return out;
  }

  function sanitizeMetadataBindingRows(rows, expectedKind) {
    var out = [];
    var seen = Object.create(null);
    var source = Array.isArray(rows) ? rows : [];
    for (var i = 0; i < source.length; i += 1) {
      var row = source[i] && typeof source[i] === 'object' && !Array.isArray(source[i]) ? source[i] : null;
      if (!row) continue;
      var subjectHash = safeMetadataHash(row.subjectHash);
      var leftHash = safeMetadataHash(row.leftSubjectHash);
      var rightHash = safeMetadataHash(row.rightSubjectHash);
      if (!subjectHash || !leftHash || !rightHash || seen[subjectHash]) continue;
      seen[subjectHash] = true;
      out.push({
        subjectType: 'library.binding',
        bindingKind: expectedKind,
        subjectHash: subjectHash,
        leftSubjectType: safeMetadataCode(row.leftSubjectType, 'chat.metadata'),
        leftSubjectHash: leftHash,
        rightSubjectType: safeMetadataCode(row.rightSubjectType, 'library.catalog'),
        rightSubjectHash: rightHash
      });
    }
    out.sort(function (a, b) {
      return cleanString(a.subjectHash).localeCompare(cleanString(b.subjectHash));
    });
    return out;
  }

  function normalizeDesktopCanonicalLibraryMetadataSnapshot(value) {
    var input = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!input) return null;
    if (cleanString(input.schema) && cleanString(input.schema) !== DESKTOP_CANONICAL_LIBRARY_METADATA_SCHEMA) return null;
    var counts = safeObject(input.counts);
    var hashes = safeObject(input.hashes);
    var catalogs = safeObject(input.catalogs);
    var bindings = safeObject(input.bindings);
    var labelCatalog = sanitizeMetadataCatalogRows(catalogs.labels, 'label');
    var tagCatalog = sanitizeMetadataCatalogRows(catalogs.tags, 'tag');
    var categoryCatalog = sanitizeMetadataCatalogRows(catalogs.categories, 'category');
    var chatLabels = sanitizeMetadataBindingRows(bindings.chatLabels, 'chat-label');
    var chatTags = sanitizeMetadataBindingRows(bindings.chatTags, 'chat-tag');
    var chatCategories = sanitizeMetadataBindingRows(bindings.chatCategories, 'chat-category');
    return {
      schema: DESKTOP_CANONICAL_LIBRARY_METADATA_SCHEMA,
      version: cleanString(input.version || '0.1.0-phase2'),
      phase: cleanString(input.phase || 'phase2-desktop-canonical-export'),
      source: 'desktop-canonical-library-metadata',
      status: cleanString(input.status || 'imported'),
      importedAt: cleanString(input.importedAt),
      sourceExportedAt: cleanString(input.sourceExportedAt || input.exportedAt),
      available: true,
      displaySourceName: 'desktopCanonicalLibraryMetadata',
      displayMode: 'hash-count-read-model',
      uiDisplayNamesAvailable: false,
      uiDisplayDeferred: true,
      counts: {
        labelCatalogCount: numberOrZero(counts.labelCatalogCount || labelCatalog.length),
        tagCatalogCount: numberOrZero(counts.tagCatalogCount || tagCatalog.length),
        categoryCatalogCount: numberOrZero(counts.categoryCatalogCount || categoryCatalog.length),
        chatStoreRowCount: numberOrZero(counts.chatStoreRowCount),
        chatLabelBindingCount: numberOrZero(counts.chatLabelBindingCount || chatLabels.length),
        chatTagBindingCount: numberOrZero(counts.chatTagBindingCount || chatTags.length),
        chatCategoryAssignmentCount: numberOrZero(counts.chatCategoryAssignmentCount || chatCategories.length),
        classificationSignalCount: numberOrZero(counts.classificationSignalCount || chatCategories.length)
      },
      hashes: {
        labels: safeMetadataHash(hashes.labels),
        tags: safeMetadataHash(hashes.tags),
        categories: safeMetadataHash(hashes.categories),
        chatLabelBindings: safeMetadataHash(hashes.chatLabelBindings),
        chatTagBindings: safeMetadataHash(hashes.chatTagBindings),
        chatCategoryAssignments: safeMetadataHash(hashes.chatCategoryAssignments),
        projection: safeMetadataHash(hashes.projection)
      },
      catalogs: {
        labels: labelCatalog,
        tags: tagCatalog,
        categories: categoryCatalog
      },
      bindings: {
        chatLabels: chatLabels,
        chatTags: chatTags,
        chatCategories: chatCategories
      },
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
        accountLinkedMetadata: false
      },
      sideEffectSummary: {
        readOnly: true,
        storageWrites: false,
        sqliteWrites: false,
        chromeStorageWrites: false,
        importInvoked: false,
        exportInvoked: false,
        syncNowInvoked: false,
        applyExecuted: false,
        desktopApply: false,
        chromeRequestExport: false,
        canonicalMutation: false,
        deletes: false
      },
      diagnostics: {
        ok: true,
        productSyncReady: false,
        phase3ChromeImportDisplayReady: true,
        readOnlyMirror: true,
        chromeRequestExportImplemented: false,
        desktopApplyImplemented: false,
        warnings: [],
        blockers: []
      },
      desktopAuthority: true,
      chromeAuthority: false,
      readOnlyProjection: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true
    };
  }

  function buildDesktopCanonicalLibraryMetadataSnapshot(bundle, importedAt) {
    var payload = safeObject(bundle && bundle.desktopCanonicalLibraryMetadata);
    if (!payload || !Object.keys(payload).length) return null;
    return normalizeDesktopCanonicalLibraryMetadataSnapshot(Object.assign({}, payload, {
      status: 'imported',
      importedAt: cleanString(importedAt) || nowIso(),
      sourceExportedAt: cleanString(bundle && bundle.exportedAt)
    }));
  }

  function summarizeDesktopCanonicalLibraryMetadata(snapshotInput) {
    var snapshot = normalizeDesktopCanonicalLibraryMetadataSnapshot(snapshotInput);
    return {
      schema: DESKTOP_CANONICAL_LIBRARY_METADATA_SCHEMA + '.chrome-import.v1',
      phase: 'phase3-chrome-import-display',
      attempted: true,
      ok: !!snapshot,
      status: snapshot ? 'desktop-canonical-library-metadata-imported' : 'desktop-canonical-library-metadata-missing',
      available: !!snapshot,
      section: 'desktopCanonicalLibraryMetadata',
      sourceName: 'desktopCanonicalLibraryMetadata',
      displayMode: 'hash-count-read-model',
      labelCatalogCount: snapshot ? numberOrZero(snapshot.counts.labelCatalogCount) : 0,
      tagCatalogCount: snapshot ? numberOrZero(snapshot.counts.tagCatalogCount) : 0,
      categoryCatalogCount: snapshot ? numberOrZero(snapshot.counts.categoryCatalogCount) : 0,
      chatCategoryAssignmentCount: snapshot ? numberOrZero(snapshot.counts.chatCategoryAssignmentCount) : 0,
      classificationSignalCount: snapshot ? numberOrZero(snapshot.counts.classificationSignalCount) : 0,
      projectionHash: snapshot ? cleanString(snapshot.hashes.projection) : '',
      importedAt: snapshot ? cleanString(snapshot.importedAt) : '',
      sourceExportedAt: snapshot ? cleanString(snapshot.sourceExportedAt) : '',
      changed: false,
      blockers: snapshot ? [] : ['desktop-canonical-library-metadata-missing'],
      warnings: [],
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
        accountLinkedMetadata: false
      },
      readOnlyProjection: true,
      desktopAuthority: true,
      chromeAuthority: false,
      chromeRequestExport: false,
      desktopApply: false,
      canonicalMutation: false,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true
    };
  }

  async function storeDesktopCanonicalLibraryMetadataSnapshot(snapshotInput) {
    var snapshot = normalizeDesktopCanonicalLibraryMetadataSnapshot(snapshotInput);
    var result = summarizeDesktopCanonicalLibraryMetadata(snapshot);
    if (!snapshot) return result;
    var current = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var existing = normalizeDesktopCanonicalLibraryMetadataSnapshot(current.desktopCanonicalLibraryMetadata);
    result.changed = JSON.stringify(safeObject(existing)) !== JSON.stringify(safeObject(snapshot));
    if (result.changed) {
      var next = cloneJson(current) || {};
      next.desktopCanonicalLibraryMetadata = snapshot;
      next.updatedAt = nowIso();
      await writeKv(FOLDER_STATE_KEY_LOCAL, next);
    }
    state.desktopCanonicalLibraryMetadata = snapshot;
    return result;
  }

  function normalizeDesktopPurgedFolderSuppressionSnapshot(value) {
    var input = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    if (!input) return null;
    var rows = Array.isArray(input.rows) ? input.rows : [];
    var safeRows = [];
    var ids = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] && typeof rows[i] === 'object' && !Array.isArray(rows[i]) ? rows[i] : null;
      var id = normalizeFolderRecordId(row && (row.folderId || row.id));
      if (!row || !id || ids.indexOf(id) !== -1) continue;
      ids.push(id);
      safeRows.push({
        schema: 'h2o.studio.folder-purge-suppression.desktop.v1.row',
        folderId: id,
        id: id,
        folderName: cleanString(row.folderName || row.name || row.title || id),
        name: cleanString(row.name || row.folderName || row.title || id),
        purgedAt: cleanString(row.purgedAt || row.deletedAt || row.hiddenAt),
        purgeReason: cleanString(row.purgeReason || row.deleteReason || row.reason),
        purgeSource: cleanString(row.purgeSource || row.source || 'desktop-purged-folder-suppression'),
        purgeTombstoneId: cleanString(row.purgeTombstoneId || row.tombstoneId),
        phase6aPermanentlyPurged: true,
        permanentlySuppressed: true,
        source: 'desktop-purged-folder-suppression',
        sourceKind: 'desktop-purged-folder-suppression',
        status: 'purged',
        desktopAuthority: true,
        chromeAuthority: false,
        noChromePurgeAuthority: true,
        noChromeTombstoneApply: true,
        noChromeTombstoneCreate: true,
        noHardDelete: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true
      });
    }
    ids.sort();
    safeRows.sort(function (a, b) {
      return cleanString(b.purgedAt).localeCompare(cleanString(a.purgedAt)) ||
        cleanString(a.folderName).localeCompare(cleanString(b.folderName));
    });
    return {
      schema: 'h2o.studio.folder-purge-suppression.desktop.v1',
      source: cleanString(input.source || 'desktop-purged-folder-suppression'),
      status: cleanString(input.status || 'imported'),
      importedAt: cleanString(input.importedAt),
      sourceExportedAt: cleanString(input.sourceExportedAt),
      desktopPurgedFolderSuppressionFolderIds: ids,
      desktopPurgedFolderSuppressionCount: ids.length,
      folderIds: ids,
      rows: safeRows,
      desktopAuthority: true,
      chromeAuthority: false,
      noChromePurgeAuthority: true,
      noChromeTombstoneApply: true,
      noChromeTombstoneCreate: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true
    };
  }

  function buildDesktopPurgedFolderSuppressionSnapshot(bundle, importedAt) {
    var payload = safeObject(bundle && bundle.desktopPurgedFolderSuppression);
    var rows = Array.isArray(payload.rows)
      ? payload.rows
      : (Array.isArray(bundle && bundle.desktopPurgedFolderSuppressions)
        ? bundle.desktopPurgedFolderSuppressions
        : null);
    if (!rows) return null;
    return normalizeDesktopPurgedFolderSuppressionSnapshot({
      source: 'desktop-purged-folder-suppression',
      status: 'imported',
      importedAt: cleanString(importedAt) || nowIso(),
      sourceExportedAt: cleanString(bundle && bundle.exportedAt),
      rows: rows
    });
  }

  async function storeDesktopPurgedFolderSuppressionSnapshot(snapshotInput) {
    var snapshot = normalizeDesktopPurgedFolderSuppressionSnapshot(snapshotInput);
    var ids = snapshot && Array.isArray(snapshot.desktopPurgedFolderSuppressionFolderIds)
      ? snapshot.desktopPurgedFolderSuppressionFolderIds.slice()
      : [];
    var idSet = {};
    ids.forEach(function (id) { if (id) idSet[id] = true; });
    var result = {
      schema: 'h2o.studio.folder-purge-suppression.chrome-import.v1',
      phase: 'phase6b.6',
      attempted: true,
      ok: true,
      status: 'desktop-purged-folder-suppression-imported',
      desktopPurgedFolderSuppressionCount: ids.length,
      purgedSuppressedFolderIds: ids,
      changed: false,
      clearedDesktopReceiptRowCount: 0,
      clearedPendingDeleteRowCount: 0,
      clearedFolderRowCount: 0,
      importedAt: snapshot ? cleanString(snapshot.importedAt) : '',
      sourceExportedAt: snapshot ? cleanString(snapshot.sourceExportedAt) : '',
      blockers: [],
      warnings: [],
      noChromePurgeAuthority: true,
      noChromeTombstoneApply: true,
      noTombstoneCreateOnChrome: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true
    };
    if (!snapshot) {
      result.ok = false;
      result.status = 'desktop-purged-folder-suppression-missing';
      result.blockers.push('desktop-purged-folder-suppression-missing');
      return result;
    }
    var current = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var existing = normalizeDesktopPurgedFolderSuppressionSnapshot(current.desktopPurgedFolderSuppression);
    var next = cloneJson(current) || {};
    var desktopReceipt = Object.assign({}, safeObject(next.hiddenByDesktopReceipt));
    var pendingDelete = Object.assign({}, safeObject(next.hiddenByChromePendingDelete));
    ids.forEach(function (folderId) {
      if (desktopReceipt[folderId]) {
        delete desktopReceipt[folderId];
        result.clearedDesktopReceiptRowCount += 1;
      }
      if (pendingDelete[folderId]) {
        delete pendingDelete[folderId];
        result.clearedPendingDeleteRowCount += 1;
      }
    });
    var rows = Array.isArray(next.folders) ? next.folders : [];
    if (rows.length) {
      next.folders = rows.filter(function (row) {
        var id = normalizeFolderRecordId(folderMetadataRowId(row));
        if (id && idSet[id]) {
          result.clearedFolderRowCount += 1;
          return false;
        }
        return true;
      });
    }
    if (next.items && typeof next.items === 'object' && !Array.isArray(next.items)) {
      var nextItems = Object.assign({}, next.items);
      ids.forEach(function (folderId) { delete nextItems[folderId]; });
      next.items = nextItems;
    }
    var canonicalSnapshotChanged = false;
    var canonical = normalizeDesktopCanonicalRecentlyDeletedSnapshot(next.desktopCanonicalRecentlyDeleted);
    if (canonical && Array.isArray(canonical.rows)) {
      var canonicalRows = canonical.rows.filter(function (row) {
        var folderId = normalizeFolderRecordId(row && (row.folderId || row.id));
        return !folderId || !idSet[folderId];
      });
      if (canonicalRows.length !== canonical.rows.length) {
        next.desktopCanonicalRecentlyDeleted = normalizeDesktopCanonicalRecentlyDeletedSnapshot(Object.assign({}, canonical, { rows: canonicalRows }));
        state.desktopCanonicalRecentlyDeleted = next.desktopCanonicalRecentlyDeleted;
        canonicalSnapshotChanged = true;
      }
    }
    next.hiddenByDesktopReceipt = desktopReceipt;
    next.hiddenByChromePendingDelete = pendingDelete;
    next.desktopPurgedFolderSuppression = snapshot;
    next.updatedAt = nowIso();
    result.changed = JSON.stringify(safeObject(existing)) !== JSON.stringify(safeObject(snapshot)) ||
      result.clearedDesktopReceiptRowCount > 0 ||
      result.clearedPendingDeleteRowCount > 0 ||
      result.clearedFolderRowCount > 0 ||
      canonicalSnapshotChanged === true;
    if (result.changed) await writeKv(FOLDER_STATE_KEY_LOCAL, next);
    state.desktopPurgedFolderSuppression = snapshot;
    return result;
  }

  function makeDesktopVisibleSetHideResult() {
    return {
      schema: 'h2o.studio.folder-visible-set.desktop-hide.v1',
      phase: 'phase5a.2',
      attempted: true,
      ok: true,
      status: 'desktop-visible-set-hide-applied',
      hiddenByDesktopVisibleSetCount: 0,
      reShownByDesktopVisibleSetCount: 0,
      skippedProtectedCount: 0,
      skippedPendingChromeCreatedCount: 0,
      hiddenByDesktopVisibleSetRows: [],
      reShownByDesktopVisibleSetRows: [],
      warnings: [],
      blockers: [],
      visibleStateOnlyHide: true,
      noTombstoneApplyOnChrome: true,
      noTombstoneCreateOnChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true
    };
  }

  async function applyDesktopVisibleSetHideOverlay(snapshotInput) {
    var snapshot = normalizeDesktopVisibleFolderSetSnapshot(snapshotInput);
    var result = makeDesktopVisibleSetHideResult();
    if (!snapshot) {
      result.ok = false;
      result.status = 'desktop-visible-set-missing';
      result.blockers.push('desktop-visible-set-missing');
      return result;
    }
    var desktopIds = Object.create(null);
    var ids = Array.isArray(snapshot.desktopVisibleFolderIds) ? snapshot.desktopVisibleFolderIds : [];
    for (var i = 0; i < ids.length; i += 1) {
      var id = normalizeFolderRecordId(ids[i]);
      if (id) desktopIds[id] = true;
    }
    var current = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var existingSnapshot = normalizeDesktopVisibleFolderSetSnapshot(current.desktopVisibleFolderSet);
    var snapshotChanged = JSON.stringify(safeObject(existingSnapshot)) !== JSON.stringify(safeObject(snapshot));
    var rows = Array.isArray(current.folders) ? current.folders : [];
    var hiddenBag = Object.assign({}, safeObject(current.hiddenByDesktopVisibleSet));
    var now = nowIso();
    var changed = false;
    var nextRows = rows.map(function (row) {
      var folderId = normalizeFolderRecordId(folderMetadataRowId(row));
      if (!folderId) return row;
      var hasDesktopVisibleRow = desktopIds[folderId] === true;
      var marker = safeObject(hiddenBag[folderId]);
      if (hasDesktopVisibleRow) {
        if (marker.hiddenByDesktopVisibleSet === true || row.hiddenByDesktopVisibleSet === true || safeObject(row.meta).hiddenByDesktopVisibleSet === true) {
          var restoredRow = Object.assign({}, row, {
            hidden: false,
            hiddenByDesktopVisibleSet: false,
            reShownByDesktopVisibleSetAt: now,
            updatedAt: cleanString(row.updatedAt || row.updated_at || now),
            meta: Object.assign({}, safeObject(row.meta), {
              hidden: false,
              hiddenByDesktopVisibleSet: false,
              reShownByDesktopVisibleSetAt: now
            })
          });
          delete hiddenBag[folderId];
          result.reShownByDesktopVisibleSetCount += 1;
          result.reShownByDesktopVisibleSetRows.push(summarizeVisibleParityFolder(restoredRow, {
            reShownByDesktopVisibleSet: true
          }));
          changed = true;
          return restoredRow;
        }
        return row;
      }
      if (!isFolderVisibleForParity(row)) return row;
      if (isProtectedFolderForVisibleParity(row)) {
        result.skippedProtectedCount += 1;
        return row;
      }
      if (isPendingChromeCreatedForVisibleParity(row, snapshot)) {
        result.skippedPendingChromeCreatedCount += 1;
        return row;
      }
      var hiddenRow = Object.assign({}, row, {
        hidden: true,
        hiddenByDesktopVisibleSet: true,
        desktopVisibleSetMissing: true,
        hiddenByDesktopVisibleSetAt: now,
        desktopVisibleSetImportedAt: cleanString(snapshot.importedAt),
        desktopVisibleSetSourceExportedAt: cleanString(snapshot.sourceExportedAt),
        meta: Object.assign({}, safeObject(row.meta), {
          hidden: true,
          hiddenByDesktopVisibleSet: true,
          desktopVisibleSetMissing: true,
          hiddenByDesktopVisibleSetAt: now,
          desktopVisibleSetImportedAt: cleanString(snapshot.importedAt),
          desktopVisibleSetSourceExportedAt: cleanString(snapshot.sourceExportedAt),
          visibleStateOnlyHide: true,
          noTombstoneApply: true,
          noTombstoneCreate: true,
          noHardDelete: true,
          noPurge: true,
          noChatDelete: true,
          noSnapshotDelete: true
        })
      });
      hiddenBag[folderId] = Object.assign({}, marker, summarizeVisibleParityFolder(row, {
        hiddenByDesktopVisibleSet: true,
        desktopVisibleSetMissing: true,
        hiddenAt: now,
        desktopVisibleSetImportedAt: cleanString(snapshot.importedAt),
        desktopVisibleSetSourceExportedAt: cleanString(snapshot.sourceExportedAt),
        visibleStateOnlyHide: true,
        noTombstoneApply: true,
        noTombstoneCreate: true,
        noHardDelete: true,
        noPurge: true,
        noChatDelete: true,
        noSnapshotDelete: true
      }));
      result.hiddenByDesktopVisibleSetCount += 1;
      result.hiddenByDesktopVisibleSetRows.push(summarizeVisibleParityFolder(hiddenRow, {
        hiddenByDesktopVisibleSet: true,
        desktopVisibleSetMissing: true
      }));
      changed = true;
      return hiddenRow;
    });
    result.hiddenByDesktopVisibleSetRows = result.hiddenByDesktopVisibleSetRows.slice(0, 80);
    result.reShownByDesktopVisibleSetRows = result.reShownByDesktopVisibleSetRows.slice(0, 80);
    if (changed || snapshotChanged) {
      var next = Object.assign({}, current, {
        folders: nextRows,
        hiddenByDesktopVisibleSet: hiddenBag,
        desktopVisibleFolderSet: snapshot,
        updatedAt: now
      });
      await writeKv(FOLDER_STATE_KEY_LOCAL, next);
    }
    result.desktopVisibleSetStored = true;
    result.writesPerformed = (changed || snapshotChanged) ? 1 : 0;
    return result;
  }

  function mergeDesktopVisibleSetHideSummary(metadataSummary, hideResult) {
    var summary = Object.assign({}, safeObject(metadataSummary));
    var hide = safeObject(hideResult);
    var changedFolderIds = Array.isArray(summary.changedFolderIds) ? summary.changedFolderIds.slice() : [];
    var changedFields = Array.isArray(summary.changedFields) ? summary.changedFields.slice() : [];
    var rows = []
      .concat(Array.isArray(hide.hiddenByDesktopVisibleSetRows) ? hide.hiddenByDesktopVisibleSetRows : [])
      .concat(Array.isArray(hide.reShownByDesktopVisibleSetRows) ? hide.reShownByDesktopVisibleSetRows : []);
    rows.forEach(function (row) { addUniqueFolderId(changedFolderIds, row && row.folderId); });
    if (numberOrZero(hide.hiddenByDesktopVisibleSetCount) > 0) addUnique(changedFields, 'desktop-visible-set-hide');
    if (numberOrZero(hide.reShownByDesktopVisibleSetCount) > 0) addUnique(changedFields, 'desktop-visible-set-reshow');
    summary.changedFolderIds = changedFolderIds;
    summary.changedFields = changedFields;
    summary.changedFolderCount = changedFolderIds.length || numberOrZero(summary.changedFolderCount);
    if (numberOrZero(hide.hiddenByDesktopVisibleSetCount) > 0 || numberOrZero(hide.reShownByDesktopVisibleSetCount) > 0) {
      summary.hasDesktopVisibleSetOverlay = true;
      summary.hasOnlyVisualUpdates = false;
    }
    return summary;
  }

  async function readLatestBundleForVisibleParityDiagnostics() {
    if (!state.handle) {
      return {
        ok: false,
        status: 'sync-folder-not-connected',
        blockers: [F19_SYNC_HARDENING_CODES.syncFolderMissing],
        path: LATEST_FILE
      };
    }
    var permission = await queryPermission(state.handle);
    if (permission !== 'granted') {
      return {
        ok: false,
        status: 'sync-folder-reconnect-required',
        permission: permission,
        blockers: [F19_SYNC_HARDENING_CODES.permissionDenied],
        path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE
      };
    }
    try {
      var fileHandle = await state.handle.getFileHandle(LATEST_FILE, { create: false });
      var file = await fileHandle.getFile();
      var text = await file.text();
      var bundle = JSON.parse(text);
      return {
        ok: true,
        status: 'latest-json-read',
        permission: permission,
        path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
        fileLastModified: numberOrZero(file.lastModified),
        fileSize: numberOrZero(file.size),
        exportedAt: cleanString(bundle && bundle.exportedAt),
        bundle: bundle
      };
    } catch (error) {
      return {
        ok: false,
        status: 'latest-json-read-failed',
        permission: permission,
        blockers: ['latest-json-read-failed'],
        path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
        error: cleanString(error && (error.message || error)).slice(0, 240)
      };
    }
  }

  async function diagnoseVisibleFolderParity(options) {
    var opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    var blockers = [];
    var warnings = [];
    var latest = await readLatestBundleForVisibleParityDiagnostics();
    if (!latest.ok) {
      return {
        ok: false,
        status: 'visible-folder-parity-diagnostic-blocked',
        phase: PHASE,
        mode: MODE,
        readOnly: true,
        blockers: Array.isArray(latest.blockers) ? latest.blockers.slice() : [latest.status],
        warnings: warnings,
        desktopLatestStatus: latest.status,
        desktopLatestPath: cleanString(latest.path),
        noTombstoneApplyOnChrome: true,
        noTombstoneCreateOnChrome: true,
        noHardDelete: true,
        noPurge: true,
        noChatDelete: true,
        noSnapshotDelete: true
      };
    }
    var bundle = latest.bundle;
    var latestSnapshot = buildDesktopVisibleFolderSetSnapshot(bundle, '');
    var storedSnapshot = normalizeDesktopVisibleFolderSetSnapshot(state.desktopVisibleFolderSet);
    var desktopSnapshot = storedSnapshot || latestSnapshot;
    var desktopVisibleMap = visibleParityRowMap(desktopSnapshot && desktopSnapshot.rows);
    var desktopIds = Object.keys(desktopVisibleMap).sort();
    var localMirrorForOverlay = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var hiddenByDesktopVisibleSetBag = safeObject(localMirrorForOverlay.hiddenByDesktopVisibleSet);
    var hiddenByDesktopVisibleSetRows = Object.keys(hiddenByDesktopVisibleSetBag).sort().map(function (folderId) {
      return summarizeVisibleParityFolder(Object.assign({ folderId: folderId, id: folderId }, safeObject(hiddenByDesktopVisibleSetBag[folderId])), {
        hiddenByDesktopVisibleSet: true,
        desktopVisibleSetMissing: true
      });
    });
    var provider = H2O && H2O.Library && H2O.Library.FolderParity;
    var model = provider && typeof provider.getDisplayModel === 'function'
      ? await provider.getDisplayModel({ fresh: opts.fresh !== false, reason: cleanString(opts.reason) || 'phase5a0-visible-folder-parity' })
      : null;
    var canonicalRows = Array.isArray(model && model.canonicalRows) ? model.canonicalRows : [];
    var chromeVisibleMap = visibleParityRowMap(canonicalRows);
    var chromeIds = Object.keys(chromeVisibleMap).sort();
    var chromeOnly = [];
    var desktopOnly = [];
    var protectedRows = [];
    var pendingChromeCreatedRows = [];
    var candidateStaleRows = [];
    for (var c = 0; c < chromeIds.length; c += 1) {
      var chromeId = chromeIds[c];
      var chromeRow = chromeVisibleMap[chromeId];
      var protectedRow = isProtectedFolderForVisibleParity(chromeRow);
      if (protectedRow) protectedRows.push(summarizeVisibleParityFolder(chromeRow, { reason: 'protected-system-folder' }));
      if (desktopVisibleMap[chromeId]) continue;
      var pendingChromeCreated = isPendingChromeCreatedForVisibleParity(chromeRow, desktopSnapshot || { sourceExportedAt: latest.exportedAt });
      var summary = summarizeVisibleParityFolder(chromeRow, {
        protected: protectedRow,
        pendingChromeCreated: pendingChromeCreated,
        candidateStale: !protectedRow && !pendingChromeCreated,
        smokeDeleteRestoreCandidate: folderMetadataRowName(chromeRow).indexOf('zz-4d4-delete-restore') === 0
      });
      if (pendingChromeCreated) pendingChromeCreatedRows.push(summary);
      if (!protectedRow && !pendingChromeCreated) candidateStaleRows.push(summary);
      if (!protectedRow) chromeOnly.push(summary);
    }
    for (var d = 0; d < desktopIds.length; d += 1) {
      var desktopId = desktopIds[d];
      if (!chromeVisibleMap[desktopId]) {
        desktopOnly.push(summarizeVisibleParityFolder(desktopVisibleMap[desktopId], {
          missingFromChromeVisibleModel: true
        }));
      }
    }
    var deleteImport = state.lastFolderDeleteReceiptImport || {};
    var restoreImport = state.lastFolderRestoreReceiptImport || {};
    var hiddenByDeleteReceiptCount = numberOrZero(deleteImport.hiddenCount || deleteImport.reconciledHideCount || deleteImport.appliedCount);
    var reShownByRestoreReceiptCount = numberOrZero(restoreImport.reShownCount || restoreImport.alreadyVisibleCount);
    return {
      ok: true,
      status: 'visible-folder-parity-diagnosed',
      phase: PHASE,
      mode: MODE,
      readOnly: true,
      source: 'desktop-latest-json-vs-chrome-folder-parity-display-model',
      desktopVisibleSetStored: !!storedSnapshot,
      desktopVisibleSetImportedAt: cleanString(desktopSnapshot && desktopSnapshot.importedAt),
      desktopVisibleSetSource: cleanString(desktopSnapshot && desktopSnapshot.source),
      desktopVisibleSetStatus: cleanString(desktopSnapshot && desktopSnapshot.status),
      desktopVisibleSetSourceExportedAt: cleanString(desktopSnapshot && desktopSnapshot.sourceExportedAt),
      desktopLatestPath: latest.path,
      desktopLatestExportedAt: latest.exportedAt,
      desktopLatestFileLastModified: latest.fileLastModified,
      desktopLatestFileSize: latest.fileSize,
      desktopVisibleSourceKind: cleanString(desktopSnapshot && desktopSnapshot.sourceKind),
      desktopLatestVisibleFolderCount: Number(latestSnapshot && latestSnapshot.desktopVisibleFolderCount) || 0,
      desktopVisibleFolderCount: Number(desktopSnapshot && desktopSnapshot.desktopVisibleFolderCount) || desktopIds.length,
      desktopVisibleFolderIds: Array.isArray(desktopSnapshot && desktopSnapshot.desktopVisibleFolderIds)
        ? desktopSnapshot.desktopVisibleFolderIds.slice()
        : desktopIds,
      chromeVisibleFolderCount: chromeIds.length,
      chromeOnlyVisibleFolderCount: chromeOnly.length,
      desktopOnlyVisibleFolderCount: desktopOnly.length,
      chromeOnlyVisibleFolders: chromeOnly,
      desktopOnlyVisibleFolders: desktopOnly,
      importedDesktopVisibleFolderCount: numberOrZero(model && model.importedDesktopVisibleFolderCount),
      importedDesktopVisibleFolders: Array.isArray(model && model.importedDesktopVisibleFolders)
        ? model.importedDesktopVisibleFolders.slice(0, 80)
        : [],
      candidateStaleFolderCount: candidateStaleRows.length,
      candidateStaleRows: candidateStaleRows,
      hiddenByDeleteReceiptCount: hiddenByDeleteReceiptCount,
      reShownByRestoreReceiptCount: reShownByRestoreReceiptCount,
      hiddenByDesktopVisibleSetCount: hiddenByDesktopVisibleSetRows.length,
      hiddenByDesktopVisibleSetRows: hiddenByDesktopVisibleSetRows,
      pendingChromeCreatedCount: pendingChromeCreatedRows.length,
      pendingChromeCreatedRows: pendingChromeCreatedRows,
      protectedFolderCount: protectedRows.length,
      protectedFolders: protectedRows,
      displayModelAvailable: !!(model && model.displayModelAvailable),
      canonicalSource: cleanString(model && model.canonicalSource),
      canonicalFolderCount: Number(model && model.canonicalFolderCount) || canonicalRows.length,
      hiddenLocalOnlyCount: Number(model && model.hiddenLocalOnlyCount) || 0,
      hiddenDynamicNativeOnlyCount: Number(model && model.hiddenDynamicNativeOnlyCount) || 0,
      folderDeleteReceiptImport: state.lastFolderDeleteReceiptImport || null,
      folderRestoreReceiptImport: state.lastFolderRestoreReceiptImport || null,
      chatFolderBindingReceiptImport: state.lastChatFolderBindingReceiptImport || null,
      blockers: blockers,
      warnings: warnings,
      noTombstoneApplyOnChrome: true,
      noTombstoneCreateOnChrome: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true
    };
  }

  async function analyzeFolderMetadataAutoConflict(bundle) {
    var incoming = folderMetadataRowsFromBundle(bundle);
    if (!incoming.rows.length) {
      return { safe: false, reason: 'folder-metadata-source-missing', changedFolderCount: 0, changedFields: [] };
    }
    var localState = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var localRows = Array.isArray(localState.folders) ? localState.folders : [];
    var localById = Object.create(null);
    for (var l = 0; l < localRows.length; l += 1) {
      var localId = folderMetadataRowId(localRows[l]);
      if (localId) localById[localId] = localRows[l];
    }
    var changed = [];
    var localNewer = [];
    var changedFields = [];
    for (var i = 0; i < incoming.rows.length; i += 1) {
      var row = incoming.rows[i];
      var folderId = folderMetadataRowId(row);
      if (!folderId) continue;
      var local = localById[folderId] || null;
      var fields = [];
      if (!local) {
        fields.push('create');
      } else {
        if (folderMetadataRowName(row) !== folderMetadataRowName(local)) fields.push('name');
        if (folderMetadataRowColor(row) !== folderMetadataRowColor(local)) fields.push('color');
      }
      if (!fields.length) continue;
      fields.forEach(function (field) { addUnique(changedFields, field); });
      var incomingMs = folderMetadataRowTimestampMs(row);
      var localMs = folderMetadataRowTimestampMs(local);
      if (local && localMs && incomingMs && localMs > incomingMs) {
        localNewer.push({ folderId: folderId, fields: fields.slice(), localUpdatedAtMs: localMs, incomingUpdatedAtMs: incomingMs });
      } else if (local && localMs && !incomingMs) {
        localNewer.push({ folderId: folderId, fields: fields.slice(), localUpdatedAtMs: localMs, incomingUpdatedAtMs: 0 });
      }
      changed.push({ folderId: folderId, fields: fields.slice(), incomingUpdatedAtMs: incomingMs, localUpdatedAtMs: localMs });
    }
    if (!changed.length) {
      return {
        safe: true,
        reason: 'folder-metadata-no-field-difference',
        sourceKind: incoming.sourceKind,
        changedFolderCount: 0,
        changedFields: []
      };
    }
    if (localNewer.length) {
      return {
        safe: false,
        reason: 'same-field-newer-local-folder-metadata',
        sourceKind: incoming.sourceKind,
        changedFolderCount: changed.length,
        changedFields: changedFields,
        localNewer: localNewer.slice(0, 8)
      };
    }
    return {
      safe: true,
      reason: 'safe-folder-metadata-field-merge',
      sourceKind: incoming.sourceKind,
      changedFolderCount: changed.length,
      changedFields: changedFields,
      changed: changed.slice(0, 8)
    };
  }

  async function resolveAutoSyncTransportBlockers(bundle, blockers, options) {
    var resolved = resolveOperatorApprovedTransportBlockers(blockers, options);
    state.lastTransportConflictStatus = '';
    state.lastTransportConflictReason = '';
    state.lastTransportConflictDecision = resolved.conflictDecision;
    state.lastTransportConflictSummary = null;
    if (resolved.blockers.indexOf('library-propagation-simultaneous-update-conflict') === -1) {
      return resolved;
    }
    if (!options || options.autoSync !== true) {
      state.lastTransportConflictStatus = 'conflict-approval-required';
      state.lastTransportConflictReason = 'manual-or-non-auto-sync-simultaneous-conflict';
      state.lastTransportConflictDecision = 'conflict-approval-required';
      return Object.assign({}, resolved, {
        conflictDecision: 'conflict-approval-required',
        conflictApprovalRequired: true
      });
    }
    var analysis = await analyzeFolderMetadataAutoConflict(bundle);
    state.lastTransportConflictReason = cleanString(analysis.reason);
    state.lastTransportConflictSummary = cloneJson(analysis);
    if (!analysis.safe) {
      state.lastTransportConflictStatus = 'conflict-approval-required';
      state.lastTransportConflictDecision = 'conflict-approval-required';
      return Object.assign({}, resolved, {
        conflictDecision: 'conflict-approval-required',
        conflictApprovalRequired: true,
        autoFolderMetadataConflictAnalysis: analysis
      });
    }
    var autoApproved = resolveOperatorApprovedTransportBlockers(blockers, { conflictDecision: 'approve-merge' });
    state.lastTransportConflictStatus = 'auto-approved-folder-metadata';
    state.lastTransportConflictDecision = 'auto-approve-folder-metadata';
    return Object.assign({}, autoApproved, {
      conflictDecision: 'auto-approve-folder-metadata',
      conflictApproved: true,
      autoApproved: true,
      autoFolderMetadataConflictAnalysis: analysis
    });
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

  function countChatViews(chats) {
    var counts = { saved: 0, linked: 0, pinned: 0, archived: 0 };
    (Array.isArray(chats) ? chats : []).forEach(function (chat) {
      var index = chat && chat.chatIndex && typeof chat.chatIndex === 'object' ? chat.chatIndex : {};
      var stateObj = index.state && typeof index.state === 'object' ? index.state : {};
      var view = cleanString(index.view || index.kind || index.type).toLowerCase();
      var hasSnapshots = chatSnapshots(chat).length > 0;
      if (view === 'saved' || index.isSaved === true || stateObj.isSaved === true) counts.saved += 1;
      else if (view === 'linked' || index.isLinked === true || stateObj.isLinked === true) counts.linked += 1;
      else if (hasSnapshots) counts.saved += 1;
      if (index.pinned === true || index.isPinned === true || stateObj.isPinned === true) counts.pinned += 1;
      if (index.archived === true || index.isArchived === true || stateObj.isArchived === true) counts.archived += 1;
    });
    return counts;
  }

  function chatSnapshots(chat) {
    return Array.isArray(chat && chat.snapshots) ? chat.snapshots : [];
  }

  function chatIndexForRow(chat) {
    return chat && chat.chatIndex && typeof chat.chatIndex === 'object' && !Array.isArray(chat.chatIndex)
      ? chat.chatIndex
      : {};
  }

  function chatIndexState(chat) {
    var index = chatIndexForRow(chat);
    return index.state && typeof index.state === 'object' && !Array.isArray(index.state)
      ? index.state
      : {};
  }

  function desktopShellLinkTarget(chat, index) {
    return cleanString(index && (index.href || index.normalizedHref || index.linkSourceHref)) ||
      cleanString(chat && (chat.href || chat.normalizedHref || chat.linkSourceHref));
  }

  function isDesktopShellLibraryRow(chat) {
    var chatId = cleanString(chat && chat.chatId);
    if (!chatId || chatSnapshots(chat).length > 0) return false;
    var index = chatIndexForRow(chat);
    var stateObj = chatIndexState(chat);
    var view = cleanString(index.view || index.kind || index.type).toLowerCase();
    var hasLinkTarget = !!desktopShellLinkTarget(chat, index);
    return index.f19MinimalLibraryIndexRow === true ||
      index.f19ChromeDesktopMinimalRow === true ||
      view === 'saved' ||
      view === 'linked' ||
      view === 'imported' ||
      index.isSaved === true ||
      index.isLinked === true ||
      index.isImported === true ||
      stateObj.isSaved === true ||
      stateObj.isLinked === true ||
      stateObj.isImported === true ||
      stateObj.isPinned === true ||
      stateObj.isArchived === true ||
      hasLinkTarget;
  }

  function desktopShellRowSummary(chats) {
    var summary = { shellRowCount: 0, linkedOnlyCount: 0, savedShellCount: 0, importedShellCount: 0 };
    (Array.isArray(chats) ? chats : []).forEach(function (chat) {
      if (!isDesktopShellLibraryRow(chat)) return;
      summary.shellRowCount += 1;
      var index = chatIndexForRow(chat);
      var stateObj = chatIndexState(chat);
      var view = cleanString(index.view || index.kind || index.type).toLowerCase();
      var isSaved = view === 'saved' || index.isSaved === true || stateObj.isSaved === true;
      var isLinked = view === 'linked' || index.isLinked === true || stateObj.isLinked === true;
      var isImported = !isSaved && !isLinked &&
        (view === 'imported' || index.isImported === true || stateObj.isImported === true || !!desktopShellLinkTarget(chat, index));
      if (isLinked && !isSaved) summary.linkedOnlyCount += 1;
      if (isSaved) summary.savedShellCount += 1;
      if (isImported) summary.importedShellCount += 1;
    });
    return summary;
  }

  function sanitizeChatForDesktopChrome(chat, warnings) {
    var out = cloneJson(chat) || {};
    var chatIndex = out.chatIndex && typeof out.chatIndex === 'object' && !Array.isArray(out.chatIndex)
      ? out.chatIndex : null;
    if (chatIndex) {
      var org = chatIndex.organization && typeof chatIndex.organization === 'object' && !Array.isArray(chatIndex.organization)
        ? chatIndex.organization : null;
      if (org) {
        if (hasAnyKeys(org, ['labels', 'labelIds'])) addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.labels);
        if (hasAnyKeys(org, ['tags', 'tagIds'])) addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.tags);
        if (hasAnyKeys(org, ['projectId', 'projectIds', 'projects', 'gizmoId', 'workspaceId'])) {
          addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.projects);
        }
        if (hasAnyKeys(org, ['folderId', 'folderName', 'folder_id'])) {
          addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.folderBindings);
        }
        var nextOrg = {};
        if (typeof org.categoryId !== 'undefined') nextOrg.categoryId = org.categoryId;
        if (typeof org.category_id !== 'undefined') nextOrg.category_id = org.category_id;
        chatIndex.organization = nextOrg;
      }
    }
    return out;
  }

  function isStudioFolderActionSource(row) {
    var meta = row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
      ? row.meta : {};
    var values = [
      row && row.source,
      row && row.sourceKind,
      row && row.kind,
      meta.source,
      meta.sourceKind,
      meta.kind
    ].map(function (value) { return cleanString(value).toLowerCase(); });
    return values.indexOf('studio-actions') !== -1 ||
      values.indexOf('desktop-user-folder-create') !== -1 ||
      values.indexOf('chrome-user-folder-create') !== -1;
  }

  function sanitizeFolderForDesktopChrome(row) {
    var out = cloneJson(row) || {};
    if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
    var folderId = cleanString(out.id || out.folderId || out.folder_id);
    if (!folderId) return null;
    out.id = cleanString(out.id || folderId);
    out.folderId = cleanString(out.folderId || folderId);
    if (typeof out.folder_id !== 'undefined') delete out.folder_id;
    if (isStudioFolderActionSource(out)) {
      var meta = out.meta && typeof out.meta === 'object' && !Array.isArray(out.meta)
        ? Object.assign({}, out.meta)
        : {};
      var source = cleanString(out.source || meta.source || 'studio-actions') || 'studio-actions';
      var sourceKind = cleanString(out.sourceKind || out.kind || meta.sourceKind || meta.kind || source) || source;
      out.source = source;
      out.sourceKind = sourceKind;
      out.kind = sourceKind;
      out.userCreated = true;
      out.materializedUserFolder = true;
      out.trustedFolderDisplay = true;
      out.shownInNormalMode = true;
      out.meta = Object.assign({}, meta, {
        source: source,
        sourceKind: sourceKind,
        userCreated: true,
        materializedUserFolder: true,
        trustedFolderDisplay: true,
        shownInNormalMode: true
      });
    }
    return out;
  }

  function readDesktopChromeFolderStateSource(bundle) {
    var csl = bundle && bundle.chromeStorageLocal && typeof bundle.chromeStorageLocal === 'object' && !Array.isArray(bundle.chromeStorageLocal)
      ? bundle.chromeStorageLocal
      : null;
    var fromStorage = csl && csl[FOLDER_STATE_KEY_LOCAL];
    if (fromStorage && typeof fromStorage === 'object' && !Array.isArray(fromStorage)) {
      return { source: fromStorage, sourceKind: 'chromeStorageLocal' };
    }
    var direct = bundle && bundle.folderState;
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
      return { source: direct, sourceKind: 'folderState' };
    }
    var catalogs = bundle && bundle.chatArchive && bundle.chatArchive.catalogs &&
      typeof bundle.chatArchive.catalogs === 'object' && !Array.isArray(bundle.chatArchive.catalogs)
      ? bundle.chatArchive.catalogs
      : null;
    var catalogFolders = catalogs && catalogs.folders;
    if (Array.isArray(catalogFolders) && catalogFolders.length > 0) {
      return {
        source: {
          schemaVersion: 1,
          exportedFrom: 'chatArchive.catalogs.folders',
          exportedAt: cleanString(bundle && bundle.exportedAt),
          folders: catalogFolders,
          items: {}
        },
        sourceKind: 'chatArchive.catalogs.folders'
      };
    }
    return { source: null, sourceKind: '' };
  }

  function folderStateForDesktopChrome(bundle, warnings) {
    var found = readDesktopChromeFolderStateSource(bundle);
    var source = found.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    var folders = [];
    if (Array.isArray(source.folders)) {
      for (var f = 0; f < source.folders.length; f += 1) {
        var folder = sanitizeFolderForDesktopChrome(source.folders[f]);
        if (folder) folders.push(folder);
      }
    }
    var items = source.items && typeof source.items === 'object' && !Array.isArray(source.items) ? source.items : {};
    var itemKeys = Object.keys(items);
    for (var i = 0; i < itemKeys.length; i += 1) {
      if (Array.isArray(items[itemKeys[i]]) && items[itemKeys[i]].length > 0) {
        addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.folderBindings);
        break;
      }
    }
    return {
      schemaVersion: Number(source.schemaVersion || source.version || 1) || 1,
      exportedFrom: cleanString(source.exportedFrom || source.source || 'desktop-studio'),
      exportedAt: cleanString(source.exportedAt || source.updatedAt),
      sourceKind: cleanString(found.sourceKind),
      folders: folders,
      items: {}
    };
  }

  function buildDesktopChromeSupportedBundle(bundleInput) {
    var warnings = [];
    var blockers = [];
    var bundle = bundleInput && typeof bundleInput === 'object' && !Array.isArray(bundleInput)
      ? bundleInput : null;
    if (!bundle) return { ok: false, blockers: ['library-propagation-bundle-invalid'], warnings: warnings };
    if (cleanString(bundle.schema) !== FULL_BUNDLE_SCHEMA) {
      return { ok: false, blockers: ['library-propagation-schema-invalid'], warnings: warnings };
    }
    var chatArchive = bundle.chatArchive && typeof bundle.chatArchive === 'object' && !Array.isArray(bundle.chatArchive)
      ? bundle.chatArchive : {};
    var sourceCatalogs = chatArchive.catalogs && typeof chatArchive.catalogs === 'object' && !Array.isArray(chatArchive.catalogs)
      ? chatArchive.catalogs : {};
    var sourceChats = Array.isArray(chatArchive.chats) ? chatArchive.chats : [];
    var sourceCategories = Array.isArray(sourceCatalogs.categories) ? sourceCatalogs.categories : [];
    if (Array.isArray(sourceCatalogs.labels) && sourceCatalogs.labels.length > 0) {
      addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.labels);
    }
    if (Array.isArray(sourceCatalogs.tags) && sourceCatalogs.tags.length > 0) {
      addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.tags);
    }
    if (Array.isArray(bundle.libraryKv) && bundle.libraryKv.length > 0) {
      addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.labels);
      addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.unsupportedStorage);
    }
    if (Array.isArray(bundle.tombstones) && bundle.tombstones.length > 0) {
      addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.tombstones);
    }
    if (bundle.syncApplyEvents && Number(bundle.syncApplyEvents.total || 0) > 0) {
      addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.applyEvents);
    }
    if (bundle.chromeStorageLocal && typeof bundle.chromeStorageLocal === 'object' && !Array.isArray(bundle.chromeStorageLocal)) {
      Object.keys(bundle.chromeStorageLocal).forEach(function (key) {
        if (key !== FOLDER_STATE_KEY_LOCAL) addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.unsupportedStorage);
      });
    }
    if (bundle.projects || bundle.projectCatalog || bundle.workspaceProjects) {
      addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.projects);
    }
    if (!bundle.sourcePeerEnvelope && !bundle.sourceSyncPeerId && !bundle.exportedFromSurface) {
      addUnique(warnings, DESKTOP_CHROME_DEFERRED_CODES.sourceMetadataMissing);
    }
    var chats = sourceChats.map(function (chat) {
      return sanitizeChatForDesktopChrome(chat, warnings);
    });
    var chatViewCounts = countChatViews(chats);
    var shellSummary = desktopShellRowSummary(chats);
    var categories = cloneJson(sourceCategories) || [];
    var folderState = folderStateForDesktopChrome(bundle, warnings);
    var desktopCanonicalLibraryMetadata = buildDesktopCanonicalLibraryMetadataSnapshot(bundle, cleanString(bundle.exportedAt));
    var chromeStorageLocal = {};
    if (folderState) chromeStorageLocal[FOLDER_STATE_KEY_LOCAL] = folderState;
    var supported = {
      schema: FULL_BUNDLE_SCHEMA,
      exportedAt: cleanString(bundle.exportedAt),
      exportId: cleanString(bundle.exportId),
      sequenceNumber: typeof bundle.sequenceNumber === 'number' ? bundle.sequenceNumber : null,
      previousExportId: bundle.previousExportId ? cleanString(bundle.previousExportId) : null,
      contentSha256: cleanString(bundle.contentSha256),
      sourceSurfaceKind: cleanString(bundle.sourceSurfaceKind || bundle.exportedFromSurface || 'desktop-studio'),
      sourceAppKind: cleanString(bundle.sourceAppKind || bundle.exportedFromExtensionName),
      sourceStoreKind: cleanString(bundle.sourceStoreKind || 'desktop-sqlite'),
      sourcePeerEnvelope: bundle.sourcePeerEnvelope && typeof bundle.sourcePeerEnvelope === 'object'
        ? cloneJson(bundle.sourcePeerEnvelope) : null,
      chatArchive: {
        schema: cleanString(chatArchive.schema || 'h2o.chatArchive.bundle.v1'),
        exportedAt: cleanString(chatArchive.exportedAt || bundle.exportedAt),
        chats: chats,
        catalogs: {
          categories: categories,
          labels: []
        }
      },
      chromeStorageLocal: chromeStorageLocal,
      libraryKv: []
    };
    return {
      ok: true,
      bundle: supported,
      warnings: warnings,
      blockers: blockers,
      sourceSummary: {
        schema: FULL_BUNDLE_SCHEMA,
        direction: 'desktop-to-chrome',
        transport: 'latest.json',
        chatCount: chats.length,
        savedCount: chatViewCounts.saved,
        linkedCount: chatViewCounts.linked,
        pinnedCount: chatViewCounts.pinned,
        archivedCount: chatViewCounts.archived,
        shellRowCount: shellSummary.shellRowCount,
        linkedOnlyCount: shellSummary.linkedOnlyCount,
        savedShellCount: shellSummary.savedShellCount,
        importedShellCount: shellSummary.importedShellCount,
        snapshotCount: countSnapshots(chats),
        categoryCount: categories.length,
        folderMetadataCount: folderState && Array.isArray(folderState.folders) ? folderState.folders.length : 0,
        folderStateSource: cleanString(folderState && folderState.sourceKind),
        folderFacetConvergenceRequired: false,
        folderCount: folderState && Array.isArray(folderState.folders) ? folderState.folders.length : 0,
        folderDeleteReceiptCount: Array.isArray(bundle.folderDeleteReceipts) ? bundle.folderDeleteReceipts.length : 0,
        folderRestoreReceiptCount: Array.isArray(bundle.folderRestoreReceipts) ? bundle.folderRestoreReceipts.length : 0,
        desktopCanonicalLibraryMetadataAvailable: !!desktopCanonicalLibraryMetadata,
        desktopCanonicalMetadataLabelCount: numberOrZero(desktopCanonicalLibraryMetadata &&
          desktopCanonicalLibraryMetadata.counts && desktopCanonicalLibraryMetadata.counts.labelCatalogCount),
        desktopCanonicalMetadataTagCount: numberOrZero(desktopCanonicalLibraryMetadata &&
          desktopCanonicalLibraryMetadata.counts && desktopCanonicalLibraryMetadata.counts.tagCatalogCount),
        desktopCanonicalMetadataCategoryCount: numberOrZero(desktopCanonicalLibraryMetadata &&
          desktopCanonicalLibraryMetadata.counts && desktopCanonicalLibraryMetadata.counts.categoryCatalogCount),
        desktopCanonicalMetadataChatCategoryAssignmentCount: numberOrZero(desktopCanonicalLibraryMetadata &&
          desktopCanonicalLibraryMetadata.counts && desktopCanonicalLibraryMetadata.counts.chatCategoryAssignmentCount),
        desktopCanonicalMetadataProjectionHash: cleanString(desktopCanonicalLibraryMetadata &&
          desktopCanonicalLibraryMetadata.hashes && desktopCanonicalLibraryMetadata.hashes.projection),
        hasSourcePeerEnvelope: !!supported.sourcePeerEnvelope,
        hasExportId: !!supported.exportId,
        hasContentSha256: !!supported.contentSha256
      }
    };
  }

  function redactedDryRunSummary(dryRun) {
    var plan = safeObject(dryRun && dryRun.plan);
    var chats = safeObject(plan.chats);
    var storage = safeObject(plan.chromeStorageLocal);
    var kv = safeObject(plan.libraryKv);
    return {
      ok: dryRun && dryRun.ok !== false,
      incomingChats: numberOrZero(chats.incoming),
      incomingSnapshots: numberOrZero(chats.incomingSnapshots),
      willImportChats: numberOrZero(chats.willImport),
      willSkipDuplicateChats: numberOrZero(chats.willSkipDuplicates),
      storageKeysIncoming: numberOrZero(storage.incoming),
      storageKeysWillImport: numberOrZero(storage.willImport),
      storageKeysDeniedByPolicy: numberOrZero(storage.deniedByPolicy),
      libraryKvIncoming: numberOrZero(kv.incoming),
      libraryKvWillImport: numberOrZero(kv.willImport),
      libraryKvDeniedByPolicy: numberOrZero(kv.deniedByPolicy)
    };
  }

  function redactedErrorCategoryList(categories) {
    var counts = Object.create(null);
    (Array.isArray(categories) ? categories : []).forEach(function (entry) {
      var code = cleanString(entry && entry.code) || 'import-error';
      counts[code] = Number(counts[code] || 0) + Number((entry && entry.count) || 1);
    });
    return Object.keys(counts).sort().map(function (code) {
      return { code: code, count: counts[code] };
    });
  }

  function addRedactedErrorCategory(categories, code) {
    var normalized = cleanString(code) || 'import-error';
    categories.push({ code: normalized, count: 1 });
  }

  function classifyDesktopShellImportError(error) {
    var msg = String(error && (error.message || error) || '').toLowerCase();
    if (msg.indexOf('registry') !== -1 && msg.indexOf('unavailable') !== -1) return 'desktop-shell-row-registry-unavailable';
    if (msg.indexOf('chatid') !== -1 || msg.indexOf('chat id') !== -1) return 'desktop-shell-row-required-field-missing';
    if (msg.indexOf('upsert') !== -1) return 'desktop-shell-row-materialize-failed';
    return 'desktop-shell-row-materialize-failed';
  }

  function registryForDesktopShellRows() {
    return H2O.ChatRegistry ||
      (H2O.Library && H2O.Library.ChatRegistry) ||
      null;
  }

  function desktopShellRecordFromChat(chat) {
    var chatId = cleanString(chat && chat.chatId);
    if (!chatId) return null;
    var index = chatIndexForRow(chat);
    var stateObj = chatIndexState(chat);
    var org = index.organization && typeof index.organization === 'object' && !Array.isArray(index.organization)
      ? index.organization
      : {};
    var meta = chat && chat.meta && typeof chat.meta === 'object' && !Array.isArray(chat.meta) ? chat.meta : {};
    var source = chat && chat.source && typeof chat.source === 'object' && !Array.isArray(chat.source) ? chat.source : {};
    var view = cleanString(index.view || index.kind || index.type).toLowerCase();
    var saved = view === 'saved' || index.isSaved === true || stateObj.isSaved === true;
    var linked = view === 'linked' || index.isLinked === true || stateObj.isLinked === true;
    var imported = !saved && !linked &&
      (view === 'imported' || index.isImported === true || stateObj.isImported === true || !!desktopShellLinkTarget(chat, index));
    var href = desktopShellLinkTarget(chat, index)
      || ('https://chatgpt.com/c/' + chatId);
    var linkedAt = cleanString(index.linkedAt || chat.linkedAt);
    var now = nowIso();
    var title = friendlyShellTitle([
        index.title || chat.title,
        index.displayTitle,
        index.sourceTitle,
        index.pageTitle,
        index.chatTitle,
        index.originalTitle,
        index.name,
        chat.displayTitle,
        chat.sourceTitle,
        chat.pageTitle,
        chat.chatTitle,
        chat.originalTitle,
        chat.name,
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
        index.filename,
        index.sourceLabel,
        chat.filename,
        chat.sourceLabel,
        source.filename,
        source.label
      ], chatId, linked && !saved ? 'Link' : 'Imported chat');
    return {
      chatId: chatId,
      title: title,
      displayTitle: title,
      sourceTitle: title,
      pageTitle: title,
      chatTitle: title,
      originalTitle: title,
      href: href,
      normalizedHref: cleanString(index.normalizedHref || chat.normalizedHref) || href,
      updatedAt: cleanString(index.updatedAt || chat.updatedAt) || now,
      lastSeenAt: cleanString(index.lastSeenAt || chat.lastSeenAt) || now,
      source: {
        first: 'desktop-sync-folder',
        seenFrom: ['desktop-sync-folder']
      },
      organization: {
        categoryId: cleanString(org.categoryId || org.category_id),
        folderId: '',
        tagIds: [],
        labelIds: []
      },
      state: {
        isSaved: !!saved,
        isLinked: !!(linked || saved),
        isPinned: index.pinned === true || index.isPinned === true || stateObj.isPinned === true,
        isArchived: index.archived === true || index.isArchived === true || stateObj.isArchived === true,
        isImported: true,
        isDeleted: stateObj.isDeleted === true
      },
      linkedAt: linkedAt || now,
      linkedFrom: cleanString(index.linkedFrom || chat.linkedFrom) || 'desktop-sync-folder',
      linkSourceHref: cleanString(index.linkSourceHref || chat.linkSourceHref) || href,
      quality: {
        confidence: 'sync-shell',
        inferredFields: imported ? ['desktop-imported-shell-row'] : ['desktop-shell-row']
      }
    };
  }

  async function materializeDesktopShellRows(bundle) {
    var chats = bundle && bundle.chatArchive && Array.isArray(bundle.chatArchive.chats)
      ? bundle.chatArchive.chats
      : [];
    var rows = chats.filter(isDesktopShellLibraryRow);
    var result = {
      attempted: rows.length > 0,
      incoming: rows.length,
      materialized: 0,
      existing: 0,
      failed: 0,
      satisfied: 0,
      redactedErrorCategories: []
    };
    if (rows.length === 0) return result;
    var registry = registryForDesktopShellRows();
    if (!registry || typeof registry.upsertRecord !== 'function') {
      result.failed = rows.length;
      addRedactedErrorCategory(result.redactedErrorCategories, 'desktop-shell-row-registry-unavailable');
      return result;
    }
    try {
      if (registry.ready && typeof registry.ready.then === 'function') await registry.ready;
    } catch (_) { /* continue with in-memory API if available */ }
    for (var i = 0; i < rows.length; i += 1) {
      try {
        var record = desktopShellRecordFromChat(rows[i]);
        if (!record || !record.chatId) throw new Error('desktop shell row chatId missing');
        var existed = null;
        if (typeof registry.getRecord === 'function') {
          try { existed = registry.getRecord(record.chatId); } catch (_) { existed = null; }
        }
        var written = registry.upsertRecord(record, {
          source: 'desktop-sync-folder',
          passive: true,
          observedAt: nowIso()
        });
        if (!written) throw new Error('desktop shell row upsert failed');
        if (existed) result.existing += 1;
        else result.materialized += 1;
      } catch (error) {
        result.failed += 1;
        addRedactedErrorCategory(result.redactedErrorCategories, classifyDesktopShellImportError(error));
      }
    }
    result.satisfied = result.materialized + result.existing;
    result.redactedErrorCategories = redactedErrorCategoryList(result.redactedErrorCategories);
    return result;
  }

  function redactedChromeImportSummary(importResult, dryRun, shellRows) {
    var chats = safeObject(importResult && importResult.chats);
    var storage = safeObject(importResult && importResult.chromeStorageLocal);
    var kv = safeObject(importResult && importResult.libraryKv);
    var shell = safeObject(shellRows);
    var folderStateMergeStats = safeObject(safeObject(storage.folderStateMergeStats)[FOLDER_STATE_KEY_LOCAL]);
    return {
      ok: importResult && importResult.schema === FULL_BUNDLE_SCHEMA,
      mode: cleanString(importResult && importResult.mode) || 'merge',
      dryRun: redactedDryRunSummary(dryRun),
      importedChats: numberOrZero(chats.importedChats),
      importedSnapshots: numberOrZero(chats.importedSnapshots),
      chromeStorageWritten: numberOrZero(storage.written || storage.writtenCount || storage.imported),
      chromeStorageSkipped: numberOrZero(storage.skipped || storage.skippedCount),
      libraryKvWritten: numberOrZero(kv.written || kv.writtenCount || kv.imported),
      libraryKvSkipped: numberOrZero(kv.skipped || kv.skippedCount),
      folderMetadataFreshness: {
        incoming: numberOrZero(folderStateMergeStats.incoming),
        created: numberOrZero(folderStateMergeStats.created),
        refreshed: numberOrZero(folderStateMergeStats.refreshed),
        skippedStale: numberOrZero(folderStateMergeStats.skippedStale),
        missingIncomingUpdatedAt: numberOrZero(folderStateMergeStats.missingIncomingUpdatedAt),
        missingExistingUpdatedAt: numberOrZero(folderStateMergeStats.missingExistingUpdatedAt)
      },
      shellRowsIncoming: numberOrZero(shell.incoming),
      shellRowsMaterialized: numberOrZero(shell.materialized),
      shellRowsExisting: numberOrZero(shell.existing),
      shellRowsSatisfied: numberOrZero(shell.satisfied),
      shellRowsFailed: numberOrZero(shell.failed),
      redactedErrorCategories: redactedErrorCategoryList(shell.redactedErrorCategories)
    };
  }

  function safeCounts(value) {
    var counts = safeObject(value);
    return {
      total: numberOrZero(counts.total),
      saved: numberOrZero(counts.saved),
      linked: numberOrZero(counts.linked),
      pinned: numberOrZero(counts.pinned),
      archived: numberOrZero(counts.archived),
      folders: numberOrZero(counts.folders),
      categories: numberOrZero(counts.categories)
    };
  }

  function evaluateFolderMetadataConvergence(sourceSummary, importSummary) {
    var source = safeObject(sourceSummary);
    var summary = safeObject(importSummary);
    var freshness = safeObject(summary.folderMetadataFreshness);
    var expected = numberOrZero(source.folderMetadataCount || source.folderCount);
    var incoming = numberOrZero(freshness.incoming);
    var created = numberOrZero(freshness.created);
    var refreshed = numberOrZero(freshness.refreshed);
    var skippedStale = numberOrZero(freshness.skippedStale);
    var satisfied = created + refreshed + skippedStale;
    var storageTouched = numberOrZero(summary.chromeStorageWritten) > 0 || numberOrZero(summary.chromeStorageSkipped) > 0;
    var ok = expected === 0 || (
      summary.ok === true &&
      incoming >= expected &&
      satisfied >= expected &&
      storageTouched
    );
    return {
      ok: ok,
      expected: expected,
      incoming: incoming,
      created: created,
      refreshed: refreshed,
      skippedStale: skippedStale,
      satisfied: satisfied,
      storageTouched: storageTouched,
      source: cleanString(source.folderStateSource),
      blocker: ok ? '' : 'desktop-to-chrome-folder-metadata-convergence-not-proven'
    };
  }

  function evaluateDesktopChromeConvergence(sourceSummary, parity, importSummary) {
    var source = safeObject(sourceSummary);
    var counts = safeCounts(parity && parity.counts);
    var folderMetadata = evaluateFolderMetadataConvergence(sourceSummary, importSummary);
    var folderMetadataConvergenceApplies = folderMetadata.ok === true && folderMetadata.expected > 0;
    var expected = {
      total: numberOrZero(source.chatCount),
      saved: numberOrZero(source.savedCount),
      linked: numberOrZero(source.linkedCount),
      pinned: numberOrZero(source.pinnedCount),
      archived: numberOrZero(source.archivedCount),
      folders: numberOrZero(source.folderCount),
      folderMetadata: numberOrZero(source.folderMetadataCount || source.folderCount),
      categories: numberOrZero(source.categoryCount)
    };
    var mismatches = [];
    var nonBlockingMismatches = [];
    var activeRowFields = ['total', 'saved', 'linked', 'pinned', 'archived'];
    ['total', 'saved', 'linked'].forEach(function (key) {
      if (counts[key] !== expected[key]) {
        nonBlockingMismatches.push({ field: key, expected: expected[key], observed: counts[key], reason: 'active-row-parity-deferred' });
      }
    });
    ['categories'].forEach(function (key) {
      if (counts[key] !== expected[key]) {
        nonBlockingMismatches.push({ field: key, expected: expected[key], observed: counts[key], reason: 'active-row-parity-deferred' });
      }
    });
    if (source.folderFacetConvergenceRequired === true && counts.folders !== expected.folders) {
      mismatches.push({ field: 'folders', expected: expected.folders, observed: counts.folders });
    }
    ['pinned', 'archived'].forEach(function (key) {
      if (expected[key] > 0 && counts[key] < expected[key]) {
        nonBlockingMismatches.push({ field: key, expected: expected[key], observed: counts[key], reason: 'active-row-parity-deferred' });
      }
    });
    if (!folderMetadata.ok && expected.folderMetadata > 0) {
      mismatches.push({
        field: 'folderMetadata',
        expected: expected.folderMetadata,
        observed: folderMetadata.satisfied,
        incoming: folderMetadata.incoming,
        reason: folderMetadata.blocker
      });
    }
    if (!parity || parity.snapshotCaptured !== true) {
      mismatches.push({ field: 'paritySnapshot', expected: true, observed: false });
    }
    if (!folderMetadataConvergenceApplies && nonBlockingMismatches.length > 0) {
      for (var i = 0; i < nonBlockingMismatches.length; i += 1) {
        var entry = Object.assign({}, nonBlockingMismatches[i]);
        if (activeRowFields.indexOf(entry.field) !== -1) entry.reason = 'active-row-parity-required';
        mismatches.push(entry);
      }
      nonBlockingMismatches = [];
    }
    return {
      ok: mismatches.length === 0,
      expected: expected,
      observed: counts,
      mismatchCount: mismatches.length,
      mismatches: mismatches,
      nonBlockingMismatchCount: nonBlockingMismatches.length,
      nonBlockingMismatches: nonBlockingMismatches,
      activeRowConvergenceDeferred: folderMetadataConvergenceApplies && nonBlockingMismatches.length > 0,
      folderMetadata: folderMetadata,
      blocker: mismatches.length ? 'desktop-to-chrome-convergence-not-proven' : ''
    };
  }

  function redactedPostImportRefreshSummary(value) {
    var summary = safeObject(value);
    var changedFolderIds = Array.isArray(summary.changedFolderIds) ? summary.changedFolderIds : [];
    return {
      mode: cleanString(summary.mode),
      changedFolderCount: numberOrZero(summary.changedFolderCount),
      changedFields: Array.isArray(summary.changedFields) ? summary.changedFields.slice() : [],
      changedFolderIdCount: changedFolderIds.length,
      changedFolderIdsRedacted: changedFolderIds.length > 0,
      renderRefreshedAt: cleanString(summary.renderRefreshedAt),
      renderRefreshCount: numberOrZero(summary.renderRefreshCount),
      cumulativeRenderRefreshCount: numberOrZero(summary.cumulativeRenderRefreshCount),
      refreshSuppressed: summary.refreshSuppressed === true,
      totalPropagationMs: numberOrZero(summary.totalPropagationMs),
      error: cleanString(summary.error)
    };
  }

  function propagationResult(ok, fields) {
    var f = fields && typeof fields === 'object' ? fields : {};
    var blockers = normalizeHardeningBlockers(f.blockers);
    var warnings = normalizeHardeningWarnings(f.warnings);
    var statusValue = cleanString(f.status || (ok ? 'imported' : 'blocked'));
    return {
      schema: PROPAGATION_SCHEMA,
      version: F19_DESKTOP_CHROME_VERSION,
      ok: ok === true && blockers.length === 0,
      direction: 'desktop-to-chrome',
      transport: 'latest.json',
      status: statusValue,
      conflictDecision: cleanString(f.conflictDecision),
      conflictApproved: f.conflictApproved === true,
      conflictApproval: {
        approved: f.conflictApproved === true,
        decision: cleanString(f.conflictDecision),
        approvedBlockers: Array.isArray(f.approvedConflictBlockers) ? f.approvedConflictBlockers.slice() : [],
        staleTransportStillBlocks: true,
        duplicateIdempotencyPreserved: true
      },
      supportedFields: DESKTOP_CHROME_SUPPORTED_FIELDS.slice(),
      deferredFields: warnings.filter(function (code) {
        return code === DESKTOP_CHROME_DEFERRED_CODES.labels ||
          code === DESKTOP_CHROME_DEFERRED_CODES.tags ||
          code === DESKTOP_CHROME_DEFERRED_CODES.projects ||
          code === DESKTOP_CHROME_DEFERRED_CODES.folderBindings ||
          code === DESKTOP_CHROME_DEFERRED_CODES.tombstones ||
          code === DESKTOP_CHROME_DEFERRED_CODES.applyEvents;
      }),
      sourceSummary: f.sourceSummary || null,
      folderMetadataCount: numberOrZero(f.sourceSummary && (f.sourceSummary.folderMetadataCount || f.sourceSummary.folderCount)),
      folderStateSource: cleanString(f.sourceSummary && f.sourceSummary.folderStateSource),
      importSummary: f.importSummary || null,
      folderDeleteReceiptImport: f.folderDeleteReceiptImport || null,
      folderRestoreReceiptImport: f.folderRestoreReceiptImport || null,
      chatFolderBindingReceiptImport: f.chatFolderBindingReceiptImport || null,
      libraryMetadataMutationReceiptImport: f.libraryMetadataMutationReceiptImport || null,
      desktopCanonicalLibraryMetadata: f.desktopCanonicalLibraryMetadata || null,
      desktopCanonicalLibraryMetadataImport: f.desktopCanonicalLibraryMetadataImport || null,
      convergence: f.convergence || null,
      postImportRefresh: f.postImportRefresh ? redactedPostImportRefreshSummary(f.postImportRefresh) : null,
      redactedErrorCategories: redactedErrorCategoryList(f.redactedErrorCategories ||
        (f.importSummary && f.importSummary.redactedErrorCategories)),
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
        simultaneousConflictApproved: f.conflictApproved === true,
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
      sideEffects: {
        chromeStorageMayWriteSupportedRows: ok === true && statusValue !== 'already-imported' && statusValue !== 'dry-run-ok',
        desktopSqliteWritten: false,
        nativeCalled: false,
        f5Touched: false,
        relayTouched: false,
        outboxTouched: false
      },
      blockers: blockers,
      warnings: warnings,
      observedAt: nowIso()
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
        surface: cleanString(snapshot && snapshot.surface),
        counts: safeCounts(snapshot && snapshot.counts)
      };
    } catch (_) {
      return {
        snapshotCaptured: false,
        paritySnapshotHash: '',
        parityDiagnosticReady: false,
        warning: 'library-propagation-parity-snapshot-failed'
      };
    }
  }

  async function importDesktopBundlePayload(bundleInput, options) {
    var opts = safeObject(options);
    var normalized = buildDesktopChromeSupportedBundle(bundleInput);
    if (!normalized.ok) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: normalized.blockers || ['library-propagation-bundle-invalid'],
        warnings: normalized.warnings || []
      });
    }
    var warnings = normalized.warnings.slice();
    if (opts.conflictApproved === true) addUnique(warnings, 'library-propagation-simultaneous-conflict-approved');
    var folderMetadataChangeSummary = safeObject(opts.folderMetadataChangeSummary);
    if (!Object.prototype.hasOwnProperty.call(folderMetadataChangeSummary, 'changedFolderCount')) {
      folderMetadataChangeSummary = await summarizeDesktopFolderMetadataChanges(normalized.bundle);
    }
    var dryRun;
    try {
      dryRun = await callArchive('dryRunImportFullBundle', { bundle: normalized.bundle });
    } catch (_) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-dry-run-failed'],
        warnings: warnings,
        sourceSummary: normalized.sourceSummary
      });
    }
    if (opts.dryRunOnly === true || opts.proofMode === true) {
      var dryParity = await captureParityAfterImport();
      if (dryParity.warning) addUnique(warnings, dryParity.warning);
      return propagationResult(true, {
        status: 'dry-run-ok',
        warnings: warnings,
        sourceSummary: normalized.sourceSummary,
        importSummary: { ok: true, mode: 'merge', dryRun: redactedDryRunSummary(dryRun), proofMode: opts.proofMode === true },
        parity: dryParity,
        conflictDecision: normalizeConflictDecision(opts),
        conflictApproved: opts.conflictApproved === true,
        approvedConflictBlockers: Array.isArray(opts.approvedConflictBlockers) ? opts.approvedConflictBlockers : [],
        idempotency: {
          fileFingerprintChecked: opts.fileFingerprint ? true : false,
          mergeOnly: true,
          existingRowsSkipped: true,
          dryRunOnly: true
        }
      });
    }
    var importResult;
    try {
      importResult = await callArchive('importFullBundle', { bundle: normalized.bundle, mode: 'merge' });
    } catch (_) {
      return propagationResult(false, {
        status: 'blocked',
        blockers: ['library-propagation-import-failed'],
        warnings: warnings,
        sourceSummary: normalized.sourceSummary,
        importSummary: { ok: false, dryRun: redactedDryRunSummary(dryRun) }
      });
    }
    var folderDeleteReceiptImport = await ingestFolderDeleteReceiptsFromDesktopBundle(bundleInput, opts);
    var folderDeleteReceiptHide = await hideFoldersAfterFolderDeleteReceipts(bundleInput);
    folderDeleteReceiptImport = mergeFolderDeleteReceiptHideResult(folderDeleteReceiptImport, folderDeleteReceiptHide);
    state.lastFolderDeleteReceiptImport = folderDeleteReceiptImport;
    folderMetadataChangeSummary = mergeFolderDeleteReceiptHideSummary(folderMetadataChangeSummary, folderDeleteReceiptHide);
    var folderRestoreReceiptImport = await importFolderRestoreReceiptsFromDesktopBundle(bundleInput);
    state.lastFolderRestoreReceiptImport = folderRestoreReceiptImport;
    folderMetadataChangeSummary = mergeFolderRestoreReceiptReShowSummary(folderMetadataChangeSummary, folderRestoreReceiptImport);
    var chatFolderBindingReceiptImport = await importChatFolderBindingReceiptsFromDesktopBundle(bundleInput);
    var libraryMetadataMutationReceiptImport = await importLibraryMetadataMutationReceiptsFromDesktopBundle(bundleInput);
    var desktopVisibleFolderSet = importDesktopVisibleFolderSetSnapshot(normalized.bundle, nowIso());
    var desktopVisibleSetHide = await applyDesktopVisibleSetHideOverlay(desktopVisibleFolderSet);
    folderMetadataChangeSummary = mergeDesktopVisibleSetHideSummary(folderMetadataChangeSummary, desktopVisibleSetHide);
    var desktopCanonicalRecentlyDeleted = buildDesktopCanonicalRecentlyDeletedSnapshot(bundleInput, nowIso()) ||
      buildDesktopCanonicalRecentlyDeletedSnapshot(normalized.bundle, nowIso());
    var desktopCanonicalRecentlyDeletedImport = await storeDesktopCanonicalRecentlyDeletedSnapshot(desktopCanonicalRecentlyDeleted);
    if (desktopCanonicalRecentlyDeletedImport.changed === true) {
      addUnique(folderMetadataChangeSummary.changedFields, 'desktop-canonical-recently-deleted');
      folderMetadataChangeSummary.changedFolderCount = Math.max(1, numberOrZero(folderMetadataChangeSummary.changedFolderCount));
    }
    var desktopPurgedFolderSuppression = buildDesktopPurgedFolderSuppressionSnapshot(bundleInput, nowIso()) ||
      buildDesktopPurgedFolderSuppressionSnapshot(normalized.bundle, nowIso());
    var desktopPurgedFolderSuppressionImport = await storeDesktopPurgedFolderSuppressionSnapshot(desktopPurgedFolderSuppression);
    if (desktopPurgedFolderSuppressionImport.changed === true) {
      addUnique(folderMetadataChangeSummary.changedFields, 'desktop-purged-folder-suppression');
      folderMetadataChangeSummary.changedFolderCount = Math.max(1, numberOrZero(folderMetadataChangeSummary.changedFolderCount));
    }
    var desktopCanonicalChatFolderBindings = buildDesktopCanonicalChatFolderBindingSnapshot(bundleInput, nowIso()) ||
      buildDesktopCanonicalChatFolderBindingSnapshot(normalized.bundle, nowIso());
    var desktopCanonicalChatFolderBindingImport = await storeDesktopCanonicalChatFolderBindingSnapshot(desktopCanonicalChatFolderBindings);
    if (desktopCanonicalChatFolderBindingImport.changed === true) {
      addUnique(folderMetadataChangeSummary.changedFields, 'desktop-canonical-chat-folder-bindings');
      folderMetadataChangeSummary.changedFolderCount = Math.max(1, numberOrZero(folderMetadataChangeSummary.changedFolderCount));
    }
    var desktopCanonicalLibraryMetadata = buildDesktopCanonicalLibraryMetadataSnapshot(bundleInput, nowIso()) ||
      buildDesktopCanonicalLibraryMetadataSnapshot(normalized.bundle, nowIso());
    var desktopCanonicalLibraryMetadataImport = await storeDesktopCanonicalLibraryMetadataSnapshot(desktopCanonicalLibraryMetadata);
    var shellRows = await materializeDesktopShellRows(normalized.bundle);
    if (numberOrZero(folderMetadataChangeSummary.changedFolderCount) > 0) {
      await refreshLibraryIndex('desktop-chrome-propagation-import');
    }
    state.lastDesktopToChromeImportAppliedAt = nowIso();
    var postImportRefresh = await refreshChromeFolderUiAfterDesktopImport(
      folderMetadataChangeSummary,
      opts.reason || 'desktop-chrome-propagation-import',
      cleanString(normalized.bundle && normalized.bundle.exportedAt)
    );
    var parity = await captureParityAfterImport();
    if (parity.warning) addUnique(warnings, parity.warning);
    var importSummary = redactedChromeImportSummary(importResult, dryRun, shellRows);
    var blockers = [];
    var redactedErrors = importSummary.redactedErrorCategories;
    if (numberOrZero(importSummary.shellRowsFailed) > 0) addUnique(blockers, 'desktop-shell-row-import-unsupported');
    if (numberOrZero(folderRestoreReceiptImport && folderRestoreReceiptImport.blockerCount) > 0) {
      addUnique(blockers, 'folder-restore-receipt-import-blocked');
    }
    if (numberOrZero(chatFolderBindingReceiptImport && chatFolderBindingReceiptImport.blockerCount) > 0) {
      addUnique(blockers, 'chat-folder-binding-receipt-import-blocked');
    }
    if (numberOrZero(libraryMetadataMutationReceiptImport && libraryMetadataMutationReceiptImport.blockerCount) > 0) {
      addUnique(blockers, 'library-metadata-mutation-receipt-import-blocked');
    }
    var convergence = evaluateDesktopChromeConvergence(normalized.sourceSummary, parity, importSummary);
    if (!convergence.ok) addUnique(blockers, convergence.blocker);
    return propagationResult(blockers.length === 0, {
      status: 'imported',
      blockers: blockers,
      warnings: warnings,
      sourceSummary: normalized.sourceSummary,
      importSummary: importSummary,
      folderDeleteReceiptImport: folderDeleteReceiptImport,
      folderRestoreReceiptImport: folderRestoreReceiptImport,
      chatFolderBindingReceiptImport: chatFolderBindingReceiptImport,
      libraryMetadataMutationReceiptImport: libraryMetadataMutationReceiptImport,
      desktopVisibleFolderSet: desktopVisibleFolderSet,
      desktopVisibleSetHide: desktopVisibleSetHide,
      desktopCanonicalRecentlyDeleted: desktopCanonicalRecentlyDeleted,
      desktopCanonicalRecentlyDeletedImport: desktopCanonicalRecentlyDeletedImport,
      desktopPurgedFolderSuppression: desktopPurgedFolderSuppression,
      desktopPurgedFolderSuppressionImport: desktopPurgedFolderSuppressionImport,
      desktopCanonicalChatFolderBindings: desktopCanonicalChatFolderBindings,
      desktopCanonicalChatFolderBindingImport: desktopCanonicalChatFolderBindingImport,
      importedDesktopCanonicalBindingCount: numberOrZero(desktopCanonicalChatFolderBindingImport && desktopCanonicalChatFolderBindingImport.bindingCount),
      desktopCanonicalLibraryMetadata: desktopCanonicalLibraryMetadata,
      desktopCanonicalLibraryMetadataImport: desktopCanonicalLibraryMetadataImport,
      convergence: convergence,
      postImportRefresh: postImportRefresh,
      redactedErrorCategories: redactedErrors,
      parity: parity,
      conflictDecision: normalizeConflictDecision(opts),
      conflictApproved: opts.conflictApproved === true,
      approvedConflictBlockers: Array.isArray(opts.approvedConflictBlockers) ? opts.approvedConflictBlockers : [],
      idempotency: {
        fileFingerprintChecked: opts.fileFingerprint ? true : false,
        mergeOnly: true,
        existingRowsSkipped: true,
        protectedDomainFallbackDisabled: true
      }
    });
  }

  function isBundleLikeInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return !!(
      cleanString(value.schema) ||
      value.chatArchive ||
      value.chromeStorageLocal ||
      value.libraryKv ||
      value.folderState
    );
  }

  function shouldTreatAsLatestJsonImportOptions(bundleInput, options, argumentCount) {
    if (argumentCount === 0) return true;
    if (typeof options !== 'undefined') return false;
    if (!bundleInput || typeof bundleInput !== 'object' || Array.isArray(bundleInput)) return false;
    if (isBundleLikeInput(bundleInput)) return false;
    return Object.prototype.hasOwnProperty.call(bundleInput, 'reason') ||
      Object.prototype.hasOwnProperty.call(bundleInput, 'dryRunOnly') ||
      Object.prototype.hasOwnProperty.call(bundleInput, 'autoSync') ||
      Object.prototype.hasOwnProperty.call(bundleInput, 'conflictDecision') ||
      Object.prototype.hasOwnProperty.call(bundleInput, 'conflictApproved') ||
      Object.prototype.hasOwnProperty.call(bundleInput, 'approvedConflictBlockers') ||
      Object.prototype.hasOwnProperty.call(bundleInput, 'direction');
  }

  async function importLatestBundle(bundleInput, options) {
    if (shouldTreatAsLatestJsonImportOptions(bundleInput, options, arguments.length)) {
      return syncNow(safeObject(bundleInput));
    }
    return importDesktopBundlePayload(bundleInput, options);
  }

  async function refreshLibraryIndex(reason) {
    try {
      if (H2O.LibraryIndex && typeof H2O.LibraryIndex.refresh === 'function') {
        await H2O.LibraryIndex.refresh(reason || 'sync-folder-import');
      } else {
        global.dispatchEvent(new CustomEvent('evt:h2o:library-index:refresh-request', {
          detail: { reason: reason || 'sync-folder-import' },
        }));
      }
    } catch (error) {
      pushError('refresh-library-index', error);
    }
    try {
      return H2O.LibraryIndex && typeof H2O.LibraryIndex.getAll === 'function'
        ? H2O.LibraryIndex.getAll().length
        : 0;
    } catch (_) {
      return 0;
    }
  }

  function currentLibraryIndexRowCount() {
    try {
      return H2O.LibraryIndex && typeof H2O.LibraryIndex.getAll === 'function'
        ? H2O.LibraryIndex.getAll().length
        : 0;
    } catch (_) {
      return 0;
    }
  }

  async function summarizeDesktopFolderMetadataChanges(bundle) {
    var incoming = folderMetadataRowsFromBundle(bundle);
    var localState = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var localRows = Array.isArray(localState.folders) ? localState.folders : [];
    var localById = Object.create(null);
    for (var i = 0; i < localRows.length; i += 1) {
      var localId = folderMetadataRowId(localRows[i]);
      if (localId) localById[localId] = localRows[i];
    }
    var changedRows = [];
    var changedFields = [];
    var changedFolderIds = [];
    for (var r = 0; r < incoming.rows.length; r += 1) {
      var row = incoming.rows[r];
      var folderId = folderMetadataRowId(row);
      if (!folderId) continue;
      var local = localById[folderId] || null;
      var fields = [];
      if (!local) fields.push('create');
      else {
        if (folderMetadataRowName(row) !== folderMetadataRowName(local)) fields.push('name');
        if (folderMetadataRowColor(row) !== folderMetadataRowColor(local)) fields.push('color');
      }
      if (!fields.length) continue;
      fields.forEach(function (field) { addUnique(changedFields, field); });
      addUnique(changedFolderIds, folderId);
      changedRows.push({ folderId: folderId, fields: fields.slice(), row: row });
    }
    return {
      sourceKind: incoming.sourceKind,
      changedFolderCount: changedRows.length,
      changedFolderIds: changedFolderIds,
      changedFields: changedFields,
      hasCreate: changedFields.indexOf('create') !== -1,
      hasOnlyVisualUpdates: changedRows.length > 0 && changedFields.every(function (field) {
        return field === 'name' || field === 'color';
      }),
      rows: changedRows,
    };
  }

  function addUniqueFolderId(list, folderId) {
    var id = normalizeFolderRecordId(folderId);
    if (id && list.indexOf(id) === -1) list.push(id);
  }

  function folderDeleteReceiptIdsForChromeHide(receipt) {
    var ids = [];
    addUnique(ids, receipt && receipt.requestId);
    addUnique(ids, receipt && receipt.reviewId);
    return ids;
  }

  function normalizeFolderDeleteReceiptForChromeHide(receiptInput) {
    var receipt = safeObject(receiptInput);
    var folderId = normalizeFolderRecordId(receipt.folderId);
    var requestIds = folderDeleteReceiptIdsForChromeHide(receipt);
    if (cleanString(receipt.schema) !== FOLDER_DELETE_RECEIPT_SCHEMA) return { ok: false, code: 'receipt-schema-invalid' };
    if (cleanString(receipt.status) !== 'applied') return { ok: false, code: 'receipt-status-not-applied' };
    if (cleanString(receipt.decision) !== 'applied-folder-delete-request') return { ok: false, code: 'receipt-decision-not-applied-folder-delete-request' };
    if (receipt.statusOnly !== true) return { ok: false, code: 'receipt-not-status-only' };
    if (receipt.noTombstoneApply !== true) return { ok: false, code: 'receipt-tombstone-apply-not-blocked' };
    if (receipt.noHardDelete !== true) return { ok: false, code: 'receipt-hard-delete-not-blocked' };
    if (receipt.noChatDelete !== true) return { ok: false, code: 'receipt-chat-delete-not-blocked' };
    if (cleanString(receipt.tombstonePropagation) !== 'deferred') return { ok: false, code: 'receipt-tombstone-propagation-not-deferred' };
    if (!folderId) return { ok: false, code: 'receipt-folder-identity-missing' };
    if (!requestIds.length) return { ok: false, code: 'receipt-request-identity-missing' };
    return {
      ok: true,
      receipt: Object.assign({}, receipt, {
        folderId: folderId,
        requestId: cleanString(receipt.requestId),
        reviewId: cleanString(receipt.reviewId),
        receiptId: cleanString(receipt.receiptId),
        tombstoneId: cleanString(receipt.tombstoneId),
      }),
      requestIds: requestIds
    };
  }

  function parseJsonObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
      var parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function chromeFolderDeleteReviewPayload(review) {
    return parseJsonObject(review && (review.rawTombstoneJson || review.raw_tombstone_json || review.rawJson || review.payloadJson));
  }

  function chromeFolderDeleteReviewFolderId(review) {
    var payload = chromeFolderDeleteReviewPayload(review);
    return normalizeFolderRecordId(payload.folderId || payload.recordId || (review && review.recordId));
  }

  function chromeFolderDeleteReviewRequestId(review) {
    var payload = chromeFolderDeleteReviewPayload(review);
    return cleanString(payload.requestId || payload.reviewId || (review && review.reviewId));
  }

  function chromeFolderDeleteReviewIsResolvedApplied(review) {
    return cleanString(review && review.status) === 'resolved' &&
      cleanString(review && review.decision) === 'applied-folder-delete-request';
  }

  async function findChromeFolderDeleteReceiptReviewForHide(receipt) {
    var reviews = H2O && H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
    if (!reviews || typeof reviews.getReview !== 'function') {
      return { ok: false, code: 'folder-delete-receipt-store-unavailable' };
    }
    var ids = folderDeleteReceiptIdsForChromeHide(receipt);
    for (var i = 0; i < ids.length; i += 1) {
      var review = await reviews.getReview(ids[i]);
      if (review) return { ok: true, review: review };
    }
    if (typeof reviews.listFolderDeleteRequests === 'function') {
      var rows = await reviews.listFolderDeleteRequests({ folderId: receipt.folderId, limit: 100 });
      var list = Array.isArray(rows) ? rows : [];
      for (var r = 0; r < list.length; r += 1) {
        var requestId = chromeFolderDeleteReviewRequestId(list[r]);
        if (ids.indexOf(requestId) !== -1 || ids.indexOf(cleanString(list[r] && list[r].reviewId)) !== -1) {
          return { ok: true, review: list[r] };
        }
      }
    }
    return { ok: false, code: 'receipt-no-matching-request' };
  }

  async function validateFolderDeleteReceiptHideTarget(receiptInput) {
    var normalized = normalizeFolderDeleteReceiptForChromeHide(receiptInput);
    if (!normalized.ok) return normalized;
    var receipt = normalized.receipt;
    var found = await findChromeFolderDeleteReceiptReviewForHide(receipt);
    if (!found.ok || !found.review) {
      if ((found && found.code) === 'receipt-no-matching-request') {
        return {
          ok: true,
          receipt: receipt,
          review: null,
          trustedDesktopReceipt: true,
          trustedDesktopReceiptWithoutLocalRequest: true,
          warning: 'receipt-no-matching-request',
        };
      }
      return { ok: false, code: found.code || 'receipt-no-matching-request', receipt: receipt };
    }
    var review = found.review;
    var localFolderId = chromeFolderDeleteReviewFolderId(review);
    if (localFolderId !== receipt.folderId) return { ok: false, code: 'receipt-folder-mismatch', receipt: receipt };
    var localRequestId = chromeFolderDeleteReviewRequestId(review);
    if (localRequestId && normalized.requestIds.indexOf(localRequestId) === -1 &&
      normalized.requestIds.indexOf(cleanString(review.reviewId)) === -1) {
      return { ok: false, code: 'receipt-request-mismatch', receipt: receipt };
    }
    if (!chromeFolderDeleteReviewIsResolvedApplied(review)) {
      return { ok: false, code: 'receipt-review-not-resolved-applied', receipt: receipt };
    }
    return { ok: true, receipt: receipt, review: review, trustedDesktopReceipt: true };
  }

  function folderStateHasFolderId(folderState, folderId) {
    var id = normalizeFolderRecordId(folderId);
    var folders = Array.isArray(folderState && folderState.folders) ? folderState.folders : [];
    for (var i = 0; i < folders.length; i += 1) {
      if (normalizeFolderRecordId(folderMetadataRowId(folders[i])) === id) return true;
    }
    var items = safeObject(folderState && folderState.items);
    return !!(id && Object.prototype.hasOwnProperty.call(items, id));
  }

  async function hideFolderByDesktopReceiptFromMirror(receipt, target) {
    var folderId = normalizeFolderRecordId(receipt && receipt.folderId);
    if (!folderId) return { ok: false, hidden: false, status: 'receipt-folder-identity-missing' };
    var current = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var markerBag = safeObject(current.hiddenByDesktopReceipt);
    var pendingBag = safeObject(current.hiddenByChromePendingDelete);
    var pendingRow = safeObject(pendingBag[folderId]);
    var hadPendingDelete = !!pendingBag[folderId];
    var alreadyMarked = !!markerBag[folderId];
    var hasFolder = folderStateHasFolderId(current, folderId);
    if (!hasFolder && alreadyMarked) {
      if (hadPendingDelete) {
        var cleared = cloneJson(current) || {};
        var clearedPending = Object.assign({}, safeObject(cleared.hiddenByChromePendingDelete));
        delete clearedPending[folderId];
        cleared.hiddenByChromePendingDelete = clearedPending;
        cleared.updatedAt = nowIso();
        await writeKv(FOLDER_STATE_KEY_LOCAL, cleared);
      }
      return {
        ok: true,
        hidden: false,
        alreadyHidden: true,
        status: 'folder-delete-receipt-folder-already-hidden',
        writesPerformed: hadPendingDelete ? 1 : 0,
        folderId: folderId,
        trustedDesktopReceiptWithoutLocalRequest: !!(target && target.trustedDesktopReceiptWithoutLocalRequest),
        pendingDeleteConfirmedByDesktopReceipt: hadPendingDelete,
      };
    }
    var next = cloneJson(current) || {};
    var rows = Array.isArray(next.folders) ? next.folders : [];
    var removedRow = null;
    next.folders = rows.filter(function (row) {
      var matches = normalizeFolderRecordId(folderMetadataRowId(row)) === folderId;
      if (matches && !removedRow) removedRow = safeObject(row);
      return !matches;
    });
    if (next.items && typeof next.items === 'object' && !Array.isArray(next.items)) {
      var nextItems = Object.assign({}, next.items);
      delete nextItems[folderId];
      next.items = nextItems;
    }
    var nextPending = Object.assign({}, safeObject(next.hiddenByChromePendingDelete));
    delete nextPending[folderId];
    next.hiddenByChromePendingDelete = nextPending;
    var sourceRow = safeObject(removedRow || pendingRow || markerBag[folderId]);
    var rowMeta = safeObject(sourceRow.meta);
    var receiptFolderName = cleanString(receipt.folderName || receipt.folderNameAtRequest);
    var folderName = cleanString(sourceRow.name || sourceRow.folderName || sourceRow.title || rowMeta.name || receiptFolderName || folderId);
    var color = cleanString(sourceRow.color || sourceRow.iconColor || rowMeta.color || rowMeta.iconColor);
    var iconColor = cleanString(sourceRow.iconColor || sourceRow.color || rowMeta.iconColor || rowMeta.color);
    var hidden = Object.assign({}, safeObject(next.hiddenByDesktopReceipt));
    hidden[folderId] = Object.assign({}, safeObject(hidden[folderId]), {
      hiddenByDesktopReceipt: true,
      deletedByDesktopReceipt: true,
      folderId: folderId,
      id: folderId,
      name: folderName,
      folderName: folderName,
      color: color,
      iconColor: iconColor,
      meta: rowMeta,
      receiptId: cleanString(receipt.receiptId),
      requestId: cleanString(receipt.requestId),
      reviewId: cleanString(receipt.reviewId),
      tombstoneId: cleanString(receipt.tombstoneId),
      hiddenAt: nowIso(),
      confirmedAt: nowIso(),
      source: 'desktop-folder-delete-receipt',
      sourceKind: 'desktop-receipt-visible-state',
      status: 'deleted',
      companionStatusLabel: 'Deleted on Desktop',
      trustedDesktopReceipt: true,
      trustedDesktopReceiptWithoutLocalRequest: !!(target && target.trustedDesktopReceiptWithoutLocalRequest),
      pendingDeleteConfirmedByDesktopReceipt: hadPendingDelete,
      statusOnly: true,
      noTombstoneApply: true,
      noTombstoneCreate: true,
      noHardDelete: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      tombstonePropagation: 'deferred'
    });
    next.hiddenByDesktopReceipt = hidden;
    next.updatedAt = nowIso();
    await writeKv(FOLDER_STATE_KEY_LOCAL, next);
    return {
      ok: true,
      hidden: hasFolder,
      alreadyHidden: !hasFolder,
      status: hasFolder ? 'folder-delete-receipt-folder-hidden' : 'folder-delete-receipt-folder-already-hidden',
      writesPerformed: 1,
      folderId: folderId,
      requestId: cleanString(receipt.requestId),
      receiptId: cleanString(receipt.receiptId),
      trustedDesktopReceiptWithoutLocalRequest: !!(target && target.trustedDesktopReceiptWithoutLocalRequest),
      pendingDeleteConfirmedByDesktopReceipt: hadPendingDelete
    };
  }

  function folderDeleteReceiptHideDiagnosticRow(receiptInput, extra) {
    var receipt = safeObject(receiptInput);
    var row = Object.assign({
      receiptId: cleanString(receipt.receiptId),
      requestId: cleanString(receipt.requestId || receipt.reviewId),
      reviewId: cleanString(receipt.reviewId || receipt.requestId),
      folderId: normalizeFolderRecordId(receipt.folderId),
      folderName: cleanString(receipt.folderName || receipt.folderNameAtRequest),
      status: cleanString(receipt.status),
      decision: cleanString(receipt.decision),
      source: 'desktop-folder-delete-receipt',
    }, safeObject(extra));
    return row;
  }

  function makeFolderDeleteReceiptHideResult() {
    return {
      schema: FOLDER_DELETE_RECEIPT_SCHEMA + '.chrome-hide',
      phase: 'phase4c.4c',
      attempted: true,
      ok: true,
      hiddenCount: 0,
      alreadyHiddenCount: 0,
      hideSkippedCount: 0,
      hideBlockerCount: 0,
      hideWarningCount: 0,
      visibleStateOnlyHide: true,
      noTombstoneApply: true,
      noTombstoneCreate: true,
      noHardDelete: true,
      noChatDelete: true,
      noAssetDelete: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      noDestructiveFolderMutation: true,
      tombstonePropagation: 'deferred',
      hiddenFolderIds: [],
      receiptRows: [],
      skippedReceipts: [],
      trustedDesktopReceiptWithoutLocalRequestCount: 0,
      warnings: [],
      blockers: []
    };
  }

  function addFolderDeleteReceiptHideCode(result, field, code) {
    var list = Array.isArray(result && result[field]) ? result[field] : null;
    var c = cleanString(code);
    if (!list || !c) return;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].code === c) {
        list[i].count = numberOrZero(list[i].count || 1) + 1;
        return;
      }
    }
    list.push({ code: c });
  }

  async function hideFoldersAfterFolderDeleteReceipts(bundle) {
    var result = makeFolderDeleteReceiptHideResult();
    var receipts = Array.isArray(bundle && bundle.folderDeleteReceipts) ? bundle.folderDeleteReceipts : [];
    if (!receipts.length) return result;
    for (var i = 0; i < receipts.length; i += 1) {
      try {
        var target = await validateFolderDeleteReceiptHideTarget(receipts[i]);
        if (!target.ok) {
          result.hideSkippedCount += 1;
          result.hideWarningCount += 1;
          addFolderDeleteReceiptHideCode(result, 'warnings', target.code || 'folder-delete-receipt-hide-skipped');
          result.skippedReceipts.push(folderDeleteReceiptHideDiagnosticRow(target.receipt || receipts[i], {
            reason: target.code || 'folder-delete-receipt-hide-skipped',
          }));
          continue;
        }
        if (target.warning) {
          result.hideWarningCount += 1;
          addFolderDeleteReceiptHideCode(result, 'warnings', target.warning);
        }
        var hidden = await hideFolderByDesktopReceiptFromMirror(target.receipt, target);
        if (hidden && hidden.hidden) {
          result.hiddenCount += 1;
          addUniqueFolderId(result.hiddenFolderIds, hidden.folderId);
        } else if (hidden && hidden.alreadyHidden) {
          result.alreadyHiddenCount += 1;
        } else {
          result.hideSkippedCount += 1;
          result.hideWarningCount += 1;
          addFolderDeleteReceiptHideCode(result, 'warnings', cleanString(hidden && hidden.status) || 'folder-delete-receipt-hide-skipped');
        }
        if (hidden && hidden.trustedDesktopReceiptWithoutLocalRequest) {
          result.trustedDesktopReceiptWithoutLocalRequestCount += 1;
        }
        result.receiptRows.push(folderDeleteReceiptHideDiagnosticRow(target.receipt, {
          hidden: !!(hidden && hidden.hidden),
          alreadyHidden: !!(hidden && hidden.alreadyHidden),
          status: cleanString(hidden && hidden.status),
          trustedDesktopReceiptWithoutLocalRequest: !!(target && target.trustedDesktopReceiptWithoutLocalRequest),
          pendingDeleteConfirmedByDesktopReceipt: !!(hidden && hidden.pendingDeleteConfirmedByDesktopReceipt),
        }));
      } catch (error) {
        pushError('folder-delete-receipt-hide', error);
        result.hideSkippedCount += 1;
        result.hideBlockerCount += 1;
        addFolderDeleteReceiptHideCode(result, 'blockers', 'folder-delete-receipt-hide-failed');
        result.skippedReceipts.push(folderDeleteReceiptHideDiagnosticRow(receipts[i], {
          reason: 'folder-delete-receipt-hide-failed',
        }));
      }
    }
    result.ok = result.hideBlockerCount === 0;
    return result;
  }

  function mergeFolderDeleteReceiptHideResult(receiptImport, hideResult) {
    var base = Object.assign({}, safeObject(receiptImport));
    var hide = safeObject(hideResult);
    base.phase = 'phase4c.4c';
    base.hiddenCount = numberOrZero(hide.hiddenCount);
    base.alreadyHiddenCount = numberOrZero(hide.alreadyHiddenCount);
    base.hideSkippedCount = numberOrZero(hide.hideSkippedCount);
    base.hideBlockerCount = numberOrZero(hide.hideBlockerCount);
    base.hideWarningCount = numberOrZero(hide.hideWarningCount);
    base.trustedDesktopReceiptWithoutLocalRequestCount = numberOrZero(hide.trustedDesktopReceiptWithoutLocalRequestCount);
    base.receiptRows = Array.isArray(hide.receiptRows) ? hide.receiptRows.slice(0, 120) : [];
    base.skippedReceipts = Array.isArray(hide.skippedReceipts) ? hide.skippedReceipts.slice(0, 120) : [];
    base.visibleStateOnlyHide = true;
    base.noFolderHide = base.hiddenCount > 0 || base.alreadyHiddenCount > 0 ? false : base.noFolderHide !== false;
    base.noTombstoneApply = true;
    base.noTombstoneCreate = true;
    base.noHardDelete = true;
    base.noChatDelete = true;
    base.noAssetDelete = true;
    base.noBindingMutation = true;
    base.noChatMutation = true;
    base.noSnapshotMutation = true;
    base.noDestructiveFolderMutation = true;
    base.tombstonePropagation = 'deferred';
    base.warnings = (Array.isArray(base.warnings) ? base.warnings.slice() : []).concat(Array.isArray(hide.warnings) ? hide.warnings : []);
    base.blockers = (Array.isArray(base.blockers) ? base.blockers.slice() : []).concat(Array.isArray(hide.blockers) ? hide.blockers : []);
    base.warningCount = base.warnings.length || numberOrZero(base.warningCount);
    base.blockerCount = base.blockers.length || numberOrZero(base.blockerCount);
    base.ok = base.ok !== false && base.blockerCount === 0 && hide.ok !== false;
    return base;
  }

  function mergeFolderDeleteReceiptHideSummary(metadataSummary, hideResult) {
    var summary = Object.assign({}, safeObject(metadataSummary));
    var hide = safeObject(hideResult);
    var changedFolderIds = Array.isArray(summary.changedFolderIds) ? summary.changedFolderIds.slice() : [];
    var changedFields = Array.isArray(summary.changedFields) ? summary.changedFields.slice() : [];
    var hiddenIds = Array.isArray(hide.hiddenFolderIds) ? hide.hiddenFolderIds : [];
    hiddenIds.forEach(function (folderId) { addUniqueFolderId(changedFolderIds, folderId); });
    if (numberOrZero(hide.hiddenCount) > 0) addUnique(changedFields, 'delete-receipt-hide');
    summary.changedFolderIds = changedFolderIds;
    summary.changedFields = changedFields;
    summary.changedFolderCount = changedFolderIds.length || (numberOrZero(summary.changedFolderCount) + numberOrZero(hide.hiddenCount));
    if (numberOrZero(hide.hiddenCount) > 0) {
      summary.hasDeleteReceiptHide = true;
      summary.hasOnlyVisualUpdates = false;
    }
    return summary;
  }

  function normalizeFolderRestoreReceiptForChromeReShow(receiptInput) {
    var receipt = safeObject(receiptInput);
    var folderId = normalizeFolderRecordId(receipt.folderId);
    if (cleanString(receipt.schema) !== FOLDER_RESTORE_RECEIPT_SCHEMA) return { ok: false, code: 'restore-receipt-schema-invalid' };
    if (cleanString(receipt.status) !== 'restored') return { ok: false, code: 'restore-receipt-status-not-restored' };
    if (cleanString(receipt.decision) !== 'desktop-folder-restored') return { ok: false, code: 'restore-receipt-decision-invalid' };
    if (receipt.statusOnly !== true) return { ok: false, code: 'restore-receipt-not-status-only' };
    if (receipt.noTombstoneApply !== true) return { ok: false, code: 'restore-receipt-tombstone-apply-not-blocked' };
    if (receipt.noHardDelete !== true) return { ok: false, code: 'restore-receipt-hard-delete-not-blocked' };
    if (receipt.noChatDelete !== true) return { ok: false, code: 'restore-receipt-chat-delete-not-blocked' };
    if (!folderId) return { ok: false, code: 'restore-receipt-folder-identity-missing' };
    return {
      ok: true,
      receipt: Object.assign({}, receipt, {
        folderId: folderId,
        receiptId: cleanString(receipt.receiptId),
        tombstoneId: cleanString(receipt.tombstoneId),
        folderName: cleanString(receipt.folderName),
        restoredAt: cleanString(receipt.restoredAt),
        requestId: cleanString(receipt.requestId || receipt.reviewId),
        reviewId: cleanString(receipt.reviewId || receipt.requestId),
      })
    };
  }

  function makeFolderRestoreReceiptImportResult() {
    return {
      schema: FOLDER_RESTORE_RECEIPT_SCHEMA + '.chrome-import',
      phase: 'phase4d.2',
      attempted: true,
      ok: true,
      found: 0,
      receiptCount: 0,
      reShownCount: 0,
      alreadyVisibleCount: 0,
      skippedCount: 0,
      malformedCount: 0,
      blockerCount: 0,
      warningCount: 0,
      importedRestoreReceiptCount: 0,
      confirmedRestoreRequestCount: 0,
      staleRestoreRequestCount: 0,
      restoreReceiptRequestIdMismatchCount: 0,
      sameFolderPendingRestoreResolvedCount: 0,
      visibleStateOnlyReShow: true,
      noChromeRestoreAuthority: true,
      noTombstoneApply: true,
      noTombstoneCreate: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noFolderDestructiveMutation: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      tombstonePropagation: 'deferred',
      reShownFolderIds: [],
      alreadyVisibleFolderIds: [],
      receiptRows: [],
      skippedReceipts: [],
      warnings: [],
      blockers: []
    };
  }

  function addFolderRestoreReceiptCode(result, field, code) {
    var list = Array.isArray(result && result[field]) ? result[field] : null;
    var c = cleanString(code);
    if (!list || !c) return;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].code === c) {
        list[i].count = numberOrZero(list[i].count || 1) + 1;
        return;
      }
    }
    list.push({ code: c });
  }

  function buildFolderRowFromRestoreReceipt(receipt, hiddenMarker) {
    var marker = safeObject(hiddenMarker);
    var folderId = normalizeFolderRecordId(receipt && receipt.folderId);
    if (!folderId) return null;
    var name = cleanString(receipt && receipt.folderName) || cleanString(marker.folderName) || folderId;
    var color = cleanString(receipt && (receipt.color || receipt.iconColor)) || cleanString(marker.color || marker.iconColor);
    var restoredAt = cleanString(receipt && receipt.restoredAt) || nowIso();
    var sourceKind = cleanString(marker.sourceKind || marker.kind || safeObject(marker.meta).sourceKind || safeObject(marker.meta).kind || 'desktop-folder-restore-receipt');
    var row = {
      id: folderId,
      folderId: folderId,
      name: name,
      title: name,
      kind: sourceKind,
      source: 'desktop-folder-restore-receipt',
      sourceKind: sourceKind,
      stateSource: 'stored-folder-state',
      materializedUserFolder: true,
      trustedFolderDisplay: true,
      shownInNormalMode: true,
      restoredByDesktopReceipt: true,
      hidden: false,
      deletedByDesktopReceipt: false,
      receiptId: cleanString(receipt && receipt.receiptId),
      tombstoneId: cleanString(receipt && receipt.tombstoneId),
      updatedAt: restoredAt,
      meta: Object.assign({}, safeObject(marker.meta), {
        source: 'desktop-folder-restore-receipt',
        sourceKind: sourceKind,
        kind: sourceKind,
        stateSource: 'stored-folder-state',
        materializedUserFolder: true,
        trustedFolderDisplay: true,
        shownInNormalMode: true,
        restoredByDesktopReceipt: true,
        hiddenByDesktopReceipt: false,
        deletedByDesktopReceipt: false,
        receiptId: cleanString(receipt && receipt.receiptId),
        tombstoneId: cleanString(receipt && receipt.tombstoneId),
        restoredAt: restoredAt,
        statusOnly: true,
        noTombstoneApply: true,
        noHardDelete: true,
        noChatDelete: true,
        tombstonePropagation: 'deferred'
      })
    };
    if (color) {
      row.color = color;
      row.iconColor = color;
    }
    return row;
  }

  async function reShowFolderByDesktopRestoreReceiptInMirror(receipt) {
    var folderId = normalizeFolderRecordId(receipt && receipt.folderId);
    if (!folderId) return { ok: false, reShown: false, status: 'restore-receipt-folder-identity-missing' };
    var current = safeObject(await readKv(FOLDER_STATE_KEY_LOCAL));
    var rows = Array.isArray(current.folders) ? current.folders : [];
    var visibleIndex = -1;
    for (var i = 0; i < rows.length; i += 1) {
      if (normalizeFolderRecordId(folderMetadataRowId(rows[i])) === folderId) {
        visibleIndex = i;
        break;
      }
    }
    if (visibleIndex !== -1) {
      return {
        ok: true,
        reShown: false,
        alreadyVisible: true,
        status: 'folder-restore-receipt-folder-already-visible',
        writesPerformed: 0,
        folderId: folderId
      };
    }

    var hidden = safeObject(current.hiddenByDesktopReceipt);
    var marker = safeObject(hidden[folderId]);
    if (!marker.hiddenByDesktopReceipt && !marker.deletedByDesktopReceipt) {
      return {
        ok: false,
        reShown: false,
        status: 'folder-restore-receipt-hidden-row-missing',
        writesPerformed: 0,
        folderId: folderId
      };
    }

    var row = buildFolderRowFromRestoreReceipt(receipt, marker);
    if (!row) {
      return {
        ok: false,
        reShown: false,
        status: 'folder-restore-receipt-row-build-failed',
        writesPerformed: 0,
        folderId: folderId
      };
    }
    var next = cloneJson(current) || {};
    var nextRows = Array.isArray(next.folders) ? next.folders.slice() : [];
    nextRows.push(row);
    next.folders = nextRows;
    var nextItems = Object.assign({}, safeObject(next.items));
    if (!Array.isArray(nextItems[folderId])) nextItems[folderId] = [];
    next.items = nextItems;
    var nextHidden = Object.assign({}, safeObject(next.hiddenByDesktopReceipt));
    delete nextHidden[folderId];
    next.hiddenByDesktopReceipt = nextHidden;
    var restored = Object.assign({}, safeObject(next.restoredByDesktopReceipt));
    restored[folderId] = {
      folderId: folderId,
      receiptId: cleanString(receipt.receiptId),
      tombstoneId: cleanString(receipt.tombstoneId),
      requestId: cleanString(receipt.requestId || receipt.reviewId),
      reviewId: cleanString(receipt.reviewId || receipt.requestId),
      restoredAt: cleanString(receipt.restoredAt) || nowIso(),
      statusOnly: true,
      noChromeRestoreAuthority: true,
      noTombstoneApply: true,
      noHardDelete: true,
      noChatDelete: true,
      tombstonePropagation: 'deferred'
    };
    next.restoredByDesktopReceipt = restored;
    next.updatedAt = nowIso();
    await writeKv(FOLDER_STATE_KEY_LOCAL, next);
    return {
      ok: true,
      reShown: true,
      alreadyVisible: false,
      status: 'folder-restore-receipt-folder-re-shown',
      writesPerformed: 1,
      folderId: folderId
    };
  }

  function mergeFolderRestoreReceiptReviewImport(result, reviewImport) {
    var target = result || makeFolderRestoreReceiptImportResult();
    var review = safeObject(reviewImport);
    target.reviewStoreImportAttempted = review.attempted === true || !!review.schema;
    target.reviewStoreImportOk = review.ok !== false;
    target.importedRestoreReceiptCount = numberOrZero(review.importedRestoreReceiptCount || review.resolvedCount || review.alreadyResolvedCount);
    target.confirmedRestoreRequestCount = numberOrZero(review.confirmedRestoreRequestCount ||
      (numberOrZero(review.resolvedCount) + numberOrZero(review.alreadyResolvedCount)));
    target.staleRestoreRequestCount = numberOrZero(review.staleRestoreRequestCount || review.trustedDesktopReceiptWithoutLocalRequestCount);
    target.restoreReceiptRequestIdMismatchCount = numberOrZero(review.restoreReceiptRequestIdMismatchCount);
    target.sameFolderPendingRestoreResolvedCount = numberOrZero(review.sameFolderPendingRestoreResolvedCount);
    target.receiptRows = Array.isArray(review.receiptRows) ? review.receiptRows.slice(0, 100) : target.receiptRows;
    target.skippedReceipts = Array.isArray(review.skippedReceipts) ? review.skippedReceipts.slice(0, 100) : target.skippedReceipts;
    (Array.isArray(review.warnings) ? review.warnings : []).forEach(function (warning) {
      addFolderRestoreReceiptCode(target, 'warnings', warning && (warning.code || warning));
    });
    (Array.isArray(review.blockers) ? review.blockers : []).forEach(function (blocker) {
      addFolderRestoreReceiptCode(target, 'blockers', blocker && (blocker.code || blocker));
    });
    target.warningCount = target.warnings.length || numberOrZero(target.warningCount);
    target.blockerCount = target.blockers.length || numberOrZero(target.blockerCount);
    target.ok = target.blockerCount === 0 && review.ok !== false;
    return target;
  }

  async function importFolderRestoreReceiptConfirmationsIntoReviewStore(bundle) {
    var receipts = Array.isArray(bundle && bundle.folderRestoreReceipts) ? bundle.folderRestoreReceipts : [];
    if (!receipts.length) {
      return {
        ok: true,
        attempted: true,
        found: 0,
        receiptCount: 0,
        importedRestoreReceiptCount: 0,
        confirmedRestoreRequestCount: 0,
        staleRestoreRequestCount: 0,
        restoreReceiptRequestIdMismatchCount: 0,
        warnings: [],
        blockers: [],
      };
    }
    try {
      var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
      if (!reviews || typeof reviews.ingestFolderRestoreReceipts !== 'function') {
        return {
          ok: true,
          attempted: false,
          found: receipts.length,
          receiptCount: receipts.length,
          importedRestoreReceiptCount: 0,
          confirmedRestoreRequestCount: 0,
          staleRestoreRequestCount: 0,
          restoreReceiptRequestIdMismatchCount: 0,
          warnings: [{ code: 'folder-restore-receipt-store-unavailable' }],
          blockers: [],
        };
      }
      return await reviews.ingestFolderRestoreReceipts(bundle, {
        source: 'latest.json',
        noChromeRestoreAuthority: true,
        noTombstoneApply: true,
      });
    } catch (error) {
      pushError('folder-restore-receipt-review-import', error);
      return {
        ok: false,
        attempted: true,
        found: receipts.length,
        receiptCount: receipts.length,
        importedRestoreReceiptCount: 0,
        confirmedRestoreRequestCount: 0,
        staleRestoreRequestCount: 0,
        restoreReceiptRequestIdMismatchCount: 0,
        warnings: [],
        blockers: [{ code: 'folder-restore-receipt-review-import-failed' }],
      };
    }
  }

  async function importFolderRestoreReceiptsFromDesktopBundle(bundle) {
    var result = makeFolderRestoreReceiptImportResult();
    var receipts = Array.isArray(bundle && bundle.folderRestoreReceipts) ? bundle.folderRestoreReceipts : [];
    result.found = receipts.length;
    result.receiptCount = receipts.length;
    var reviewImport = await importFolderRestoreReceiptConfirmationsIntoReviewStore(bundle);
    result = mergeFolderRestoreReceiptReviewImport(result, reviewImport);
    if (!receipts.length) {
      state.lastFolderRestoreReceiptImport = result;
      return result;
    }
    for (var i = 0; i < receipts.length; i += 1) {
      try {
        var normalized = normalizeFolderRestoreReceiptForChromeReShow(receipts[i]);
        if (!normalized.ok) {
          result.malformedCount += 1;
          result.skippedCount += 1;
          result.warningCount += 1;
          addFolderRestoreReceiptCode(result, 'warnings', normalized.code || 'folder-restore-receipt-malformed');
          continue;
        }
        var reShow = await reShowFolderByDesktopRestoreReceiptInMirror(normalized.receipt);
        if (reShow && reShow.reShown) {
          result.reShownCount += 1;
          addUniqueFolderId(result.reShownFolderIds, reShow.folderId);
        } else if (reShow && reShow.alreadyVisible) {
          result.alreadyVisibleCount += 1;
          addUniqueFolderId(result.alreadyVisibleFolderIds, reShow.folderId);
        } else {
          result.skippedCount += 1;
          result.warningCount += 1;
          addFolderRestoreReceiptCode(result, 'warnings', cleanString(reShow && reShow.status) || 'folder-restore-receipt-skipped');
        }
      } catch (error) {
        pushError('folder-restore-receipt-import', error);
        result.skippedCount += 1;
        result.blockerCount += 1;
        addFolderRestoreReceiptCode(result, 'blockers', 'folder-restore-receipt-import-failed');
      }
    }
    result.warningCount = result.warnings.length || result.warningCount;
    result.blockerCount = result.blockers.length || result.blockerCount;
    result.ok = result.blockerCount === 0;
    state.lastFolderRestoreReceiptImport = result;
    return result;
  }

  function makeChatFolderBindingReceiptImportResult() {
    return {
      schema: CHAT_FOLDER_BINDING_RECEIPT_SCHEMA + '.chrome-import',
      phase: 'phase-b9',
      ok: true,
      attempted: true,
      found: 0,
      receiptCount: 0,
      importedChatFolderBindingReceiptCount: 0,
      confirmedChatFolderBindingRequestCount: 0,
      staleChatFolderBindingRequestCount: 0,
      requestIdMismatchCount: 0,
      skippedCount: 0,
      malformedCount: 0,
      blockerCount: 0,
      warningCount: 0,
      noChromeBindingAuthority: true,
      noChromeDestructiveBindingApply: true,
      noBindingMutation: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      warnings: [],
      blockers: [],
      receiptRows: [],
      skippedReceipts: [],
    };
  }

  function addChatFolderBindingReceiptCode(result, bucket, code) {
    var c = cleanString(code);
    if (!c || !result || !Array.isArray(result[bucket])) return;
    if (!result[bucket].some(function (row) { return row && row.code === c; })) {
      result[bucket].push({ code: c });
    }
  }

  function mergeChatFolderBindingReceiptReviewImport(result, reviewImport) {
    var target = result || makeChatFolderBindingReceiptImportResult();
    var review = safeObject(reviewImport);
    target.reviewStoreImportAttempted = review.attempted === true || !!review.schema;
    target.reviewStoreImportOk = review.ok !== false;
    target.importedChatFolderBindingReceiptCount = numberOrZero(review.importedChatFolderBindingReceiptCount || review.resolvedCount || review.alreadyResolvedCount);
    target.confirmedChatFolderBindingRequestCount = numberOrZero(review.confirmedChatFolderBindingRequestCount ||
      (numberOrZero(review.resolvedCount) + numberOrZero(review.alreadyResolvedCount)));
    target.staleChatFolderBindingRequestCount = numberOrZero(review.staleChatFolderBindingRequestCount || review.trustedDesktopReceiptWithoutLocalRequestCount);
    target.requestIdMismatchCount = numberOrZero(review.requestIdMismatchCount);
    target.receiptRows = Array.isArray(review.receiptRows) ? review.receiptRows.slice(0, 100) : target.receiptRows;
    target.skippedReceipts = Array.isArray(review.skippedReceipts) ? review.skippedReceipts.slice(0, 100) : target.skippedReceipts;
    (Array.isArray(review.warnings) ? review.warnings : []).forEach(function (warning) {
      addChatFolderBindingReceiptCode(target, 'warnings', warning && (warning.code || warning));
    });
    (Array.isArray(review.blockers) ? review.blockers : []).forEach(function (blocker) {
      addChatFolderBindingReceiptCode(target, 'blockers', blocker && (blocker.code || blocker));
    });
    target.warningCount = target.warnings.length || numberOrZero(target.warningCount);
    target.blockerCount = target.blockers.length || numberOrZero(target.blockerCount);
    target.ok = target.blockerCount === 0 && review.ok !== false;
    return target;
  }

  async function importChatFolderBindingReceiptsFromDesktopBundle(bundle) {
    var result = makeChatFolderBindingReceiptImportResult();
    var receipts = Array.isArray(bundle && bundle.chatFolderBindingReceipts) ? bundle.chatFolderBindingReceipts : [];
    result.found = receipts.length;
    result.receiptCount = receipts.length;
    if (!receipts.length) {
      state.lastChatFolderBindingReceiptImport = result;
      return result;
    }
    try {
      var reviews = H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
      if (!reviews || typeof reviews.ingestChatFolderBindingReceipts !== 'function') {
        result.warningCount = 1;
        addChatFolderBindingReceiptCode(result, 'warnings', 'chat-folder-binding-receipt-store-unavailable');
        state.lastChatFolderBindingReceiptImport = result;
        return result;
      }
      var reviewImport = await reviews.ingestChatFolderBindingReceipts(bundle, {
        source: 'latest.json',
        noChromeBindingAuthority: true,
        noChromeDestructiveBindingApply: true,
        noBindingMutation: true,
      });
      result = mergeChatFolderBindingReceiptReviewImport(result, reviewImport);
      state.lastChatFolderBindingReceiptImport = result;
      return result;
    } catch (error) {
      pushError('chat-folder-binding-receipt-import', error);
      result.ok = false;
      result.blockerCount = 1;
      addChatFolderBindingReceiptCode(result, 'blockers', 'chat-folder-binding-receipt-import-failed');
      state.lastChatFolderBindingReceiptImport = result;
      return result;
    }
  }

  function mergeFolderRestoreReceiptReShowSummary(metadataSummary, restoreResult) {
    var summary = Object.assign({}, safeObject(metadataSummary));
    var restore = safeObject(restoreResult);
    var changedFolderIds = Array.isArray(summary.changedFolderIds) ? summary.changedFolderIds.slice() : [];
    var changedFields = Array.isArray(summary.changedFields) ? summary.changedFields.slice() : [];
    var reShownIds = Array.isArray(restore.reShownFolderIds) ? restore.reShownFolderIds : [];
    reShownIds.forEach(function (folderId) { addUniqueFolderId(changedFolderIds, folderId); });
    if (numberOrZero(restore.reShownCount) > 0) addUnique(changedFields, 'restore-receipt-re-show');
    summary.changedFolderIds = changedFolderIds;
    summary.changedFields = changedFields;
    summary.changedFolderCount = changedFolderIds.length || (numberOrZero(summary.changedFolderCount) + numberOrZero(restore.reShownCount));
    if (numberOrZero(restore.reShownCount) > 0) {
      summary.hasRestoreReceiptReShow = true;
      summary.hasOnlyVisualUpdates = false;
    }
    return summary;
  }

  function dispatchFolderMetadataChangedEvent(summary, reason, mode) {
    try {
      global.dispatchEvent(new CustomEvent('evt:h2o:folder-metadata:changed', {
        detail: {
          source: 'desktop-to-chrome-import',
          reason: cleanString(reason) || 'sync-folder-import',
          refreshMode: cleanString(mode),
          changedFolderCount: numberOrZero(summary && summary.changedFolderCount),
          changedFolderIds: Array.isArray(summary && summary.changedFolderIds) ? summary.changedFolderIds.slice() : [],
          changedFields: Array.isArray(summary && summary.changedFields) ? summary.changedFields.slice() : [],
          t: Date.now(),
        },
      }));
    } catch (error) {
      pushError('dispatch-folder-metadata-changed', error);
    }
  }

  function recordChromePostImportRefresh(mode, summary, refreshError, bundleExportedAt, options) {
    var opts = safeObject(options);
    var safeSummary = safeObject(summary);
    var cleanMode = cleanString(mode) || 'unknown';
    var refreshSuppressed = opts.refreshSuppressed === true;
    state.lastDesktopToChromeRenderRefreshedAt = nowIso();
    state.lastDesktopToChromeRefreshMode = cleanMode;
    state.lastDesktopToChromeChangedFolderCount = numberOrZero(safeSummary.changedFolderCount);
    state.lastDesktopToChromeChangedFields = Array.isArray(safeSummary.changedFields) ? safeSummary.changedFields.slice() : [];
    state.lastDesktopToChromeChangedFolderIds = Array.isArray(safeSummary.changedFolderIds) ? safeSummary.changedFolderIds.slice() : [];
    state.lastDesktopToChromePostImportRefreshError = cleanString(refreshError);
    state.lastChromePostImportRefreshMode = cleanMode;
    state.lastChromePostImportRefreshAt = state.lastDesktopToChromeRenderRefreshedAt;
    state.lastChromePostImportRefreshError = state.lastDesktopToChromePostImportRefreshError;
    state.lastChromePostImportRenderRefreshCount = numberOrZero(opts.renderRefreshCount);
    state.lastChromePostImportRefreshSuppressed = refreshSuppressed;
    if (refreshSuppressed) state.chromePostImportRefreshSuppressedCount += 1;
    state.lastChromePostImportChangedFolderCount = state.lastDesktopToChromeChangedFolderCount;
    state.lastChromePostImportChangedFields = state.lastDesktopToChromeChangedFields.slice();
    state.lastChromePostImportChangedFolderIds = state.lastDesktopToChromeChangedFolderIds.slice();
    var exportedMs = parseTimeMs(bundleExportedAt);
    var renderMs = parseTimeMs(state.lastDesktopToChromeRenderRefreshedAt);
    state.lastDesktopToChromeTotalPropagationMs = exportedMs && renderMs ? Math.max(0, renderMs - exportedMs) : 0;
  }

  async function prepareChromeFolderDisplayModel(reason) {
    if (H2O.Library && H2O.Library.FolderParity && typeof H2O.Library.FolderParity.getDisplayModel === 'function') {
      await H2O.Library.FolderParity.getDisplayModel({
        fresh: true,
        reason: 'desktop-to-chrome-post-import-refresh:' + (cleanString(reason) || 'sync-folder-import'),
      });
    }
  }

  function updateFolderRowNode(node, row) {
    if (!node || !row) return false;
    var folderId = folderMetadataRowId(row);
    var name = folderMetadataRowName(row);
    var color = folderMetadataRowColor(row);
    if (!folderId) return false;
    if (name) {
      node.setAttribute('data-h2o-folder-name', name);
      node.setAttribute('data-h2o-folder-normalized-name', name.replace(/\s+/g, ' ').toLowerCase());
      node.setAttribute('title', name);
      node.setAttribute('aria-label', name);
      var label = node.querySelector && node.querySelector('.wbSidebarSectionItemLabel');
      if (label) {
        if (label.children && label.children.length) label.children[0].textContent = name;
        else label.textContent = name;
      }
    }
    if (color) {
      node.setAttribute('data-color', color);
      node.setAttribute('data-h2o-folder-color', color);
      try { node.style.setProperty('--wb-sidebar-item-color', color); } catch (_) { /* ignore */ }
    } else {
      node.removeAttribute('data-color');
      node.removeAttribute('data-h2o-folder-color');
      try { node.style.removeProperty('--wb-sidebar-item-color'); } catch (_) { /* ignore */ }
    }
    if (node.querySelectorAll) {
      node.querySelectorAll('.wbSidebarSectionItemMenu').forEach(function (button) {
        button.setAttribute('data-h2o-folder-id', folderId);
        if (name) button.setAttribute('data-h2o-folder-name', name);
        if (color) button.setAttribute('data-h2o-folder-color', color);
        else button.removeAttribute('data-h2o-folder-color');
      });
    }
    return true;
  }

  function applyTargetedFolderRowRefresh(summary) {
    var doc = global.document;
    if (!doc || !doc.querySelectorAll) return { attempted: false, updated: 0, missing: numberOrZero(summary && summary.changedFolderCount) };
    var rows = Array.isArray(summary && summary.rows) ? summary.rows : [];
    var nodes = Array.prototype.slice.call(doc.querySelectorAll('[data-h2o-folder-sidebar-row="1"], .wbSidebarSectionItem--folders[data-section="folders"]'));
    var updated = 0;
    var missing = 0;
    rows.forEach(function (entry) {
      var folderId = cleanString(entry && entry.folderId);
      if (!folderId) return;
      var matched = false;
      nodes.forEach(function (node) {
        var nodeId = cleanString(node.getAttribute && (node.getAttribute('data-h2o-folder-id') || node.getAttribute('data-id')));
        if (nodeId !== folderId) return;
        matched = updateFolderRowNode(node, entry.row) || matched;
      });
      if (matched) updated += 1;
      else missing += 1;
    });
    return { attempted: true, updated: updated, missing: missing };
  }

  async function applyFreshTargetedFolderRowRefresh(summary, reason) {
    await prepareChromeFolderDisplayModel(reason);
    state.chromePostImportRenderRefreshCount += 1;
    return applyTargetedFolderRowRefresh(summary);
  }

  function scheduleChromeTargetedFolderRefreshRetry(summary, reason, bundleExportedAt) {
    var safeSummary = safeObject(summary);
    if (!numberOrZero(safeSummary.changedFolderCount)) return false;
    try {
      if (state.chromePostImportRefreshRetryTimer) {
        global.clearTimeout(state.chromePostImportRefreshRetryTimer);
      }
    } catch (_) { /* ignore */ }
    state.chromePostImportRefreshRetryTimer = global.setTimeout(function () {
      state.chromePostImportRefreshRetryTimer = null;
      applyFreshTargetedFolderRowRefresh(safeSummary, (cleanString(reason) || 'sync-folder-import') + ':targeted-retry')
        .then(function (targeted) {
          var retryMode = targeted && targeted.attempted && targeted.missing === 0 && targeted.updated >= numberOrZero(safeSummary.changedFolderCount)
            ? 'targeted-folder-refresh'
            : 'targeted-folder-refresh-missing';
          recordChromePostImportRefresh(retryMode, safeSummary, '', bundleExportedAt, {
            renderRefreshCount: 1,
            refreshSuppressed: false
          });
          dispatchFolderMetadataChangedEvent(safeSummary, reason, retryMode);
        })
        .catch(function (error) {
          var refreshError = String(error && (error.message || error));
          pushError('desktop-to-chrome-post-import-refresh.retry', error);
          recordChromePostImportRefresh('targeted-folder-refresh-error', safeSummary, refreshError, bundleExportedAt, {
            renderRefreshCount: 0,
            refreshSuppressed: false
          });
          dispatchFolderMetadataChangedEvent(safeSummary, reason, 'targeted-folder-refresh-error');
        });
    }, CHROME_TARGETED_REFRESH_RETRY_MS);
    return true;
  }

  async function refreshChromeFolderUiAfterDesktopImport(summary, reason, bundleExportedAt) {
    var cleanReason = cleanString(reason) || 'sync-folder-import';
    var safeSummary = safeObject(summary);
    var changedCount = numberOrZero(safeSummary.changedFolderCount);
    var mode = changedCount ? 'targeted-folder-refresh' : 'no-folder-metadata-change';
    var refreshError = '';
    var renderCountBefore = state.chromePostImportRenderRefreshCount;
    var refreshSuppressed = changedCount === 0;
    try {
      if (changedCount && safeSummary.hasOnlyVisualUpdates === true) {
        var targeted = await applyFreshTargetedFolderRowRefresh(safeSummary, cleanReason);
        if (!targeted.attempted || targeted.missing > 0 || targeted.updated < changedCount) {
          mode = scheduleChromeTargetedFolderRefreshRetry(safeSummary, cleanReason, bundleExportedAt)
            ? 'targeted-folder-refresh-deferred'
            : 'targeted-folder-refresh-missing';
        } else {
          mode = 'targeted-folder-refresh';
        }
      } else if (changedCount) {
        await prepareChromeFolderDisplayModel(cleanReason);
        if (H2O.Library && H2O.Library.SidebarSections && typeof H2O.Library.SidebarSections.refresh === 'function') {
          await H2O.Library.SidebarSections.refresh();
          state.chromePostImportRenderRefreshCount += 1;
          mode = 'sidebar-refresh';
        } else {
          global.dispatchEvent(new CustomEvent('evt:h2o:folders:changed', {
            detail: { source: 'desktop-to-chrome-import', reason: cleanReason, t: Date.now() },
          }));
          state.chromePostImportRenderRefreshCount += 1;
          mode = 'full-refresh-fallback';
        }
      }
    } catch (error) {
      refreshError = String(error && (error.message || error));
      pushError('desktop-to-chrome-post-import-refresh', error);
      mode = mode === 'targeted-folder-refresh' ? 'targeted-folder-refresh-error' : mode;
      refreshSuppressed = false;
    }
    var renderRefreshCount = Math.max(0, state.chromePostImportRenderRefreshCount - renderCountBefore);
    recordChromePostImportRefresh(mode, safeSummary, refreshError, bundleExportedAt, {
      renderRefreshCount: renderRefreshCount,
      refreshSuppressed: refreshSuppressed
    });
    dispatchFolderMetadataChangedEvent(safeSummary, cleanReason, mode);
    return {
      mode: mode,
      changedFolderCount: changedCount,
      changedFields: state.lastDesktopToChromeChangedFields.slice(),
      changedFolderIds: state.lastDesktopToChromeChangedFolderIds.slice(),
      renderRefreshedAt: state.lastDesktopToChromeRenderRefreshedAt,
      renderRefreshCount: renderRefreshCount,
      cumulativeRenderRefreshCount: state.chromePostImportRenderRefreshCount,
      refreshSuppressed: refreshSuppressed,
      totalPropagationMs: state.lastDesktopToChromeTotalPropagationMs,
      error: refreshError,
    };
  }

  function importCounts(importResult, dryRun) {
    var chats = safeObject(importResult && importResult.chats);
    var planChats = safeObject(dryRun && dryRun.plan && dryRun.plan.chats);
    var planStorage = safeObject(dryRun && dryRun.plan && dryRun.plan.chromeStorageLocal);
    var planKv = safeObject(dryRun && dryRun.plan && dryRun.plan.libraryKv);
    var skippedChats = numberOrZero(planChats.willSkipDuplicates);
    var skippedStorage = numberOrZero(planStorage.willSkipDuplicates);
    var skippedKv = numberOrZero(planKv.willSkipDuplicates);
    return {
      importedChats: numberOrZero(chats.importedChats),
      importedSnapshots: numberOrZero(chats.importedSnapshots),
      skipped: skippedChats + skippedStorage + skippedKv,
      skippedDetails: {
        chats: skippedChats,
        chromeStorageLocal: skippedStorage,
        libraryKv: skippedKv,
      },
    };
  }

  async function connectFolder() {
    if (typeof global.showDirectoryPicker !== 'function') {
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        status: 'file-system-access-unavailable',
      };
    }
    try {
      var handle = await global.showDirectoryPicker({ mode: 'read' });
      var permission = await requestReadPermission(handle);
      state.permission = permission;
      if (permission !== 'granted') {
        return {
          ok: false,
          phase: PHASE,
          mode: MODE,
          permission: permission,
          status: 'sync-folder-permission-denied',
        };
      }
      var connectedAt = nowIso();
      await idbPut(IDB_KEY, {
        handle: handle,
        name: cleanString(handle && handle.name),
        connectedAt: connectedAt,
      });
      state.handle = handle;
      state.loaded = true;
      state.folderName = cleanString(handle && handle.name);
      state.connectedAt = connectedAt;
      state.lastSyncStatus = 'sync-folder-connected';
      state.lastSyncError = '';
      await persistState({ connected: true, permission: permission });
      if (state.autoSyncEnabled) {
        startDesktopLatestPoller('folder-connected');
        scheduleAutoSync('folder-connected').catch(function (autoError) { pushError('auto-sync.folder-connected', autoError); });
      }
      return {
        ok: true,
        phase: PHASE,
        mode: MODE,
        folderName: state.folderName,
        permission: permission,
        status: 'sync-folder-connected',
      };
    } catch (error) {
      state.lastSyncStatus = 'sync-folder-connect-failed';
      state.lastSyncError = String(error && (error.message || error));
      pushError('connect-folder', error);
      try { await persistState({ connected: false, lastSyncStatus: state.lastSyncStatus, lastSyncError: state.lastSyncError }); }
      catch (_) { /* ignore */ }
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        error: state.lastSyncError,
        status: 'sync-folder-connect-failed',
      };
    }
  }

  async function disconnectFolder() {
    clearAutoSyncTimer();
    clearDesktopLatestPollTimer();
    try { await idbDelete(IDB_KEY); }
    catch (error) { pushError('disconnect-folder', error); }
    state.handle = null;
    state.loaded = true;
    state.folderName = '';
    state.connectedAt = '';
    state.permission = 'unknown';
    state.lastSyncStatus = 'sync-folder-disconnected';
    state.lastSyncError = '';
    await persistState({ connected: false, folderName: '', connectedAt: '' });
    return {
      ok: true,
      phase: PHASE,
      mode: MODE,
      connected: false,
      status: 'sync-folder-disconnected',
    };
  }

  function hasFolder() {
    return !!state.handle;
  }

  function getConnectedDirectoryHandle() {
    return state.handle || null;
  }

  /* Permission escalation belongs to this explicit product gesture. It never
   * writes a delivery slot or publication ledger; after a successful grant it
   * only asks the existing canonical reconciler to re-evaluate its own Auto
   * authority and normal publication path. */
  async function authorizeChromePublishing() {
    var handle = state.handle;
    if (!handle) {
      return Object.freeze({
        ok: false,
        permission: 'not-checked',
        authorized: false,
        scheduled: false,
        status: 'sync-folder-not-connected'
      });
    }
    var permission = await queryReadWritePermission(handle);
    var requested = false;
    if (permission !== 'granted') {
      if (typeof handle.requestPermission !== 'function') {
        return Object.freeze({
          ok: false,
          permission: 'unavailable',
          authorized: false,
          requested: false,
          scheduled: false,
          status: 'chrome-publishing-authorization-unavailable'
        });
      }
      requested = true;
      try {
        permission = await handle.requestPermission({ mode: 'readwrite' });
      } catch (error) {
        pushError('authorize-chrome-publishing', error);
        permission = 'unavailable';
      }
    }
    if (permission !== 'granted') {
      return Object.freeze({
        ok: false,
        permission: permission,
        authorized: false,
        requested: requested,
        scheduled: false,
        status: permission === 'denied'
          ? 'chrome-publishing-authorization-denied'
          : (permission === 'unavailable'
            ? 'chrome-publishing-authorization-unavailable'
            : 'chrome-publishing-authorization-required')
      });
    }
    var reconciler = H2O.Studio.sync && H2O.Studio.sync.objectAutoReconcile;
    var scheduled = !!reconciler &&
      typeof reconciler.scheduleReconcile === 'function' &&
      reconciler.scheduleReconcile('chrome-publishing-authorization-granted') === true;
    return Object.freeze({
      ok: true,
      permission: 'granted',
      authorized: true,
      requested: requested,
      scheduled: scheduled,
      status: 'chrome-publishing-authorized'
    });
  }

  async function enableAutoSync() {
    await loadStoredHandle();
    state.autoSyncEnabled = true;
    state.lastAutoSyncStatus = 'auto-sync-enabled';
    state.lastAutoSyncError = '';
    bindAutoSyncEvents();
    startDesktopLatestPoller('enable-auto-sync');
    await persistState({
      autoSyncEnabled: true,
      lastAutoSyncStatus: state.lastAutoSyncStatus,
      lastAutoSyncError: '',
    });
    return {
      ok: true,
      phase: PHASE,
      mode: MODE,
      enabled: true,
      connected: !!state.handle,
      minIntervalMs: AUTO_SYNC_MIN_INTERVAL_MS,
      triggerDelayMs: AUTO_SYNC_DELAY_MS,
      bootDelayMs: AUTO_SYNC_BOOT_DELAY_MS,
      backgroundAutoImport: false,
      chromeWritesSyncFolder: false,
      status: 'auto-sync-enabled',
    };
  }

  async function disableAutoSync() {
    clearAutoSyncTimer();
    clearDesktopLatestPollTimer();
    state.autoSyncEnabled = false;
    state.lastAutoSyncStatus = 'auto-sync-disabled';
    state.lastAutoSyncError = '';
    await persistState({
      autoSyncEnabled: false,
      lastAutoSyncStatus: state.lastAutoSyncStatus,
      lastAutoSyncError: '',
    });
    return {
      ok: true,
      phase: PHASE,
      mode: MODE,
      enabled: false,
      scheduled: false,
      status: 'auto-sync-disabled',
    };
  }

  function isAutoSyncEnabled() {
    return !!state.autoSyncEnabled;
  }

  async function runAutoSync(reason) {
    var cleanReason = cleanString(reason) || state.autoSyncScheduledReason || 'auto-sync';
    if (objectProtocolOwnsAutomaticMutation()) {
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: false,
        autoSync: true,
        reason: cleanReason,
        status: 'object-protocol-auto-owner',
      };
    }
    if (!state.autoSyncEnabled) {
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: false,
        autoSync: true,
        reason: cleanReason,
        status: 'auto-sync-disabled',
      };
    }
    await loadStoredHandle();
    if (!state.handle) {
      state.lastAutoSyncStatus = 'auto-sync-folder-not-connected';
      state.lastAutoSyncError = '';
      await persistState({ lastAutoSyncStatus: state.lastAutoSyncStatus, lastAutoSyncError: '' });
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: true,
        connected: false,
        autoSync: true,
        reason: cleanReason,
        status: 'auto-sync-folder-not-connected',
      };
    }
    if (state.autoSyncRunning || state.syncInFlight) {
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: true,
        autoSync: true,
        reason: cleanReason,
        status: 'auto-sync-in-flight',
      };
    }
    var permission = await queryPermission(state.handle);
    state.permission = permission;
    if (permission !== 'granted') {
      state.lastAutoSyncAttemptAt = Date.now();
      state.lastAutoSyncAt = nowIso();
      state.lastAutoSyncReason = cleanReason;
      state.lastAutoSyncStatus = 'auto-sync-reconnect-required';
      state.lastAutoSyncError = 'read permission not granted';
      await persistState({
        permission: permission,
        lastAutoSyncAttemptAt: state.lastAutoSyncAttemptAt,
        lastAutoSyncAt: state.lastAutoSyncAt,
        lastAutoSyncReason: state.lastAutoSyncReason,
        lastAutoSyncStatus: state.lastAutoSyncStatus,
        lastAutoSyncError: state.lastAutoSyncError,
      });
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: true,
        autoSync: true,
        permission: permission,
        reason: cleanReason,
        error: state.lastAutoSyncError,
        status: 'auto-sync-reconnect-required',
      };
    }

    state.autoSyncRunning = true;
    state.lastAutoSyncAttemptAt = Date.now();
    state.lastAutoSyncReason = cleanReason;
    try {
      var result = await syncNow({ autoSync: true, reason: cleanReason });
      state.lastAutoSyncAt = nowIso();
      state.lastAutoSyncStatus = cleanString(result && result.status) || (result && result.ok ? 'auto-sync-ok' : 'auto-sync-failed');
      state.lastAutoSyncError = cleanString(result && (
        result.error ||
        result.reason ||
        (Array.isArray(result.blockers) ? result.blockers.join(',') : '')
      ));
      await persistState({
        lastAutoSyncAttemptAt: state.lastAutoSyncAttemptAt,
        lastAutoSyncAt: state.lastAutoSyncAt,
        lastAutoSyncReason: state.lastAutoSyncReason,
        lastAutoSyncStatus: state.lastAutoSyncStatus,
        lastAutoSyncError: state.lastAutoSyncError,
      });
      return Object.assign({}, result || {}, {
        autoSync: true,
        autoSyncReason: cleanReason,
        lastAutoSyncAt: state.lastAutoSyncAt,
      });
    } catch (error) {
      state.lastAutoSyncAt = nowIso();
      state.lastAutoSyncStatus = 'auto-sync-failed';
      state.lastAutoSyncError = String(error && (error.message || error));
      pushError('run-auto-sync', error);
      await persistState({
        lastAutoSyncAttemptAt: state.lastAutoSyncAttemptAt,
        lastAutoSyncAt: state.lastAutoSyncAt,
        lastAutoSyncReason: state.lastAutoSyncReason,
        lastAutoSyncStatus: state.lastAutoSyncStatus,
        lastAutoSyncError: state.lastAutoSyncError,
      });
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: true,
        autoSync: true,
        reason: cleanReason,
        error: state.lastAutoSyncError,
        status: state.lastAutoSyncStatus,
      };
    } finally {
      state.autoSyncRunning = false;
    }
  }

  async function scheduleAutoSync(reason) {
    var cleanReason = cleanString(reason) || 'auto-sync';
    await loadStoredHandle();
    if (objectProtocolOwnsAutomaticMutation()) {
      clearAutoSyncTimer();
      clearDesktopLatestPollTimer();
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: false,
        scheduled: false,
        reason: cleanReason,
        status: 'object-protocol-auto-owner',
      };
    }
    if (!state.autoSyncEnabled) {
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: false,
        scheduled: false,
        reason: cleanReason,
        status: 'auto-sync-disabled',
      };
    }
    if (!state.handle) {
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: true,
        connected: false,
        scheduled: false,
        reason: cleanReason,
        status: 'auto-sync-folder-not-connected',
      };
    }
    if (state.autoSyncRunning || state.syncInFlight) {
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: true,
        scheduled: false,
        reason: cleanReason,
        status: 'auto-sync-in-flight',
      };
    }
    var nowMs = Date.now();
    var remaining = throttleRemainingMs(nowMs);
    if (remaining > 0 && !isFastDesktopLatestChangeReason(cleanReason)) {
      state.lastAutoSyncStatus = 'auto-sync-throttled';
      state.lastAutoSyncReason = cleanReason;
      await persistState({
        lastAutoSyncReason: state.lastAutoSyncReason,
        lastAutoSyncStatus: state.lastAutoSyncStatus,
      });
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        enabled: true,
        scheduled: false,
        reason: cleanReason,
        throttleRemainingMs: remaining,
        minIntervalMs: AUTO_SYNC_MIN_INTERVAL_MS,
        status: 'auto-sync-throttled',
      };
    }
    if (state.autoSyncTimer) {
      state.autoSyncScheduledReason = cleanReason;
      return {
        ok: true,
        phase: PHASE,
        mode: MODE,
        enabled: true,
        scheduled: true,
        reason: cleanReason,
        status: 'auto-sync-already-scheduled',
      };
    }

    state.autoSyncScheduledAt = nowMs;
    state.autoSyncScheduledReason = cleanReason;
    state.lastAutoSyncReason = cleanReason;
    state.lastAutoSyncStatus = 'auto-sync-scheduled';
    await persistState({
      lastAutoSyncReason: cleanReason,
      lastAutoSyncStatus: state.lastAutoSyncStatus,
    });
    state.autoSyncTimer = global.setTimeout(function () {
      state.autoSyncTimer = null;
      runAutoSync(state.autoSyncScheduledReason || cleanReason).catch(function (error) {
        pushError('scheduled-auto-sync', error);
      });
    }, AUTO_SYNC_DELAY_MS);
    return {
      ok: true,
      phase: PHASE,
      mode: MODE,
      enabled: true,
      scheduled: true,
      reason: cleanReason,
      delayMs: AUTO_SYNC_DELAY_MS,
      minIntervalMs: AUTO_SYNC_MIN_INTERVAL_MS,
      status: 'auto-sync-scheduled',
    };
  }

  function status() {
    return {
      ok: true,
      phase: PHASE,
      mode: MODE,
      surface: 'chrome-mv3',
      loaded: !!state.loaded,
      connected: !!state.handle,
      folderName: state.folderName,
      permission: state.permission,
      latestFile: LATEST_FILE,
      chromeLatestFile: CHROME_LATEST_FILE,
      desktopChromePropagationSchema: PROPAGATION_SCHEMA,
      desktopChromePropagationVersion: F19_DESKTOP_CHROME_VERSION,
      /* F3.1: expose lastAppliedExportId so consumers can see which producer
       * export this peer most recently applied. The value is already read
       * from bundle.exportId at line ~969, persisted to chrome.storage.local
       * via persistState(), and restored on boot via loadState(). diagnose()
       * wraps status() with Object.assign, so it automatically picks this up. */
      lastAppliedExportId: state.lastAppliedExportId,
      lastAppliedExportedAt: state.lastAppliedExportedAt,
      lastAppliedAt: state.lastAppliedAt,
      lastChecksum: state.lastChecksum,
      lastSyncStatus: state.lastSyncStatus,
      lastSyncError: state.lastSyncError,
      syncInFlight: !!state.syncInFlight,
      autoSyncEnabled: !!state.autoSyncEnabled,
      autoSyncEventsBound: !!state.autoSyncEventsBound,
      autoSyncScheduled: !!state.autoSyncTimer,
      autoSyncRunning: !!state.autoSyncRunning,
      autoSyncMinIntervalMs: AUTO_SYNC_MIN_INTERVAL_MS,
      autoSyncDelayMs: AUTO_SYNC_DELAY_MS,
      desktopLatestPollingEnabled: !!state.desktopLatestPollTimer,
      desktopLatestPollIntervalMs: DESKTOP_LATEST_POLL_INTERVAL_MS,
      desktopLatestPollRunning: !!state.desktopLatestPollRunning,
      lastDesktopLatestPollAt: state.lastDesktopLatestPollAt,
      lastDesktopLatestPollStatus: state.lastDesktopLatestPollStatus,
      lastDesktopLatestPollError: state.lastDesktopLatestPollError,
      lastDesktopLatestPollDetectedAt: state.lastDesktopLatestPollDetectedAt,
      lastDesktopLatestPollFileLastModified: state.lastDesktopLatestPollFileLastModified,
      lastDesktopLatestPollFileSize: state.lastDesktopLatestPollFileSize,
      desktopToChromeLatency: {
        desktopMutationAt: state.lastDesktopToChromeExportWrittenAt,
        desktopExportWrittenAt: state.lastDesktopToChromeExportWrittenAt,
        chromeImportStartedAt: state.lastDesktopToChromeImportStartedAt,
        chromeImportAppliedAt: state.lastDesktopToChromeImportAppliedAt,
        chromeRenderRefreshedAt: state.lastDesktopToChromeRenderRefreshedAt,
        totalPropagationMs: state.lastDesktopToChromeTotalPropagationMs,
        postImportRefreshMode: state.lastDesktopToChromeRefreshMode,
        chromePostImportRefreshMode: state.lastChromePostImportRefreshMode,
        chromePostImportRefreshAt: state.lastChromePostImportRefreshAt,
        changedFolderCount: state.lastDesktopToChromeChangedFolderCount,
        changedFields: state.lastDesktopToChromeChangedFields.slice(),
        changedFolderIds: state.lastDesktopToChromeChangedFolderIds.slice(),
        renderRefreshCount: state.lastChromePostImportRenderRefreshCount,
        cumulativeRenderRefreshCount: state.chromePostImportRenderRefreshCount,
        refreshSuppressed: state.lastChromePostImportRefreshSuppressed,
        refreshSuppressedCount: state.chromePostImportRefreshSuppressedCount,
        postImportRefreshError: state.lastDesktopToChromePostImportRefreshError,
        loopSuppressed: state.loopSuppressedCount,
        duplicateSkipped: state.duplicateSkippedCount,
        selfOriginSkipped: state.selfOriginSkippedCount,
      },
      chromePostImportRefreshMode: state.lastChromePostImportRefreshMode,
      changedFolderCount: state.lastChromePostImportChangedFolderCount,
      folderDeleteReceiptImport: state.lastFolderDeleteReceiptImport || null,
      folderRestoreReceiptImport: state.lastFolderRestoreReceiptImport || null,
      chatFolderBindingReceiptImport: state.lastChatFolderBindingReceiptImport || null,
      libraryMetadataMutationReceiptImport: state.lastLibraryMetadataMutationReceiptImport || null,
      desktopCanonicalRecentlyDeleted: state.desktopCanonicalRecentlyDeleted || null,
      desktopPurgedFolderSuppression: state.desktopPurgedFolderSuppression || null,
      desktopCanonicalLibraryMetadata: state.desktopCanonicalLibraryMetadata || null,
      desktopCanonicalLibraryMetadataImport: summarizeDesktopCanonicalLibraryMetadata(state.desktopCanonicalLibraryMetadata),
      renderRefreshCount: state.lastChromePostImportRenderRefreshCount,
      cumulativeRenderRefreshCount: state.chromePostImportRenderRefreshCount,
      refreshSuppressed: state.lastChromePostImportRefreshSuppressed,
      refreshSuppressedCount: state.chromePostImportRefreshSuppressedCount,
      loopSuppressed: state.loopSuppressedCount,
      duplicateSkipped: state.duplicateSkippedCount,
      selfOriginSkipped: state.selfOriginSkippedCount,
      lastAutoSyncAttemptAt: state.lastAutoSyncAttemptAt,
      lastAutoSyncAt: state.lastAutoSyncAt,
      lastAutoSyncReason: state.lastAutoSyncReason,
      lastAutoSyncStatus: state.lastAutoSyncStatus,
      lastAutoSyncError: state.lastAutoSyncError,
      chromeExportPending: !!state.chromeExportPending,
      chromeExportInFlight: !!state.chromeExportInFlight,
      chromeExportInFlightPersisted: !!state.chromeExportInFlight,
      chromeExportInFlightMemory: !!state.chromeExportInFlight,
      chromeExportInFlightAgeMs: chromeExportInFlightAgeMs(),
      chromeExportInFlightStaleMs: CHROME_EXPORT_IN_FLIGHT_STALE_MS,
      chromeExportStaleLockCleared: false,
      chromeExportLastStaleLockClearedAt: state.chromeExportLastStaleLockClearedAt,
      chromeExportLastStaleLockClearedReason: state.chromeExportLastStaleLockClearedReason,
      chromeExportLockOwner: cleanString(state.chromeExportInFlightOwner),
      chromeExportLockReason: cleanString(state.chromeExportInFlightReason),
      chromeExportDebounceMs: CHROME_EXPORT_DEBOUNCE_MS,
      chromeExportScheduledAt: state.chromeExportScheduledAt,
      chromeExportScheduledReason: state.chromeExportScheduledReason,
      lastExportStatus: state.lastChromeExportStatus,
      lastExportedAt: state.lastChromeExportAt,
      lastExportFile: state.lastChromeExportFile,
      lastExportBytes: state.lastChromeExportBytes,
      lastExportError: state.lastChromeExportError,
      lastExportReason: state.lastChromeExportReason,
      lastExportPermission: state.lastChromeExportPermission,
      lastExportBlockers: state.lastChromeExportBlockers.slice(),
      backgroundAutoImport: false,
      chromeWritesSyncFolder: state.lastChromeExportStatus === 'chrome-to-desktop-exported' ||
        (!!state.handle && getChromeExportWriteGate().effectiveFlagEnabled === true),
      chromeDesktopExportApiAvailable: !!getChromeAutoImportApi(),
    };
  }

  async function getReadinessSnapshot(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var readinessApi = H2O.Studio.sync && H2O.Studio.sync.readiness;
    if (!readinessApi || typeof readinessApi.deriveSnapshot !== 'function') {
      throw new Error('sync-readiness-derivation-unavailable');
    }
    await loadStoredHandle();
    /* Live query wins over any historical/null status. Never request from a
     * diagnostic read: requestPermission remains user-gesture-only. */
    var permission = state.handle ? await queryPermission(state.handle) : 'not-checked';
    var publishingPermission = state.handle
      ? await queryReadWritePermission(state.handle)
      : 'not-checked';
    state.permission = permission;
    var normalizedPermission = readinessApi.normalizePermission(permission);
    var platform = H2O.Studio && H2O.Studio.platform;
    var storage = { ready: true, backend: 'chrome', status: 'ready' };
    if (platform && typeof platform.whenStorageAuthorityReady === 'function') {
      try { storage = await platform.whenStorageAuthorityReady(); }
      catch (_) { storage = { ready: false, backend: 'unavailable', status: 'unavailable' }; }
    }
    var connected = !!state.handle;
    var prerequisitesSatisfied = connected && normalizedPermission === 'granted';
    /* Focus/visibility listeners are the scheduler authority. The polling
     * timer is intentionally paused while the document is hidden, which must
     * not falsely relabel configured automation as permanently inactive. */
    var schedulerActive = !!state.autoSyncEventsBound;
    var reason = !state.autoSyncEnabled ? 'not-configured'
      : (!connected ? 'folder-not-connected'
        : (normalizedPermission !== 'granted' ? (normalizedPermission === 'prompt'
          ? 'permission-required' : 'permission-' + normalizedPermission)
          : (!schedulerActive ? 'scheduler-not-running' : '')));
    return readinessApi.deriveSnapshot({
      foundation: {
        uiMounted: opts.uiMounted === true,
        runtimeLoaded: true,
        storage: storage,
        identity: { required: false, ready: false, canonical: false, status: 'not-applicable' },
      },
      localFolder: {
        configValid: false,
        authorizationValid: false,
        authorizationStatus: 'not-applicable',
      },
      browserDelivery: {
        handlePresent: connected,
        permission: normalizedPermission,
        publishingPermission: readinessApi.normalizePermission(publishingPermission),
        livePermission: connected,
        deliveryAvailable: typeof syncNow === 'function',
        operation: {
          state: state.syncInFlight || state.autoSyncRunning ? 'in-flight'
            : (state.lastSyncError || state.lastAutoSyncError ? 'error' : 'idle'),
          reason: state.lastSyncError || state.lastAutoSyncError || '',
          lastActivity: state.lastAutoSyncAt || state.lastAppliedAt || null,
        },
      },
      webdav: {
        descriptorValid: false,
        credentialsReady: false,
        reachabilityReady: false,
        reason: 'desktop-only',
      },
      automation: {
        chromeAutoImport: {
          configured: state.autoSyncEnabled === true,
          prerequisitesSatisfied: prerequisitesSatisfied,
          schedulerActive: schedulerActive,
          reason: reason,
          lastActivity: state.lastAutoSyncAt || state.lastAppliedAt || null,
          operation: { state: state.autoSyncRunning ? 'in-flight' : 'idle' },
        },
      },
      archiveRecovery: {
        available: false,
        ready: false,
        reason: 'not-assessed-m2',
      },
    });
  }

  function tombstoneReviewIngestUnavailable(code) {
    return {
      attempted: true,
      dryRun: false,
      ok: false,
      found: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      selfOriginatedIgnored: 0,
      malformed: 0,
      unsupported: 0,
      failed: 0,
      warnings: [{ code: cleanString(code) || 'tombstone-review-store-unavailable' }],
    };
  }

  function folderDeleteReceiptImportUnavailable(code) {
    return {
      schema: FOLDER_DELETE_RECEIPT_SCHEMA + '.import',
      phase: 'phase4c.4b',
      attempted: true,
      ok: false,
      found: 0,
      receiptCount: 0,
      resolvedCount: 0,
      alreadyResolvedCount: 0,
      skippedCount: 0,
      malformedCount: 0,
      blockerCount: 1,
      warningCount: 1,
      noFolderHide: true,
      hiddenCount: 0,
      alreadyHiddenCount: 0,
      hideSkippedCount: 0,
      hideBlockerCount: 0,
      hideWarningCount: 0,
      visibleStateOnlyHide: true,
      noTombstoneApply: true,
      noTombstoneCreate: true,
      noHardDelete: true,
      noChatDelete: true,
      noAssetDelete: true,
      noFolderMutation: true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      noDestructiveFolderMutation: true,
      tombstonePropagation: 'deferred',
      blockers: [{ code: cleanString(code) || 'folder-delete-receipt-store-unavailable' }],
      warnings: [{ code: cleanString(code) || 'folder-delete-receipt-store-unavailable' }],
    };
  }

  function normalizeFolderDeleteReceiptImportResult(raw) {
    var r = safeObject(raw);
    var warnings = Array.isArray(r.warnings)
      ? r.warnings.map(function (warning) {
        var out = { code: cleanString(warning && warning.code) || 'warning' };
        if (warning && warning.count != null) out.count = numberOrZero(warning.count);
        return out;
      }).filter(function (warning) { return warning.code; })
      : [];
    var blockers = Array.isArray(r.blockers)
      ? r.blockers.map(function (blocker) {
        var out = { code: cleanString(blocker && blocker.code) || 'blocker' };
        if (blocker && blocker.count != null) out.count = numberOrZero(blocker.count);
        return out;
      }).filter(function (blocker) { return blocker.code; })
      : [];
    return {
      schema: cleanString(r.schema || (FOLDER_DELETE_RECEIPT_SCHEMA + '.import')),
      phase: cleanString(r.phase || 'phase4c.4b'),
      attempted: r.attempted !== false,
      ok: r.ok !== false && blockers.length === 0,
      found: numberOrZero(r.found),
      receiptCount: numberOrZero(r.receiptCount),
      resolvedCount: numberOrZero(r.resolvedCount),
      alreadyResolvedCount: numberOrZero(r.alreadyResolvedCount),
      skippedCount: numberOrZero(r.skippedCount),
      malformedCount: numberOrZero(r.malformedCount),
      blockerCount: blockers.length || numberOrZero(r.blockerCount),
      warningCount: warnings.length || numberOrZero(r.warningCount),
      noFolderHide: r.noFolderHide === false ? false : true,
      hiddenCount: numberOrZero(r.hiddenCount),
      alreadyHiddenCount: numberOrZero(r.alreadyHiddenCount),
      hideSkippedCount: numberOrZero(r.hideSkippedCount),
      hideBlockerCount: numberOrZero(r.hideBlockerCount),
      hideWarningCount: numberOrZero(r.hideWarningCount),
      trustedDesktopReceiptWithoutLocalRequestCount: numberOrZero(r.trustedDesktopReceiptWithoutLocalRequestCount),
      visibleStateOnlyHide: r.visibleStateOnlyHide === true,
      noTombstoneApply: true,
      noTombstoneCreate: true,
      noHardDelete: true,
      noChatDelete: true,
      noAssetDelete: true,
      noFolderMutation: r.noFolderMutation === false ? false : true,
      noBindingMutation: true,
      noChatMutation: true,
      noSnapshotMutation: true,
      noDestructiveFolderMutation: true,
      tombstonePropagation: 'deferred',
      receiptRows: Array.isArray(r.receiptRows) ? r.receiptRows.slice(0, 120).map(function (row) {
        return {
          receiptId: cleanString(row && row.receiptId),
          requestId: cleanString(row && row.requestId),
          reviewId: cleanString(row && row.reviewId),
          folderId: cleanString(row && row.folderId),
          folderName: cleanString(row && row.folderName),
          status: cleanString(row && row.status),
          source: cleanString(row && row.source),
          trustedDesktopReceiptWithoutLocalRequest: row && row.trustedDesktopReceiptWithoutLocalRequest === true,
          pendingDeleteConfirmedByDesktopReceipt: row && row.pendingDeleteConfirmedByDesktopReceipt === true,
          hidden: row && row.hidden === true,
          alreadyHidden: row && row.alreadyHidden === true,
        };
      }) : [],
      skippedReceipts: Array.isArray(r.skippedReceipts) ? r.skippedReceipts.slice(0, 120).map(function (row) {
        return {
          receiptId: cleanString(row && row.receiptId),
          requestId: cleanString(row && row.requestId),
          reviewId: cleanString(row && row.reviewId),
          folderId: cleanString(row && row.folderId),
          reason: cleanString(row && row.reason),
        };
      }) : [],
      warnings: warnings,
      blockers: blockers,
    };
  }

  async function ingestFolderDeleteReceiptsFromDesktopBundle(bundle, options) {
    var receipts = Array.isArray(bundle && bundle.folderDeleteReceipts) ? bundle.folderDeleteReceipts : [];
    if (!receipts.length) {
      var empty = normalizeFolderDeleteReceiptImportResult({
        schema: FOLDER_DELETE_RECEIPT_SCHEMA + '.import',
        phase: 'phase4c.4b',
        attempted: true,
        ok: true,
        found: 0,
        receiptCount: 0,
        noFolderHide: true,
        noTombstoneApply: true,
      });
      state.lastFolderDeleteReceiptImport = empty;
      return empty;
    }
    try {
      var reviews = H2O && H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
      if (!reviews || typeof reviews.ingestFolderDeleteReceipts !== 'function') {
        var unavailable = folderDeleteReceiptImportUnavailable('folder-delete-receipt-store-unavailable');
        state.lastFolderDeleteReceiptImport = unavailable;
        return unavailable;
      }
      var result = await reviews.ingestFolderDeleteReceipts(bundle, {
        source: 'latest.json',
        syncReason: cleanString(options && options.reason),
        bundleExportId: cleanString(bundle && bundle.exportId),
        bundleSourceSyncPeerId: cleanString(bundle && bundle.sourceSyncPeerId),
      });
      var normalized = normalizeFolderDeleteReceiptImportResult(result);
      state.lastFolderDeleteReceiptImport = normalized;
      return normalized;
    } catch (error) {
      pushError('folder-delete-receipt-import', error);
      var failed = folderDeleteReceiptImportUnavailable('folder-delete-receipt-import-failed');
      state.lastFolderDeleteReceiptImport = failed;
      return failed;
    }
  }

  function normalizeTombstoneReviewIngestResult(raw) {
    var r = safeObject(raw);
    return {
      attempted: true,
      dryRun: false,
      ok: r.ok !== false,
      found: numberOrZero(r.found),
      inserted: numberOrZero(r.inserted),
      updated: numberOrZero(r.updated),
      skipped: numberOrZero(r.skipped),
      selfOriginatedIgnored: numberOrZero(r.selfOriginatedIgnored),
      malformed: numberOrZero(r.malformed),
      unsupported: numberOrZero(r.unsupported),
      failed: numberOrZero(r.failed),
      warnings: Array.isArray(r.warnings)
        ? r.warnings.map(function (warning) {
          var out = { code: cleanString(warning && warning.code) || 'warning' };
          if (warning && warning.count != null) out.count = numberOrZero(warning.count);
          return out;
        }).filter(function (warning) { return warning.code; })
        : [],
    };
  }

  async function maybeIngestTombstoneReviews(bundle, options) {
    var opts = safeObject(options);
    if (opts.ingestTombstoneReviews !== true) return null;
    try {
      var reviews = H2O && H2O.Studio && H2O.Studio.store && H2O.Studio.store.tombstoneReviews;
      if (!reviews || typeof reviews.ingestBundleTombstones !== 'function') {
        return tombstoneReviewIngestUnavailable('tombstone-review-store-unavailable');
      }
      var result = await reviews.ingestBundleTombstones(bundle, {
        source: 'chrome-folder-sync',
        dryRun: false,
        allowSelfOrigin: false,
        syncReason: cleanString(opts.reason),
        bundleExportId: cleanString(bundle && bundle.exportId),
        bundleSourceSyncPeerId: cleanString(bundle && bundle.sourceSyncPeerId),
      });
      return normalizeTombstoneReviewIngestResult(result);
    } catch (error) {
      pushError('tombstone-review-ingest', error);
      return tombstoneReviewIngestUnavailable('tombstone-review-ingest-failed');
    }
  }

  function normalizeSyncDirection(value) {
    return cleanString(value).toLowerCase().replace(/_/g, '-');
  }

  function wantsChromeToDesktopExport(options) {
    var opts = safeObject(options);
    var direction = normalizeSyncDirection(opts.direction || opts.syncDirection || opts.transportDirection);
    return direction === 'chrome-to-desktop' || direction === 'chrome-to-desktop-export';
  }

  function getChromeAutoImportApi() {
    try {
      var sync = H2O && H2O.Studio && H2O.Studio.sync;
      var autoImport = sync && sync.autoImport;
      return autoImport && typeof autoImport.exportNow === 'function' ? autoImport : null;
    } catch (_) {
      return null;
    }
  }

  function getChromeExportWriteGate() {
    try {
      var autoImport = getChromeAutoImportApi();
      if (autoImport && typeof autoImport.diagnoseChromeExportWriteGate === 'function') {
        return safeObject(autoImport.diagnoseChromeExportWriteGate());
      }
    } catch (error) {
      pushError('chrome-export-write-gate', error);
    }
    return {
      schema: 'h2o.studio.sync.chrome-export-write-gate.v1',
      flagKey: 'sync.chromeAutoImport',
      effectiveFlagEnabled: false,
      blockers: ['chrome-export-write-gate-unavailable'],
      privacy: { redacted: true },
    };
  }

  function normalizeBlockers(value) {
    return Array.isArray(value)
      ? value.map(cleanString).filter(Boolean).slice(0, 8)
      : [];
  }

  function chromeExportInFlightAgeMs(now) {
    if (!state.chromeExportInFlight || !state.chromeExportInFlightStartedAt) return 0;
    return Math.max(0, Number(now || Date.now()) - Number(state.chromeExportInFlightStartedAt || 0));
  }

  function chromeExportLockDiagnostics(extra) {
    var data = safeObject(extra);
    var memoryInFlight = Object.prototype.hasOwnProperty.call(data, 'memoryInFlight')
      ? data.memoryInFlight === true
      : state.chromeExportInFlight === true;
    var ageMs = Object.prototype.hasOwnProperty.call(data, 'ageMs')
      ? Math.max(0, Number(data.ageMs) || 0)
      : chromeExportInFlightAgeMs();
    return {
      chromeExportInFlightPersisted: state.chromeExportInFlight === true,
      chromeExportInFlightMemory: memoryInFlight,
      chromeExportInFlightAgeMs: ageMs,
      chromeExportInFlightStaleMs: CHROME_EXPORT_IN_FLIGHT_STALE_MS,
      chromeExportStaleLockCleared: data.staleCleared === true,
      chromeExportLockOwner: cleanString(data.owner || state.chromeExportInFlightOwner || 'folder-import.chrome-export'),
      chromeExportLockReason: cleanString(data.reason || state.chromeExportInFlightReason),
    };
  }

  function clearStaleChromeExportLock(reason) {
    if (!state.chromeExportInFlight) return null;
    var ageMs = chromeExportInFlightAgeMs();
    if (!state.chromeExportInFlightStartedAt || ageMs < CHROME_EXPORT_IN_FLIGHT_STALE_MS) {
      return { cleared: false, ageMs: ageMs };
    }
    var previous = {
      owner: state.chromeExportInFlightOwner,
      reason: state.chromeExportInFlightReason,
      ageMs: ageMs,
    };
    state.chromeExportInFlight = false;
    state.chromeExportInFlightStartedAt = 0;
    state.chromeExportInFlightReason = '';
    state.chromeExportInFlightOwner = '';
    state.chromeExportLastStaleLockClearedAt = nowIso();
    state.chromeExportLastStaleLockClearedReason = cleanString(reason || previous.reason || 'stale-export-lock');
    return Object.assign({ cleared: true }, previous);
  }

  async function rememberChromeExportResult(result, reason) {
    var raw = safeObject(result);
    var blockers = normalizeBlockers(raw.blockers);
    state.chromeExportPending = false;
    state.chromeExportInFlight = false;
    state.chromeExportInFlightStartedAt = 0;
    state.chromeExportInFlightReason = '';
    state.chromeExportInFlightOwner = '';
    state.lastChromeExportAt = cleanString(raw.exportedAt || raw.completedAt) || nowIso();
    state.lastChromeExportReason = cleanString(reason || raw.reason || state.lastChromeExportReason);
    state.lastChromeExportStatus = cleanString(raw.status) || (raw.ok === true ? 'chrome-to-desktop-exported' : 'chrome-to-desktop-export-blocked');
    state.lastChromeExportError = cleanString(raw.error || raw.reason);
    state.lastChromeExportFile = cleanString(raw.filename || (raw.ok === true ? CHROME_LATEST_FILE : ''));
    state.lastChromeExportBytes = numberOrZero(raw.bytes);
    state.lastChromeExportPermission = cleanString(raw.permission || state.lastChromeExportPermission || state.permission || 'unknown');
    state.lastChromeExportBlockers = blockers;
    try {
      await persistState({
        chromeExportPending: false,
        chromeExportInFlight: false,
        chromeExportInFlightStartedAt: 0,
        chromeExportInFlightReason: '',
        chromeExportInFlightOwner: '',
        chromeExportLastStaleLockClearedAt: state.chromeExportLastStaleLockClearedAt,
        chromeExportLastStaleLockClearedReason: state.chromeExportLastStaleLockClearedReason,
        lastChromeExportAt: state.lastChromeExportAt,
        lastChromeExportReason: state.lastChromeExportReason,
        lastChromeExportStatus: state.lastChromeExportStatus,
        lastChromeExportError: state.lastChromeExportError,
        lastChromeExportFile: state.lastChromeExportFile,
        lastChromeExportBytes: state.lastChromeExportBytes,
        lastChromeExportPermission: state.lastChromeExportPermission,
        lastChromeExportBlockers: state.lastChromeExportBlockers.slice(),
      });
    } catch (error) { pushError('persist-chrome-export-result', error); }
    return raw;
  }

  async function recordChromeExportBlocked(reason, status, blockers, error, permission) {
    var result = Object.assign({
      ok: false,
      phase: PHASE,
      mode: MODE,
      direction: 'chrome-to-desktop',
      transport: CHROME_LATEST_FILE,
      path: syncFolderPath(CHROME_LATEST_FILE),
      autoSync: true,
      chromeWritesSyncFolder: false,
      desktopWritesSyncFolder: false,
      permission: cleanString(permission || state.permission || 'unknown'),
      blockers: normalizeBlockers(blockers),
      error: cleanString(error),
      status: cleanString(status) || 'chrome-to-desktop-export-blocked',
    }, chromeExportLockDiagnostics({
      memoryInFlight: state.chromeExportInFlight === true,
      reason: reason,
      owner: state.chromeExportInFlightOwner,
    }));
    await rememberChromeExportResult(result, reason);
    return result;
  }

  async function runChromeToDesktopExport(reason) {
    var cleanReason = cleanString(reason) || state.chromeExportScheduledReason || 'folder-metadata-auto-export';
    var staleLock = clearStaleChromeExportLock(cleanReason);
    if (state.chromeExportInFlight) {
      return Object.assign({
        ok: false,
        phase: PHASE,
        mode: MODE,
        direction: 'chrome-to-desktop',
        transport: CHROME_LATEST_FILE,
        path: syncFolderPath(CHROME_LATEST_FILE),
        autoSync: true,
        chromeWritesSyncFolder: false,
        desktopWritesSyncFolder: false,
        permission: cleanString(state.lastChromeExportPermission || state.permission || 'unknown'),
        blockers: ['chrome-to-desktop-export-in-flight'],
        error: 'export already in flight',
        status: 'export-pending',
      }, chromeExportLockDiagnostics({
        memoryInFlight: true,
        ageMs: chromeExportInFlightAgeMs(),
        reason: state.chromeExportInFlightReason || cleanReason,
        owner: state.chromeExportInFlightOwner || 'folder-import.runChromeToDesktopExport',
      }));
    }
    state.chromeExportInFlight = true;
    state.chromeExportInFlightStartedAt = Date.now();
    state.chromeExportInFlightReason = cleanReason;
    state.chromeExportInFlightOwner = 'folder-import.runChromeToDesktopExport';
    state.chromeExportPending = false;
    state.lastChromeExportAttemptAt = Date.now();
    state.lastChromeExportReason = cleanReason;
    state.lastChromeExportStatus = 'export-pending';
    state.lastChromeExportError = '';
    state.lastChromeExportBlockers = [];
    try {
      await persistState({
        chromeExportPending: false,
        chromeExportInFlight: true,
        chromeExportInFlightStartedAt: state.chromeExportInFlightStartedAt,
        chromeExportInFlightReason: state.chromeExportInFlightReason,
        chromeExportInFlightOwner: state.chromeExportInFlightOwner,
        chromeExportStaleLockCleared: !!(staleLock && staleLock.cleared),
        lastChromeExportAttemptAt: state.lastChromeExportAttemptAt,
        lastChromeExportReason: cleanReason,
        lastChromeExportStatus: state.lastChromeExportStatus,
        lastChromeExportError: '',
        lastChromeExportBlockers: [],
      });
    } catch (error) { pushError('persist-chrome-export-start', error); }

    try { await loadStoredHandle(); }
    catch (error) { pushError('chrome-auto-export.load-folder-handle', error); }
    if (!state.handle) {
      return recordChromeExportBlocked(
        cleanReason,
        'permission-required',
        ['sync-folder-not-connected', 'permission-required'],
        'sync folder not connected — use Connect Folder first',
        'unknown'
      );
    }
    var writePermission = await queryReadWritePermission(state.handle);
    state.lastChromeExportPermission = writePermission;
    if (writePermission !== 'granted') {
      return recordChromeExportBlocked(
        cleanReason,
        'permission-required',
        ['permission-required'],
        'readwrite permission not granted (got "' + writePermission + '")',
        writePermission
      );
    }
    try {
      var result = await exportChromeToSyncFolder({
        reason: cleanReason,
        autoSync: true,
        folderAutoSync: true,
        folderMutationAutoSync: true,
      });
      return result;
    } catch (error) {
      pushError('run-chrome-to-desktop-export', error);
      return recordChromeExportBlocked(
        cleanReason,
        'chrome-to-desktop-export-failed',
        ['chrome-to-desktop-export-failed'],
        String(error && (error.message || error)),
        writePermission
      );
    } finally {
      state.chromeExportInFlight = false;
      state.chromeExportInFlightStartedAt = 0;
      state.chromeExportInFlightReason = '';
      state.chromeExportInFlightOwner = '';
    }
  }

  async function scheduleChromeToDesktopExport(options) {
    var opts = typeof options === 'string' ? { reason: options } : safeObject(options);
    var cleanReason = cleanString(opts.reason) || 'folder-metadata-auto-export';
    clearChromeExportTimer();
    state.chromeExportPending = true;
    state.chromeExportScheduledAt = Date.now();
    state.chromeExportScheduledReason = cleanReason;
    state.lastChromeExportReason = cleanReason;
    state.lastChromeExportStatus = 'export-pending';
    state.lastChromeExportError = '';
    state.lastChromeExportBlockers = [];
    try {
      await persistState({
        chromeExportPending: true,
        chromeExportScheduledAt: state.chromeExportScheduledAt,
        chromeExportScheduledReason: cleanReason,
        lastChromeExportReason: cleanReason,
        lastChromeExportStatus: state.lastChromeExportStatus,
        lastChromeExportError: '',
        lastChromeExportBlockers: [],
      });
    } catch (error) { pushError('persist-chrome-export-scheduled', error); }
    state.chromeExportTimer = global.setTimeout(function () {
      state.chromeExportTimer = null;
      runChromeToDesktopExport(cleanReason).catch(function (error) {
        pushError('scheduled-chrome-export', error);
      });
    }, CHROME_EXPORT_DEBOUNCE_MS);
    return {
      ok: true,
      phase: PHASE,
      mode: MODE,
      direction: 'chrome-to-desktop',
      transport: CHROME_LATEST_FILE,
      autoSync: true,
      chromeWritesSyncFolder: false,
      scheduled: true,
      pending: true,
      reason: cleanReason,
      delayMs: CHROME_EXPORT_DEBOUNCE_MS,
      status: 'export-pending',
    };
  }

  async function exportChromeToSyncFolder(options) {
    var startedAt = Date.now();
    var opts = safeObject(options);
    if (state.syncInFlight) {
      return rememberChromeExportResult({
        ok: false,
        phase: PHASE,
        mode: MODE,
        direction: 'chrome-to-desktop',
        transport: CHROME_LATEST_FILE,
        path: syncFolderPath(CHROME_LATEST_FILE),
        autoSync: !!opts.autoSync,
        chromeWritesSyncFolder: false,
        desktopWritesSyncFolder: false,
        status: 'sync-folder-sync-in-flight',
      }, cleanString(opts.reason) || 'chrome-to-desktop-export');
    }
    try { await loadStoredHandle(); }
    catch (error) { pushError('chrome-to-desktop.load-folder-handle', error); }

    var autoImport = getChromeAutoImportApi();
    if (!autoImport) {
      return rememberChromeExportResult({
        ok: false,
        phase: PHASE,
        mode: MODE,
        direction: 'chrome-to-desktop',
        transport: CHROME_LATEST_FILE,
        path: syncFolderPath(CHROME_LATEST_FILE),
        autoSync: !!opts.autoSync,
        chromeWritesSyncFolder: false,
        desktopWritesSyncFolder: false,
        blockers: ['chrome-to-desktop-export-unavailable'],
        status: 'chrome-to-desktop-export-unavailable',
        error: 'H2O.Studio.sync.autoImport.exportNow is unavailable',
        durationMs: Date.now() - startedAt,
      }, cleanString(opts.reason) || 'chrome-to-desktop-export');
    }

    var raw;
    try {
      raw = safeObject(await autoImport.exportNow(Object.assign({}, opts, {
        direction: 'chrome-to-desktop',
        transport: CHROME_LATEST_FILE,
      })));
    } catch (error) {
      pushError('chrome-to-desktop.exportNow', error);
      raw = {
        ok: false,
        error: String(error && (error.message || error)),
        blockers: ['chrome-to-desktop-export-failed'],
        status: 'chrome-to-desktop-export-failed',
      };
    }

    var blockers = Array.isArray(raw.blockers) ? raw.blockers.slice() : [];
    if (raw.ok !== true && blockers.length === 0) {
      blockers.push(raw.flagEnabled === false
        ? 'chrome-to-desktop-export-flag-off'
        : 'chrome-to-desktop-export-failed');
    }
    var status = raw.ok === true
      ? 'chrome-to-desktop-exported'
      : (cleanString(raw.status) || blockers[0] || 'chrome-to-desktop-export-blocked');

    var normalized = Object.assign({}, raw, {
      ok: raw.ok === true,
      phase: PHASE,
      mode: MODE,
      direction: 'chrome-to-desktop',
      transport: CHROME_LATEST_FILE,
      path: cleanString(raw.path) || syncFolderPath(CHROME_LATEST_FILE),
      filename: raw.ok === true ? CHROME_LATEST_FILE : cleanString(raw.filename),
      autoSync: !!opts.autoSync,
      backgroundAutoImport: false,
      chromeWritesSyncFolder: raw.ok === true,
      desktopWritesSyncFolder: false,
      blockers: blockers,
      status: status,
      durationMs: Date.now() - startedAt,
    });
    await rememberChromeExportResult(normalized, cleanString(opts.reason) || 'chrome-to-desktop-export');
    return normalized;
  }

  async function syncNow(options) {
    var startedAt = Date.now();
    var opts = safeObject(options);
    if (wantsChromeToDesktopExport(opts)) {
      return exportChromeToSyncFolder(opts);
    }
    if (state.syncInFlight) {
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
        autoSync: !!opts.autoSync,
        status: 'sync-folder-sync-in-flight',
      };
    }
    state.syncInFlight = true;
    try {
    await loadStoredHandle();
    if (!state.handle) {
      state.lastSyncStatus = 'sync-folder-not-connected';
      state.lastSyncError = '';
      await persistState({ lastSyncStatus: state.lastSyncStatus, lastSyncError: '' });
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        path: LATEST_FILE,
        blockers: [F19_SYNC_HARDENING_CODES.syncFolderMissing],
        hardeningCode: F19_SYNC_HARDENING_CODES.syncFolderMissing,
        status: 'sync-folder-not-connected',
      };
    }

    var permission = await queryPermission(state.handle);
    state.permission = permission;
    if (permission !== 'granted') {
      state.lastSyncStatus = 'sync-folder-reconnect-required';
      state.lastSyncError = 'read permission not granted';
      await persistState({ permission: permission, lastSyncStatus: state.lastSyncStatus, lastSyncError: state.lastSyncError });
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        permission: permission,
        path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
        error: state.lastSyncError,
        blockers: [F19_SYNC_HARDENING_CODES.permissionDenied],
        hardeningCode: F19_SYNC_HARDENING_CODES.permissionDenied,
        status: 'sync-folder-reconnect-required',
      };
    }

    try {
      var fileHandle;
      try {
        fileHandle = await state.handle.getFileHandle(LATEST_FILE, { create: false });
      } catch (missingError) {
        state.lastSyncStatus = 'sync-folder-latest-missing';
        state.lastSyncError = String(missingError && (missingError.message || missingError));
        await persistState({ lastSyncStatus: state.lastSyncStatus, lastSyncError: state.lastSyncError });
        return {
          ok: false,
          phase: PHASE,
          mode: MODE,
          path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
          error: state.lastSyncError,
          blockers: [F19_SYNC_HARDENING_CODES.transportFileMissing],
          hardeningCode: F19_SYNC_HARDENING_CODES.transportFileMissing,
          status: 'sync-folder-latest-missing',
        };
      }
      var file = await fileHandle.getFile();
      var text = await file.text();
      var checksumHex = await sha256Hex(text);
      var checksum = checksumHex ? ('sha256:' + checksumHex) : '';
      var bundle;
      try {
        bundle = JSON.parse(text);
      } catch (parseError) {
        state.lastSyncStatus = 'sync-folder-latest-malformed';
        state.lastSyncError = 'latest.json parse failed: ' + String(parseError && (parseError.message || parseError));
        await persistState({
          lastSyncStatus: state.lastSyncStatus,
          lastSyncError: state.lastSyncError,
          lastChecksum: checksum,
          lastFileLastModified: numberOrZero(file.lastModified),
          lastFileSize: numberOrZero(file.size),
        });
        return {
          ok: false,
          phase: PHASE,
          mode: MODE,
          path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
          error: state.lastSyncError,
          checksum: checksum,
          fileLastModified: numberOrZero(file.lastModified),
          fileSize: numberOrZero(file.size),
          blockers: [F19_SYNC_HARDENING_CODES.transportFileMalformed],
          hardeningCode: F19_SYNC_HARDENING_CODES.transportFileMalformed,
          status: 'sync-folder-latest-malformed',
        };
      }
      try {
        validateBundle(bundle);
      } catch (schemaError) {
        state.lastSyncStatus = 'sync-folder-latest-schema-unsupported';
        state.lastSyncError = String(schemaError && (schemaError.message || schemaError));
        await persistState({
          lastSyncStatus: state.lastSyncStatus,
          lastSyncError: state.lastSyncError,
          lastChecksum: checksum,
          lastFileLastModified: numberOrZero(file.lastModified),
          lastFileSize: numberOrZero(file.size),
        });
        return {
          ok: false,
          phase: PHASE,
          mode: MODE,
          path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
          error: state.lastSyncError,
          schema: cleanString(bundle && bundle.schema),
          checksum: checksum,
          fileLastModified: numberOrZero(file.lastModified),
          fileSize: numberOrZero(file.size),
          blockers: [F19_SYNC_HARDENING_CODES.transportSchemaUnsupported],
          hardeningCode: F19_SYNC_HARDENING_CODES.transportSchemaUnsupported,
          status: 'sync-folder-latest-schema-unsupported',
        };
      }
      var folderMetadataChangeSummary = await summarizeDesktopFolderMetadataChanges(bundle);
      state.lastDesktopToChromeExportWrittenAt = cleanString(bundle.exportedAt || '');
      state.lastDesktopToChromeImportStartedAt = nowIso();
      state.lastDesktopToChromeImportAppliedAt = '';
      state.lastDesktopToChromeRenderRefreshedAt = '';
      state.lastDesktopToChromeTotalPropagationMs = 0;
      state.lastDesktopToChromeRefreshMode = '';
      state.lastDesktopToChromeChangedFolderCount = numberOrZero(folderMetadataChangeSummary.changedFolderCount);
      state.lastDesktopToChromeChangedFields = Array.isArray(folderMetadataChangeSummary.changedFields) ? folderMetadataChangeSummary.changedFields.slice() : [];
      state.lastDesktopToChromeChangedFolderIds = Array.isArray(folderMetadataChangeSummary.changedFolderIds) ? folderMetadataChangeSummary.changedFolderIds.slice() : [];
      var signature = summarySignature(bundle);
      if (opts.autoSync && checksum && state.lastChecksum && state.lastChecksum === checksum) {
        var alreadyNormalized = buildDesktopChromeSupportedBundle(bundle);
        var alreadyRowsAfter = currentLibraryIndexRowCount();
        var alreadyParity = {
          snapshotCaptured: false,
          paritySnapshotHash: '',
          parityDiagnosticReady: !!(H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.libraryParity),
          refreshSuppressed: true,
          reason: 'sync-folder-auto-skip'
        };
        var alreadyConvergence = alreadyNormalized.ok
          ? {
            ok: true,
            duplicateSkipped: true,
            blocker: '',
            reason: 'duplicate-import-idempotent'
          }
          : { ok: false, blocker: 'desktop-to-chrome-convergence-not-proven' };
        if (alreadyConvergence.ok) {
          var alreadyReceiptImport = await ingestFolderDeleteReceiptsFromDesktopBundle(bundle, opts);
          var alreadyReceiptHide = await hideFoldersAfterFolderDeleteReceipts(bundle);
          alreadyReceiptImport = mergeFolderDeleteReceiptHideResult(alreadyReceiptImport, alreadyReceiptHide);
          state.lastFolderDeleteReceiptImport = alreadyReceiptImport;
          var alreadyRefreshSummary = mergeFolderDeleteReceiptHideSummary(folderMetadataChangeSummary, alreadyReceiptHide);
          var alreadyRestoreReceiptImport = await importFolderRestoreReceiptsFromDesktopBundle(bundle);
          alreadyRefreshSummary = mergeFolderRestoreReceiptReShowSummary(alreadyRefreshSummary, alreadyRestoreReceiptImport);
          var alreadyChatFolderBindingReceiptImport = await importChatFolderBindingReceiptsFromDesktopBundle(bundle);
          var alreadyLibraryMetadataMutationReceiptImport = await importLibraryMetadataMutationReceiptsFromDesktopBundle(bundle);
          var alreadyDesktopVisibleFolderSet = importDesktopVisibleFolderSetSnapshot(bundle, nowIso());
          var alreadyDesktopVisibleSetHide = await applyDesktopVisibleSetHideOverlay(alreadyDesktopVisibleFolderSet);
          alreadyRefreshSummary = mergeDesktopVisibleSetHideSummary(alreadyRefreshSummary, alreadyDesktopVisibleSetHide);
          var alreadyDesktopCanonicalRecentlyDeleted = buildDesktopCanonicalRecentlyDeletedSnapshot(bundle, nowIso());
          var alreadyDesktopCanonicalRecentlyDeletedImport = await storeDesktopCanonicalRecentlyDeletedSnapshot(alreadyDesktopCanonicalRecentlyDeleted);
          if (alreadyDesktopCanonicalRecentlyDeletedImport.changed === true) {
            addUnique(alreadyRefreshSummary.changedFields, 'desktop-canonical-recently-deleted');
            alreadyRefreshSummary.changedFolderCount = Math.max(1, numberOrZero(alreadyRefreshSummary.changedFolderCount));
          }
          var alreadyDesktopPurgedFolderSuppression = buildDesktopPurgedFolderSuppressionSnapshot(bundle, nowIso());
          var alreadyDesktopPurgedFolderSuppressionImport = await storeDesktopPurgedFolderSuppressionSnapshot(alreadyDesktopPurgedFolderSuppression);
          if (alreadyDesktopPurgedFolderSuppressionImport.changed === true) {
            addUnique(alreadyRefreshSummary.changedFields, 'desktop-purged-folder-suppression');
            alreadyRefreshSummary.changedFolderCount = Math.max(1, numberOrZero(alreadyRefreshSummary.changedFolderCount));
          }
          var alreadyDesktopCanonicalChatFolderBindings = buildDesktopCanonicalChatFolderBindingSnapshot(bundle, nowIso());
          var alreadyDesktopCanonicalChatFolderBindingImport = await storeDesktopCanonicalChatFolderBindingSnapshot(alreadyDesktopCanonicalChatFolderBindings);
          if (alreadyDesktopCanonicalChatFolderBindingImport.changed === true) {
            addUnique(alreadyRefreshSummary.changedFields, 'desktop-canonical-chat-folder-bindings');
            alreadyRefreshSummary.changedFolderCount = Math.max(1, numberOrZero(alreadyRefreshSummary.changedFolderCount));
          }
          var alreadyDesktopCanonicalLibraryMetadata = buildDesktopCanonicalLibraryMetadataSnapshot(bundle, nowIso());
          var alreadyDesktopCanonicalLibraryMetadataImport = await storeDesktopCanonicalLibraryMetadataSnapshot(alreadyDesktopCanonicalLibraryMetadata);
          state.duplicateSkippedCount += 1;
          state.loopSuppressedCount += 1;
          var alreadyPostImportRefresh;
          if (numberOrZero(alreadyReceiptHide.hiddenCount) > 0 ||
            numberOrZero(alreadyRestoreReceiptImport.reShownCount) > 0 ||
            alreadyDesktopCanonicalRecentlyDeletedImport.changed === true ||
            alreadyDesktopPurgedFolderSuppressionImport.changed === true ||
            alreadyDesktopCanonicalChatFolderBindingImport.changed === true) {
            alreadyPostImportRefresh = await refreshChromeFolderUiAfterDesktopImport(
              alreadyRefreshSummary,
              opts.reason || 'desktop-chrome-propagation-import',
              cleanString(bundle.exportedAt || '')
            );
          } else {
            recordChromePostImportRefresh('duplicate-suppressed', alreadyRefreshSummary, '', cleanString(bundle.exportedAt || ''), {
              renderRefreshCount: 0,
              refreshSuppressed: true
            });
            alreadyPostImportRefresh = {
              mode: 'duplicate-suppressed',
              changedFolderCount: numberOrZero(alreadyRefreshSummary.changedFolderCount),
              changedFields: Array.isArray(alreadyRefreshSummary.changedFields) ? alreadyRefreshSummary.changedFields.slice() : [],
              changedFolderIds: Array.isArray(alreadyRefreshSummary.changedFolderIds) ? alreadyRefreshSummary.changedFolderIds.slice() : [],
              renderRefreshCount: 0,
              cumulativeRenderRefreshCount: state.chromePostImportRenderRefreshCount,
              refreshSuppressed: true,
              loopSuppressed: state.loopSuppressedCount,
              duplicateSkipped: state.duplicateSkippedCount
            };
          }
          var alreadyPropagation = propagationResult(true, {
            status: 'already-imported',
            sourceSummary: alreadyNormalized.sourceSummary,
            importSummary: {
              ok: true,
              mode: 'skip',
              duplicateSkipped: true,
              chromeStorageWritten: 0,
              chromeStorageSkipped: 0,
              libraryKvWritten: 0,
              libraryKvSkipped: 0,
              folderMetadataFreshness: {
                incoming: numberOrZero(folderMetadataChangeSummary.changedFolderCount),
                created: 0,
                refreshed: 0,
                skippedStale: 0,
                missingIncomingUpdatedAt: 0,
                missingExistingUpdatedAt: 0
              },
              redactedErrorCategories: []
            },
            folderDeleteReceiptImport: alreadyReceiptImport,
            folderRestoreReceiptImport: alreadyRestoreReceiptImport,
            chatFolderBindingReceiptImport: alreadyChatFolderBindingReceiptImport,
            libraryMetadataMutationReceiptImport: alreadyLibraryMetadataMutationReceiptImport,
            desktopVisibleFolderSet: alreadyDesktopVisibleFolderSet,
            desktopVisibleSetHide: alreadyDesktopVisibleSetHide,
            desktopCanonicalRecentlyDeleted: alreadyDesktopCanonicalRecentlyDeleted,
            desktopCanonicalRecentlyDeletedImport: alreadyDesktopCanonicalRecentlyDeletedImport,
            desktopPurgedFolderSuppression: alreadyDesktopPurgedFolderSuppression,
            desktopPurgedFolderSuppressionImport: alreadyDesktopPurgedFolderSuppressionImport,
            desktopCanonicalChatFolderBindings: alreadyDesktopCanonicalChatFolderBindings,
            desktopCanonicalChatFolderBindingImport: alreadyDesktopCanonicalChatFolderBindingImport,
            importedDesktopCanonicalBindingCount: numberOrZero(alreadyDesktopCanonicalChatFolderBindingImport && alreadyDesktopCanonicalChatFolderBindingImport.bindingCount),
            desktopCanonicalLibraryMetadata: alreadyDesktopCanonicalLibraryMetadata,
            desktopCanonicalLibraryMetadataImport: alreadyDesktopCanonicalLibraryMetadataImport,
            parity: alreadyParity,
            convergence: alreadyConvergence,
            postImportRefresh: alreadyPostImportRefresh,
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
          state.lastFileName = LATEST_FILE;
          state.lastFileLastModified = numberOrZero(file.lastModified);
          state.lastFileSize = numberOrZero(file.size);
          state.lastSummarySignature = signature;
          state.lastSyncStatus = 'auto-sync-latest-already-applied';
          state.lastSyncError = '';
          state.lastSyncResult = alreadyPropagation;
          state.lastChecksum = checksum;
          await persistState({
            lastSyncStatus: state.lastSyncStatus,
            lastSyncError: '',
            lastChecksum: checksum,
            lastSummarySignature: signature,
            lastFileLastModified: state.lastFileLastModified,
            lastFileSize: state.lastFileSize,
          });
          return {
            ok: true,
            phase: PHASE,
            mode: MODE,
            path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
            schema: bundle.schema,
            exportedAt: cleanString(bundle.exportedAt),
            checksum: checksum,
            fileLastModified: state.lastFileLastModified,
            fileSize: state.lastFileSize,
            summarySignature: signature,
            importedChats: 0,
            importedSnapshots: 0,
            skipped: 0,
            rowsAfter: alreadyRowsAfter,
            sourceSummary: alreadyPropagation.sourceSummary,
            importSummary: alreadyPropagation.importSummary,
            folderDeleteReceiptImport: alreadyPropagation.folderDeleteReceiptImport,
            folderRestoreReceiptImport: alreadyPropagation.folderRestoreReceiptImport,
            chatFolderBindingReceiptImport: alreadyPropagation.chatFolderBindingReceiptImport,
            libraryMetadataMutationReceiptImport: alreadyPropagation.libraryMetadataMutationReceiptImport,
            convergence: alreadyPropagation.convergence,
            desktopVisibleFolderSet: alreadyDesktopVisibleFolderSet,
            desktopVisibleSetHide: alreadyDesktopVisibleSetHide,
            desktopCanonicalRecentlyDeleted: alreadyDesktopCanonicalRecentlyDeleted,
            desktopCanonicalRecentlyDeletedImport: alreadyDesktopCanonicalRecentlyDeletedImport,
            desktopPurgedFolderSuppression: alreadyDesktopPurgedFolderSuppression,
            desktopPurgedFolderSuppressionImport: alreadyDesktopPurgedFolderSuppressionImport,
            desktopCanonicalChatFolderBindings: alreadyDesktopCanonicalChatFolderBindings,
            desktopCanonicalChatFolderBindingImport: alreadyDesktopCanonicalChatFolderBindingImport,
            importedDesktopCanonicalBindingCount: numberOrZero(alreadyDesktopCanonicalChatFolderBindingImport && alreadyDesktopCanonicalChatFolderBindingImport.bindingCount),
            desktopCanonicalLibraryMetadata: alreadyDesktopCanonicalLibraryMetadata,
            desktopCanonicalLibraryMetadataImport: alreadyDesktopCanonicalLibraryMetadataImport,
            blockers: alreadyPropagation.blockers,
            warnings: alreadyPropagation.warnings,
            redactedErrorCategories: alreadyPropagation.redactedErrorCategories,
            propagation: alreadyPropagation,
            autoSync: true,
            durationMs: Date.now() - startedAt,
            backgroundAutoImport: false,
            chromeWritesSyncFolder: false,
            status: 'auto-sync-latest-already-applied',
          };
        }
      }

      var transportBlockers = classifyIncomingDesktopTransport(bundle, checksum);
      var transportApproval = await resolveAutoSyncTransportBlockers(bundle, transportBlockers, opts);
      transportBlockers = transportApproval.blockers;
      if (transportBlockers.length > 0) {
        var transportBlockedStatus = transportApproval.conflictApprovalRequired
          ? 'conflict-approval-required'
          : 'blocked';
        var blockedPropagation = propagationResult(false, {
          status: transportBlockedStatus,
          blockers: transportBlockers,
          conflictDecision: transportApproval.conflictDecision,
          conflictApproved: transportApproval.conflictApproved,
          approvedConflictBlockers: transportApproval.approvedBlockers,
          sourceSummary: {
            schema: cleanString(bundle && bundle.schema),
            direction: 'desktop-to-chrome',
            transport: LATEST_FILE,
            hasExportId: !!(bundle && bundle.exportId),
            exportedAt: cleanString(bundle && bundle.exportedAt)
          },
          idempotency: {
            fileFingerprintChecked: true,
            alreadyImported: false,
            mergeOnly: true,
            existingRowsSkipped: true,
            protectedDomainFallbackDisabled: true
          }
        });
        state.lastFileName = LATEST_FILE;
        state.lastFileLastModified = numberOrZero(file.lastModified);
        state.lastFileSize = numberOrZero(file.size);
        state.lastSummarySignature = signature;
        state.lastSyncStatus = transportApproval.conflictApprovalRequired
          ? 'conflict-approval-required'
          : 'sync-folder-import-blocked';
        state.lastSyncError = cleanString(blockedPropagation.blockers.join(','));
        state.lastSyncResult = blockedPropagation;
        await persistState({
          lastSyncStatus: state.lastSyncStatus,
          lastSyncError: state.lastSyncError,
          lastFileLastModified: state.lastFileLastModified,
          lastFileSize: state.lastFileSize,
          lastSummarySignature: state.lastSummarySignature,
        });
        return {
          ok: false,
          phase: PHASE,
          mode: MODE,
          path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
          schema: bundle.schema,
          exportedAt: cleanString(bundle.exportedAt),
          checksum: checksum,
          fileLastModified: state.lastFileLastModified,
          fileSize: state.lastFileSize,
          summarySignature: signature,
          sourceSummary: blockedPropagation.sourceSummary,
          importSummary: blockedPropagation.importSummary,
          convergence: blockedPropagation.convergence,
          conflictDecision: blockedPropagation.conflictDecision,
          conflictApproved: blockedPropagation.conflictApproved,
          conflictApproval: blockedPropagation.conflictApproval,
          conflictApprovalRequired: transportApproval.conflictApprovalRequired === true,
          autoFolderMetadataConflictAnalysis: transportApproval.autoFolderMetadataConflictAnalysis || null,
          blockers: blockedPropagation.blockers,
          warnings: blockedPropagation.warnings,
          redactedErrorCategories: blockedPropagation.redactedErrorCategories,
          propagation: blockedPropagation,
          durationMs: Date.now() - startedAt,
          autoSync: !!opts.autoSync,
          backgroundAutoImport: false,
          chromeWritesSyncFolder: false,
          status: state.lastSyncStatus,
        };
      }

      var propagation = await importDesktopBundlePayload(bundle, {
        dryRunOnly: opts.dryRunOnly === true,
        fileFingerprint: checksum,
        reason: cleanString(opts.reason),
        autoSync: !!opts.autoSync,
        conflictDecision: transportApproval.conflictDecision,
        conflictApproved: transportApproval.conflictApproved,
        approvedConflictBlockers: transportApproval.approvedBlockers,
        autoFolderMetadataConflictAnalysis: transportApproval.autoFolderMetadataConflictAnalysis || null,
        folderMetadataChangeSummary: folderMetadataChangeSummary
      });
      if (opts.dryRunOnly) {
        state.lastSyncStatus = 'sync-folder-dry-run-ok';
        state.lastSyncError = '';
        await persistState({
          lastSyncStatus: state.lastSyncStatus,
          lastSyncError: '',
          lastChecksum: checksum,
          lastFileLastModified: numberOrZero(file.lastModified),
          lastFileSize: numberOrZero(file.size),
        });
        return {
          ok: true,
          phase: PHASE,
          mode: MODE,
          path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
          schema: bundle.schema,
          propagation: propagation,
          dryRun: propagation.importSummary && propagation.importSummary.dryRun ? propagation.importSummary.dryRun : null,
          checksum: checksum,
          status: 'sync-folder-dry-run-ok',
        };
      }

      var refreshMode = cleanString(propagation && propagation.postImportRefresh && propagation.postImportRefresh.mode);
      var refreshSuppressed = refreshMode.indexOf('targeted-folder-refresh') === 0 ||
        refreshMode === 'duplicate-suppressed' ||
        refreshMode === 'no-folder-metadata-change';
      var noOpRefreshSuppressed = refreshMode === 'duplicate-suppressed' || refreshMode === 'no-folder-metadata-change';
      var rowsAfter = refreshSuppressed
        ? currentLibraryIndexRowCount()
        : await refreshLibraryIndex('sync-folder-import');
      if (!noOpRefreshSuppressed) {
        try {
          global.dispatchEvent(new CustomEvent('evt:h2o:data:backup:imported', {
            detail: { source: 'sync-folder-import', result: propagation },
          }));
        } catch (_) { /* ignore */ }
        if (refreshMode.indexOf('targeted-folder-refresh') !== 0 && refreshMode !== 'duplicate-suppressed') {
          try {
            global.dispatchEvent(new CustomEvent('evt:h2o:library:cross-surface-sync', {
              detail: { source: 'sync-folder-import', refreshMode: refreshMode, t: Date.now() },
            }));
          } catch (_) { /* ignore */ }
        }
      }

      var importSummary = safeObject(propagation && propagation.importSummary);
      var dryRunSummary = safeObject(importSummary.dryRun);
      state.lastFileName = LATEST_FILE;
      state.lastFileLastModified = numberOrZero(file.lastModified);
      state.lastFileSize = numberOrZero(file.size);
      state.lastAppliedExportId = cleanString(bundle.exportId || '');
      state.lastAppliedExportedAt = cleanString(bundle.exportedAt || '');
      state.lastAppliedAt = nowIso();
      state.lastDesktopToChromeImportAppliedAt = state.lastAppliedAt;
      var desktopVisibleFolderSet = importDesktopVisibleFolderSetSnapshot(bundle, state.lastAppliedAt);
      state.lastChecksum = checksum || cleanString(bundle.checksum);
      state.lastSummarySignature = signature;
      state.lastSyncStatus = propagation && propagation.ok ? 'sync-folder-imported' : 'sync-folder-import-blocked';
      state.lastSyncError = propagation && propagation.ok ? '' : cleanString(propagation && propagation.blockers && propagation.blockers.join(','));
      state.lastSyncResult = propagation;
      await persistState({
        lastAppliedExportId: state.lastAppliedExportId,
        lastAppliedExportedAt: state.lastAppliedExportedAt,
        lastAppliedAt: state.lastAppliedAt,
        lastChecksum: state.lastChecksum,
        lastSummarySignature: signature,
        lastSyncStatus: state.lastSyncStatus,
        lastSyncError: state.lastSyncError,
        lastFileLastModified: state.lastFileLastModified,
        lastFileSize: state.lastFileSize,
        desktopVisibleFolderSet: desktopVisibleFolderSet,
      });

      var result = {
        ok: !!(propagation && propagation.ok),
        phase: PHASE,
        mode: MODE,
        path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
        schema: bundle.schema,
        exportedAt: cleanString(bundle.exportedAt),
        lastAppliedExportId: state.lastAppliedExportId,
        checksum: state.lastChecksum,
        fileLastModified: state.lastFileLastModified,
        fileSize: state.lastFileSize,
        summarySignature: signature,
        importedChats: numberOrZero(importSummary.importedChats),
        importedSnapshots: numberOrZero(importSummary.importedSnapshots),
        skipped: numberOrZero(dryRunSummary.willSkipDuplicateChats),
        skippedDetails: {
          chats: numberOrZero(dryRunSummary.willSkipDuplicateChats),
          chromeStorageLocal: numberOrZero(importSummary.chromeStorageSkipped),
          libraryKv: numberOrZero(importSummary.libraryKvSkipped),
        },
        sourceSummary: propagation && propagation.sourceSummary,
        importSummary: propagation && propagation.importSummary,
        folderDeleteReceiptImport: propagation && propagation.folderDeleteReceiptImport,
        folderRestoreReceiptImport: propagation && propagation.folderRestoreReceiptImport,
        desktopVisibleFolderSet: desktopVisibleFolderSet,
        desktopVisibleSetHide: propagation && propagation.desktopVisibleSetHide,
        desktopCanonicalRecentlyDeleted: propagation && propagation.desktopCanonicalRecentlyDeleted,
        desktopCanonicalRecentlyDeletedImport: propagation && propagation.desktopCanonicalRecentlyDeletedImport,
        desktopPurgedFolderSuppression: propagation && propagation.desktopPurgedFolderSuppression,
        desktopPurgedFolderSuppressionImport: propagation && propagation.desktopPurgedFolderSuppressionImport,
        desktopCanonicalChatFolderBindings: propagation && propagation.desktopCanonicalChatFolderBindings,
        desktopCanonicalChatFolderBindingImport: propagation && propagation.desktopCanonicalChatFolderBindingImport,
        importedDesktopCanonicalBindingCount: numberOrZero(propagation && propagation.importedDesktopCanonicalBindingCount),
        desktopCanonicalLibraryMetadata: propagation && propagation.desktopCanonicalLibraryMetadata,
        desktopCanonicalLibraryMetadataImport: propagation && propagation.desktopCanonicalLibraryMetadataImport,
        convergence: propagation && propagation.convergence,
        postImportRefresh: propagation && propagation.postImportRefresh,
        conflictDecision: propagation && propagation.conflictDecision,
        conflictApproved: propagation && propagation.conflictApproved,
        conflictApproval: propagation && propagation.conflictApproval,
        blockers: propagation && propagation.blockers,
        warnings: propagation && propagation.warnings,
        redactedErrorCategories: propagation && propagation.redactedErrorCategories,
        rowsAfter: rowsAfter,
        dryRun: dryRunSummary,
        propagation: propagation,
        durationMs: Date.now() - startedAt,
        autoSync: !!opts.autoSync,
        backgroundAutoImport: false,
        chromeWritesSyncFolder: false,
        status: propagation && propagation.ok ? 'sync-folder-imported' : 'sync-folder-import-blocked',
      };
      return result;
    } catch (error) {
      state.lastSyncStatus = 'sync-folder-import-failed';
      state.lastSyncError = String(error && (error.message || error));
      pushError('sync-now', error);
      try {
        await persistState({
          lastSyncStatus: state.lastSyncStatus,
          lastSyncError: state.lastSyncError,
        });
      } catch (_) { /* ignore */ }
      return {
        ok: false,
        phase: PHASE,
        mode: MODE,
        path: (state.folderName ? state.folderName + '/' : '') + LATEST_FILE,
        error: state.lastSyncError,
        rowsAfter: H2O.LibraryIndex && typeof H2O.LibraryIndex.getAll === 'function' ? H2O.LibraryIndex.getAll().length : 0,
        durationMs: Date.now() - startedAt,
        status: state.lastSyncStatus,
      };
    }
    } finally {
      state.syncInFlight = false;
    }
  }

  function diagnose() {
    var storage = getChromeStorageLocal();
    var chromeExportWriteGate = getChromeExportWriteGate();
    return Object.assign(status(), {
      installed: true,
      api: 'H2O.Studio.sync.folder',
      idbName: IDB_NAME,
      idbStore: IDB_STORE,
      stateKey: STATE_KEY,
      fileSystemAccessAvailable: typeof global.showDirectoryPicker === 'function',
      indexedDbAvailable: !!global.indexedDB,
      chromeStorageAvailable: !!(storage && typeof storage.get === 'function' && typeof storage.set === 'function'),
      dryRunImportAvailable: true,
      mergeImportOnly: true,
      desktopChromePropagation: {
        schema: PROPAGATION_SCHEMA,
        version: F19_DESKTOP_CHROME_VERSION,
        transport: LATEST_FILE,
        direction: 'desktop-to-chrome',
        supportedFields: DESKTOP_CHROME_SUPPORTED_FIELDS.slice(),
        deferredCodes: Object.assign({}, DESKTOP_CHROME_DEFERRED_CODES),
        hardeningTaxonomy: Object.assign({}, F19_SYNC_HARDENING_CODES),
        offlineRestartBehavior: {
          desktopOffline: 'latest.json remains pending until Chrome imports it',
          chromeOffline: 'Chrome imports latest.json after restart or focus when permission remains granted',
          repeatedImport: F19_SYNC_HARDENING_CODES.duplicateImportIdempotent,
          staleTransport: F19_SYNC_HARDENING_CODES.transportStale,
          simultaneousUpdate: F19_SYNC_HARDENING_CODES.simultaneousUpdateConflict,
          missingPermission: F19_SYNC_HARDENING_CODES.permissionDenied
        },
        guardedImportAvailable: true
      },
      importLatestBundleReadsLatestJson: true,
      importLatestBundlePayloadCompatibility: true,
      fullBundleV2ImportCompatible: true,
      chromeDesktopExport: {
        api: 'H2O.Studio.sync.folder.exportChromeToSyncFolder',
        schedulerApi: 'H2O.Studio.sync.folder.scheduleChromeToDesktopExport',
        syncNowDirection: 'H2O.Studio.sync.folder.syncNow({ direction: "chrome-to-desktop" })',
        transport: CHROME_LATEST_FILE,
        direction: 'chrome-to-desktop',
        autoImportAvailable: !!getChromeAutoImportApi(),
        exportFlagKey: cleanString(chromeExportWriteGate.flagKey || 'sync.chromeAutoImport'),
        exportFlagEnabled: chromeExportWriteGate.effectiveFlagEnabled === true,
        exportWriteGate: chromeExportWriteGate,
        enableForSmokeSnippet: cleanString(chromeExportWriteGate.enableForSmokeSnippet),
        chromeWritesSyncFolder: true,
        writesLatestJson: false,
        staleDesktopLatestJsonIgnored: true
      },
      desktopToChrome: {
        autoImportEnabled: !!state.autoSyncEnabled,
        autoExportEnabled: false,
        latestTransport: LATEST_FILE,
        lastImportStatus: state.lastAutoSyncStatus || state.lastSyncStatus,
        lastImportedAt: state.lastAutoSyncAt || state.lastAppliedAt,
        lastImportError: state.lastAutoSyncError || state.lastSyncError,
        desktopLatestPollingEnabled: !!state.desktopLatestPollTimer,
        desktopLatestPollIntervalMs: DESKTOP_LATEST_POLL_INTERVAL_MS,
        lastDesktopLatestPollStatus: state.lastDesktopLatestPollStatus,
        lastDesktopLatestPollDetectedAt: state.lastDesktopLatestPollDetectedAt,
        latency: {
          desktopMutationAt: state.lastDesktopToChromeExportWrittenAt,
          desktopExportWrittenAt: state.lastDesktopToChromeExportWrittenAt,
          chromeImportStartedAt: state.lastDesktopToChromeImportStartedAt,
          chromeImportAppliedAt: state.lastDesktopToChromeImportAppliedAt,
          chromeRenderRefreshedAt: state.lastDesktopToChromeRenderRefreshedAt,
          totalPropagationMs: state.lastDesktopToChromeTotalPropagationMs,
          postImportRefreshMode: state.lastDesktopToChromeRefreshMode,
          chromePostImportRefreshMode: state.lastChromePostImportRefreshMode,
          chromePostImportRefreshAt: state.lastChromePostImportRefreshAt,
          changedFolderCount: state.lastDesktopToChromeChangedFolderCount,
          changedFields: state.lastDesktopToChromeChangedFields.slice(),
          changedFolderIds: state.lastDesktopToChromeChangedFolderIds.slice(),
          renderRefreshCount: state.lastChromePostImportRenderRefreshCount,
          cumulativeRenderRefreshCount: state.chromePostImportRenderRefreshCount,
          refreshSuppressed: state.lastChromePostImportRefreshSuppressed,
          refreshSuppressedCount: state.chromePostImportRefreshSuppressedCount,
          postImportRefreshError: state.lastDesktopToChromePostImportRefreshError,
          loopSuppressed: state.loopSuppressedCount,
          duplicateSkipped: state.duplicateSkippedCount,
          selfOriginSkipped: state.selfOriginSkippedCount,
        },
        folderDeleteReceiptImport: state.lastFolderDeleteReceiptImport || null,
        folderRestoreReceiptImport: state.lastFolderRestoreReceiptImport || null,
        chatFolderBindingReceiptImport: state.lastChatFolderBindingReceiptImport || null,
        libraryMetadataMutationReceiptImport: state.lastLibraryMetadataMutationReceiptImport || null,
        desktopCanonicalLibraryMetadataImport: summarizeDesktopCanonicalLibraryMetadata(state.desktopCanonicalLibraryMetadata),
        simultaneousConflictStatus: state.lastTransportConflictStatus,
        simultaneousConflictDecision: state.lastTransportConflictDecision,
        simultaneousConflictReason: state.lastTransportConflictReason,
        simultaneousConflictSummary: state.lastTransportConflictSummary,
        pending: !!state.autoSyncTimer,
        inFlight: !!state.autoSyncRunning || !!state.syncInFlight,
        permission: state.permission,
      },
      chromeToDesktop: {
        autoExportEnabled: true,
        chromeWritesSyncFolder: state.lastChromeExportStatus === 'chrome-to-desktop-exported' ||
          (!!state.handle && chromeExportWriteGate.effectiveFlagEnabled === true),
        exportReady: !!state.handle && chromeExportWriteGate.effectiveFlagEnabled === true,
        exportApiAvailable: !!getChromeAutoImportApi(),
        exportFlagKey: cleanString(chromeExportWriteGate.flagKey || 'sync.chromeAutoImport'),
        exportFlagEnabled: chromeExportWriteGate.effectiveFlagEnabled === true,
        exportWriteGate: chromeExportWriteGate,
        exportFlagOff: chromeExportWriteGate.effectiveFlagEnabled !== true,
        enableForSmokeSnippet: cleanString(chromeExportWriteGate.enableForSmokeSnippet),
        transport: CHROME_LATEST_FILE,
        lastExportStatus: state.lastChromeExportStatus,
        lastExportedAt: state.lastChromeExportAt,
        lastExportBytes: state.lastChromeExportBytes,
        lastExportFile: state.lastChromeExportFile,
        lastExportReason: state.lastChromeExportReason,
        lastExportError: state.lastChromeExportError,
        permission: state.lastChromeExportPermission || state.permission,
        pending: !!state.chromeExportPending,
        inFlight: !!state.chromeExportInFlight,
        chromeExportInFlightPersisted: !!state.chromeExportInFlight,
        chromeExportInFlightMemory: !!state.chromeExportInFlight,
        chromeExportInFlightAgeMs: chromeExportInFlightAgeMs(),
        chromeExportInFlightStaleMs: CHROME_EXPORT_IN_FLIGHT_STALE_MS,
        chromeExportStaleLockCleared: false,
        chromeExportLastStaleLockClearedAt: state.chromeExportLastStaleLockClearedAt,
        chromeExportLastStaleLockClearedReason: state.chromeExportLastStaleLockClearedReason,
        chromeExportLockOwner: cleanString(state.chromeExportInFlightOwner),
        chromeExportLockReason: cleanString(state.chromeExportInFlightReason),
        blockers: state.lastChromeExportBlockers.slice(),
      },
      chromeAutoImport: {
        autoImportEnabled: !!state.autoSyncEnabled,
        chromeExportWriteGate: chromeExportWriteGate,
        chromeExportFlagEnabled: chromeExportWriteGate.effectiveFlagEnabled === true,
        lastImportStatus: state.lastAutoSyncStatus || state.lastSyncStatus,
        lastImportedAt: state.lastAutoSyncAt || state.lastAppliedAt,
        lastImportError: state.lastAutoSyncError || state.lastSyncError,
        desktopLatestPollingEnabled: !!state.desktopLatestPollTimer,
        desktopLatestPollIntervalMs: DESKTOP_LATEST_POLL_INTERVAL_MS,
        lastDesktopLatestPollStatus: state.lastDesktopLatestPollStatus,
        postImportRefreshMode: state.lastDesktopToChromeRefreshMode,
        chromePostImportRefreshMode: state.lastChromePostImportRefreshMode,
        changedFolderCount: state.lastChromePostImportChangedFolderCount,
        renderRefreshCount: state.lastChromePostImportRenderRefreshCount,
        cumulativeRenderRefreshCount: state.chromePostImportRenderRefreshCount,
        refreshSuppressed: state.lastChromePostImportRefreshSuppressed,
        refreshSuppressedCount: state.chromePostImportRefreshSuppressedCount,
        loopSuppressed: state.loopSuppressedCount,
        duplicateSkipped: state.duplicateSkippedCount,
        selfOriginSkipped: state.selfOriginSkippedCount,
        simultaneousConflictStatus: state.lastTransportConflictStatus,
        simultaneousConflictDecision: state.lastTransportConflictDecision,
        simultaneousConflictReason: state.lastTransportConflictReason,
        permission: state.permission,
        pending: !!state.autoSyncTimer,
        running: !!state.autoSyncRunning,
      },
      blockers: {
        permissionRequired: state.permission !== 'granted',
        autoImportDisabled: !state.autoSyncEnabled,
        simultaneousConflict: state.lastTransportConflictStatus === 'conflict-approval-required',
        schedulerNotFired: !state.autoSyncScheduledAt && !state.lastAutoSyncAttemptAt,
        noFolderHandle: !state.handle,
      },
      automaticPolling: !!state.desktopLatestPollTimer,
      focusTriggerEnabled: !!state.autoSyncEnabled,
      visibilityTriggerEnabled: !!state.autoSyncEnabled,
      bootReadyTriggerEnabled: !!state.autoSyncEnabled,
      bidirectionalSync: false,
      lastFileName: state.lastFileName,
      lastFileLastModified: state.lastFileLastModified,
      lastFileSize: state.lastFileSize,
      lastSummarySignature: state.lastSummarySignature,
      lastSyncResult: state.lastSyncResult,
      errors: state.errors.slice(),
    });
  }

  function diagnoseHealth() {
    var raw = diagnose();
    var desktopToChromeRaw = safeObject(raw.desktopToChrome);
    var chromeToDesktopRaw = safeObject(raw.chromeToDesktop);
    var chromeAutoImportRaw = safeObject(raw.chromeAutoImport);
    var latency = safeObject(desktopToChromeRaw.latency);
    var blockerFlags = safeObject(raw.blockers);
    var blockers = [];
    var warnings = [];
    var statusCodes = [];
    var pending = !!(desktopToChromeRaw.pending || chromeToDesktopRaw.pending || chromeAutoImportRaw.pending);
    var inFlight = !!(desktopToChromeRaw.inFlight || chromeToDesktopRaw.inFlight || chromeAutoImportRaw.running || raw.syncInFlight);
    var autoSyncDisabled = !raw.autoSyncEnabled || blockerFlags.autoImportDisabled === true;
    var permission = cleanString(chromeToDesktopRaw.permission || desktopToChromeRaw.permission || raw.permission || 'unknown') || 'unknown';

    if (blockerFlags.permissionRequired === true || (permission && permission !== 'granted')) {
      addHealthCode(blockers, 'permission-required');
    }
    if (blockerFlags.noFolderHandle === true || !raw.connected) {
      addHealthCode(blockers, 'no-folder-handle');
    }
    if (autoSyncDisabled) addHealthCode(statusCodes, 'auto-sync-disabled');
    if (shouldReportChromeSchedulerNotFired(raw, desktopToChromeRaw, blockerFlags)) {
      addHealthCode(warnings, 'scheduler-not-fired');
      addHealthCode(statusCodes, 'scheduler-not-fired');
    }
    if (blockerFlags.simultaneousConflict === true ||
        cleanString(desktopToChromeRaw.simultaneousConflictStatus) === 'conflict-approval-required') {
      addHealthCode(blockers, 'simultaneous-conflict');
    }
    addHealthCodesFromList(blockers, chromeToDesktopRaw.blockers);
    addHealthCodesFromError(blockers, raw.lastSyncError);
    addHealthCodesFromError(blockers, raw.lastAutoSyncError);
    addHealthCodesFromError(blockers, chromeToDesktopRaw.lastExportError);

    if (latency.refreshSuppressed === true || numberOrZero(latency.refreshSuppressedCount) > 0) {
      addHealthCode(statusCodes, 'no-op-refresh-suppressed');
    }
    if (numberOrZero(latency.duplicateSkipped) > 0 || numberOrZero(chromeAutoImportRaw.duplicateSkipped) > 0) {
      addHealthCode(statusCodes, 'duplicate-suppressed');
    }
    if (numberOrZero(latency.loopSuppressed) > 0 || numberOrZero(chromeAutoImportRaw.loopSuppressed) > 0) {
      addHealthCode(statusCodes, 'loop-suppressed');
    }
    if (numberOrZero(latency.selfOriginSkipped) > 0 || numberOrZero(chromeAutoImportRaw.selfOriginSkipped) > 0) {
      addHealthCode(statusCodes, 'self-origin-skipped');
    }
    if (!blockers.length && !statusCodes.length && !raw.connected && permission === 'unknown') {
      addHealthCode(statusCodes, 'unknown-state');
    }

    var verdict = folderHealthVerdict(blockers, warnings, pending, inFlight, autoSyncDisabled && !blockers.length);
    return {
      schema: FOLDER_SYNC_HEALTH_SCHEMA,
      version: FOLDER_SYNC_HEALTH_VERSION,
      surface: 'chrome-studio',
      observedAt: nowIso(),
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
      folderDeleteReceiptImport: state.lastFolderDeleteReceiptImport || null,
      folderRestoreReceiptImport: state.lastFolderRestoreReceiptImport || null,
      chatFolderBindingReceiptImport: state.lastChatFolderBindingReceiptImport || null,
      libraryMetadataMutationReceiptImport: state.lastLibraryMetadataMutationReceiptImport || null,
      desktopToChrome: {
        autoExportEnabled: !!desktopToChromeRaw.autoExportEnabled,
        autoImportEnabled: !!desktopToChromeRaw.autoImportEnabled,
        latestTransport: cleanString(desktopToChromeRaw.latestTransport || LATEST_FILE),
        lastExportStatus: cleanString(state.lastDesktopLatestPollStatus),
        lastExportedAt: cleanString(state.lastDesktopToChromeExportWrittenAt),
        lastExportBytes: numberOrZero(state.lastDesktopLatestPollFileSize || state.lastFileSize),
        lastExportError: '',
        lastImportStatus: cleanString(desktopToChromeRaw.lastImportStatus),
        lastImportedAt: cleanString(desktopToChromeRaw.lastImportedAt),
        lastAppliedExportedAt: cleanString(state.lastAppliedExportedAt),
        lastPropagationMs: numberOrZero(latency.totalPropagationMs),
        pending: !!desktopToChromeRaw.pending,
        inFlight: !!desktopToChromeRaw.inFlight,
        permission: cleanString(desktopToChromeRaw.permission || permission),
        noOpRefreshSuppressed: latency.refreshSuppressed === true,
        refreshSuppressedCount: numberOrZero(latency.refreshSuppressedCount),
        changedFolderCount: numberOrZero(latency.changedFolderCount),
        changedFolderIds: [],
        changedFolderIdsRedacted: true,
        folderDeleteReceiptImport: state.lastFolderDeleteReceiptImport || null,
        folderRestoreReceiptImport: state.lastFolderRestoreReceiptImport || null,
        chatFolderBindingReceiptImport: state.lastChatFolderBindingReceiptImport || null,
        libraryMetadataMutationReceiptImport: state.lastLibraryMetadataMutationReceiptImport || null,
        desktopCanonicalLibraryMetadataImport: summarizeDesktopCanonicalLibraryMetadata(state.desktopCanonicalLibraryMetadata)
      },
      chromeToDesktop: {
        chromeWritesSyncFolder: !!chromeToDesktopRaw.chromeWritesSyncFolder,
        exportApiAvailable: !!chromeToDesktopRaw.exportApiAvailable,
        exportFlagKey: cleanString(chromeToDesktopRaw.exportFlagKey),
        exportFlagEnabled: chromeToDesktopRaw.exportFlagEnabled === true,
        exportWriteGate: safeObject(chromeToDesktopRaw.exportWriteGate),
        exportFlagOff: chromeToDesktopRaw.exportFlagOff === true,
        enableForSmokeSnippet: cleanString(chromeToDesktopRaw.enableForSmokeSnippet),
        permission: permission,
        lastExportStatus: cleanString(chromeToDesktopRaw.lastExportStatus),
        lastExportedAt: cleanString(chromeToDesktopRaw.lastExportedAt),
        lastExportBytes: numberOrZero(chromeToDesktopRaw.lastExportBytes),
        lastExportError: cleanString(chromeToDesktopRaw.lastExportError),
        desktopAutoImportEnabled: null,
        desktopLastImportStatus: '',
        desktopLastImportedAt: '',
        pending: !!chromeToDesktopRaw.pending,
        inFlight: !!chromeToDesktopRaw.inFlight,
        chromeExportInFlightPersisted: chromeToDesktopRaw.chromeExportInFlightPersisted === true,
        chromeExportInFlightMemory: chromeToDesktopRaw.chromeExportInFlightMemory === true,
        chromeExportInFlightAgeMs: numberOrZero(chromeToDesktopRaw.chromeExportInFlightAgeMs),
        chromeExportInFlightStaleMs: numberOrZero(chromeToDesktopRaw.chromeExportInFlightStaleMs),
        chromeExportStaleLockCleared: chromeToDesktopRaw.chromeExportStaleLockCleared === true,
        chromeExportLastStaleLockClearedAt: cleanString(chromeToDesktopRaw.chromeExportLastStaleLockClearedAt),
        chromeExportLastStaleLockClearedReason: cleanString(chromeToDesktopRaw.chromeExportLastStaleLockClearedReason),
        chromeExportLockOwner: cleanString(chromeToDesktopRaw.chromeExportLockOwner),
        chromeExportLockReason: cleanString(chromeToDesktopRaw.chromeExportLockReason)
      },
      uiRefreshHealth: {
        postImportRefreshMode: cleanString(latency.chromePostImportRefreshMode || latency.postImportRefreshMode),
        renderRefreshCount: numberOrZero(latency.renderRefreshCount),
        cumulativeRenderRefreshCount: numberOrZero(latency.cumulativeRenderRefreshCount),
        refreshSuppressed: latency.refreshSuppressed === true,
        refreshSuppressedCount: numberOrZero(latency.refreshSuppressedCount),
        lastChangedFolderCount: numberOrZero(latency.changedFolderCount),
        lastChangedFields: Array.isArray(latency.changedFields) ? latency.changedFields.slice() : []
      },
      loopPrevention: {
        loopSuppressed: numberOrZero(latency.loopSuppressed),
        duplicateSuppressed: numberOrZero(latency.duplicateSkipped),
        selfOriginSkipped: numberOrZero(latency.selfOriginSkipped)
      },
      deferred: {
        deleteTombstone: 'deferred',
        webdav: 'deferred'
      }
    };
  }

  function getDesktopCanonicalLibraryMetadata() {
    return cloneJson(state.desktopCanonicalLibraryMetadata) || null;
  }

  function diagnoseDesktopCanonicalLibraryMetadata() {
    return summarizeDesktopCanonicalLibraryMetadata(state.desktopCanonicalLibraryMetadata);
  }

  function generateLibraryMetadataMutationRequestId() {
    try {
      var c = global.crypto || null;
      if (c && typeof c.randomUUID === 'function') {
        return 'library-metadata-mutation-request:' + c.randomUUID();
      }
    } catch (_) { /* fall through */ }
    return 'library-metadata-mutation-request:' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2);
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

  function normalizeLibraryMetadataRequestAction(input) {
    var action = cleanString(input.action || input.requestType || input.type).toLowerCase().replace(/_/g, '-');
    var kind = cleanString(input.metadataKind || input.kind || input.catalogKind).toLowerCase();
    if (!action && kind && cleanString(input.operation)) action = kind + '-' + cleanString(input.operation).toLowerCase();
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

  function libraryMetadataMutationRequestFailure(status, blockers, extra) {
    return Object.assign({
      ok: false,
      status: cleanString(status) || 'library-metadata-mutation-request-rejected',
      blockers: (Array.isArray(blockers) ? blockers : [blockers]).filter(Boolean).map(function (code) {
        return { code: cleanString(code) || 'library-metadata-mutation-request-blocked' };
      }),
      schema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA + '.result.v1',
      sourceSurface: 'chrome-studio',
      requestOnly: true,
      desktopApplyRequired: true,
      desktopApply: false,
      noLocalApply: true,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutation: true,
      chromeAuthority: false,
      desktopAuthority: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true
    }, extra || {});
  }

  function libraryMetadataMutationProjectionBasis() {
    var projection = summarizeDesktopCanonicalLibraryMetadata(state.desktopCanonicalLibraryMetadata);
    return {
      sourceName: 'desktopCanonicalLibraryMetadata',
      available: projection.available === true,
      schema: DESKTOP_CANONICAL_LIBRARY_METADATA_SCHEMA,
      importedAt: cleanString(projection.importedAt),
      sourceExportedAt: cleanString(projection.sourceExportedAt),
      projectionHash: safeMetadataHash(projection.projectionHash),
      displayMode: 'hash-count-read-model'
    };
  }

  function shapeLibraryMetadataMutationRequestInput(input, options, requestId, requestedAt) {
    var data = safeObject(input);
    var opts = safeObject(options);
    var action = normalizeLibraryMetadataRequestAction(data);
    if (libraryMetadataMutationDeferredDestructiveAction(action)) {
      return {
        ok: false,
        code: 'library-metadata-mutation-request-destructive-action-deferred',
        action: action
      };
    }
    var spec = libraryMetadataMutationActionSpec(action);
    if (!spec) {
      return { ok: false, code: 'library-metadata-mutation-request-action-unsupported', action: action };
    }
    var chatId = safeMetadataRequestId(data.chatId || data.conversationId || data.recordId);
    var entityId = safeMetadataRequestId(data.entityId || data.labelId || data.tagId || data.categoryId ||
      data.classificationId || data.id);
    var displayName = safeMetadataRequestName(data.displayName || data.name || data.label || data.title || data.newName);
    if (action === 'chat-category-clear') {
      entityId = '';
      displayName = '';
    }
    var expectedCurrentBasisHash = safeMetadataHash(data.expectedCurrentBasisHash || data.expectedProjectionHash ||
      data.projectionHash || data.expectedCurrentHash);
    var projectionBasis = libraryMetadataMutationProjectionBasis();
    if (!expectedCurrentBasisHash) expectedCurrentBasisHash = projectionBasis.projectionHash;
    if (spec.requiresChatId && !chatId) {
      return { ok: false, code: 'library-metadata-mutation-request-chat-id-required', action: action };
    }
    if (spec.requiresId && !entityId) {
      return { ok: false, code: 'library-metadata-mutation-request-entity-id-required', action: action };
    }
    if (spec.requiresName && !displayName) {
      return { ok: false, code: 'library-metadata-mutation-request-display-name-required', action: action };
    }
    var idempotencyKey = [
      'library-metadata-mutation-request',
      action,
      spec.metadataKind,
      chatId || '-',
      entityId || '-',
      displayName || '-',
      expectedCurrentBasisHash || '-'
    ].join(':');
    return {
      ok: true,
      request: {
        schema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA,
        version: '0.1.0-phase6',
        phase: 'phase6-chrome-request-export',
        requestId: requestId,
        reviewId: requestId,
        idempotencyKey: idempotencyKey,
        intent: 'library-metadata-mutation-request',
        classification: 'metadata-request',
        requestType: action,
        action: action,
        operation: spec.operation,
        metadataKind: spec.metadataKind,
        subjectKind: spec.subjectKind,
        status: 'pending',
        createdAt: requestedAt,
        requestedAt: requestedAt,
        requestedBy: 'chrome-studio',
        source: 'chrome-studio',
        sourceSurface: 'chrome-studio',
        sourcePeerId: safeMetadataRequestId(opts.sourcePeerId || data.sourcePeerId || 'chrome-studio') || 'chrome-studio',
        expectedCurrentBasisHash: expectedCurrentBasisHash || null,
        expectedCurrentBasis: projectionBasis,
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
        }
      }
    };
  }

  function sanitizeLibraryMetadataMutationRequestExportPayload(payload) {
    var p = safeObject(payload);
    if (cleanString(p.schema) !== LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA) return null;
    if (cleanString(p.intent) !== 'library-metadata-mutation-request') return null;
    if (cleanString(p.status) !== 'pending') return null;
    if (p.desktopApplyRequired !== true || p.noLocalApply !== true) return null;
    if (p.noChromeCanonicalMutation !== true || p.noDesktopCanonicalMutation !== true) return null;
    if (p.noHardDelete !== true || p.noPurge !== true || p.noChatDelete !== true ||
        p.noSnapshotDelete !== true || p.noAssetDelete !== true) return null;
    if (p.noLabelDelete !== true || p.noTagDelete !== true ||
        p.noCategoryDelete !== true || p.noMetadataDelete !== true) return null;
    var action = normalizeLibraryMetadataRequestAction(p);
    if (libraryMetadataMutationDeferredDestructiveAction(action)) return null;
    var spec = libraryMetadataMutationActionSpec(action);
    if (!spec) return null;
    var requestId = cleanString(p.requestId || p.reviewId);
    if (!requestId) return null;
    var payloadObj = safeObject(p.payload);
    var chatId = safeMetadataRequestId(payloadObj.chatId || payloadObj.conversationId);
    var entityId = safeMetadataRequestId(payloadObj.entityId || payloadObj.labelId || payloadObj.tagId ||
      payloadObj.categoryId || payloadObj.classificationId);
    var displayName = safeMetadataRequestName(payloadObj.displayName);
    if (action === 'chat-category-clear') {
      entityId = '';
      displayName = '';
    }
    if (spec.requiresChatId && !chatId) return null;
    if (spec.requiresId && !entityId) return null;
    if (spec.requiresName && !displayName) return null;
    return {
      schema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA,
      version: cleanString(p.version || '0.1.0-phase6'),
      phase: 'phase6-chrome-request-export',
      requestId: requestId,
      reviewId: cleanString(p.reviewId || requestId) || requestId,
      idempotencyKey: cleanString(p.idempotencyKey),
      intent: 'library-metadata-mutation-request',
      classification: 'metadata-request',
      requestType: action,
      action: action,
      operation: spec.operation,
      metadataKind: spec.metadataKind,
      subjectKind: spec.subjectKind,
      status: 'pending',
      createdAt: cleanString(p.createdAt || p.requestedAt),
      requestedAt: cleanString(p.requestedAt || p.createdAt),
      requestedBy: 'chrome-studio',
      source: 'chrome-studio',
      sourceSurface: 'chrome-studio',
      sourcePeerId: safeMetadataRequestId(p.sourcePeerId || 'chrome-studio') || 'chrome-studio',
      expectedCurrentBasisHash: safeMetadataHash(p.expectedCurrentBasisHash),
      expectedCurrentBasis: safeObject(p.expectedCurrentBasis),
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
      mirroredAt: nowIso()
    };
  }

  function libraryMetadataMutationRequestExportIdentity(request) {
    var row = safeObject(request);
    return cleanString(row.requestId || row.reviewId) + '|' + cleanString(row.idempotencyKey);
  }

  async function readLibraryMetadataMutationRequestExportMirror() {
    var empty = {
      ok: true,
      schema: LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA,
      found: false,
      requestCount: 0,
      requests: []
    };
    try {
      var mirror = await readKv(LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_KEY);
      if (!mirror || typeof mirror !== 'object') return empty;
      if (cleanString(mirror.schema) !== LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA) {
        return Object.assign({}, empty, {
          ok: false,
          found: true,
          warning: 'library-metadata-mutation-request-export-mirror-schema-invalid'
        });
      }
      return {
        ok: true,
        schema: LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA,
        found: true,
        updatedAt: cleanString(mirror.updatedAt),
        requestCount: Array.isArray(mirror.requests) ? mirror.requests.length : 0,
        requests: Array.isArray(mirror.requests) ? mirror.requests.slice() : []
      };
    } catch (e) {
      pushError('libraryMetadataMutationRequests.exportMirror.read', e);
      return Object.assign({}, empty, {
        ok: false,
        found: false,
        warning: 'library-metadata-mutation-request-export-mirror-read-failed',
        error: String((e && e.message) || e)
      });
    }
  }

  async function upsertLibraryMetadataMutationRequestExportMirror(payload) {
    var request = sanitizeLibraryMetadataMutationRequestExportPayload(payload);
    if (!request) {
      return libraryMetadataMutationRequestFailure(
        'library-metadata-mutation-request-export-mirror-invalid',
        'library-metadata-mutation-request-export-mirror-invalid'
      );
    }
    try {
      var current = await readKv(LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_KEY);
      var rows = Array.isArray(current && current.requests) ? current.requests.slice() : [];
      var key = libraryMetadataMutationRequestExportIdentity(request);
      rows = rows.filter(function (row) {
        return libraryMetadataMutationRequestExportIdentity(row) !== key &&
          cleanString(row.idempotencyKey) !== cleanString(request.idempotencyKey);
      });
      rows.push(request);
      if (rows.length > 1000) rows = rows.slice(rows.length - 1000);
      await writeKv(LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_KEY, {
        schema: LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA,
        version: 1,
        updatedAt: nowIso(),
        requestCount: rows.length,
        requests: rows
      });
      return {
        ok: true,
        status: 'library-metadata-mutation-request-export-mirror-updated',
        requestCount: rows.length,
        noChromeCanonicalMutation: true,
        noDesktopCanonicalMutation: true,
        requestOnly: true
      };
    } catch (e) {
      pushError('libraryMetadataMutationRequests.exportMirror.upsert', e);
      return libraryMetadataMutationRequestFailure(
        'library-metadata-mutation-request-export-mirror-failed',
        'library-metadata-mutation-request-export-mirror-failed',
        { reason: String((e && e.message) || e) }
      );
    }
  }

  async function requestLibraryMetadataMutation(input, options) {
    var requestedAt = nowIso();
    var requestId = generateLibraryMetadataMutationRequestId();
    var shaped = shapeLibraryMetadataMutationRequestInput(input, options, requestId, requestedAt);
    if (!shaped.ok) {
      return libraryMetadataMutationRequestFailure(shaped.code, shaped.code, {
        requestType: shaped.action || normalizeLibraryMetadataRequestAction(input || {})
      });
    }
    var mirror = await readLibraryMetadataMutationRequestExportMirror();
    var existing = (Array.isArray(mirror.requests) ? mirror.requests : []).find(function (row) {
      return cleanString(row.idempotencyKey) === cleanString(shaped.request.idempotencyKey) &&
        cleanString(row.status) === 'pending';
    }) || null;
    if (existing) {
      state.libraryMetadataMutationRequestDuplicates += 1;
      state.lastLibraryMetadataMutationRequestAt = requestedAt;
      state.lastLibraryMetadataMutationRequestStatus = 'pending-existing';
      var existingMirror = await upsertLibraryMetadataMutationRequestExportMirror(existing);
      return {
        ok: true,
        status: 'pending-existing',
        duplicate: true,
        requestId: cleanString(existing.requestId || existing.reviewId),
        reviewId: cleanString(existing.reviewId || existing.requestId),
        idempotencyKey: cleanString(existing.idempotencyKey),
        requestType: cleanString(existing.requestType || existing.action),
        payload: cloneJson(existing),
        exportMirror: existingMirror,
        requestOnly: true,
        desktopApplyRequired: true,
        desktopApply: false,
        noLocalApply: true,
        noChromeCanonicalMutation: true,
        noDesktopCanonicalMutation: true,
        noHardDelete: true,
        noPurge: true,
        noChatDelete: true,
        noSnapshotDelete: true,
        noAssetDelete: true
      };
    }
    var updatedMirror = await upsertLibraryMetadataMutationRequestExportMirror(shaped.request);
    if (!updatedMirror.ok) return updatedMirror;
    state.libraryMetadataMutationRequestCreates += 1;
    state.lastLibraryMetadataMutationRequestAt = requestedAt;
    state.lastLibraryMetadataMutationRequestStatus = 'pending-created';
    return {
      ok: true,
      status: 'pending-created',
      duplicate: false,
      requestId: shaped.request.requestId,
      reviewId: shaped.request.reviewId,
      idempotencyKey: shaped.request.idempotencyKey,
      requestType: shaped.request.requestType,
      payload: cloneJson(shaped.request),
      exportMirror: updatedMirror,
      requestOnly: true,
      desktopApplyRequired: true,
      desktopApply: false,
      noLocalApply: true,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutation: true,
      chromeAuthority: false,
      desktopAuthority: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true
    };
  }

  async function listLibraryMetadataMutationRequests(options) {
    var opts = safeObject(options);
    var mirror = await readLibraryMetadataMutationRequestExportMirror();
    var rows = Array.isArray(mirror.requests) ? mirror.requests.slice() : [];
    var statusFilter = cleanString(opts.status);
    if (statusFilter) rows = rows.filter(function (row) {
      return cleanString(row.status) === statusFilter;
    });
    var limit = numberOrZero(opts.limit) || 1000;
    if (limit > 0) rows = rows.slice(0, Math.min(limit, 1000));
    return rows.map(function (row) { return cloneJson(row); }).filter(Boolean);
  }

  async function diagnoseLibraryMetadataMutationRequests(options) {
    var includeRows = !!(options && options.includeRows);
    var mirror = await readLibraryMetadataMutationRequestExportMirror();
    var rows = Array.isArray(mirror.requests) ? mirror.requests : [];
    var pending = rows.filter(function (row) { return cleanString(row.status) === 'pending'; });
    var result = {
      schema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA + '.diagnostic.v1',
      phase: 'phase6-chrome-request-export',
      ok: mirror.ok === true,
      installed: true,
      surface: 'chrome-studio',
      section: 'libraryMetadataMutationRequests',
      exportMirrorKey: LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_KEY,
      exportMirrorSchema: LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA,
      requestSchema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA,
      mirrorAvailable: mirror.found === true,
      pendingCount: pending.length,
      totalCount: rows.length,
      lastRequestAt: state.lastLibraryMetadataMutationRequestAt,
      lastRequestStatus: state.lastLibraryMetadataMutationRequestStatus,
      createsSinceBoot: state.libraryMetadataMutationRequestCreates,
      duplicatesSinceBoot: state.libraryMetadataMutationRequestDuplicates,
      requestOnly: true,
      desktopApplyRequired: true,
      desktopApply: false,
      noLocalApply: true,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutation: true,
      chromeAuthority: false,
      desktopAuthority: true,
      separateFromDesktopCanonicalLibraryMetadata: true,
      productSyncReady: false,
      destructiveMetadataActionsDeferred: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true,
      privacy: {
        rawChatContent: false,
        rawChatTitles: false,
        accountLinkedMetadata: false,
        displayNamePolicy: 'explicit-user-entered-metadata-only'
      },
      warnings: mirror.warning ? [mirror.warning] : [],
      blockers: mirror.ok === true ? [] : ['library-metadata-mutation-request-export-mirror-unavailable']
    };
    if (includeRows) result.requests = rows.map(function (row) { return cloneJson(row); }).filter(Boolean);
    return result;
  }

  // ----- Phase 8: Chrome read-only import/display of Desktop-issued library metadata mutation receipts -----
  //
  // Chrome remains request-only. It never owns canonical metadata. This lane only reads trusted
  // Desktop receipts from the desktop-to-chrome bundle, records them in a Chrome-only read-model
  // mirror, and marks the matching Chrome pending request rows as observed/resolved. It performs no
  // canonical mutation, no Desktop apply, and no delete of any kind.
  //
  // Receipt status taxonomy follows Phase 7 exactly:
  //   applied | rejected | deferred | skipped_duplicate | stale_basis | invalid
  // Terminal statuses conclude the request instance and flip the matching Chrome request off
  // 'pending' (stops Chrome re-exporting an already-decided request, without deleting history).
  // 'deferred' is observed-only and stays pending so a future Desktop phase can still apply it.

  function knownLibraryMetadataMutationReceiptStatus(status) {
    var s = cleanString(status);
    return s === 'applied' || s === 'rejected' || s === 'deferred' ||
      s === 'skipped_duplicate' || s === 'stale_basis' || s === 'invalid';
  }

  function isTerminalLibraryMetadataMutationReceiptStatus(status) {
    var s = cleanString(status);
    return s === 'applied' || s === 'rejected' || s === 'invalid' ||
      s === 'skipped_duplicate' || s === 'stale_basis';
  }

  function sanitizeImportedLibraryMetadataMutationReceipt(receipt) {
    var r = safeObject(receipt);
    if (cleanString(r.schema) !== LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA) {
      return { ok: false, code: 'library-metadata-mutation-receipt-schema-invalid' };
    }
    var receiptId = safeMetadataRequestId(r.receiptId);
    if (!receiptId) return { ok: false, code: 'library-metadata-mutation-receipt-id-invalid' };
    var requestId = safeMetadataRequestId(r.requestId || r.reviewId);
    if (!requestId) return { ok: false, code: 'library-metadata-mutation-receipt-request-id-invalid' };
    var status = cleanString(r.status);
    if (!knownLibraryMetadataMutationReceiptStatus(status)) {
      return { ok: false, code: 'library-metadata-mutation-receipt-status-unknown' };
    }
    if (r.separateFromDesktopCanonicalLibraryMetadata !== true) {
      return { ok: false, code: 'library-metadata-mutation-receipt-not-separate-from-canonical' };
    }
    if (r.productSyncReady !== false) {
      return { ok: false, code: 'library-metadata-mutation-receipt-product-sync-flag-invalid' };
    }
    var privacy = safeObject(r.privacy);
    if (privacy.redacted !== true || privacy.hashOnly !== true ||
        privacy.rawChatIds === true || privacy.rawChatTitles === true ||
        privacy.rawChatContent === true || privacy.accountLinkedMetadata === true) {
      return { ok: false, code: 'library-metadata-mutation-receipt-privacy-invalid' };
    }
    var safety = safeObject(r.safety);
    if (safety.desktopAuthority !== true || safety.chromeAuthority !== false ||
        safety.noChromeCanonicalMutation !== true ||
        safety.noHardDelete !== true || safety.noPurge !== true ||
        safety.noChatDelete !== true || safety.noSnapshotDelete !== true ||
        safety.noAssetDelete !== true || safety.noLabelDelete !== true ||
        safety.noTagDelete !== true || safety.noCategoryDelete !== true ||
        safety.noMetadataDelete !== true) {
      return { ok: false, code: 'library-metadata-mutation-receipt-safety-invalid' };
    }
    var target = safeObject(r.target);
    var sanitized = {
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA,
      version: cleanString(r.version),
      phase: cleanString(r.phase),
      receiptId: receiptId,
      requestId: requestId,
      reviewId: safeMetadataRequestId(r.reviewId || r.requestId) || requestId,
      idempotencyKey: cleanString(r.idempotencyKey),
      requestAction: normalizeLibraryMetadataRequestAction(r),
      requestType: cleanString(r.requestType || r.requestAction),
      metadataKind: cleanString(r.metadataKind),
      subjectKind: cleanString(r.subjectKind),
      status: status,
      reason: cleanString(r.reason) || status,
      code: cleanString(r.code) || status,
      reviewedAt: cleanString(r.reviewedAt),
      appliedAt: cleanString(r.appliedAt),
      target: {
        chatIdHash: safeMetadataHash(target.chatIdHash),
        entityIdHash: safeMetadataHash(target.entityIdHash),
        metadataKind: cleanString(target.metadataKind)
      },
      expectedCurrentBasisHash: safeMetadataHash(r.expectedCurrentBasisHash),
      beforeProjectionHash: safeMetadataHash(r.beforeProjectionHash),
      resultingCanonicalHash: safeMetadataHash(r.resultingCanonicalHash),
      beforeAssignmentHash: safeMetadataHash(r.beforeAssignmentHash),
      afterAssignmentHash: safeMetadataHash(r.afterAssignmentHash),
      counts: safeObject(r.counts),
      desktopSource: {
        surface: cleanString(safeObject(r.source).surface) || 'desktop-studio',
        authority: 'desktop'
      },
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
        accountLinkedMetadata: false
      },
      safety: {
        desktopAuthority: true,
        chromeAuthority: false,
        chromeReadOnly: true,
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
      productSyncReady: false,
      terminal: isTerminalLibraryMetadataMutationReceiptStatus(status),
      chromeImport: {
        surface: 'chrome-studio',
        readOnly: true,
        source: 'desktop-latest-bundle'
      }
    };
    return { ok: true, receipt: sanitized };
  }

  async function readLibraryMetadataMutationReceiptImportMirror() {
    var empty = {
      ok: true,
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_MIRROR_SCHEMA,
      found: false,
      updatedAt: '',
      receiptCount: 0,
      receipts: []
    };
    try {
      var mirror = await readKv(LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_KEY);
      if (!mirror || typeof mirror !== 'object' || Array.isArray(mirror)) return empty;
      if (cleanString(mirror.schema) !== LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_MIRROR_SCHEMA) {
        return Object.assign({}, empty, {
          ok: false,
          found: true,
          warning: 'library-metadata-mutation-receipt-import-mirror-schema-invalid'
        });
      }
      return {
        ok: true,
        schema: LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_MIRROR_SCHEMA,
        found: true,
        updatedAt: cleanString(mirror.updatedAt),
        receiptCount: Array.isArray(mirror.receipts) ? mirror.receipts.length : 0,
        receipts: Array.isArray(mirror.receipts) ? mirror.receipts.slice() : []
      };
    } catch (e) {
      pushError('libraryMetadataMutationReceipts.importMirror.read', e);
      return Object.assign({}, empty, {
        ok: false,
        warning: 'library-metadata-mutation-receipt-import-mirror-read-failed'
      });
    }
  }

  async function writeLibraryMetadataMutationReceiptImportMirror(rows) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    if (list.length > 1000) list = list.slice(list.length - 1000);
    await writeKv(LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_KEY, {
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_MIRROR_SCHEMA,
      version: 1,
      updatedAt: nowIso(),
      receiptCount: list.length,
      receipts: list
    });
    return list;
  }

  // Read-model only. Marks matching Chrome request rows as observed/resolved using the existing
  // Phase 6 pending-export mirror. No row is ever deleted; resolved rows keep full history and are
  // naturally excluded from Chrome->Desktop re-export because the export sanitizer requires
  // status === 'pending'. Idempotent: a row already resolved by the same receiptId is not rewritten.
  async function markLibraryMetadataMutationRequestsResolvedByReceipts(receipts) {
    var summary = {
      matchedPendingRequestCount: 0,
      resolvedPendingRequestCount: 0,
      observedDeferredRequestCount: 0,
      alreadyResolvedRequestCount: 0,
      unmatchedReceiptCount: 0,
      warnings: []
    };
    var rowsList = Array.isArray(receipts) ? receipts : [];
    if (!rowsList.length) return summary;
    var mirror = await readLibraryMetadataMutationRequestExportMirror();
    var requestRows = Array.isArray(mirror.requests) ? mirror.requests.slice() : [];
    if (!requestRows.length) {
      summary.unmatchedReceiptCount = rowsList.length;
      return summary;
    }
    var changed = false;
    rowsList.forEach(function (receipt) {
      var requestId = cleanString(receipt.requestId);
      var idempotencyKey = cleanString(receipt.idempotencyKey);
      var status = cleanString(receipt.status);
      var receiptId = cleanString(receipt.receiptId);
      var matches = requestRows.filter(function (row) {
        var rid = cleanString(row && (row.requestId || row.reviewId));
        var rkey = cleanString(row && row.idempotencyKey);
        return (requestId && rid === requestId) || (idempotencyKey && rkey === idempotencyKey);
      });
      if (!matches.length) {
        summary.unmatchedReceiptCount += 1;
        return;
      }
      matches.forEach(function (row) {
        var rowStatus = cleanString(row.status);
        if (rowStatus === 'pending') {
          summary.matchedPendingRequestCount += 1;
          if (isTerminalLibraryMetadataMutationReceiptStatus(status)) {
            row.status = 'resolved';
            row.resolvedByReceiptId = receiptId;
            row.resolvedReceiptStatus = status;
            row.resolvedAt = nowIso();
            row.resolutionSource = 'desktop-receipt-import';
            summary.resolvedPendingRequestCount += 1;
            changed = true;
          } else if (cleanString(row.observedByReceiptId) !== receiptId) {
            // deferred: keep pending for a future Desktop phase, record observation only.
            row.observedByReceiptId = receiptId;
            row.observedReceiptStatus = status;
            row.observedAt = nowIso();
            summary.observedDeferredRequestCount += 1;
            changed = true;
          } else {
            summary.observedDeferredRequestCount += 1;
          }
        } else if (rowStatus === 'resolved' && cleanString(row.resolvedByReceiptId) === receiptId) {
          summary.alreadyResolvedRequestCount += 1;
        }
      });
    });
    if (changed) {
      try {
        await writeKv(LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_KEY, {
          schema: LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_MIRROR_SCHEMA,
          version: 1,
          updatedAt: nowIso(),
          requestCount: requestRows.length,
          requests: requestRows
        });
      } catch (e) {
        pushError('libraryMetadataMutationRequests.resolveByReceipt', e);
        summary.warnings.push({ code: 'library-metadata-mutation-request-resolution-write-failed' });
      }
    }
    return summary;
  }

  function makeLibraryMetadataMutationReceiptImportResult() {
    return {
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA + '.chrome-import.v1',
      phase: 'phase8-chrome-receipt-import',
      ok: true,
      attempted: true,
      surface: 'chrome-studio',
      found: 0,
      receiptCount: 0,
      importedReceiptCount: 0,
      newReceiptCount: 0,
      duplicateReceiptCount: 0,
      skippedMalformedCount: 0,
      statusCounts: { applied: 0, rejected: 0, deferred: 0, skipped_duplicate: 0, stale_basis: 0, invalid: 0 },
      matchedPendingRequestCount: 0,
      resolvedPendingRequestCount: 0,
      observedDeferredRequestCount: 0,
      alreadyResolvedRequestCount: 0,
      unmatchedReceiptCount: 0,
      blockerCount: 0,
      warningCount: 0,
      chromeReadOnly: true,
      desktopAuthority: true,
      chromeAuthority: false,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutationFromChrome: true,
      separateFromDesktopCanonicalLibraryMetadata: true,
      productSyncReady: false,
      destructiveMetadataActionsDeferred: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true,
      receiptRows: [],
      skippedReceipts: [],
      warnings: [],
      blockers: []
    };
  }

  function addLibraryMetadataMutationReceiptCode(result, bucket, code) {
    var c = cleanString(code);
    if (!c || !result || !Array.isArray(result[bucket])) return;
    if (!result[bucket].some(function (row) { return row && row.code === c; })) {
      result[bucket].push({ code: c });
    }
  }

  async function importLibraryMetadataMutationReceiptsFromDesktopBundle(bundle) {
    var result = makeLibraryMetadataMutationReceiptImportResult();
    var incoming = Array.isArray(bundle && bundle.libraryMetadataMutationReceipts) ? bundle.libraryMetadataMutationReceipts : [];
    result.found = incoming.length;
    if (!incoming.length) {
      state.lastLibraryMetadataMutationReceiptImport = result;
      return result;
    }
    try {
      var mirror = await readLibraryMetadataMutationReceiptImportMirror();
      if (mirror.warning) {
        addLibraryMetadataMutationReceiptCode(result, 'warnings', mirror.warning);
      }
      var existingRows = Array.isArray(mirror.receipts) ? mirror.receipts.slice() : [];
      var byId = Object.create(null);
      existingRows.forEach(function (row) {
        var id = cleanString(row && row.receiptId);
        if (id) byId[id] = row;
      });
      var sanitizedReceipts = [];
      incoming.forEach(function (raw) {
        var outcome = sanitizeImportedLibraryMetadataMutationReceipt(raw);
        if (!outcome.ok) {
          result.skippedMalformedCount += 1;
          if (result.skippedReceipts.length < 50) result.skippedReceipts.push({ code: outcome.code });
          addLibraryMetadataMutationReceiptCode(result, 'warnings', outcome.code);
          return;
        }
        var receipt = outcome.receipt;
        var existing = byId[receipt.receiptId] || null;
        receipt.chromeImport.firstObservedAt = (existing && existing.chromeImport &&
          cleanString(existing.chromeImport.firstObservedAt)) || nowIso();
        receipt.chromeImport.lastObservedAt = nowIso();
        if (existing) result.duplicateReceiptCount += 1;
        else result.newReceiptCount += 1;
        var status = cleanString(receipt.status);
        if (Object.prototype.hasOwnProperty.call(result.statusCounts, status)) {
          result.statusCounts[status] += 1;
        }
        byId[receipt.receiptId] = receipt;
        sanitizedReceipts.push(receipt);
      });
      result.importedReceiptCount = sanitizedReceipts.length;
      var nextRows = existingRows.filter(function (row) {
        var id = cleanString(row && row.receiptId);
        return id && !sanitizedReceipts.some(function (r) { return r.receiptId === id; });
      }).concat(sanitizedReceipts);
      await writeLibraryMetadataMutationReceiptImportMirror(nextRows);
      result.receiptCount = nextRows.length;
      var resolution = await markLibraryMetadataMutationRequestsResolvedByReceipts(sanitizedReceipts);
      result.matchedPendingRequestCount = numberOrZero(resolution.matchedPendingRequestCount);
      result.resolvedPendingRequestCount = numberOrZero(resolution.resolvedPendingRequestCount);
      result.observedDeferredRequestCount = numberOrZero(resolution.observedDeferredRequestCount);
      result.alreadyResolvedRequestCount = numberOrZero(resolution.alreadyResolvedRequestCount);
      result.unmatchedReceiptCount = numberOrZero(resolution.unmatchedReceiptCount);
      (Array.isArray(resolution.warnings) ? resolution.warnings : []).forEach(function (w) {
        addLibraryMetadataMutationReceiptCode(result, 'warnings', w && (w.code || w));
      });
      result.receiptRows = sanitizedReceipts.slice(0, 100).map(function (row) {
        return {
          receiptId: row.receiptId,
          requestId: row.requestId,
          idempotencyKey: row.idempotencyKey,
          requestType: row.requestType,
          status: row.status,
          terminal: row.terminal === true,
          code: row.code
        };
      });
      result.warningCount = result.warnings.length;
      result.blockerCount = result.blockers.length;
      result.ok = result.blockerCount === 0;
      state.libraryMetadataMutationReceiptImports += 1;
      state.libraryMetadataMutationReceiptResolvedRequests += result.resolvedPendingRequestCount;
      state.lastLibraryMetadataMutationReceiptImport = result;
      return result;
    } catch (error) {
      pushError('library-metadata-mutation-receipt-import', error);
      result.ok = false;
      result.blockerCount = 1;
      addLibraryMetadataMutationReceiptCode(result, 'blockers', 'library-metadata-mutation-receipt-import-failed');
      state.lastLibraryMetadataMutationReceiptImport = result;
      return result;
    }
  }

  async function listLibraryMetadataMutationReceipts(options) {
    var opts = safeObject(options);
    var mirror = await readLibraryMetadataMutationReceiptImportMirror();
    var rows = Array.isArray(mirror.receipts) ? mirror.receipts.slice() : [];
    var statusFilter = cleanString(opts.status);
    if (statusFilter) rows = rows.filter(function (row) { return cleanString(row && row.status) === statusFilter; });
    var requestIdFilter = safeMetadataRequestId(opts.requestId);
    if (requestIdFilter) rows = rows.filter(function (row) { return cleanString(row && row.requestId) === requestIdFilter; });
    var limit = numberOrZero(opts.limit) || 1000;
    if (limit > 0) rows = rows.slice(0, Math.min(limit, 1000));
    return rows.map(function (row) { return cloneJson(row); }).filter(Boolean);
  }

  async function diagnoseLibraryMetadataMutationReceipts(options) {
    var includeRows = !!(options && options.includeRows);
    var mirror = await readLibraryMetadataMutationReceiptImportMirror();
    var rows = Array.isArray(mirror.receipts) ? mirror.receipts : [];
    var statusCounts = { applied: 0, rejected: 0, deferred: 0, skipped_duplicate: 0, stale_basis: 0, invalid: 0 };
    rows.forEach(function (row) {
      var s = cleanString(row && row.status);
      if (Object.prototype.hasOwnProperty.call(statusCounts, s)) statusCounts[s] += 1;
    });
    var requestMirror = await readLibraryMetadataMutationRequestExportMirror();
    var requestRows = Array.isArray(requestMirror.requests) ? requestMirror.requests : [];
    var pendingRequestCount = requestRows.filter(function (row) { return cleanString(row && row.status) === 'pending'; }).length;
    var resolvedRequestCount = requestRows.filter(function (row) { return cleanString(row && row.status) === 'resolved'; }).length;
    var result = {
      schema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA + '.chrome-import-diagnostic.v1',
      phase: 'phase8-chrome-receipt-import',
      ok: mirror.ok === true,
      installed: true,
      surface: 'chrome-studio',
      section: 'libraryMetadataMutationReceipts',
      importMirrorKey: LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_KEY,
      importMirrorSchema: LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_MIRROR_SCHEMA,
      receiptSchema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA,
      mirrorAvailable: mirror.found === true,
      receiptCount: rows.length,
      statusCounts: statusCounts,
      appliedCount: statusCounts.applied,
      rejectedCount: statusCounts.rejected,
      deferredCount: statusCounts.deferred,
      skippedDuplicateCount: statusCounts.skipped_duplicate,
      staleBasisCount: statusCounts.stale_basis,
      invalidCount: statusCounts.invalid,
      pendingRequestCount: pendingRequestCount,
      resolvedRequestCount: resolvedRequestCount,
      importsSinceBoot: state.libraryMetadataMutationReceiptImports,
      resolvedRequestsSinceBoot: state.libraryMetadataMutationReceiptResolvedRequests,
      lastImport: state.lastLibraryMetadataMutationReceiptImport || null,
      chromeReadOnly: true,
      desktopApply: false,
      desktopAuthority: true,
      chromeAuthority: false,
      noChromeCanonicalMutation: true,
      noDesktopCanonicalMutationFromChrome: true,
      separateFromDesktopCanonicalLibraryMetadata: true,
      productSyncReady: false,
      destructiveMetadataActionsDeferred: true,
      noHardDelete: true,
      noPurge: true,
      noChatDelete: true,
      noSnapshotDelete: true,
      noAssetDelete: true,
      noLabelDelete: true,
      noTagDelete: true,
      noCategoryDelete: true,
      noMetadataDelete: true,
      privacy: {
        redacted: true,
        hashOnly: true,
        rawChatIds: false,
        rawChatTitles: false,
        rawChatContent: false,
        accountLinkedMetadata: false
      },
      warnings: mirror.warning ? [{ code: mirror.warning }] : [],
      blockers: mirror.ok === true ? [] : [{ code: 'library-metadata-mutation-receipt-import-mirror-unavailable' }]
    };
    if (includeRows) result.receipts = rows.map(function (row) { return cloneJson(row); }).filter(Boolean);
    return result;
  }

  var api = {
    connectFolder: connectFolder,
    disconnectFolder: disconnectFolder,
    hasFolder: hasFolder,
    getConnectedDirectoryHandle: getConnectedDirectoryHandle,
    authorizeChromePublishing: authorizeChromePublishing,
    status: status,
    syncNow: syncNow,
    exportChromeToSyncFolder: exportChromeToSyncFolder,
    syncChromeToDesktop: exportChromeToSyncFolder,
    scheduleChromeToDesktopExport: scheduleChromeToDesktopExport,
    importLatestBundle: importLatestBundle,
    desktopChromePropagationSchema: PROPAGATION_SCHEMA,
    desktopChromePropagationVersion: F19_DESKTOP_CHROME_VERSION,
    desktopChromeHardeningTaxonomy: Object.assign({}, F19_SYNC_HARDENING_CODES),
    enableAutoSync: enableAutoSync,
    disableAutoSync: disableAutoSync,
    isAutoSyncEnabled: isAutoSyncEnabled,
    scheduleAutoSync: scheduleAutoSync,
    getReadinessSnapshot: getReadinessSnapshot,
    diagnose: diagnose,
    diagnoseHealth: diagnoseHealth,
    getDesktopCanonicalLibraryMetadata: getDesktopCanonicalLibraryMetadata,
    diagnoseDesktopCanonicalLibraryMetadata: diagnoseDesktopCanonicalLibraryMetadata,
    requestLibraryMetadataMutation: requestLibraryMetadataMutation,
    listLibraryMetadataMutationRequests: listLibraryMetadataMutationRequests,
    diagnoseLibraryMetadataMutationRequests: diagnoseLibraryMetadataMutationRequests,
    libraryMetadataMutationRequestSchema: LIBRARY_METADATA_MUTATION_REQUEST_SCHEMA,
    libraryMetadataMutationRequestExportKey: LIBRARY_METADATA_MUTATION_REQUEST_EXPORT_KEY,
    importLibraryMetadataMutationReceiptsFromDesktopBundle: importLibraryMetadataMutationReceiptsFromDesktopBundle,
    listLibraryMetadataMutationReceipts: listLibraryMetadataMutationReceipts,
    diagnoseLibraryMetadataMutationReceipts: diagnoseLibraryMetadataMutationReceipts,
    libraryMetadataMutationReceiptSchema: LIBRARY_METADATA_MUTATION_RECEIPT_SCHEMA,
    libraryMetadataMutationReceiptImportKey: LIBRARY_METADATA_MUTATION_RECEIPT_IMPORT_KEY,
    diagnoseVisibleFolderParity: diagnoseVisibleFolderParity,
    health: {
      diagnose: diagnoseHealth,
    },
  };

  H2O.Studio.sync = Object.assign({}, H2O.Studio.sync || {}, {
    folder: api,
  });

  loadStoredHandle().then(function () {
    if (!state.autoSyncEnabled) return;
    bindAutoSyncEvents();
    if (!state.handle) return;
    startDesktopLatestPoller('studio-boot-ready');
    global.setTimeout(function () {
      scheduleAutoSync('studio-boot-ready').catch(function (error) {
        pushError('auto-sync.boot-ready', error);
      });
    }, AUTO_SYNC_BOOT_DELAY_MS);
  }).catch(function (error) {
    pushError('boot-load-folder', error);
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
