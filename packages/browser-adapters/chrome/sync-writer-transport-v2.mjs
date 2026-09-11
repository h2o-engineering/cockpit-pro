/*
 * P02 Wave 1 / Z4 writer transport primitives.
 *
 * This module is inactive and transport-injected. It owns no folder handle,
 * repository activation, scheduler, Apply, canonical store, or live transport
 * authority. The injected local substrate must provide single-writer atomic
 * promotion; this is visibility protection, not multi-writer CAS.
 */

import {
  P02ContractError,
  P02_SYNC_CONTRACT_V2,
  objectKeyHex,
  serializeContractDocument,
  validateContractDocument,
  writerKeyHex
} from './sync-contract-v2.mjs';

/*
 * Z4 read/write split. Every shared repository-read primitive - the four
 * readers, the path derivations, the error class, the validation-code mapping
 * and the byte/identifier helpers - now lives in the reader module. They are
 * IMPORTED here rather than redefined, so there is exactly one definition of
 * each in the product and `instanceof P02WriterTransportError` keeps holding
 * across both halves.
 */
import {
  P02_WRITER_TRANSPORT_V2,
  P02WriterTransportError,
  bytesEqual,
  clone,
  compareCanonicalText,
  createLocalReaderTransportPrimitives,
  deriveRevisionPath,
  deriveWriterPaths,
  exactBytes,
  fail,
  freezeDeep,
  isPlainObject,
  lowerHex64,
  reconstructWriterHeadsSnapshot,
  strictIdentifier,
  validateHead,
  validationCode
} from './sync-reader-transport-v2.mjs';

const { DOCUMENT_KIND, SCHEMA } = P02_SYNC_CONTRACT_V2;

/* Single source of truth: the limits live with the reader that enforces them. */
const {
  DEFAULT_MAX_ANCESTRY_DEPTH,
  DEFAULT_MAX_ANCESTRY_BYTES
} = P02_WRITER_TRANSPORT_V2;

/*
 * Re-exported so every existing importer of this module keeps resolving the
 * same bindings it always did. These are re-exports, not second definitions.
 */
export {
  P02_WRITER_TRANSPORT_V2,
  P02WriterTransportError,
  deriveRevisionPath,
  deriveWriterPaths,
  reconstructWriterHeadsSnapshot
};


function temporaryPath(finalPath, identity) {
  return `${finalPath}.pending-${identity}`;
}

export async function buildWriterHeadsSnapshot({
  writerSyncPeerId,
  heads,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!strictIdentifier(writerSyncPeerId) ||
      !Array.isArray(heads) ||
      heads.length === 0) {
    fail('p02-z4-head-set-invalid');
  }
  const groups = new Map();
  const revisionIdentity = new Set();
  for (const raw of heads) {
    const head = await validateHead(raw, cryptoImplementation);
    if (head.writerSyncPeerId !== writerSyncPeerId) {
      fail('p02-z4-writer-identity-mismatch');
    }
    const groupIdentity = `${head.objectDomain}\u0000${head.objectId}`;
    const prior = groups.get(groupIdentity);
    if (prior && prior.objectKey !== head.objectKey) {
      fail('p02-z4-object-identity-conflict');
    }
    const revisionKey = `${groupIdentity}\u0000${head.revisionId}`;
    if (revisionIdentity.has(revisionKey)) {
      fail('p02-z4-duplicate-tip');
    }
    revisionIdentity.add(revisionKey);
    const group = prior || {
      headSchema: SCHEMA.HEAD,
      objectDomain: head.objectDomain,
      objectId: head.objectId,
      objectKey: head.objectKey,
      tips: []
    };
    group.tips.push({
      revisionId: head.revisionId,
      payloadSha256: head.payloadSha256,
      revisionBlobSha256: head.revisionBlobSha256,
      previousRevisionId: head.previousRevisionId,
      previousRevisionBlobSha256: head.previousRevisionBlobSha256,
      sourceUpdatedAtIso: head.sourceUpdatedAtIso
    });
    groups.set(groupIdentity, group);
  }
  const objects = [...groups.values()]
    .sort((left, right) =>
      compareCanonicalText(left.objectDomain, right.objectDomain) ||
      compareCanonicalText(left.objectId, right.objectId) ||
      compareCanonicalText(left.objectKey, right.objectKey))
    .map((group) => ({
      ...group,
      tips: group.tips.sort((left, right) =>
        compareCanonicalText(left.revisionId, right.revisionId) ||
        compareCanonicalText(
          left.revisionBlobSha256,
          right.revisionBlobSha256
        ))
    }));
  const serialized = await serializeContractDocument({
    kind: DOCUMENT_KIND.HEADS_SNAPSHOT,
    value: {
      schema: SCHEMA.HEADS_SNAPSHOT,
      writerSyncPeerId,
      objects
    },
    cryptoImplementation
  });
  return freezeDeep({
    writerSyncPeerId,
    writerKey: await writerKeyHex(writerSyncPeerId, cryptoImplementation),
    value: clone(serialized.value),
    bytes: exactBytes(serialized.bytes),
    headsSnapshotSha256: serialized.blobSha256,
    objectCount: objects.length,
    tipCount: heads.length
  });
}

