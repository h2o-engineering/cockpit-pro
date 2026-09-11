/*
 * Round 2 / Item 9-2 — offline validation and injected revision admission.
 *
 * CHROME/MV3 PLATFORM ADAPTER ONLY.
 *
 * Inputs are untrusted bytes. This module has no service-worker registration,
 * external message surface, transport capability, or native archive access.
 */

import { ITEM9_1_CONSTANTS } from './sync-object-store.mjs';
import {
  P02_ADMISSION_DISPOSITION,
  buildBranchIndex,
  classifyAdmission
} from '../../core/sync-branch-evidence-v2.mjs';

const REVISION_SCHEMA = 'h2o.studio.syncRevision.v1';
const HEAD_SCHEMA = 'h2o.studio.syncHead.v1';
const PAYLOAD_SCHEMA = 'h2o.studio.fullBundle.v2';
const OBJECT_DOMAIN = 'studio.chat.saved-state.v1';
const MAX_REVISION_BYTES = 5 * 1024 * 1024;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 512;

const REVISION_KEYS = Object.freeze([
  'objectId',
  'objectKey',
  'payload',
  'payloadSha256',
  'revisionId',
  'schema'
]);
const HEAD_KEYS = Object.freeze([
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

const ERROR_CODE = Object.freeze({
  HEAD_INVALID: 'round2-item9-head-invalid',
  REVISION_INVALID: 'round2-item9-revision-invalid',
  CANONICAL_BYTES_MISMATCH: 'round2-item9-canonical-bytes-mismatch',
  OBJECT_KEY_MISMATCH: 'round2-item9-object-key-mismatch',
  HEAD_REVISION_MISMATCH: 'round2-item9-head-revision-mismatch',
  REVISION_BLOB_HASH_MISMATCH: 'round2-item9-revision-blob-hash-mismatch',
  PAYLOAD_HASH_MISMATCH: 'round2-item9-payload-hash-mismatch',
  LINEAGE_MISSING: 'round2-item9-lineage-missing',
  LINEAGE_CONFLICT: 'round2-item9-lineage-conflict',
  ADMISSION_FAILED: 'round2-item9-admission-failed'
});

const SHA256_RE = /^[0-9a-f]{64}$/;

class Item9AdmissionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Item9AdmissionError';
    this.code = code;
  }
}

function fail(code) {
  throw new Item9AdmissionError(code);
}

function safeCode(error, fallback = ERROR_CODE.ADMISSION_FAILED) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  const allowed = [
    ...Object.values(ERROR_CODE),
    ...Object.values(ITEM9_1_CONSTANTS.ERROR_CODE)
  ];
  return allowed.includes(code) ? code : fallback;
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function hasExactKeys(value, expected) {
  return isPlainObject(value) &&
    Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
}

function isStrictIdentifier(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isAcceptedWriterIdentity(value) {
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

function exactBytes(value, failureCode) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) &&
      value.constructor &&
      value.constructor.name === 'Uint8Array') {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
  }
  fail(failureCode);
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function canonicalJson(value) {
  function normalize(item) {
    if (item === null ||
        typeof item === 'string' ||
        typeof item === 'boolean') {
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail(ERROR_CODE.REVISION_INVALID);
      return item;
    }
    if (Array.isArray(item)) return item.map(normalize);
    if (!isPlainObject(item)) fail(ERROR_CODE.REVISION_INVALID);
    const output = {};
    for (const key of Object.keys(item).sort()) {
      output[key] = normalize(item[key]);
    }
    return output;
  }
  return JSON.stringify(normalize(value));
}

function decodeCanonicalJson(bytes, maximumBytes, invalidCode) {
  const copied = exactBytes(bytes, invalidCode);
  if (copied.byteLength === 0 || copied.byteLength > maximumBytes) {
    fail(invalidCode);
  }
  let text;
  let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(copied);
    value = JSON.parse(text);
  } catch (_) {
    fail(invalidCode);
  }
  if (!isPlainObject(value)) fail(invalidCode);
  let canonical;
  try {
    canonical = canonicalJson(value);
  } catch (_) {
    fail(invalidCode);
  }
  const canonicalBytes = new TextEncoder().encode(canonical);
  if (!bytesEqual(copied, canonicalBytes)) {
    fail(ERROR_CODE.CANONICAL_BYTES_MISMATCH);
  }
  return { bytes: copied, text, value };
}

