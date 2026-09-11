/* H2O Desktop Sync - F10.8.4 relay index and dedupe ledger
 *
 * Desktop/Tauri-only read index over durable relay outbox/inbox stores.
 *
 * Safety invariants:
 *   - Read-only derived ledger. No writes, no upload, no download, no apply,
 *     no convergence, no automatic review, no automatic merge, no timers,
 *     no networking, and no mobile write-back.
 *   - Uses existing outbox/inbox stores only. No new index storage key.
 *   - Dedupe/replay/stale/expired detection is diagnostic only.
 */
(function (global) {
  'use strict';

  function detectTauri() {
    try {
      if (typeof global.__TAURI_INTERNALS__ !== 'undefined') return true;
      if (typeof global.__TAURI__ !== 'undefined') return true;
    } catch (_) { /* ignore */ }
    return false;
  }
  if (!detectTauri()) return;

  var H2O = global.H2O = global.H2O || {};
  H2O.Desktop = H2O.Desktop || {};
  H2O.Desktop.Sync = H2O.Desktop.Sync || {};
  if (H2O.Desktop.Sync.__relayIndexInstalled) return;

  var INDEX_SCHEMA = 'h2o.desktop.sync.relay-index.v1';
  var OUTBOX_KEY = 'h2o:sync:relay-outbox:v1';
  var INBOX_KEY = 'h2o:sync:relay-inbox:v1';
  var OUTBOX_SCHEMA = 'h2o.desktop.sync.relay-outbox.v1';
  var INBOX_SCHEMA = 'h2o.desktop.sync.relay-inbox.v1';
  var VERSION = '0.1.0-f10.8.4';
  var DEFAULT_STALE_AFTER_DAYS = 30;

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function safeObject(value) {
    return isObject(value) ? value : {};
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function cleanString(value) {
    return String(value == null ? '' : value).trim();
  }

  function nowIsoSeconds() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  function isSha256Hex(value) {
    return /^[0-9a-f]{64}$/.test(cleanString(value));
  }

  function addCode(list, code) {
    var normalized = cleanString(code);
    if (!normalized || list.indexOf(normalized) !== -1) return;
    list.push(normalized);
  }

  function codeList(value) {
    return asArray(value).map(function (item) {
      return isObject(item) ? cleanString(item.code) : cleanString(item);
    }).filter(Boolean);
  }

  function validIso(value) {
    var text = cleanString(value);
    if (!text) return false;
    var ms = Date.parse(text);
    return Number.isFinite(ms);
  }

  function storageRef() {
    try {
      var s = global.chrome && global.chrome.storage && global.chrome.storage.local;
      if (s && typeof s.get === 'function') return s;
    } catch (_) { /* ignore */ }
    return null;
  }

  function storageGet(key) {
    return new Promise(function (resolve, reject) {
      var s = storageRef();
      if (!s) { reject(new Error('storage-unavailable')); return; }
      try {
        s.get([key], function (items) {
          var lastError = global.chrome && global.chrome.runtime && global.chrome.runtime.lastError;
          if (lastError) { reject(new Error(String(lastError.message || lastError))); return; }
          resolve(items && Object.prototype.hasOwnProperty.call(items, key) ? items[key] : null);
        });
      } catch (e) { reject(e); }
    });
  }

  function parseEnvelope(row) {
    try {
      var serialized = cleanString(row.serializedEnvelope);
      if (!serialized) return null;
      var parsed = JSON.parse(serialized);
      return isObject(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function peerIdFromRow(row) {
    var remoteObjectKey = cleanString(row.remoteObjectKey);
    var remoteMatch = /^relay\/([^/]+)\//.exec(remoteObjectKey);
    if (remoteMatch) return remoteMatch[1];
    var peer = safeObject(safeObject(row.sourcePlatform).sourcePeerEnvelope);
    return cleanString(peer.syncPeerIdHash || peer.installIdHash || peer.physicalDeviceIdHash);
  }

  function sourcePlatformSummary(row) {
    var source = safeObject(row.sourcePlatform);
    var peer = safeObject(source.sourcePeerEnvelope);
    return {
      platformId: cleanString(source.platformId),
      surfaceKind: cleanString(source.surfaceKind),
      sourcePeerEnvelope: {
        physicalDeviceIdHash: cleanString(peer.physicalDeviceIdHash),
        installIdHash: cleanString(peer.installIdHash),
        syncPeerIdHash: cleanString(peer.syncPeerIdHash),
        surfaceKind: cleanString(peer.surfaceKind)
      }
    };
  }

  /* M3 Activity & Audit needs a normal-user domain label, not raw envelope
   * payload. Derive one enum while the existing relay index already has the
   * validated envelope in memory, then discard the payload as before. */
  function activityFamily(envelope) {
    if (!envelope || cleanString(envelope.kind) !== 'applyEvent') return '';
    var operation = cleanString(envelope.operation).toLowerCase();
    var subjectType = cleanString(envelope.subjectType).toLowerCase();
    var signal = operation + ' ' + subjectType;
    if (/snapshot|archive|restore|receipt/.test(signal)) return 'snapshot-archive-receipt';
    if (/binding/.test(signal)) return 'convergence-binding';
    if (/delete|tombstone/.test(signal)) return 'delete';
    if (/move/.test(signal)) return 'move';
    if (/rename/.test(signal)) return 'rename';
    if (/color|metadata|folder/.test(signal)) return 'folder-metadata-color';
    if (/remote|preview/.test(signal)) return 'remote-apply-preview';
    return 'other-apply';
  }

  function expiredByEnvelope(envelope, nowMs) {
    if (!envelope || !validIso(envelope.expiresAt)) return false;
    return Date.parse(envelope.expiresAt) <= nowMs;
  }

  function staleByEnvelope(envelope, nowMs, staleAfterMs) {
    if (!envelope || !validIso(envelope.createdAt)) return false;
    return Date.parse(envelope.createdAt) + staleAfterMs < nowMs;
  }

  function validationFromOutbox(row) {
    return {
      ok: true,
      expired: false,
      blockers: [],
      warnings: []
    };
  }

  function validationFromInbox(row) {
    var summary = safeObject(row.validationSummary);
    return {
      ok: summary.ok === true,
      expired: summary.expired === true || cleanString(row.relayStatus) === 'expired',
      blockers: codeList(summary.blockers),
      warnings: codeList(summary.warnings)
    };
  }

  function outboxEntry(row, index, nowMs, staleAfterMs) {
    var envelope = parseEnvelope(row);
    var validation = validationFromOutbox(row);
    var stale = staleByEnvelope(envelope, nowMs, staleAfterMs);
    var expired = expiredByEnvelope(envelope, nowMs);
    if (stale) addCode(validation.warnings, 'stale-envelope');
    if (expired) {
      validation.expired = true;
      addCode(validation.warnings, 'envelope-expired');
    }
    return {
      indexId: 'outbox:' + cleanString(row.eventDigest || row.envelopeDigest || index),
      direction: 'outbox',
      sourceStore: OUTBOX_KEY,
      rowId: cleanString(row.rowId),
      envelopeDigest: cleanString(row.envelopeDigest),
      eventDigest: cleanString(row.eventDigest),
      dedupeKey: cleanString(row.dedupeKey),
      kind: cleanString(row.kind),
      activityFamily: activityFamily(envelope),
      relayStatus: cleanString(row.relayStatus),
      uploadTimestamp: cleanString(row.uploadedAtIso),
      downloadTimestamp: '',
      peerId: peerIdFromRow(row),
      sourcePlatform: sourcePlatformSummary(row),
      validation: validation,
      stale: stale,
      expired: expired || validation.expired,
      replayAttempt: false,
      duplicate: false
    };
  }

  function inboxEntry(row, index, nowMs, staleAfterMs) {
    var envelope = parseEnvelope(row);
    var validation = validationFromInbox(row);
    var stale = staleByEnvelope(envelope, nowMs, staleAfterMs);
    var expired = validation.expired || expiredByEnvelope(envelope, nowMs);
    if (stale) addCode(validation.warnings, 'stale-envelope');
    if (expired) addCode(validation.warnings, 'envelope-expired');
    return {
      indexId: 'inbox:' + cleanString(row.eventDigest || row.envelopeDigest || index),
      direction: 'inbox',
      sourceStore: INBOX_KEY,
      rowId: cleanString(row.rowId),
      envelopeDigest: cleanString(row.envelopeDigest),
      eventDigest: cleanString(row.eventDigest),
      dedupeKey: cleanString(row.dedupeKey),
      kind: cleanString(row.kind),
      activityFamily: activityFamily(envelope),
      relayStatus: cleanString(row.relayStatus),
      uploadTimestamp: '',
      downloadTimestamp: cleanString(row.receivedAtIso),
      peerId: peerIdFromRow(row),
      sourcePlatform: sourcePlatformSummary(row),
      validation: validation,
      stale: stale,
      expired: expired,
      replayAttempt: false,
      duplicate: false
    };
  }

  function addMapEntry(map, key, entry) {
    if (!key) return;
    if (!map[key]) map[key] = [];
    map[key].push(entry);
  }

  function markDuplicates(entries, keyName, code, duplicateEvents) {
    var byKey = {};
    for (var i = 0; i < entries.length; i += 1) addMapEntry(byKey, entries[i][keyName], entries[i]);
    var keys = Object.keys(byKey);
    for (var k = 0; k < keys.length; k += 1) {
      var group = byKey[keys[k]];
      if (group.length <= 1) continue;
      duplicateEvents.push({
        code: code,
        key: keys[k],
        count: group.length,
        indexIds: group.map(function (entry) { return entry.indexId; })
      });
      for (var g = 0; g < group.length; g += 1) {
        group[g].duplicate = true;
        addCode(group[g].validation.warnings, code);
      }
    }
  }

  function markReplay(entries, replayEvents) {
    var byDedupe = {};
    for (var i = 0; i < entries.length; i += 1) addMapEntry(byDedupe, entries[i].dedupeKey, entries[i]);
    var keys = Object.keys(byDedupe);
    for (var k = 0; k < keys.length; k += 1) {
      var group = byDedupe[keys[k]];
      if (group.length <= 1) continue;
      var eventDigests = {};
      for (var g = 0; g < group.length; g += 1) eventDigests[group[g].eventDigest] = true;
      if (Object.keys(eventDigests).length <= 1) continue;
      replayEvents.push({
        code: 'replay-dedupe-key',
        dedupeKey: keys[k],
        count: group.length,
        eventDigests: Object.keys(eventDigests),
        indexIds: group.map(function (entry) { return entry.indexId; })
      });
      for (var r = 0; r < group.length; r += 1) {
        group[r].replayAttempt = true;
        addCode(group[r].validation.warnings, 'replay-dedupe-key');
      }
    }
  }

  function countEntries(entries) {
    return {
      total: entries.length,
      outbox: entries.filter(function (entry) { return entry.direction === 'outbox'; }).length,
      inbox: entries.filter(function (entry) { return entry.direction === 'inbox'; }).length,
      pendingUpload: entries.filter(function (entry) { return entry.relayStatus === 'pending-upload'; }).length,
      uploaded: entries.filter(function (entry) { return entry.relayStatus === 'uploaded'; }).length,
      pendingReview: entries.filter(function (entry) { return entry.relayStatus === 'pending-review'; }).length,
      blocked: entries.filter(function (entry) { return entry.relayStatus === 'blocked'; }).length,
      expired: entries.filter(function (entry) { return entry.expired || entry.relayStatus === 'expired'; }).length,
      stale: entries.filter(function (entry) { return entry.stale; }).length,
      duplicates: entries.filter(function (entry) { return entry.duplicate; }).length,
      replayAttempts: entries.filter(function (entry) { return entry.replayAttempt; }).length
    };
  }

  async function readOutbox() {
    var raw = await storageGet(OUTBOX_KEY);
    if (!raw) return { ok: true, rows: [], warnings: ['outbox-missing'], blockers: [] };
    if (!isObject(raw) || raw.schema !== OUTBOX_SCHEMA || !Array.isArray(raw.rows)) {
      return { ok: false, rows: [], warnings: [], blockers: ['outbox-malformed'] };
    }
    return { ok: true, rows: raw.rows.slice(), warnings: [], blockers: [] };
  }

  async function readInbox() {
    var raw = await storageGet(INBOX_KEY);
    if (!raw) return { ok: true, rows: [], warnings: ['inbox-missing'], blockers: [] };
    if (!isObject(raw) || raw.schema !== INBOX_SCHEMA || !Array.isArray(raw.rows)) {
      return { ok: false, rows: [], warnings: [], blockers: ['inbox-malformed'] };
    }
    return { ok: true, rows: raw.rows.slice(), warnings: [], blockers: [] };
  }

  async function listRelayIndex(options) {
    var opts = safeObject(options);
    var staleDays = Number(opts.staleAfterDays);
    if (!Number.isFinite(staleDays) || staleDays <= 0) staleDays = DEFAULT_STALE_AFTER_DAYS;
    var nowIso = nowIsoSeconds();
    var nowMs = Date.parse(nowIso);
    var staleAfterMs = staleDays * 24 * 60 * 60 * 1000;
    var blockers = [];
    var warnings = [];
    var outbox;
    var inbox;
    try {
      outbox = await readOutbox();
      inbox = await readInbox();
    } catch (_) {
      return {
        schema: INDEX_SCHEMA,
        ok: false,
        generatedAtIso: nowIso,
        sourceStores: [OUTBOX_KEY, INBOX_KEY],
        entries: [],
        counts: countEntries([]),
        duplicates: [],
        replays: [],
        blockers: ['storage-unavailable'],
        warnings: []
      };
    }
    codeList(outbox.blockers).forEach(function (code) { addCode(blockers, code); });
    codeList(inbox.blockers).forEach(function (code) { addCode(blockers, code); });
    codeList(outbox.warnings).forEach(function (code) { addCode(warnings, code); });
    codeList(inbox.warnings).forEach(function (code) { addCode(warnings, code); });

    var entries = [];
    if (outbox.ok) {
      for (var o = 0; o < outbox.rows.length; o += 1) {
        entries.push(outboxEntry(safeObject(outbox.rows[o]), o, nowMs, staleAfterMs));
      }
    }
    if (inbox.ok) {
      for (var i = 0; i < inbox.rows.length; i += 1) {
        entries.push(inboxEntry(safeObject(inbox.rows[i]), i, nowMs, staleAfterMs));
      }
    }

    var duplicates = [];
    var replays = [];
    markDuplicates(entries, 'eventDigest', 'duplicate-eventDigest', duplicates);
    markDuplicates(entries, 'envelopeDigest', 'duplicate-envelopeDigest', duplicates);
    markReplay(entries, replays);

    return {
      schema: INDEX_SCHEMA,
      ok: blockers.length === 0,
      generatedAtIso: nowIso,
      staleAfterDays: staleDays,
      sourceStores: [OUTBOX_KEY, INBOX_KEY],
      entries: entries,
      counts: countEntries(entries),
      duplicates: duplicates,
      replays: replays,
      blockers: blockers,
      warnings: warnings
    };
  }

  H2O.Desktop.Sync.listRelayIndex = listRelayIndex;
  H2O.Desktop.Sync.__relayIndexInstalled = true;
  H2O.Desktop.Sync.__relayIndexVersion = VERSION;

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
