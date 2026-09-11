/*
 * P02 Wave 1 / Z4 repository READ transport primitives.
 *
 * These four readers - revision, heads snapshot, ancestry, writer state - were
 * closure-bound inside `createLocalWriterTransportPrimitives`, whose storage
 * guard demands `writeTemporary` / `readTemporary` / `promoteTemporary`. A
 * read-only realm could therefore not reach them at all: not because reading
 * needs write capability, but because the two halves shared one factory. This
 * module is that extraction. The bodies are MOVED, not rewritten, so there is
 * exactly one writer-state status ladder, one ancestry reason vocabulary and
 * one validation-code mapping in the product.
 *
 * The reader requires ONLY `storage.read(path)`. It owns no folder handle, no
 * repository activation, no scheduler, no Apply and no write method of any
 * kind - and, unlike the writer factory, it cannot be handed one, because it
 * never looks for one.
 *
 * `createLocalWriterTransportPrimitives` composes this module internally and
 * delegates its read methods to it, keeping every existing writer requirement
 * and its public surface unchanged.
 */

import {
  P02ContractError,
  P02_SYNC_CONTRACT_V2,
  objectKeyHex,
  serializeContractDocument,
  validateContractDocument,
  writerKeyHex
} from './sync-contract-v2.mjs';

const { DOCUMENT_KIND, SCHEMA } = P02_SYNC_CONTRACT_V2;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_ANCESTRY_DEPTH = 1024;
const DEFAULT_MAX_ANCESTRY_BYTES = 32 * 1024 * 1024;

export const P02_WRITER_TRANSPORT_V2 = Object.freeze({
  DEFAULT_MAX_ANCESTRY_DEPTH,
  DEFAULT_MAX_ANCESTRY_BYTES,
  PATH_SCHEMA: 'h2o.studio.syncWriterTransportPaths.p02.v1'
});

/*
 * ONE error class for both halves. The writer module re-exports this exact
 * binding, so `instanceof` keeps working for every existing consumer and a
 * reader-thrown error is indistinguishable from a writer-thrown one - which it
 * must be, because until this extraction it WAS the same throw site.
 */
export class P02WriterTransportError extends Error {
  constructor(code) {
    super(code);
    this.name = 'P02WriterTransportError';
    this.code = code;
  }
}

export function fail(code) {
  throw new P02WriterTransportError(code);
}

export function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

export function strictIdentifier(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function lowerHex64(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

export function exactBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && value.constructor?.name === 'Uint8Array') {
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    );
  }
  fail('p02-z4-bytes-invalid');
}

export function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const item of Object.values(value)) freezeDeep(item);
  return Object.freeze(value);
}

export function validationCode(error) {
  return error instanceof P02ContractError
    ? error.code
    : error instanceof P02WriterTransportError
      ? error.code
      : 'p02-z4-transport-read-invalid';
}

export function deriveRevisionPath(objectKey, revisionBlobSha256) {
  if (!lowerHex64(objectKey) || !lowerHex64(revisionBlobSha256)) {
    fail('p02-z4-path-identity-invalid');
  }
  return `objects/${objectKey}/revisions/${revisionBlobSha256}.json`;
}

export function deriveWriterPaths(writerKey, headsSnapshotSha256 = null) {
  if (!lowerHex64(writerKey) ||
      (headsSnapshotSha256 !== null && !lowerHex64(headsSnapshotSha256))) {
    fail('p02-z4-path-identity-invalid');
  }
  const root = `writers/${writerKey}`;
  return freezeDeep({
    schema: P02_WRITER_TRANSPORT_V2.PATH_SCHEMA,
    root,
    heads: `${root}/heads`,
    snapshot: headsSnapshotSha256 === null
      ? null
      : `${root}/heads/${headsSnapshotSha256}.json`,
    state: `${root}/state.json`
  });
}

export async function validateHead(head, cryptoImplementation) {
  const validated = await serializeContractDocument({
    kind: DOCUMENT_KIND.HEAD,
    value: head,
    cryptoImplementation
  });
  return validated.value;
}

export async function reconstructWriterHeadsSnapshot({
  bytes,
  expectedHeadsSnapshotSha256,
  cryptoImplementation = globalThis.crypto
} = {}) {
  const validated = await validateContractDocument({
    kind: DOCUMENT_KIND.HEADS_SNAPSHOT,
    bytes: exactBytes(bytes),
    expectedBlobSha256: expectedHeadsSnapshotSha256,
    cryptoImplementation
  });
  const heads = [];
  for (const group of validated.value.objects) {
    for (const tip of group.tips) {
      heads.push(await validateHead({
        schema: group.headSchema,
        objectDomain: group.objectDomain,
        objectId: group.objectId,
        objectKey: group.objectKey,
        revisionId: tip.revisionId,
        payloadSha256: tip.payloadSha256,
        revisionBlobSha256: tip.revisionBlobSha256,
        writerSyncPeerId: validated.value.writerSyncPeerId,
        previousRevisionId: tip.previousRevisionId,
        previousRevisionBlobSha256: tip.previousRevisionBlobSha256,
        sourceUpdatedAtIso: tip.sourceUpdatedAtIso
      }, cryptoImplementation));
    }
  }
  return freezeDeep({
    writerSyncPeerId: validated.value.writerSyncPeerId,
    headsSnapshotSha256: validated.blobSha256,
    value: clone(validated.value),
    bytes: exactBytes(validated.bytes),
    heads: heads.sort((left, right) =>
      compareCanonicalText(left.objectDomain, right.objectDomain) ||
      compareCanonicalText(left.objectId, right.objectId) ||
      compareCanonicalText(left.revisionId, right.revisionId) ||
      compareCanonicalText(left.revisionBlobSha256, right.revisionBlobSha256))
  });
}

