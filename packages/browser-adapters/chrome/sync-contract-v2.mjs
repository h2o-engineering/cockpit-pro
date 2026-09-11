/*
 * P02 Wave 1 / Z1 — transport-free v2 sync contract authority.
 *
 * This module is intentionally additive. It does not import or extend the
 * accepted P01 v1 admission models. Inputs are untrusted canonical JSON bytes;
 * every document is strict, version-tagged, and side-effect free.
 */

const SCHEMA = Object.freeze({
  REVISION: 'h2o.studio.syncRevision.v2',
  HEAD: 'h2o.studio.syncHead.v2',
  CLOSURE_PAYLOAD: 'h2o.studio.syncClosurePayload.v1',
  HEADS_SNAPSHOT: 'h2o.studio.syncHeadsSnapshot.v2',
  WRITER_STATE: 'h2o.studio.syncWriterState.v2',
  LIBRARY_INFO: 'h2o.studio.syncLibraryInfo.v1',
  LEGACY_BASELINE_RECEIPT: 'h2o.studio.syncLegacyBaselineReceipt.v1'
});

const LIMITS = Object.freeze({
  MAX_REVISION_BYTES: 5 * 1024 * 1024,
  MAX_PAYLOAD_BYTES: 5 * 1024 * 1024,
  MAX_HEAD_BYTES: 64 * 1024,
  MAX_HEADS_SNAPSHOT_BYTES: 5 * 1024 * 1024,
  MAX_POINTER_BYTES: 4 * 1024,
  MAX_LIBRARY_INFO_BYTES: 64 * 1024,
  MAX_RECEIPT_BYTES: 64 * 1024,
  MAX_ID_LENGTH: 512
});

const SUPPORTED = Object.freeze({
  formatVersion: 2,
  protocolVersion: 2,
  layoutEpoch: 1
});

const ERROR_CODE = Object.freeze({
  SCHEMA_INVALID: 'p02-z1-schema-invalid',
  CANONICAL_BYTES_MISMATCH: 'p02-z1-canonical-bytes-mismatch',
  OBJECT_KEY_MISMATCH: 'p02-z1-object-key-mismatch',
  PAYLOAD_HASH_MISMATCH: 'p02-z1-payload-hash-mismatch',
  BLOB_ADDRESS_MISMATCH: 'p02-z1-blob-address-mismatch',
  LIMIT_EXCEEDED: 'p02-z1-limit-exceeded',
  UNSUPPORTED_FORMAT: 'p02-z1-unsupported-format',
  UNSUPPORTED_PROTOCOL: 'p02-z1-unsupported-protocol',
  UNSUPPORTED_EPOCH: 'p02-z1-unsupported-epoch',
  CRYPTO_UNAVAILABLE: 'p02-z1-crypto-unavailable'
});

const DOCUMENT_KIND = Object.freeze({
  REVISION: 'revision',
  HEAD: 'head',
  HEADS_SNAPSHOT: 'heads-snapshot',
  WRITER_STATE: 'writer-state',
  LIBRARY_INFO: 'library-info',
  LEGACY_BASELINE_RECEIPT: 'legacy-baseline-receipt'
});

const SHA256_RE = /^[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ASCII_DOMAIN_RE = /^[\x21-\x7e]+$/;

const encoder = new TextEncoder();

export class P02ContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02ContractError';
    this.code = code;
  }
}

function fail(code) {
  throw new P02ContractError(code);
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value, expected) {
  return isPlainObject(value) &&
    Object.keys(value).sort().join(',') === expected.slice().sort().join(',');
}

function isStrictIdentifier(value) {
  return typeof value === 'string' &&
    Array.from(value).length > 0 &&
    Array.from(value).length <= LIMITS.MAX_ID_LENGTH &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value);
}

/* Public read-only predicate for authorities that must validate a peer before
 * persistence. Keeping this as a projection of the protocol's own private
 * predicate prevents config surfaces from drifting to a looser identity
 * grammar than the repository/runtime contract. */
