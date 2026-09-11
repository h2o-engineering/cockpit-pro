/* H2O Studio Sync — Chrome Item 9 Desktop-revision delivery (Round 2 / 9-3A)
 *
 * Chrome Studio-page-only, explicit-gesture entry. Reads the one sibling
 * `round2-item9-delivery.json` file from the already-connected sync folder,
 * then delegates exact bytes to the packaged Item 9-2 admission adapter.
 */
(function (global) {
  'use strict';

  function isTauri() {
    try {
      return typeof global.__TAURI_INTERNALS__ !== 'undefined' ||
        typeof global.__TAURI__ !== 'undefined';
    } catch (_) {
      return false;
    }
  }

  function isChromeStudio() {
    try {
      return !isTauri() &&
        global.location?.protocol === 'chrome-extension:' &&
        !!(global.chrome && global.chrome.runtime && global.chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  if (!isChromeStudio()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  H2O.Studio.sync = H2O.Studio.sync || {};
  if (H2O.Studio.sync.item9Delivery) return;

  var DELIVERY_FILE = 'round2-item9-delivery.json';
  var CONFIG_KEY = 'h2o:studio:sync:config:v1';
  var MAX_DELIVERY_FILE_BYTES = 8 * 1024 * 1024;
  var STORE_MODULE_PATH =
    'surfaces/studio/sync/item9-adapters/sync-object-store.mjs';
  var ADMISSION_MODULE_PATH =
    'surfaces/studio/sync/item9-adapters/sync-revision-admission.mjs';
  var DELIVERY_MODULE_PATH =
    'surfaces/studio/sync/item9-adapters/sync-delivery-runtime.mjs';
  var APPLY_MODULE_PATH =
    'surfaces/studio/sync/item9-adapters/sync-revision-apply.mjs';
  var inFlight = null;
  var runtimePromise = null;
  var runtimeLoadState = 'idle';
  var lastResult = null;
  var lastApplyResult = null;

  var ENTRY_ERROR = Object.freeze({
    FOLDER_NOT_CONNECTED: 'round2-item9-delivery-folder-not-connected',
    PERMISSION_DENIED: 'round2-item9-delivery-permission-denied',
    PERMISSION_REQUEST_FAILED: 'round2-item9-delivery-permission-request-failed',
    FILE_MISSING: 'round2-item9-delivery-file-missing',
    FILE_TOO_LARGE: 'round2-item9-delivery-file-too-large',
    FILE_READ_FAILED: 'round2-item9-delivery-file-read-failed',
    RUNTIME_UNAVAILABLE: 'round2-item9-delivery-runtime-unavailable'
  });
  var safeErrorCodes = new Set(Object.values(ENTRY_ERROR));

  function blocked(code) {
    return Object.freeze({
      ok: false,
      verdict: 'blocked',
      errorCode: safeErrorCodes.has(code)
        ? code
        : ENTRY_ERROR.RUNTIME_UNAVAILABLE
    });
  }

  function safeResult(result) {
    if (!result || result.ok !== true) {
      return blocked(result && result.errorCode);
    }
    return Object.freeze({
      ok: true,
      verdict: result.verdict,
      unchangedNoOp: result.unchangedNoOp === true,
      objectId: result.objectId,
      peerFingerprintSha256Hex: result.peerFingerprintSha256Hex,
      objectKeySha256Hex: result.objectKeySha256Hex,
      revisionKeySha256Hex: result.revisionKeySha256Hex,
      revisionBlobSha256Hex: result.revisionBlobSha256Hex,
      payloadSha256Hex: result.payloadSha256Hex,
      observedState: result.observedState,
      applyState: result.applyState
    });
  }

  function safeApplyResult(result) {
    if (!result || result.ok !== true) {
      return blocked(result && result.errorCode);
    }
    return Object.freeze({
      ok: true,
      verdict: result.verdict,
      unchangedNoOp: result.unchangedNoOp === true,
      objectId: result.objectId,
      revisionId: result.revisionId,
      parentRevisionId: result.parentRevisionId == null
        ? null
        : result.parentRevisionId,
      writerSyncPeerId: result.writerSyncPeerId || null,
      lastAppliedRevisionId: result.lastAppliedRevisionId || null,
      pending: result.pending || null
    });
  }

  async function requireReadPermission(handle, allowPrompt) {
    var permission = 'prompt';
    try {
      if (typeof handle.queryPermission === 'function') {
        permission = await handle.queryPermission({ mode: 'read' });
      }
    } catch (_) {
      permission = 'prompt';
    }
    if (permission === 'granted') return;
    if (allowPrompt === false) {
      throw Object.assign(new Error(ENTRY_ERROR.PERMISSION_DENIED), {
        code: ENTRY_ERROR.PERMISSION_DENIED
      });
    }
    if (typeof handle.requestPermission !== 'function') {
      throw Object.assign(new Error(ENTRY_ERROR.PERMISSION_DENIED), {
        code: ENTRY_ERROR.PERMISSION_DENIED
      });
    }
    try {
      permission = await handle.requestPermission({ mode: 'read' });
    } catch (_) {
      throw Object.assign(new Error(ENTRY_ERROR.PERMISSION_REQUEST_FAILED), {
        code: ENTRY_ERROR.PERMISSION_REQUEST_FAILED
      });
    }
    if (permission !== 'granted') {
      throw Object.assign(new Error(ENTRY_ERROR.PERMISSION_DENIED), {
        code: ENTRY_ERROR.PERMISSION_DENIED
      });
    }
  }

  async function automaticAuthority() {
    try {
      var stored = await global.chrome.storage.local.get(CONFIG_KEY);
      var config = stored && stored[CONFIG_KEY];
      return !!config && config.schemaVersion === 1 && config.mode === 'auto';
    } catch (_) {
      return false;
    }
  }

  async function readDeliveryFile(handle) {
    let fileHandle;
    try {
      fileHandle = await handle.getFileHandle(DELIVERY_FILE, { create: false });
    } catch (error) {
      var missing = error && error.name === 'NotFoundError';
      throw Object.assign(new Error(
        missing ? ENTRY_ERROR.FILE_MISSING : ENTRY_ERROR.FILE_READ_FAILED
      ), {
        code: missing ? ENTRY_ERROR.FILE_MISSING : ENTRY_ERROR.FILE_READ_FAILED
      });
    }
    let file;
    try {
      file = await fileHandle.getFile();
      if (!Number.isSafeInteger(file.size) ||
          file.size <= 0 ||
          file.size > MAX_DELIVERY_FILE_BYTES) {
        throw Object.assign(new Error(ENTRY_ERROR.FILE_TOO_LARGE), {
          code: ENTRY_ERROR.FILE_TOO_LARGE
        });
      }
      return await file.text();
    } catch (error) {
      if (error && error.code === ENTRY_ERROR.FILE_TOO_LARGE) throw error;
      throw Object.assign(new Error(ENTRY_ERROR.FILE_READ_FAILED), {
        code: ENTRY_ERROR.FILE_READ_FAILED
      });
    }
  }

  function loadRuntime() {
    if (runtimePromise) return runtimePromise;
    var storeModuleUrl;
    var admissionModuleUrl;
    var deliveryModuleUrl;
    var applyModuleUrl;
    try {
      storeModuleUrl = global.chrome.runtime.getURL(STORE_MODULE_PATH);
      admissionModuleUrl = global.chrome.runtime.getURL(ADMISSION_MODULE_PATH);
      deliveryModuleUrl = global.chrome.runtime.getURL(DELIVERY_MODULE_PATH);
      applyModuleUrl = global.chrome.runtime.getURL(APPLY_MODULE_PATH);
    } catch (_) {
      runtimeLoadState = 'failed';
      return Promise.reject(Object.assign(
        new Error(ENTRY_ERROR.RUNTIME_UNAVAILABLE),
        { code: ENTRY_ERROR.RUNTIME_UNAVAILABLE }
      ));
    }
    runtimeLoadState = 'pending';
    runtimePromise = Promise.all([
      import(storeModuleUrl),
      import(admissionModuleUrl),
      import(deliveryModuleUrl),
      import(applyModuleUrl)
    ]).then(function (modules) {
      var storeModule = modules[0];
      var admissionModule = modules[1];
      var deliveryModule = modules[2];
      var applyModule = modules[3];
      var observationStore = storeModule.createChromeSyncObjectStore({
        identityProvider: H2O.Studio.identity,
        indexedDBFactory: global.indexedDB,
        cryptoImplementation: global.crypto
      });
      var admission = admissionModule.createInjectedRevisionAdmission({
        observationStore: observationStore,
        canonicalAnchorProvider: function (objectId) {
          var publication = H2O.Studio.sync.localPublication;
          if (!publication ||
              typeof publication.resolveCanonicalAnchor !== 'function') {
            throw new Error(ENTRY_ERROR.RUNTIME_UNAVAILABLE);
          }
          return publication.resolveCanonicalAnchor(objectId);
        },
        cryptoImplementation: global.crypto
      });
      var runtime = deliveryModule.createBrowserDeliveryRuntime({
        observationStore: observationStore,
        admission: admission,
        cryptoImplementation: global.crypto
      });
      var apply = applyModule.createChromeRevisionApply({
        syncStore: observationStore,
        archiveAuthority: H2O.Studio.syncApplyArchiveAuthority,
        canonicalAnchorProvider: function (objectId) {
          var publication = H2O.Studio.sync.localPublication;
          if (!publication ||
              typeof publication.resolveCanonicalAnchor !== 'function') {
            throw new Error(ENTRY_ERROR.RUNTIME_UNAVAILABLE);
          }
          return publication.resolveCanonicalAnchor(objectId);
        },
        cryptoImplementation: global.crypto
      });
      var allowedCodes = new Set([
        ...Object.values(storeModule.ITEM9_1_CONSTANTS.ERROR_CODE),
        ...Object.values(admissionModule.ITEM9_2_CONSTANTS.ERROR_CODE),
        ...Object.values(deliveryModule.ITEM9_3A_CONSTANTS.ERROR_CODE),
        ...Object.values(applyModule.CHROME_SYNC_APPLY_CONSTANTS.ERROR_CODE)
      ]);
      allowedCodes.forEach(function (code) {
        safeErrorCodes.add(code);
      });
      runtimeLoadState = 'ready';
      return Object.freeze({
        runtime: runtime,
        apply: apply,
        allowedCodes: allowedCodes
      });
    }).catch(function () {
      runtimePromise = null;
      runtimeLoadState = 'failed';
      throw Object.assign(new Error(ENTRY_ERROR.RUNTIME_UNAVAILABLE), {
        code: ENTRY_ERROR.RUNTIME_UNAVAILABLE
      });
    });
    return runtimePromise;
  }

  async function performDelivery(automatic) {
    if (automatic && await automaticAuthority() !== true) {
      return blocked(ENTRY_ERROR.PERMISSION_DENIED);
    }
    var folder = H2O.Studio.sync.folder;
    var handle = folder &&
      typeof folder.getConnectedDirectoryHandle === 'function'
      ? folder.getConnectedDirectoryHandle()
      : null;
    if (!handle) {
      throw Object.assign(new Error(ENTRY_ERROR.FOLDER_NOT_CONNECTED), {
        code: ENTRY_ERROR.FOLDER_NOT_CONNECTED
      });
    }
    await requireReadPermission(handle, automatic !== true);
    if (automatic && await automaticAuthority() !== true) {
      return blocked(ENTRY_ERROR.PERMISSION_DENIED);
    }
    var deliveryJsonText = await readDeliveryFile(handle);
    var loaded = await loadRuntime();
    try {
      return safeResult(await loaded.runtime.admitDeliveryPackage({
        deliveryJsonText: deliveryJsonText
      }));
    } catch (error) {
      return blocked(loaded.allowedCodes.has(error && error.code)
        ? error.code
        : ENTRY_ERROR.RUNTIME_UNAVAILABLE);
    }
  }

  function deliverFromSyncFolder() {
    if (inFlight) return inFlight;
    inFlight = performDelivery(false)
      .catch(function (error) {
        return blocked(error && error.code);
      })
      .then(function (result) {
        lastResult = result;
        return result;
      })
      .finally(function () {
        inFlight = null;
      });
    return inFlight;
  }

  function deliverFromSyncFolderAutomatically() {
    if (inFlight) return inFlight;
    inFlight = performDelivery(true)
      .catch(function (error) {
        return blocked(error && error.code);
      })
      .then(function (result) {
        lastResult = result;
        return result;
      })
      .finally(function () {
        inFlight = null;
      });
    return inFlight;
  }

  async function applyNextAdmittedRevision(objectId) {
    var loaded = await loadRuntime();
    try {
      lastApplyResult = safeApplyResult(
        await loaded.apply.applyNextAdmittedRevision(objectId)
      );
    } catch (error) {
      lastApplyResult = blocked(loaded.allowedCodes.has(error && error.code)
        ? error.code
        : ENTRY_ERROR.RUNTIME_UNAVAILABLE);
    }
    return lastApplyResult;
  }

  function diagnoseApply() {
    if (runtimeLoadState === 'idle' || runtimeLoadState === 'failed') {
      loadRuntime().catch(function () { /* redacted readiness only */ });
    }
    return Object.freeze({
      ok: true,
      verdict: 'chrome-revision-apply-diagnostic',
      runtimeLoadState: runtimeLoadState,
      lastVerdict: lastApplyResult ? lastApplyResult.verdict : null,
      lastErrorCode: lastApplyResult && lastApplyResult.ok === false
        ? lastApplyResult.errorCode
        : null,
      automatic: false,
      receiveCoupled: false,
      noNetwork: true
    });
  }

  function diagnose() {
    if (runtimeLoadState === 'idle' || runtimeLoadState === 'failed') {
      loadRuntime().catch(function () { /* redacted readiness only */ });
    }
    var folder = H2O.Studio.sync.folder;
    var connected = !!(folder &&
      typeof folder.getConnectedDirectoryHandle === 'function' &&
      folder.getConnectedDirectoryHandle());
    return Object.freeze({
      ok: true,
      verdict: 'item9-delivery-diagnostic',
      connected: connected,
      busy: !!inFlight,
      runtimeLoaded: runtimeLoadState === 'ready',
      runtimeReady: runtimeLoadState === 'ready',
      runtimeLoadState: runtimeLoadState,
      lastVerdict: lastResult ? lastResult.verdict : null,
      lastErrorCode: lastResult && lastResult.ok === false
        ? lastResult.errorCode
        : null,
      noNetwork: true,
      nativeArchiveMutation: false
    });
  }

  H2O.Studio.sync.item9Delivery = Object.freeze({
    deliverFromSyncFolder: deliverFromSyncFolder,
    deliverFromSyncFolderAutomatically: deliverFromSyncFolderAutomatically,
    diagnose: diagnose
  });
  H2O.Studio.sync.revisionApply = Object.freeze({
    applyNextAdmittedRevision: applyNextAdmittedRevision,
    diagnose: diagnoseApply
  });
})(globalThis);
