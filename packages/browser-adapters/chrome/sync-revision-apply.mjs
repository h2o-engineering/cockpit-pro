/* H2O Studio Sync — explicit Chrome admitted-revision canonical Apply.
 *
 * One caller-selected object only. Receive remains a separate transition.
 * Durable observation/evidence/apply-state authorities own correctness; this
 * module has no scheduler, folder, transport, credential, or network access.
 */

import { ITEM9_1_CONSTANTS } from './sync-object-store.mjs';
import { payloadSourceRevisionId } from '../../core/sync-p02-revision-mint-v2.mjs';
import {
  ITEM9_2_CONSTANTS,
  revalidateStoredAdmissionEvidence
} from './sync-revision-admission.mjs';

const ERROR_CODE = Object.freeze({
  INVALID_REQUEST: 'chrome-sync-apply-invalid-request',
  RUNTIME_UNAVAILABLE: 'chrome-sync-apply-runtime-unavailable',
  LEGACY_ADMISSION_EVIDENCE_INSUFFICIENT:
    ITEM9_1_CONSTANTS.ERROR_CODE.LEGACY_ADMISSION_EVIDENCE_INSUFFICIENT,
  NO_ELIGIBLE_REVISION: 'chrome-sync-apply-no-eligible-revision',
  LINEAGE_CONFLICT: 'chrome-sync-apply-lineage-conflict',
  APPLY_STATE_CONFLICT: 'chrome-sync-apply-state-conflict',
  CANONICAL_WRITE_FAILED: 'chrome-sync-apply-canonical-write-failed',
  CANONICAL_READBACK_FAILED: 'chrome-sync-apply-canonical-readback-failed',
  CONVERGENCE_PROOF_FAILED: 'chrome-sync-apply-convergence-proof-failed'
});

const ALLOWED_CODES = new Set([
  ...Object.values(ERROR_CODE),
  ...Object.values(ITEM9_1_CONSTANTS.ERROR_CODE),
  ...Object.values(ITEM9_2_CONSTANTS.ERROR_CODE)
]);

class ChromeSyncApplyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ChromeSyncApplyError';
    this.code = code;
  }
}

function fail(code) {
  throw new ChromeSyncApplyError(code);
}