export function strictSyncIdentifier(value) {
  return isStrictIdentifier(value);
}

function isObjectDomain(value) {
  return isStrictIdentifier(value) && ASCII_DOMAIN_RE.test(value);
}

function isTimestamp(value) {
  return typeof value === 'string' && TIMESTAMP_RE.test(value);
}

function normalizeCanonical(value, inArray = false) {
  if (value === undefined) {
    if (inArray) fail(ERROR_CODE.SCHEMA_INVALID);
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(ERROR_CODE.SCHEMA_INVALID);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeCanonical(item, true));
  }
  if (!isPlainObject(value)) fail(ERROR_CODE.SCHEMA_INVALID);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeCanonical(value[key], false);
    if (normalized !== undefined) output[key] = normalized;
  }
  return output;
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeCanonical(value));
}

function exactBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) &&
      value.constructor?.name === 'Uint8Array') {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
  }
  fail(ERROR_CODE.SCHEMA_INVALID);
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function sha256Hex(bytes, cryptoImplementation) {
  if (!cryptoImplementation?.subtle ||
      typeof cryptoImplementation.subtle.digest !== 'function') {
    fail(ERROR_CODE.CRYPTO_UNAVAILABLE);
  }
  let digest;
  try {
    digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
  } catch (_) {
    fail(ERROR_CODE.CRYPTO_UNAVAILABLE);
  }
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}

async function deriveKey(domain, identity, cryptoImplementation) {
  return sha256Hex(encoder.encode(`${domain}\u0000${identity}`), cryptoImplementation);
}

export function objectKeyHex(objectDomain, objectId, cryptoImplementation = globalThis.crypto) {
  if (!isObjectDomain(objectDomain) || !isStrictIdentifier(objectId)) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
  return deriveKey(objectDomain, objectId, cryptoImplementation);
}

export function writerKeyHex(writerSyncPeerId, cryptoImplementation = globalThis.crypto) {
  if (!isStrictIdentifier(writerSyncPeerId)) fail(ERROR_CODE.SCHEMA_INVALID);
  return deriveKey(
    'h2o.studio.sync-writer.v1',
    writerSyncPeerId,
    cryptoImplementation
  );
}

function maximumForKind(kind) {
  switch (kind) {
    case DOCUMENT_KIND.REVISION: return LIMITS.MAX_REVISION_BYTES;
    case DOCUMENT_KIND.HEAD: return LIMITS.MAX_HEAD_BYTES;
    case DOCUMENT_KIND.HEADS_SNAPSHOT: return LIMITS.MAX_HEADS_SNAPSHOT_BYTES;
    case DOCUMENT_KIND.WRITER_STATE: return LIMITS.MAX_POINTER_BYTES;
    case DOCUMENT_KIND.LIBRARY_INFO: return LIMITS.MAX_LIBRARY_INFO_BYTES;
    case DOCUMENT_KIND.LEGACY_BASELINE_RECEIPT: return LIMITS.MAX_RECEIPT_BYTES;
    default: fail(ERROR_CODE.SCHEMA_INVALID);
  }
}

function decodeCanonical(bytes, kind) {
  const copied = exactBytes(bytes);
  const maximumBytes = maximumForKind(kind);
  if (copied.byteLength === 0 || copied.byteLength > maximumBytes) {
    fail(ERROR_CODE.LIMIT_EXCEEDED);
  }
  let value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(copied);
    value = JSON.parse(text);
  } catch (_) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
  if (!isPlainObject(value)) fail(ERROR_CODE.SCHEMA_INVALID);
  const canonicalBytes = encoder.encode(canonicalJson(value));
  if (!bytesEqual(copied, canonicalBytes)) {
    fail(ERROR_CODE.CANONICAL_BYTES_MISMATCH);
  }
  return { bytes: copied, value };
}

