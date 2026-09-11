/*
 * O1-T10 — Desktop v2 admission and branch-evidence writer.
 *
 * Takes a VERIFIED P02 v2 revision and decides how to retain it, then writes
 * the derived evidence row. Three things about that sentence carry weight.
 *
 * VERIFIED means the caller has already proven the bytes: this module never
 * fetches, never validates a signature, and never decides that something is
 * real. It decides how already-real evidence relates to the evidence already
 * held, which is a different question with different failure modes.
 *
 * V2 means the parent is a PAIR - previousRevisionId together with
 * previousRevisionBlobSha256 - and the superseded source/canonical anchor rule
 * is not available here at all. A v1 projection head cannot anchor a v2 graph:
 * the two are different representations, the only bridge between them is the
 * payload hash, and a payload hash never establishes ancestry. The anchor is
 * the T05 p02AnchorSet and nothing else, which is why this module refuses a
 * canonicalAnchorRevisionId outright rather than accepting and ignoring it.
 *
 * DERIVED means sync_branch_evidence_state is a cache. Every row in it is
 * recomputable from retained immutable evidence plus the anchors, so dropping
 * the table loses nothing but time. It is never consulted as authority about
 * what happened - only about what was previously computed.
 *
 * The table is the EXISTING v21 shape. No migration is added, and none is
 * needed: the amended anchor contract changes how a disposition is decided, not
 * what a disposition is.
 *
 * OBJECT-LOCAL BY CONSTRUCTION. Every read and every write is scoped to one
 * (peer, object) pair, so a hostile or broken object cannot influence another's
 * admission. That is enforced by the queries themselves, not by convention.
 */
import {
  P02_ADMISSION_DISPOSITION,
  P02_BRANCH_EVIDENCE_ERROR,
  buildBranchIndex,
  classifyAdmission,
  normalizeRetainedEvidence
} from '../core/sync-branch-evidence-v2.mjs';
import {
  P02_CAPACITY_LIMITS,
  P02_CAPACITY_VERDICT,
  evaluateCapacity
} from '../core/sync-evidence-capacity-v2.mjs';
import { createP02AnchorSet } from '../core/sync-p02-anchor-set-v2.mjs';
import { P02_GATE_STATE, evaluateFormatGate } from '../core/sync-format-gate-v2.mjs';

export const P02_DESKTOP_ADMISSION_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncDesktopBranchAdmission.p02.v1',
  TABLE: 'sync_branch_evidence_state',
  CHAT_OBJECT_DOMAIN: 'studio.chat.saved-state.v1',
  /*
   * An evidence chain deeper than this is refused rather than walked. The bound
   * is an implementation choice, not a frozen contract: correctness never
   * depends on its value because the index is rebuilt from scratch each pass.
   * It exists so one object cannot make a pass unbounded.
   */
  MAX_EVIDENCE_DEPTH: 64
});

export const P02_DESKTOP_ADMISSION_ERROR = Object.freeze({
  DEPENDENCY_INVALID: 'p02-desktop-admission-dependency-invalid',
  INPUT_INVALID: 'p02-desktop-admission-input-invalid',
  GATE_NOT_ACTIVATED: 'p02-desktop-admission-gate-not-activated',
  ANCHOR_SOURCE_REFUSED: 'p02-desktop-admission-anchor-source-refused',
  DEPTH_EXCEEDED: 'p02-desktop-admission-depth-exceeded'
});

const SELECT_EVIDENCE =
  'SELECT revision_id, revision_blob_sha256_hex, parent_revision_id, '
  + 'parent_revision_blob_sha256_hex, branch_disposition, closure_type, '
  + 'selected_revision_id, selected_revision_blob_sha256_hex, proven, apply_state '
  + `FROM ${P02_DESKTOP_ADMISSION_V2.TABLE} WHERE peer_object_key = ? ORDER BY revision_id`;

