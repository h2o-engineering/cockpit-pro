/*
 * P02 V8-A — generic syncRevision.v2 production.
 *
 * This module turns an already-canonical object projection into the frozen §E
 * revision envelope and its canonical immutable bytes. It is the ONLY place
 * that composes a v2 revision, and it is deliberately domain-agnostic:
 * `objectDomain` is data, never a switch. Chat, chat-note, folder, label, tag,
 * category and any future H2O object family reach this core through their own
 * adapter by supplying identity plus an already-canonical payload.
 *
 * Scope is production only. Nothing here reads or writes a repository, a
 * database, a filesystem or a network: no transport, no writer heads, no writer
 * pointer, no ceremony. §J.1 publication is a later, separate step.
 *
 * Schema, key sets, limits, canonical serialization and the parent-pair rule
 * all come from the frozen contract module; this core adds no second v2 schema
 * implementation.
 */

import {
  P02_SYNC_CONTRACT_V2,
  P02ContractError,
  canonicalJson,
  objectKeyHex,
  serializeContractDocument
} from './sync-contract-v2.mjs';

const { DOCUMENT_KIND, SCHEMA, LIMITS } = P02_SYNC_CONTRACT_V2;
const SHA256_RE = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export const P02_REVISION_PRODUCTION_V2 = Object.freeze({
  INPUT_SCHEMA: 'h2o.studio.syncRevisionProductionInput.p02.v1',
  PARENT_KIND: Object.freeze({ ROOT: 'root', DESCENDANT: 'descendant' }),
  /*
   * Supervisor ruling, filling a gap N1 does not decide. The first P02
   * revision of an object that already carries P01 history is a v2 ROOT:
   * both frozen parent keys present, both null. A P01 revision id is never a
   * v2 parent, and no P01 blob is synthesized to manufacture P02 ancestry.
   * It is named here so the decision cannot quietly drift later.
   */
  P01_CUTOVER_ROOT_RULE: 'p02-first-revision-is-root-at-p01-cutover'
});

export const P02_REVISION_PRODUCTION_ERROR = Object.freeze({
  INPUT_INVALID: 'p02-v8a-revision-input-invalid',
  PARENT_DESCRIPTOR_INVALID: 'p02-v8a-parent-descriptor-invalid',
  PARENT_PAIR_INCOHERENT: 'p02-v8a-parent-pair-incoherent',
  UNPROVEN_P02_PARENT: 'p02-v8a-unproven-p02-parent',
  PAYLOAD_INVALID: 'p02-v8a-payload-invalid',
  LIMIT_EXCEEDED: 'p02-v8a-limit-exceeded',
  CRYPTO_UNAVAILABLE: 'p02-v8a-crypto-unavailable'
});

export class P02RevisionProductionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02RevisionProductionError';
    this.code = code;
  }
}