function validateParentPair(value) {
  if (!own(value, 'previousRevisionId') ||
      !own(value, 'previousRevisionBlobSha256')) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
  const revisionNull = value.previousRevisionId === null;
  const blobNull = value.previousRevisionBlobSha256 === null;
  if (revisionNull !== blobNull) fail(ERROR_CODE.SCHEMA_INVALID);
  if (!revisionNull &&
      (!isStrictIdentifier(value.previousRevisionId) ||
        !SHA256_RE.test(value.previousRevisionBlobSha256))) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
}

function validateIdentity(value) {
  if (!isObjectDomain(value.objectDomain) ||
      !isStrictIdentifier(value.objectId) ||
      !isStrictIdentifier(value.revisionId)) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
}

async function validateRevision(value, cryptoImplementation) {
  const commonKeys = [
    'objectDomain',
    'objectId',
    'payload',
    'payloadSha256',
    'previousRevisionBlobSha256',
    'previousRevisionId',
    'revisionId',
    'schema',
    'writerSyncPeerId'
  ];
  const closureType = value.closureType;
  const expectedKeys = closureType === 'branch-superseded'
    ? [...commonKeys, 'closureType', 'selectedRevision']
    : closureType === 'object-deleted'
      ? [...commonKeys, 'closureType']
      : commonKeys;
  if (!hasExactKeys(value, expectedKeys) ||
      value.schema !== SCHEMA.REVISION ||
      !SHA256_RE.test(value.payloadSha256 || '') ||
      !isStrictIdentifier(value.writerSyncPeerId) ||
      !isPlainObject(value.payload)) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
  validateIdentity(value);
  validateParentPair(value);

  if (closureType === undefined) {
    // Live revisions contain no closure-only fields.
  } else {
    if (value.previousRevisionId === null ||
        !hasExactKeys(value.payload, ['schema']) ||
        value.payload.schema !== SCHEMA.CLOSURE_PAYLOAD) {
      fail(ERROR_CODE.SCHEMA_INVALID);
    }
    if (closureType === 'branch-superseded') {
      if (!hasExactKeys(value.selectedRevision, [
        'revisionBlobSha256',
        'revisionId'
      ]) ||
          !isStrictIdentifier(value.selectedRevision.revisionId) ||
          !SHA256_RE.test(value.selectedRevision.revisionBlobSha256 || '') ||
          value.selectedRevision.revisionId === value.previousRevisionId ||
          value.selectedRevision.revisionBlobSha256 ===
            value.previousRevisionBlobSha256) {
        fail(ERROR_CODE.SCHEMA_INVALID);
      }
    } else if (closureType !== 'object-deleted') {
      fail(ERROR_CODE.SCHEMA_INVALID);
    }
  }

  const payloadBytes = encoder.encode(canonicalJson(value.payload));
  if (payloadBytes.byteLength > LIMITS.MAX_PAYLOAD_BYTES) {
    fail(ERROR_CODE.LIMIT_EXCEEDED);
  }
  if (await sha256Hex(payloadBytes, cryptoImplementation) !== value.payloadSha256) {
    fail(ERROR_CODE.PAYLOAD_HASH_MISMATCH);
  }
  return value;
}

async function validateHead(value, cryptoImplementation) {
  if (!hasExactKeys(value, [
    'objectDomain',
    'objectId',
    'objectKey',
    'payloadSha256',
    'previousRevisionBlobSha256',
    'previousRevisionId',
    'revisionBlobSha256',
    'revisionId',
    'schema',
    'sourceUpdatedAtIso',
    'writerSyncPeerId'
  ]) ||
      value.schema !== SCHEMA.HEAD ||
      !SHA256_RE.test(value.objectKey || '') ||
      !SHA256_RE.test(value.payloadSha256 || '') ||
      !SHA256_RE.test(value.revisionBlobSha256 || '') ||
      !isStrictIdentifier(value.writerSyncPeerId) ||
      !isTimestamp(value.sourceUpdatedAtIso)) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
  validateIdentity(value);
  validateParentPair(value);
  if (await objectKeyHex(
    value.objectDomain,
    value.objectId,
    cryptoImplementation
  ) !== value.objectKey) {
    fail(ERROR_CODE.OBJECT_KEY_MISMATCH);
  }
  return value;
}