const UPSERT_EVIDENCE =
  `INSERT INTO ${P02_DESKTOP_ADMISSION_V2.TABLE} (`
  + 'peer_object_key, object_id, revision_id, revision_blob_sha256_hex, '
  + 'parent_revision_id, parent_revision_blob_sha256_hex, branch_disposition, '
  + 'closure_type, selected_revision_id, selected_revision_blob_sha256_hex, '
  + 'proven, apply_state, rebuilt_at'
  + ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) '
  + 'ON CONFLICT(peer_object_key, revision_id) DO UPDATE SET '
  + 'revision_blob_sha256_hex = excluded.revision_blob_sha256_hex, '
  + 'parent_revision_id = excluded.parent_revision_id, '
  + 'parent_revision_blob_sha256_hex = excluded.parent_revision_blob_sha256_hex, '
  + 'branch_disposition = excluded.branch_disposition, '
  + 'closure_type = excluded.closure_type, '
  + 'selected_revision_id = excluded.selected_revision_id, '
  + 'selected_revision_blob_sha256_hex = excluded.selected_revision_blob_sha256_hex, '
  + 'proven = excluded.proven, '
  + 'rebuilt_at = excluded.rebuilt_at';

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

/*
 * Depth is measured over the evidence the candidate would join, not over the
 * repository. A chain longer than the bound is refused before the index is
 * built, so an adversarial ancestry cannot make index construction expensive.
 */
function chainDepth(records, candidate) {
  const byId = new Map(records.map((record) => [record.document.revisionId, record.document]));
  let depth = 1;
  let cursor = candidate.previousRevisionId;
  const seen = new Set([candidate.revisionId]);
  while (cursor !== null && cursor !== undefined) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    depth += 1;
    if (depth > P02_DESKTOP_ADMISSION_V2.MAX_EVIDENCE_DEPTH) return depth;
    const parent = byId.get(cursor);
    if (!parent) break;
    cursor = parent.previousRevisionId;
  }
  return depth;
}