function safeCode(error, fallback = ERROR_CODE.RUNTIME_UNAVAILABLE) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return ALLOWED_CODES.has(code) ? code : fallback;
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function isIdentifier(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function canonicalJson(value) {
  function normalize(item) {
    if (item === null ||
        typeof item === 'string' ||
        typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail(ERROR_CODE.CONVERGENCE_PROOF_FAILED);
      return item;
    }
    if (Array.isArray(item)) return item.map(normalize);
    if (!isPlainObject(item)) fail(ERROR_CODE.CONVERGENCE_PROOF_FAILED);
    const output = {};
    for (const key of Object.keys(item).sort()) {
      output[key] = normalize(item[key]);
    }
    return output;
  }
  return JSON.stringify(normalize(value));
}

function expectedSnapshot(payload, objectId, revisionId) {
  const chats = payload?.chatArchive?.chats;
  const chat = Array.isArray(chats) && chats.length === 1 ? chats[0] : null;
  const snapshots = chat?.snapshots;
  const snapshot = Array.isArray(snapshots) && snapshots.length === 1
    ? snapshots[0]
    : null;
  if (payload?.schema !== 'h2o.studio.fullBundle.v2' ||
      !chat ||
      chat.chatId !== objectId ||
      !snapshot ||
      snapshot.chatId !== objectId ||
      snapshot.snapshotId !== revisionId ||
      !Array.isArray(snapshot.messages) ||
      !Array.isArray(snapshot.meta?.richTurns)) {
    fail(ERROR_CODE.CONVERGENCE_PROOF_FAILED);
  }
  return snapshot;
}

function semanticSnapshot(snapshot) {
  if (!isPlainObject(snapshot) ||
      !Array.isArray(snapshot.messages) ||
      !Array.isArray(snapshot.meta?.richTurns)) return null;
  return {
    snapshotId: snapshot.snapshotId,
    chatId: snapshot.chatId,
    createdAt: snapshot.createdAt,
    messageCount: snapshot.messageCount,
    messages: snapshot.messages.map((message) => ({
      order: message?.order,
      role: message?.role,
      text: message?.text
    })),
    meta: {
      title: snapshot.meta.title,
      richTurns: snapshot.meta.richTurns.map((turn) => ({
        turnIdx: turn?.turnIdx,
        role: turn?.role,
        outerHTML: turn?.outerHTML,
        meta: isPlainObject(turn?.meta) ? turn.meta : null
      }))
    }
  };
}

function canonicalWriterBundle(payload) {
  if (!isPlainObject(payload) ||
      payload.schema !== 'h2o.studio.fullBundle.v2' ||
      !isPlainObject(payload.chatArchive)) {
    fail(ERROR_CODE.INVALID_REQUEST);
  }
  return {
    ...payload,
    chatArchive: {
      ...payload.chatArchive,
      schema: 'h2o.chatArchive.bundle.v1'
    }
  };
}

function referenceFrom(observation, evidence) {
  return Object.freeze({
    objectId: observation.objectId,
    revisionId: observation.revisionId,
    parentRevisionId: observation.parentRevisionId,
    observationKey: observation.key,
    revisionBlobSha256Hex: observation.revisionBlobSha256Hex,
    payloadSha256Hex: observation.payloadSha256Hex,
    headSha256Hex: evidence.headSha256Hex
  });
}

function referenceMatches(left, right) {
  return !!left && !!right &&
    left.revisionId === right.revisionId &&
    left.parentRevisionId === right.parentRevisionId &&
    left.observationKey === right.observationKey &&
    left.revisionBlobSha256Hex === right.revisionBlobSha256Hex &&
    left.payloadSha256Hex === right.payloadSha256Hex &&
    left.headSha256Hex === right.headSha256Hex;
}

function selectCandidate(snapshot, canonicalAnchor) {
  const observations = snapshot.observations;
  const evidenceByKey = new Map(
    snapshot.admissionEvidence.map((record) => [record.key, record])
  );
  const state = snapshot.applyState;
  if (state?.pending) {
    const observation = observations.find((record) =>
      record.key === state.pending.observationKey &&
      record.revisionId === state.pending.revisionId);
    if (!observation) fail(ERROR_CODE.APPLY_STATE_CONFLICT);
    return {
      kind: 'pending',
      observation,
      evidence: evidenceByKey.get(observation.key) || null
    };
  }
  if (observations.length === 0) return { kind: 'none' };
  if (canonicalAnchor === null) {
    const roots = observations.filter((record) =>
      record.parentRevisionId === null);
    if (roots.length !== 1) fail(ERROR_CODE.LINEAGE_CONFLICT);
    return {
      kind: 'candidate',
      observation: roots[0],
      evidence: evidenceByKey.get(roots[0].key) || null
    };
  }
  const materialized = observations.find((record) =>
    record.revisionId === canonicalAnchor.revisionId);
  const children = observations.filter((record) =>
    record.parentRevisionId === canonicalAnchor.revisionId);
  if (children.length > 1) fail(ERROR_CODE.LINEAGE_CONFLICT);
  if (children.length === 1) {
    return {
      kind: 'candidate',
      observation: children[0],
      evidence: evidenceByKey.get(children[0].key) || null
    };
  }
  if (!materialized) return { kind: 'none' };
  const materializedEvidence = evidenceByKey.get(materialized.key) || null;
  const remotelyApplied = !!state?.lastApplied && !!materializedEvidence &&
    referenceMatches(
      state.lastApplied,
      referenceFrom(materialized, materializedEvidence)
    );
  return {
    kind: remotelyApplied ? 'already-applied' : 'already-canonical',
    observation: materialized,
    evidence: materializedEvidence
  };
}

export function createChromeRevisionApply({
  syncStore,
  archiveAuthority,
  canonicalAnchorProvider,
  cryptoImplementation = globalThis.crypto
} = {}) {
  async function resolveCanonicalAnchor(objectId, fallbackApplyState = null) {
    if (typeof canonicalAnchorProvider !== 'function') {
      const reference = fallbackApplyState?.lastApplied || null;
      return reference
        ? Object.freeze({
          objectId,
          revisionId: reference.revisionId,
          revisionBlobSha256Hex: reference.revisionBlobSha256Hex,
          payloadSha256Hex: reference.payloadSha256Hex
        })
        : null;
    }
    const anchor = await canonicalAnchorProvider(objectId);
    if (anchor === null) return null;
    if (!isPlainObject(anchor) ||
        anchor.objectId !== objectId ||
        !isIdentifier(anchor.revisionId) ||
        !/^[0-9a-f]{64}$/.test(anchor.revisionBlobSha256Hex || '') ||
        !/^[0-9a-f]{64}$/.test(anchor.payloadSha256Hex || '')) {
      fail(ERROR_CODE.APPLY_STATE_CONFLICT);
    }
    return anchor;
  }

  async function revalidate(selection) {
    if (!selection.evidence) {
      fail(ERROR_CODE.LEGACY_ADMISSION_EVIDENCE_INSUFFICIENT);
    }
    return revalidateStoredAdmissionEvidence({
      observation: selection.observation,
      evidence: selection.evidence,
      cryptoImplementation
    });
  }

  async function readCanonical(candidate) {
    /*
     * A1 §4/§7 call-site rule. Both halves of this seam - the canonical
     * read-back and the identity equations inside expectedSnapshot - are about
     * CANONICAL state, which is keyed by the snapshot id the payload carries.
     * The envelope revisionId is engine-minted and names a transport address,
     * so loading canonical state by it would miss and comparing against it
     * would fail. The protocol ledger below keeps the envelope id, which is
     * the identity the repository actually published.
     *
     * In the v1 lane the two are the same value, so this is byte-identical
     * there. A payload whose two statements of its own identity disagree is
     * refused rather than read against whichever one happened to be picked.
     */
    const sourceRevisionId = payloadSourceRevisionId(candidate.payload);
    if (!sourceRevisionId) fail(ERROR_CODE.CONVERGENCE_PROOF_FAILED);
    let loaded;
    try {
      loaded = await archiveAuthority.loadSnapshot(sourceRevisionId);
    } catch (_) {
      fail(ERROR_CODE.CANONICAL_READBACK_FAILED);
    }
    if (!loaded) return Object.freeze({ state: 'missing' });
    const expected = semanticSnapshot(
      expectedSnapshot(
        candidate.payload,
        candidate.objectId,
        sourceRevisionId
      )
    );
    const actual = semanticSnapshot(loaded);
    if (!expected || !actual || canonicalJson(expected) !== canonicalJson(actual)) {
      return Object.freeze({ state: 'conflict' });
    }
    return Object.freeze({ state: 'converged' });
  }

  async function commit(candidate, verdict) {
    const committed = await syncStore.commitApplyIntent(
      candidate.objectId,
      candidate.revisionId
    );
    return Object.freeze({
      ok: true,
      verdict,
      unchangedNoOp: verdict === 'already-applied',
      objectId: candidate.objectId,
      revisionId: candidate.revisionId,
      parentRevisionId: candidate.parentRevisionId,
      writerSyncPeerId: candidate.writerSyncPeerId,
      lastAppliedRevisionId:
        committed.applyState.lastApplied.revisionId,
      pending: committed.applyState.pending
    });
  }

  async function applyNextAdmittedRevision(objectId) {
    if (!isIdentifier(objectId) ||
        !syncStore ||
        typeof syncStore.readApplySnapshot !== 'function' ||
        typeof syncStore.stageApplyIntent !== 'function' ||
        typeof syncStore.commitApplyIntent !== 'function' ||
        !archiveAuthority ||
        typeof archiveAuthority.importFullBundle !== 'function' ||
        typeof archiveAuthority.loadSnapshot !== 'function') {
      fail(ERROR_CODE.INVALID_REQUEST);
    }
    try {
      const snapshot = await syncStore.readApplySnapshot(objectId);
      const canonicalAnchor = await resolveCanonicalAnchor(
        objectId,
        snapshot.applyState
      );
      const selection = selectCandidate(snapshot, canonicalAnchor);
      if (selection.kind === 'none') {
        return Object.freeze({
          ok: true,
          verdict: 'no-eligible-revision',
          unchangedNoOp: true,
          objectId,
          revisionId: null
        });
      }
      const candidate = await revalidate(selection);
      if (selection.kind === 'already-canonical' ||
          selection.kind === 'already-applied') {
        const proof = await readCanonical(candidate);
        if (proof.state !== 'converged') {
          fail(ERROR_CODE.CONVERGENCE_PROOF_FAILED);
        }
        return Object.freeze({
          ok: true,
          verdict: selection.kind,
          unchangedNoOp: true,
          objectId,
          revisionId: candidate.revisionId,
          parentRevisionId: candidate.parentRevisionId,
          writerSyncPeerId: candidate.writerSyncPeerId,
          lastAppliedRevisionId: selection.kind === 'already-applied'
            ? candidate.revisionId
            : (snapshot.applyState?.lastApplied?.revisionId || null),
          pending: null
        });
      }

      if (selection.kind === 'pending') {
        const pendingReference = referenceFrom(
          selection.observation,
          selection.evidence
        );
        if (!referenceMatches(snapshot.applyState.pending, pendingReference)) {
          fail(ERROR_CODE.APPLY_STATE_CONFLICT);
        }
        const recoveryProof = await readCanonical(candidate);
        if (recoveryProof.state === 'converged') {
          return commit(candidate, 'reconciled-applied');
        }
        if (recoveryProof.state === 'conflict') {
          fail(ERROR_CODE.CONVERGENCE_PROOF_FAILED);
        }
        const recoveryAnchor = await resolveCanonicalAnchor(
          objectId,
          snapshot.applyState
        );
        if ((candidate.parentRevisionId === null && recoveryAnchor !== null) ||
            (candidate.parentRevisionId !== null &&
              recoveryAnchor?.revisionId !== candidate.parentRevisionId)) {
          fail(ERROR_CODE.APPLY_STATE_CONFLICT);
        }
      } else {
        const staged = await syncStore.stageApplyIntent(
          {
            ...referenceFrom(selection.observation, selection.evidence),
            canonicalAnchorRevisionId: canonicalAnchor?.revisionId || null
          }
        );
        if (staged.verdict === 'already-applied') {
          const proof = await readCanonical(candidate);
          if (proof.state !== 'converged') {
            fail(ERROR_CODE.CONVERGENCE_PROOF_FAILED);
          }
          return Object.freeze({
            ok: true,
            verdict: 'already-applied',
            unchangedNoOp: true,
            objectId,
            revisionId: candidate.revisionId,
            parentRevisionId: candidate.parentRevisionId,
            writerSyncPeerId: candidate.writerSyncPeerId,
            lastAppliedRevisionId: candidate.revisionId,
            pending: null
          });
        }
        if (staged.verdict === 'pending-existing') {
          const concurrentProof = await readCanonical(candidate);
          if (concurrentProof.state === 'converged') {
            return commit(candidate, 'reconciled-applied');
          }
          if (concurrentProof.state === 'conflict') {
            fail(ERROR_CODE.CONVERGENCE_PROOF_FAILED);
          }
          fail(ITEM9_1_CONSTANTS.ERROR_CODE.APPLY_PENDING_UNRESOLVED);
        }
      }

      const beforeWriteAnchor = await resolveCanonicalAnchor(
        objectId,
        snapshot.applyState
      );
      if ((candidate.parentRevisionId === null && beforeWriteAnchor !== null) ||
          (candidate.parentRevisionId !== null &&
            beforeWriteAnchor?.revisionId !== candidate.parentRevisionId)) {
        const concurrentProof = await readCanonical(candidate);
        if (concurrentProof.state === 'converged') {
          return commit(candidate, 'reconciled-applied');
        }
        fail(ERROR_CODE.APPLY_STATE_CONFLICT);
      }

      try {
        await archiveAuthority.importFullBundle({
          bundle: canonicalWriterBundle(candidate.payload),
          mode: 'merge'
        });
      } catch (_) {
        fail(ERROR_CODE.CANONICAL_WRITE_FAILED);
      }
      const proof = await readCanonical(candidate);
      if (proof.state !== 'converged') {
        fail(ERROR_CODE.CONVERGENCE_PROOF_FAILED);
      }
      return commit(candidate, 'applied');
    } catch (error) {
      throw new ChromeSyncApplyError(safeCode(error));
    }
  }

  return Object.freeze({ applyNextAdmittedRevision });
}

export const CHROME_SYNC_APPLY_CONSTANTS = Object.freeze({ ERROR_CODE });
