/*
 * Round 2 / Item 9-3A — offline Desktop-revision delivery admission.
 *
 * CHROME/MV3 STUDIO-PAGE ADAPTER ONLY.
 *
 * This module validates a byte-carrying delivery envelope and delegates the
 * exact decoded head/revision bytes to Item 9-2. It has no file-system,
 * service-worker, transport, or archive-write capability.
 */

import { ITEM9_1_CONSTANTS } from './sync-object-store.mjs';
import { ITEM9_2_CONSTANTS } from './sync-revision-admission.mjs';

const DELIVERY_SCHEMA = 'h2o.round2.item9.browser-delivery.v1';
const DELIVERY_SCHEMA_VERSION = 1;
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_REVISION_BYTES = 5 * 1024 * 1024;
const MAX_OBJECT_ID_LENGTH = 512;
const DELIVERY_KEYS = Object.freeze([
  'deliverySchemaVersion',
  'headBytesBase64',
  'headSha256Hex',
  'objectId',
  'producedAtIso',
  'revisionBlobSha256Hex',
  'revisionBytesBase64',
  'schema'
]);
const SHA256_RE = /^[0-9a-f]{64}$/;

const ERROR_CODE = Object.freeze({
  INVALID: 'round2-item9-delivery-invalid',
  SCHEMA_UNSUPPORTED: 'round2-item9-delivery-schema-unsupported',
  BASE64_INVALID: 'round2-item9-delivery-base64-invalid',
  SIZE_EXCEEDED: 'round2-item9-delivery-size-exceeded',
  CHECKSUM_MISMATCH: 'round2-item9-delivery-checksum-mismatch',
  OBJECT_MISMATCH: 'round2-item9-delivery-object-mismatch',
  ADMISSION_FAILED: 'round2-item9-delivery-admission-failed'
});

const ADMISSION_ERROR_CODES = Object.freeze([
  ...Object.values(ITEM9_1_CONSTANTS.ERROR_CODE),
  ...Object.values(ITEM9_2_CONSTANTS.ERROR_CODE)
]);

class Item9DeliveryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Item9DeliveryError';
    this.code = code;
  }
}

function fail(code) {
  throw new Item9DeliveryError(code);
}

function safeCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (Object.values(ERROR_CODE).includes(code)) return code;
  if (ADMISSION_ERROR_CODES.includes(code)) return code;
  return ERROR_CODE.ADMISSION_FAILED;
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isObjectId(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OBJECT_ID_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch (_) {
    return false;
  }
}

function skipWhitespace(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  return index;
}

function skipJsonString(text, start) {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') return index + 1;
    if (character === '\\') {
      index += 1;
      if (text[index] === 'u') index += 4;
    }
    index += 1;
  }
  return text.length;
}

function skipJsonValue(text, start) {
  let index = skipWhitespace(text, start);
  const character = text[index];
  if (character === '"') return skipJsonString(text, index);
  if (character === '{') {
    index = skipWhitespace(text, index + 1);
    if (text[index] === '}') return index + 1;
    while (index < text.length) {
      index = skipJsonString(text, index);
      index = skipWhitespace(text, index);
      index = skipJsonValue(text, index + 1);
      index = skipWhitespace(text, index);
      if (text[index] === '}') return index + 1;
      index = skipWhitespace(text, index + 1);
    }
  }
  if (character === '[') {
    index = skipWhitespace(text, index + 1);
    if (text[index] === ']') return index + 1;
    while (index < text.length) {
      index = skipJsonValue(text, index);
      index = skipWhitespace(text, index);
      if (text[index] === ']') return index + 1;
      index = skipWhitespace(text, index + 1);
    }
  }
  while (index < text.length && !/[,\]}]/.test(text[index])) index += 1;
  return index;
}

function topLevelKeys(jsonText) {
  const keys = [];
  let index = skipWhitespace(jsonText, 0);
  if (jsonText[index] !== '{') return keys;
  index = skipWhitespace(jsonText, index + 1);
  if (jsonText[index] === '}') return keys;
  while (index < jsonText.length) {
    const keyStart = index;
    const keyEnd = skipJsonString(jsonText, keyStart);
    keys.push(JSON.parse(jsonText.slice(keyStart, keyEnd)));
    index = skipWhitespace(jsonText, keyEnd);
    index = skipJsonValue(jsonText, index + 1);
    index = skipWhitespace(jsonText, index);
    if (jsonText[index] === '}') break;
    index = skipWhitespace(jsonText, index + 1);
  }
  return keys;
}

function parseDeliveryEnvelope(deliveryJsonText) {
  if (typeof deliveryJsonText !== 'string' || deliveryJsonText.length === 0) {
    fail(ERROR_CODE.INVALID);
  }
  let parsed;
  try {
    parsed = JSON.parse(deliveryJsonText);
  } catch (_) {
    fail(ERROR_CODE.INVALID);
  }
  if (!isPlainObject(parsed)) fail(ERROR_CODE.INVALID);
  let keys;
  try {
    keys = topLevelKeys(deliveryJsonText);
  } catch (_) {
    fail(ERROR_CODE.INVALID);
  }
  if (new Set(keys).size !== keys.length ||
      keys.slice().sort().join(',') !== DELIVERY_KEYS.join(',')) {
    fail(ERROR_CODE.INVALID);
  }
  if (parsed.schema !== DELIVERY_SCHEMA ||
      parsed.deliverySchemaVersion !== DELIVERY_SCHEMA_VERSION) {
    fail(ERROR_CODE.SCHEMA_UNSUPPORTED);
  }
  if (!isObjectId(parsed.objectId) ||
      !isIsoTimestamp(parsed.producedAtIso) ||
      !SHA256_RE.test(parsed.headSha256Hex || '') ||
      !SHA256_RE.test(parsed.revisionBlobSha256Hex || '') ||
      typeof parsed.headBytesBase64 !== 'string' ||
      typeof parsed.revisionBytesBase64 !== 'string') {
    fail(ERROR_CODE.INVALID);
  }
  return parsed;
}