export function createDesktopBranchEvidenceAdmission({
  sql,
  clock = () => new Date().toISOString(),
  peerObjectKeyFor,
  limits = P02_CAPACITY_LIMITS,
  objectDomain = P02_DESKTOP_ADMISSION_V2.CHAT_OBJECT_DOMAIN
} = {}) {
  if (!isPlainObject(sql) || typeof sql.select !== 'function' ||
      typeof sql.execute !== 'function' || typeof peerObjectKeyFor !== 'function') {
    fail(P02_DESKTOP_ADMISSION_ERROR.DEPENDENCY_INVALID);
  }

  /* Every row this module reads or writes is scoped to one (peer, object). */
  async function retainedFor(peerObjectKey) {
    const rows = await sql.select(SELECT_EVIDENCE, [peerObjectKey]);
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      revisionBlobSha256: clean(row.revision_blob_sha256_hex),
      disposition: clean(row.branch_disposition),
      applyState: clean(row.apply_state),
      document: {
        objectDomain,
        objectId: clean(row.object_id) || undefined,
        revisionId: clean(row.revision_id),
        previousRevisionId: row.parent_revision_id == null
          ? null : clean(row.parent_revision_id),
        previousRevisionBlobSha256: row.parent_revision_blob_sha256_hex == null
          ? null : clean(row.parent_revision_blob_sha256_hex),
        ...(row.closure_type == null ? {} : { closureType: clean(row.closure_type) }),
        ...(row.selected_revision_id == null ? {} : {
          selectedRevision: {
            revisionId: clean(row.selected_revision_id),
            revisionBlobSha256: clean(row.selected_revision_blob_sha256_hex)
          }
        })
      }
    }));
  }

  /*
   * The gate is consulted BEFORE anything else. Admitting evidence into a
   * repository whose format authority is missing, malformed or quarantined
   * would be writing into a repository we have no right to write into, and the
   * fact that this table is only a cache does not change that.
   */
  function requireActivatedGate(libraryInfo, repositoryHasContent, legacyBaselineMatches) {
    const gate = evaluateFormatGate({
      libraryInfo, repositoryHasContent, legacyBaselineMatches
    });
    if (gate.state !== P02_GATE_STATE.SUPPORTED || gate.mayWrite !== true) {
      fail(P02_DESKTOP_ADMISSION_ERROR.GATE_NOT_ACTIVATED, gate.state);
    }
    return gate;
  }

  async function admitRevision({
    objectId,
    objectKey,
    writerSyncPeerId,
    revision,
    revisionBlobSha256,
    revisionBytes = 0,
    headBytes = 0,
    protocolState = {},
    libraryInfo = null,
    repositoryHasContent = true,
    legacyBaselineMatches = true,
    /* Present only so it can be refused. See the module comment. */
    canonicalAnchorRevisionId = undefined
  } = {}) {
    if (canonicalAnchorRevisionId !== undefined) {
      /* The superseded rule, refused rather than silently ignored: a caller
       * that still passes it is operating on a model of ancestry that no
       * longer holds, and should find out here rather than downstream. */
      fail(P02_DESKTOP_ADMISSION_ERROR.ANCHOR_SOURCE_REFUSED);
    }
    const id = clean(objectId);
    const key = clean(objectKey);
    if (!id || !hex64(key) || !clean(writerSyncPeerId) ||
        !isPlainObject(revision) || !hex64(clean(revisionBlobSha256))) {
      fail(P02_DESKTOP_ADMISSION_ERROR.INPUT_INVALID);
    }
    const gate = requireActivatedGate(libraryInfo, repositoryHasContent, legacyBaselineMatches);

    const candidateRecord = {
      revisionBlobSha256: clean(revisionBlobSha256),
      document: { ...revision, objectDomain, objectId: id }
    };
    /* Malformed candidates quarantine rather than throwing, so one bad record
     * cannot stop the object's other evidence from being processed. */
    let normalized;
    try {
      normalized = normalizeRetainedEvidence(candidateRecord);
    } catch (error) {
      return Object.freeze({
        schema: P02_DESKTOP_ADMISSION_V2.SCHEMA,
        objectId: id,
        disposition: P02_ADMISSION_DISPOSITION.QUARANTINED,
        reason: clean(error?.code) || P02_BRANCH_EVIDENCE_ERROR.RECORD_INVALID,
        admitted: false, persisted: false, applyEligible: false
      });
    }

    const peerObjectKey = clean(await peerObjectKeyFor(writerSyncPeerId, key));
    if (!peerObjectKey) fail(P02_DESKTOP_ADMISSION_ERROR.INPUT_INVALID);

    const retained = await retainedFor(peerObjectKey);

    const depth = chainDepth(retained, normalized);
    if (depth > P02_DESKTOP_ADMISSION_V2.MAX_EVIDENCE_DEPTH) {
      return Object.freeze({
        schema: P02_DESKTOP_ADMISSION_V2.SCHEMA,
        objectId: id, peerObjectKey,
        disposition: P02_ADMISSION_DISPOSITION.QUARANTINED,
        reason: P02_DESKTOP_ADMISSION_ERROR.DEPTH_EXCEEDED,
        depth,
        admitted: false, persisted: false, applyEligible: false
      });
    }

    /*
     * The amended anchor: repository-proven v2 protocol pairs assembled by this
     * adapter, which is the only layer that knows the row is in the P02 regime.
     */
    const p02AnchorSet = createP02AnchorSet({
      objectDomain, objectId: id, protocolState
    });

    const index = buildBranchIndex({
      objectDomain, objectId: id, records: retained, p02AnchorSet
    });

    /* V9 first: capacity is a property of what is already retained, and a
     * refusal here must not be mistaken for a statement about ancestry. */
    const capacity = evaluateCapacity({
      retained: retained.map((record) => ({
        revisionId: record.document.revisionId,
        revisionBlobSha256: record.revisionBlobSha256,
        revisionBytes: 0, headBytes: 0
      })),
      candidate: {
        revisionId: normalized.revisionId,
        revisionBlobSha256: normalized.revisionBlobSha256,
        revisionBytes, headBytes,
        previousRevisionId: normalized.previousRevisionId,
        closureType: normalized.closureType ?? null,
        selectedRevision: normalized.selectedRevision ?? null
      },
      index,
      limits
    });
    if (capacity.verdict === P02_CAPACITY_VERDICT.INTEGRITY) {
      const row = await persist({
        peerObjectKey, objectId: id, node: normalized,
        disposition: P02_ADMISSION_DISPOSITION.QUARANTINED, proven: false
      });
      return Object.freeze({
        schema: P02_DESKTOP_ADMISSION_V2.SCHEMA,
        objectId: id, peerObjectKey,
        disposition: P02_ADMISSION_DISPOSITION.QUARANTINED,
        reason: P02_BRANCH_EVIDENCE_ERROR.IDENTITY_CONFLICT,
        admitted: false, persisted: row, applyEligible: false,
        capacity: capacity.verdict, gateState: gate.state
      });
    }
    if (!capacity.admitted) {
      /* Nothing retained is touched, nothing evicted, nothing written. */
      return Object.freeze({
        schema: P02_DESKTOP_ADMISSION_V2.SCHEMA,
        objectId: id, peerObjectKey,
        disposition: null,
        reason: 'capacity-exhausted',
        blockedReason: capacity.blockedReason,
        admitted: false, persisted: false, applyEligible: false,
        capacity: capacity.verdict,
        recoveryCritical: capacity.recoveryCritical,
        recoveryClass: capacity.recoveryClass,
        usage: capacity.usage, gateState: gate.state
      });
    }

    const admission = classifyAdmission({
      index, candidate: candidateRecord, p02AnchorSet,
      capacityAvailable: true
    });

    const persisted = admission.disposition === null
      ? false
      : await persist({
        peerObjectKey, objectId: id, node: normalized,
        disposition: admission.disposition,
        proven: admission.disposition === P02_ADMISSION_DISPOSITION.ACCEPTED_LINEAR ||
          admission.disposition === P02_ADMISSION_DISPOSITION.ADMITTED_CLOSURE
      });

    return Object.freeze({
      schema: P02_DESKTOP_ADMISSION_V2.SCHEMA,
      objectId: id, peerObjectKey,
      disposition: admission.disposition,
      reason: admission.reason ?? null,
      admitted: admission.disposition !== null,
      replay: admission.replay === true,
      applyEligible: admission.applyEligible === true,
      anchorConflict: admission.anchorConflict === true,
      persisted,
      capacity: capacity.verdict,
      recoveryCritical: capacity.recoveryCritical === true,
      recoveryClass: capacity.recoveryClass ?? null,
      gateState: gate.state,
      anchorPairs: p02AnchorSet.pairs.length
    });
  }

  async function persist({ peerObjectKey, objectId, node, disposition, proven }) {
    await sql.execute(UPSERT_EVIDENCE, [
      peerObjectKey,
      objectId,
      node.revisionId,
      node.revisionBlobSha256,
      node.previousRevisionId ?? null,
      node.previousRevisionBlobSha256 ?? null,
      disposition,
      node.closureType ?? null,
      node.selectedRevision?.revisionId ?? null,
      node.selectedRevision?.revisionBlobSha256 ?? null,
      proven ? 1 : 0,
      /* Admission never authorizes Apply; that is Y-9's decision, later. */
      'not-applied',
      clock()
    ]);
    return true;
  }

  /*
   * The whole point of "derived": the cache can be thrown away and rebuilt
   * from the retained evidence it was computed from, yielding the same rows.
   */
  async function rebuildIndex({ writerSyncPeerId, objectId, objectKey, protocolState = {} } = {}) {
    const peerObjectKey = clean(await peerObjectKeyFor(writerSyncPeerId, clean(objectKey)));
    const retained = await retainedFor(peerObjectKey);
    return buildBranchIndex({
      objectDomain,
      objectId: clean(objectId),
      records: retained,
      p02AnchorSet: createP02AnchorSet({
        objectDomain, objectId: clean(objectId), protocolState
      })
    });
  }

  return Object.freeze({
    schema: P02_DESKTOP_ADMISSION_V2.SCHEMA,
    admitRevision,
    rebuildIndex,
    /* Read-only view, object-scoped. Never an authority about what happened. */
    retainedFor: async ({ writerSyncPeerId, objectKey }) =>
      retainedFor(clean(await peerObjectKeyFor(clean(writerSyncPeerId), clean(objectKey))))
  });
}
