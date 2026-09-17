/* H2O Studio — Saved Chat Local Backup card (Backup v1 T03)
 *
 * New UI only. A manual, operator-triggered surface mounted as a sibling
 * beneath the Archive Health card, following the same pattern as the
 * inspector, importer, exporter, reclamation and Recovery Center cards.
 *
 * ONE ACTION, NON-DESTRUCTIVE. "Back up saved chats" writes one immutable,
 * verified, point-in-time backup set under the governed local backup root
 * that the native T02 publisher derives itself. This module names no path, no
 * root, no staging name, no package leaf, no backupId and no completeness
 * flag; every one of those is native-derived. It never writes the source
 * Saved-Chat DB, the archive, the CAS, the asset registry or Sync state.
 *
 * WHAT IT ORCHESTRATES (contract §4–§7, §9, §12–§17 of the accepted T01
 * Local Backup v1 contract; native authority in
 * docs/systems/archive/saved-chat-local-backup.md):
 *
 *   1. enumerate the eligible set through the existing store adapters and
 *      freeze it (declaration-before-creation);
 *   2. BEGIN a native session with that declaration;
 *   3. per eligible chat: package_begin → the REAL live-family package
 *      builder run ONCE with a Backup-private asset stack that streams the
 *      projection's own asset bytes into the open native stage → the
 *      source-change guard → snapshot + manifest members → package_finish
 *      bound to the builder's contentHash (one automatic rebuild on a guard
 *      mismatch, then backup-source-unstable);
 *   4. FINALIZE with the exact per-entry failure records;
 *   5. render complete / incomplete / failed truthfully.
 *
 * WHAT IT NEVER DOES: no second package projector, serializer, hasher,
 * verifier or scanner; no source store write verb; no CAS read or write; no
 * arbitrary filesystem path; no restore; no retention or deletion.
 *
 * Failure vocabulary is CLOSED (NB-VER-02): renderer-generated codes come
 * from RENDERER_FAILURE_CODES, native codes are passed through verbatim and
 * are expected within NATIVE_FAILURE_CODES, and stages come from
 * FAILURE_STAGES. Nothing here invents a code.
 *
 * Contracts: docs/systems/archive/saved-chat-local-backup.md
 */
