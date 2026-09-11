/*
 * Platform-neutral canonical saved-chat projection.
 *
 * This module is deliberately pure apart from injected store, relationship,
 * identity, and cryptographic authorities. It contains no platform detection,
 * persistence, transport, filesystem, or UI behavior.
 */

const OBJECT_DOMAIN = 'studio.chat.saved-state.v1';
const REVISION_SCHEMA = 'h2o.studio.syncRevision.v1';
const HEAD_SCHEMA = 'h2o.studio.syncHead.v1';
const PAYLOAD_SCHEMA = 'h2o.studio.fullBundle.v2';
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const MAX_ID_LENGTH = 512;

const RELATIONSHIP_KEYS = Object.freeze([
  'assets',
  'categories',
  'folders',
  'labels',
  'organizations',
  'projects',
  'tags'
]);

export const LOCAL_PUBLICATION_PROJECTION_ERROR = Object.freeze({
  CANONICAL_JSON_UNSUPPORTED: 'local-publication-canonical-json-unsupported',
  CRYPTO_UNAVAILABLE: 'local-publication-crypto-unavailable',
  HISTORICAL_SOURCE_MISMATCH: 'local-publication-historical-source-mismatch',
  HISTORICAL_TIMESTAMP_UNAVAILABLE: 'local-publication-historical-timestamp-unavailable',
  /* The canonical capacity verdict from frozen H.2, spelled here rather than
   * imported: adding sync-evidence-capacity-v2 to this module's graph would
   * pull a new dependency into every consumer that stages the projection core.
   * Assurance asserts this equals P02_CAPACITY_VERDICT.BLOCKED, so the two
   * cannot drift without a RED. */
  PAYLOAD_CAPACITY_BLOCKED: 'local-publication-blocked(capacity)',
  RELATIONSHIP_PROOF_UNAVAILABLE: 'local-publication-relationship-proof-unavailable',
  STORE_UNAVAILABLE: 'local-publication-store-unavailable',
  UNSUPPORTED_OBJECT_SHAPE: 'local-publication-unsupported-object-shape',
  WRITER_IDENTITY_UNAVAILABLE: 'local-publication-writer-identity-unavailable'
});

export class LocalPublicationProjectionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalPublicationProjectionError';
    this.code = code;
  }
}

function fail(code) {
  throw new LocalPublicationProjectionError(code);
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
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

function normalizeCanonical(value, inArray) {
  if (value === undefined) {
    if (inArray) fail(LOCAL_PUBLICATION_PROJECTION_ERROR.CANONICAL_JSON_UNSUPPORTED);
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.CANONICAL_JSON_UNSUPPORTED);
    }
    return value;
  }
  if (typeof value === 'bigint' ||
      typeof value === 'function' ||
      typeof value === 'symbol') {
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.CANONICAL_JSON_UNSUPPORTED);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCanonical(item, true));
  }
  if (!isPlainObject(value)) {
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.CANONICAL_JSON_UNSUPPORTED);
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeCanonical(value[key], false);
    if (normalized !== undefined) output[key] = normalized;
  }
  return output;
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeCanonical(value, false));
}

function hasUnsupportedRelationshipKey(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const forbidden = /^(assets?|attachments?|externalAssets?|folder(Id|Ids|Bindings?)?|labels?|labelIds?|tags?|tagIds?|category(Id|Relationship)?|categories|project(Id|Ids|Relationship)?|projects|organization(State|Id|Ids|Relationship)?|organizations|org(Id|State)?)$/i;
  return Object.keys(value).some((key) => {
    const item = value[key];
    if (forbidden.test(key)) {
      if (item == null || item === '' || item === false) return false;
      if (Array.isArray(item) && item.length === 0) return false;
      if (isPlainObject(item) && Object.keys(item).length === 0) return false;
      return true;
    }
    return hasUnsupportedRelationshipKey(item, seen);
  });
}

function normalizeTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) {
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
  }
  const seen = new Set();
  return turns.map((turn, index) => {
    if (!isPlainObject(turn)) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    const turnIdx = Number(own(turn, 'turnIdx') ? turn.turnIdx : index);
    const role = clean(turn.role);
    if (!Number.isInteger(turnIdx) || turnIdx < 0 || seen.has(turnIdx) || !role) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    seen.add(turnIdx);
    const text = typeof turn.text === 'string' ? turn.text : '';
    const outerHtml = typeof turn.outerHtml === 'string'
      ? turn.outerHtml
      : typeof turn.outerHTML === 'string'
        ? turn.outerHTML
        : '';
    const meta = isPlainObject(turn.meta) ? turn.meta : {};
    if ((!text && !outerHtml) || hasUnsupportedRelationshipKey(meta)) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    return { turnIdx, role, text, outerHtml, meta };
  }).sort((left, right) => left.turnIdx - right.turnIdx);
}

function snapshotTimestamp(snapshot, chat, historical) {
  /*
   * capturedAt FIRST (A1 §4c). This value is projected into the payload as the
   * snapshot's `createdAt`, and apply-side convergence compares that field
   * against the local snapshot's `capturedAt` - and only against capturedAt.
   * The Desktop snapshots table carries BOTH captured_at and updated_at, so
   * whenever they differ the projection wrote one value and convergence
   * demanded the other, and a perfectly converged object failed its own
   * convergence proof. Ordering capturedAt first makes the projection agree
   * with the comparison that is actually performed.
   *
   * Consequence, stated rather than hidden: any snapshot whose captured_at and
   * updated_at differ now projects to different bytes than before, so its
   * payload hash changes and it reads as dirty exactly once, converging at the
   * next publication. That is the correct behaviour - the previous bytes named
   * a timestamp convergence would never accept.
   */
  const candidates = [
    snapshot?.capturedAt,
    snapshot?.captured_at,
    snapshot?.updatedAt,
    snapshot?.updated_at,
    snapshot?.createdAt,
    snapshot?.created_at,
    ...(historical ? [] : [chat?.updatedAt, chat?.updated_at])
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return new Date(candidate).toISOString();
    }
    const value = clean(candidate);
    const milliseconds = Date.parse(value);
    if (value && Number.isFinite(milliseconds)) {
      return new Date(milliseconds).toISOString();
    }
  }
  fail(historical
    ? LOCAL_PUBLICATION_PROJECTION_ERROR.HISTORICAL_TIMESTAMP_UNAVAILABLE
    : LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
}

async function verifyRelationshipProof(relationshipProbe, chat, objectId, revisionId) {
  if (typeof relationshipProbe !== 'function') {
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.RELATIONSHIP_PROOF_UNAVAILABLE);
  }
  let proof;
  try {
    proof = await relationshipProbe({ chatId: objectId, snapshotId: revisionId });
  } catch (error) {
    if (error?.code === LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE) {
      throw error;
    }
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.RELATIONSHIP_PROOF_UNAVAILABLE);
  }
  if (!hasExactKeys(proof, RELATIONSHIP_KEYS)) {
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.RELATIONSHIP_PROOF_UNAVAILABLE);
  }
  /* N1 v1.2 (C14/D.2, ratified): C14 governs what leaves in the PAYLOAD, not
   * which chats may be projected. Relationship evidence - folders, labels,
   * tags, categories, organizations, projects, asset-registry rows - is
   * observed and then deliberately ignored for eligibility. A chat that is
   * filed, tagged or carries asset rows is an ordinary saved-chat object.
   *
   * The probe is still REQUIRED and still shape-checked: a probe that cannot
   * answer remains RELATIONSHIP_PROOF_UNAVAILABLE, because not knowing is not
   * the same as knowing there is nothing. Only the "must be empty" veto is
   * gone. Exclusion is enforced where it belongs, on the emitted payload, by
   * validateContentOnlyPayload - which is unchanged and still strict. */
  for (const key of RELATIONSHIP_KEYS) {
    if (!Array.isArray(proof[key])) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.RELATIONSHIP_PROOF_UNAVAILABLE);
    }
  }
}