function validateStorage(storage) {
  if (!storage ||
      typeof storage.read !== 'function' ||
      typeof storage.writeTemporary !== 'function' ||
      typeof storage.readTemporary !== 'function' ||
      typeof storage.promoteTemporary !== 'function') {
    fail('p02-z4-local-storage-invalid');
  }
}

export function createLocalWriterTransportPrimitives({
  storage,
  ownedWriterSyncPeerId,
  cryptoImplementation = globalThis.crypto,
  maxAncestryDepth = DEFAULT_MAX_ANCESTRY_DEPTH,
  maxAncestryBytes = DEFAULT_MAX_ANCESTRY_BYTES
} = {}) {
  validateStorage(storage);
  if (!strictIdentifier(ownedWriterSyncPeerId) ||
      !Number.isSafeInteger(maxAncestryDepth) || maxAncestryDepth < 1 ||
      !Number.isSafeInteger(maxAncestryBytes) || maxAncestryBytes < 1) {
    fail('p02-z4-local-transport-config-invalid');
  }

  /*
   * The shared reader, constructed from THIS factory's storage and crypto. The
   * writer's four read methods are this instance's methods - not copies - so
   * writer-state outcomes, ancestry reasons, pointer/heads behaviour and every
   * validation code are the same objects the reader returns.
   */
  const reader = createLocalReaderTransportPrimitives({
    storage, cryptoImplementation, maxAncestryDepth, maxAncestryBytes
  });
  const {
    readBytes,
    validateRevisionIdentity,
    readRevision,
    readHeadsSnapshot,
    fetchAncestry,
    readWriterState
  } = reader;

  async function createOrVerifyImmutable({
    finalPath,
    temporaryIdentity,
    bytes,
    verify,
    divergentCode
  }) {
    const proposed = exactBytes(bytes);
    await verify(proposed);
    const existing = await readBytes(finalPath);
    if (existing !== null) {
      try {
        await verify(existing);
      } catch (_) {
        fail(divergentCode);
      }
      if (!bytesEqual(existing, proposed)) fail(divergentCode);
      return freezeDeep({
        status: 'already-present-verified',
        path: finalPath,
        created: false,
        readBackVerified: true
      });
    }

    const pendingPath = temporaryPath(finalPath, temporaryIdentity);
    await storage.writeTemporary(pendingPath, proposed);
    const pending = exactBytes(await storage.readTemporary(pendingPath));
    await verify(pending);
    if (!bytesEqual(pending, proposed)) fail('p02-z4-temporary-readback-mismatch');
    try {
      await storage.promoteTemporary(pendingPath, finalPath, {
        replaceExisting: false
      });
    } catch (error) {
      const raced = await readBytes(finalPath);
      if (raced === null) throw error;
      try {
        await verify(raced);
      } catch (_) {
        fail(divergentCode);
      }
      if (!bytesEqual(raced, proposed)) fail(divergentCode);
    }
    const finalBytes = await readBytes(finalPath);
    if (finalBytes === null) fail('p02-z4-immutable-promotion-missing');
    await verify(finalBytes);
    if (!bytesEqual(finalBytes, proposed)) fail(divergentCode);
    return freezeDeep({
      status: 'created-verified',
      path: finalPath,
      created: true,
      readBackVerified: true
    });
  }

  async function createOrVerifyRevision({
    objectDomain,
    objectId,
    objectKey,
    revisionBlobSha256,
    bytes
  } = {}) {
    if (!strictIdentifier(objectDomain) ||
        !strictIdentifier(objectId) ||
        !lowerHex64(objectKey) ||
        !lowerHex64(revisionBlobSha256)) {
      fail('p02-z4-revision-address-invalid');
    }
    const path = deriveRevisionPath(objectKey, revisionBlobSha256);
    return createOrVerifyImmutable({
      finalPath: path,
      temporaryIdentity: revisionBlobSha256,
      bytes,
      verify: (candidate) => validateRevisionIdentity({
        bytes: candidate,
        revisionBlobSha256,
        objectDomain,
        objectId,
        objectKey
      }),
      divergentCode: 'p02-z4-immutable-revision-divergent'
    });
  }

  async function createOrVerifyHeadsSnapshot(snapshot) {
    if (!snapshot ||
        snapshot.writerSyncPeerId !== ownedWriterSyncPeerId ||
        !lowerHex64(snapshot.writerKey) ||
        !lowerHex64(snapshot.headsSnapshotSha256)) {
      fail('p02-z4-heads-snapshot-address-invalid');
    }
    const expectedWriterKey = await writerKeyHex(
      ownedWriterSyncPeerId,
      cryptoImplementation
    );
    if (snapshot.writerKey !== expectedWriterKey) {
      fail('p02-z4-writer-identity-mismatch');
    }
    const path = deriveWriterPaths(
      snapshot.writerKey,
      snapshot.headsSnapshotSha256
    ).snapshot;
    return createOrVerifyImmutable({
      finalPath: path,
      temporaryIdentity: snapshot.headsSnapshotSha256,
      bytes: snapshot.bytes,
      verify: async (candidate) => {
        const validated = await reconstructWriterHeadsSnapshot({
          bytes: candidate,
          expectedHeadsSnapshotSha256: snapshot.headsSnapshotSha256,
          cryptoImplementation
        });
        if (validated.writerSyncPeerId !== ownedWriterSyncPeerId) {
          fail('p02-z4-writer-identity-mismatch');
        }
      },
      divergentCode: 'p02-z4-immutable-snapshot-divergent'
    });
  }

  async function publishWriterState({
    headsSnapshotSha256,
    expectedCurrentHeadsSnapshotSha256 = undefined
  } = {}) {
    if (!lowerHex64(headsSnapshotSha256) ||
        (expectedCurrentHeadsSnapshotSha256 !== undefined &&
          expectedCurrentHeadsSnapshotSha256 !== null &&
          !lowerHex64(expectedCurrentHeadsSnapshotSha256))) {
      fail('p02-z4-pointer-input-invalid');
    }
    const writerKey = await writerKeyHex(
      ownedWriterSyncPeerId,
      cryptoImplementation
    );
    const snapshot = await readHeadsSnapshot({
      writerSyncPeerId: ownedWriterSyncPeerId,
      headsSnapshotSha256
    });
    if (snapshot.status !== 'verified') fail('p02-z4-pointer-snapshot-unproven');
    const current = await readWriterState({
      writerSyncPeerId: ownedWriterSyncPeerId
    });
    const currentHash = current.status === 'verified'
      ? current.pointer.currentHeadsSnapshotSha256
      : null;
    if (current.status !== 'verified' && current.status !== 'absent') {
      fail('p02-z4-current-pointer-unreadable');
    }
    if (expectedCurrentHeadsSnapshotSha256 !== undefined &&
        currentHash !== expectedCurrentHeadsSnapshotSha256) {
      fail('p02-z4-local-pointer-stale');
    }
    const serialized = await serializeContractDocument({
      kind: DOCUMENT_KIND.WRITER_STATE,
      value: {
        schema: SCHEMA.WRITER_STATE,
        writerSyncPeerId: ownedWriterSyncPeerId,
        currentHeadsSnapshotSha256: headsSnapshotSha256
      },
      cryptoImplementation
    });
    if (current.status === 'verified' &&
        bytesEqual(current.pointerBytes, serialized.bytes)) {
      return freezeDeep({
        status: 'already-current-verified',
        path: current.path,
        updated: false,
        pointerSha256: serialized.blobSha256,
        currentHeadsSnapshotSha256: headsSnapshotSha256
      });
    }
    const statePath = deriveWriterPaths(writerKey).state;
    const pendingPath = temporaryPath(statePath, serialized.blobSha256);
    await storage.writeTemporary(pendingPath, serialized.bytes);
    const pending = exactBytes(await storage.readTemporary(pendingPath));
    await validateContractDocument({
      kind: DOCUMENT_KIND.WRITER_STATE,
      bytes: pending,
      expectedBlobSha256: serialized.blobSha256,
      cryptoImplementation
    });
    if (!bytesEqual(pending, serialized.bytes)) {
      fail('p02-z4-temporary-readback-mismatch');
    }
    await storage.promoteTemporary(pendingPath, statePath, {
      replaceExisting: true
    });
    const finalBytes = await readBytes(statePath);
    if (finalBytes === null) fail('p02-z4-pointer-promotion-missing');
    const verified = await validateContractDocument({
      kind: DOCUMENT_KIND.WRITER_STATE,
      bytes: finalBytes,
      expectedBlobSha256: serialized.blobSha256,
      cryptoImplementation
    });
    if (verified.value.writerSyncPeerId !== ownedWriterSyncPeerId ||
        verified.value.currentHeadsSnapshotSha256 !== headsSnapshotSha256) {
      fail('p02-z4-pointer-readback-mismatch');
    }
    return freezeDeep({
      status: 'published-verified',
      path: statePath,
      updated: true,
      pointerSha256: serialized.blobSha256,
      currentHeadsSnapshotSha256: headsSnapshotSha256
    });
  }

  /*
   * `expectedCurrentHeadsSnapshotSha256` (O1-T15) is the CAS token from the
   * readWriterState that supplied the caller's merge base, and it is passed in
   * EXPLICITLY for a reason. Deriving it here means re-reading the pointer
   * after the caller has already planned the merge, so a pointer that moved in
   * between would be silently adopted as the base - and the CAS would then
   * confirm a state nobody inspected, which is the precise failure a CAS
   * exists to prevent.
   *
   * `undefined` keeps the accepted derive-here behaviour for callers that do
   * not plan a merge. `null` is a positive claim that the pointer was ABSENT
   * when the caller looked, and becomes a create-if-absent precondition.
   */
  async function publishBatch({
    revisions, heads, expectedCurrentHeadsSnapshotSha256 = undefined
  } = {}) {
    if (!Array.isArray(revisions) || !Array.isArray(heads) || heads.length === 0) {
      fail('p02-z4-publication-batch-invalid');
    }
    if (expectedCurrentHeadsSnapshotSha256 !== undefined &&
        expectedCurrentHeadsSnapshotSha256 !== null &&
        !lowerHex64(expectedCurrentHeadsSnapshotSha256)) {
      fail('p02-z4-publication-expected-current-invalid');
    }
    const validatedHeads = [];
    for (const head of heads) {
      const validated = await validateHead(head, cryptoImplementation);
      if (validated.writerSyncPeerId !== ownedWriterSyncPeerId) {
        fail('p02-z4-writer-identity-mismatch');
      }
      validatedHeads.push(validated);
    }
    const phases = ['writer-ownership-validated'];
    for (const revision of revisions) {
      await createOrVerifyRevision(revision);
    }
    phases.push('immutable-revisions-verified');

    for (const head of validatedHeads) {
      const current = await readRevision({
        objectDomain: head.objectDomain,
        objectId: head.objectId,
        objectKey: head.objectKey,
        revisionBlobSha256: head.revisionBlobSha256
      });
      if (current.status !== 'verified' ||
          current.value.revisionId !== head.revisionId ||
          current.value.payloadSha256 !== head.payloadSha256 ||
          current.value.previousRevisionId !== head.previousRevisionId ||
          current.value.previousRevisionBlobSha256 !==
            head.previousRevisionBlobSha256) {
        fail('p02-z4-head-revision-mismatch');
      }
      const ancestry = await fetchAncestry({
        objectDomain: head.objectDomain,
        objectId: head.objectId,
        objectKey: head.objectKey,
        revisionBlobSha256: head.revisionBlobSha256
      });
      if (ancestry.outcome !== 'proven-chain') {
        fail(ancestry.outcome === 'retained-unproven-parent'
          ? 'p02-z4-ancestry-pending'
          : 'p02-z4-ancestry-quarantined');
      }
    }
    phases.push('immutable-ancestry-verified');

    const snapshot = await buildWriterHeadsSnapshot({
      writerSyncPeerId: ownedWriterSyncPeerId,
      heads: validatedHeads,
      cryptoImplementation
    });
    phases.push('complete-heads-snapshot-built');
    await createOrVerifyHeadsSnapshot(snapshot);
    phases.push('immutable-heads-snapshot-verified');
    /*
     * When the caller supplied a token, it is used VERBATIM and the pointer is
     * not re-read: the caller's plan and the precondition must describe the
     * same base. Only a caller that supplied nothing gets the derived token.
     */
    let expectedCurrent = expectedCurrentHeadsSnapshotSha256;
    if (expectedCurrent === undefined) {
      const before = await readWriterState({
        writerSyncPeerId: ownedWriterSyncPeerId
      });
      expectedCurrent = before.status === 'verified'
        ? before.pointer.currentHeadsSnapshotSha256
        : null;
    }
    /* The phase sequence is a frozen pin; the token's provenance is reported
     * in the result instead, where it changes no accepted contract. */
    const pointer = await publishWriterState({
      headsSnapshotSha256: snapshot.headsSnapshotSha256,
      expectedCurrentHeadsSnapshotSha256: expectedCurrent
    });
    phases.push('writer-state-pointer-verified', 'transport-batch-committed');
    return freezeDeep({
      ok: true,
      verdict: 'committed',
      writerSyncPeerId: ownedWriterSyncPeerId,
      writerKey: snapshot.writerKey,
      headsSnapshotSha256: snapshot.headsSnapshotSha256,
      pointerSha256: pointer.pointerSha256,
      expectedCurrentHeadsSnapshotSha256: expectedCurrent,
      casTokenSource: expectedCurrentHeadsSnapshotSha256 === undefined
        ? 'derived-at-publish'
        : 'supplied-by-caller',
      phases
    });
  }

  return freezeDeep({
    createOrVerifyRevision,
    readRevision,
    createOrVerifyHeadsSnapshot,
    readHeadsSnapshot,
    fetchAncestry,
    readWriterState,
    publishWriterState,
    publishBatch
  });
}