/*
 * The reader's whole capability requirement. Deliberately NOT the writer's
 * `validateStorage`: asking a read port for promotion methods it will never
 * use is what made the read half unreachable in the first place.
 */
function validateReaderStorage(storage) {
  if (!storage || typeof storage.read !== 'function') {
    fail('p02-z4-local-reader-storage-invalid');
  }
}

/*
 * No `ownedWriterSyncPeerId`. None of the four readers consults it: every one
 * of them takes the peer it is asked about as an argument, which is exactly
 * what makes cross-peer Receive possible from a realm that owns no writer.
 */
export function createLocalReaderTransportPrimitives({
  storage,
  cryptoImplementation = globalThis.crypto,
  maxAncestryDepth = DEFAULT_MAX_ANCESTRY_DEPTH,
  maxAncestryBytes = DEFAULT_MAX_ANCESTRY_BYTES
} = {}) {
  validateReaderStorage(storage);
  if (!Number.isSafeInteger(maxAncestryDepth) || maxAncestryDepth < 1 ||
      !Number.isSafeInteger(maxAncestryBytes) || maxAncestryBytes < 1) {
    fail('p02-z4-local-transport-config-invalid');
  }

  async function readBytes(path) {
    const value = await storage.read(path);
    return value == null ? null : exactBytes(value);
  }

  async function validateRevisionIdentity({
    bytes,
    revisionBlobSha256,
    objectDomain,
    objectId,
    objectKey
  }) {
    const validated = await validateContractDocument({
      kind: DOCUMENT_KIND.REVISION,
      bytes,
      expectedBlobSha256: revisionBlobSha256,
      cryptoImplementation
    });
    const expectedObjectKey = await objectKeyHex(
      objectDomain,
      objectId,
      cryptoImplementation
    );
    if (validated.value.objectDomain !== objectDomain ||
        validated.value.objectId !== objectId ||
        objectKey !== expectedObjectKey) {
      fail('p02-z4-revision-object-identity-mismatch');
    }
    return validated;
  }

  async function readRevision({
    objectDomain,
    objectId,
    objectKey,
    revisionBlobSha256
  } = {}) {
    if (!strictIdentifier(objectDomain) ||
        !strictIdentifier(objectId) ||
        !lowerHex64(objectKey) ||
        !lowerHex64(revisionBlobSha256)) {
      fail('p02-z4-revision-address-invalid');
    }
    const path = deriveRevisionPath(objectKey, revisionBlobSha256);
    const bytes = await readBytes(path);
    if (bytes === null) return freezeDeep({ status: 'missing', path });
    const validated = await validateRevisionIdentity({
      bytes,
      revisionBlobSha256,
      objectDomain,
      objectId,
      objectKey
    });
    return freezeDeep({
      status: 'verified',
      path,
      bytes: exactBytes(bytes),
      value: clone(validated.value),
      revisionBlobSha256: validated.blobSha256
    });
  }

  async function readHeadsSnapshot({
    writerSyncPeerId,
    headsSnapshotSha256
  } = {}) {
    if (!strictIdentifier(writerSyncPeerId) ||
        !lowerHex64(headsSnapshotSha256)) {
      fail('p02-z4-heads-snapshot-address-invalid');
    }
    const writerKey = await writerKeyHex(writerSyncPeerId, cryptoImplementation);
    const path = deriveWriterPaths(writerKey, headsSnapshotSha256).snapshot;
    const bytes = await readBytes(path);
    if (bytes === null) return freezeDeep({ status: 'missing', path });
    const reconstructed = await reconstructWriterHeadsSnapshot({
      bytes,
      expectedHeadsSnapshotSha256: headsSnapshotSha256,
      cryptoImplementation
    });
    if (reconstructed.writerSyncPeerId !== writerSyncPeerId) {
      fail('p02-z4-writer-identity-mismatch');
    }
    return freezeDeep({ status: 'verified', path, ...reconstructed });
  }

  async function fetchAncestry({
    objectDomain,
    objectId,
    objectKey,
    revisionBlobSha256,
    knownVerifiedAncestors = new Map()
  } = {}) {
    if (!(knownVerifiedAncestors instanceof Map)) {
      fail('p02-z4-known-ancestry-invalid');
    }
    const seenBlobs = new Set();
    const seenRevisions = new Set();
    const chain = [];
    let currentBlob = revisionBlobSha256;
    let expectedRevisionId = null;
    let totalBytes = 0;
    for (let depth = 0; ; depth += 1) {
      if (depth >= maxAncestryDepth) {
        return freezeDeep({
          outcome: 'quarantined',
          reason: 'ancestry-depth-limit-exceeded',
          chain
        });
      }
      if (seenBlobs.has(currentBlob)) {
        return freezeDeep({
          outcome: 'quarantined', reason: 'ancestry-cycle', chain
        });
      }
      seenBlobs.add(currentBlob);
      let current;
      try {
        current = await readRevision({
          objectDomain,
          objectId,
          objectKey,
          revisionBlobSha256: currentBlob
        });
      } catch (error) {
        return freezeDeep({
          outcome: 'quarantined', reason: validationCode(error), chain
        });
      }
      if (current.status === 'missing') {
        return freezeDeep({
          outcome: 'retained-unproven-parent',
          reason: 'ancestry-blob-missing',
          missingRevisionBlobSha256: currentBlob,
          chain
        });
      }
      totalBytes += current.bytes.byteLength;
      if (totalBytes > maxAncestryBytes) {
        return freezeDeep({
          outcome: 'quarantined', reason: 'ancestry-byte-limit-exceeded', chain
        });
      }
      const revision = current.value;
      if (expectedRevisionId !== null && revision.revisionId !== expectedRevisionId) {
        return freezeDeep({
          outcome: 'quarantined', reason: 'ancestry-revision-id-mismatch', chain
        });
      }
      if (seenRevisions.has(revision.revisionId)) {
        return freezeDeep({
          outcome: 'quarantined', reason: 'ancestry-cycle', chain
        });
      }
      seenRevisions.add(revision.revisionId);
      chain.push({
        revisionId: revision.revisionId,
        revisionBlobSha256: currentBlob
      });
      if (revision.previousRevisionId === null) {
        return freezeDeep({
          outcome: 'proven-chain',
          reason: 'root-reached',
          totalBytes,
          chain
        });
      }
      if (revision.previousRevisionId === revision.revisionId ||
          revision.previousRevisionBlobSha256 === currentBlob) {
        return freezeDeep({
          outcome: 'quarantined', reason: 'ancestry-self-reference', chain
        });
      }
      const anchor = knownVerifiedAncestors.get(
        revision.previousRevisionBlobSha256
      );
      if (anchor !== undefined) {
        if (!isPlainObject(anchor) ||
            anchor.objectDomain !== objectDomain ||
            anchor.objectId !== objectId ||
            anchor.revisionId !== revision.previousRevisionId) {
          return freezeDeep({
            outcome: 'quarantined', reason: 'ancestry-known-anchor-mismatch', chain
          });
        }
        return freezeDeep({
          outcome: 'proven-chain',
          reason: 'known-verified-ancestor-reached',
          anchorRevisionBlobSha256: revision.previousRevisionBlobSha256,
          totalBytes,
          chain
        });
      }
      expectedRevisionId = revision.previousRevisionId;
      currentBlob = revision.previousRevisionBlobSha256;
    }
  }

  async function readWriterState({ writerSyncPeerId } = {}) {
    if (!strictIdentifier(writerSyncPeerId)) {
      fail('p02-z4-writer-identity-invalid');
    }
    const writerKey = await writerKeyHex(writerSyncPeerId, cryptoImplementation);
    const path = deriveWriterPaths(writerKey).state;
    const bytes = await readBytes(path);
    if (bytes === null) return freezeDeep({ status: 'absent', path, writerKey });
    let pointer;
    try {
      pointer = await validateContractDocument({
        kind: DOCUMENT_KIND.WRITER_STATE,
        bytes,
        cryptoImplementation
      });
    } catch (error) {
      return freezeDeep({
        status: 'quarantined', path, writerKey, reason: validationCode(error)
      });
    }
    if (pointer.value.writerSyncPeerId !== writerSyncPeerId) {
      return freezeDeep({
        status: 'quarantined',
        path,
        writerKey,
        reason: 'p02-z4-writer-identity-mismatch'
      });
    }
    let snapshot;
    try {
      snapshot = await readHeadsSnapshot({
        writerSyncPeerId,
        headsSnapshotSha256: pointer.value.currentHeadsSnapshotSha256
      });
    } catch (error) {
      return freezeDeep({
        status: 'quarantined', path, writerKey, reason: validationCode(error)
      });
    }
    if (snapshot.status === 'missing') {
      return freezeDeep({
        status: 'retained-unproven-pointer',
        path,
        writerKey,
        currentHeadsSnapshotSha256: pointer.value.currentHeadsSnapshotSha256,
        reason: 'heads-snapshot-missing'
      });
    }
    return freezeDeep({
      status: 'verified',
      path,
      writerKey,
      pointerSha256: pointer.blobSha256,
      pointer: clone(pointer.value),
      pointerBytes: exactBytes(pointer.bytes),
      snapshot
    });
  }

  return freezeDeep({
    /* Stated, so a caller cannot look for a write method and find nothing. */
    readOnly: true,
    readBytes,
    validateRevisionIdentity,
    readRevision,
    readHeadsSnapshot,
    fetchAncestry,
    readWriterState
  });
}