async function validateHeadsSnapshot(value, cryptoImplementation) {
  if (!hasExactKeys(value, ['objects', 'schema', 'writerSyncPeerId']) ||
      value.schema !== SCHEMA.HEADS_SNAPSHOT ||
      !isStrictIdentifier(value.writerSyncPeerId) ||
      !Array.isArray(value.objects) ||
      value.objects.length === 0) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
  const objectKeys = new Set();
  for (const group of value.objects) {
    if (!hasExactKeys(group, [
      'headSchema',
      'objectDomain',
      'objectId',
      'objectKey',
      'tips'
    ]) ||
        group.headSchema !== SCHEMA.HEAD ||
        !isObjectDomain(group.objectDomain) ||
        !isStrictIdentifier(group.objectId) ||
        !SHA256_RE.test(group.objectKey || '') ||
        !Array.isArray(group.tips) ||
        group.tips.length === 0 ||
        objectKeys.has(group.objectKey)) {
      fail(ERROR_CODE.SCHEMA_INVALID);
    }
    objectKeys.add(group.objectKey);
    const tipBlobs = new Set();
    for (const tip of group.tips) {
      if (!hasExactKeys(tip, [
        'payloadSha256',
        'previousRevisionBlobSha256',
        'previousRevisionId',
        'revisionBlobSha256',
        'revisionId',
        'sourceUpdatedAtIso'
      ]) ||
          tipBlobs.has(tip.revisionBlobSha256)) {
        fail(ERROR_CODE.SCHEMA_INVALID);
      }
      tipBlobs.add(tip.revisionBlobSha256);
      await validateHead({
        schema: group.headSchema,
        objectDomain: group.objectDomain,
        objectId: group.objectId,
        objectKey: group.objectKey,
        revisionId: tip.revisionId,
        payloadSha256: tip.payloadSha256,
        revisionBlobSha256: tip.revisionBlobSha256,
        writerSyncPeerId: value.writerSyncPeerId,
        previousRevisionId: tip.previousRevisionId,
        previousRevisionBlobSha256: tip.previousRevisionBlobSha256,
        sourceUpdatedAtIso: tip.sourceUpdatedAtIso
      }, cryptoImplementation);
    }
  }
  return value;
}

function validateWriterState(value) {
  if (!hasExactKeys(value, [
    'currentHeadsSnapshotSha256',
    'schema',
    'writerSyncPeerId'
  ]) ||
      value.schema !== SCHEMA.WRITER_STATE ||
      !isStrictIdentifier(value.writerSyncPeerId) ||
      !SHA256_RE.test(value.currentHeadsSnapshotSha256 || '')) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
  return value;
}

function validateLibraryInfo(value, policy) {
  if (!hasExactKeys(value, [
    'formatVersion',
    'layoutEpoch',
    'legacyBaselineReceiptSha256',
    'minimumCompatibleProtocolVersion',
    'schema'
  ]) ||
      value.schema !== SCHEMA.LIBRARY_INFO ||
      !Number.isSafeInteger(value.formatVersion) || value.formatVersion < 1 ||
      !Number.isSafeInteger(value.minimumCompatibleProtocolVersion) ||
      value.minimumCompatibleProtocolVersion < 1 ||
      !Number.isSafeInteger(value.layoutEpoch) || value.layoutEpoch < 1 ||
      !SHA256_RE.test(value.legacyBaselineReceiptSha256 || '')) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
  if (value.formatVersion !== policy.formatVersion) {
    fail(ERROR_CODE.UNSUPPORTED_FORMAT);
  }
  if (value.minimumCompatibleProtocolVersion > policy.protocolVersion) {
    fail(ERROR_CODE.UNSUPPORTED_PROTOCOL);
  }
  if (value.layoutEpoch !== policy.layoutEpoch) {
    fail(ERROR_CODE.UNSUPPORTED_EPOCH);
  }
  return value;
}