async function sha256Hex(cryptoImplementation, bytes) {
  if (!cryptoImplementation?.subtle ||
      typeof cryptoImplementation.subtle.digest !== 'function') {
    fail(ERROR_CODE.ADMISSION_FAILED);
  }
  try {
    const digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
    return Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
  } catch (_) {
    fail(ERROR_CODE.ADMISSION_FAILED);
  }
}

function hasUnsupportedContentKey(value) {
  if (!value || typeof value !== 'object') return false;
  const forbidden =
    /^(assets?|attachments?|externalAssets?|folder(Id|Ids|Bindings?)?|labels?|labelIds?|tags?|tagIds?|category(Id|Relationship)?|organization(State|Id)?|org(Id|State)?)$/i;
  return Object.keys(value).some((key) => {
    const item = value[key];
    if (forbidden.test(key)) {
      if (item == null || item === '' || item === false) return false;
      if (Array.isArray(item) && item.length === 0) return false;
      if (isPlainObject(item) && Object.keys(item).length === 0) return false;
      return true;
    }
    return hasUnsupportedContentKey(item);
  });
}

function validateContentOnlyPayload(payload, objectId, revisionId) {
  if (!hasExactKeys(
    payload,
    ['schema', 'chatArchive', 'chromeStorageLocal', 'libraryKv']
  ) ||
      payload.schema !== PAYLOAD_SCHEMA ||
      !isPlainObject(payload.chromeStorageLocal) ||
      Object.keys(payload.chromeStorageLocal).length !== 0 ||
      !Array.isArray(payload.libraryKv) ||
      payload.libraryKv.length !== 0 ||
      hasUnsupportedContentKey(payload.chromeStorageLocal) ||
      hasUnsupportedContentKey(payload.libraryKv)) {
    fail(ERROR_CODE.REVISION_INVALID);
  }

  const archive = payload.chatArchive;
  const chats = archive?.chats;
  const catalogs = archive?.catalogs;
  if (!hasExactKeys(archive, ['catalogs', 'chats']) ||
      !Array.isArray(chats) ||
      chats.length !== 1 ||
      !hasExactKeys(catalogs, ['categories', 'labels', 'tags']) ||
      ['categories', 'labels', 'tags'].some(
        (key) => !Array.isArray(catalogs[key]) || catalogs[key].length !== 0
      )) {
    fail(ERROR_CODE.REVISION_INVALID);
  }

  const chat = chats[0];
  const chatIndex = chat?.chatIndex;
  if (!hasExactKeys(chat, ['chatId', 'title', 'chatIndex', 'snapshots']) ||
      chat.chatId !== objectId ||
      typeof chat.title !== 'string' ||
      !Array.isArray(chat.snapshots) ||
      chat.snapshots.length !== 1 ||
      hasUnsupportedContentKey(chat) ||
      !hasExactKeys(chatIndex, [
        'lastSnapshotId',
        'messageCount',
        'organization',
        'snapshotCount',
        'state',
        'title'
      ]) ||
      chatIndex.lastSnapshotId !== revisionId ||
      chatIndex.snapshotCount !== 1 ||
      !Number.isSafeInteger(chatIndex.messageCount) ||
      !hasExactKeys(chatIndex.state, ['isLinked', 'isSaved']) ||
      chatIndex.state.isSaved !== true ||
      chatIndex.state.isLinked !== true ||
      !isPlainObject(chatIndex.organization) ||
      Object.keys(chatIndex.organization).length !== 0) {
    fail(ERROR_CODE.REVISION_INVALID);
  }

  const snapshot = chat.snapshots[0];
  if (!hasExactKeys(snapshot, [
    'chatId',
    'createdAt',
    'messageCount',
    'messages',
    'meta',
    'snapshotId'
  ]) ||
      snapshot.snapshotId !== revisionId ||
      snapshot.chatId !== objectId ||
      !Array.isArray(snapshot.messages) ||
      snapshot.messages.length === 0 ||
      hasUnsupportedContentKey(snapshot) ||
      typeof snapshot.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.createdAt)) ||
      snapshot.messageCount !== snapshot.messages.length ||
      chatIndex.messageCount !== snapshot.messages.length ||
      !hasExactKeys(snapshot.meta, ['richTurns', 'title']) ||
      typeof snapshot.meta.title !== 'string') {
    fail(ERROR_CODE.REVISION_INVALID);
  }

  const richTurns = snapshot.meta.richTurns;
  if (!Array.isArray(richTurns) ||
      richTurns.length !== snapshot.messages.length) {
    fail(ERROR_CODE.REVISION_INVALID);
  }
  const orders = new Set();
  snapshot.messages.forEach((message, index) => {
    const detail = richTurns[index];
    if (!hasExactKeys(message, ['order', 'role', 'text']) ||
        !Number.isInteger(message.order) ||
        message.order < 0 ||
        orders.has(message.order) ||
        typeof message.role !== 'string' ||
        message.role.trim().length === 0 ||
        typeof message.text !== 'string' ||
        !hasExactKeys(detail, ['meta', 'outerHTML', 'role', 'turnIdx']) ||
        detail.turnIdx !== message.order ||
        typeof detail.role !== 'string' ||
        detail.role.trim() !== message.role.trim() ||
        typeof detail.outerHTML !== 'string' ||
        !isPlainObject(detail.meta) ||
        (!message.text && !detail.outerHTML) ||
        hasUnsupportedContentKey(detail.meta)) {
      fail(ERROR_CODE.REVISION_INVALID);
    }
    orders.add(message.order);
  });
}

