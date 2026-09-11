/*
 * O1-T11 — Chrome v2 admission, BESIDE the v1 path.
 *
 * The v1 admission contract accepts a six-key revision document. A v2 envelope
 * has nine keys, carries an object domain and a parent PAIR, and is a different
 * format - not a newer dialect of the same one. Widening the v1 validator to
 * let a v2 document through would delete the only thing that currently
 * guarantees a v1 document is a v1 document, so this is a separate path and
 * the v1 contract is untouched.
 *
 * PARENT PAIRS ONLY. There is no allowUnresolvedParentHash here. That flag
 * exists for accepted P01 observations, which record a parent id without the
 * parent bytes and therefore cannot express a v2 pair; a v2 writer always can,
 * so a v2 record that omits the parent hash is malformed rather than
 * legacy-shaped. Accepting it would let a peer claim ancestry it never proved.
 *
 * CR1 IDENTITY-SQUAT HARDENING. Two records claiming one revisionId with
 * different bytes is an attack shape as much as a corruption shape, so it must
 * not be able to take down anything but itself. Two protections apply together:
 * the index is built with conflict quarantining so one squatted id excludes
 * only itself, and admission additionally cross-checks the candidate against
 * the OBSERVATION store, because a squat that agrees with branch evidence and
 * disagrees with the observation it supposedly came from is the same lie told
 * in a different place.
 *
 * OBJECT ISOLATION. Every read and write is scoped to one object. A hostile
 * object cannot make another object's evidence throw, quarantine, or change
 * disposition - which is checked, not assumed.
 *
 * No DATABASE_VERSION bump: this writes through the existing branch-evidence
 * store, whose record shape already carries everything a v2 pair needs.
 */
import {
  P02_ADMISSION_DISPOSITION,
  P02_BRANCH_EVIDENCE_ERROR,
  buildBranchIndex,
  classifyAdmission,
  normalizeRetainedEvidence
} from '../../core/sync-branch-evidence-v2.mjs';
import { createP02AnchorSet } from '../../core/sync-p02-anchor-set-v2.mjs';

export const P02_CHROME_ADMISSION_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncChromeBranchAdmission.p02.v1',
  REVISION_SCHEMA: 'h2o.studio.syncRevision.v2',
  CHAT_OBJECT_DOMAIN: 'studio.chat.saved-state.v1',
  /* Exactly the keys a v2 envelope carries. Not a superset of the v1 six. */
  REVISION_KEYS: Object.freeze([
    'objectDomain', 'objectId', 'payload', 'payloadSha256',
    'previousRevisionBlobSha256', 'previousRevisionId', 'revisionId',
    'schema', 'writerSyncPeerId'
  ])
});

export const P02_CHROME_ADMISSION_ERROR = Object.freeze({
  DEPENDENCY_INVALID: 'p02-chrome-v2-admission-dependency-invalid',
  REVISION_INVALID: 'p02-chrome-v2-admission-revision-invalid',
  PARENT_PAIR_REQUIRED: 'p02-chrome-v2-admission-parent-pair-required',
  BLOB_HASH_MISMATCH: 'p02-chrome-v2-admission-blob-hash-mismatch',
  OBSERVATION_IDENTITY_CONFLICT: 'p02-chrome-v2-admission-observation-identity-conflict'
});

const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(code, detail = null) {
  const error = new Error(code);
  error.code = code;
  if (detail !== null) error.detail = detail;
  throw error;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, i) => key === keys[i]);
}

/*
 * The v2 shape check. Deliberately exact rather than permissive: a document
 * with an unexpected key is not a v2 revision with extras, it is something
 * else, and guessing which is how a format boundary erodes.
 */
