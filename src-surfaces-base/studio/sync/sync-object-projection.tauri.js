/* H2O Studio Round 2A — deterministic content-only saved-chat projection.
 *
 * Canonical JSON rule: object keys sort recursively; array order is retained;
 * undefined object properties are omitted; undefined array elements and all
 * functions/symbols/bigints/non-finite numbers are rejected. Output is UTF-8
 * JSON with no whitespace and no trailing newline.
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
  if (H2O.Desktop.SyncObjectProjection) return;

  var OBJECT_DOMAIN = 'studio.chat.saved-state.v1';
  var REVISION_SCHEMA = 'h2o.studio.syncRevision.v1';
  var PAYLOAD_SCHEMA = 'h2o.studio.fullBundle.v2';
  var MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
  var DB_URL = 'sqlite:studio-v1.db';
  var testDependencies = null;

  function fail(code) {
    var error = new Error(code);
    error.code = code;
    throw error;
  }

  function clean(value) { return String(value == null ? '' : value).trim(); }
  function own(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
  function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
  function hasExactKeys(value, keys) {
    return isObject(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');
  }

  function normalizeCanonical(value, inArray) {
    if (value === undefined) {
      if (inArray) fail('round2a-canonical-json-unsupported');
      return undefined;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('round2a-canonical-json-unsupported');
      return value;
    }
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
      fail('round2a-canonical-json-unsupported');
    }
    if (Array.isArray(value)) {
      return value.map(function (item) { return normalizeCanonical(item, true); });
    }
    if (!isObject(value) || Object.prototype.toString.call(value) !== '[object Object]') {
      fail('round2a-canonical-json-unsupported');
    }
    var output = {};
    Object.keys(value).sort().forEach(function (key) {
      var normalized = normalizeCanonical(value[key], false);
      if (normalized !== undefined) output[key] = normalized;
    });
    return output;
  }

  function canonicalJson(value) {
    return JSON.stringify(normalizeCanonical(value, false));
  }

  async function sha256HexBytes(bytes) {
    if (!global.crypto || !global.crypto.subtle) fail('round2a-crypto-unavailable');
    var digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  async function sha256HexText(text) {
    return sha256HexBytes(new TextEncoder().encode(String(text)));
  }

  async function objectKeyHex(objectId) {
    var prefix = new TextEncoder().encode(OBJECT_DOMAIN + '\u0000' + objectId);
    return sha256HexBytes(prefix);
  }

  function toIso(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return new Date(value).toISOString();
    }
    var text = clean(value);
    var millis = Date.parse(text);
    if (!text || !Number.isFinite(millis)) fail('round2a-unsupported-object-shape');
    return new Date(millis).toISOString();
  }

  function hasUnsupportedKey(value, seen) {
    if (!value || typeof value !== 'object') return false;
    seen = seen || new Set();
    if (seen.has(value)) return true;
    seen.add(value);
    var forbidden = /^(assets?|attachments?|externalAssets?|folder(Id|Ids|Bindings?)?|labels?|labelIds?|tags?|tagIds?|category(Id|Relationship)?|organization(State|Id)?|org(Id|State)?)$/i;
    return Object.keys(value).some(function (key) {
      var item = value[key];
      if (forbidden.test(key)) {
        if (item == null || item === '' || item === false) return false;
        if (Array.isArray(item) && item.length === 0) return false;
        if (isObject(item) && Object.keys(item).length === 0) return false;
        return true;
      }
      return hasUnsupportedKey(item, seen);
    });
  }

  function normalizeTurns(turns) {
    if (!Array.isArray(turns) || turns.length === 0) fail('round2a-unsupported-object-shape');
    var seen = new Set();
    return turns.map(function (turn, index) {
      if (!isObject(turn)) fail('round2a-unsupported-object-shape');
      var turnIdx = Number(own(turn, 'turnIdx') ? turn.turnIdx : index);
      var role = clean(turn.role);
      if (!Number.isInteger(turnIdx) || turnIdx < 0 || seen.has(turnIdx) || !role) {
        fail('round2a-unsupported-object-shape');
      }
      seen.add(turnIdx);
      var text = typeof turn.text === 'string' ? turn.text : '';
      var outerHtml = typeof turn.outerHtml === 'string' ? turn.outerHtml : '';
      if (!text && !outerHtml) fail('round2a-unsupported-object-shape');
      if (hasUnsupportedKey(turn.meta || {})) fail('round2a-unsupported-object-shape');
      return { turnIdx: turnIdx, role: role, text: text, outerHtml: outerHtml, meta: isObject(turn.meta) ? turn.meta : {} };
    }).sort(function (a, b) { return a.turnIdx - b.turnIdx; });
  }

  function getInvoke() {
    try {
      if (global.__TAURI_INTERNALS__ && typeof global.__TAURI_INTERNALS__.invoke === 'function') return global.__TAURI_INTERNALS__.invoke.bind(global.__TAURI_INTERNALS__);
      if (global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === 'function') return global.__TAURI__.core.invoke.bind(global.__TAURI__.core);
      if (global.__TAURI__ && typeof global.__TAURI__.invoke === 'function') return global.__TAURI__.invoke.bind(global.__TAURI__);
    } catch (_) { /* fail below */ }
    return null;
  }

  async function strictSqlRelationshipProbe(chatId, snapshotId) {
    var invoke = getInvoke();
    if (!invoke) fail('round2a-relationship-proof-unavailable');
    var queries = {
      assets: ['SELECT sha256 FROM snapshot_turn_assets WHERE snapshot_id = ? LIMIT 1', [snapshotId]],
      folders: ['SELECT folder_id FROM folder_bindings WHERE chat_id = ? LIMIT 1', [chatId]],
      labels: ['SELECT label_id FROM label_bindings WHERE chat_id = ? LIMIT 1', [chatId]],
      tags: ['SELECT tag_id FROM tag_bindings WHERE chat_id = ? LIMIT 1', [chatId]]
    /* N1 v1.2 (C14/D.2, ratified): these probes stay as DIAGNOSTICS. Rows in
     * folder_bindings, label_bindings, tag_bindings or snapshot_turn_assets,
     * and a category/organization/project on the chat row, no longer refuse a
     * chat - C14 governs the emitted payload, not eligibility. Exclusion is
     * still enforced downstream by the content-only payload validator, which
     * is unchanged, so Desktop emits exactly the payload Chrome does. */
    };
    var proof = {};
    for (var key of Object.keys(queries)) {
      try {
        proof[key] = await invoke('plugin:sql|select', {
          db: DB_URL,
          query: queries[key][0],
          values: queries[key][1]
        });
      } catch (_) {
        fail('round2a-relationship-proof-unavailable');
      }
    }
    return proof;
  }

  async function relationshipCheck(chat, chatId, snapshotId) {
    var probe = testDependencies && testDependencies.strictRelationshipProbe;
    var proof;
    try {
      proof = typeof probe === 'function'
        ? await probe({ chatId: chatId, snapshotId: snapshotId })
        : await strictSqlRelationshipProbe(chatId, snapshotId);
    } catch (error) {
      if (error && error.code === 'round2a-unsupported-object-shape') throw error;
      fail('round2a-relationship-proof-unavailable');
    }
    var keys = ['assets', 'folders', 'labels', 'tags'];
    if (!isObject(proof) || Object.keys(proof).sort().join(',') !== keys.slice().sort().join(',')) {
      fail('round2a-relationship-proof-unavailable');
    }
    for (var i = 0; i < keys.length; i += 1) {
      if (!Array.isArray(proof[keys[i]])) fail('round2a-relationship-proof-unavailable');
    }
  }

  function dependencies() {
    if (testDependencies) return testDependencies;
    return { stores: H2O.Studio && H2O.Studio.store };
  }

  async function projectObjectInternal(objectId, requestedRevisionId) {
    objectId = clean(objectId);
    if (!objectId || objectId.length > 512) fail('round2a-unsupported-object-shape');
    var deps = dependencies();
    var stores = deps && deps.stores || {};
    if (!stores.chats || typeof stores.chats.get !== 'function' ||
        !stores.snapshots || typeof stores.snapshots.listByChat !== 'function' || typeof stores.snapshots.get !== 'function') {
      fail('round2a-store-unavailable');
    }
    var chat = await stores.chats.get(objectId);
    /* Relationship keys on the canonical INPUT record no longer disqualify it,
     * exactly as in the platform-neutral core. */
    if (!chat || clean(chat.id || chat.chatId) !== objectId) {
      fail('round2a-unsupported-object-shape');
    }
    var headers = await stores.snapshots.listByChat(objectId);
    if (!Array.isArray(headers) || headers.length === 0) fail('round2a-unsupported-object-shape');
    var latestId = clean(requestedRevisionId);
    if (!latestId) latestId = clean(chat.lastSnapshotId || chat.last_snapshot_id);
    if (!latestId && headers.length === 1) latestId = clean(headers[0].snapshotId || headers[0].id);
    if (!latestId) fail('round2a-unsupported-object-shape');
    var selected = headers.filter(function (row) { return clean(row && (row.snapshotId || row.id)) === latestId; });
    if (selected.length !== 1) fail('round2a-unsupported-object-shape');
    var combined = await stores.snapshots.get(latestId);
    var snapshot = combined && (combined.snapshot || combined);
    var turns = normalizeTurns(combined && combined.turns || snapshot && snapshot.turns);
    if (!snapshot || clean(snapshot.snapshotId || snapshot.id) !== latestId || clean(snapshot.chatId || snapshot.chat_id) !== objectId) {
      fail('round2a-unsupported-object-shape');
    }
    await relationshipCheck(chat, objectId, latestId);
    var sourceUpdatedAtIso = toIso(
      snapshot.capturedAt || snapshot.captured_at ||
      snapshot.createdAt || snapshot.created_at ||
      snapshot.updatedAt || snapshot.updated_at ||
      chat.updatedAt || chat.updated_at
    );
    var title = clean(snapshot.title || chat.title) || 'Synced chat';
    var payload = {
      schema: PAYLOAD_SCHEMA,
      chatArchive: {
        chats: [{
          chatId: objectId,
          title: title,
          chatIndex: {
            title: title,
            lastSnapshotId: latestId,
            snapshotCount: 1,
            messageCount: turns.length,
            state: { isSaved: true, isLinked: true },
            organization: {}
          },
          snapshots: [{
            snapshotId: latestId,
            chatId: objectId,
            createdAt: sourceUpdatedAtIso,
            messageCount: turns.length,
            messages: turns.map(function (turn) {
              return { order: turn.turnIdx, role: turn.role, text: turn.text };
            }),
            meta: {
              title: title,
              richTurns: turns.map(function (turn) {
                return { turnIdx: turn.turnIdx, role: turn.role, outerHTML: turn.outerHtml, meta: turn.meta };
              })
            }
          }]
        }],
        catalogs: { categories: [], labels: [], tags: [] }
      },
      chromeStorageLocal: {},
      libraryKv: []
    };
    validateContentOnlyPayload(payload, objectId, latestId);
    var payloadText = canonicalJson(payload);
    /* Too large is a capacity refusal, not an unsupported shape. Same frozen
     * cap, same canonical verdict family as the platform-neutral core. */
    if (new TextEncoder().encode(payloadText).byteLength > MAX_PAYLOAD_BYTES) fail('round2a-blocked(capacity)');
    var payloadSha256Hex = await sha256HexText(payloadText);
    var key = await objectKeyHex(objectId);
    var envelope = {
      schema: REVISION_SCHEMA,
      objectId: objectId,
      objectKey: key,
      revisionId: latestId,
      payloadSha256: payloadSha256Hex,
      payload: payload
    };
    var revisionBlobText = canonicalJson(envelope);
    return {
      schema: REVISION_SCHEMA,
      objectId: objectId,
      objectKeyHex: key,
      revisionId: latestId,
      payload: payload,
      payloadText: payloadText,
      payloadSha256Hex: payloadSha256Hex,
      revisionBlobText: revisionBlobText,
      revisionBlobSha256Hex: await sha256HexText(revisionBlobText),
      sourceUpdatedAtIso: sourceUpdatedAtIso,
      turnIdentitySha256Hex: await sha256HexText(canonicalJson(turns))
    };
  }

  function projectObject(objectId) {
    return projectObjectInternal(objectId, null);
  }

  function projectObjectRevision(objectId, revisionId) {
    revisionId = clean(revisionId);
    if (!revisionId || revisionId.length > 512) fail('round2a-recovery-source-mismatch');
    return projectObjectInternal(objectId, revisionId).catch(function (error) {
      if (error && error.code === 'round2a-relationship-proof-unavailable') throw error;
      var mismatch = new Error('round2a-recovery-source-mismatch');
      mismatch.code = 'round2a-recovery-source-mismatch';
      throw mismatch;
    });
  }

  function validateContentOnlyPayload(payload, objectId, revisionId) {
    if (!hasExactKeys(payload, ['schema', 'chatArchive', 'chromeStorageLocal', 'libraryKv']) ||
        payload.schema !== PAYLOAD_SCHEMA || hasUnsupportedKey(payload.chromeStorageLocal) || hasUnsupportedKey(payload.libraryKv)) {
      fail('round2a-unsupported-object-shape');
    }
    if (Object.keys(payload.chromeStorageLocal || {}).length !== 0 || !Array.isArray(payload.libraryKv) || payload.libraryKv.length !== 0) {
      fail('round2a-unsupported-object-shape');
    }
    var archive = payload.chatArchive;
    var chats = archive && archive.chats;
    var catalogs = archive && archive.catalogs;
    if (!hasExactKeys(archive, ['chats', 'catalogs']) || !Array.isArray(chats) || chats.length !== 1 ||
        !hasExactKeys(catalogs, ['categories', 'labels', 'tags']) ||
        ['categories', 'labels', 'tags'].some(function (key) { return !Array.isArray(catalogs[key]) || catalogs[key].length !== 0; })) {
      fail('round2a-unsupported-object-shape');
    }
    var chat = chats[0];
    var chatIndex = chat && chat.chatIndex;
    if (!hasExactKeys(chat, ['chatId', 'title', 'chatIndex', 'snapshots']) || clean(chat.chatId) !== objectId ||
        typeof chat.title !== 'string' || !Array.isArray(chat.snapshots) || chat.snapshots.length !== 1 || hasUnsupportedKey(chat) ||
        !hasExactKeys(chatIndex, ['title', 'lastSnapshotId', 'snapshotCount', 'messageCount', 'state', 'organization']) ||
        clean(chatIndex.lastSnapshotId) !== revisionId || chatIndex.snapshotCount !== 1 ||
        !hasExactKeys(chatIndex.state, ['isSaved', 'isLinked']) || chatIndex.state.isSaved !== true || chatIndex.state.isLinked !== true ||
        !isObject(chatIndex.organization) || Object.keys(chatIndex.organization).length !== 0) {
      fail('round2a-unsupported-object-shape');
    }
    var snapshot = chat.snapshots[0];
    if (!hasExactKeys(snapshot, ['snapshotId', 'chatId', 'createdAt', 'messageCount', 'messages', 'meta']) ||
        clean(snapshot.snapshotId) !== revisionId || clean(snapshot.chatId) !== objectId ||
        !Array.isArray(snapshot.messages) || snapshot.messages.length === 0 || hasUnsupportedKey(snapshot) ||
        typeof snapshot.createdAt !== 'string' || !Number.isFinite(Date.parse(snapshot.createdAt)) ||
        snapshot.messageCount !== snapshot.messages.length || chatIndex.messageCount !== snapshot.messages.length ||
        !hasExactKeys(snapshot.meta, ['title', 'richTurns']) || typeof snapshot.meta.title !== 'string') {
      fail('round2a-unsupported-object-shape');
    }
    var rich = snapshot.meta && snapshot.meta.richTurns;
    if (!Array.isArray(rich) || rich.length !== snapshot.messages.length) fail('round2a-unsupported-object-shape');
    var orders = new Set();
    snapshot.messages.forEach(function (message, index) {
      var detail = rich[index];
      if (!hasExactKeys(message, ['order', 'role', 'text']) || !Number.isInteger(message.order) || message.order < 0 ||
          orders.has(message.order) || !clean(message.role) || typeof message.text !== 'string' ||
          !hasExactKeys(detail, ['turnIdx', 'role', 'outerHTML', 'meta']) || detail.turnIdx !== message.order ||
          clean(detail.role) !== clean(message.role) || typeof detail.outerHTML !== 'string' || !isObject(detail.meta) ||
          (!message.text && !detail.outerHTML) || hasUnsupportedKey(detail.meta)) {
        fail('round2a-unsupported-object-shape');
      }
      orders.add(message.order);
    });
    return true;
  }

  async function validateRevisionBlob(revisionBlobText, expected) {
    if (typeof revisionBlobText !== 'string' || new TextEncoder().encode(revisionBlobText).byteLength > MAX_PAYLOAD_BYTES) {
      fail('round2a-unsupported-object-shape');
    }
    var envelope;
    try { envelope = JSON.parse(revisionBlobText); } catch (_) { fail('round2a-revision-blob-invalid'); }
    if (canonicalJson(envelope) !== revisionBlobText || !isObject(envelope) || Object.keys(envelope).sort().join(',') !== 'objectId,objectKey,payload,payloadSha256,revisionId,schema') {
      fail('round2a-revision-blob-invalid');
    }
    if (envelope.schema !== REVISION_SCHEMA || clean(envelope.objectId) !== clean(expected.objectId) ||
        clean(envelope.objectKey) !== clean(expected.objectKeyHex) || clean(envelope.revisionId) !== clean(expected.revisionId)) {
      fail('unexpected-remote-object');
    }
    if (await objectKeyHex(envelope.objectId) !== envelope.objectKey) fail('round2a-object-key-mismatch');
    var payloadText = canonicalJson(envelope.payload);
    if (await sha256HexText(payloadText) !== envelope.payloadSha256 ||
        expected.payloadSha256Hex && expected.payloadSha256Hex !== envelope.payloadSha256 ||
        expected.revisionBlobSha256Hex && await sha256HexText(revisionBlobText) !== expected.revisionBlobSha256Hex) {
      fail('round2a-revision-blob-divergent');
    }
    validateContentOnlyPayload(envelope.payload, envelope.objectId, envelope.revisionId);
    return envelope;
  }

  H2O.Desktop.SyncObjectProjection = Object.freeze({
    schema: REVISION_SCHEMA,
    payloadSchema: PAYLOAD_SCHEMA,
    canonicalJson: canonicalJson,
    sha256HexText: sha256HexText,
    objectKeyHex: objectKeyHex,
    projectObject: projectObject,
    projectObjectRevision: projectObjectRevision,
    validateRevisionBlob: validateRevisionBlob,
    validateContentOnlyPayload: validateContentOnlyPayload,
    constants: Object.freeze({ MAX_PAYLOAD_BYTES: MAX_PAYLOAD_BYTES, OBJECT_DOMAIN: OBJECT_DOMAIN }),
    __test: Object.freeze({
      setDependencies: function (next) { testDependencies = next; },
      clearDependencies: function () { testDependencies = null; },
      normalizeTurns: normalizeTurns
    })
  });
})(typeof window !== 'undefined' ? window : globalThis);
