/*
 * P02 V8-C3b — governed first-publication composition.
 *
 * This is the seam that turns an operator-selected candidate into one committed
 * P02 publication. It owns ordering and nothing else: eligibility belongs to the
 * C1 work authority, selection to C2, revision bytes to V8-A, the write window
 * to the C3a lease, publication mechanics to Z4, durable I/O to V8-B, and
 * canonical evidence to the platform's existing intent-before-dispatch protocol.
 * Every one of those arrives injected, so this module reimplements none of them.
 *
 * The ordering it does own is the load-bearing part:
 *
 *   revalidate selection -> durable intent -> governed lease -> Z4 publish
 *   -> repository pointer commit -> canonical publication evidence -> close
 *
 * Canonical state must never claim a publication that the repository has not
 * committed, so evidence is advanced only after Z4 reports the pointer durable.
 * The reverse gap is expected and recoverable: if the process dies after the
 * pointer commit but before evidence, the retained intent plus the repository
 * itself prove exactly which publication happened, and recovery repairs the
 * bookkeeping instead of authoring a divergent second revision.
 *
 * Domain-generic. `objectDomain` is data; there is no chat, note, folder or
 * label branch anywhere below the descriptor boundary.
 */

import {
  P02_FIRST_PUBLICATION_ERROR,
  revalidateFirstPublicationSelection
} from './sync-first-publication-candidates-v2.mjs';

export const P02_PUBLICATION_COMPOSITION_V2 = Object.freeze({
  PREPARED_SCHEMA: 'h2o.studio.syncFirstPublicationPrepared.p02.v1',
  RESULT_SCHEMA: 'h2o.studio.syncFirstPublicationResult.p02.v1',
  OUTCOME: Object.freeze({
    COMMITTED: 'publication-committed',
    RECOVERED: 'publication-recovered-already-committed',
    REPOSITORY_COMMITTED_EVIDENCE_PENDING: 'repository-committed-evidence-pending'
  })
});

export const P02_PUBLICATION_COMPOSITION_ERROR = Object.freeze({
  INPUT_INVALID: 'p02-v8c3b-input-invalid',
  SELECTION_STALE: 'p02-v8c3b-selection-stale',
  PREPARED_MISMATCH: 'p02-v8c3b-prepared-mismatch',
  NOT_AUTHORIZED: 'p02-v8c3b-not-authorized',
  P01_NOT_QUIESCED: 'p02-v8c3b-p01-writer-not-quiesced',
  WRITER_ALREADY_PUBLISHED: 'p02-v8c3b-writer-already-published',
  INTENT_FAILED: 'p02-v8c3b-intent-failed',
  LEASE_FAILED: 'p02-v8c3b-lease-failed',
  PUBLISH_FAILED: 'p02-v8c3b-publish-failed',
  EVIDENCE_FAILED: 'p02-v8c3b-evidence-failed',
  RECOVERY_CONTRADICTED: 'p02-v8c3b-recovery-contradicted',
  NO_PENDING_INTENT: 'p02-v8c3b-no-pending-intent'
});

