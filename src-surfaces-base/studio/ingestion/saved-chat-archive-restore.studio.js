/* H2O Studio — Saved Chat Archive Restore Original IDs (Desktop, Phase K.2)
 *
 * Verification-gated restore of a `.h2ochat` package under its ORIGINAL chatId
 * and ORIGINAL snapshotId. This is the first restore mode only:
 *
 *   restore-original-ids:
 *     - absent-only
 *     - non-destructive
 *     - no overwrite
 *     - no relink
 *     - no tombstone override/un-delete
 *
 * Public API (H2O.Studio.archiveRestore):
 *   isDesktopCapable() -> boolean
 *   dryRunRestorePackage({ packagePath }) -> Promise<decision>
 *   restoreVerifiedPackage({ packagePath, mode, confirm }) -> Promise<result>
 *
 * The module reuses:
 *   - H2O.Studio.archiveInspector.inspectPackage as the verification gate
 *   - H2O.Studio.archiveImporter.buildTurnsFromPackageSnapshot for portable
 *     package snapshot turns
 *
 * Writes are limited to insert-only rows in chats, snapshots, and
 * snapshot_turns, plus provenance metadata on the inserted rows. Existing rows
 * are never updated. Relink and tombstone override are future phases.
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.archiveRestore && H2O.Studio.archiveRestore.__installed) return;

  var MODULE_VERSION = '0.1.0-phase-k-2';
  var APP_LOCAL_DATA = 15;
  var DB_URL = 'sqlite:studio-v1.db';
  var PACKAGE_ROOT = 'archive/packages';
  var RESTORE_MODE = 'restore-original-ids';
  var SNAPSHOT_READ_CAP = 8 * 1024 * 1024;
  var TURN_INSERT_BATCH_SIZE = 100;

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* swallow */ }
    return false;
  }

  function cleanString(v) { return String(v == null ? '' : v).trim(); }
  function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function safeObject(v) { return isObject(v) ? v : {}; }
  function asArray(v) { return Array.isArray(v) ? v : []; }
  function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }

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

  function getInspector() {
    var ins = H2O.Studio && H2O.Studio.archiveInspector;
    return (ins && typeof ins.inspectPackage === 'function') ? ins : null;
  }

  function getImporter() {
    var imp = H2O.Studio && H2O.Studio.archiveImporter;
    return (imp && typeof imp.buildTurnsFromPackageSnapshot === 'function') ? imp : null;
  }

  function getStores() { return (H2O.Studio && H2O.Studio.store) || {}; }
  function getSnapshotsStore() {
    var s = getStores().snapshots;
    return (s && typeof s.get === 'function') ? s : null;
  }
  function getChatsStore() {
    var c = getStores().chats;
    return (c && typeof c.get === 'function') ? c : null;
  }

  function isDesktopCapable() {
    return detectTauri() && !!getInvoke() && !!getInspector() && !!getImporter()
      && !!getSnapshotsStore() && !!getChatsStore();
  }

  function sqlSelect(query, values) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable'));
    return invoke('plugin:sql|select', { db: DB_URL, query: query, values: values || [] });
  }

  function sqlExecute(query, values) {
    var invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('tauri invoke unavailable'));
    return invoke('plugin:sql|execute', { db: DB_URL, query: query, values: values || [] });
  }

  function joinPath() {
    var parts = [];
    for (var i = 0; i < arguments.length; i += 1) {
      var part = cleanString(arguments[i]).replace(/^\/+|\/+$/g, '');
      if (part) parts.push(part);
    }
    return parts.join('/');
  }

  function packageDirNameForPath(packagePath) {
    var p = cleanString(packagePath).replace(/[\/\\]+$/g, '');
    var idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  function packagePathIsScoped(packagePath) {
    var p = cleanString(packagePath).replace(/[\/\\]+$/g, '');
    return p.indexOf(PACKAGE_ROOT + '/') === 0 && /\.h2ochat$/.test(packageDirNameForPath(p));
  }

  function decodeToText(value) {
    if (typeof value === 'string') return value;
    var bytes = value;
    if (value && value.data && (Array.isArray(value.data) || value.data instanceof Uint8Array)) bytes = value.data;
    try {
      var arr = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(asArray(bytes));
      if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(arr);
      var out = ''; for (var i = 0; i < arr.length; i += 1) out += String.fromCharCode(arr[i]);
      return out;
    } catch (_) { return ''; }
  }

  function safeParseJson(text) {
    try { var v = JSON.parse(text); return isObject(v) ? v : null; } catch (_) { return null; }
  }

  /* Single governed saved-chat package codec authority (M03 T02/T03). This
   * module never implements gzip decoding, magic detection, physical/logical
   * hashing or descriptor verification; it only consumes verified logical bytes. */
  function savedChatPackageCodecV3() {
    var codec = H2O.Studio && H2O.Studio.ingestion && H2O.Studio.ingestion.savedChatPackageCodec;
    if (!codec || codec.__installed !== true ||
        typeof codec.readVerifiedPackageMember !== 'function' ||
        !isFiniteNumber(codec.LOGICAL_SNAPSHOT_CAP_BYTES)) {
      return null;
    }
    return codec;
  }

  /* ── Trusted archive-state binding ────────────────────────────────────────
   *
   * `packagePath` is an ADDRESS, never proof. Between the moment trusted
   * verification rules on a package and the moment its bytes are read, the
   * bytes at that address can change. Sourcing the expected digest, length or
   * encoding from a package file read after that ruling lets a substituted
   * package describe — and therefore validate — itself, and for restore the
   * consequence is content persisted under another package's ORIGINAL
   * canonical chatId and snapshotId.
   *
   * So the expectations come from the trusted archive-integrity enumeration
   * instead: the verifier's own measurements of the package it examined. The
   * package is never allowed to state what it should hash to. This module adds
   * no verification of its own — it consumes existing trusted facts and the
   * existing governed codec. */
  var CLASS_VERIFIED_GENERATION = 'verified-generation';
  var CLASS_LEGACY_PACKAGE = 'legacy-package';
  var FAMILY_V3 = 'v3';

  function getTrustedIntegrityFn() {
    var ing = (H2O.Studio && H2O.Studio.ingestion) || {};
    return (typeof ing.readSavedChatArchiveIntegrityV1 === 'function')
      ? ing.readSavedChatArchiveIntegrityV1 : null;
  }
  function getPartitionFn() {
    var mapping = (H2O.Studio && H2O.Studio.archiveHealthMapping) || null;
    return (mapping && typeof mapping.partitionOccupants === 'function')
      ? mapping.partitionOccupants : null;
  }

  /* Representation normalization only. The trusted wire carries a bare digest
   * for content identity; the inspector re-applies the `sha256-` prefix
   * outwardly. Nothing is recomputed. */
  function bareHash(value) {
    var text = cleanString(value).toLowerCase();
    return text.indexOf('sha256-') === 0 ? text.slice(7) : text;
  }

  /* The trusted occupant for exactly this package, from a FRESH enumeration.
   * The canonical partition is reused, so reserved infrastructure and
   * non-package strays can never be matched. */
  function trustedOccupantFor(packagePath) {
    var readIntegrity = getTrustedIntegrityFn();
    var partition = getPartitionFn();
    if (!readIntegrity || !partition) return Promise.resolve(null);
    return Promise.resolve()
      .then(function () { return readIntegrity(); })
      .then(function (envelope) {
        var occupants = asArray(safeObject(partition(safeObject(envelope).occupants)).packageOccupants);
        for (var i = 0; i < occupants.length; i += 1) {
          var occupant = safeObject(occupants[i]);
          if (cleanString(occupant.path) !== packagePath) continue;
          var klass = cleanString(occupant.class);
          if (klass !== CLASS_VERIFIED_GENERATION && klass !== CLASS_LEGACY_PACKAGE) return null;
          return occupant;
        }
        return null;
      }, function () { return null; });
  }

  /* Binds the two independent trusted reads — the inspection that produced the
   * verdict and the enumeration that produced the member measurements — to the
   * SAME package state. STRICT: both sides are trusted output, so a missing
   * identity is a failure to bind, not an absence of evidence. Two empty values
   * must never compare equal. */
  function trustedStateMatches(inspection, occupant) {
    var inspected = bareHash(safeObject(safeObject(inspection).identity).contentHash);
    var enumerated = bareHash(safeObject(occupant).contentHash);
    if (!inspected || !enumerated) return false;
    return inspected === enumerated;
  }

  /* The verifier's own measurements of the snapshot member. Returned only when
   * COMPLETE: a partial set is a set of checks that would silently not happen,
   * so it fails closed rather than degrading. */
  function trustedMemberAnchors(occupant) {
    var o = safeObject(occupant);
    var encoding = cleanString(o.snapshotEncoding);
    var physicalSha = cleanString(o.snapshotPhysicalSha256);
    var logicalSha = cleanString(o.logicalSnapshotSha256);
    var physicalLength = o.snapshotPhysicalByteLength;
    var logicalLength = o.logicalSnapshotByteLength;
    var family = cleanString(o.constructionFamily);
    if (!family || !encoding || !physicalSha || !logicalSha) return null;
    if (!isFiniteNumber(physicalLength) || physicalLength < 0) return null;
    if (!isFiniteNumber(logicalLength) || logicalLength < 0) return null;
    return {
      family: family,
      encoding: encoding,
      physicalSha256: physicalSha,
      physicalByteLength: physicalLength,
      logicalSha256: logicalSha,
      logicalByteLength: logicalLength,
    };
  }

  /* The governed member descriptor, built ENTIRELY from trusted anchors. Every
   * field the codec verifies against is a verifier measurement; no value here
   * comes from the package. */
  function trustedSnapshotDescriptor(anchors) {
    var a = safeObject(anchors);
    return {
      path: 'snapshot.json',
      encoding: a.encoding,
      sha256: a.physicalSha256,
      byteLength: a.physicalByteLength,
      contentSha256: a.logicalSha256,
      contentByteLength: a.logicalByteLength,
    };
  }

  /* Read the snapshot BOUND to the trusted package state.
   *
   * The read regime is chosen by the TRUSTED construction family, never by
   * anything the package says about itself, so a package trusted as v3 can
   * never fall through to the weaker plain read by claiming otherwise. v3 goes
   * through the governed verified-member path against the trusted descriptor;
   * v1/v2 have no governed logical representation, so the bounded reader's own
   * returned physical digest AND length are compared against the trusted
   * measurements before a single byte is parsed. A package substituted after
   * either the inspection or the enumeration therefore refuses here.
   *
   * Every failure yields null, which the existing callers already treat as a
   * hard refusal — no new policy state is introduced. */
  function readBoundPackageSnapshotJson(packagePath, inspection) {
    var codec = savedChatPackageCodecV3();
    if (!codec || typeof codec.readBoundedPackageMemberBytes !== 'function') return Promise.resolve(null);
    return trustedOccupantFor(packagePath).then(function (occupant) {
      if (!occupant || !trustedStateMatches(inspection, occupant)) return null;
      var anchors = trustedMemberAnchors(occupant);
      if (!anchors) return null;
      var cap = codec.LOGICAL_SNAPSHOT_CAP_BYTES;
      if (anchors.family === FAMILY_V3) {
        return Promise.resolve(codec.readVerifiedPackageMember({
          packagePath: packagePath,
          descriptor: trustedSnapshotDescriptor(anchors),
          expectedPath: 'snapshot.json',
          physicalByteCap: cap,
          logicalByteCap: cap,
        })).then(function (verified) {
          return safeParseJson(decodeToText(safeObject(verified).logicalBytes));
        }, function () { return null; });
      }
      return Promise.resolve(codec.readBoundedPackageMemberBytes({
        packagePath: packagePath,
        memberPath: 'snapshot.json',
        physicalByteCap: cap,
      })).then(function (bounded) {
        var read = safeObject(bounded);
        if (bareHash(read.physicalSha256) !== bareHash(anchors.physicalSha256)) return null;
        if (read.physicalByteLength !== anchors.physicalByteLength) return null;
        return safeParseJson(decodeToText(read.storedBytes));
      }, function () { return null; });
    }, function () { return null; });
  }

  function snapshotRowId(snap) {
    var s = safeObject(snap);
    return cleanString(s.snapshotId) || cleanString(s.id);
  }

  function getChatIdFromRow(chat) {
    var c = safeObject(chat);
    return cleanString(c.chatId) || cleanString(c.id);
  }

  function contentDigestFromSnapshot(snapshotJson, contentHash) {
    var snap = safeObject(snapshotJson);
    var meta = safeObject(snap.metadata || snap.meta);
    return cleanString(snap.digest) || cleanString(meta.digest) || cleanString(contentHash);
  }

  function packageIdentity(inspection, snapshotJson) {
    var ins = safeObject(inspection);
    var id = safeObject(ins.identity);
    var snap = safeObject(snapshotJson);
    var messages = asArray(snap.messages);
    var contentHash = cleanString(id.contentHash);
    return {
      chatId: cleanString(id.chatId) || cleanString(snap.chatId),
      snapshotId: cleanString(id.snapshotId) || cleanString(snap.snapshotId),
      title: cleanString(snap.title) || cleanString(id.title) || 'Restored chat',
      contentHash: contentHash,
      /* M05 §D — the EXACT generation this operation is bound to. `contentHash`
       * is the inspector's RECOMPUTED hash, so for a `generation` package it is
       * also the generation identifier in the basename. This flow is driven by
       * an explicitly selected packagePath and must never substitute a newer
       * sibling generation, a "latest", or a BEST-HISTORICAL pick for it. */
      packageKind: cleanString(id.packageKind) || 'unusable',
      nameClassification: cleanString(id.nameClassification) || 'unclassified',
      contentHashVerified: id.contentHashVerified === true,
      manifestClaimedContentHash: cleanString(id.manifestClaimedContentHash),
      digest: contentDigestFromSnapshot(snap, contentHash),
      capturedAt: snap.capturedAt == null ? '' : snap.capturedAt,
      messageCount: messages.length || (isFiniteNumber(id.messageCount) ? id.messageCount : 0),
      schemaVersion: id.schemaVersion == null ? null : id.schemaVersion,
      payloadVersion: id.payloadVersion == null ? null : id.payloadVersion,
    };
  }

  function toEpochMillis(value) {
    if (typeof value === 'number' && isFinite(value)) return Math.floor(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
    var parsed = Date.parse(String(value == null ? '' : value));
    return isFinite(parsed) ? parsed : Date.now();
  }

  function existingSnapshotDigest(combined) {
    var snap = safeObject(safeObject(combined).snapshot);
    var meta = safeObject(snap.meta);
    return cleanString(snap.digest) || cleanString(meta.digest) || cleanString(meta.contentHash);
  }

  function nonVerifiedDecision(inspectStatus) {
    var s = cleanString(inspectStatus);
    if (s === 'verified') return null;
    if (s === 'unsupported-version') return 'unsupported-version';
    if (s === 'missing-files' || s === 'hash-mismatch' || s === 'corrupted') return 'corrupted';
    if (s === 'read-error') return 'read-error';
    return 'rejected';
  }

  function baseIdentity() {
    return {
      chatId: '', snapshotId: '', title: '', contentHash: '', digest: '',
      capturedAt: '', messageCount: 0, schemaVersion: null, payloadVersion: null,
    };
  }

  function dryRunResult(packagePath, decision, identity, store, reason, inspectStatus) {
    var ok = decision === 'restore-ready' || decision === 'already-present';
    return {
      ok: ok,
      decision: decision,
      status: decision,
      packagePath: cleanString(packagePath) || null,
      packageDirName: packagePath ? packageDirNameForPath(packagePath) : null,
      mode: RESTORE_MODE,
      mutated: false,
      identity: identity || baseIdentity(),
      store: store || {
        chatExists: false,
        snapshotExists: false,
        chatTombstoned: false,
        digestComparable: false,
        digestMatches: false,
      },
      reason: reason || '',
      inspectStatus: cleanString(inspectStatus),
    };
  }

  function actionResult(packagePath, status, dry, restored, reason) {
    return {
      ok: status === 'restored' || status === 'already-present',
      status: status,
      decision: cleanString(dry && dry.decision),
      packagePath: cleanString(packagePath) || null,
      mode: RESTORE_MODE,
      restored: restored || null,
      reason: reason || '',
    };
  }

  function findActiveChatTombstone(chatId) {
    var id = cleanString(chatId);
    if (!id) return Promise.resolve(false);
    return sqlSelect(
      "SELECT 1 AS present FROM sync_tombstones WHERE record_kind = 'chat' AND record_id = ? AND (restored_at IS NULL OR restored_at = '') LIMIT 1",
      [id]
    ).then(function (rows) { return Array.isArray(rows) && rows.length > 0; }, function () { return false; });
  }

  function dryRunRestorePackage(options) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    if (!packagePath) return Promise.resolve(dryRunResult(null, 'rejected', null, null, 'no package path', ''));
    if (!isDesktopCapable()) return Promise.resolve(dryRunResult(packagePath, 'rejected', null, null, 'desktop-only', ''));
    if (!packagePathIsScoped(packagePath)) return Promise.resolve(dryRunResult(packagePath, 'rejected', null, null, 'path-not-scoped', ''));

    var inspector = getInspector();
    var snapStore = getSnapshotsStore();
    var chatStore = getChatsStore();
    var inspection = null;
    var snapshotJson = null;

    return Promise.resolve()
      .then(function () { return inspector.inspectPackage({ packagePath: packagePath }); })
      .then(function (res) { inspection = safeObject(res); })
      .then(function () { return readBoundPackageSnapshotJson(packagePath, inspection); })
      .then(function (json) { snapshotJson = json; })
      .then(function () {
        var inspectStatus = cleanString(inspection.status);
        var identity = packageIdentity(inspection, snapshotJson);
        var early = nonVerifiedDecision(inspectStatus);
        if (early) return dryRunResult(packagePath, early, identity, null, 'inspector status: ' + inspectStatus, inspectStatus);
        /* The snapshot could not be bound to the trusted package state, so there
         * is nothing here that may be reported as restorable. Execution refuses
         * this case too, but a dry-run that still said `restore-ready` would arm
         * an operator confirmation for a package whose content is unproven.
         * Existing `rejected` vocabulary; no new decision state. */
        if (!snapshotJson) {
          return dryRunResult(packagePath, 'rejected', identity, null,
            'snapshot content could not be bound to the trusted package state', inspectStatus);
        }
        if (!identity.chatId || !identity.snapshotId) {
          return dryRunResult(packagePath, 'rejected', identity, null, 'package identity missing chatId or snapshotId', inspectStatus);
        }
        return Promise.all([
          Promise.resolve(snapStore.get(identity.snapshotId)).catch(function () { return null; }),
          Promise.resolve(chatStore.get(identity.chatId)).catch(function () { return null; }),
          findActiveChatTombstone(identity.chatId),
        ]).then(function (triple) {
          var existingCombined = triple[0];
          var existingChat = triple[1];
          var tombstoned = triple[2] === true || !!(existingChat && existingChat.isDeleted);
          var existingSnap = safeObject(existingCombined).snapshot;
          var snapshotExists = !!snapshotRowId(existingSnap);
          var chatExists = !!getChatIdFromRow(existingChat);
          var store = {
            chatExists: chatExists,
            snapshotExists: snapshotExists,
            chatTombstoned: tombstoned,
            digestComparable: false,
            digestMatches: false,
          };
          if (tombstoned) {
            return dryRunResult(packagePath, 'tombstoned', identity, store, 'original chatId is tombstoned; override/un-delete is deferred', inspectStatus);
          }
          if (snapshotExists) {
            var existingDigest = existingSnapshotDigest(existingCombined);
            var expectedDigest = cleanString(identity.digest);
            /* Two materially different situations both refuse to overwrite, and
             * the refusal is right in both. But only one of them is a finding:
             * "the store genuinely differs from this package" is an
             * authoritative comparison, while "one side had no digest to
             * compare" concluded nothing at all. Reporting the second as the
             * first would tell an operator their archive diverged when it may
             * be identical, so the indeterminate case stays indeterminate. */
            var digestComparable = !!expectedDigest && !!existingDigest;
            var digestMatches = digestComparable && expectedDigest === existingDigest;
            store.digestComparable = digestComparable;
            store.digestMatches = digestMatches;
            if (digestMatches) {
              return dryRunResult(packagePath, 'already-present', identity, store, 'original snapshotId already exists with matching digest', inspectStatus);
            }
            if (!digestComparable) {
              return dryRunResult(packagePath, 'conflict-snapshot-id', identity, store, 'original snapshotId exists but the digests could not be compared (one side is missing a digest); refusing overwrite without an authoritative comparison', inspectStatus);
            }
            return dryRunResult(packagePath, 'conflict-snapshot-id', identity, store, 'original snapshotId exists with a different digest; refusing overwrite', inspectStatus);
          }
          if (chatExists) {
            return dryRunResult(packagePath, 'conflict-chat-id', identity, store, 'original chatId exists; relink/restore-into-existing-chat is deferred', inspectStatus);
          }
          return dryRunResult(packagePath, 'restore-ready', identity, store, 'verified package is absent from the store and not tombstoned', inspectStatus);
        });
      })
      .catch(function (err) {
        return dryRunResult(packagePath, 'read-error', null, null, String((err && err.message) || err || 'dry-run threw'), '');
      });
  }

  function metaJson(meta) {
    try { return JSON.stringify(meta || {}); } catch (_) { return '{}'; }
  }

  function turnMeta(turn) {
    return metaJson(safeObject(turn).meta || {});
  }

  function insertTurns(snapshotId, turns) {
    if (!Array.isArray(turns) || !turns.length) return Promise.resolve(null);
    var chain = Promise.resolve();
    for (var start = 0; start < turns.length; start += TURN_INSERT_BATCH_SIZE) {
      (function (batch, batchStart) {
        chain = chain.then(function () {
          var rowsSql = batch.map(function () { return '(?, ?, ?, ?, ?, ?)'; }).join(', ');
          var vals = [];
          batch.forEach(function (t, idx) {
            var turn = safeObject(t);
            var turnIdx = isFiniteNumber(turn.turnIdx) ? Math.floor(turn.turnIdx) : (batchStart + idx);
            vals.push(snapshotId, turnIdx, cleanString(turn.role) || 'assistant',
              String(turn.outerHtml || ''), String(turn.text || ''), turnMeta(turn));
          });
          return sqlExecute('INSERT INTO snapshot_turns (snapshot_id, turn_idx, role, outer_html, text, meta_json) VALUES ' + rowsSql, vals);
        });
      })(turns.slice(start, start + TURN_INSERT_BATCH_SIZE), start);
    }
    return chain;
  }

  function rollbackQuietly() {
    return sqlExecute('ROLLBACK', []).catch(function () { return null; });
  }

  function insertRestoreRows(packagePath, identity, snapshotJson, turns) {
    var now = Date.now();
    var restoredAt = new Date(now).toISOString();
    var capturedAt = toEpochMillis(identity.capturedAt);
    var provenance = {
      restoredFromPackage: true,
      source: 'h2ochat-package-restore',
      restorer: 'archive-restore-k2',
      mode: RESTORE_MODE,
      originalChatId: identity.chatId,
      originalSnapshotId: identity.snapshotId,
      contentHash: identity.contentHash,
      digest: identity.digest,
      packagePath: packagePath,
      packageDirName: packageDirNameForPath(packagePath),
      originalCapturedAt: identity.capturedAt,
      restoredAt: restoredAt,
    };
    var chatMeta = { restored: provenance };
    var snapshotMeta = Object.assign({}, safeObject(snapshotJson).meta || {}, { restored: provenance });

    return sqlExecute('BEGIN IMMEDIATE', []).then(function () {
      var chatRows = [];
      return sqlSelect('SELECT id FROM snapshots WHERE id = ? LIMIT 1', [identity.snapshotId])
        .then(function (snapshotRows) {
          if (asArray(snapshotRows).length) throw new Error('conflict-snapshot-id');
          return sqlSelect('SELECT id, is_deleted FROM chats WHERE id = ? LIMIT 1', [identity.chatId]);
        }).then(function (rows) {
          chatRows = asArray(rows);
          if (chatRows.length && Number(safeObject(chatRows[0]).is_deleted) === 1) throw new Error('tombstoned');
          return sqlSelect("SELECT tombstone_id FROM sync_tombstones WHERE record_kind = 'chat' AND record_id = ? AND (restored_at IS NULL OR restored_at = '') LIMIT 1", [identity.chatId]);
        }).then(function (tombstoneRows) {
          if (asArray(tombstoneRows).length) throw new Error('tombstoned');
          if (chatRows.length) throw new Error('conflict-chat-id');
        return sqlExecute(
          'INSERT INTO chats (id, title, created_at, updated_at, last_message_at, message_count, is_saved, is_linked, last_snapshot_id, last_captured_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [identity.chatId, identity.title, now, now, capturedAt, turns.length, 1, 0, identity.snapshotId, capturedAt, metaJson(chatMeta)]
        );
      }).then(function () {
        return sqlExecute(
          'INSERT INTO snapshots (id, chat_id, title, digest, message_count, captured_at, updated_at, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [identity.snapshotId, identity.chatId, identity.title, identity.digest, turns.length, capturedAt, now, metaJson(snapshotMeta)]
        );
      }).then(function () {
        return insertTurns(identity.snapshotId, turns);
      }).then(function () {
        return sqlExecute('COMMIT', []);
      }).then(function () {
        return {
          chatId: identity.chatId,
          snapshotId: identity.snapshotId,
          turnCount: turns.length,
          contentHash: identity.contentHash,
          restoredAt: restoredAt,
        };
      });
    }).catch(function (err) {
      return rollbackQuietly().then(function () { throw err; });
    });
  }

  function restoreVerifiedPackage(options) {
    var opts = safeObject(options);
    var packagePath = cleanString(opts.packagePath);
    var mode = cleanString(opts.mode) || RESTORE_MODE;
    if (!packagePath) return Promise.resolve(actionResult(null, 'rejected', null, null, 'no package path'));
    if (!isDesktopCapable()) return Promise.resolve(actionResult(packagePath, 'rejected', null, null, 'desktop-only'));
    if (mode !== RESTORE_MODE) return Promise.resolve(actionResult(packagePath, 'rejected', null, null, 'unsupported-mode: ' + mode));
    if (opts.confirm !== true) return Promise.resolve(actionResult(packagePath, 'rejected', null, null, 'confirm required'));

    var dry = null;
    var snapshotJson = null;
    return dryRunRestorePackage({ packagePath: packagePath }).then(function (res) {
      dry = safeObject(res);
      if (dry.decision === 'already-present') {
        return actionResult(packagePath, 'already-present', dry, {
          chatId: dry.identity.chatId,
          snapshotId: dry.identity.snapshotId,
          turnCount: 0,
          contentHash: dry.identity.contentHash,
        }, 'original snapshot already present; no write performed');
      }
      if (dry.decision !== 'restore-ready') {
        var conflictStatuses = { 'conflict-chat-id': true, 'conflict-snapshot-id': true };
        var status = conflictStatuses[dry.decision] ? 'conflict' : (dry.decision === 'tombstoned' ? 'tombstoned' : 'rejected');
        return actionResult(packagePath, status, dry, null, dry.reason || ('not restore-ready: ' + dry.decision));
      }
      return Promise.resolve(getInspector().inspectPackage({ packagePath: packagePath })).then(function (inspection) {
        if (cleanString(safeObject(inspection).status) !== 'verified') {
          return actionResult(packagePath, 'rejected', dry, null, 'package no longer verified at write time');
        }
        return readBoundPackageSnapshotJson(packagePath, inspection).then(function (json) {
          snapshotJson = json;
          var identity = packageIdentity(inspection, snapshotJson);
          var turns = getImporter().buildTurnsFromPackageSnapshot(snapshotJson);
          if (!turns.length) {
            return actionResult(packagePath, 'rejected', dry, null, 'no turns to restore (refusing partial restore)');
          }
          return Promise.resolve(getSnapshotsStore().get(identity.snapshotId)).catch(function () { return null; })
            .then(function (existingCombined) {
              if (snapshotRowId(safeObject(existingCombined).snapshot)) {
                return actionResult(packagePath, 'conflict', dry, null, 'snapshot appeared before insert; refusing overwrite');
              }
              return insertRestoreRows(packagePath, identity, snapshotJson, turns).then(function (restored) {
                return actionResult(packagePath, 'restored', dry, restored, 'restored original chatId + snapshotId');
              });
            });
        });
      });
    }).catch(function (err) {
      var msg = String((err && err.message) || err || 'restore threw');
      if (msg === 'tombstoned') return actionResult(packagePath, 'tombstoned', dry, null, 'chat became tombstoned before insert');
      if (msg === 'conflict-chat-id' || msg === 'conflict-snapshot-id') return actionResult(packagePath, 'conflict', dry, null, msg);
      return actionResult(packagePath, 'write-error', dry, null, msg);
    });
  }

  H2O.Studio.archiveRestore = {
    __installed: true,
    __version: MODULE_VERSION,
    detectTauri: detectTauri,
    isDesktopCapable: isDesktopCapable,
    dryRunRestorePackage: dryRunRestorePackage,
    restoreVerifiedPackage: restoreVerifiedPackage,
  };
})(typeof window !== 'undefined' ? window : globalThis);