(function (global) {
  'use strict';

  var H2O = global.H2O = global.H2O || {};
  H2O.Studio = H2O.Studio || {};
  if (H2O.Studio.localBackupUi && H2O.Studio.localBackupUi.__installed) return;

  var MODULE_VERSION = '1.0.0-backup-v1-t03';

  /* The exact accepted T02 native command surface. Reused, never duplicated. */
  var COMMANDS = Object.freeze({
    rootPolicy: 'h2o_saved_chat_backup_root_policy',
    begin: 'h2o_saved_chat_backup_begin',
    packageBegin: 'h2o_saved_chat_backup_package_begin',
    writeMember: 'h2o_saved_chat_backup_write_member',
    packageFinish: 'h2o_saved_chat_backup_package_finish',
    packageAbort: 'h2o_saved_chat_backup_package_abort',
    finalize: 'h2o_saved_chat_backup_finalize',
    abort: 'h2o_saved_chat_backup_abort',
    list: 'h2o_saved_chat_backup_list',
    verify: 'h2o_saved_chat_backup_verify',
  });

  /* Renderer transport chunk (contract §18: native admits ≤ 8 MiB per call;
   * the renderer sends 4 MiB). A transport constant, never a member ceiling. */
  var CHUNK_BYTES = 4 * 1024 * 1024;
  /* One automatic rebuild per entry after a guard mismatch (contract §5). */
  var MAX_REBUILDS = 1;
  /* Bounded diagnostic text per failure record (contract §8). */
  var FAILURE_DETAIL_MAX_BYTES = 512;

  /* ── Closed vocabularies (NB-VER-02) ─────────────────────────────────── */

  /* Codes THIS module may generate for a per-entry failure or a run refusal. */
  var RENDERER_FAILURE_CODES = Object.freeze([
    'backup-enumeration-indeterminate',
    'backup-enumeration-inconsistent',
    'backup-source-chat-disappeared',
    'backup-source-snapshot-disappeared',
    'backup-source-read-failed',
    'backup-source-unstable',
    'backup-projection-failed',
    'backup-projection-bound-exceeded',
  ]);

  /* Existing vocabulary reused verbatim where the meaning is identical. */
  var REUSED_FAILURE_CODES = Object.freeze([
    'store-not-ready',
    'generation-policy-unavailable',
  ]);

  /* The native T02 vocabulary (contract §17). A native `status` is passed
   * through verbatim and is expected to be one of these. */
  var NATIVE_FAILURE_CODES = Object.freeze([
    'backup-root-unavailable', 'backup-root-absent', 'backup-path-redirect-refused',
    'backup-unsupported-platform', 'backup-session-busy', 'backup-session-unknown',
    'backup-session-evicted', 'backup-invalid-state', 'backup-staging-collision',
    'backup-destination-exists', 'backup-write-failed', 'backup-fence-failed',
    'backup-promote-failed', 'backup-cleanup-incomplete',
    'backup-name-exceeds-filesystem-limit', 'backup-name-limit-indeterminate',
    'backup-invalid-member-name', 'backup-member-duplicate', 'backup-member-empty',
    'backup-chunk-too-large', 'backup-entry-unknown', 'backup-entry-duplicate',
    'backup-manifest-inconsistent', 'backup-nothing-to-back-up',
    'backup-no-package-succeeded', 'backup-asset-hash-mismatch',
    'backup-member-length-mismatch', 'backup-package-identity-mismatch',
    'backup-package-verification-failed', 'backup-publication-identity-mismatch',
    'backup-package-leaf-occupied', 'backup-set-foreign-entry',
    'backup-set-package-unverified', 'backup-set-cross-check-failed',
    'backup-set-digest-mismatch', 'backup-manifest-invalid',
    'backup-manifest-too-large', 'backup-not-a-backup-leaf', 'backup-cancelled',
    'backup-staging-residue-detected',
  ]);

  /* The stage a per-entry failure is attributed to. */
  var FAILURE_STAGES = Object.freeze([
    'enumeration',
    'package-begin',
    'build',
    'guard',
    'write-member',
    'package-finish',
  ]);

  /* Contract §17 error classes, for display only. */
  var ERROR_CLASSES = Object.freeze({
    'backup-root-unavailable': 'DESTINATION_ERROR',
    'backup-root-absent': 'DESTINATION_ERROR',
    'backup-path-redirect-refused': 'DESTINATION_ERROR',
    'backup-destination-exists': 'DESTINATION_ERROR',
    'backup-write-failed': 'DESTINATION_ERROR',
    'backup-fence-failed': 'DESTINATION_ERROR',
    'backup-promote-failed': 'DESTINATION_ERROR',
    'backup-cleanup-incomplete': 'DESTINATION_ERROR',
    'backup-unsupported-platform': 'UNSUPPORTED',
    'backup-session-busy': 'RETRYABLE',
    'backup-staging-collision': 'RETRYABLE',
    'backup-session-unknown': 'PROTOCOL_ERROR',
    'backup-session-evicted': 'PROTOCOL_ERROR',
    'backup-invalid-state': 'PROTOCOL_ERROR',
    'backup-name-exceeds-filesystem-limit': 'PROTOCOL_ERROR',
    'backup-name-limit-indeterminate': 'PROTOCOL_ERROR',
    'backup-invalid-member-name': 'PROTOCOL_ERROR',
    'backup-member-duplicate': 'PROTOCOL_ERROR',
    'backup-member-empty': 'PROTOCOL_ERROR',
    'backup-chunk-too-large': 'PROTOCOL_ERROR',
    'backup-entry-unknown': 'PROTOCOL_ERROR',
    'backup-entry-duplicate': 'PROTOCOL_ERROR',
    'backup-manifest-inconsistent': 'PROTOCOL_ERROR',
    'backup-nothing-to-back-up': 'PROTOCOL_ERROR',
    'backup-no-package-succeeded': 'PROTOCOL_ERROR',
    'backup-enumeration-indeterminate': 'SOURCE_DATA_ERROR',
    'backup-enumeration-inconsistent': 'SOURCE_DATA_ERROR',
    'backup-source-chat-disappeared': 'SOURCE_DATA_ERROR',
    'backup-source-snapshot-disappeared': 'SOURCE_DATA_ERROR',
    'backup-source-read-failed': 'SOURCE_DATA_ERROR',
    'backup-source-unstable': 'SOURCE_DATA_ERROR',
    'backup-projection-failed': 'SOURCE_DATA_ERROR',
    'backup-projection-bound-exceeded': 'SOURCE_DATA_ERROR',
    'store-not-ready': 'SOURCE_DATA_ERROR',
    'generation-policy-unavailable': 'SOURCE_DATA_ERROR',
    'backup-asset-hash-mismatch': 'INTEGRITY_FAILURE',
    'backup-member-length-mismatch': 'INTEGRITY_FAILURE',
    'backup-package-identity-mismatch': 'INTEGRITY_FAILURE',
    'backup-package-verification-failed': 'INTEGRITY_FAILURE',
    'backup-publication-identity-mismatch': 'INTEGRITY_FAILURE',
    'backup-package-leaf-occupied': 'INTEGRITY_FAILURE',
    'backup-set-foreign-entry': 'INTEGRITY_FAILURE',
    'backup-set-package-unverified': 'INTEGRITY_FAILURE',
    'backup-set-cross-check-failed': 'INTEGRITY_FAILURE',
    'backup-set-digest-mismatch': 'INTEGRITY_FAILURE',
    'backup-manifest-invalid': 'INTEGRITY_FAILURE',
    'backup-manifest-too-large': 'INTEGRITY_FAILURE',
    'backup-not-a-backup-leaf': 'INTEGRITY_FAILURE',
    'backup-cancelled': 'CANCELLED',
    'backup-staging-residue-detected': 'INFORMATIONAL',
  });

  var TEXT = {
    title: 'Local backup',
    subtitle: 'Creates a manual local backup of the saved chats selected at the start. '
      + 'Each chat is consistency-checked while it is backed up. The backup is written to the '
      + 'H2O Studio Backups folder in your home folder, and existing backups are never changed.',
    recoveryScope: 'Recovery in v1 uses Recover as New; it does not overwrite the current chat. '
      + 'Chat text and turns are preserved. Image and other asset bytes remain in the backup package, '
      + 'but Recover as New does not reattach those package assets to the recovered chat in v1.',
    idle: 'No backup has been run in this session.',
    unavailable: 'Local backup is available in Desktop Studio only.',
    backupButton: 'Back up saved chats',
    cancelButton: 'Cancel',
    verifyButton: 'Verify backup',
    refreshButton: 'Refresh list',
    running: 'Backing up',
    preparing: 'Preparing the backup…',
    finalizing: 'Verifying and publishing the backup set…',
    complete: 'Backup complete',
    incomplete: 'Backup INCOMPLETE',
    failed: 'Backup failed',
    cancelled: 'Backup cancelled — nothing was published.',
    nothingToBackUp: 'Nothing to back up — no eligible saved chats were found.',
    runtimeError: 'Backup stopped because the Desktop backup service returned an unexpected error.',
    cleanupWarning: 'The previous backup session may remain busy until it is released automatically.',
    durabilityWarning: 'The backup was published, but its final durability fence did not complete. '
      + 'Verify the backup before relying on it.',
    listHeading: 'Backups',
    listEmpty: 'No backups found yet.',
    listUnavailable: 'The backups folder could not be read.',
    residue: 'stale staging folder(s)',
    residueExplanation: 'Stale staging folders are not backups. This version does not remove them automatically. '
      + 'Only remove them manually when no backup is active.',
    foreign: 'other entries in the backups folder (not backups)',
    verifyHeading: 'Verify result',
    kindComplete: 'Complete backup',
    kindPartial: 'Partial backup',
  };

  /* ── Helpers ──────────────────────────────────────────────────────────── */

  function safeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function asArray(value) { return Array.isArray(value) ? value : []; }
  function cleanString(value) { return typeof value === 'string' ? value.trim() : ''; }
  function isFiniteNumber(value) { return typeof value === 'number' && isFinite(value); }
  function nowIso() {
    try { return new Date().toISOString(); }
    catch (_) { return ''; }
  }
  function byteOrderCompare(a, b) {
    var x = String(a), y = String(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  function textEncoder() {
    if (typeof global.TextEncoder !== 'function') throw new Error('TextEncoder unavailable');
    return new global.TextEncoder();
  }
  function utf8Length(text) { return textEncoder().encode(String(text)).length; }

  /* Diagnostic text only: control characters removed, bounded to the native
   * cap on a UTF-8 boundary. Never a code, never a stage. */
  function boundedDetail(text) {
    var clean = String(text == null ? '' : text).replace(/[ -]+/g, ' ').trim();
    while (clean && utf8Length(clean) > FAILURE_DETAIL_MAX_BYTES) {
      clean = clean.slice(0, -1);
    }
    return clean;
  }

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  function getInvoke() {
    var internals = global.__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === 'function') return internals.invoke.bind(internals);
    var legacy = global.__TAURI__;
    if (legacy && legacy.core && typeof legacy.core.invoke === 'function') return legacy.core.invoke.bind(legacy.core);
    if (legacy && typeof legacy.invoke === 'function') return legacy.invoke.bind(legacy);
    return null;
  }

  function isRendererCode(code) { return RENDERER_FAILURE_CODES.indexOf(code) >= 0; }
  function isNativeCode(code) { return NATIVE_FAILURE_CODES.indexOf(code) >= 0; }
  function isReusedCode(code) { return REUSED_FAILURE_CODES.indexOf(code) >= 0; }
  function isAllowedFailureCode(code) {
    return isRendererCode(code) || isNativeCode(code) || isReusedCode(code);
  }
  function isAllowedStage(stage) { return FAILURE_STAGES.indexOf(stage) >= 0; }
  function classifyFailureCode(code) {
    return ERROR_CLASSES[cleanString(code)] || 'PROTOCOL_ERROR';
  }

  /* A per-entry failure record in the exact FINALIZE wire shape. The closed
   * vocabularies are enforced at construction: a renderer-generated code or a
   * stage outside them is a programming error, never a record. A NATIVE
   * status is preserved verbatim (contract §14: never aliased); the permanent
   * harness proves every emitted code stays inside the closed union. */
  function makeFailure(chatId, snapshotId, code, stage, detail, fromNative) {
    var c = cleanString(code);
    var s = cleanString(stage);
    if (!c) throw new Error('local backup: a failure record requires a code');
    if (!fromNative && !isAllowedFailureCode(c)) throw new Error('local backup: failure code outside the closed vocabulary: ' + c);
    if (!isAllowedStage(s)) throw new Error('local backup: failure stage outside the closed vocabulary: ' + s);
    return { chatId: cleanString(chatId), snapshotId: cleanString(snapshotId), code: c, stage: s, detail: boundedDetail(detail) };
  }

  /* The native status of a refused result, passed through verbatim. */
  function nativeStatus(result) {
    return cleanString(safeObject(result).status);
  }

  function runError(code, message) {
    var err = new Error(message || code);
    err.code = code;
    return err;
  }

  /* ── Store readiness and error snapshots (contract §4) ───────────────── */

  function storeNamespace(deps) {
    var explicit = safeObject(deps).stores;
    if (explicit) return explicit;
    return (H2O.Studio && H2O.Studio.store) || {};
  }

  function storeIsReady(store) {
    if (!store) return false;
    if (typeof store.isReady === 'function') {
      try { return store.isReady() === true; }
      catch (_) { return false; }
    }
    return true;
  }

  function errorCountOf(diagnostic) {
    return asArray(safeObject(diagnostic).errors).length;
  }

  /* chats/snapshots diagnose synchronously; tombstones.diagnose() is a
   * Promise and MUST be awaited (NB-01). */
  async function errorSnapshot(stores) {
    var chats = 0, snapshots = 0, tombstones = 0;
    try { if (typeof stores.chats.diagnose === 'function') chats = errorCountOf(stores.chats.diagnose()); }
    catch (_) { chats = Number.MAX_SAFE_INTEGER; }
    try { if (typeof stores.snapshots.diagnose === 'function') snapshots = errorCountOf(stores.snapshots.diagnose()); }
    catch (_) { snapshots = Number.MAX_SAFE_INTEGER; }
    try { if (typeof stores.tombstones.diagnose === 'function') tombstones = errorCountOf(await stores.tombstones.diagnose()); }
    catch (_) { tombstones = Number.MAX_SAFE_INTEGER; }
    return { chats: chats, snapshots: snapshots, tombstones: tombstones };
  }

  function errorsIncreased(before, after) {
    var a = safeObject(before), b = safeObject(after);
    return b.chats > a.chats || b.snapshots > a.snapshots || b.tombstones > a.tombstones;
  }

  /* ── Snapshot selection and source identity (contract §4, §5) ────────── */

  function numberOrZero(value) { return isFiniteNumber(value) ? value : 0; }

  /* Mirrors the package builder's own header sort (hydrateSnapshot): capturedAt
   * || updatedAt descending, snapshotId descending tie-break. The permanent
   * harness proves this selection equals what the builder selects for the
   * same chat. */
  function sortSnapshotHeadersDesc(a, b) {
    var av = numberOrZero(a && (a.capturedAt || a.updatedAt));
    var bv = numberOrZero(b && (b.capturedAt || b.updatedAt));
    if (av !== bv) return bv - av;
    return cleanString(b && (b.snapshotId || b.id)).localeCompare(cleanString(a && (a.snapshotId || a.id)));
  }

  function selectCurrentSnapshotHeader(headers) {
    var sorted = asArray(headers).slice().sort(sortSnapshotHeadersDesc);
    return sorted[0] || null;
  }

  function nullable(value) { return value === undefined ? null : value; }

  function identityFromRows(chatId, snapshotId, chat, snapshot, turns) {
    return {
      chatId: cleanString(chatId),
      snapshotId: cleanString(snapshotId),
      chatUpdatedAt: nullable(safeObject(chat).updatedAt),
      snapshotUpdatedAt: nullable(safeObject(snapshot).updatedAt),
      snapshotMessageCount: nullable(safeObject(snapshot).messageCount),
      snapshotDigest: nullable(safeObject(snapshot).digest),
      turnCount: asArray(turns).length,
    };
  }

  function sourceIdentityEquals(a, b) {
    var x = safeObject(a), y = safeObject(b);
    var keys = ['chatId', 'snapshotId', 'chatUpdatedAt', 'snapshotUpdatedAt', 'snapshotMessageCount', 'snapshotDigest', 'turnCount'];
    for (var i = 0; i < keys.length; i += 1) {
      if (nullable(x[keys[i]]) !== nullable(y[keys[i]])) return false;
    }
    return true;
  }

  /* Read-only re-read of the guarded facts. Distinguishes an absent row from
   * a read failure only through the caller's error snapshot (NB-08). */
  async function readSourceIdentity(stores, chatId, snapshotId) {
    var chat = null, combined = null;
    try { chat = await stores.chats.get(chatId); } catch (_) { chat = null; }
    if (!chat) return { chatMissing: true, snapshotMissing: false, identity: null };
    try { combined = await stores.snapshots.get(snapshotId); } catch (_) { combined = null; }
    if (!combined || !combined.snapshot) return { chatMissing: false, snapshotMissing: true, identity: null };
    return {
      chatMissing: false,
      snapshotMissing: false,
      identity: identityFromRows(chatId, snapshotId, chat, combined.snapshot, combined.turns),
    };
  }

  /* ── Enumeration (contract §4) ────────────────────────────────────────── */

  async function activeChatTombstoneExists(stores, chatId) {
    if (!stores.tombstones || typeof stores.tombstones.list !== 'function') return false;
    var rows = asArray(await stores.tombstones.list({ recordKind: 'chat', recordId: chatId, limit: 1000 }));
    for (var i = 0; i < rows.length; i += 1) {
      /* NULL and '' are both ACTIVE (NB-02): the Lane's restore module admits
       * `(restored_at IS NULL OR restored_at = '')`, and the list mapper may
       * surface either representation. Never the store's activeOnly filter. */
      if (rows[i] && (rows[i].restoredAt == null || cleanString(String(rows[i].restoredAt)) === '')) return true;
    }
    return false;
  }

  async function enumerateEligibleSavedChats(stores) {
    var before = await errorSnapshot(stores);
    var at = nowIso();
    var saved = asArray(await stores.chats.list({ filter: { isSaved: true } }));
    var linkedOnly = asArray(await stores.chats.list({ filter: { isLinked: true, isSaved: false } }));
    var rows = saved.slice().sort(function (a, b) {
      return byteOrderCompare(cleanString(a && a.chatId), cleanString(b && b.chatId));
    });
    var seen = {};
    var eligible = [];
    var skipped = { deleted: 0, tombstoned: 0, linkedOnly: linkedOnly.length, noSnapshot: 0 };
    for (var i = 0; i < rows.length; i += 1) {
      var chat = safeObject(rows[i]);
      var chatId = cleanString(chat.chatId);
      if (!chatId || seen[chatId]) {
        return { ok: false, code: 'backup-enumeration-inconsistent', at: at, enumeratedCount: rows.length, eligible: [], skipped: skipped };
      }
      seen[chatId] = true;
      if (chat.isDeleted === true) { skipped.deleted += 1; continue; }
      if (await activeChatTombstoneExists(stores, chatId)) { skipped.tombstoned += 1; continue; }
      var header = selectCurrentSnapshotHeader(await stores.snapshots.listByChat(chatId));
      var snapshotId = cleanString(header && (header.snapshotId || header.id));
      if (!snapshotId) { skipped.noSnapshot += 1; continue; }
      var combined = await stores.snapshots.get(snapshotId);
      if (!combined || !combined.snapshot) {
        /* Re-list once: the header may have vanished between list and get. */
        header = selectCurrentSnapshotHeader(await stores.snapshots.listByChat(chatId));
        snapshotId = cleanString(header && (header.snapshotId || header.id));
        combined = snapshotId ? await stores.snapshots.get(snapshotId) : null;
        if (!combined || !combined.snapshot) { skipped.noSnapshot += 1; continue; }
      }
      var turns = asArray(combined.turns);
      /* A zero-turn current snapshot is skipped, never substituted (NB-10). */
      if (turns.length === 0) { skipped.noSnapshot += 1; continue; }
      eligible.push({
        chatId: chatId,
        snapshotId: snapshotId,
        title: cleanString(chat.title),
        identity: identityFromRows(chatId, snapshotId, chat, combined.snapshot, turns),
      });
    }
    var after = await errorSnapshot(stores);
    if (errorsIncreased(before, after)) {
      return { ok: false, code: 'backup-enumeration-indeterminate', at: at, enumeratedCount: rows.length, eligible: [], skipped: skipped };
    }
    return { ok: true, code: '', at: at, enumeratedCount: rows.length, eligible: eligible, skipped: skipped, errorSnapshot: after };
  }

  /* ── Native member streaming (contract §9, §18) ───────────────────────── */

  /* One member, delivered as N bounded raw-body appends through the accepted
   * T02 command, following the publisher bridge's raw-body convention. */
  async function streamMember(invoke, token, member, bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
    var offset = 0;
    var ack = null;
    do {
      var end = Math.min(offset + CHUNK_BYTES, view.length);
      var isFinal = end >= view.length;
      var options = { token: token, member: member, final: isFinal };
      if (isFinal) options.byteLength = view.length;
      ack = await invoke(COMMANDS.writeMember, view.subarray(offset, end), {
        headers: { options: JSON.stringify(options) },
      });
      if (!ack || ack.ok !== true) {
        return { ok: false, status: nativeStatus(ack) || 'backup-write-failed', codes: asArray(safeObject(ack).codes) };
      }
      offset = end;
    } while (offset < view.length);
    return { ok: true, status: 'accepted', memberSha256: cleanString(safeObject(ack).memberSha256), memberBytes: view.length };
  }

  /* ── The Backup-private asset stack (contract §7) ─────────────────────── */

  /* Complete stack for the builder's injection seam: the REAL materializer,
   * a Backup-private CAS adapter that hashes with the real codec and streams
   * each unique asset into the open native package stage, and a no-op
   * registry. Nothing here reads or writes the source CAS or registry. */
  function createBackupAssetStack(params) {
    var p = safeObject(params);
    var ingestion = safeObject(p.ingestion);
    var codec = ingestion.savedChatPackageCodec;
    var realCas = ingestion.assetCas;
    var capBytes = realCas && isFiniteNumber(realCas.assetBlobCapBytes) ? realCas.assetBlobCapBytes : 0;
    var stream = typeof p.streamMember === 'function' ? p.streamMember : streamMember;
    var streamed = {};
    var puts = 0;
    var nativeFailure = null;
    var assetCas = {
      /* Republished so the materializer's whole-snapshot pre-scan bounds the
       * projection exactly as the writer's CAS would. */
      assetBlobCapBytes: capBytes,
      putCount: function () { return puts; },
      streamedShas: function () { return Object.keys(streamed).sort(); },
      putAssetBytes: async function (input) {
        var opts = safeObject(input);
        var bytes = opts.bytes;
        if (!(bytes instanceof Uint8Array)) throw new Error('backup putAssetBytes: bytes are required');
        if (capBytes && bytes.length > capBytes) {
          var bound = new Error('backup putAssetBytes: asset exceeds the governed ingest bound: ' + bytes.length + ' > ' + capBytes + ' bytes');
          bound.code = 'asset-bound-exceeded';
          throw bound;
        }
        if (!codec || typeof codec.sha256PrefixedBytes !== 'function') {
          throw new Error('backup putAssetBytes: savedChatPackageCodec.sha256PrefixedBytes unavailable');
        }
        puts += 1;
        var sha256 = await codec.sha256PrefixedBytes(bytes);
        var ext = cleanString(opts.ext);
        var mimeType = cleanString(opts.mimeType);
        var descriptor = { sha256: sha256, byteLength: bytes.length, mimeType: mimeType, ext: ext, deduped: false, wrote: false };
        /* The materializer calls once per inline OCCURRENCE; one member per sha
         * per stage, exactly as the real CAS dedupes. */
        if (streamed[sha256]) return Object.assign({}, descriptor, { deduped: true });
        var ack = await stream(p.invoke, p.token, { kind: 'asset', name: sha256 + '.' + ext }, bytes);
        if (!ack || ack.ok !== true) {
          nativeFailure = { code: cleanString(ack && ack.status) || 'backup-write-failed', codes: asArray(ack && ack.codes) };
          var failed = new Error('backup putAssetBytes: native member write refused: ' + nativeFailure.code);
          failed.code = 'backup-native-write-refused';
          throw failed;
        }
        streamed[sha256] = true;
        return descriptor;
      },
    };
    var assetStore = {
      mutationCount: function () { return 0; },
      upsert: async function () { return null; },
      linkToTurn: async function () { return null; },
    };
    return {
      materializer: ingestion.savedChatPackageAssets,
      assetCas: assetCas,
      assetStore: assetStore,
      nativeFailure: function () { return nativeFailure; },
    };
  }

  /* ── The run (contract §9, §12, §13) ──────────────────────────────────── */

  function appBuildStamp() {
    try {
      var runtime = global.chrome && global.chrome.runtime;
      var manifest = runtime && typeof runtime.getManifest === 'function' ? runtime.getManifest() : null;
      var version = cleanString(safeObject(manifest).version);
      return version || null;
    } catch (_) { return null; }
  }

  function memberBytesOf(built, fileName) {
    var file = safeObject(safeObject(built).files)[fileName];
    if (file && file.bytes instanceof Uint8Array) return file.bytes;
    if (file && typeof file.text === 'string') return textEncoder().encode(file.text);
    return null;
  }

  function finishResultFrom(status, code, message, extra) {
    return Object.assign({
      status: status,
      code: cleanString(code),
      errorClass: code ? classifyFailureCode(code) : '',
      message: message || '',
      backupId: '',
      backupLeaf: '',
      committed: false,
      durabilityComplete: false,
      fullFsync: false,
      complete: null,
      counts: null,
      codes: [],
      entries: [],
      failures: [],
      cancelled: false,
      runtimeError: false,
      cleanupUnconfirmed: false,
      diagnostic: '',
      chatTitles: {},
      native: null,
    }, safeObject(extra));
  }

  function runtimeFailureResult(error, extra) {
    var diagnostic = boundedDetail((error && error.message) || error || 'unexpected renderer or IPC failure');
    return finishResultFrom('failed', '', TEXT.runtimeError, Object.assign({
      runtimeError: true,
      diagnostic: diagnostic,
    }, safeObject(extra)));
  }

  /* Runs one manual backup end to end. `deps` may inject `invoke`, `stores`
   * and `ingestion` (the permanent harness does); production resolves the
   * real globals. `hooks.onProgress` / `hooks.isCancelled` are optional. */
  async function runLocalBackup(deps, hooks) {
    var d = safeObject(deps);
    var h = safeObject(hooks);
    var invoke = typeof d.invoke === 'function' ? d.invoke : getInvoke();
    if (!invoke) throw new Error('local backup: tauri invoke unavailable (Desktop Studio only)');
    var stores = storeNamespace(d);
    var ingestion = safeObject(d.ingestion || (H2O.Studio && H2O.Studio.ingestion));
    var build = ingestion.buildSavedChatPackageForLiveGenerationFamily;
    var readPolicy = ingestion.readSavedChatGenerationPolicy;
    var progress = typeof h.onProgress === 'function' ? h.onProgress : function () {};
    var isCancelled = typeof h.isCancelled === 'function' ? h.isCancelled : function () { return false; };

    if (!storeIsReady(stores.chats) || !storeIsReady(stores.snapshots) || !storeIsReady(stores.tombstones)) {
      return finishResultFrom('failed', 'store-not-ready', 'The saved-chat store is not ready.');
    }
    if (typeof build !== 'function' || typeof readPolicy !== 'function') {
      return finishResultFrom('failed', 'generation-policy-unavailable', 'The package projector is unavailable.');
    }
    var policyToken;
    try { policyToken = await readPolicy(); }
    catch (_) { return finishResultFrom('failed', 'generation-policy-unavailable', 'The generation policy could not be read.'); }

    /* 1–2. Enumerate and freeze; declaration before creation. */
    var enumeration = await enumerateEligibleSavedChats(stores);
    if (!enumeration.ok) {
      return finishResultFrom('failed', enumeration.code, 'The saved-chat set could not be enumerated reliably.', { counts: countsOf(enumeration, 0, 0) });
    }
    if (enumeration.eligible.length === 0) {
      /* A valid empty set is a neutral local outcome. There is no BEGIN, no
       * published object and no source/protocol failure. */
      return finishResultFrom('empty', '', TEXT.nothingToBackUp, { counts: countsOf(enumeration, 0, 0) });
    }
    if (isCancelled()) return finishResultFrom('failed', 'backup-cancelled', TEXT.cancelled, { cancelled: true });

    /* 4. BEGIN with the frozen declaration. */
    var begun = await invoke(COMMANDS.begin, { options: { enumeration: {
      at: enumeration.at,
      eligible: enumeration.eligible.map(function (e) { return { chatId: e.chatId, snapshotId: e.snapshotId }; }),
      skipped: enumeration.skipped,
      enumeratedCount: enumeration.enumeratedCount,
      source: { appBuildStamp: appBuildStamp() },
    } } });
    if (!begun || begun.ok !== true) {
      return finishResultFrom('failed', nativeStatus(begun) || 'backup-write-failed', 'The native backup session could not be opened.', { native: begun || null });
    }
    var token = cleanString(begun.token);
    var backupId = cleanString(begun.backupId);
    var entries = [];
    var failures = [];
    var total = enumeration.eligible.length;
    var chatTitles = {};
    enumeration.eligible.forEach(function (entry) {
      var title = cleanString(entry && entry.title);
      if (title) chatTitles[entry.chatId] = title;
    });
    var sessionOwned = true;

    function terminalSessionStatus(status) {
      return status === 'backup-cancelled' || status === 'backup-session-unknown' || status === 'backup-session-evicted';
    }

    /* Abort only the token this renderer obtained from BEGIN. The caller can
     * distinguish confirmed cleanup from a rejected/failed best-effort call,
     * while the original failure always remains primary. */
    async function abortOwnedSession() {
      if (!sessionOwned) return { attempted: false, confirmed: true };
      try {
        var response = await invoke(COMMANDS.abort, { options: { token: token } });
        var status = nativeStatus(response);
        var confirmed = !!(response && response.ok === true) || terminalSessionStatus(status);
        if (confirmed) sessionOwned = false;
        return { attempted: true, confirmed: confirmed, response: response || null };
      } catch (_) {
        return { attempted: true, confirmed: false, response: null };
      }
    }

    try {
      async function packageAbort(reason) {
        var aborted = await invoke(COMMANDS.packageAbort, { options: { token: token, reason: cleanString(reason) } });
        /* Benign when no package is open (NB-T02-03); a dead session is not. */
        if (aborted && aborted.ok === true) return null;
        var status = nativeStatus(aborted);
        /* A terminal or missing session cannot continue; anything else is a
         * benign no-op for a stage that is already gone. */
        if (status === 'backup-cancelled' || status === 'backup-session-unknown' || status === 'backup-session-evicted' || status === 'backup-invalid-state') return status;
        return null;
      }

      async function abortRun(code, message) {
        await abortOwnedSession();
        return finishResultFrom('failed', code, message, {
          backupId: backupId,
          cancelled: code === 'backup-cancelled',
          entries: entries,
          failures: failures,
          chatTitles: chatTitles,
        });
      }

    /* 5. One package per eligible chat, in the frozen deterministic order. */
    for (var i = 0; i < total; i += 1) {
      var entry = enumeration.eligible[i];
      if (isCancelled()) return abortRun('backup-cancelled', TEXT.cancelled);
      progress({ current: i + 1, total: total, chatId: entry.chatId });
      var identity = entry.identity;
      var rebuilds = 0;
      var failure = null;
      var published = null;
      var sessionDead = null;

      while (true) {
        /* b. open the stage BEFORE the projection (RC-T01-BACKUP-01). */
        var opened = await invoke(COMMANDS.packageBegin, { options: { token: token, chatId: entry.chatId, snapshotId: entry.snapshotId } });
        if (!opened || opened.ok !== true) {
          var openStatus = nativeStatus(opened) || 'backup-write-failed';
          if (openStatus === 'backup-cancelled' || openStatus === 'backup-session-unknown' || openStatus === 'backup-session-evicted') { sessionDead = openStatus; break; }
          /* e.g. backup-invalid-member-name for a Windows-reserved stem (NB-T02-07):
           * a per-entry failure; the run continues. */
          failure = makeFailure(entry.chatId, entry.snapshotId, openStatus, 'package-begin', 'package_begin refused', true);
          break;
        }

        /* c–d. the real builder ONCE, assets streamed during the build. */
        var stack = createBackupAssetStack({ invoke: invoke, token: token, ingestion: ingestion });
        var built = null;
        var buildFailure = null;
        var buildErrorSnapshot = await errorSnapshot(stores);
        try {
          built = await build({ chatId: entry.chatId, snapshotId: entry.snapshotId, assetStack: stack }, policyToken);
        } catch (err) {
          var native = stack.nativeFailure();
          var message = String((err && err.message) || err || '');
          if (native) buildFailure = makeFailure(entry.chatId, entry.snapshotId, native.code, 'write-member', 'asset member write refused', true);
          else if (err && err.code === 'asset-bound-exceeded') buildFailure = makeFailure(entry.chatId, entry.snapshotId, 'backup-projection-bound-exceeded', 'build', message);
          else if (/exceeds the governed ingest bound|governed snapshot cap/i.test(message)) buildFailure = makeFailure(entry.chatId, entry.snapshotId, 'backup-projection-bound-exceeded', 'build', message);
          else if (/snapshot not found|no snapshots found/i.test(message)) {
            /* The builder could not hydrate the frozen snapshot: apply the
             * guard's own classification (disappeared vs read failure, NB-08). */
            var vanished = await readSourceIdentity(stores, entry.chatId, entry.snapshotId);
            var vanishedAfter = await errorSnapshot(stores);
            var vanishedCode = errorsIncreased(buildErrorSnapshot, vanishedAfter)
              ? 'backup-source-read-failed'
              : (vanished.chatMissing ? 'backup-source-chat-disappeared'
                : (vanished.snapshotMissing ? 'backup-source-snapshot-disappeared' : 'backup-projection-failed'));
            buildFailure = makeFailure(entry.chatId, entry.snapshotId, vanishedCode, vanishedCode === 'backup-projection-failed' ? 'build' : 'guard', message);
          }
          else buildFailure = makeFailure(entry.chatId, entry.snapshotId, 'backup-projection-failed', 'build', message);
        }
        if (buildFailure) {
          /* k. the stage may be open or already discarded: abort before any
           * further package_begin (NB-T02-03, NB-VER-01). */
          sessionDead = await packageAbort(buildFailure.code);
          if (sessionDead) break;
          failure = buildFailure;
          break;
        }

        /* e–h. the source-change guard (contract §5, NB-08, NB-12). */
        var snapBefore = await errorSnapshot(stores);
        var reread = await readSourceIdentity(stores, entry.chatId, entry.snapshotId);
        var snapAfter = await errorSnapshot(stores);
        if (reread.chatMissing || reread.snapshotMissing) {
          var missingCode = errorsIncreased(snapBefore, snapAfter)
            ? 'backup-source-read-failed'
            : (reread.chatMissing ? 'backup-source-chat-disappeared' : 'backup-source-snapshot-disappeared');
          sessionDead = await packageAbort(missingCode);
          if (sessionDead) break;
          failure = makeFailure(entry.chatId, entry.snapshotId, missingCode, 'guard', 'source re-read after the build');
          break;
        }
        if (!sourceIdentityEquals(identity, reread.identity)) {
          sessionDead = await packageAbort('source-changed');
          if (sessionDead) break;
          rebuilds += 1;
          if (rebuilds > MAX_REBUILDS) {
            failure = makeFailure(entry.chatId, entry.snapshotId, 'backup-source-unstable', 'guard', 'source changed during two consecutive builds');
            break;
          }
          identity = reread.identity;
          continue; /* exactly ONE rebuild through a fresh package_begin */
        }

        /* i. application members from the builder's exact bytes. */
        var snapshotBytes = memberBytesOf(built, 'snapshot.json');
        var manifestBytes = memberBytesOf(built, 'manifest.json');
        if (!snapshotBytes || !manifestBytes) {
          sessionDead = await packageAbort('projection-incomplete');
          if (sessionDead) break;
          failure = makeFailure(entry.chatId, entry.snapshotId, 'backup-projection-failed', 'build', 'built package lacks snapshot.json or manifest.json bytes');
          break;
        }
        var wrote = await streamMember(invoke, token, { kind: 'snapshot' }, snapshotBytes);
        if (wrote.ok) wrote = await streamMember(invoke, token, { kind: 'manifest' }, manifestBytes);
        if (!wrote.ok) {
          if (wrote.status === 'backup-cancelled' || wrote.status === 'backup-session-unknown' || wrote.status === 'backup-session-evicted') { sessionDead = wrote.status; break; }
          sessionDead = await packageAbort(wrote.status);
          if (sessionDead) break;
          failure = makeFailure(entry.chatId, entry.snapshotId, wrote.status, 'write-member', 'member write refused', true);
          break;
        }

        /* j. bind the builder's contentHash at package_finish. */
        var finished = await invoke(COMMANDS.packageFinish, { options: { token: token, expectedContentHash: cleanString(built.contentHash) } });
        if (!finished || finished.ok !== true) {
          var finishStatus = nativeStatus(finished) || 'backup-package-verification-failed';
          if (finishStatus === 'backup-cancelled' || finishStatus === 'backup-session-unknown' || finishStatus === 'backup-session-evicted') { sessionDead = finishStatus; break; }
          sessionDead = await packageAbort(finishStatus);
          if (sessionDead) break;
          failure = makeFailure(entry.chatId, entry.snapshotId, finishStatus, 'package-finish', asArray(finished && finished.codes).join(','), true);
          break;
        }
        published = safeObject(finished.entry);
        break;
      }

      if (sessionDead) return abortRun(sessionDead, sessionDead === 'backup-cancelled' ? TEXT.cancelled : 'The native backup session ended.');
      if (failure) failures.push(failure);
      else if (published) entries.push(published);
    }

    if (isCancelled()) return abortRun('backup-cancelled', TEXT.cancelled);

    /* 6. FINALIZE with the exact failure records. */
    progress({ current: total, total: total, chatId: '', finalizing: true });
    var finalized = await invoke(COMMANDS.finalize, { options: { token: token, failures: failures } });
    /* Publication is the native commit point. From this instant the renderer
     * no longer owns an abortable staging session, even if later response/UI
     * handling encounters an unexpected problem. */
    if (finalized && finalized.committed === true) sessionOwned = false;
    var finalStatus = nativeStatus(finalized);
    var counts = safeObject(finalized && finalized.counts);
    if (!finalized || finalized.ok !== true || finalized.committed !== true) {
      /* Committed false never displays success; a FAILED native run has
       * already removed its own staging. */
      var failedCode = finalStatus || 'backup-promote-failed';
      if (failedCode === 'backup-cancelled') {
        sessionOwned = false;
        return finishResultFrom('failed', failedCode, TEXT.cancelled, { backupId: backupId, cancelled: true, entries: entries, failures: failures, chatTitles: chatTitles, native: finalized || null, codes: asArray(finalized && finalized.codes) });
      }
      /* A refusal that leaves the session live (e.g. an inconsistent
       * declaration) still needs its own staging removed. */
      if (finalized && finalized.committed !== true && finalStatus !== 'backup-session-unknown' && finalStatus !== 'backup-session-evicted') {
        await abortOwnedSession();
      } else if (terminalSessionStatus(finalStatus)) {
        sessionOwned = false;
      }
      return finishResultFrom('failed', failedCode, 'The backup set could not be published.', { backupId: backupId, entries: entries, failures: failures, chatTitles: chatTitles, native: finalized || null, codes: asArray(finalized && finalized.codes), counts: Object.keys(counts).length ? counts : countsOf(enumeration, entries.length, failures.length) });
    }
    var complete = finalized.complete === true && finalStatus === 'published';
    return finishResultFrom(complete ? 'complete' : 'incomplete', '', complete ? TEXT.complete : TEXT.incomplete, {
      backupId: cleanString(finalized.backupId) || backupId,
      backupLeaf: cleanString(finalized.backupLeaf),
      committed: true,
      durabilityComplete: finalized.durabilityComplete === true,
      fullFsync: finalized.fullFsync === true,
      complete: complete,
      counts: Object.keys(counts).length ? counts : countsOf(enumeration, entries.length, failures.length),
      codes: asArray(finalized.codes),
      entries: entries,
      failures: failures,
      chatTitles: chatTitles,
      native: finalized,
    });
    } catch (error) {
      var cleanup = await abortOwnedSession();
      return runtimeFailureResult(error, {
        backupId: backupId,
        entries: entries,
        failures: failures,
        chatTitles: chatTitles,
        counts: countsOf(enumeration, entries.length, failures.length),
        cleanupUnconfirmed: cleanup.attempted && !cleanup.confirmed,
      });
    }
  }

  function countsOf(enumeration, success, failed) {
    var e = safeObject(enumeration);
    return {
      enumerated: e.enumeratedCount || 0,
      eligible: asArray(e.eligible).length,
      success: success,
      failed: failed,
      skipped: safeObject(e.skipped),
    };
  }

  /* ── Read-only list / verify (contract §9, §15) ───────────────────────── */

  async function listBackups(invoke) {
    var fn = typeof invoke === 'function' ? invoke : getInvoke();
    if (!fn) return null;
    return safeObject(await fn(COMMANDS.list, {}));
  }

  async function verifyBackup(invoke, leaf) {
    var fn = typeof invoke === 'function' ? invoke : getInvoke();
    if (!fn) return null;
    return safeObject(await fn(COMMANDS.verify, { options: { leaf: cleanString(leaf) } }));
  }

  /* Rows of the governed list: only native-classified backups get a Verify
   * control. Residue and foreign entries are counted, never opened. */
  function formatListRows(listResult) {
    var list = safeObject(listResult);
    var rows = [];
    asArray(list.entries).forEach(function (entry) {
      var e = safeObject(entry);
      var kind = cleanString(e.kind);
      if (kind !== 'backup' && kind !== 'backup-partial') return;
      rows.push({
        leaf: cleanString(e.leaf),
        kind: kind,
        backupId: cleanString(e.backupId),
        label: kind === 'backup' ? TEXT.kindComplete : TEXT.kindPartial,
        manifestPresent: e.manifestPresent === true,
      });
    });
    var residueLeaves = asArray(list.entries).filter(function (entry) {
      return cleanString(safeObject(entry).kind) === 'staging-residue';
    }).map(function (entry) { return cleanString(safeObject(entry).leaf); }).filter(Boolean);
    var foreign = asArray(list.entries).filter(function (entry) { return cleanString(safeObject(entry).kind) === 'foreign'; }).length;
    return {
      ok: list.ok === true,
      status: cleanString(list.status),
      rootPresent: list.rootPresent === true,
      rootDisplayPath: cleanString(list.rootDisplayPath),
      rows: rows,
      residueCount: isFiniteNumber(list.residueCount) ? list.residueCount : 0,
      residueLeaves: residueLeaves,
      foreignCount: foreign,
    };
  }

  /* The native status/code pair, rendered faithfully (NB-T02-06). Only the
   * two valid-* statuses are ever presented as valid. */
  function formatVerifyResult(verifyResult) {
    var v = safeObject(verifyResult);
    var status = cleanString(v.status);
    var codes = asArray(v.codes).map(cleanString).filter(Boolean);
    var valid = status === 'valid-complete' || status === 'valid-incomplete';
    var headline;
    if (status === 'valid-complete') headline = 'Valid — complete backup';
    else if (status === 'valid-incomplete') headline = 'Valid — partial backup (some chats failed when it was made)';
    else if (status === 'malformed') headline = 'NOT valid — malformed backup';
    else if (status === 'unsupported') headline = 'NOT valid — unsupported';
    else if (status === 'unreadable') headline = 'NOT valid — unreadable';
    else headline = 'NOT valid — unknown verification status';
    return {
      status: status,
      valid: valid,
      headline: headline,
      codes: codes,
      classes: codes.map(classifyFailureCode),
      backupId: cleanString(v.backupId),
      entriesVerified: isFiniteNumber(v.entriesVerified) ? v.entriesVerified : 0,
      occupantsSeen: isFiniteNumber(v.occupantsSeen) ? v.occupantsSeen : 0,
    };
  }

  /* Run result → operator lines. Committed decides whether a backup exists;
   * durability and fullFsync are separate facts (NB-T02-08). */
  function formatRunResult(result) {
    var r = safeObject(result);
    var counts = safeObject(r.counts);
    var skipped = safeObject(counts.skipped);
    var deleted = numberOrZero(skipped.deleted);
    var tombstoned = numberOrZero(skipped.tombstoned);
    var noSnapshot = numberOrZero(skipped.noSnapshot);
    var linkedOnly = numberOrZero(skipped.linkedOnly);
    var savedSkipped = deleted + tombstoned + noSnapshot;
    var lines = [];
    if (r.runtimeError === true) {
      lines.push(TEXT.runtimeError);
    } else if (r.status === 'empty') {
      lines.push(TEXT.nothingToBackUp);
    } else if (r.status === 'complete') {
      lines.push(TEXT.complete + ' — ' + (counts.success || 0) + ' of ' + (counts.eligible || 0)
        + ' eligible chats backed up; ' + savedSkipped + ' saved chat' + (savedSkipped === 1 ? '' : 's') + ' skipped.');
    } else if (r.status === 'incomplete') {
      lines.push(TEXT.incomplete + ' — ' + (counts.success || 0) + ' of ' + (counts.eligible || 0)
        + ' eligible chats backed up; ' + (counts.failed || 0) + ' failed; ' + savedSkipped + ' saved chat'
        + (savedSkipped === 1 ? '' : 's') + ' skipped.');
    } else if (r.cancelled) {
      lines.push(TEXT.cancelled);
    } else if (r.code === 'backup-no-package-succeeded' && numberOrZero(counts.eligible) > 0) {
      lines.push(TEXT.failed + ' — 0 of ' + counts.eligible + ' eligible chats were backed up; '
        + (counts.failed || 0) + ' failed.');
    } else {
      lines.push(TEXT.failed + ' — ' + (r.code || 'unknown') + ' (' + (r.errorClass || classifyFailureCode(r.code)) + ').');
    }
    if (counts.skipped) {
      lines.push('Skipped saved chats: ' + savedSkipped + ' — ' + deleted + ' deleted, ' + tombstoned
        + ' tombstoned, ' + noSnapshot + ' with no snapshot or zero turns.');
      if (linkedOnly > 0) lines.push('Linked-only chats not eligible for saved-chat backup: ' + linkedOnly + '.');
    }
    if (r.backupLeaf) lines.push('Backup: ' + r.backupLeaf);
    if (r.committed === true && r.durabilityComplete !== true) lines.push(TEXT.durabilityWarning + (asArray(r.codes).length ? ' (' + asArray(r.codes).join(', ') + ')' : ''));
    if (r.runtimeError === true && r.cleanupUnconfirmed === true) lines.push(TEXT.cleanupWarning);
    asArray(r.failures).forEach(function (f) {
      var title = cleanString(safeObject(r.chatTitles)[f.chatId]);
      var identity = title ? title + ' (' + f.chatId + ')' : f.chatId;
      lines.push('Failed: ' + identity + ' — ' + f.code + ' (' + classifyFailureCode(f.code) + ', ' + f.stage + ')');
    });
    return { headline: lines[0] || '', lines: lines, tone: r.status === 'complete' ? 'success' : (r.status === 'empty' ? 'neutral' : 'warning') };
  }

  /* ── The card ─────────────────────────────────────────────────────────── */

  function el(tag, text, style) {
    var node = global.document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (style) node.setAttribute('style', style);
    return node;
  }

  /* One renderer operation for the module, independent of the current card
   * DOM. A remount replaces only `currentView`; the active promise, progress,
   * cancellation request and terminal result stay authoritative here. */
  var runController = {
    state: {
      status: 'idle',
      running: false,
      progress: null,
      cancelRequested: false,
      activePromise: null,
      runId: 0,
      result: null,
      list: null,
      verify: null,
    },
    currentView: null,
  };

  function notifyCurrentView() {
    var view = runController.currentView;
    if (!view || typeof view.render !== 'function') return;
    try { view.render(runController.state); } catch (_) { /* detached UI is never authoritative */ }
  }

  async function refreshControllerList(deps) {
    var wire = await listBackups(deps.invoke);
    runController.state.list = formatListRows(wire);
    notifyCurrentView();
    return runController.state.list;
  }

  async function verifyFromController(view, deps, leaf) {
    if (runController.currentView !== view) return null;
    var chosen = cleanString(leaf);
    if (!chosen) return null;
    var wire = await verifyBackup(deps.invoke, chosen);
    runController.state.verify = { leaf: chosen, result: formatVerifyResult(wire) };
    notifyCurrentView();
    return runController.state.verify;
  }

  function startControllerRun(view, deps) {
    var state = runController.state;
    if (state.activePromise) return state.activePromise;
    if (runController.currentView !== view) return Promise.resolve(state.result);

    state.running = true;
    state.status = 'running';
    state.progress = null;
    state.cancelRequested = false;
    state.result = null;
    state.verify = null;
    state.runId += 1;
    notifyCurrentView();

    var operation = (async function () {
      var outcome;
      try {
        outcome = await runLocalBackup(deps, {
          onProgress: function (progress) {
            state.progress = progress;
            notifyCurrentView();
          },
          isCancelled: function () { return state.cancelRequested; },
        });
      } catch (error) {
        /* Pre-BEGIN renderer failures have no native token to clean up. The
         * same runtime truth applies without misclassifying projection data. */
        outcome = runtimeFailureResult(error);
      }

      state.running = false;
      state.status = outcome.status;
      state.result = outcome;
      notifyCurrentView();

      /* Rendering or LIST failure after a committed result must never
       * reclassify that published terminal result. */
      try { await refreshControllerList(deps); } catch (_) { /* result stands */ }
      state.cancelRequested = false;
      state.activePromise = null;
      notifyCurrentView();
      return outcome;
    })();
    state.activePromise = operation;
    return operation;
  }

  function cancelControllerRun(view) {
    var state = runController.state;
    if (runController.currentView !== view || !state.running) return;
    state.cancelRequested = true;
    notifyCurrentView();
  }

  function mountLocalBackupCard(healthContainer, options) {
    if (!healthContainer || !global.document) return null;
    var container = healthContainer;
    var parent = healthContainer.parentNode;
    if (parent && typeof parent.appendChild === 'function') {
      var mount = (typeof parent.querySelector === 'function')
        ? parent.querySelector('[data-h2o-local-backup-mount="1"]') : null;
      if (!mount) {
        mount = global.document.createElement('div');
        mount.setAttribute('data-h2o-local-backup-mount', '1');
        mount.style.marginTop = '12px';
        parent.appendChild(mount);
      }
      /* Idempotent remount: one visible card; controller state survives. */
      mount.textContent = '';
      container = mount;
    }
    var opts = safeObject(options);
    var invoke = typeof opts.invoke === 'function' ? opts.invoke : getInvoke();
    var desktop = typeof opts.invoke === 'function' ? true : (detectTauri() && !!invoke);
    var deps = { invoke: invoke, stores: opts.stores, ingestion: opts.ingestion };

    var card = global.document.createElement('section');
    card.setAttribute('data-h2o-card', 'saved-chat-local-backup');
    card.appendChild(el('h3', TEXT.title));
    card.appendChild(el('div', TEXT.subtitle, 'opacity:0.85;margin-bottom:8px'));
    card.appendChild(el('div', TEXT.recoveryScope, 'opacity:0.85;margin-bottom:8px'));
    var backupButton = el('button', TEXT.backupButton);
    backupButton.setAttribute('type', 'button');
    backupButton.setAttribute('data-h2o-action', 'local-backup-run');
    var cancelButton = el('button', TEXT.cancelButton);
    cancelButton.setAttribute('type', 'button');
    cancelButton.setAttribute('data-h2o-action', 'local-backup-cancel');
    var status = el('div', TEXT.idle, 'margin-top:8px');
    status.setAttribute('data-h2o-local-backup-status', 'idle');
    var result = el('div', '', 'margin-top:6px');
    var listHeading = el('h4', TEXT.listHeading, 'margin-top:12px');
    var refreshButton = el('button', TEXT.refreshButton);
    refreshButton.setAttribute('type', 'button');
    refreshButton.setAttribute('data-h2o-action', 'local-backup-refresh');
    var listBody = el('div', '', 'margin-top:6px');
    var verifyBody = el('div', '', 'margin-top:6px');
    card.appendChild(backupButton);
    card.appendChild(cancelButton);
    card.appendChild(status);
    card.appendChild(result);
    card.appendChild(listHeading);
    card.appendChild(refreshButton);
    card.appendChild(listBody);
    card.appendChild(verifyBody);
    container.appendChild(card);

    if (!desktop) {
      status.textContent = TEXT.unavailable;
      status.setAttribute('data-h2o-local-backup-status', 'unavailable');
      backupButton.disabled = true;
      cancelButton.disabled = true;
      refreshButton.disabled = true;
      return {
        run: function () { return Promise.resolve(null); },
        cancel: function () {},
        refreshList: function () { return Promise.resolve(null); },
        verify: function () { return Promise.resolve(null); },
        getState: function () { return { status: 'unavailable' }; },
      };
    }

    var view = {
      render: function (state) {
        var statusText = TEXT.idle;
        if (state.running) {
          if (state.progress && state.progress.finalizing) statusText = TEXT.finalizing;
          else if (state.progress) statusText = TEXT.running + ' ' + state.progress.current + ' of ' + state.progress.total + '…';
          else statusText = TEXT.preparing;
        } else if (state.result) {
          statusText = formatRunResult(state.result).headline;
        }
        status.textContent = statusText;
        status.setAttribute('data-h2o-local-backup-status', state.running ? 'running' : state.status);
        backupButton.disabled = state.running;
        cancelButton.disabled = !state.running || state.cancelRequested;

        result.textContent = '';
        if (state.result) {
          var formattedRun = formatRunResult(state.result);
          formattedRun.lines.forEach(function (line, index) {
            var color = formattedRun.tone === 'success' ? 'color:#3fb950' : (formattedRun.tone === 'warning' ? 'color:#d29922' : '');
            result.appendChild(el('div', line, index === 0 ? color : ''));
          });
        }

        listBody.textContent = '';
        var formatted = state.list;
        if (formatted) {
          if (!formatted.ok) {
            listBody.appendChild(el('div', formatted.status === 'backup-root-absent' ? TEXT.listEmpty : (TEXT.listUnavailable + ' (' + formatted.status + ')')));
          } else {
            if (formatted.rootDisplayPath) listBody.appendChild(el('div', 'Folder: ' + formatted.rootDisplayPath, 'opacity:0.85'));
            if (!formatted.rows.length) listBody.appendChild(el('div', TEXT.listEmpty));
            formatted.rows.forEach(function (row) {
              var line = el('div', '', 'margin-top:4px');
              line.setAttribute('data-h2o-local-backup-row', row.leaf);
              line.appendChild(el('span', row.label + ' — ' + row.leaf + ' '));
              var button = el('button', TEXT.verifyButton);
              button.setAttribute('type', 'button');
              button.setAttribute('data-h2o-action', 'local-backup-verify');
              button.setAttribute('data-h2o-leaf', row.leaf);
              button.addEventListener('click', function () { verifyFromController(view, deps, row.leaf); });
              line.appendChild(button);
              listBody.appendChild(line);
            });
            if (formatted.residueCount > 0) {
              var residueNames = asArray(formatted.residueLeaves);
              listBody.appendChild(el('div', formatted.residueCount + ' ' + TEXT.residue
                + (residueNames.length ? ': ' + residueNames.join(', ') : '') + '.', 'color:#d29922'));
              listBody.appendChild(el('div', TEXT.residueExplanation, 'color:#d29922'));
            }
            if (formatted.foreignCount > 0) listBody.appendChild(el('div', formatted.foreignCount + ' ' + TEXT.foreign, 'opacity:0.85'));
          }
        }

        verifyBody.textContent = '';
        if (state.verify) {
          var verification = state.verify.result;
          verifyBody.appendChild(el('div', TEXT.verifyHeading + ' — ' + state.verify.leaf));
          verifyBody.appendChild(el('div', verification.headline, verification.valid ? 'color:#3fb950' : 'color:#f85149'));
          verifyBody.appendChild(el('div', 'status: ' + verification.status + (verification.codes.length ? ' · codes: ' + verification.codes.join(', ') : '')));
          if (verification.valid) verifyBody.appendChild(el('div', verification.entriesVerified + ' package(s) verified.'));
        }
      },
    };

    runController.currentView = view;
    notifyCurrentView();

    function run() { return startControllerRun(view, deps); }
    function cancel() { cancelControllerRun(view); }
    function refreshList() {
      if (runController.currentView !== view) return Promise.resolve(runController.state.list);
      return refreshControllerList(deps);
    }
    function verify(leaf) { return verifyFromController(view, deps, leaf); }

    backupButton.addEventListener('click', function () { run(); });
    cancelButton.addEventListener('click', function () { cancel(); });
    refreshButton.addEventListener('click', function () { refreshList(); });
    /* NO run on mount, no timer, no interval, no polling. */
    return {
      run: run,
      cancel: cancel,
      refreshList: refreshList,
      verify: verify,
      getState: function () { return runController.state; },
    };
  }

  H2O.Studio.localBackupUi = {
    __installed: true,
    __version: MODULE_VERSION,
    COMMANDS: COMMANDS,
    CHUNK_BYTES: CHUNK_BYTES,
    MAX_REBUILDS: MAX_REBUILDS,
    RENDERER_FAILURE_CODES: RENDERER_FAILURE_CODES,
    REUSED_FAILURE_CODES: REUSED_FAILURE_CODES,
    NATIVE_FAILURE_CODES: NATIVE_FAILURE_CODES,
    FAILURE_STAGES: FAILURE_STAGES,
    ERROR_CLASSES: ERROR_CLASSES,
    mountLocalBackupCard: mountLocalBackupCard,
    runLocalBackup: runLocalBackup,
    enumerateEligibleSavedChats: enumerateEligibleSavedChats,
    selectCurrentSnapshotHeader: selectCurrentSnapshotHeader,
    readSourceIdentity: readSourceIdentity,
    sourceIdentityEquals: sourceIdentityEquals,
    createBackupAssetStack: createBackupAssetStack,
    streamMember: streamMember,
    listBackups: listBackups,
    verifyBackup: verifyBackup,
    formatListRows: formatListRows,
    formatVerifyResult: formatVerifyResult,
    formatRunResult: formatRunResult,
    classifyFailureCode: classifyFailureCode,
    isAllowedFailureCode: isAllowedFailureCode,
    isAllowedStage: isAllowedStage,
    makeFailure: makeFailure,
  };
})(typeof window !== 'undefined' ? window : globalThis);
