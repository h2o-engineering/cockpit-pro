/* H2O Studio Round 2 / Item 9-3B1 + Item 11 — verified browser-delivery producer.
 *
 * TAURI DESKTOP ONLY. This dormant adapter is intentionally not packaged or
 * loaded until Item 9-3B2 supplies its separately reviewed UI composition.
 */
(function (global) {
  'use strict';

  function detectTauri() {
    try { return !!(global.__TAURI_INTERNALS__ || global.__TAURI__); }
    catch (_) { return false; }
  }
  if (!detectTauri()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Desktop = H2O.Desktop || {};
  if (H2O.Desktop.SyncObjectDelivery) return;

  var DELIVERY_SCHEMA = 'h2o.round2.item9.browser-delivery.v1';
  var DELIVERY_SCHEMA_VERSION = 1;
  var DELIVERY_KEYS = Object.freeze([
    'deliverySchemaVersion',
    'headBytesBase64',
    'headSha256Hex',
    'objectId',
    'producedAtIso',
    'revisionBlobSha256Hex',
    'revisionBytesBase64',
    'schema'
  ]);
  var HEAD_SCHEMA = 'h2o.studio.syncHead.v1';
  var HEAD_KEYS = Object.freeze([
    'objectId',
    'objectKey',
    'payloadSha256',
    'previousRevisionId',
    'revisionBlobSha256',
    'revisionId',
    'schema',
    'sourceUpdatedAtIso',
    'writerSyncPeerId'
  ]);
  var MAX_HEAD_BYTES = 64 * 1024;
  var MAX_REVISION_BYTES = 5 * 1024 * 1024;
  var MAX_DELIVERY_BYTES = 8 * 1024 * 1024;
  var MAX_ID_LENGTH = 512;
  var HOME_BASE_DIR = 21;
  var CONFIG_KEY = 'h2o:studio:sync:config:v1';
  var DEFAULT_SYNC_FOLDER = 'H2O Studio Sync';
  var VALID_CONFIG_MODES = Object.freeze(['off', 'manual', 'notify', 'auto']);
  var VALID_PATH_MODES = Object.freeze(['relative', 'absolute']);
  var SHA256_RE = /^[0-9a-f]{64}$/;
  var ERROR_CODE = Object.freeze({
    BUSY: 'round2-item9-delivery-preparation-busy',
    OBJECT_INVALID: 'round2-item9-delivery-object-invalid',
    PROJECTION_UNAVAILABLE: 'round2-item9-delivery-projection-unavailable',
    PULL_FAILED: 'round2-item9-delivery-pull-failed',
    HEAD_MISSING: 'round2-item9-delivery-head-missing',
    HEAD_INVALID: 'round2-item9-delivery-head-invalid',
    HEAD_PARENT_MISSING: 'round2-item9-delivery-head-previous-revision-missing',
    REVISION_INVALID: 'round2-item9-delivery-revision-invalid',
    SIZE_EXCEEDED: 'round2-item9-delivery-size-exceeded',
    CHECKSUM_MISMATCH: 'round2-item9-delivery-checksum-mismatch',
    TIMESTAMP_INVALID: 'round2-item9-delivery-timestamp-invalid',
    PREPARATION_FAILED: 'round2-item9-delivery-preparation-failed',
    FOLDER_NOT_CONFIGURED: 'round2-item11-delivery-folder-not-configured',
    FOLDER_SELECTION_CANCELLED: 'round2-item11-delivery-folder-selection-cancelled',
    FOLDER_CONFIG_MISMATCH: 'round2-item11-delivery-folder-config-mismatch',
    FOLDER_INVALID: 'round2-item11-delivery-folder-invalid',
    FOLDER_SYMLINK_REJECTED: 'round2-item11-delivery-folder-symlink-rejected',
    FOLDER_MOVED_OR_REPLACED: 'round2-item11-delivery-folder-moved-or-replaced',
    FOLDER_OWNER_MISMATCH: 'round2-item11-delivery-folder-owner-mismatch',
    FOLDER_UNAVAILABLE: 'round2-item11-delivery-folder-unavailable',
    FOLDER_PERMISSION_DENIED: 'round2-item11-delivery-folder-permission-denied',
    TEMP_EXISTS: 'round2-item11-delivery-temp-exists',
    TEMP_WRITE_FAILED: 'round2-item11-delivery-temp-write-failed',
    TEMP_VERIFICATION_FAILED: 'round2-item11-delivery-temp-verification-failed',
    ATOMIC_REPLACE_FAILED: 'round2-item11-delivery-atomic-replace-failed',
    FINAL_VERIFICATION_FAILED: 'round2-item11-delivery-final-verification-failed',
    ENVELOPE_INVALID: 'round2-item11-delivery-envelope-invalid',
    AUTHORIZATION_WRITE_FAILED: 'round2-item11-delivery-authorization-write-failed',
    AUTHORIZATION_VALIDATION_FAILED: 'round2-item11-delivery-authorization-validation-failed',
    /* True-local preparation reproduces the publish path's fail-closed identity
     * contract on the public identity surface, so it reuses its exact codes. */
    IDENTITY_UNAVAILABLE: 'round2a-sync-peer-identity-unavailable',
    IDENTITY_DIVERGENT: 'round2a-sync-peer-identity-divergent',
    LOCAL_PREPARATION_FAILED: 'round2-item11-local-delivery-preparation-failed',
    RECEIVE_FAILED: 'round2-item11-local-publication-receive-failed',
    LINEAGE_READ_FAILED: 'round2-item11-local-delivery-lineage-read-failed'
  });
  /* Native intake contract, mirrored here only so a foreign shape is refused
   * rather than rendered as an admission. */
  var RECEIVE_RESULT_SCHEMA = 'h2o.studio.local-publication-receive-result.v1';
  var RECEIVE_VERDICT = Object.freeze({
    ADMITTED: 'revision-admitted',
    STAGED_DIVERGENT: 'revision-staged-divergent',
    IDENTICAL_REPLAY: 'identical-replay',
    ABSENT: 'local-publication-absent'
  });
  var testDependencies = null;
  var preparationInFlight = false;
  var localPreparationInFlight = false;
  var localReceiveInFlight = false;
  /* Runtime-only result of the latest native authorization check. It is never
   * persisted and therefore returns to not-checked after restart instead of
   * pretending a historical success is still live authority. */
  var destinationAuthorization = Object.freeze({
    valid: false,
    status: 'not-checked',
    checkedAt: null
  });

  function rememberDestinationAuthorization(valid, status) {
    destinationAuthorization = Object.freeze({
      valid: valid === true,
      status: String(status || (valid ? 'authorized' : 'not-checked')),
      checkedAt: new Date().toISOString()
    });
    return destinationAuthorization;
  }

  function destinationAuthorizationSnapshot() {
    return destinationAuthorization;
  }

  function isAuthorizationFailureCode(code) {
    var value = String(code || '');
    return value === ERROR_CODE.FOLDER_NOT_CONFIGURED ||
        value === ERROR_CODE.FOLDER_CONFIG_MISMATCH ||
        value === ERROR_CODE.FOLDER_INVALID ||
        value === ERROR_CODE.FOLDER_SYMLINK_REJECTED ||
        value === ERROR_CODE.FOLDER_MOVED_OR_REPLACED ||
        value === ERROR_CODE.FOLDER_OWNER_MISMATCH ||
        value === ERROR_CODE.FOLDER_UNAVAILABLE ||
        value === ERROR_CODE.FOLDER_PERMISSION_DENIED ||
        value === ERROR_CODE.AUTHORIZATION_VALIDATION_FAILED;
  }

  function rememberAuthorizationFailure(code) {
    var value = String(code || '');
    if (isAuthorizationFailureCode(value)) {
      return rememberDestinationAuthorization(false, value);
    }
    return destinationAuthorization;
  }

  function fail(code) {
    var error = new Error(code);
    error.code = code;
    throw error;
  }

  function own(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      Object.prototype.toString.call(value) === '[object Object]';
  }

  function hasExactKeys(value, keys) {
    return isPlainObject(value) &&
      Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
  }

  function isStrictIdentifier(value) {
    return typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_ID_LENGTH &&
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value);
  }

  function isWriterIdentity(value) {
    return typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= MAX_ID_LENGTH &&
      !/[\u0000-\u001f\u007f]/.test(value);
  }

  function isAcceptedTimestamp(value) {
    return typeof value === 'string' &&
      value.length >= 20 &&
      value.length <= 40 &&
      value.endsWith('Z') &&
      Number.isFinite(Date.parse(value));
  }

  function exactTimestamp(value) {
    if (typeof value !== 'string') fail(ERROR_CODE.TIMESTAMP_INVALID);
    var normalized;
    try { normalized = new Date(value).toISOString(); }
    catch (_) { fail(ERROR_CODE.TIMESTAMP_INVALID); }
    if (normalized !== value || !/\.\d{3}Z$/.test(value)) {
      fail(ERROR_CODE.TIMESTAMP_INVALID);
    }
    return value;
  }

  function exactUtf8Bytes(text, code) {
    if (typeof text !== 'string') fail(code);
    var bytes = new TextEncoder().encode(text);
    var decoded;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { fail(code); }
    if (decoded !== text) fail(code);
    return new Uint8Array(bytes);
  }

  function assertBytesWithinLimit(bytes, maximum, code) {
    if (!(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > maximum) {
      fail(code);
    }
    return bytes;
  }

  function assertDeliverySize(text) {
    var bytes = new TextEncoder().encode(String(text));
    if (bytes.byteLength > MAX_DELIVERY_BYTES) {
      fail(ERROR_CODE.SIZE_EXCEEDED);
    }
    return bytes.byteLength;
  }

  function bytesToBase64(bytes) {
    var alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var output = '';
    for (var index = 0; index < bytes.byteLength; index += 3) {
      var first = bytes[index];
      var hasSecond = index + 1 < bytes.byteLength;
      var hasThird = index + 2 < bytes.byteLength;
      var second = hasSecond ? bytes[index + 1] : 0;
      var third = hasThird ? bytes[index + 2] : 0;
      output += alphabet[first >> 2];
      output += alphabet[((first & 3) << 4) | (second >> 4)];
      output += hasSecond
        ? alphabet[((second & 15) << 2) | (third >> 6)]
        : '=';
      output += hasThird ? alphabet[third & 63] : '=';
    }
    return output;
  }

  function projection() {
    var value = H2O.Desktop.SyncObjectProjection;
    if (!value ||
        typeof value.canonicalJson !== 'function' ||
        typeof value.sha256HexText !== 'function' ||
        typeof value.objectKeyHex !== 'function' ||
        typeof value.validateRevisionBlob !== 'function') {
      fail(ERROR_CODE.PROJECTION_UNAVAILABLE);
    }
    return value;
  }

  function getInvoke() {
    try {
      if (global.__TAURI_INTERNALS__ &&
          typeof global.__TAURI_INTERNALS__.invoke === 'function') {
        return global.__TAURI_INTERNALS__.invoke.bind(global.__TAURI_INTERNALS__);
      }
      if (global.__TAURI__ &&
          global.__TAURI__.core &&
          typeof global.__TAURI__.core.invoke === 'function') {
        return global.__TAURI__.core.invoke.bind(global.__TAURI__.core);
      }
      if (global.__TAURI__ && typeof global.__TAURI__.invoke === 'function') {
        return global.__TAURI__.invoke.bind(global.__TAURI__);
      }
    } catch (_) { /* fail closed below */ }
    return null;
  }

  function pullTransport(request) {
    if (testDependencies && typeof testDependencies.pull === 'function') {
      return Promise.resolve(testDependencies.pull(request));
    }
    var invoke = getInvoke();
    if (!invoke) fail(ERROR_CODE.PULL_FAILED);
    return invoke('h2o_sync_object_pull_transport', { request: request });
  }

  function readRawSyncConfig() {
    if (testDependencies && typeof testDependencies.readConfig === 'function') {
      return Promise.resolve(testDependencies.readConfig());
    }
    return new Promise(function (resolve, reject) {
      try {
        if (!global.chrome || !global.chrome.storage ||
            !global.chrome.storage.local ||
            typeof global.chrome.storage.local.get !== 'function') {
          reject(new Error(ERROR_CODE.FOLDER_NOT_CONFIGURED));
          return;
        }
        global.chrome.storage.local.get([CONFIG_KEY], function (items) {
          var runtimeError = global.chrome.runtime && global.chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(ERROR_CODE.FOLDER_NOT_CONFIGURED));
            return;
          }
          resolve(items && own(items, CONFIG_KEY) ? items[CONFIG_KEY] : null);
        });
      } catch (_) {
        reject(new Error(ERROR_CODE.FOLDER_NOT_CONFIGURED));
      }
    });
  }

  function isAbsolutePath(value) {
    return value.charAt(0) === '/' || /^[A-Za-z]:[\\/]/.test(value);
  }

  function hasUnsafePathComponent(value) {
    return value.split(/[\\/]/).some(function (part) {
      return part === '.' || part === '..';
    });
  }

  function validateConfiguredFolderPath(value) {
    if (typeof value !== 'string' || value.length === 0 ||
        value.length > 4096 || value.trim() !== value ||
        /[\u0000-\u001f\u007f]/.test(value) ||
        hasUnsafePathComponent(value)) {
      fail(ERROR_CODE.FOLDER_INVALID);
    }
    var absolute = isAbsolutePath(value);
    if ((!absolute && (value.charAt(0) === '~' || value.indexOf('\\') >= 0)) ||
        (absolute && (/^\/$/.test(value) || /^[A-Za-z]:[\\/]?$/.test(value)))) {
      fail(ERROR_CODE.FOLDER_INVALID);
    }
    return absolute ? 'absolute' : 'relative';
  }

  function validateRawSyncConfig(raw) {
    if (raw === null || typeof raw === 'undefined') {
      return {
        configurationAbsent: true,
        folderPath: DEFAULT_SYNC_FOLDER,
        configuredPathMode: 'relative'
      };
    }
    var allowedKeys = [
      'folderPath',
      'configuredPeers',
      'mode',
      'phase3AutoSyncConfigVersion',
      'schemaVersion',
      'updatedAt'
    ];
    if (!isPlainObject(raw) ||
        Object.keys(raw).some(function (key) { return !allowedKeys.includes(key); }) ||
        raw.schemaVersion !== 1 ||
        !VALID_CONFIG_MODES.includes(raw.mode) ||
        typeof raw.updatedAt !== 'string' ||
        (raw.updatedAt !== '' && !isAcceptedTimestamp(raw.updatedAt)) ||
        (own(raw, 'configuredPeers') && (!Array.isArray(raw.configuredPeers) ||
          raw.configuredPeers.some(function (row) {
            return !isPlainObject(row) ||
              Object.keys(row).sort().join(',') !== 'syncPeerId,writerKey' ||
              typeof row.syncPeerId !== 'string' || row.syncPeerId.length === 0 ||
              row.syncPeerId.length > 512 || row.syncPeerId.trim() !== row.syncPeerId ||
              /[\u0000-\u001f\u007f]/.test(row.syncPeerId) ||
              typeof row.writerKey !== 'string' || !/^[0-9a-f]{64}$/.test(row.writerKey);
          }))) ||
        (own(raw, 'phase3AutoSyncConfigVersion') &&
          raw.phase3AutoSyncConfigVersion !== 1)) {
      fail(ERROR_CODE.FOLDER_INVALID);
    }
    return {
      configurationAbsent: false,
      folderPath: raw.folderPath,
      configuredPathMode: validateConfiguredFolderPath(raw.folderPath)
    };
  }

  function resolveHomeDirectory() {
    if (testDependencies && typeof testDependencies.resolveHome === 'function') {
      return Promise.resolve(testDependencies.resolveHome());
    }
    var invoke = getInvoke();
    if (!invoke) fail(ERROR_CODE.FOLDER_UNAVAILABLE);
    return invoke('plugin:path|resolve_directory', { directory: HOME_BASE_DIR });
  }

  function resolveAbsolutePath(paths) {
    if (testDependencies && typeof testDependencies.resolvePath === 'function') {
      return Promise.resolve(testDependencies.resolvePath(paths.slice()));
    }
    var invoke = getInvoke();
    if (!invoke) fail(ERROR_CODE.FOLDER_UNAVAILABLE);
    return invoke('plugin:path|resolve', { paths: paths });
  }

  async function resolveConfiguredDestination() {
    var raw;
    try { raw = await readRawSyncConfig(); }
    catch (_) { fail(ERROR_CODE.FOLDER_NOT_CONFIGURED); }
    var configured = validateRawSyncConfig(raw);
    var paths;
    if (configured.configuredPathMode === 'relative') {
      var home;
      try { home = await resolveHomeDirectory(); }
      catch (_) { fail(ERROR_CODE.FOLDER_UNAVAILABLE); }
      if (typeof home !== 'string' || !isAbsolutePath(home)) {
        fail(ERROR_CODE.FOLDER_UNAVAILABLE);
      }
      paths = [home, configured.folderPath];
    } else {
      paths = [configured.folderPath];
    }
    var resolved;
    try { resolved = await resolveAbsolutePath(paths); }
    catch (_) { fail(ERROR_CODE.FOLDER_UNAVAILABLE); }
    if (typeof resolved !== 'string' || !isAbsolutePath(resolved) ||
        resolved.length > 4096 || hasUnsafePathComponent(resolved)) {
      fail(ERROR_CODE.FOLDER_INVALID);
    }
    var acceptedProjection = projection();
    var destinationPathSha256Hex;
    try { destinationPathSha256Hex = await acceptedProjection.sha256HexText(resolved); }
    catch (_) { fail(ERROR_CODE.FOLDER_INVALID); }
    if (!SHA256_RE.test(destinationPathSha256Hex || '')) {
      fail(ERROR_CODE.FOLDER_INVALID);
    }
    return {
      configurationAbsent: configured.configurationAbsent,
      configuredPathMode: configured.configuredPathMode,
      destinationPathSha256Hex: destinationPathSha256Hex
    };
  }

  function invokeNativePrepare(request) {
    if (testDependencies && typeof testDependencies.nativePrepare === 'function') {
      return Promise.resolve(testDependencies.nativePrepare(request));
    }
    var invoke = getInvoke();
    if (!invoke) fail(ERROR_CODE.PREPARATION_FAILED);
    return invoke('h2o_item11_prepare_delivery', { request: request });
  }

  function invokeNativeSelection() {
    if (testDependencies && typeof testDependencies.nativeSelect === 'function') {
      return Promise.resolve(testDependencies.nativeSelect());
    }
    var invoke = getInvoke();
    if (!invoke) fail(ERROR_CODE.PREPARATION_FAILED);
    return invoke('h2o_item11_select_delivery_folder');
  }

  function invokeNativeAuthorizationValidation(request) {
    if (testDependencies &&
        typeof testDependencies.nativeValidateAuthorization === 'function') {
      return Promise.resolve(testDependencies.nativeValidateAuthorization(request));
    }
    var invoke = getInvoke();
    if (!invoke) fail(ERROR_CODE.AUTHORIZATION_VALIDATION_FAILED);
    return invoke('h2o_item11_validate_delivery_authorization', { request: request });
  }

  function nowIso() {
    var value = testDependencies && typeof testDependencies.clock === 'function'
      ? testDependencies.clock()
      : new Date().toISOString();
    return exactTimestamp(value);
  }

  function safeFailure(code) {
    var allowed = Object.values(ERROR_CODE);
    var safe = allowed.includes(code) ? code : ERROR_CODE.PREPARATION_FAILED;
    return Object.freeze({
      ok: false,
      verdict: 'blocked',
      errorCode: safe
    });
  }

  function safeSuccess(details) {
    return Object.freeze({
      ok: true,
      verdict: 'browser-delivery-prepared',
      objectId: details.objectId,
      revisionId: details.revisionId,
      headSha256Hex: details.headSha256Hex,
      revisionBlobSha256Hex: details.revisionBlobSha256Hex,
      payloadSha256Hex: details.payloadSha256Hex,
      producedAtIso: details.producedAtIso,
      deliveryByteLength: details.deliveryByteLength,
      destinationFolderLeafName: details.destinationFolderLeafName,
      destinationPathSha256Hex: details.destinationPathSha256Hex,
      destinationConfiguredPathMode: details.destinationConfiguredPathMode
    });
  }

  function safeErrorCode(error) {
    if (typeof error === 'string') return error;
    if (!error || typeof error !== 'object') return '';
    if (typeof error.code === 'string') return error.code;
    if (typeof error.message === 'string') return error.message;
    return '';
  }

  function validateRedactedDestinationEvidence(value, expectedVerdict) {
    if (!isPlainObject(value) ||
        value.ok !== true || value.verdict !== expectedVerdict ||
        typeof value.destinationFolderLeafName !== 'string' ||
        value.destinationFolderLeafName.length === 0 ||
        value.destinationFolderLeafName.length > 255 ||
        /[\\/\u0000-\u001f\u007f]/.test(value.destinationFolderLeafName) ||
        !SHA256_RE.test(value.destinationPathSha256Hex || '') ||
        !VALID_PATH_MODES.includes(value.destinationConfiguredPathMode)) {
      fail(ERROR_CODE.PREPARATION_FAILED);
    }
    return value;
  }

  function validateAuthorizationEvidence(value, expected) {
    var keys = [
      'destinationConfiguredPathMode',
      'destinationFolderLeafName',
      'destinationPathSha256Hex',
      'noNetwork',
      'ok',
      'readOnly',
      'status',
      'verdict'
    ];
    if (!hasExactKeys(value, keys) ||
        value.ok !== true ||
        value.verdict !== 'delivery-authorization-validated' ||
        value.status !== 'authorized' ||
        value.readOnly !== true ||
        value.noNetwork !== true ||
        typeof value.destinationFolderLeafName !== 'string' ||
        value.destinationFolderLeafName.length === 0 ||
        value.destinationFolderLeafName.length > 255 ||
        /[\\/\u0000-\u001f\u007f]/.test(value.destinationFolderLeafName) ||
        value.destinationPathSha256Hex !== expected.destinationPathSha256Hex ||
        value.destinationConfiguredPathMode !== expected.configuredPathMode) {
      fail(ERROR_CODE.AUTHORIZATION_VALIDATION_FAILED);
    }
    return value;
  }

  async function rehydrateDestinationAuthorization() {
    try {
      var destination = await resolveConfiguredDestination();
      if (destination.configurationAbsent) fail(ERROR_CODE.FOLDER_NOT_CONFIGURED);
      var validated = await invokeNativeAuthorizationValidation({
        expectedDestinationPathSha256Hex: destination.destinationPathSha256Hex,
        destinationConfiguredPathMode: destination.configuredPathMode
      });
      validateAuthorizationEvidence(validated, destination);
      return rememberDestinationAuthorization(true, 'authorized');
    } catch (error) {
      var code = safeErrorCode(error);
      return rememberDestinationAuthorization(
        false,
        isAuthorizationFailureCode(code)
          ? code
          : ERROR_CODE.AUTHORIZATION_VALIDATION_FAILED
      );
    }
  }

  function validateHead(headCanonicalText, expected, acceptedProjection) {
    var headBytes = assertBytesWithinLimit(
      exactUtf8Bytes(headCanonicalText, ERROR_CODE.HEAD_INVALID),
      MAX_HEAD_BYTES,
      ERROR_CODE.SIZE_EXCEEDED
    );
    var head;
    try { head = JSON.parse(headCanonicalText); }
    catch (_) { fail(ERROR_CODE.HEAD_INVALID); }
    if (!isPlainObject(head) || !own(head, 'previousRevisionId')) {
      if (isPlainObject(head) && !own(head, 'previousRevisionId')) {
        fail(ERROR_CODE.HEAD_PARENT_MISSING);
      }
      fail(ERROR_CODE.HEAD_INVALID);
    }
    if (!hasExactKeys(head, HEAD_KEYS) ||
        head.schema !== HEAD_SCHEMA ||
        acceptedProjection.canonicalJson(head) !== headCanonicalText ||
        !isStrictIdentifier(head.objectId) ||
        !isStrictIdentifier(head.revisionId) ||
        !SHA256_RE.test(head.objectKey || '') ||
        !SHA256_RE.test(head.payloadSha256 || '') ||
        !SHA256_RE.test(head.revisionBlobSha256 || '') ||
        !isWriterIdentity(head.writerSyncPeerId) ||
        (head.previousRevisionId !== null &&
          !isStrictIdentifier(head.previousRevisionId)) ||
        !isAcceptedTimestamp(head.sourceUpdatedAtIso)) {
      fail(ERROR_CODE.HEAD_INVALID);
    }
    if (head.objectId !== expected.objectId ||
        head.objectKey !== expected.objectKeyHex ||
        head.revisionId !== expected.revisionId ||
        head.payloadSha256 !== expected.payloadSha256Hex ||
        head.revisionBlobSha256 !== expected.revisionBlobSha256Hex) {
      fail(ERROR_CODE.CHECKSUM_MISMATCH);
    }
    if (expected.head &&
        acceptedProjection.canonicalJson(expected.head) !== headCanonicalText) {
      fail(ERROR_CODE.HEAD_INVALID);
    }
    return { head: head, bytes: new Uint8Array(headBytes) };
  }

  async function buildVerifiedDelivery(objectId) {
    if (!isStrictIdentifier(objectId)) fail(ERROR_CODE.OBJECT_INVALID);
    var acceptedProjection = projection();
    var objectKeyHex;
    try { objectKeyHex = await acceptedProjection.objectKeyHex(objectId); }
    catch (_) { fail(ERROR_CODE.OBJECT_INVALID); }
    if (!SHA256_RE.test(objectKeyHex || '')) fail(ERROR_CODE.OBJECT_INVALID);

    var pulled;
    try {
      pulled = await pullTransport({
        objectId: objectId,
        objectKeyHex: objectKeyHex,
        maxRevisionBytes: MAX_REVISION_BYTES
      });
    } catch (_) {
      fail(ERROR_CODE.PULL_FAILED);
    }
    if (!pulled ||
        pulled.ok !== true ||
        pulled.transportVerified !== true) {
      fail(ERROR_CODE.PULL_FAILED);
    }
    if (pulled.headPresent !== true ||
        !isPlainObject(pulled.head) ||
        typeof pulled.headCanonicalText !== 'string') {
      fail(ERROR_CODE.HEAD_MISSING);
    }
    if (typeof pulled.revisionBlobText !== 'string') {
      fail(ERROR_CODE.REVISION_INVALID);
    }

    var revisionBytes = assertBytesWithinLimit(
      exactUtf8Bytes(pulled.revisionBlobText, ERROR_CODE.REVISION_INVALID),
      MAX_REVISION_BYTES,
      ERROR_CODE.SIZE_EXCEEDED
    );
    var revisionBlobSha256Hex;
    try {
      revisionBlobSha256Hex =
        await acceptedProjection.sha256HexText(pulled.revisionBlobText);
    } catch (_) {
      fail(ERROR_CODE.REVISION_INVALID);
    }
    if (!SHA256_RE.test(revisionBlobSha256Hex || '')) {
      fail(ERROR_CODE.REVISION_INVALID);
    }

    var revision;
    try {
      revision = await acceptedProjection.validateRevisionBlob(
        pulled.revisionBlobText,
        {
          objectId: objectId,
          objectKeyHex: objectKeyHex,
          revisionId: pulled.head.revisionId,
          payloadSha256Hex: pulled.head.payloadSha256,
          revisionBlobSha256Hex: revisionBlobSha256Hex
        }
      );
    } catch (_) {
      fail(ERROR_CODE.REVISION_INVALID);
    }
    if (!revision ||
        revision.objectId !== objectId ||
        revision.objectKey !== objectKeyHex ||
        revision.revisionId !== pulled.head.revisionId ||
        revision.payloadSha256 !== pulled.head.payloadSha256 ||
        revisionBlobSha256Hex !== pulled.head.revisionBlobSha256) {
      fail(ERROR_CODE.CHECKSUM_MISMATCH);
    }

    var verifiedHead = validateHead(
      pulled.headCanonicalText,
      {
        objectId: objectId,
        objectKeyHex: objectKeyHex,
        revisionId: revision.revisionId,
        payloadSha256Hex: revision.payloadSha256,
        revisionBlobSha256Hex: revisionBlobSha256Hex,
        head: pulled.head
      },
      acceptedProjection
    );
    var independentlyDerivedKey;
    try { independentlyDerivedKey = await acceptedProjection.objectKeyHex(verifiedHead.head.objectId); }
    catch (_) { fail(ERROR_CODE.OBJECT_INVALID); }
    if (independentlyDerivedKey !== verifiedHead.head.objectKey) {
      fail(ERROR_CODE.CHECKSUM_MISMATCH);
    }

    var headSha256Hex;
    try {
      headSha256Hex =
        await acceptedProjection.sha256HexText(pulled.headCanonicalText);
    } catch (_) {
      fail(ERROR_CODE.HEAD_INVALID);
    }
    if (!SHA256_RE.test(headSha256Hex || '')) fail(ERROR_CODE.HEAD_INVALID);
    var producedAtIso = nowIso();
    var envelope = {
      schema: DELIVERY_SCHEMA,
      deliverySchemaVersion: DELIVERY_SCHEMA_VERSION,
      objectId: objectId,
      headBytesBase64: bytesToBase64(
        new Uint8Array(verifiedHead.bytes)
      ),
      revisionBytesBase64: bytesToBase64(
        new Uint8Array(revisionBytes)
      ),
      headSha256Hex: headSha256Hex,
      revisionBlobSha256Hex: revisionBlobSha256Hex,
      producedAtIso: producedAtIso
    };
    if (!hasExactKeys(envelope, DELIVERY_KEYS)) {
      fail(ERROR_CODE.PREPARATION_FAILED);
    }
    var deliveryJsonText;
    try { deliveryJsonText = acceptedProjection.canonicalJson(envelope); }
    catch (_) { fail(ERROR_CODE.PREPARATION_FAILED); }
    var deliveryByteLength = assertDeliverySize(deliveryJsonText);
    return {
      objectId: objectId,
      revisionId: revision.revisionId,
      headSha256Hex: headSha256Hex,
      revisionBlobSha256Hex: revisionBlobSha256Hex,
      payloadSha256Hex: revision.payloadSha256,
      producedAtIso: producedAtIso,
      deliveryByteLength: deliveryByteLength,
      deliveryJsonText: deliveryJsonText
    };
  }

  async function writeThroughNativeBoundary(verified, destination) {
    var nativeResult;
    try {
      nativeResult = await invokeNativePrepare({
        deliveryJson: verified.deliveryJsonText,
        objectId: verified.objectId,
        expectedDestinationPathSha256Hex: destination.destinationPathSha256Hex,
        destinationConfiguredPathMode: destination.configuredPathMode,
        configurationAbsent: destination.configurationAbsent
      });
    } catch (error) {
      fail(safeErrorCode(error));
    }
    validateRedactedDestinationEvidence(nativeResult, 'delivery-written');
    if (nativeResult.destinationPathSha256Hex !== destination.destinationPathSha256Hex ||
        nativeResult.destinationConfiguredPathMode !== destination.configuredPathMode) {
      fail(ERROR_CODE.FOLDER_CONFIG_MISMATCH);
    }
    return nativeResult;
  }

  async function prepareBrowserDelivery(objectId) {
    if (preparationInFlight) return safeFailure(ERROR_CODE.BUSY);
    preparationInFlight = true;
    try {
      var destination = await resolveConfiguredDestination();
      var verified = await buildVerifiedDelivery(objectId);
      var nativeResult = await writeThroughNativeBoundary(verified, destination);
      rememberDestinationAuthorization(true, 'authorized');
      verified.destinationFolderLeafName = nativeResult.destinationFolderLeafName;
      verified.destinationPathSha256Hex = nativeResult.destinationPathSha256Hex;
      verified.destinationConfiguredPathMode = nativeResult.destinationConfiguredPathMode;
      return safeSuccess(verified);
    } catch (error) {
      var code = safeErrorCode(error);
      rememberAuthorizationFailure(code);
      return safeFailure(code);
    } finally {
      preparationInFlight = false;
    }
  }

  /* ── True-local browser delivery ──────────────────────────────────────────
   * Structurally separate from prepareBrowserDelivery above. Its reachable
   * graph is projectObject → identity → resolveConfiguredDestination → the
   * native local command, with no edge to pullTransport, buildVerifiedDelivery
   * or any transport at all. A local failure stays a local failure: there is no
   * remote fallback, because there is no remote call site to fall back to. */

  function identityApi() {
    if (testDependencies && testDependencies.identity) return testDependencies.identity;
    var studio = H2O.Studio;
    var identity = studio && studio.identity;
    if (!identity ||
        typeof identity.whenReady !== 'function' ||
        typeof identity.authority !== 'function' ||
        typeof identity.get !== 'function') {
      fail(ERROR_CODE.IDENTITY_UNAVAILABLE);
    }
    return identity;
  }

  /* The publish path's fail-closed sequence, reproduced on the public identity
   * surface in the same order: readiness, then authority, then the value. A
   * divergent or non-canonical Desktop identity never reaches the native call. */
  async function canonicalWriterSyncPeerId() {
    var identity = identityApi();
    try {
      await identity.whenReady();
    } catch (_) {
      fail(ERROR_CODE.IDENTITY_UNAVAILABLE);
    }
    var authority = identity.authority();
    if (authority && authority.desktop === true && authority.canonical !== true) {
      if (authority.status === 'divergent') fail(ERROR_CODE.IDENTITY_DIVERGENT);
      fail(ERROR_CODE.IDENTITY_UNAVAILABLE);
    }
    var value = identity.get();
    var syncPeerId = value && value.syncPeerId;
    if (!isWriterIdentity(syncPeerId)) fail(ERROR_CODE.IDENTITY_UNAVAILABLE);
    return syncPeerId;
  }

  function localProjection(objectId) {
    if (testDependencies && typeof testDependencies.projectObject === 'function') {
      return Promise.resolve(testDependencies.projectObject(objectId));
    }
    var acceptedProjection = projection();
    if (typeof acceptedProjection.projectObject !== 'function') {
      fail(ERROR_CODE.PROJECTION_UNAVAILABLE);
    }
    return acceptedProjection.projectObject(objectId);
  }

  function invokeNativeLocalPrepare(request) {
    if (testDependencies && typeof testDependencies.nativeLocalPrepare === 'function') {
      return Promise.resolve(testDependencies.nativeLocalPrepare(request));
    }
    var invoke = getInvoke();
    if (!invoke) fail(ERROR_CODE.LOCAL_PREPARATION_FAILED);
    return invoke('h2o_item11_prepare_local_delivery', { request: request });
  }

  function invokeNativeLineageRead(request) {
    if (testDependencies && typeof testDependencies.nativeLineageRead === 'function') {
      return Promise.resolve(testDependencies.nativeLineageRead(request));
    }
    var invoke = getInvoke();
    if (!invoke) fail(ERROR_CODE.LINEAGE_READ_FAILED);
    return invoke('h2o_item11_read_lineage', { request: request });
  }

  function safeLineageResult(result, expectedObjectId) {
    var state = result && result.state;
    var chain = Array.isArray(result && result.chain) ? result.chain : [];
    var current = result && result.currentRevisionId;
    var currentHash = result && result.currentRevisionBlobSha256Hex;
    var previous = result && result.previousRevisionId;
    var pending = result && result.pendingRevisionId;
    var shapeValid = state === 'empty'
      ? current === null && currentHash === null && previous === null && pending === null && chain.length === 0
      : state === 'current'
        ? isStrictIdentifier(current) && SHA256_RE.test(currentHash || '') && pending === null && chain.length >= 1 &&
          chain[chain.length - 1] === current &&
          (previous === null || (chain.length === 2 && chain[0] === previous))
        : state === 'pending' && isStrictIdentifier(pending) &&
          (current === null ? chain.length === 0 : chain[chain.length - 1] === current);
    if (!isPlainObject(result) || result.ok !== true ||
        result.verdict !== 'delivery-lineage-read' ||
        !isStrictIdentifier(result.objectId) || result.objectId !== expectedObjectId ||
        !['empty', 'current', 'pending'].includes(state) ||
        !Array.isArray(result.chain) || chain.length > 2 ||
        chain.some(function (value) { return !isStrictIdentifier(value); }) ||
        (current !== null && !isStrictIdentifier(current)) ||
        (currentHash !== null && !SHA256_RE.test(currentHash || '')) ||
        ((current === null) !== (currentHash === null)) ||
        (previous !== null && !isStrictIdentifier(previous)) ||
        (pending !== null && !isStrictIdentifier(pending)) || !shapeValid ||
        (result.updatedAt !== null && !isAcceptedTimestamp(result.updatedAt)) ||
        result.readOnly !== true || result.noNetwork !== true) {
      fail(ERROR_CODE.LINEAGE_READ_FAILED);
    }
    return Object.freeze({
      ok: true,
      verdict: result.verdict,
      state: result.state,
      objectId: result.objectId,
      currentRevisionId: result.currentRevisionId,
      currentRevisionBlobSha256Hex: result.currentRevisionBlobSha256Hex,
      previousRevisionId: result.previousRevisionId,
      pendingRevisionId: result.pendingRevisionId,
      chain: Object.freeze(result.chain.slice()),
      updatedAt: typeof result.updatedAt === 'string' ? result.updatedAt : null,
      readOnly: true,
      noNetwork: true
    });
  }

  /* M3 read-only projection of the native Item 11 lineage authority. The same
   * canonical identity, configured destination and native binding checks used
   * by preparation guard this read. No ledger path, hashes or raw identity are
   * exposed, and an absent explicit folder configuration never creates the
   * default destination as a side effect of inspection. */
  async function readLineage(objectId) {
    try {
      if (!isStrictIdentifier(objectId)) fail(ERROR_CODE.OBJECT_INVALID);
      var writerSyncPeerId = await canonicalWriterSyncPeerId();
      var destination = await resolveConfiguredDestination();
      if (destination.configurationAbsent) fail(ERROR_CODE.FOLDER_NOT_CONFIGURED);
      return safeLineageResult(await invokeNativeLineageRead({
        objectId: objectId,
        writerSyncPeerId: writerSyncPeerId,
        expectedDestinationPathSha256Hex: destination.destinationPathSha256Hex,
        destinationConfiguredPathMode: destination.configuredPathMode
      }), objectId);
    } catch (error) {
      var code = safeErrorCode(error);
      rememberAuthorizationFailure(code);
      return safeFailure(Object.values(ERROR_CODE).includes(code)
        ? code
        : ERROR_CODE.LINEAGE_READ_FAILED);
    }
  }

  function safeLocalSuccess(result) {
    if (!isPlainObject(result) || result.ok !== true) {
      fail(ERROR_CODE.LOCAL_PREPARATION_FAILED);
    }
    return Object.freeze({
      ok: true,
      verdict: result.verdict,
      objectId: result.objectId,
      revisionId: result.revisionId,
      previousRevisionId: result.previousRevisionId ?? null,
      headSha256Hex: result.headSha256Hex,
      revisionBlobSha256Hex: result.revisionBlobSha256Hex,
      payloadSha256Hex: result.payloadSha256Hex,
      deliverySha256Hex: result.deliverySha256Hex,
      producedAtIso: result.producedAtIso,
      deliveryByteLength: result.deliveryByteLength,
      destinationFolderLeafName: result.destinationFolderLeafName,
      destinationPathSha256Hex: result.destinationPathSha256Hex,
      destinationConfiguredPathMode: result.destinationConfiguredPathMode,
      lineageDisposition: result.lineageDisposition,
      slotPosture: result.slotPosture,
      noNetwork: result.noNetwork === true
    });
  }

  async function prepareLocalBrowserDelivery(objectId) {
    if (localPreparationInFlight) return safeFailure(ERROR_CODE.BUSY);
    localPreparationInFlight = true;
    try {
      if (!isStrictIdentifier(objectId)) fail(ERROR_CODE.OBJECT_INVALID);
      /* Local authority only. previousRevisionId, producedAtIso, the head bytes
       * and every digest of the delivery envelope are native authority and are
       * deliberately absent from this request. */
      var projected = await localProjection(objectId);
      if (!isPlainObject(projected)) fail(ERROR_CODE.PROJECTION_UNAVAILABLE);
      var writerSyncPeerId = await canonicalWriterSyncPeerId();
      var destination = await resolveConfiguredDestination();
      var native = await invokeNativeLocalPrepare({
        objectId: objectId,
        objectKeyHex: projected.objectKeyHex,
        revisionId: projected.revisionId,
        payloadSha256Hex: projected.payloadSha256Hex,
        revisionBlobText: projected.revisionBlobText,
        revisionBlobSha256Hex: projected.revisionBlobSha256Hex,
        writerSyncPeerId: writerSyncPeerId,
        sourceUpdatedAtIso: projected.sourceUpdatedAtIso,
        expectedDestinationPathSha256Hex: destination.destinationPathSha256Hex,
        destinationConfiguredPathMode: destination.configuredPathMode,
        configurationAbsent: destination.configurationAbsent
      });
      rememberDestinationAuthorization(true, 'authorized');
      return safeLocalSuccess(native);
    } catch (error) {
      /* A local failure is returned as a local failure. Nothing here retries
       * against a transport, and no remote producer is reachable from it. */
      var code = safeErrorCode(error);
      rememberAuthorizationFailure(code);
      return safeFailure(code);
    } finally {
      localPreparationInFlight = false;
    }
  }

  /* Chrome -> Desktop intake. The native command owns the authorized folder,
   * the envelope read, the admission decision and every digest; it takes no
   * arguments precisely so this surface cannot aim it somewhere else. Nothing
   * here retries, polls, or applies: one explicit activation is one invocation,
   * and the returned admission is reported exactly as the native authority
   * stated it. */
  function invokeNativeLocalReceive() {
    if (testDependencies && typeof testDependencies.nativeLocalReceive === 'function') {
      return Promise.resolve(testDependencies.nativeLocalReceive());
    }
    var invoke = getInvoke();
    if (!invoke) fail(ERROR_CODE.RECEIVE_FAILED);
    return invoke('h2o_local_publication_receive');
  }

  function safeReceiveResult(result) {
    if (!isPlainObject(result) || result.schema !== RECEIVE_RESULT_SCHEMA) {
      fail(ERROR_CODE.RECEIVE_FAILED);
    }
    /* noApply and noNetwork are contract, not decoration: a native result that
     * does not assert both is refused rather than surfaced as a success. */
    if (result.noApply !== true || result.noNetwork !== true) {
      fail(ERROR_CODE.RECEIVE_FAILED);
    }
    var verdict = typeof result.verdict === 'string' ? result.verdict : '';
    if (!verdict) fail(ERROR_CODE.RECEIVE_FAILED);
    return Object.freeze({
      ok: result.ok === true,
      verdict: verdict,
      reason: typeof result.reason === 'string' ? result.reason : null,
      objectId: typeof result.objectId === 'string' ? result.objectId : null,
      revisionId: typeof result.revisionId === 'string' ? result.revisionId : null,
      admissionDisposition: typeof result.historicalAdmission === 'string'
        ? result.historicalAdmission
        : null,
      unchangedNoOp: result.unchangedNoOp === true,
      observationCount: Number.isFinite(result.observationCount)
        ? result.observationCount
        : 0,
      divergent: verdict === RECEIVE_VERDICT.STAGED_DIVERGENT,
      noApply: true,
      noNetwork: true
    });
  }

  async function receiveLocalPublication() {
    if (localReceiveInFlight) return safeFailure(ERROR_CODE.BUSY);
    localReceiveInFlight = true;
    try {
      return safeReceiveResult(await invokeNativeLocalReceive());
    } catch (error) {
      return safeFailure(safeErrorCode(error));
    } finally {
      localReceiveInFlight = false;
    }
  }

  async function setExistingSyncConfigFolder(configuredFolderPath) {
    if (testDependencies && typeof testDependencies.setSyncConfig === 'function') {
      return Promise.resolve(testDependencies.setSyncConfig({ folderPath: configuredFolderPath }));
    }
    if (!H2O.Studio || !H2O.Studio.sync ||
        typeof H2O.Studio.sync.setConfig !== 'function') {
      fail(ERROR_CODE.FOLDER_NOT_CONFIGURED);
    }
    return H2O.Studio.sync.setConfig({ folderPath: configuredFolderPath });
  }

  async function selectDeliveryFolder() {
    try {
      var selected = await invokeNativeSelection();
      validateRedactedDestinationEvidence(selected, 'delivery-folder-selected');
      if (typeof selected.configuredFolderPath !== 'string' ||
          selected.configuredFolderPath.length === 0 ||
          validateConfiguredFolderPath(selected.configuredFolderPath) !==
            selected.destinationConfiguredPathMode) {
        fail(ERROR_CODE.FOLDER_INVALID);
      }
      await setExistingSyncConfigFolder(selected.configuredFolderPath);
      rememberDestinationAuthorization(true, 'authorized');
      return Object.freeze({
        ok: true,
        verdict: 'delivery-folder-selected',
        destinationFolderLeafName: selected.destinationFolderLeafName,
        destinationPathSha256Hex: selected.destinationPathSha256Hex,
        destinationConfiguredPathMode: selected.destinationConfiguredPathMode
      });
    } catch (error) {
      var code = safeErrorCode(error);
      rememberAuthorizationFailure(code);
      return safeFailure(code);
    }
  }

  function diagnose() {
    return Object.freeze({
      ok: true,
      verdict: 'browser-delivery-producer-ready',
      runtimeReachable: false,
      packaged: false,
      loadedByStudio: false,
      destinationAuthorization: destinationAuthorizationSnapshot()
    });
  }

  H2O.Desktop.SyncObjectDelivery = Object.freeze({
    prepareBrowserDelivery: prepareBrowserDelivery,
    prepareLocalBrowserDelivery: prepareLocalBrowserDelivery,
    receiveLocalPublication: receiveLocalPublication,
    readLineage: readLineage,
    selectDeliveryFolder: selectDeliveryFolder,
    rehydrateDestinationAuthorization: rehydrateDestinationAuthorization,
    destinationAuthorizationSnapshot: destinationAuthorizationSnapshot,
    diagnose: diagnose,
    __test: Object.freeze({
      constants: Object.freeze({
        DELIVERY_SCHEMA: DELIVERY_SCHEMA,
        DELIVERY_SCHEMA_VERSION: DELIVERY_SCHEMA_VERSION,
        DELIVERY_KEYS: DELIVERY_KEYS,
        MAX_HEAD_BYTES: MAX_HEAD_BYTES,
        MAX_REVISION_BYTES: MAX_REVISION_BYTES,
        MAX_DELIVERY_BYTES: MAX_DELIVERY_BYTES,
        HOME_BASE_DIR: HOME_BASE_DIR,
        CONFIG_KEY: CONFIG_KEY,
        DEFAULT_SYNC_FOLDER: DEFAULT_SYNC_FOLDER,
        ERROR_CODE: ERROR_CODE
      }),
      setDependencies: function (next) { testDependencies = next || null; },
      clearDependencies: function () { testDependencies = null; },
      assertBytesWithinLimit: assertBytesWithinLimit,
      assertDeliverySize: assertDeliverySize,
      bytesToBase64: bytesToBase64,
      validateRawSyncConfig: validateRawSyncConfig,
      validateConfiguredFolderPath: validateConfiguredFolderPath
    })
  });
})(typeof window !== 'undefined' ? window : globalThis);