export class P02PublicationCompositionError extends Error {
  constructor(code, detail = null) {
    super(code);
    this.name = 'P02PublicationCompositionError';
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, detail) => {
  throw new P02PublicationCompositionError(code, detail);
};
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const HEX64 = /^[0-9a-f]{64}$/;

/*
 * Read-only preparation. Revalidates the operator's selection against a fresh
 * work authority, then asks the domain adapter for revision bytes. Nothing is
 * written, so a stale selection dies here rather than after durable intent.
 */
export async function prepareFirstPublication({
  enumeration,
  plan,
  produceRevision,
  writer,
  repository,
  classify,
  presentation = null,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!isPlainObject(plan) || typeof produceRevision !== 'function' ||
      !isPlainObject(writer) || !isPlainObject(repository) ||
      !HEX64.test(String(writer.writerKey || '')) ||
      !HEX64.test(String(repository.containerPathSha256Hex || '')) ||
      !Number.isSafeInteger(repository.layoutEpoch)) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.INPUT_INVALID);
  }

  let revalidated;
  try {
    revalidated = await revalidateFirstPublicationSelection({
      plan, enumeration, presentation, classify, cryptoImplementation
    });
  } catch (error) {
    /* Every C2 refusal - unknown key, converged, quarantined, projection
     * blocked, capacity blocked, moved source - lands here as one typed stale
     * result. A changed candidate is never silently re-prepared. */
    fail(P02_PUBLICATION_COMPOSITION_ERROR.SELECTION_STALE, error?.code ?? null);
  }

  const binding = revalidated.candidate.binding;
  const produced = await produceRevision(binding);
  if (!isPlainObject(produced) ||
      produced.objectId !== binding.objectId ||
      produced.objectDomain !== binding.objectDomain ||
      !HEX64.test(String(produced.objectKey || '')) ||
      !HEX64.test(String(produced.revisionBlobSha256 || '')) ||
      !(produced.canonicalBytes instanceof Uint8Array)) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.PREPARED_MISMATCH);
  }
  if (produced.objectKey !== binding.objectKey) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.PREPARED_MISMATCH, 'object-key');
  }

  return Object.freeze({
    schema: P02_PUBLICATION_COMPOSITION_V2.PREPARED_SCHEMA,
    selectionKey: plan.selectionKey,
    binding,
    writerSyncPeerId: writer.syncPeerId,
    writerKey: writer.writerKey,
    containerPathSha256Hex: repository.containerPathSha256Hex,
    layoutEpoch: repository.layoutEpoch,
    objectDomain: produced.objectDomain,
    objectId: produced.objectId,
    objectKey: produced.objectKey,
    revisionId: produced.revisionId,
    revisionBlobSha256: produced.revisionBlobSha256,
    payloadSha256: produced.payloadSha256,
    isRoot: produced.isRoot === true,
    previousRevisionId: produced.revision?.previousRevisionId ?? null,
    previousRevisionBlobSha256: produced.revision?.previousRevisionBlobSha256 ?? null,
    canonicalBytes: produced.canonicalBytes
  });
}

/* Z4's revision input is exactly V8-A output; no envelope field is restated. */
const revisionInput = (prepared) => ({
  objectDomain: prepared.objectDomain,
  objectId: prepared.objectId,
  objectKey: prepared.objectKey,
  revisionBlobSha256: prepared.revisionBlobSha256,
  bytes: prepared.canonicalBytes
});

/*
 * The governed mutation. Ordering is the contract; each step is injected.
 */