async function deriveObjectKey(cryptoImplementation, objectId) {
  const bytes = new TextEncoder().encode(`${OBJECT_DOMAIN}\u0000${objectId}`);
  return sha256Hex(cryptoImplementation, bytes);
}

async function validateInternal({
  headBytes,
  revisionBlobBytes,
  cryptoImplementation
}) {
  const decodedRevision = decodeCanonicalJson(
    revisionBlobBytes,
    MAX_REVISION_BYTES,
    ERROR_CODE.REVISION_INVALID
  );
  const revision = decodedRevision.value;
  if (!hasExactKeys(revision, REVISION_KEYS) ||
      revision.schema !== REVISION_SCHEMA ||
      !isStrictIdentifier(revision.objectId) ||
      !isStrictIdentifier(revision.revisionId) ||
      !SHA256_RE.test(revision.objectKey || '') ||
      !SHA256_RE.test(revision.payloadSha256 || '') ||
      !isPlainObject(revision.payload)) {
    fail(ERROR_CODE.REVISION_INVALID);
  }
  validateContentOnlyPayload(
    revision.payload,
    revision.objectId,
    revision.revisionId
  );

  const derivedObjectKey = await deriveObjectKey(
    cryptoImplementation,
    revision.objectId
  );
  if (derivedObjectKey !== revision.objectKey) {
    fail(ERROR_CODE.OBJECT_KEY_MISMATCH);
  }
  const payloadBytes = new TextEncoder().encode(canonicalJson(revision.payload));
  const payloadSha256Hex = await sha256Hex(cryptoImplementation, payloadBytes);
  if (payloadSha256Hex !== revision.payloadSha256) {
    fail(ERROR_CODE.PAYLOAD_HASH_MISMATCH);
  }
  const revisionBlobSha256Hex = await sha256Hex(
    cryptoImplementation,
    decodedRevision.bytes
  );

  const decodedHead = decodeCanonicalJson(
    headBytes,
    MAX_HEAD_BYTES,
    ERROR_CODE.HEAD_INVALID
  );
  const head = decodedHead.value;
  if (!hasExactKeys(head, HEAD_KEYS) ||
      head.schema !== HEAD_SCHEMA ||
      !isStrictIdentifier(head.objectId) ||
      !isStrictIdentifier(head.revisionId) ||
      !SHA256_RE.test(head.objectKey || '') ||
      !SHA256_RE.test(head.payloadSha256 || '') ||
      !SHA256_RE.test(head.revisionBlobSha256 || '') ||
      !isAcceptedWriterIdentity(head.writerSyncPeerId) ||
      (head.previousRevisionId !== null &&
        !isStrictIdentifier(head.previousRevisionId)) ||
      !isAcceptedTimestamp(head.sourceUpdatedAtIso)) {
    fail(ERROR_CODE.HEAD_INVALID);
  }
  const derivedHeadObjectKey = await deriveObjectKey(
    cryptoImplementation,
    head.objectId
  );
  if (derivedHeadObjectKey !== head.objectKey) {
    fail(ERROR_CODE.OBJECT_KEY_MISMATCH);
  }
  if (head.objectId !== revision.objectId ||
      head.objectKey !== revision.objectKey ||
      head.revisionId !== revision.revisionId ||
      head.payloadSha256 !== revision.payloadSha256) {
    fail(ERROR_CODE.HEAD_REVISION_MISMATCH);
  }
  if (head.revisionBlobSha256 !== revisionBlobSha256Hex) {
    fail(ERROR_CODE.REVISION_BLOB_HASH_MISMATCH);
  }

  return {
    head,
    revision,
    revisionBlobBytes: decodedRevision.bytes,
    revisionBlobSha256Hex,
    payloadSha256Hex,
    headSha256Hex: await sha256Hex(cryptoImplementation, decodedHead.bytes),
    revisionIdentitySha256Hex: await sha256Hex(
      cryptoImplementation,
      new TextEncoder().encode(revision.revisionId)
    )
  };
}

