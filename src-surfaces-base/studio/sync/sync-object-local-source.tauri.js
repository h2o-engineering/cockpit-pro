/* H2O Studio P01 — admitted local revision source for canonical convergence.
 * Loading only attaches an API. Reads occur solely after an explicit request;
 * this module never receives, admits, applies, schedules, retries, or mutates.
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
  if (H2O.Desktop.SyncObjectLocalSource) return;

  var DB_URL = 'sqlite:studio-v1.db';
  var MAX_REVISION_BYTES = 5 * 1024 * 1024;
  var OBSERVATION_SCHEMA = 'h2o.studio.inbound-revision-observation.v1';
  var HEAD_SCHEMA = 'h2o.studio.syncHead.v1';
  var REVISION_SCHEMA = 'h2o.studio.syncRevision.v1';
  var SOURCE_KIND = 'admitted-local';
  var CHROME_WRITER_PREFIX = 'studio-chrome:mv3-chrome:idb-archive:';
  var testDependencies = null;

  function fail(code) {
    var error = new Error(code);
    error.code = code;
    throw error;
  }
  function clean(value) { return String(value == null ? '' : value).trim(); }
  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function validIdentity(value) {
    return typeof value === 'string' && value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
  }
  function lowerHex64(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
  function exactKeys(value, keys) {
    return isObject(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
  }
  function nullableIdentity(value) {
    if (value == null) return null;
    if (!validIdentity(value)) fail('local-revision-evidence-invalid');
    return value;
  }
  function isUuidV4(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  }
  function validChromeWriter(value) {
    return typeof value === 'string' && value.indexOf(CHROME_WRITER_PREFIX) === 0 && isUuidV4(value.slice(CHROME_WRITER_PREFIX.length));
  }

  function getInvoke() {
    if (testDependencies && testDependencies.invoke) return testDependencies.invoke;
    try {
      if (global.__TAURI_INTERNALS__ && typeof global.__TAURI_INTERNALS__.invoke === 'function') return global.__TAURI_INTERNALS__.invoke.bind(global.__TAURI_INTERNALS__);
      if (global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === 'function') return global.__TAURI__.core.invoke.bind(global.__TAURI__.core);
      if (global.__TAURI__ && typeof global.__TAURI__.invoke === 'function') return global.__TAURI__.invoke.bind(global.__TAURI__);
    } catch (_) { /* ignore */ }
    return null;
  }

  function sqlSelect(query, values) {
    if (testDependencies && testDependencies.sql) return testDependencies.sql.select(query, values || []);
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('local-revision-source-unavailable'));
    return invoke('plugin:sql|select', { db: DB_URL, query: query, values: values || [] });
  }

  function readBranches(objectId) {
    if (testDependencies && testDependencies.readBranches) return testDependencies.readBranches(objectId);
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('local-revision-source-unavailable'));
    return invoke('h2o_local_publication_read_branches', { objectId: objectId });
  }

  function projection() {
    var api = H2O.Desktop.SyncObjectProjection;
    if (!api || typeof api.canonicalJson !== 'function' || typeof api.sha256HexText !== 'function') {
      fail('local-revision-source-unavailable');
    }
    return api;
  }

  function bytes(value) {
    var result;
    if (Array.isArray(value)) result = new Uint8Array(value);
    else if (global.ArrayBuffer && global.ArrayBuffer.isView(value)) {
      result = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else if (global.ArrayBuffer && value instanceof global.ArrayBuffer) result = new Uint8Array(value);
    else if (isObject(value) && value.type === 'Buffer' && Array.isArray(value.data)) result = new Uint8Array(value.data);
    else fail('local-revision-evidence-invalid');
    return new Uint8Array(result);
  }

  function utf8Text(value) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
    catch (_) { fail('local-revision-evidence-invalid'); }
  }

  async function sha256HexBytes(value) {
    if (!global.crypto || !global.crypto.subtle) fail('local-revision-source-unavailable');
    var digest = await global.crypto.subtle.digest('SHA-256', value);
    return Array.from(new Uint8Array(digest)).map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function blocked(code) {
    return {
      ok: false,
      verdict: 'blocked',
      headPresent: false,
      sourceKind: SOURCE_KIND,
      sourceVerified: true,
      conflictClass: code,
      errorCode: code
    };
  }

  function validateBranchView(view, objectId) {
    if (!isObject(view) || view.ok !== true || view.schema !== 'h2o.studio.local-publication-branches.v1' ||
        view.objectId !== objectId || view.noApply !== true || view.noNetwork !== true ||
        !Array.isArray(view.pendingChain) || !Array.isArray(view.branches)) {
      fail('local-revision-branch-view-invalid');
    }
    if (view.anchor != null && !validIdentity(view.anchor)) fail('local-revision-branch-view-invalid');
    var seen = new Set();
    view.pendingChain.forEach(function (revisionId) {
      if (!validIdentity(revisionId) || seen.has(revisionId)) fail('local-revision-branch-view-invalid');
      seen.add(revisionId);
    });
    view.branches.forEach(function (branch) {
      if (!isObject(branch) || !validIdentity(branch.revisionId) ||
          (branch.parentRevisionId != null && !validIdentity(branch.parentRevisionId)) ||
          !lowerHex64(branch.revisionBlobSha256Hex) || !lowerHex64(branch.payloadSha256Hex) ||
          !lowerHex64(branch.headSha256Hex) || !lowerHex64(branch.writerSyncPeerIdSha256Hex) ||
          branch.applyState !== 'not-applied') {
        fail('local-revision-branch-view-invalid');
      }
    });
    return view;
  }

  function selectCandidate(view) {
    if (view.unavailableReason) return { blocked: 'local-revision-baseline-unavailable' };
    if (view.branches.some(function (branch) {
      return branch.historicalAdmission === 'divergent-staged' || branch.currentRelationship === 'divergent-staged';
    })) return { blocked: 'local-revision-divergence' };

    var revisionId = view.pendingChain.length ? view.pendingChain[0] : view.anchor;
    if (!revisionId) return { absent: true };
    var matches = view.branches.filter(function (branch) { return branch.revisionId === revisionId; });
    /* `branches` is sourced from the inbound admission ledger, so a
     * Desktop-authored anchor that was never received from Chrome legitimately
     * matches nothing. Replaying such an anchor means "nothing admitted to
     * apply" — a no-op — not an identity conflict. Only the replay case is
     * relaxed: a pending-chain entry with no matching branch, or any duplicate
     * match, remains fail-closed. */
    if (matches.length === 0 && view.pendingChain.length === 0) return { absent: true };
    if (matches.length !== 1) fail('local-revision-identity-conflict');
    var candidate = matches[0];
    var replay = view.pendingChain.length === 0;
    if (candidate.historicalAdmission !== 'accepted-linear' || candidate.applyState !== 'not-applied' ||
        (!replay && candidate.currentRelationship !== 'pending-from-current-anchor') ||
        (!replay && nullableIdentity(candidate.parentRevisionId) !== nullableIdentity(view.anchor))) {
      fail('local-revision-not-linear');
    }
    return { candidate: candidate, replay: replay };
  }

  async function validateObservation(row, branch, request) {
    if (!isObject(row) || row.schema !== OBSERVATION_SCHEMA || row.object_id !== request.objectId ||
        row.object_key_sha256_hex !== request.objectKeyHex || row.revision_id !== branch.revisionId ||
        nullableIdentity(row.parent_revision_id) !== nullableIdentity(branch.parentRevisionId) ||
        row.admission_disposition !== branch.historicalAdmission || row.admission_reason !== branch.admissionReason ||
        row.head_sha256_hex !== branch.headSha256Hex || row.revision_blob_sha256_hex !== branch.revisionBlobSha256Hex ||
        row.payload_sha256_hex !== branch.payloadSha256Hex ||
        row.writer_sync_peer_id_sha256_hex !== branch.writerSyncPeerIdSha256Hex ||
        row.observed_state !== 'observed' || row.apply_state !== 'not-applied' ||
        row.parent_key !== (branch.parentRevisionId == null ? 'root' : 'p:' + branch.parentRevisionId) ||
        !lowerHex64(row.key) || row.key !== row.revision_key_sha256_hex || !lowerHex64(row.peer_object_key)) {
      fail('local-revision-identity-conflict');
    }

    var expectedPeerObjectKey = await projection().sha256HexText(row.writer_sync_peer_id_sha256_hex + '\u0000' + request.objectKeyHex);
    var expectedRevisionKey = await projection().sha256HexText(row.peer_object_key + '\u0000' + branch.revisionId);
    if (row.peer_object_key !== expectedPeerObjectKey || row.key !== expectedRevisionKey) {
      fail('local-revision-identity-conflict');
    }

    var headBytes = bytes(row.canonical_head_bytes);
    var revisionBytes = bytes(row.canonical_revision_bytes);
    if (!headBytes.byteLength || headBytes.byteLength > 64 * 1024 ||
        !revisionBytes.byteLength || revisionBytes.byteLength > request.maxRevisionBytes ||
        await sha256HexBytes(headBytes) !== row.head_sha256_hex ||
        await sha256HexBytes(revisionBytes) !== row.revision_blob_sha256_hex) {
      fail('local-revision-evidence-invalid');
    }

    var headText = utf8Text(headBytes);
    var revisionText = utf8Text(revisionBytes);
    var head;
    var revision;
    try { head = JSON.parse(headText); revision = JSON.parse(revisionText); }
    catch (_) { fail('local-revision-evidence-invalid'); }
    if (!exactKeys(head, ['schema', 'objectId', 'objectKey', 'revisionId', 'payloadSha256', 'revisionBlobSha256', 'writerSyncPeerId', 'previousRevisionId', 'sourceUpdatedAtIso']) ||
        !exactKeys(revision, ['schema', 'objectId', 'objectKey', 'revisionId', 'payloadSha256', 'payload']) ||
        projection().canonicalJson(head) !== headText || projection().canonicalJson(revision) !== revisionText ||
        head.schema !== HEAD_SCHEMA || revision.schema !== REVISION_SCHEMA ||
        head.objectId !== request.objectId || revision.objectId !== request.objectId ||
        head.objectKey !== request.objectKeyHex || revision.objectKey !== request.objectKeyHex ||
        head.revisionId !== branch.revisionId || revision.revisionId !== branch.revisionId ||
        nullableIdentity(head.previousRevisionId) !== nullableIdentity(branch.parentRevisionId) ||
        head.revisionBlobSha256 !== row.revision_blob_sha256_hex ||
        head.payloadSha256 !== row.payload_sha256_hex || revision.payloadSha256 !== row.payload_sha256_hex ||
        !validChromeWriter(head.writerSyncPeerId) ||
        await projection().sha256HexText(head.writerSyncPeerId) !== row.writer_sync_peer_id_sha256_hex ||
        await projection().sha256HexText(projection().canonicalJson(revision.payload)) !== row.payload_sha256_hex) {
      fail('local-revision-evidence-invalid');
    }
    return { head: head, headText: headText, revisionText: revisionText };
  }

  async function readCandidate(request) {
    if (!isObject(request) || !validIdentity(request.objectId) || !lowerHex64(request.objectKeyHex) ||
        !Number.isInteger(request.maxRevisionBytes) || request.maxRevisionBytes <= 0 || request.maxRevisionBytes > MAX_REVISION_BYTES) {
      fail('local-revision-source-request-invalid');
    }
    var view = validateBranchView(await readBranches(request.objectId), request.objectId);
    var selected = selectCandidate(view);
    if (selected.blocked) return blocked(selected.blocked);
    if (selected.absent) {
      return { ok: true, verdict: 'head-absent', headPresent: false, sourceKind: SOURCE_KIND, sourceVerified: true };
    }
    var rows = await sqlSelect(
      'SELECT * FROM sync_inbound_revision_observations WHERE object_id = ? AND revision_id = ? ORDER BY key',
      [request.objectId, selected.candidate.revisionId]
    );
    if (!Array.isArray(rows) || rows.length !== 1) fail('local-revision-identity-conflict');
    var verified = await validateObservation(rows[0], selected.candidate, request);
    var sourceStrongVersion = 'local-admission:head-sha256:' + selected.candidate.headSha256Hex;
    return {
      ok: true,
      verdict: selected.replay ? 'local-admission-replay-verified' : 'local-admission-verified',
      headPresent: true,
      head: verified.head,
      headCanonicalText: verified.headText,
      revisionBlobText: verified.revisionText,
      sourceKind: SOURCE_KIND,
      sourceStrongVersion: sourceStrongVersion,
      sourceVerified: true,
      transportVerified: false,
      localEvidence: Object.freeze({
        observationKey: rows[0].key,
        revisionId: selected.candidate.revisionId,
        parentRevisionId: selected.candidate.parentRevisionId == null ? null : selected.candidate.parentRevisionId,
        headSha256Hex: selected.candidate.headSha256Hex,
        revisionBlobSha256Hex: selected.candidate.revisionBlobSha256Hex,
        payloadSha256Hex: selected.candidate.payloadSha256Hex,
        writerSyncPeerIdSha256Hex: selected.candidate.writerSyncPeerIdSha256Hex,
        historicalAdmission: selected.candidate.historicalAdmission,
        currentRelationship: selected.candidate.currentRelationship,
        applyState: selected.candidate.applyState
      })
    };
  }

  H2O.Desktop.SyncObjectLocalSource = Object.freeze({
    schema: 'h2o.studio.syncObjectLocalSource.v1',
    sourceKind: SOURCE_KIND,
    readCandidate: readCandidate,
    diagnose: function () { return { installed: true, initializationSideEffects: 0, sourceKind: SOURCE_KIND }; },
    __test: Object.freeze({
      setDependencies: function (next) { testDependencies = next; },
      clearDependencies: function () { testDependencies = null; }
    })
  });
})(typeof window !== 'undefined' ? window : globalThis);