export async function executeFirstPublication({
  prepared,
  enumeration,
  authority,
  evidence,
  openLease,
  closeLease,
  createTransport,
  buildHead,
  classify,
  cryptoImplementation = globalThis.crypto
} = {}) {
  if (!isPlainObject(prepared) ||
      prepared.schema !== P02_PUBLICATION_COMPOSITION_V2.PREPARED_SCHEMA ||
      !isPlainObject(authority) || !isPlainObject(evidence) ||
      typeof openLease !== 'function' || typeof closeLease !== 'function' ||
      typeof createTransport !== 'function' || typeof buildHead !== 'function') {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.INPUT_INVALID);
  }
  if (!authority.governedCampaign || !authority.operatorAuthorization) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.NOT_AUTHORIZED);
  }
  if (authority.p01WriterQuiesced !== true) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.P01_NOT_QUIESCED);
  }

  /* Re-run the whole read-only preparation against fresh state. A candidate
   * that moved between preparation and execution must not be published. */
  const fresh = await prepareFirstPublication({
    enumeration,
    plan: { schema: 'h2o.studio.syncFirstPublicationSelectionPlan.p02.v1',
      selectionKey: prepared.selectionKey, binding: prepared.binding },
    produceRevision: async () => prepared,
    writer: { syncPeerId: prepared.writerSyncPeerId, writerKey: prepared.writerKey },
    repository: {
      containerPathSha256Hex: prepared.containerPathSha256Hex,
      layoutEpoch: prepared.layoutEpoch
    },
    classify,
    cryptoImplementation
  });
  if (fresh.revisionBlobSha256 !== prepared.revisionBlobSha256 ||
      fresh.objectKey !== prepared.objectKey ||
      fresh.revisionId !== prepared.revisionId) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.PREPARED_MISMATCH);
  }

  /* Durable intent BEFORE any repository mutation. */
  let acquisition;
  try {
    acquisition = await evidence.recordIntent({
      syncPeerId: prepared.writerSyncPeerId,
      objectId: prepared.objectId,
      objectKey: prepared.objectKey,
      revisionId: prepared.revisionId,
      revisionBlobSha256: prepared.revisionBlobSha256,
      payloadSha256: prepared.payloadSha256
    });
  } catch (error) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.INTENT_FAILED, error?.code ?? null);
  }

  let capability = null;
  let pointerCommitted = false;
  try {
    const grant = await openLease({
      governedCampaign: authority.governedCampaign,
      operatorAuthorization: authority.operatorAuthorization,
      p01WriterQuiesced: true,
      writerSyncPeerId: prepared.writerSyncPeerId,
      writerKey: prepared.writerKey,
      expectedContainerPathSha256Hex: prepared.containerPathSha256Hex,
      expectedLayoutEpoch: prepared.layoutEpoch,
      objectDomain: prepared.objectDomain,
      objectId: prepared.objectId,
      objectKey: prepared.objectKey,
      revisionId: prepared.revisionId,
      revisionBlobSha256: prepared.revisionBlobSha256
    });
    capability = grant?.capability ?? null;
    if (!capability) fail(P02_PUBLICATION_COMPOSITION_ERROR.LEASE_FAILED);

    const transport = createTransport(capability);
    const batch = await transport.publishBatch({
      revisions: [revisionInput(prepared)],
      heads: [buildHead(prepared)]
    });
    if (!batch || batch.ok !== true || batch.verdict !== 'committed') {
      fail(P02_PUBLICATION_COMPOSITION_ERROR.PUBLISH_FAILED);
    }
    pointerCommitted = true;

    /* Only now may canonical state claim the publication. */
    await evidence.completePublication(acquisition, {
      syncPeerId: prepared.writerSyncPeerId,
      objectId: prepared.objectId,
      revisionId: prepared.revisionId,
      revisionBlobSha256: prepared.revisionBlobSha256,
      /* The payload identity of the bytes actually published, carried from the
       * prepared publication rather than re-derived, so the recorded content
       * identity can never describe a later edit. */
      payloadSha256: prepared.payloadSha256
    });
    await closeLease(capability, 'committed');
    return Object.freeze({
      schema: P02_PUBLICATION_COMPOSITION_V2.RESULT_SCHEMA,
      outcome: P02_PUBLICATION_COMPOSITION_V2.OUTCOME.COMMITTED,
      selectionKey: prepared.selectionKey,
      objectDomain: prepared.objectDomain,
      objectId: prepared.objectId,
      objectKey: prepared.objectKey,
      writerKey: prepared.writerKey,
      revisionId: prepared.revisionId,
      revisionBlobSha256: prepared.revisionBlobSha256,
      isRoot: prepared.isRoot,
      headsSnapshotSha256: batch.headsSnapshotSha256,
      pointerSha256: batch.pointerSha256,
      phases: batch.phases,
      evidenceCompleted: true
    });
  } catch (error) {
    if (capability) {
      try { await closeLease(capability, 'aborted'); } catch (_) { /* lease may be gone */ }
    }
    /*
     * The split-store case. Once the pointer is durable the repository is the
     * publication, so the intent is RETAINED: deleting it would strand a
     * committed publication with no local trace, and republishing would author
     * a divergent revision. Recovery repairs the bookkeeping instead.
     */
    try {
      await evidence.abandonIntent(acquisition, {
        syncPeerId: prepared.writerSyncPeerId,
        objectId: prepared.objectId,
        errorCode: error?.code || P02_PUBLICATION_COMPOSITION_ERROR.PUBLISH_FAILED,
        retainIntent: pointerCommitted
      });
    } catch (_) { /* a lost owner must not overwrite the winner */ }
    if (pointerCommitted) {
      return Object.freeze({
        schema: P02_PUBLICATION_COMPOSITION_V2.RESULT_SCHEMA,
        outcome: P02_PUBLICATION_COMPOSITION_V2.OUTCOME.REPOSITORY_COMMITTED_EVIDENCE_PENDING,
        selectionKey: prepared.selectionKey,
        objectId: prepared.objectId,
        objectKey: prepared.objectKey,
        revisionId: prepared.revisionId,
        revisionBlobSha256: prepared.revisionBlobSha256,
        evidenceCompleted: false,
        recoverable: true
      });
    }
    throw error;
  }
}

/*
 * Restart recovery.
 *
 * Answers exactly one question: does the repository already prove this pending
 * intent? Proof means the writer pointer resolves to a heads snapshot that
 * names the intended revision at the intended immutable address. Anything
 * weaker is not proof and fails closed with evidence preserved; nothing is
 * deleted, and no revision is authored.
 */