export function validateContentOnlyPayload(payload, objectId, revisionId) {
  if (!hasExactKeys(payload, ['schema', 'chatArchive', 'chromeStorageLocal', 'libraryKv']) ||
      payload.schema !== PAYLOAD_SCHEMA ||
      !isPlainObject(payload.chromeStorageLocal) ||
      Object.keys(payload.chromeStorageLocal).length !== 0 ||
      !Array.isArray(payload.libraryKv) ||
      payload.libraryKv.length !== 0 ||
      hasUnsupportedRelationshipKey(payload)) {
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
  }
  const archive = payload.chatArchive;
  const chats = archive?.chats;
  const catalogs = archive?.catalogs;
  if (!hasExactKeys(archive, ['chats', 'catalogs']) ||
      !Array.isArray(chats) || chats.length !== 1 ||
      !hasExactKeys(catalogs, ['categories', 'labels', 'tags']) ||
      ['categories', 'labels', 'tags'].some((key) =>
        !Array.isArray(catalogs[key]) || catalogs[key].length !== 0)) {
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
  }
  const chat = chats[0];
  const chatIndex = chat?.chatIndex;
  if (!hasExactKeys(chat, ['chatId', 'title', 'chatIndex', 'snapshots']) ||
      clean(chat.chatId) !== objectId ||
      typeof chat.title !== 'string' ||
      !Array.isArray(chat.snapshots) || chat.snapshots.length !== 1 ||
      !hasExactKeys(chatIndex, [
        'title', 'lastSnapshotId', 'snapshotCount', 'messageCount',
        'state', 'organization'
      ]) ||
      clean(chatIndex.lastSnapshotId) !== revisionId ||
      chatIndex.snapshotCount !== 1 ||
      !hasExactKeys(chatIndex.state, ['isSaved', 'isLinked']) ||
      chatIndex.state.isSaved !== true ||
      chatIndex.state.isLinked !== true ||
      !isPlainObject(chatIndex.organization) ||
      Object.keys(chatIndex.organization).length !== 0) {
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
  }
  const snapshot = chat.snapshots[0];
  if (!hasExactKeys(snapshot, [
    'snapshotId', 'chatId', 'createdAt', 'messageCount', 'messages', 'meta'
  ]) ||
      clean(snapshot.snapshotId) !== revisionId ||
      clean(snapshot.chatId) !== objectId ||
      !Array.isArray(snapshot.messages) || snapshot.messages.length === 0 ||
      typeof snapshot.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.createdAt)) ||
      snapshot.messageCount !== snapshot.messages.length ||
      chatIndex.messageCount !== snapshot.messages.length ||
      !hasExactKeys(snapshot.meta, ['title', 'richTurns']) ||
      typeof snapshot.meta.title !== 'string' ||
      !Array.isArray(snapshot.meta.richTurns) ||
      snapshot.meta.richTurns.length !== snapshot.messages.length) {
    fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
  }
  const orders = new Set();
  snapshot.messages.forEach((message, index) => {
    const detail = snapshot.meta.richTurns[index];
    if (!hasExactKeys(message, ['order', 'role', 'text']) ||
        !Number.isInteger(message.order) || message.order < 0 ||
        orders.has(message.order) || !clean(message.role) ||
        typeof message.text !== 'string' ||
        !hasExactKeys(detail, ['turnIdx', 'role', 'outerHTML', 'meta']) ||
        detail.turnIdx !== message.order ||
        clean(detail.role) !== clean(message.role) ||
        typeof detail.outerHTML !== 'string' ||
        !isPlainObject(detail.meta) ||
        (!message.text && !detail.outerHTML) ||
        hasUnsupportedRelationshipKey(detail.meta)) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    orders.add(message.order);
  });
  return true;
}