function validateLegacyBaselineReceipt(value) {
  if (!hasExactKeys(value, ['artifacts', 'schema']) ||
      value.schema !== SCHEMA.LEGACY_BASELINE_RECEIPT ||
      !Array.isArray(value.artifacts) ||
      value.artifacts.length === 0) {
    fail(ERROR_CODE.SCHEMA_INVALID);
  }
  let previousPath = '';
  for (const artifact of value.artifacts) {
    if (!hasExactKeys(artifact, ['observation', 'path']) ||
        !isStrictIdentifier(artifact.path) ||
        !ASCII_DOMAIN_RE.test(artifact.path) ||
        artifact.path <= previousPath ||
        !isPlainObject(artifact.observation)) {
      fail(ERROR_CODE.SCHEMA_INVALID);
    }
    previousPath = artifact.path;
    if (artifact.observation.status === 'absent') {
      if (!hasExactKeys(artifact.observation, ['status'])) {
        fail(ERROR_CODE.SCHEMA_INVALID);
      }
    } else if (artifact.observation.status === 'sha256') {
      if (!hasExactKeys(artifact.observation, ['sha256', 'status']) ||
          !SHA256_RE.test(artifact.observation.sha256 || '')) {
        fail(ERROR_CODE.SCHEMA_INVALID);
      }
    } else {
      fail(ERROR_CODE.SCHEMA_INVALID);
    }
  }
  return value;
}

async function validateValue(kind, value, cryptoImplementation, policy) {
  switch (kind) {
    case DOCUMENT_KIND.REVISION:
      return validateRevision(value, cryptoImplementation);
    case DOCUMENT_KIND.HEAD:
      return validateHead(value, cryptoImplementation);
    case DOCUMENT_KIND.HEADS_SNAPSHOT:
      return validateHeadsSnapshot(value, cryptoImplementation);
    case DOCUMENT_KIND.WRITER_STATE:
      return validateWriterState(value);
    case DOCUMENT_KIND.LIBRARY_INFO:
      return validateLibraryInfo(value, policy);
    case DOCUMENT_KIND.LEGACY_BASELINE_RECEIPT:
      return validateLegacyBaselineReceipt(value);
    default:
      fail(ERROR_CODE.SCHEMA_INVALID);
  }
}

export async function validateContractDocument({
  kind,
  bytes,
  expectedBlobSha256 = null,
  cryptoImplementation = globalThis.crypto,
  policy = SUPPORTED
} = {}) {
  const decoded = decodeCanonical(bytes, kind);
  const value = await validateValue(
    kind,
    decoded.value,
    cryptoImplementation,
    policy
  );
  const blobSha256 = await sha256Hex(decoded.bytes, cryptoImplementation);
  if (expectedBlobSha256 !== null &&
      (!SHA256_RE.test(expectedBlobSha256) || expectedBlobSha256 !== blobSha256)) {
    fail(ERROR_CODE.BLOB_ADDRESS_MISMATCH);
  }
  return Object.freeze({
    ok: true,
    kind,
    value,
    bytes: decoded.bytes,
    blobSha256
  });
}

export async function serializeContractDocument({
  kind,
  value,
  cryptoImplementation = globalThis.crypto,
  policy = SUPPORTED
} = {}) {
  const bytes = encoder.encode(canonicalJson(value));
  return validateContractDocument({
    kind,
    bytes,
    cryptoImplementation,
    policy
  });
}

export const P02_SYNC_CONTRACT_V2 = Object.freeze({
  SCHEMA,
  LIMITS,
  SUPPORTED,
  ERROR_CODE,
  DOCUMENT_KIND,
  CLOSURE_TYPE: Object.freeze([
    'object-deleted',
    'branch-superseded'
  ])
});