function validateV2Revision(revision, { objectDomain }) {
  if (!hasExactKeys(revision, P02_CHROME_ADMISSION_V2.REVISION_KEYS) ||
      revision.schema !== P02_CHROME_ADMISSION_V2.REVISION_SCHEMA ||
      revision.objectDomain !== objectDomain ||
      !clean(revision.objectId) ||
      !clean(revision.revisionId) ||
      !clean(revision.writerSyncPeerId) ||
      !hex64(revision.payloadSha256) ||
      !isPlainObject(revision.payload)) {
    fail(P02_CHROME_ADMISSION_ERROR.REVISION_INVALID);
  }
  const parentId = revision.previousRevisionId;
  const parentBlob = revision.previousRevisionBlobSha256;
  const isRoot = parentId === null && parentBlob === null;
  const isChild = clean(parentId).length > 0 && hex64(parentBlob);
  if (!isRoot && !isChild) {
    /* A half-pair. The v1 lane tolerates this shape through
     * allowUnresolvedParentHash; the v2 lane never does. */
    fail(P02_CHROME_ADMISSION_ERROR.PARENT_PAIR_REQUIRED);
  }
  return revision;
}

export function createChromeV2BranchAdmission({
  evidenceStore,
  sha256HexBytes,
  objectDomain = P02_CHROME_ADMISSION_V2.CHAT_OBJECT_DOMAIN
} = {}) {
  if (!isPlainObject(evidenceStore) ||
      typeof evidenceStore.listBranchEvidence !== 'function' ||
      typeof evidenceStore.recordBranchEvidence !== 'function' ||
      typeof sha256HexBytes !== 'function') {
    fail(P02_CHROME_ADMISSION_ERROR.DEPENDENCY_INVALID);
  }
  const observationsFor = typeof evidenceStore.listObservations === 'function'
    ? evidenceStore.listObservations.bind(evidenceStore)
    : null;

  /* Object-scoped by the store call itself, not by filtering afterwards. */
  async function retainedFor(objectId) {
    const records = await evidenceStore.listBranchEvidence(objectId);
    return (Array.isArray(records) ? records : []).map((record) => ({
      revisionBlobSha256: clean(record.revisionBlobSha256Hex),
      disposition: clean(record.disposition),
      document: {
        objectDomain,
        objectId: clean(record.objectId),
        revisionId: clean(record.revisionId),
        previousRevisionId: record.parentRevisionId == null
          ? null : clean(record.parentRevisionId),
        previousRevisionBlobSha256: record.parentRevisionBlobSha256Hex == null
          ? null : clean(record.parentRevisionBlobSha256Hex),
        ...(record.closureType == null ? {} : { closureType: clean(record.closureType) })
      }
    }));
  }

  /*
   * CR1 cross-check. Branch evidence and the observation store are two records
   * of the same fact written at different times; a revision whose identity
   * disagrees between them is squatting, whichever one is "right". Refusing
   * here means the disagreement is caught before either store is extended with
   * a third claim.
   */
  async function observationConflict(objectId, revisionId, revisionBlobSha256) {
    if (observationsFor === null) return null;
    let observations;
    try {
      observations = await observationsFor(objectId);
    } catch (_) {
      /* An unreadable observation store is not evidence of a squat. */
      return null;
    }
    for (const observation of Array.isArray(observations) ? observations : []) {
      if (clean(observation?.revisionId) !== revisionId) continue;
      const observedBlob = clean(
        observation?.revisionBlobSha256Hex ?? observation?.revisionBlobSha256
      );
      if (hex64(observedBlob) && observedBlob !== revisionBlobSha256) {
        return observedBlob;
      }
    }
    return null;
  }

  async function admitV2Revision({
    revision,
    revisionBlobBytes,
    protocolState = {}
  } = {}) {
    const bytes = revisionBlobBytes instanceof Uint8Array
      ? revisionBlobBytes
      : null;
    if (bytes === null || bytes.byteLength === 0) {
      fail(P02_CHROME_ADMISSION_ERROR.REVISION_INVALID);
    }
    const validated = validateV2Revision(revision, { objectDomain });
    const objectId = clean(validated.objectId);
    const revisionId = clean(validated.revisionId);

    /* The address is derived from the bytes, never taken on trust. */
    const revisionBlobSha256 = clean(await sha256HexBytes(bytes));
    if (!hex64(revisionBlobSha256)) {
      fail(P02_CHROME_ADMISSION_ERROR.BLOB_HASH_MISMATCH);
    }

    const squatSource = await observationConflict(objectId, revisionId, revisionBlobSha256);
    if (squatSource !== null) {
      return Object.freeze({
        schema: P02_CHROME_ADMISSION_V2.SCHEMA,
        objectId, revisionId,
        disposition: P02_ADMISSION_DISPOSITION.QUARANTINED,
        reason: P02_CHROME_ADMISSION_ERROR.OBSERVATION_IDENTITY_CONFLICT,
        observedRevisionBlobSha256Hex: squatSource,
        candidateRevisionBlobSha256Hex: revisionBlobSha256,
        admitted: false, persisted: false, applyEligible: false
      });
    }

    const candidate = {
      revisionBlobSha256,
      document: {
        objectDomain,
        objectId,
        revisionId,
        previousRevisionId: validated.previousRevisionId,
        previousRevisionBlobSha256: validated.previousRevisionBlobSha256
      }
    };
    let normalized;
    try {
      normalized = normalizeRetainedEvidence(candidate);
    } catch (error) {
      return Object.freeze({
        schema: P02_CHROME_ADMISSION_V2.SCHEMA,
        objectId, revisionId,
        disposition: P02_ADMISSION_DISPOSITION.QUARANTINED,
        reason: clean(error?.code) || P02_BRANCH_EVIDENCE_ERROR.RECORD_INVALID,
        admitted: false, persisted: false, applyEligible: false
      });
    }

    const retained = await retainedFor(objectId);
    const p02AnchorSet = createP02AnchorSet({ objectDomain, objectId, protocolState });
    /*
     * Conflict quarantining ON: these records came from a peer, so one squatted
     * id must exclude only itself rather than collapsing the whole index.
     */
    const index = buildBranchIndex({
      objectDomain, objectId, records: retained, p02AnchorSet,
      quarantineIdentityConflicts: true
    });

    const admission = classifyAdmission({
      index, candidate, p02AnchorSet, capacityAvailable: true
    });

    let persisted = false;
    if (admission.disposition !== null && admission.replay !== true) {
      await evidenceStore.recordBranchEvidence({
        objectId,
        revisionId,
        revisionBlobSha256Hex: revisionBlobSha256,
        revisionBlobBytes: bytes,
        parentRevisionId: normalized.previousRevisionId,
        parentRevisionBlobSha256Hex: normalized.previousRevisionBlobSha256,
        disposition: admission.disposition,
        reason: admission.reason ?? null,
        closureType: normalized.closureType ?? null
      });
      persisted = true;
    }

    return Object.freeze({
      schema: P02_CHROME_ADMISSION_V2.SCHEMA,
      objectId, revisionId, revisionBlobSha256Hex: revisionBlobSha256,
      disposition: admission.disposition,
      reason: admission.reason ?? null,
      admitted: admission.disposition !== null,
      replay: admission.replay === true,
      applyEligible: admission.applyEligible === true,
      anchorConflict: admission.anchorConflict === true,
      persisted,
      squattedRevisionIds: index.identitySquattedRevisionIds ?? [],
      anchorPairs: p02AnchorSet.pairs.length
    });
  }

  /* Object-scoped index rebuild, for callers that need the graph, not a verdict. */
  async function indexFor({ objectId, protocolState = {} } = {}) {
    const id = clean(objectId);
    return buildBranchIndex({
      objectDomain, objectId: id, records: await retainedFor(id),
      p02AnchorSet: createP02AnchorSet({ objectDomain, objectId: id, protocolState }),
      quarantineIdentityConflicts: true
    });
  }

  return Object.freeze({
    schema: P02_CHROME_ADMISSION_V2.SCHEMA,
    admitV2Revision,
    indexFor
  });
}