/*
 * The production evidence store answers with raw sync_object_state rows, so the
 * pending intent arrives in snake_case. Reading only camelCase - as this did -
 * means a genuine interrupted publication is never recognised at all. Accept
 * either spelling and depend on neither.
 */
function normalizePendingPublicationState(state) {
  const pick = (camel, snake) => state[camel] ?? state[snake] ?? null;
  return Object.freeze({
    syncPeerId: pick('syncPeerId', 'sync_peer_id'),
    objectId: pick('objectId', 'object_id'),
    pendingOperation: pick('pendingOperation', 'pending_operation'),
    intendedObjectKey: pick('intendedObjectKey', 'intended_object_key'),
    intendedRevisionId: pick('intendedRevisionId', 'intended_revision_id'),
    intendedRevisionBlobSha256:
      pick('intendedRevisionBlobSha256', 'intended_revision_blob_sha256'),
    intendedPayloadSha256: pick('intendedPayloadSha256', 'intended_payload_sha256')
  });
}

export async function recoverFirstPublication({
  syncPeerId = null,
  objectId = null,
  state = null,
  readRepositoryPublication,
  evidence,
  acquisition = null
} = {}) {
  if (typeof readRepositoryPublication !== 'function' || !isPlainObject(evidence)) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.INPUT_INVALID);
  }
  /* Read the real row when the caller did not already hold one. */
  let source = state;
  if (!isPlainObject(source)) {
    if (typeof evidence.readState !== 'function') {
      fail(P02_PUBLICATION_COMPOSITION_ERROR.INPUT_INVALID);
    }
    source = await evidence.readState(syncPeerId, objectId);
  }
  if (!isPlainObject(source)) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.NO_PENDING_INTENT);
  }
  const pending = normalizePendingPublicationState(source);
  const intendedRevisionId = pending.intendedRevisionId;
  const intendedBlob = pending.intendedRevisionBlobSha256;
  if (pending.pendingOperation !== 'publish' || !intendedRevisionId || !intendedBlob) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.NO_PENDING_INTENT);
  }

  const observed = await readRepositoryPublication({
    objectKey: pending.intendedObjectKey,
    revisionBlobSha256: intendedBlob
  });
  const proves = !!observed &&
    observed.pointerPresent === true &&
    observed.headsNamesRevision === true &&
    observed.revisionPresent === true &&
    observed.revisionId === intendedRevisionId &&
    observed.revisionBlobSha256 === intendedBlob;
  if (!proves) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.RECOVERY_CONTRADICTED, observed ?? null);
  }

  /*
   * Ownership is taken only AFTER the repository has proven the intent, so a
   * contradicted repository leaves the interrupted publisher's row exactly as
   * it was found. Adoption runs through the existing acquire() protocol; it
   * neither weakens the owner predicate nor authors a second intent.
   */
  let owned = acquisition;
  if (!owned) {
    if (typeof evidence.adoptIntent !== 'function') {
      fail(P02_PUBLICATION_COMPOSITION_ERROR.INPUT_INVALID);
    }
    owned = await evidence.adoptIntent({
      syncPeerId: pending.syncPeerId,
      objectId: pending.objectId
    });
    /* An unresumed acquisition means the pending row was gone by the time
     * ownership was taken: there is nothing to repair, and a freshly created
     * empty row must never be completed as though it were the publication. */
    if (!owned || owned.resumed === false) {
      fail(P02_PUBLICATION_COMPOSITION_ERROR.NO_PENDING_INTENT);
    }
  }

  /* Recovery completes the interrupted publication's own identity, so the
   * payload hash comes from the retained intent, not from a fresh projection. */
  if (!pending.intendedPayloadSha256) {
    fail(P02_PUBLICATION_COMPOSITION_ERROR.NO_PENDING_INTENT);
  }
  await evidence.completePublication(owned, {
    syncPeerId: pending.syncPeerId,
    objectId: pending.objectId,
    revisionId: intendedRevisionId,
    revisionBlobSha256: intendedBlob,
    payloadSha256: pending.intendedPayloadSha256
  });
  return Object.freeze({
    schema: P02_PUBLICATION_COMPOSITION_V2.RESULT_SCHEMA,
    outcome: P02_PUBLICATION_COMPOSITION_V2.OUTCOME.RECOVERED,
    objectId: pending.objectId,
    revisionId: intendedRevisionId,
    revisionBlobSha256: intendedBlob,
    evidenceCompleted: true,
    republished: false
  });
}

export { P02_FIRST_PUBLICATION_ERROR };
