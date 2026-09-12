/* H2O Studio Round 2A — durable single-object publish/pull/apply runtime.
 * Explicit calls only: loading this file attaches an API but performs no SQL,
 * descriptor resolution, transport, projection, import, or local mutation.
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
  if (H2O.Desktop.SyncObjectRuntime) return;

  var DB_URL = 'sqlite:studio-v1.db';
  var MAX_REVISION_BYTES = 5 * 1024 * 1024;
  var active = new Set();
  var testDependencies = null;
  var localSourceReady = null;

  function fail(code) {
    var error = new Error(code);
    error.code = code;
    throw error;
  }
  function clean(value) { return String(value == null ? '' : value).trim(); }
  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function rowsAffected(result) {
    if (Array.isArray(result)) return Number(result[0]) || 0;
    if (isObject(result)) return Number(result.rowsAffected || result.rows_affected || result.affected) || 0;
    return Number(result) || 0;
  }
  function nowIso() { return new Date().toISOString(); }
  function token() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return Array.from(bytes).map(function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
  }
  var contextId = token();

  function getInvoke() {
    if (testDependencies && testDependencies.invoke) return testDependencies.invoke;
    try {
      if (global.__TAURI_INTERNALS__ && typeof global.__TAURI_INTERNALS__.invoke === 'function') return global.__TAURI_INTERNALS__.invoke.bind(global.__TAURI_INTERNALS__);
      if (global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === 'function') return global.__TAURI__.core.invoke.bind(global.__TAURI__.core);
      if (global.__TAURI__ && typeof global.__TAURI__.invoke === 'function') return global.__TAURI__.invoke.bind(global.__TAURI__);
    } catch (_) { /* ignore */ }
    return null;
  }

  function sqlExecute(query, values) {
    if (testDependencies && testDependencies.sql) return testDependencies.sql.execute(query, values || []);
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('round2a-sql-unavailable'));
    return invoke('plugin:sql|execute', { db: DB_URL, query: query, values: values || [] });
  }
  function sqlSelect(query, values) {
    if (testDependencies && testDependencies.sql) return testDependencies.sql.select(query, values || []);
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('round2a-sql-unavailable'));
    return invoke('plugin:sql|select', { db: DB_URL, query: query, values: values || [] });
  }

  async function peerId() {
    if (testDependencies && testDependencies.syncPeerId) return clean(testDependencies.syncPeerId);
    var identity = H2O.Studio && H2O.Studio.identity;
    if (identity && typeof identity.whenReady === 'function') await identity.whenReady();
    if (!identity || typeof identity.authority !== 'function') {
      fail('round2a-sync-peer-identity-unavailable');
    }
    var authority = identity && typeof identity.authority === 'function'
      ? identity.authority()
      : null;
    if (authority && authority.desktop === true && authority.canonical !== true) {
      if (clean(authority.status) === 'divergent') {
        fail('round2a-sync-peer-identity-divergent');
      }
      fail('round2a-sync-peer-identity-unavailable');
    }
    var value = identity && typeof identity.get === 'function' ? identity.get() : null;
    var id = clean(value && value.syncPeerId);
    if (!id) fail('round2a-sync-peer-identity-unavailable');
    return id;
  }

  function projection() {
    var api = H2O.Desktop.SyncObjectProjection;
    if (!api) fail('round2a-projection-unavailable');
    return api;
  }

  function stores() {
    return testDependencies && testDependencies.stores || H2O.Studio && H2O.Studio.store || {};
  }

  /*
   * Optional repository-proof port for the cross-representation bridge. No row
   * datum can prove that a v1 projection blob and a v2 envelope blob wrap the
   * same payload, so the repository is the only authority that can settle it.
   * Port absent ⇒ the guard keeps its original fail-closed behaviour exactly.
   */
  function p02RevisionProof() {
    return (testDependencies && testDependencies.p02RevisionProof) ||
      (H2O.Desktop && H2O.Desktop.P02RevisionProof) || null;
  }

  /* Repository-backed payload equality for one stored anchor pair. Verification
   * failure and read error are NOT proof and never soften the guard. */
  async function provesSamePayload(objectId, reference, canonical) {
    var proof = p02RevisionProof();
    if (!proof || typeof proof.readRevisionPayloadSha256 !== 'function') return false;
    var proven;
    try {
      proven = await proof.readRevisionPayloadSha256({
        objectId: objectId,
        revisionId: reference.revisionId,
        revisionBlobSha256: reference.revisionBlobSha256Hex
      });
    } catch (_) {
      return false;
    }
    proven = clean(proven);
    return /^[0-9a-f]{64}$/.test(proven) && proven === canonical.payloadSha256Hex;
  }

  /* Guarded and unowned, like heal-on-proof: clears only the terminal state this
   * mismatch produced, only while the row is idle, and never touches an anchor. */
  async function clearRepresentationQuarantine(syncPeerId, objectId) {
    try {
      await sqlExecute(
        'UPDATE sync_object_state SET last_conflict_class = NULL, last_error_code = NULL, updated_at = ? ' +
        'WHERE sync_peer_id = ? AND object_id = ? AND pending_operation IS NULL ' +
        'AND last_conflict_class = ? AND last_error_code = ?',
        [nowIso(), syncPeerId, objectId, 'local-unexported-change', 'local-unexported-change']
      );
    } catch (_) {
      /* Opportunistic repair: failing to clear must never fail the read that
       * discovered the mismatch was benign. */
    }
  }

  function importer() {
    return testDependencies && testDependencies.importBundle || H2O.Studio && H2O.Studio.ingestion && H2O.Studio.ingestion.importBundle;
  }

  /*
   * ALREADY-APPLIED METADATA SELF-HEAL.
   *
   * An already-applied P02 revision is proven converged from canonical content
   * alone (chat pointer, snapshot, turns) and never reaches the importer again:
   * that is the idempotency invariant and it stays. Importer-derived chat
   * metadata (answer/turn counts, the imported createdAt) is not part of that
   * proof, so a row materialized by an older importer keeps its stale values
   * forever unless something re-derives them. This hands the exact, already
   * verified canonical payload to the ingestion module's bounded metadata
   * reconciliation, which owns those fields; it imports nothing, touches no
   * repository, and never moves an anchor. Its failure is reported, never
   * raised: the canonical Apply already succeeded before it runs.
   */
  function metadataReconciler() {
    return testDependencies && testDependencies.reconcileImportedChatMetadata ||
      H2O.Studio && H2O.Studio.ingestion && H2O.Studio.ingestion.reconcileImportedChatMetadata;
  }

  async function reconcileAlreadyAppliedMetadata(objectId, payload) {
    var reconcile = metadataReconciler();
    if (typeof reconcile !== 'function') {
      return { ok: false, reconciled: false, code: 'metadata-reconciler-unavailable', chats: [] };
    }
    try {
      var outcome = await reconcile(payload, { chatId: objectId, source: 'p02-already-applied' });
      if (!isObject(outcome)) return { ok: false, reconciled: false, code: 'metadata-reconciliation-invalid', chats: [] };
      return {
        ok: outcome.ok === true,
        reconciled: outcome.reconciled === true,
        code: clean(outcome.code),
        chats: Array.isArray(outcome.chats) ? outcome.chats : []
      };
    } catch (error) {
      return { ok: false, reconciled: false, code: clean(error && (error.code || error.message)) || 'metadata-reconciliation-failed', chats: [] };
    }
  }

  async function stateRow(syncPeerId, objectId) {
    var rows = await sqlSelect('SELECT * FROM sync_object_state WHERE sync_peer_id = ? AND object_id = ?', [syncPeerId, objectId]);
    return Array.isArray(rows) && rows[0] || null;
  }

  function provenanceReference(revisionId, revisionHash, kind) {
    var id = clean(revisionId);
    var hash = clean(revisionHash);
    if (!id && !hash) return null;
    if (!id || !/^[0-9a-f]{64}$/.test(hash)) fail('canonical-state-contradiction');
    return Object.freeze({ revisionId: id, revisionBlobSha256Hex: hash, kind: kind });
  }

  function referencesAgree(left, right) {
    return !left || !right || left.revisionId !== right.revisionId ||
      left.revisionBlobSha256Hex === right.revisionBlobSha256Hex;
  }

  /* The canonical chat pointer and exact snapshot projection are the only
   * authority for what is materialized now. Publication and Apply rows are
   * deliberately treated as orthogonal provenance: either may lag after the
   * other authors a clean descendant, and neither may overwrite canonicality.
   *
   * `localPublicationTip` is an optional, already-validated read-only Item 11
   * lineage projection supplied by the automation adapter. It is never
   * persisted here and cannot redirect the canonical projection. */
  async function resolveCanonicalAnchor(objectId, options) {
    objectId = clean(objectId);
    if (!objectId || objectId.length > 512) fail('canonical-state-contradiction');
    var input = isObject(options) ? options : {};
    var syncPeerId = clean(input.syncPeerId) || await peerId();
    var row = input.row || await stateRow(syncPeerId, objectId);
    var currentStores = stores();
    var chat = currentStores.chats && await currentStores.chats.get(objectId);
    var applied = provenanceReference(
      row && row.last_applied_revision_id,
      row && row.last_applied_revision_blob_sha256,
      'remote-applied'
    );
    var published = provenanceReference(
      row && row.last_published_revision_id,
      row && row.last_published_revision_blob_sha256,
      'runtime-published'
    );
    var item11 = input.localPublicationTip && provenanceReference(
      input.localPublicationTip.revisionId,
      input.localPublicationTip.revisionBlobSha256Hex,
      'local-published'
    );
    if (!referencesAgree(applied, published) ||
        !referencesAgree(applied, item11) ||
        !referencesAgree(published, item11)) {
      fail('canonical-state-contradiction');
    }
    if (!chat) {
      if (applied || published || item11) fail('canonical-state-contradiction');
      return Object.freeze({
        ok: true,
        classification: 'EMPTY_INITIAL',
        objectId: objectId,
        revisionId: null,
        revisionBlobSha256Hex: null,
        payloadSha256Hex: null,
        localPublishedMatch: false,
        remoteAppliedMatch: false,
        row: row || null
      });
    }
    var pointer = clean(chat.lastSnapshotId || chat.last_snapshot_id);
    var projected;
    try {
      projected = pointer && typeof projection().projectObjectRevision === 'function'
        ? await projection().projectObjectRevision(objectId, pointer)
        : await projection().projectObject(objectId);
    } catch (_) {
      fail('canonical-state-contradiction');
    }
    if (!projected || clean(projected.objectId) !== objectId ||
        !clean(projected.revisionId) ||
        (pointer && clean(projected.revisionId) !== pointer) ||
        !/^[0-9a-f]{64}$/.test(clean(projected.revisionBlobSha256Hex)) ||
        !/^[0-9a-f]{64}$/.test(clean(projected.payloadSha256Hex))) {
      fail('canonical-state-contradiction');
    }
    var canonical = Object.freeze({
      revisionId: clean(projected.revisionId),
      revisionBlobSha256Hex: clean(projected.revisionBlobSha256Hex),
      payloadSha256Hex: clean(projected.payloadSha256Hex)
    });
    /*
     * Same id, different blob was an unconditional contradiction. That is right
     * within one representation and wrong across two: a P02 anchor records the
     * v2 envelope hash while canonical records the v1 projection hash, and those
     * differ by design for the very same content. Left alone it converts a
     * correctly converged published object into a durable quarantine on the next
     * pull.
     *
     * The bridge asks the repository, the only authority that can settle it: if
     * the stored pair verifies at its immutable address and the payload it
     * carries equals canonical's payload, the mismatch is representational and
     * benign. A different payload is real divergence and keeps the throw.
     */
    var benign = { applied: false, published: false, item11: false };
    var benignNames = ['applied', 'published', 'item11'];
    var benignRefs = [applied, published, item11];
    for (var benignIndex = 0; benignIndex < benignRefs.length; benignIndex += 1) {
      var reference = benignRefs[benignIndex];
      if (!reference || reference.revisionId !== canonical.revisionId ||
          reference.revisionBlobSha256Hex === canonical.revisionBlobSha256Hex) continue;
      if (!(await provesSamePayload(objectId, reference, canonical))) {
        fail('canonical-state-contradiction');
      }
      benign[benignNames[benignIndex]] = true;
    }
    if (benign.applied || benign.published || benign.item11) {
      /* The recorded terminal existed only because of this mismatch. */
      await clearRepresentationQuarantine(syncPeerId, objectId);
    }
    var localPublishedMatch = benign.published || benign.item11 ||
      [published, item11].some(function (reference) {
        return reference && reference.revisionId === canonical.revisionId &&
          reference.revisionBlobSha256Hex === canonical.revisionBlobSha256Hex;
      });
    var remoteAppliedMatch = benign.applied || (!!applied &&
      applied.revisionId === canonical.revisionId &&
      applied.revisionBlobSha256Hex === canonical.revisionBlobSha256Hex);
    var classification = localPublishedMatch && remoteAppliedMatch
      ? 'KNOWN_CANONICAL_BOTH'
      : (localPublishedMatch
        ? 'KNOWN_CANONICAL_LOCAL_PUBLISHED'
        : (remoteAppliedMatch
          ? 'KNOWN_CANONICAL_REMOTE_APPLIED'
          : 'LOCAL_UNPUBLISHED_CHANGE'));
    return Object.freeze({
      ok: true,
      classification: classification,
      objectId: objectId,
      revisionId: canonical.revisionId,
      revisionBlobSha256Hex: canonical.revisionBlobSha256Hex,
      payloadSha256Hex: canonical.payloadSha256Hex,
      localPublishedMatch: localPublishedMatch,
      remoteAppliedMatch: remoteAppliedMatch,
      applied: applied,
      published: item11 || published,
      row: row || null
    });
  }

  async function runtimeSession() {
    if (testDependencies) return { bootId: clean(testDependencies.bootId) || 'round2a-test-boot' };
    var invoke = getInvoke();
    if (!invoke) fail('round2a-profile-runtime-busy');
    var session = await invoke('h2o_sync_object_runtime_session');
    if (!session || !clean(session.bootId)) fail('round2a-profile-runtime-busy');
    return { bootId: clean(session.bootId) };
  }

  function strictOwnerSchema() {
    return !testDependencies || testDependencies.strictOwnerSchema === true;
  }

  async function acquireLegacy(syncPeerId, objectId, operation, key) {
    var operationToken = token();
    var now = nowIso();
    var result = await sqlExecute(
      'INSERT INTO sync_object_state (sync_peer_id, object_id, pending_operation, operation_phase, operation_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(sync_peer_id, object_id) DO UPDATE SET pending_operation = excluded.pending_operation, operation_phase = excluded.operation_phase, operation_token = excluded.operation_token, last_error_code = NULL, updated_at = excluded.updated_at ' +
      'WHERE sync_object_state.pending_operation IS NULL',
      [syncPeerId, objectId, operation, 'acquire', operationToken, now, now]
    );
    if (rowsAffected(result) > 0) return { key: key, token: operationToken, bootId: 'round2a-test-boot', contextId: contextId, resumed: false, row: await stateRow(syncPeerId, objectId), legacy: true };
    var pending = await stateRow(syncPeerId, objectId);
    if (!pending || clean(pending.pending_operation) !== operation || clean(pending.operation_phase) !== 'apply') fail('round2a-local-operation-busy');
    var adopted = await sqlExecute(
      'UPDATE sync_object_state SET operation_token = ?, updated_at = ? WHERE sync_peer_id = ? AND object_id = ? AND operation_token = ? AND pending_operation = ? AND operation_phase = ?',
      [operationToken, now, syncPeerId, objectId, pending.operation_token, operation, 'apply']
    );
    if (rowsAffected(adopted) !== 1) fail('round2a-local-operation-busy');
    return { key: key, token: operationToken, bootId: 'round2a-test-boot', contextId: contextId, resumed: true, row: await stateRow(syncPeerId, objectId), legacy: true };
  }

  async function acquire(syncPeerId, objectId, operation, bootId) {
    var key = syncPeerId + '\u0000' + objectId;
    if (active.has(key)) fail('round2a-local-operation-busy');
    active.add(key);
    try {
      if (!strictOwnerSchema()) return await acquireLegacy(syncPeerId, objectId, operation, key);
      var ownerToken = token();
      var now = nowIso();
      var result = await sqlExecute(
        'INSERT INTO sync_object_state (sync_peer_id, object_id, pending_operation, operation_phase, owner_boot_id, owner_context_id, owner_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(sync_peer_id, object_id) DO UPDATE SET pending_operation = excluded.pending_operation, operation_phase = excluded.operation_phase, owner_boot_id = excluded.owner_boot_id, owner_context_id = excluded.owner_context_id, owner_token = excluded.owner_token, last_error_code = NULL, updated_at = excluded.updated_at ' +
        'WHERE sync_object_state.pending_operation IS NULL',
        [syncPeerId, objectId, operation, 'acquire', bootId, contextId, ownerToken, now, now]
      );
      if (rowsAffected(result) > 0) return { key: key, token: ownerToken, bootId: bootId, contextId: contextId, resumed: false, row: await stateRow(syncPeerId, objectId), legacy: false };
      var pending = await stateRow(syncPeerId, objectId);
      if (!pending || clean(pending.pending_operation) !== operation) fail('round2a-local-operation-busy');
      if (clean(pending.owner_boot_id) === bootId) fail('round2a-local-operation-busy');
      var adopted = await sqlExecute(
        'UPDATE sync_object_state SET owner_boot_id = ?, owner_context_id = ?, owner_token = ?, updated_at = ? WHERE sync_peer_id = ? AND object_id = ? AND owner_boot_id IS ? AND owner_context_id IS ? AND owner_token IS ? AND pending_operation = ? AND operation_phase IS ?',
        [bootId, contextId, ownerToken, now, syncPeerId, objectId, pending.owner_boot_id, pending.owner_context_id, pending.owner_token, operation, pending.operation_phase]
      );
      if (rowsAffected(adopted) !== 1) fail('round2a-local-operation-busy');
      return { key: key, token: ownerToken, bootId: bootId, contextId: contextId, resumed: true, row: pending, legacy: false };
    } catch (error) {
      active.delete(key);
      throw error;
    }
  }

  /*
   * True when the row's recorded publication anchor cannot have been authored by
   * the P01 projection lane: it names the same canonical revision this lane is
   * about to publish, carries a payload identity, and yet its blob is not the
   * blob P01 produces for that revision. Only a foreign representation - the P02
   * v2 envelope - satisfies that. Absent or matching anchors are not foreign, so
   * ordinary P01 republication is untouched.
   */
  function foreignLanePublication(prior, projected) {
    if (!prior || !projected) return false;
    var storedId = clean(prior.last_published_revision_id);
    var storedBlob = clean(prior.last_published_revision_blob_sha256);
    var storedPayload = clean(prior.last_published_payload_sha256);
    if (!storedId || !storedBlob || !storedPayload) return false;
    if (storedId !== clean(projected.revisionId)) return false;
    return storedBlob !== clean(projected.revisionBlobSha256Hex);
  }

  /* v22 identity amendment. Direction names which anchor the row's payload
   * identity belongs to, so the comparator never has to guess. */
  var P02_DIRECTION = Object.freeze({ PUBLISHED: 'published', APPLIED: 'applied' });

  /* A direction is only meaningful with a payload identity beside it, so an
   * anchor write that cannot supply one fails closed rather than writing a
   * half-identity that classification would have to treat as corruption. */
  function requiredPayloadIdentity(value) {
    var hash = clean(value).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) fail('round2a-payload-identity-unavailable');
    return hash;
  }

  function releaseMemory(acquisition) { active.delete(acquisition.key); }

  async function updateOwned(acquisition, syncPeerId, objectId, assignments, values) {
    var predicate = acquisition.legacy
      ? 'operation_token = ?'
      : 'owner_boot_id = ? AND owner_context_id = ? AND owner_token = ?';
    var ownership = acquisition.legacy
      ? [acquisition.token]
      : [acquisition.bootId, acquisition.contextId, acquisition.token];
    var result = await sqlExecute(
      'UPDATE sync_object_state SET ' + assignments + ', updated_at = ? WHERE sync_peer_id = ? AND object_id = ? AND ' + predicate,
      values.concat([nowIso(), syncPeerId, objectId]).concat(ownership)
    );
    if (rowsAffected(result) !== 1) fail('round2a-local-operation-lost');
  }

  function clearOwnerAssignments(acquisition) {
    return acquisition.legacy
      ? 'pending_operation = NULL, operation_phase = NULL, operation_token = NULL'
      : 'pending_operation = NULL, operation_phase = NULL, owner_boot_id = NULL, owner_context_id = NULL, owner_token = NULL';
  }

  function intendedAssignments(acquisition) {
    return acquisition.legacy
      ? 'operation_phase = ?, intended_revision_id = ?, intended_revision_blob_sha256 = ?'
      : 'operation_phase = ?, intended_revision_id = ?, intended_revision_blob_sha256 = ?, intended_object_key = ?, intended_payload_sha256 = ?';
  }

  function clearIntendedAssignments(acquisition) {
    return acquisition.legacy
      ? 'intended_revision_id = NULL, intended_revision_blob_sha256 = NULL'
      : 'intended_revision_id = NULL, intended_revision_blob_sha256 = NULL, intended_object_key = NULL, intended_payload_sha256 = NULL';
  }

  async function transport(command, request) {
    if (testDependencies && testDependencies.transport) return testDependencies.transport[command](request);
    var invoke = getInvoke();
    if (!invoke) fail('round2a-transport-unavailable');
    return invoke(command, { request: request });
  }

  function pullSourceKind(options) {
    if (options == null) return 'webdav';
    if (!isObject(options)) fail('round2a-pull-source-invalid');
    var source = clean(options.source) || 'webdav';
    if (source !== 'webdav' && source !== 'admitted-local' &&
        source !== 'p02-admitted-local') fail('round2a-pull-source-invalid');
    return source;
  }

  async function admittedLocalSource() {
    var available = testDependencies && testDependencies.localSource || H2O.Desktop.SyncObjectLocalSource;
    if (available && typeof available.readCandidate === 'function') return available;
    if (!localSourceReady) {
      if (!global.document || typeof global.document.createElement !== 'function') fail('local-revision-source-unavailable');
      localSourceReady = new Promise(function (resolve, reject) {
        var script = global.document.createElement('script');
        script.src = '/sync/sync-object-local-source.tauri.js';
        script.async = false;
        script.onload = function () {
          var loaded = H2O.Desktop.SyncObjectLocalSource;
          if (loaded && typeof loaded.readCandidate === 'function') resolve(loaded);
          else reject(new Error('local-revision-source-unavailable'));
        };
        script.onerror = function () { reject(new Error('local-revision-source-unavailable')); };
        (global.document.head || global.document.documentElement).appendChild(script);
      });
    }
    return localSourceReady;
  }

  async function readPullSource(source, request) {
    if (source === 'webdav') return transport('h2o_sync_object_pull_transport', request);
    if (source === 'p02-admitted-local') {
      var p02Source = testDependencies && testDependencies.p02LocalSource ||
        H2O.Desktop.SyncObjectP02LocalSource;
      if (!p02Source || typeof p02Source.readCandidate !== 'function') {
        fail('p02-local-revision-source-unavailable');
      }
      return p02Source.readCandidate(request);
    }
    var localSource = await admittedLocalSource();
    return localSource.readCandidate(request);
  }

  function pullSourceStrongVersion(pulled) {
    return clean(pulled && (pulled.sourceStrongVersion || pulled.headStrongEtag));
  }

  function expectedHeadFromRow(row) {
    if (!row || !clean(row.remote_head_strong_etag) || !clean(row.remote_head_revision_blob_sha256) || !clean(row.last_published_revision_id)) return null;
    return {
      revisionId: clean(row.last_published_revision_id),
      revisionBlobSha256Hex: clean(row.remote_head_revision_blob_sha256),
      strongEtag: clean(row.remote_head_strong_etag)
    };
  }

  function publishFailureIsDefinite(result) {
    if (result && typeof result.remoteSideEffectUncertain === 'boolean') {
      return result.remoteSideEffectUncertain !== true;
    }
    var code = clean(result && result.errorCode);
    return new Set([
      'round2a-publish-request-invalid', 'round2a-object-key-mismatch',
      'round2a-revision-blob-hash-mismatch', 'round2a-revision-blob-invalid',
      'round2a-revision-blob-not-canonical', 'round2a-revision-envelope-invalid',
      'round2a-revision-envelope-mismatch', 'round2a-layout-parent-missing',
      'round2a-layout-propfind-invalid', 'round2a-layout-create-failed',
      'round2a-layout-collection-not-proven',
      'round2a-layout-authentication-required', 'round2a-layout-access-forbidden',
      'round2a-layout-redirect-refused', 'round2a-layout-method-not-allowed',
      'round2a-layout-parent-conflict', 'round2a-layout-locked',
      'round2a-layout-server-error', 'round2a-layout-response-too-large',
      'round2a-layout-connect-failed', 'round2a-layout-timeout',
      'round2a-layout-request-failed', 'round2a-layout-response-read-failed',
      'round2a-layout-propfind-failed', 'round2a-get-failed',
      'round2a-get-status-invalid', 'round2a-head-invalid',
      'round2a-head-not-canonical', 'round2a-head-too-large',
      'round2a-revision-put-409', 'round2a-revision-put-failed',
      'round2a-head-put-409', 'stale-head-etag', 'concurrent-writer',
      'same-revision-divergent-hash', 'unexpected-remote-object'
    ]).has(code);
  }

  /*
   * O1-T19. The generation gate, consulted before any P01 publication byte is
   * written. A missing gate is unobservable, not permission: guessing P01 here
   * would write into a repository P02 may already own.
   */
  async function generationPermitsP01Mutation() {
    var gate = H2O.Studio && H2O.Studio.sync && H2O.Studio.sync.writerGeneration;
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

  async function publishObject(objectId) {
    objectId = clean(objectId);
    var generation = await generationPermitsP01Mutation();
    if (generation.permitted !== true) fail(generation.reason || 'p01-writer-stood-down');
    var syncPeerId = await peerId();
    var session = await runtimeSession();
    var prior = await stateRow(syncPeerId, objectId);
    var recovering = !!(prior && clean(prior.pending_operation) === 'publish');
    var projected;
    if (recovering) {
      if (clean(prior.owner_boot_id) === session.bootId) fail('round2a-local-operation-busy');
      var intendedRevisionId = clean(prior.intended_revision_id);
      if (!intendedRevisionId || typeof projection().projectObjectRevision !== 'function') fail('round2a-recovery-source-mismatch');
      projected = await projection().projectObjectRevision(objectId, intendedRevisionId);
    } else {
      /* Pure projection precedes ownership acquisition: unsupported source
       * state can never strand a durable pending operation. */
      projected = await projection().projectObject(objectId);
    }
    /* Cross-lane fence. A row whose recorded publication was authored by the
     * P02 lane must not be re-published by P01: the lanes keep different
     * repositories and different envelope representations, so a P01 publish
     * would overwrite a P02 anchor with an unrelated identity.
     *
     * Provenance is read from evidence, not assumed. P01 always anchors on the
     * blob its own projection produces, so a stored anchor naming the SAME
     * canonical revision under a DIFFERENT blob cannot have come from this lane.
     * The check runs before acquire(), so a refusal never takes an operation and
     * never reaches the destructive clearing path in the catch below. */
    if (foreignLanePublication(prior, projected)) fail('round2a-p02-publication-lane-owned');
    var acquisition = await acquire(syncPeerId, objectId, 'publish', session.bootId);
    var dispatched = false;
    try {
      var acquiredPrior = acquisition.row || prior;
      if (acquisition.resumed && (
        clean(acquiredPrior.intended_revision_id) !== projected.revisionId ||
        clean(acquiredPrior.intended_revision_blob_sha256) !== projected.revisionBlobSha256Hex ||
        clean(acquiredPrior.intended_object_key) !== projected.objectKeyHex ||
        clean(acquiredPrior.intended_payload_sha256) !== projected.payloadSha256Hex
      )) fail('round2a-recovery-source-mismatch');
      var intended = intendedAssignments(acquisition);
      await updateOwned(acquisition, syncPeerId, objectId, intended,
        acquisition.legacy
          ? ['transport', projected.revisionId, projected.revisionBlobSha256Hex]
          : ['transport', projected.revisionId, projected.revisionBlobSha256Hex, projected.objectKeyHex, projected.payloadSha256Hex]);
      if (testDependencies && typeof testDependencies.beforePublishTransport === 'function') {
        await testDependencies.beforePublishTransport(projected);
      }
      dispatched = true;
      var result = await transport('h2o_sync_object_publish_transport', {
        objectId: objectId,
        objectKeyHex: projected.objectKeyHex,
        revisionId: projected.revisionId,
        payloadSha256Hex: projected.payloadSha256Hex,
        revisionBlobText: projected.revisionBlobText,
        revisionBlobSha256Hex: projected.revisionBlobSha256Hex,
        writerSyncPeerId: syncPeerId,
        sourceUpdatedAtIso: projected.sourceUpdatedAtIso,
        expectedHead: expectedHeadFromRow(acquiredPrior)
      });
      if (!result || result.ok !== true) {
        var failed = result || { ok: false, errorCode: 'round2a-publish-failed' };
        if (publishFailureIsDefinite(failed)) {
          await updateOwned(acquisition, syncPeerId, objectId,
            clearOwnerAssignments(acquisition) + ', last_conflict_class = ?, last_error_code = ?',
            [clean(failed.conflictClass) || null, clean(failed.errorCode) || 'round2a-publish-failed']);
        } else {
          await updateOwned(acquisition, syncPeerId, objectId,
            'last_conflict_class = ?, last_error_code = ?',
            [clean(failed.conflictClass) || null, clean(failed.errorCode) || 'round2a-publish-uncertain']);
          failed = Object.assign({}, failed, { localRecoveryPending: true });
        }
        return failed;
      }
      /* v22 lockstep, P01 side. P01 keeps writing its own v1 projection blob as
       * the anchor - that semantic is unchanged - and now also records the
       * payload identity and direction, so a P01-published row is classified by
       * the same content rule rather than by representation coincidence. */
      await updateOwned(acquisition, syncPeerId, objectId,
        'last_published_revision_id = ?, last_published_revision_blob_sha256 = ?, last_published_payload_sha256 = ?, last_converged_direction = ?, remote_head_strong_etag = ?, remote_head_revision_blob_sha256 = ?, ' + clearOwnerAssignments(acquisition) + ', ' + clearIntendedAssignments(acquisition) + ', last_conflict_class = NULL, last_error_code = NULL',
        [projected.revisionId, projected.revisionBlobSha256Hex,
          requiredPayloadIdentity(projected.payloadSha256Hex), P02_DIRECTION.PUBLISHED,
          result.newHeadStrongEtag || expectedHeadFromRow(acquiredPrior) && expectedHeadFromRow(acquiredPrior).strongEtag || null, projected.revisionBlobSha256Hex]);
      return Object.assign({}, result, { localStateCommitted: true });
    } catch (error) {
      var code = clean(error && (error.code || error.message)) || 'round2a-publish-failed';
      try {
        if (dispatched) {
          await updateOwned(acquisition, syncPeerId, objectId, 'last_error_code = ?', [code]);
        } else {
          await updateOwned(acquisition, syncPeerId, objectId,
            clearOwnerAssignments(acquisition) + ', ' + clearIntendedAssignments(acquisition) + ', last_error_code = ?', [code]);
        }
      } catch (_) { /* a stale owner must not overwrite the winner */ }
      throw error;
    } finally {
      releaseMemory(acquisition);
    }
  }

  function convergenceIso(value) {
    var millis = typeof value === 'number' ? value : Date.parse(String(value == null ? '' : value));
    if (!Number.isFinite(millis)) fail('round2a-store-convergence-failed');
    return new Date(millis).toISOString();
  }

  /*
   * The payload's own source identity (A1 §4).
   *
   * This surface is a classic IIFE and cannot import, so the predicate is
   * restated here rather than shared. `payloadSourceRevisionId` in
   * packages/core/sync-p02-revision-mint-v2.mjs is the contract; the O1-T05b
   * validator pins the two against each other over the same vectors so they
   * cannot drift apart unnoticed.
   *
   * chatIndex.lastSnapshotId and snapshots[0].snapshotId are two independent
   * statements of one fact, so they must agree before either is trusted.
   */
  function payloadSourceRevisionId(payload) {
    var chat = payload && payload.chatArchive && payload.chatArchive.chats &&
      payload.chatArchive.chats[0];
    var snapshot = chat && chat.snapshots && chat.snapshots[0];
    var indexed = clean(chat && chat.chatIndex && chat.chatIndex.lastSnapshotId);
    var captured = clean(snapshot && snapshot.snapshotId);
    if (!indexed || indexed !== captured) return null;
    return indexed;
  }

  function payloadTurns(payload, revisionId) {
    var snapshot = payload.chatArchive.chats[0].snapshots[0];
    var rich = snapshot.meta.richTurns;
    return snapshot.messages.map(function (message, index) {
      var matched = rich.find(function (row) { return Number(row.turnIdx) === Number(message.order); }) || rich[index] || {};
      return {
        snapshotId: revisionId,
        turnIdx: Number(message.order),
        role: clean(message.role),
        text: String(message.text || ''),
        outerHtml: String(matched.outerHTML || ''),
        meta: isObject(matched.meta) ? matched.meta : null
      };
    });
  }

  function normalizeConvergenceRecord(input) {
    if (!isObject(input) || !Array.isArray(input.turns)) fail('round2a-store-convergence-failed');
    var record = {
      chat: {
        chatId: clean(input.chatId),
        lastSnapshotId: clean(input.lastSnapshotId)
      },
      snapshot: {
        snapshotId: clean(input.snapshotId),
        chatId: clean(input.snapshotChatId),
        createdAt: convergenceIso(input.createdAt),
        messageCount: Number(input.messageCount),
        title: typeof input.title === 'string' ? input.title : null
      },
      turns: input.turns.map(function (turn) {
        if (!isObject(turn) || !isObject(turn.meta)) fail('round2a-store-convergence-failed');
        return {
          snapshotId: clean(turn.snapshotId || turn.snapshot_id),
          turnIdx: Number(turn.turnIdx == null ? turn.turn_idx : turn.turnIdx),
          role: clean(turn.role),
          text: typeof turn.text === 'string' ? turn.text : null,
          outerHtml: typeof turn.outerHtml === 'string' ? turn.outerHtml : typeof turn.outer_html === 'string' ? turn.outer_html : null,
          meta: turn.meta
        };
      })
    };
    if (!record.chat.chatId || !record.chat.lastSnapshotId ||
        !record.snapshot.snapshotId || !record.snapshot.chatId ||
        !Number.isInteger(record.snapshot.messageCount) || record.snapshot.messageCount < 0 ||
        record.snapshot.title === null || record.turns.some(function (turn) {
          return !turn.snapshotId || !Number.isInteger(turn.turnIdx) || turn.turnIdx < 0 ||
            !turn.role || turn.text === null || turn.outerHtml === null;
        })) {
      fail('round2a-store-convergence-failed');
    }
    return record;
  }

  function incomingConvergenceRecord(payload, objectId, revisionId) {
    var chat = payload.chatArchive.chats[0];
    var snapshot = chat.snapshots[0];
    return normalizeConvergenceRecord({
      chatId: chat.chatId,
      lastSnapshotId: chat.chatIndex.lastSnapshotId,
      snapshotId: snapshot.snapshotId,
      snapshotChatId: snapshot.chatId,
      createdAt: snapshot.createdAt,
      messageCount: snapshot.messageCount,
      title: snapshot.meta.title,
      turns: payloadTurns(payload, revisionId)
    });
  }

  function localConvergenceRecord(chat, snapshot, turns) {
    return normalizeConvergenceRecord({
      chatId: chat.chatId || chat.id,
      lastSnapshotId: chat.lastSnapshotId || chat.last_snapshot_id,
      snapshotId: snapshot.snapshotId || snapshot.id,
      snapshotChatId: snapshot.chatId || snapshot.chat_id,
      createdAt: snapshot.capturedAt == null ? snapshot.captured_at : snapshot.capturedAt,
      messageCount: snapshot.messageCount == null ? snapshot.message_count : snapshot.messageCount,
      title: snapshot.title,
      turns: turns
    });
  }

  /*
   * A1 §4/§7 call-site rule: this seam keys on the PAYLOAD's source identity,
   * never on the envelope revisionId.
   *
   * Both halves of the seam - the canonical store lookups and the identity
   * equations - are about canonical state, and canonical state is keyed by the
   * snapshot id the payload carries. The envelope revisionId is engine-minted
   * and names a transport address, so looking canonical state up by it would
   * miss, and demanding that canonical rows equal it would fail every time.
   *
   * In the v1 lane the two ids are the same value, so this is byte-identical
   * to the previous behaviour there. The `sourceRevisionId` argument stays
   * accepted so the P01 call sites need no change at all.
   */
  async function convergence(objectId, sourceRevisionId, payload, revisionHash) {
    var revisionId = clean(payloadSourceRevisionId(payload)) || clean(sourceRevisionId);
    /* The payload's two statements of its own identity must agree, and must
     * agree with what the caller asked to converge; otherwise the proof would
     * be about a different revision than the one being applied. */
    if (!revisionId) fail('round2a-store-convergence-failed');
    var currentStores = stores();
    var chat = currentStores.chats && await currentStores.chats.get(objectId);
    var combined = currentStores.snapshots && await currentStores.snapshots.get(revisionId);
    var snapshot = combined && (combined.snapshot || combined);
    var turns = combined && combined.turns || snapshot && snapshot.turns;
    if (!chat || !snapshot || !Array.isArray(turns)) {
      fail('round2a-store-convergence-failed');
    }
    var expected = incomingConvergenceRecord(payload, objectId, revisionId);
    var actual = localConvergenceRecord(chat, snapshot, turns);
    if (expected.chat.chatId !== objectId || expected.chat.lastSnapshotId !== revisionId ||
        expected.snapshot.snapshotId !== revisionId || expected.snapshot.chatId !== objectId ||
        expected.turns.some(function (turn) { return turn.snapshotId !== revisionId; }) ||
        actual.chat.chatId !== objectId || actual.chat.lastSnapshotId !== revisionId ||
        actual.snapshot.snapshotId !== revisionId || actual.snapshot.chatId !== objectId ||
        actual.turns.some(function (turn) { return turn.snapshotId !== revisionId; }) ||
        projection().canonicalJson(expected) !== projection().canonicalJson(actual)) {
      fail('round2a-store-convergence-failed');
    }
    return { revisionBlobSha256Hex: revisionHash, turnCount: actual.turns.length,
      sourceRevisionId: revisionId };
  }

  /*
   * O1-T14, the deferred seam.
   *
   * The legacy formula asks "does the canonical content pointer name the same
   * revision the ledger last applied". That works only while the two are the
   * same identity, which the v1 lane guarantees and the v2 lane deliberately
   * does not: a P02 envelope revisionId is engine-minted and names a transport
   * address, while the canonical pointer names a snapshot in the source domain.
   * Comparing them across the v2 lane asks whether a mint equals a snapshot id,
   * which is always false - so a correctly converged object would look
   * un-applied forever and be re-pulled on every pass.
   *
   * The v2 lane therefore uses payload equivalence, which is the only
   * cross-representation identity the amendment recognises: the canonical
   * projection's payload hash against the payload the applied anchor recorded.
   *
   * The regime is chosen by the direction column exactly as the enumerator
   * chooses it - direction present means the P02 regime - so the v1 lane below
   * is reached only when there is no P02 convergence to speak of, and its
   * formula is byte-identical to what it always was.
   */
  async function upToDateNoOp(row, objectId) {
    var revisionId = clean(row && row.last_applied_revision_id);
    var revisionHash = clean(row && row.last_applied_revision_blob_sha256);
    if (!revisionId || !revisionHash || clean(row.convergence_watermark_sha256) !== revisionHash) return false;
    var currentStores = stores();
    var chat = currentStores.chats && await currentStores.chats.get(objectId);
    if (!chat) return false;

    var direction = clean(row && row.last_converged_direction);
    if (direction) {
      /* P02 regime. A direction with no payload beside it is a half-written
       * identity, which classification treats as integrity - never as
       * convergence, so this refuses rather than guessing. */
      var appliedPayload = clean(row && row.last_applied_payload_sha256);
      if (!/^[0-9a-f]{64}$/.test(appliedPayload)) return false;
      var pointer = clean(chat.lastSnapshotId || chat.last_snapshot_id);
      if (!pointer) return false;
      var projected;
      try {
        projected = typeof projection().projectObjectRevision === 'function'
          ? await projection().projectObjectRevision(objectId, pointer)
          : await projection().projectObject(objectId);
      } catch (_) {
        /* Unprojectable canonical state is not a convergence claim. Closures
         * and soft-deleted objects land here and are decided by the deleted
         * flag and classification, never by a content payload comparison. */
        return false;
      }
      var canonicalPayload = clean(projected && projected.payloadSha256Hex);
      if (!/^[0-9a-f]{64}$/.test(canonicalPayload)) return false;
      return canonicalPayload === appliedPayload;
    }

    /* Legacy regime, unchanged: within one representation the ids really are
     * the same identity, so the exact original formula still holds. */
    var snapshot = currentStores.snapshots && await currentStores.snapshots.get(revisionId);
    return !!snapshot && clean(chat.lastSnapshotId || chat.last_snapshot_id) === revisionId;
  }

  async function recordPullTerminal(acquisition, syncPeerId, objectId, conflictClass, errorCode) {
    await updateOwned(acquisition, syncPeerId, objectId,
      clearOwnerAssignments(acquisition) + ', last_conflict_class = ?, last_error_code = ?',
      [conflictClass || null, errorCode || null]);
  }

  async function commitApplied(acquisition, syncPeerId, objectId, pulled, proof) {
    /* v22 lockstep, apply side: the applied anchor keeps its exact transport
     * envelope identity, and the payload identity that envelope carries is
     * recorded beside it so convergence never has to compare envelopes from
     * different representations. */
    await updateOwned(acquisition, syncPeerId, objectId,
      'last_applied_revision_id = ?, last_applied_revision_blob_sha256 = ?, last_applied_payload_sha256 = ?, last_converged_direction = ?, convergence_watermark_sha256 = ?, consumed_revision_blob_sha256 = ?, remote_head_strong_etag = ?, remote_head_revision_blob_sha256 = ?, ' + clearOwnerAssignments(acquisition) + ', ' + clearIntendedAssignments(acquisition) + ', last_conflict_class = NULL, last_error_code = NULL',
      [pulled.head.revisionId, pulled.head.revisionBlobSha256,
        requiredPayloadIdentity(pulled.head.payloadSha256), P02_DIRECTION.APPLIED,
        pulled.head.revisionBlobSha256, pulled.head.revisionBlobSha256, pullSourceStrongVersion(pulled), pulled.head.revisionBlobSha256]);
    return proof;
  }

  async function pullObject(objectId, options) {
    objectId = clean(objectId);
    var source = pullSourceKind(options);
    var syncPeerId = await peerId();
    var session = await runtimeSession();
    var acquisition = await acquire(syncPeerId, objectId, 'pull', session.bootId);
    var preservePending = false;
    /* APPLY_RESULT_REPORTING: whether the canonical importer was actually
     * invoked on this pass. Reported on every path and never inferred from a
     * successful application. */
    var importerInvoked = false;
    try {
      var key = await projection().objectKeyHex(objectId);
      var pulled = await readPullSource(source, { objectId: objectId, objectKeyHex: key, maxRevisionBytes: MAX_REVISION_BYTES });
      if (!pulled || pulled.ok !== true) {
        await recordPullTerminal(acquisition, syncPeerId, objectId, clean(pulled && pulled.conflictClass) || null, clean(pulled && pulled.errorCode) || 'round2a-pull-failed');
        return Object.assign({}, pulled || { ok: false, errorCode: 'round2a-pull-failed' }, { importerInvoked: false });
      }
      if (!pulled.headPresent) {
        await recordPullTerminal(acquisition, syncPeerId, objectId, null, null);
        return Object.assign({}, pulled, { unchangedNoOp: true, importerInvoked: false });
      }
      if (source === 'admitted-local' && (
        pulled.sourceKind !== 'admitted-local' || pulled.sourceVerified !== true ||
        clean(pulled.headStrongEtag) || !pullSourceStrongVersion(pulled)
      )) fail('local-revision-source-contract-invalid');
      var row = await stateRow(syncPeerId, objectId);
      var envelope;
      if (source === 'p02-admitted-local') {
        if (pulled.sourceKind !== 'p02-admitted-local' ||
            pulled.sourceVerified !== true || clean(pulled.headStrongEtag) ||
            !pullSourceStrongVersion(pulled) || !isObject(pulled.revisionValue) ||
            pulled.revisionValue.revisionId !== pulled.head.revisionId ||
            pulled.revisionValue.payloadSha256 !== pulled.head.payloadSha256 ||
            !isObject(pulled.revisionValue.payload)) {
          fail('p02-local-revision-source-contract-invalid');
        }
        envelope = pulled.revisionValue;
      } else {
        envelope = await projection().validateRevisionBlob(pulled.revisionBlobText, {
          objectId: objectId,
          objectKeyHex: key,
          revisionId: pulled.head.revisionId,
          payloadSha256Hex: pulled.head.payloadSha256,
          revisionBlobSha256Hex: pulled.head.revisionBlobSha256
        });
      }
      var currentStores = stores();
      var localChat = currentStores.chats && await currentStores.chats.get(objectId);
      var anchor;
      try {
        anchor = await resolveCanonicalAnchor(objectId, {
          syncPeerId: syncPeerId,
          row: row
        });
      } catch (anchorError) {
        if (clean(anchorError && (anchorError.code || anchorError.message)) !==
            'canonical-state-contradiction') throw anchorError;
        await recordPullTerminal(
          acquisition,
          syncPeerId,
          objectId,
          'local-unexported-change',
          'local-unexported-change'
        );
        return {
          ok: false,
          verdict: 'blocked',
          conflictClass: 'local-unexported-change',
          errorCode: 'local-unexported-change'
        };
      }
      var localLast = clean(anchor.revisionId);
      var priorApplied = clean(row && row.last_applied_revision_id);
      var incoming = clean(pulled.head.revisionId);
      var incomingParent = clean(pulled.head.previousRevisionId);
      var incomingParentBlob = clean(pulled.head.previousRevisionBlobSha256);

      /* Reverse P02 one-hop bridge. A Desktop canonical head is a v1
       * projection, while the Chrome child names the exact v2 envelope pair
       * Desktop previously published or applied. Direction + payload equality
       * proves which row anchor represents the current canonical content;
       * neither a bare id nor a payload hash alone is sufficient. */
      var p02CurrentAnchor = null;
      if (source === 'p02-admitted-local' && row &&
          clean(row.last_converged_direction) &&
          /^[0-9a-f]{64}$/.test(clean(anchor.payloadSha256Hex))) {
        var anchorDirection = clean(row.last_converged_direction);
        var anchorId = anchorDirection === P02_DIRECTION.PUBLISHED
          ? clean(row.last_published_revision_id)
          : anchorDirection === P02_DIRECTION.APPLIED
            ? clean(row.last_applied_revision_id) : '';
        var anchorBlob = anchorDirection === P02_DIRECTION.PUBLISHED
          ? clean(row.last_published_revision_blob_sha256)
          : anchorDirection === P02_DIRECTION.APPLIED
            ? clean(row.last_applied_revision_blob_sha256) : '';
        var anchorPayload = anchorDirection === P02_DIRECTION.PUBLISHED
          ? clean(row.last_published_payload_sha256)
          : anchorDirection === P02_DIRECTION.APPLIED
            ? clean(row.last_applied_payload_sha256) : '';
        if (anchorId && /^[0-9a-f]{64}$/.test(anchorBlob) &&
            anchorPayload === clean(anchor.payloadSha256Hex)) {
          p02CurrentAnchor = { revisionId: anchorId, revisionBlobSha256: anchorBlob };
        }
      }
      var p02ParentMatches = !!p02CurrentAnchor &&
        incomingParent === p02CurrentAnchor.revisionId &&
        incomingParentBlob === p02CurrentAnchor.revisionBlobSha256;
      var p02AlreadyApplied = source === 'p02-admitted-local' &&
        priorApplied === incoming &&
        clean(row && row.last_applied_revision_blob_sha256) ===
          clean(pulled.head.revisionBlobSha256) &&
        clean(row && row.last_applied_payload_sha256) ===
          clean(pulled.head.payloadSha256);

      /*
       * Resumption of THIS interrupted apply - not a local unexported change.
       *
       * An apply that imported canonical content and then failed after the
       * write (a convergence refusal, a crash) leaves the canonical pointer at
       * the snapshot ITS OWN payload created, while last_applied_* is still
       * unset. On the next boot the lineage gate below sees localLast !== the
       * incoming revision and reads that as a local edit, so the operation can
       * never be completed or retried - the partial state is terminal.
       *
       * The allowance is bound to the operation itself, not to a code. acquire()
       * adopts a stale owner by rewriting only the owner triple, leaving
       * pending_operation, operation_phase and the intended_* identity exactly
       * as the interrupted run wrote them, and reports resumed:true with that
       * row. So every fact below comes from persisted state that only this same
       * pull/apply could have written:
       *   - the operation was ADOPTED, not freshly acquired;
       *   - it is a pull already in its apply phase;
       *   - its intended revision, blob, object key and payload are the exact
       *     incoming ones - a different revision, object or payload cannot match;
       *   - nothing has been applied for this target yet;
       *   - the canonical pointer is precisely this payload's own snapshot id,
       *     which is the signature of this payload's interrupted import and not
       *     of any other local edit.
       * Any unrelated local change leaves the pointer somewhere else and fails
       * the last predicate, so the normal protection below still applies. */
      var resumedRow = (acquisition && acquisition.resumed === true && acquisition.row) || null;
      var resumingSameApply = !!resumedRow &&
        clean(resumedRow.pending_operation) === 'pull' &&
        clean(resumedRow.operation_phase) === 'apply' &&
        clean(resumedRow.intended_revision_id) === incoming &&
        clean(resumedRow.intended_revision_blob_sha256) === clean(pulled.head.revisionBlobSha256) &&
        (acquisition.legacy ||
          (clean(resumedRow.intended_object_key) === clean(key) &&
           clean(resumedRow.intended_payload_sha256) === clean(pulled.head.payloadSha256))) &&
        !priorApplied &&
        !clean(row && row.last_applied_revision_blob_sha256) &&
        !clean(row && row.last_applied_payload_sha256) &&
        !!localLast &&
        localLast === clean(payloadSourceRevisionId(envelope.payload));

      /* Domain validation is complete. This is the last gate before any
       * apply-pending state, importer call, pointer, ledger, or watermark
       * mutation. */
      if (localLast && localLast !== incoming && incomingParent !== localLast &&
          !p02ParentMatches && !p02AlreadyApplied && !resumingSameApply) {
        await recordPullTerminal(acquisition, syncPeerId, objectId, 'local-unexported-change', 'local-unexported-change');
        return { ok: false, verdict: 'blocked', conflictClass: 'local-unexported-change', errorCode: 'local-unexported-change' };
      }
      if (!localLast && incomingParent) {
        await recordPullTerminal(acquisition, syncPeerId, objectId, 'revision-regression', 'revision-regression');
        return { ok: false, verdict: 'blocked', conflictClass: 'revision-regression', errorCode: 'revision-regression' };
      }
      if (localLast === incoming || p02AlreadyApplied) {
        var adoptedProof;
        try { adoptedProof = await convergence(objectId, incoming, envelope.payload, pulled.head.revisionBlobSha256); }
        catch (_) {
          await recordPullTerminal(acquisition, syncPeerId, objectId, 'local-unexported-change', 'local-unexported-change');
          return { ok: false, verdict: 'blocked', conflictClass: 'local-unexported-change', errorCode: 'local-unexported-change' };
        }
        await commitApplied(acquisition, syncPeerId, objectId, pulled, adoptedProof);
        /* Only the exact already-applied revision (id, blob and payload all
         * recorded as applied, source the admitted P02 local source, and the
         * convergence proof above passed) qualifies for the bounded metadata
         * self-heal. Adoption of an existing local revision does not. */
        var metadataReconciliation = p02AlreadyApplied
          ? await reconcileAlreadyAppliedMetadata(objectId, envelope.payload) : null;
        return Object.assign({}, pulled, {
          unchangedNoOp: true, convergenceVerified: true, adoptedExisting: !priorApplied, convergence: adoptedProof, importerInvoked: false,
          metadataReconciled: !!(metadataReconciliation && metadataReconciliation.reconciled === true),
          metadataReconciliation: metadataReconciliation
        });
      }
      var intended = intendedAssignments(acquisition);
      var applyAssignments = intended + ', remote_head_strong_etag = ?, remote_head_revision_blob_sha256 = ?';
      var applyValues = acquisition.legacy
        ? ['apply', pulled.head.revisionId, pulled.head.revisionBlobSha256, pullSourceStrongVersion(pulled), pulled.head.revisionBlobSha256]
        : ['apply', pulled.head.revisionId, pulled.head.revisionBlobSha256, key, pulled.head.payloadSha256, pullSourceStrongVersion(pulled), pulled.head.revisionBlobSha256];
      await updateOwned(acquisition, syncPeerId, objectId, applyAssignments, applyValues);
      preservePending = true;
      var appliedSourceRevisionId = clean(payloadSourceRevisionId(envelope.payload));
      if (!appliedSourceRevisionId) fail('round2a-store-convergence-failed');
      var apply = importer();
      if (typeof apply !== 'function') fail('round2a-importer-unavailable');
      importerInvoked = true;
      var applied = await apply(envelope.payload, 'merge', { round2aContentOnly: true });
      if (!applied || applied.ok !== true) fail('round2a-local-apply-failed');
      /* The merge importer intentionally fills an empty lastSnapshotId but
       * does not replace an existing one. Round 2A has already proven strict
       * lineage above, so advance only this non-destructive content pointer
       * after the immutable snapshot was idempotently inserted. */
      if (currentStores.chats && typeof currentStores.chats.upsert === 'function') {
        var localSnapshots = currentStores.snapshots && typeof currentStores.snapshots.listByChat === 'function'
          ? await currentStores.snapshots.listByChat(objectId) : [];
        await currentStores.chats.upsert({
          chatId: objectId,
          /*
           * The canonical content pointer names a canonical snapshot, so it
           * takes the payload's source id and never the envelope revisionId -
           * which, once minted, names nothing in canonical state. Identical in
           * the v1 lane, where the two values coincide.
           */
          lastSnapshotId: appliedSourceRevisionId,
          snapshotCount: Array.isArray(localSnapshots) ? localSnapshots.length : 1,
          isSaved: true,
          isLinked: true
        });
      }
      var proof = await convergence(objectId, pulled.head.revisionId, envelope.payload, pulled.head.revisionBlobSha256);
      await commitApplied(acquisition, syncPeerId, objectId, pulled, proof);
      preservePending = false;
      return Object.assign({}, pulled, { applied: true, convergenceVerified: true, convergence: proof, importerInvoked: importerInvoked });
    } catch (error) {
      if (preservePending) {
        try { await updateOwned(acquisition, syncPeerId, objectId, 'last_error_code = ?', [clean(error.code || error.message) || 'round2a-apply-interrupted']); } catch (_) { /* preserve original */ }
      } else {
        try { await updateOwned(acquisition, syncPeerId, objectId, clearOwnerAssignments(acquisition) + ', last_error_code = ?', [clean(error.code || error.message) || 'round2a-pull-failed']); } catch (_) { /* preserve original */ }
      }
      try { if (error && typeof error === 'object') error.importerInvoked = importerInvoked; } catch (_) { /* reporting only */ }
      throw error;
    } finally {
      releaseMemory(acquisition);
    }
  }

  function applyNextAdmittedLocalRevision(objectId) {
    return pullObject(objectId, { source: 'admitted-local' });
  }

  function applyNextAdmittedP02Revision(objectId) {
    return pullObject(objectId, { source: 'p02-admitted-local' });
  }

  /*
   * P02 V8-C3b: the generic publication-evidence protocol, exposed as narrow
   * production API.
   *
   * The intent-before-dispatch model here is transport-neutral - it touches
   * only pending_operation, operation_phase, the owner triple and the
   * intended_* columns - but until now it existed solely as private helpers
   * plus a __test surface, so a second publisher could only have duplicated its
   * ownership and stale-owner-adoption logic. Duplicating that subtlety is
   * exactly how two publishers drift apart, so it is promoted rather than
   * copied. Nothing WebDAV-shaped is exposed: no strong ETag, no remote head.
   */
  var publicationEvidence = Object.freeze({
    schema: 'h2o.studio.syncPublicationEvidence.p02.v1',
    readState: function (syncPeerId, objectId) {
      return stateRow(syncPeerId, objectId);
    },
    /* Durable intent. Ownership is acquired first, so a second publisher on
     * this row fails closed rather than racing. */
    recordIntent: async function (input) {
      /* The boot identity is the runtime session's, exactly as publishObject
       * and pullObject take it, and never the caller's. A caller that omitted
       * it would insert owner_boot_id = NULL, which the strict-owner predicate
       * can never match, so the very next updateOwned fails
       * round2a-local-operation-lost and strands a durable pending row. */
      var session = await runtimeSession();
      var acquisition = await acquire(
        input.syncPeerId, input.objectId, 'publish', session.bootId
      );
      try {
        await updateOwned(acquisition, input.syncPeerId, input.objectId,
          intendedAssignments(acquisition),
          acquisition.legacy
            ? ['transport', input.revisionId, input.revisionBlobSha256]
            : ['transport', input.revisionId, input.revisionBlobSha256,
              input.objectKey, input.payloadSha256]);
      } catch (error) {
        releaseMemory(acquisition);
        throw error;
      }
      return acquisition;
    },
    /*
     * Heal-on-proof. Rows published before the identity amendment carry an
     * anchor pair but no payload identity, so they cannot be classified at all
     * and would otherwise stay permanently dirty. This backfills the missing
     * identity - and ONLY that - once the repository has proven the anchor.
     *
     * Deliberately unowned: healing is bookkeeping about a publication that
     * already committed, so acquiring an operation would make a read-repair
     * compete with real work and could strand a pending row. Instead the UPDATE
     * carries its own guard: it applies only while the row is idle and still
     * names the exact pair that was proven, so an interleaved publish, apply or
     * rollback makes the heal a no-op rather than a clobber.
     */
    healPublishedPayloadIdentity: async function (input) {
      var payload = requiredPayloadIdentity(input.payloadSha256);
      var result = await sqlExecute(
        'UPDATE sync_object_state SET last_published_payload_sha256 = ?, last_converged_direction = ?, updated_at = ? ' +
        'WHERE sync_peer_id = ? AND object_id = ? AND pending_operation IS NULL ' +
        'AND last_published_revision_id = ? AND last_published_revision_blob_sha256 = ? ' +
        'AND last_published_payload_sha256 IS NULL',
        [payload, P02_DIRECTION.PUBLISHED, nowIso(),
          input.syncPeerId, input.objectId, input.revisionId, input.revisionBlobSha256]
      );
      return { healed: rowsAffected(result) === 1 };
    },
    /* Recovery only. Takes ownership of an EXISTING pending publish intent
     * through the same acquire() protocol - including its stale-owner adoption
     * rule and its same-boot refusal - without authoring a new intent: the
     * intended_* columns are left exactly as the interrupted publisher wrote
     * them. `resumed` tells the caller whether a real prior intent was adopted
     * or an empty row created, so a vanished intent can never be mistaken for
     * a recoverable one. */
    adoptIntent: async function (input) {
      var session = await runtimeSession();
      return acquire(input.syncPeerId, input.objectId, 'publish', session.bootId);
    },
    /* Completion runs only after the repository pointer is durable. It advances
     * the two generic published fields and clears owner and intent; applied and
     * consumed watermarks are deliberately untouched. */
    completePublication: async function (acquisition, input) {
      try {
        /* v22 lockstep: the anchor pair, the payload identity that anchor
         * carries, and the direction are written in one statement. Splitting
         * them would let a row claim an anchor whose content identity is
         * unknown, which is exactly the state that cannot be classified. The
         * payload hash is the one the publication was prepared from; it is
         * never re-projected here, because a re-projection could observe an
         * edit made after the bytes were composed. */
        await updateOwned(acquisition, input.syncPeerId, input.objectId,
          'last_published_revision_id = ?, last_published_revision_blob_sha256 = ?, ' +
          'last_published_payload_sha256 = ?, last_converged_direction = ?, ' +
          clearOwnerAssignments(acquisition) + ', ' +
          clearIntendedAssignments(acquisition) +
          ', last_conflict_class = NULL, last_error_code = NULL',
          [input.revisionId, input.revisionBlobSha256,
            requiredPayloadIdentity(input.payloadSha256), P02_DIRECTION.PUBLISHED]);
      } finally {
        releaseMemory(acquisition);
      }
    },
    /* A definite failure clears the intent; an indefinite one retains it so a
     * restart can prove whether the repository already committed. */
    abandonIntent: async function (acquisition, input) {
      try {
        if (input.retainIntent === true) {
          await updateOwned(acquisition, input.syncPeerId, input.objectId,
            'last_error_code = ?', [input.errorCode]);
        } else {
          await updateOwned(acquisition, input.syncPeerId, input.objectId,
            clearOwnerAssignments(acquisition) + ', ' +
            clearIntendedAssignments(acquisition) + ', last_error_code = ?',
            [input.errorCode]);
        }
      } finally {
        releaseMemory(acquisition);
      }
    }
  });

  H2O.Desktop.SyncObjectRuntime = Object.freeze({
    schema: 'h2o.studio.syncObjectRuntime.v1',
    publishObject: publishObject,
    publicationEvidence: publicationEvidence,
    pullObject: pullObject,
    applyNextAdmittedLocalRevision: applyNextAdmittedLocalRevision,
    applyNextAdmittedP02Revision: applyNextAdmittedP02Revision,
    resolveCanonicalAnchor: resolveCanonicalAnchor,
    diagnose: function () { return { installed: true, initializationSideEffects: 0, activeOperationCount: active.size }; },
    __test: Object.freeze({
      setDependencies: function (next) {
        testDependencies = next;
        /* Compatibility for the already-shipped injected transport validator,
         * whose deliberately minimal schema predates strict-owner columns.
         * Production never enters this test-only branch. */
        if (next && next.strictOwnerSchema !== true && projection().__test) {
          projection().__test.setDependencies({
            stores: next.stores,
            strictRelationshipProbe: async function () { return { assets: [], folders: [], labels: [], tags: [] }; }
          });
        }
      },
      clearDependencies: function () {
        testDependencies = null;
        active.clear();
        if (H2O.Desktop.SyncObjectProjection && H2O.Desktop.SyncObjectProjection.__test) {
          H2O.Desktop.SyncObjectProjection.__test.clearDependencies();
        }
      },
      acquire: acquire,
      updateOwned: updateOwned,
      convergence: convergence,
      stateRow: stateRow,
      contextId: contextId
    })
  });
})(typeof window !== 'undefined' ? window : globalThis);