export function createCanonicalSyncObjectProjectionCore({
  cryptoImplementation = globalThis.crypto
} = {}) {
  async function sha256HexBytes(bytes) {
    if (!cryptoImplementation?.subtle ||
        typeof cryptoImplementation.subtle.digest !== 'function') {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.CRYPTO_UNAVAILABLE);
    }
    try {
      const digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
      return Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
    } catch (_) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.CRYPTO_UNAVAILABLE);
    }
  }

  function sha256HexText(text) {
    return sha256HexBytes(new TextEncoder().encode(String(text)));
  }

  function objectKeyHex(objectId) {
    return sha256HexBytes(
      new TextEncoder().encode(`${OBJECT_DOMAIN}\u0000${objectId}`)
    );
  }

  async function project({
    objectId,
    requestedRevisionId = null,
    stores,
    relationshipProbe,
    writerSyncPeerId,
    previousRevisionId = null
  } = {}) {
    if (!isStrictIdentifier(objectId)) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    if (!isStrictIdentifier(writerSyncPeerId)) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.WRITER_IDENTITY_UNAVAILABLE);
    }
    if (previousRevisionId !== null && !isStrictIdentifier(previousRevisionId)) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    if (!stores?.chats || typeof stores.chats.get !== 'function' ||
        !stores?.snapshots || typeof stores.snapshots.get !== 'function' ||
        typeof stores.snapshots.listByChat !== 'function') {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.STORE_UNAVAILABLE);
    }
    const chat = await stores.chats.get(objectId);
    /* Relationship keys on the canonical INPUT record no longer disqualify it;
     * they are simply not carried into the payload. */
    if (!chat || clean(chat.id || chat.chatId) !== objectId) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    const headers = await stores.snapshots.listByChat(objectId);
    if (!Array.isArray(headers) || headers.length === 0) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    const historical = requestedRevisionId !== null;
    let revisionId = clean(requestedRevisionId);
    if (!revisionId) revisionId = clean(chat.lastSnapshotId || chat.last_snapshot_id);
    if (!revisionId && headers.length === 1) {
      revisionId = clean(headers[0]?.snapshotId || headers[0]?.id);
    }
    if (!isStrictIdentifier(revisionId)) {
      fail(historical
        ? LOCAL_PUBLICATION_PROJECTION_ERROR.HISTORICAL_SOURCE_MISMATCH
        : LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    const selected = headers.filter((row) =>
      clean(row?.snapshotId || row?.id) === revisionId);
    if (selected.length !== 1) {
      fail(historical
        ? LOCAL_PUBLICATION_PROJECTION_ERROR.HISTORICAL_SOURCE_MISMATCH
        : LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    const combined = await stores.snapshots.get(revisionId);
    const snapshot = combined?.snapshot || combined;
    if (!snapshot ||
        clean(snapshot.snapshotId || snapshot.id) !== revisionId ||
        clean(snapshot.chatId || snapshot.chat_id) !== objectId) {
      fail(historical
        ? LOCAL_PUBLICATION_PROJECTION_ERROR.HISTORICAL_SOURCE_MISMATCH
        : LOCAL_PUBLICATION_PROJECTION_ERROR.UNSUPPORTED_OBJECT_SHAPE);
    }
    const turns = normalizeTurns(combined?.turns || snapshot?.turns);
    await verifyRelationshipProof(
      relationshipProbe,
      chat,
      objectId,
      revisionId
    );
    const sourceUpdatedAtIso = snapshotTimestamp(snapshot, chat, historical);
    const title = historical
      ? clean(snapshot.title)
      : clean(snapshot.title || chat.title) || 'Synced chat';
    if (!title) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.HISTORICAL_SOURCE_MISMATCH);
    }
    const payload = {
      schema: PAYLOAD_SCHEMA,
      chatArchive: {
        chats: [{
          chatId: objectId,
          title,
          chatIndex: {
            title,
            lastSnapshotId: revisionId,
            snapshotCount: 1,
            messageCount: turns.length,
            state: { isSaved: true, isLinked: true },
            organization: {}
          },
          snapshots: [{
            snapshotId: revisionId,
            chatId: objectId,
            createdAt: sourceUpdatedAtIso,
            messageCount: turns.length,
            messages: turns.map((turn) => ({
              order: turn.turnIdx,
              role: turn.role,
              text: turn.text
            })),
            meta: {
              title,
              richTurns: turns.map((turn) => ({
                turnIdx: turn.turnIdx,
                role: turn.role,
                outerHTML: turn.outerHtml,
                meta: turn.meta
              }))
            }
          }]
        }],
        catalogs: { categories: [], labels: [], tags: [] }
      },
      chromeStorageLocal: {},
      libraryKv: []
    };
    validateContentOnlyPayload(payload, objectId, revisionId);
    const payloadCanonicalText = canonicalJson(payload);
    const payloadCanonicalBytes = new TextEncoder().encode(payloadCanonicalText);
    /* An otherwise-valid chat that is simply too large is a CAPACITY refusal,
     * not an unsupported shape - frozen H.2 already defines blocked(capacity),
     * so the existing verdict is reused rather than a competing one invented.
     * MAX_PAYLOAD_BYTES itself is unchanged. */
    if (payloadCanonicalBytes.byteLength > MAX_PAYLOAD_BYTES) {
      fail(LOCAL_PUBLICATION_PROJECTION_ERROR.PAYLOAD_CAPACITY_BLOCKED);
    }
    const payloadSha256Hex = await sha256HexBytes(payloadCanonicalBytes);
    const objectKey = await objectKeyHex(objectId);
    const revision = {
      schema: REVISION_SCHEMA,
      objectId,
      objectKey,
      revisionId,
      payloadSha256: payloadSha256Hex,
      payload
    };
    const revisionCanonicalText = canonicalJson(revision);
    const revisionCanonicalBytes = new TextEncoder().encode(revisionCanonicalText);
    const revisionBlobSha256Hex = await sha256HexBytes(revisionCanonicalBytes);
    const head = {
      schema: HEAD_SCHEMA,
      objectId,
      objectKey,
      revisionId,
      payloadSha256: payloadSha256Hex,
      revisionBlobSha256: revisionBlobSha256Hex,
      writerSyncPeerId,
      previousRevisionId,
      sourceUpdatedAtIso
    };
    const headCanonicalText = canonicalJson(head);
    const headCanonicalBytes = new TextEncoder().encode(headCanonicalText);
    return Object.freeze({
      schema: REVISION_SCHEMA,
      headSchema: HEAD_SCHEMA,
      objectId,
      objectKeyHex: objectKey,
      revisionId,
      previousRevisionId,
      writerSyncPeerId,
      payload,
      payloadText: payloadCanonicalText,
      payloadCanonicalBytes,
      payloadSha256Hex,
      revision,
      revisionBlobText: revisionCanonicalText,
      revisionCanonicalBytes,
      revisionBlobSha256Hex,
      head,
      headCanonicalText,
      headCanonicalBytes,
      headSha256Hex: await sha256HexBytes(headCanonicalBytes),
      sourceUpdatedAtIso,
      turnIdentitySha256Hex: await sha256HexText(canonicalJson(turns))
    });
  }

  return Object.freeze({
    projectObject(input) {
      return project({ ...input, requestedRevisionId: null });
    },
    projectObjectRevision(input) {
      if (!isStrictIdentifier(input?.revisionId)) {
        fail(LOCAL_PUBLICATION_PROJECTION_ERROR.HISTORICAL_SOURCE_MISMATCH);
      }
      return project({
        ...input,
        requestedRevisionId: input.revisionId
      });
    },
    canonicalJson,
    objectKeyHex,
    sha256HexText,
    validateContentOnlyPayload
  });
}

export const CANONICAL_SYNC_OBJECT_PROJECTION_CONSTANTS = Object.freeze({
  OBJECT_DOMAIN,
  REVISION_SCHEMA,
  HEAD_SCHEMA,
  PAYLOAD_SCHEMA,
  MAX_PAYLOAD_BYTES,
  RELATIONSHIP_KEYS
});