function decodedBase64Length(value) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function hasCanonicalBase64Shape(value) {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let padding = 0;
  if (value.endsWith('==')) padding = 2;
  else if (value.endsWith('=')) padding = 1;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  for (let index = dataLength; index < value.length; index += 1) {
    if (value[index] !== '=') return false;
  }
  return padding === 0 ||
    (padding === 1 && dataLength % 4 === 3) ||
    (padding === 2 && dataLength % 4 === 2);
}

function decodeBase64(value, maximumBytes) {
  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4;
  if (value.length > maximumEncodedLength) fail(ERROR_CODE.SIZE_EXCEEDED);
  if (!hasCanonicalBase64Shape(value)) {
    fail(ERROR_CODE.BASE64_INVALID);
  }
  const decodedLength = decodedBase64Length(value);
  if (decodedLength <= 0 || decodedLength > maximumBytes) {
    fail(ERROR_CODE.SIZE_EXCEEDED);
  }
  let binary;
  try {
    binary = globalThis.atob(value);
    if (globalThis.btoa(binary) !== value) fail(ERROR_CODE.BASE64_INVALID);
  } catch (error) {
    if (error instanceof Item9DeliveryError) throw error;
    fail(ERROR_CODE.BASE64_INVALID);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.byteLength !== decodedLength ||
      bytes.byteLength > maximumBytes) {
    fail(ERROR_CODE.SIZE_EXCEEDED);
  }
  return new Uint8Array(bytes);
}

async function sha256Hex(bytes, cryptoImplementation) {
  if (!cryptoImplementation?.subtle ||
      typeof cryptoImplementation.subtle.digest !== 'function') {
    fail(ERROR_CODE.ADMISSION_FAILED);
  }
  try {
    const digest = await cryptoImplementation.subtle.digest(
      'SHA-256',
      new Uint8Array(bytes)
    );
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch (_) {
    fail(ERROR_CODE.ADMISSION_FAILED);
  }
}

function readHeadObjectId(headBytes) {
  let head;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(headBytes);
    head = JSON.parse(text);
  } catch (_) {
    fail(ERROR_CODE.INVALID);
  }
  if (!isPlainObject(head) || !isObjectId(head.objectId)) {
    fail(ERROR_CODE.INVALID);
  }
  return head.objectId;
}

function safeSuccess(result, objectId) {
  if (!isPlainObject(result) ||
      result.ok !== true ||
      !['revision-admitted', 'identical-replay'].includes(result.verdict)) {
    fail(ERROR_CODE.ADMISSION_FAILED);
  }
  return Object.freeze({
    ok: true,
    verdict: result.verdict,
    unchangedNoOp: result.unchangedNoOp === true,
    objectId,
    peerFingerprintSha256Hex: result.peerFingerprintSha256Hex,
    objectKeySha256Hex: result.objectKeySha256Hex,
    revisionKeySha256Hex: result.revisionKeySha256Hex,
    revisionBlobSha256Hex: result.revisionBlobSha256Hex,
    payloadSha256Hex: result.payloadSha256Hex,
    observedState: result.observedState,
    applyState: result.applyState
  });
}

export function createBrowserDeliveryRuntime({
  observationStore,
  admission,
  cryptoImplementation = globalThis.crypto
} = {}) {
  return Object.freeze({
    async admitDeliveryPackage({ deliveryJsonText } = {}) {
      try {
        if (!observationStore ||
            typeof observationStore.ensureReady !== 'function' ||
            !admission ||
            typeof admission.admitInjectedRevision !== 'function') {
          fail(ERROR_CODE.ADMISSION_FAILED);
        }
        const envelope = parseDeliveryEnvelope(deliveryJsonText);
        const headBytes = decodeBase64(
          envelope.headBytesBase64,
          MAX_HEAD_BYTES
        );
        const revisionBlobBytes = decodeBase64(
          envelope.revisionBytesBase64,
          MAX_REVISION_BYTES
        );
        const [headSha256Hex, revisionBlobSha256Hex] = await Promise.all([
          sha256Hex(headBytes, cryptoImplementation),
          sha256Hex(revisionBlobBytes, cryptoImplementation)
        ]);
        if (headSha256Hex !== envelope.headSha256Hex ||
            revisionBlobSha256Hex !== envelope.revisionBlobSha256Hex) {
          fail(ERROR_CODE.CHECKSUM_MISMATCH);
        }
        if (readHeadObjectId(headBytes) !== envelope.objectId) {
          fail(ERROR_CODE.OBJECT_MISMATCH);
        }
        await observationStore.ensureReady();
        return safeSuccess(
          await admission.admitInjectedRevision({
            headBytes: new Uint8Array(headBytes),
            revisionBlobBytes: new Uint8Array(revisionBlobBytes)
          }),
          envelope.objectId
        );
      } catch (error) {
        throw new Item9DeliveryError(safeCode(error));
      }
    }
  });
}

export const ITEM9_3A_CONSTANTS = Object.freeze({
  DELIVERY_SCHEMA,
  DELIVERY_SCHEMA_VERSION,
  DELIVERY_KEYS,
  MAX_HEAD_BYTES,
  MAX_REVISION_BYTES,
  ERROR_CODE
});