function safeValidationResult(verified) {
  return Object.freeze({
    ok: true,
    verdict: 'revision-validated',
    objectKeySha256Hex: verified.revision.objectKey,
    revisionIdentitySha256Hex: verified.revisionIdentitySha256Hex,
    revisionBlobSha256Hex: verified.revisionBlobSha256Hex,
    payloadSha256Hex: verified.payloadSha256Hex,
    headSha256Hex: verified.headSha256Hex,
    initialRevision: verified.head.previousRevisionId === null
  });
}

export async function validateInjectedHeadAndRevision({
  headBytes,
  revisionBlobBytes,
  cryptoImplementation = globalThis.crypto
} = {}) {
  try {
    const copiedHeadBytes = exactBytes(headBytes, ERROR_CODE.HEAD_INVALID);
    const copiedRevisionBlobBytes = exactBytes(
      revisionBlobBytes,
      ERROR_CODE.REVISION_INVALID
    );
    return safeValidationResult(await validateInternal({
      headBytes: copiedHeadBytes,
      revisionBlobBytes: copiedRevisionBlobBytes,
      cryptoImplementation
    }));
  } catch (error) {
    throw new Item9AdmissionError(safeCode(error));
  }
}

export async function revalidateStoredAdmissionEvidence({
  observation,
  evidence,
  cryptoImplementation = globalThis.crypto
} = {}) {
  try {
    if (!isPlainObject(observation) ||
        !isPlainObject(evidence) ||
        observation.observedState !== 'observed' ||
        observation.applyState !== 'not-applied' ||
        evidence.schema !== ITEM9_1_CONSTANTS.ADMISSION_EVIDENCE_SCHEMA ||
        evidence.schemaVersion !==
          ITEM9_1_CONSTANTS.ADMISSION_EVIDENCE_SCHEMA_VERSION ||
        evidence.key !== observation.key ||
        evidence.peerFingerprintSha256Hex !==
          observation.peerFingerprintSha256Hex ||
        !SHA256_RE.test(evidence.headSha256Hex || '')) {
      fail(ITEM9_1_CONSTANTS.ERROR_CODE.OBSERVATION_CONFLICT);
    }
    const objectIdentitySha256Hex = await sha256Hex(
      cryptoImplementation,
      new TextEncoder().encode(observation.objectId)
    );
    const revisionIdentitySha256Hex = await sha256Hex(
      cryptoImplementation,
      new TextEncoder().encode(observation.revisionId)
    );
    const expectedPeerObjectKey = [
      'v1',
      observation.peerFingerprintSha256Hex,
      objectIdentitySha256Hex
    ].join(':');
    const expectedObservationKey = [
      expectedPeerObjectKey,
      revisionIdentitySha256Hex
    ].join(':');
    if (observation.objectKeySha256Hex !== objectIdentitySha256Hex ||
        observation.revisionKeySha256Hex !== revisionIdentitySha256Hex ||
        observation.peerObjectKey !== expectedPeerObjectKey ||
        observation.key !== expectedObservationKey) {
      fail(ITEM9_1_CONSTANTS.ERROR_CODE.OBSERVATION_CONFLICT);
    }
    const headBytes = exactBytes(
      evidence.headBytes,
      ERROR_CODE.HEAD_INVALID
    );
    const revisionBlobBytes = exactBytes(
      observation.revisionBlobBytes,
      ERROR_CODE.REVISION_INVALID
    );
    const verified = await validateInternal({
      headBytes,
      revisionBlobBytes,
      cryptoImplementation
    });
    if (verified.headSha256Hex !== evidence.headSha256Hex ||
        verified.head.objectId !== observation.objectId ||
        verified.head.revisionId !== observation.revisionId ||
        verified.head.previousRevisionId !== observation.parentRevisionId ||
        verified.revisionBlobSha256Hex !==
          observation.revisionBlobSha256Hex ||
        verified.payloadSha256Hex !== observation.payloadSha256Hex) {
      fail(ITEM9_1_CONSTANTS.ERROR_CODE.OBSERVATION_CONFLICT);
    }
    return Object.freeze({
      ok: true,
      verdict: 'admission-evidence-revalidated',
      observationKey: observation.key,
      peerFingerprintSha256Hex: observation.peerFingerprintSha256Hex,
      objectId: verified.revision.objectId,
      objectKey: verified.revision.objectKey,
      revisionId: verified.revision.revisionId,
      parentRevisionId: verified.head.previousRevisionId,
      writerSyncPeerId: verified.head.writerSyncPeerId,
      revisionBlobSha256Hex: verified.revisionBlobSha256Hex,
      payloadSha256Hex: verified.payloadSha256Hex,
      headSha256Hex: verified.headSha256Hex,
      payload: verified.revision.payload
    });
  } catch (error) {
    throw new Item9AdmissionError(safeCode(error));
  }
}