function fail(code) {
  throw new P02RevisionProductionError(code);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* Mirrors the frozen identifier rule; kept local so this core never widens it. */
function strictIdentifier(value) {
  return typeof value === 'string' &&
    Array.from(value).length > 0 &&
    Array.from(value).length <= LIMITS.MAX_ID_LENGTH &&
    value.trim() === value &&
    !/\p{Cc}/u.test(value);
}

async function sha256Hex(bytes, cryptoImplementation) {
  if (!cryptoImplementation?.subtle ||
      typeof cryptoImplementation.subtle.digest !== 'function') {
    fail(P02_REVISION_PRODUCTION_ERROR.CRYPTO_UNAVAILABLE);
  }
  let digest;
  try {
    digest = await cryptoImplementation.subtle.digest('SHA-256', bytes);
  } catch (_) {
    fail(P02_REVISION_PRODUCTION_ERROR.CRYPTO_UNAVAILABLE);
  }
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')).join('');
}

/*
 * Root parent descriptor. This is what the P01 -> P02 cutover uses: the object
 * keeps its durable identity, and its first P02 revision starts a fresh v2
 * ancestry rather than importing anything from the legacy lane.
 */
export function rootParent() {
  return Object.freeze({
    kind: P02_REVISION_PRODUCTION_V2.PARENT_KIND.ROOT,
    previousRevisionId: null,
    previousRevisionBlobSha256: null,
    lineage: P02_REVISION_PRODUCTION_V2.P01_CUTOVER_ROOT_RULE
  });
}

/*
 * Descendant parent descriptor. `provenP02Parent` must be exactly true and is
 * not a convenience flag: it forces the caller to assert that the named parent
 * is an admitted immutable P02 revision whose blob address was verified. That
 * makes it structurally impossible to slide a P01 `last_applied_revision_id`
 * into a v2 parent field by accident.
 */
export function descendantParent({
  previousRevisionId,
  previousRevisionBlobSha256,
  provenP02Parent
} = {}) {
  if (!strictIdentifier(previousRevisionId) ||
      typeof previousRevisionBlobSha256 !== 'string' ||
      !SHA256_RE.test(previousRevisionBlobSha256)) {
    fail(P02_REVISION_PRODUCTION_ERROR.PARENT_DESCRIPTOR_INVALID);
  }
  if (provenP02Parent !== true) {
    fail(P02_REVISION_PRODUCTION_ERROR.UNPROVEN_P02_PARENT);
  }
  return Object.freeze({
    kind: P02_REVISION_PRODUCTION_V2.PARENT_KIND.DESCENDANT,
    previousRevisionId,
    previousRevisionBlobSha256,
    lineage: 'p02-proven-immutable-parent'
  });
}

/*
 * Both parent keys are always written, so `key absent` can never be produced.
 * E.6 makes absent-vs-explicit-null load-bearing, and the frozen validator
 * rejects a half-null pair; this re-checks it here so a malformed descriptor
 * fails with a production-layer code instead of reaching serialization.
 */
function parentPair(parent) {
  if (!isPlainObject(parent) ||
      !Object.prototype.hasOwnProperty.call(parent, 'previousRevisionId') ||
      !Object.prototype.hasOwnProperty.call(parent, 'previousRevisionBlobSha256')) {
    fail(P02_REVISION_PRODUCTION_ERROR.PARENT_DESCRIPTOR_INVALID);
  }
  const idNull = parent.previousRevisionId === null;
  const blobNull = parent.previousRevisionBlobSha256 === null;
  if (idNull !== blobNull) fail(P02_REVISION_PRODUCTION_ERROR.PARENT_PAIR_INCOHERENT);
  if (idNull) {
    if (parent.kind !== P02_REVISION_PRODUCTION_V2.PARENT_KIND.ROOT) {
      fail(P02_REVISION_PRODUCTION_ERROR.PARENT_DESCRIPTOR_INVALID);
    }
    return { previousRevisionId: null, previousRevisionBlobSha256: null, isRoot: true };
  }
  if (parent.kind !== P02_REVISION_PRODUCTION_V2.PARENT_KIND.DESCENDANT ||
      !strictIdentifier(parent.previousRevisionId) ||
      !SHA256_RE.test(parent.previousRevisionBlobSha256)) {
    fail(P02_REVISION_PRODUCTION_ERROR.PARENT_DESCRIPTOR_INVALID);
  }
  return {
    previousRevisionId: parent.previousRevisionId,
    previousRevisionBlobSha256: parent.previousRevisionBlobSha256,
    isRoot: false
  };
}

/*
 * The single generic entry point. Input carries only domain-independent data;
 * the payload arrives already canonical from the domain adapter, because
 * deciding what belongs in a chat/folder/label payload is a domain question
 * (C14 scope) and never a revision-core question.
 */
export async function produceRevisionV2({
  objectDomain,
  objectId,
  revisionId,
  writerSyncPeerId,
  payload,
  parent,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!strictIdentifier(objectDomain) ||
      !strictIdentifier(objectId) ||
      !strictIdentifier(revisionId) ||
      !strictIdentifier(writerSyncPeerId)) {
    fail(P02_REVISION_PRODUCTION_ERROR.INPUT_INVALID);
  }
  if (!isPlainObject(payload)) fail(P02_REVISION_PRODUCTION_ERROR.PAYLOAD_INVALID);

  const pair = parentPair(parent);

  let payloadBytes;
  try {
    payloadBytes = encoder.encode(canonicalJson(payload));
  } catch (_) {
    fail(P02_REVISION_PRODUCTION_ERROR.PAYLOAD_INVALID);
  }
  if (payloadBytes.byteLength > LIMITS.MAX_PAYLOAD_BYTES) {
    fail(P02_REVISION_PRODUCTION_ERROR.LIMIT_EXCEEDED);
  }
  const payloadSha256 = await sha256Hex(payloadBytes, cryptoImplementation);

  /* Exactly the frozen live-revision key set: both parent keys present. */
  const revision = {
    objectDomain,
    objectId,
    payload,
    payloadSha256,
    previousRevisionBlobSha256: pair.previousRevisionBlobSha256,
    previousRevisionId: pair.previousRevisionId,
    revisionId,
    schema: SCHEMA.REVISION,
    writerSyncPeerId
  };

  /* The frozen module owns validation, canonical bytes and the blob address. */
  let serialized;
  try {
    serialized = await serializeContractDocument({
      kind: DOCUMENT_KIND.REVISION,
      value: revision,
      cryptoImplementation
    });
  } catch (error) {
    if (error instanceof P02ContractError) throw error;
    fail(P02_REVISION_PRODUCTION_ERROR.INPUT_INVALID);
  }

  const objectKey = await objectKeyHex(objectDomain, objectId, cryptoImplementation);

  return Object.freeze({
    ok: true,
    objectDomain,
    objectId,
    objectKey,
    revisionId,
    writerSyncPeerId,
    isRoot: pair.isRoot,
    parentKind: pair.isRoot
      ? P02_REVISION_PRODUCTION_V2.PARENT_KIND.ROOT
      : P02_REVISION_PRODUCTION_V2.PARENT_KIND.DESCENDANT,
    lineage: parent.lineage,
    payloadSha256,
    revisionBlobSha256: serialized.blobSha256,
    canonicalBytes: serialized.bytes,
    revision: serialized.value
  });
}