export function createInjectedRevisionAdmission({
  observationStore,
  canonicalAnchorProvider = null,
  cryptoImplementation = globalThis.crypto
} = {}) {
  return Object.freeze({
    validateInjectedHeadAndRevision(input) {
      return validateInjectedHeadAndRevision({
        ...input,
        cryptoImplementation
      });
    },

    /*
     * P02 Wave 1 / Z6, frozen G.1/G.2/Y-8.
     *
     * The accepted linear path stays exactly as-is above: this is an ADDITIVE
     * entry point, so no accepted behaviour or accepted data changes until a
     * later governed unit wires it.
     *
     * It removes the P01 defect where a structurally valid sibling or an
     * unknown-parent revision could be terminally lost. Flow:
     *   validate bytes -> try accepted linear admission
     *   -> on lineage rejection, classify with the shared branch-evidence
     *      module and RETAIN the revision as immutable evidence
     *   -> never Apply-eligible, never deleted, survives restart.
     */
    async admitRevisionWithBranchRetention({
      headBytes,
      revisionBlobBytes,
      capacityAvailable = true
    } = {}) {
      try {
        const copiedHeadBytes = exactBytes(headBytes, ERROR_CODE.HEAD_INVALID);
        const copiedRevisionBlobBytes = exactBytes(
          revisionBlobBytes,
          ERROR_CODE.REVISION_INVALID
        );
        if (!observationStore ||
            typeof observationStore.recordBranchEvidence !== 'function' ||
            typeof observationStore.listBranchEvidence !== 'function') {
          fail(ERROR_CODE.ADMISSION_FAILED);
        }
        /* Integrity first: malformed bytes quarantine, they never retain. */
        const verified = await validateInternal({
          headBytes: copiedHeadBytes,
          revisionBlobBytes: copiedRevisionBlobBytes,
          cryptoImplementation
        });

        /* Preferred path is unchanged accepted linear admission. */
        try {
          const linear = await this.admitInjectedRevision({
            headBytes: copiedHeadBytes,
            revisionBlobBytes: copiedRevisionBlobBytes
          });
          return Object.freeze({
            ...linear,
            disposition: P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR,
            applyEligible: false,
            retained: true
          });
        } catch (error) {
          const code = safeCode(error);
          if (code !== ERROR_CODE.LINEAGE_CONFLICT &&
              code !== ERROR_CODE.LINEAGE_MISSING) {
            throw error;
          }
        }

        /*
         * Lineage rejection is where P01 lost the branch. Retain instead.
         * The disposition comes from the shared platform-neutral module, so
         * Desktop and Chrome derive identical graph facts, and no conflict
         * semantics are invented here.
         */
        const retained = await observationStore.listBranchEvidence(
          verified.revision.objectId
        );
        const observations = await observationStore.listObservationsForObject(
          verified.revision.objectId
        );
        /*
         * Accepted v1 observations carry the parent id but no parent hash.
         * Resolve it from the retained set where possible; anything still
         * unresolved stays unproven rather than being fabricated.
         */
        const hashByRevisionId = new Map();
        for (const observation of observations) {
          hashByRevisionId.set(
            observation.revisionId,
            observation.revisionBlobSha256Hex
          );
        }
        for (const record of retained) {
          hashByRevisionId.set(record.revisionId, record.revisionBlobSha256Hex);
        }
        const parentHashFor = (parentRevisionId, recorded) => {
          if (parentRevisionId === null || parentRevisionId === undefined) return null;
          return recorded ?? hashByRevisionId.get(parentRevisionId) ?? undefined;
        };
        const records = [
          ...observations.map((observation) => ({
            document: {
              objectDomain: OBJECT_DOMAIN,
              objectId: observation.objectId,
              revisionId: observation.revisionId,
              previousRevisionId: observation.parentRevisionId ?? null,
              previousRevisionBlobSha256: parentHashFor(
                observation.parentRevisionId ?? null,
                observation.parentRevisionBlobSha256Hex
              )
            },
            revisionBlobSha256: observation.revisionBlobSha256Hex,
            disposition: P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR
          })),
          ...retained.map((record) => ({
            document: {
              objectDomain: OBJECT_DOMAIN,
              objectId: record.objectId,
              revisionId: record.revisionId,
              previousRevisionId: record.parentRevisionId ?? null,
              previousRevisionBlobSha256: parentHashFor(
                record.parentRevisionId ?? null,
                record.parentRevisionBlobSha256Hex
              ),
              ...(record.closureType === null
                ? {}
                : { closureType: record.closureType })
            },
            revisionBlobSha256: record.revisionBlobSha256Hex,
            disposition: record.disposition
          }))
        ];
        const index = buildBranchIndex({
          objectDomain: OBJECT_DOMAIN,
          objectId: verified.revision.objectId,
          records,
          allowUnresolvedParentHash: true
        });
        const candidate = {
          document: {
            objectDomain: OBJECT_DOMAIN,
            objectId: verified.revision.objectId,
            revisionId: verified.revision.revisionId,
            previousRevisionId: verified.head.previousRevisionId ?? null,
            previousRevisionBlobSha256: parentHashFor(
              verified.head.previousRevisionId ?? null,
              verified.head.previousRevisionBlobSha256
            )
          },
          revisionBlobSha256: verified.revisionBlobSha256Hex
        };
        const verdict = classifyAdmission({
          index,
          candidate,
          capacityAvailable,
          allowUnresolvedParentHash: true
        });
        if (verdict.admitted === false) {
          /* Capacity refusal: nothing retained is touched, nothing deleted. */
          return Object.freeze({
            ok: false,
            verdict: 'blocked(capacity)',
            disposition: null,
            blockedReason: verdict.blockedReason,
            applyEligible: false,
            retained: false
          });
        }
        const stored = await observationStore.recordBranchEvidence({
          objectId: verified.revision.objectId,
          revisionId: verified.revision.revisionId,
          revisionBlobSha256Hex: verified.revisionBlobSha256Hex,
          revisionBlobBytes: copiedRevisionBlobBytes,
          parentRevisionId: verified.head.previousRevisionId ?? null,
          parentRevisionBlobSha256Hex:
            verified.head.previousRevisionBlobSha256 ?? null,
          disposition: verdict.disposition,
          reason: verdict.reason,
          closureType: verdict.closureType ?? null
        });
        return Object.freeze({
          ok: true,
          verdict: stored.verdict,
          disposition: verdict.disposition,
          reason: verdict.reason,
          /* Retaining bytes is never accepting them for Apply (G.5). */
          applyEligible: false,
          retained: true,
          unchangedNoOp: stored.unchangedNoOp,
          record: stored.record
        });
      } catch (error) {
        throw new Item9AdmissionError(safeCode(error));
      }
    },

    async admitInjectedRevision({ headBytes, revisionBlobBytes } = {}) {
      try {
        const copiedHeadBytes = exactBytes(headBytes, ERROR_CODE.HEAD_INVALID);
        const copiedRevisionBlobBytes = exactBytes(
          revisionBlobBytes,
          ERROR_CODE.REVISION_INVALID
        );
        if (!observationStore ||
            typeof observationStore.ensureReady !== 'function' ||
            typeof observationStore.recordLinearObservation !== 'function') {
          fail(ERROR_CODE.ADMISSION_FAILED);
        }
        const verified = await validateInternal({
          headBytes: copiedHeadBytes,
          revisionBlobBytes: copiedRevisionBlobBytes,
          cryptoImplementation
        });
        const canonicalAnchor = typeof canonicalAnchorProvider === 'function'
          ? await canonicalAnchorProvider(verified.revision.objectId)
          : null;
        if (canonicalAnchor !== null &&
            (!isPlainObject(canonicalAnchor) ||
              canonicalAnchor.objectId !== verified.revision.objectId ||
              !isStrictIdentifier(canonicalAnchor.revisionId) ||
              !SHA256_RE.test(canonicalAnchor.revisionBlobSha256Hex || '') ||
              !SHA256_RE.test(canonicalAnchor.payloadSha256Hex || ''))) {
          fail(ERROR_CODE.LINEAGE_MISSING);
        }
        const authority = await observationStore.ensureReady();
        const observationInput = {
          objectId: verified.revision.objectId,
          revisionId: verified.revision.revisionId,
          revisionBlobSha256Hex: verified.revisionBlobSha256Hex,
          payloadSha256Hex: verified.payloadSha256Hex,
          parentRevisionId: verified.head.previousRevisionId,
          revisionBlobBytes: verified.revisionBlobBytes,
          headSha256Hex: verified.headSha256Hex,
          headBytes: copiedHeadBytes
        };
        if (typeof canonicalAnchorProvider === 'function') {
          observationInput.canonicalAnchorRevisionId =
            canonicalAnchor?.revisionId || null;
        }
        const recorded = await observationStore.recordLinearObservation(
          observationInput
        );
        return Object.freeze({
          ok: true,
          verdict: recorded.verdict === 'identical-replay'
            ? 'identical-replay'
            : 'revision-admitted',
          unchangedNoOp: recorded.unchangedNoOp,
          peerFingerprintSha256Hex: authority.peerFingerprintSha256Hex,
          objectKeySha256Hex: recorded.observation.objectKeySha256Hex,
          revisionKeySha256Hex: recorded.observation.revisionKeySha256Hex,
          revisionBlobSha256Hex: recorded.observation.revisionBlobSha256Hex,
          payloadSha256Hex: recorded.observation.payloadSha256Hex,
          observedState: recorded.observation.observedState,
          applyState: recorded.observation.applyState
        });
      } catch (error) {
        throw new Item9AdmissionError(safeCode(error));
      }
    }
  });
}

export const ITEM9_2_CONSTANTS = Object.freeze({
  REVISION_SCHEMA,
  HEAD_SCHEMA,
  PAYLOAD_SCHEMA,
  OBJECT_DOMAIN,
  MAX_REVISION_BYTES,
  MAX_HEAD_BYTES,
  REVISION_KEYS,
  HEAD_KEYS,
  ERROR_CODE
});
