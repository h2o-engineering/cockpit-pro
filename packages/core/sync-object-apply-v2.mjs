/*
 * O1-T14 — v2 Apply core: hop selection and apply-time verification.
 *
 * Admission decided that a revision is real and how it relates to what we hold.
 * Apply is a different question - may we write this into canonical state right
 * now - and it re-asks things admission already answered, on purpose.
 *
 * APPLY-TIME BYTE VERIFICATION. Evidence recorded at admission says what the
 * bytes WERE. Apply must prove what they ARE, because the gap between the two
 * spans an unbounded amount of time and an untrusted folder that anything on
 * the machine can write to. Retained evidence is a record, not a lock, so the
 * bytes are re-read and re-hashed and must still equal the evidence-recorded
 * address before a single canonical row changes.
 *
 * ONE HOP PER PASS. When the selected leaf is several revisions ahead, exactly
 * one proven next hop is applied. The domain importer applies content, and
 * content applied out of order is content applied wrongly: jumping to the leaf
 * would skip intermediate canonical states that later revisions were authored
 * against. The hop must be admitted, proven, on the selected leaf's chain, and
 * exactly one step beyond the current anchor - four conditions, because three
 * of them are individually satisfiable by a sibling.
 *
 * TWO IDENTITY DOMAINS, NEVER CROSSED. The payload's source identity is what
 * canonical validation and import use. The envelope revisionId is what the
 * protocol ledger records. Writing a mint into canonical snapshot identity
 * would corrupt the source domain with transport addresses; recording a
 * snapshot id as a protocol anchor would claim ancestry a payload hash cannot
 * establish.
 *
 * CLOSURES ARE SCOPED OUT of content-payload predicates. A deletion closure has
 * no content to converge, so asking whether its payload matches canonical state
 * is a question with no true answer. Its convergence comes from the closure and
 * classification semantics instead.
 *
 * Platform-neutral: every capability is injected. No store, no filesystem, no
 * SQL, no chrome API, no clock.
 */

import { P02_ATTEMPT_OUTCOME } from './sync-object-scheduler-v2.mjs';
import { payloadSourceRevisionId } from './sync-p02-revision-mint-v2.mjs';

export const P02_APPLY_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncObjectApply.p02.v1',
  DIRECTION_APPLIED: 'applied'
});

export const P02_APPLY_VERDICT = Object.freeze({
  APPLIED: 'applied',
  PENDING_RECOVERED: 'pending-recovered',
  /* Already at this revision. Idempotent, and not a mutation. */
  ALREADY_APPLIED: 'already-applied',
  /* Nothing proven to apply right now. */
  NO_ELIGIBLE_HOP: 'no-eligible-hop',
  BLOCKED: 'blocked',
  INTEGRITY: 'integrity'
});

export const P02_APPLY_ERROR = Object.freeze({
  DEPENDENCY_INVALID: 'p02-apply-dependency-invalid',
  CANDIDATE_INVALID: 'p02-apply-candidate-invalid',
  BYTES_MISSING: 'p02-apply-revision-bytes-missing',
  BYTES_CHANGED: 'p02-apply-revision-bytes-changed',
  ENVELOPE_INVALID: 'p02-apply-envelope-invalid',
  PAYLOAD_IDENTITY_INVALID: 'p02-apply-payload-identity-invalid',
  PARENT_PAIR_MISMATCH: 'p02-apply-parent-pair-mismatch',
  HOP_AMBIGUOUS: 'p02-apply-hop-ambiguous',
  HOP_NOT_ADMITTED: 'p02-apply-hop-not-admitted',
  HOP_NOT_PROVEN: 'p02-apply-hop-not-proven',
  INTENT_STAGE_FAILED: 'p02-apply-intent-stage-failed',
  PENDING_UNRESOLVED: 'p02-apply-pending-unresolved',
  PRECONDITION_FAILED: 'p02-apply-anchor-precondition-failed',
  READBACK_FAILED: 'p02-apply-readback-convergence-failed',
  COMMIT_FAILED: 'p02-apply-commit-failed'
});

const HEX64 = /^[0-9a-f]{64}$/;
const hex64 = (value) => typeof value === 'string' && HEX64.test(value);
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireFunction(value, code) {
  if (typeof value !== 'function') throw new TypeError(code);
  return value;
}

const pairKey = (revisionId, revisionBlobSha256) =>
  `${clean(revisionId)} ${clean(revisionBlobSha256)}`;

const refuse = (verdict, reason, extra = {}) => Object.freeze({
  schema: P02_APPLY_V2.SCHEMA,
  verdict, reason, applied: false, canonicalMutated: false,
  outcome: verdict === P02_APPLY_VERDICT.BLOCKED
    ? P02_ATTEMPT_OUTCOME.BLOCKED
    : verdict === P02_APPLY_VERDICT.INTEGRITY
      ? P02_ATTEMPT_OUTCOME.INTEGRITY
      : P02_ATTEMPT_OUTCOME.NO_EFFECT,
  ...extra
});

/*
 * Select exactly one hop.
 *
 * `chain` is the selected leaf's proven ancestry, ordered root-first. The hop
 * is the revision immediately after the current anchor - not the leaf, and not
 * whichever sibling happens to sort first.
 */
export function selectApplyHop({
  chain = [],
  currentAnchor = null,
  admittedPairs = new Set()
} = {}) {
  if (!Array.isArray(chain) || chain.length === 0) {
    return { hop: null, reason: P02_APPLY_ERROR.HOP_NOT_PROVEN, remaining: 0 };
  }
  const anchorKey = currentAnchor
    ? pairKey(currentAnchor.revisionId, currentAnchor.revisionBlobSha256)
    : null;

  let index = 0;
  if (anchorKey !== null) {
    const position = chain.findIndex((node) =>
      pairKey(node.revisionId, node.revisionBlobSha256) === anchorKey);
    if (position === -1) {
      /*
       * The anchor is not on this leaf's chain, so the leaf does not descend
       * from what we have applied. That is a fork, and choosing a hop would be
       * choosing a side.
       */
      return { hop: null, reason: P02_APPLY_ERROR.HOP_AMBIGUOUS, remaining: chain.length };
    }
    index = position + 1;
  }
  if (index >= chain.length) {
    return { hop: null, reason: null, remaining: 0, alreadyApplied: true };
  }
  const hop = chain[index];
  if (!admittedPairs.has(pairKey(hop.revisionId, hop.revisionBlobSha256))) {
    /* Proven ancestry is not admission. A hop we have not admitted has not been
     * through capacity, identity or disposition checks. */
    return { hop: null, reason: P02_APPLY_ERROR.HOP_NOT_ADMITTED, remaining: chain.length - index };
  }
  return {
    hop,
    reason: null,
    /* Reported so a caller can tell "one of five" from "the last one". */
    remaining: chain.length - index - 1,
    isLeaf: index === chain.length - 1
  };
}

/*
 * Re-verify the bytes at apply time and split the two identity domains.
 *
 * Returns the ENVELOPE identity for the protocol ledger and the PAYLOAD source
 * identity for canonical import, deliberately as separate fields so a caller
 * cannot reach for "the id" and get the wrong one.
 */
export function verifyApplyCandidate({
  candidate,
  bytes,
  observedRevisionBlobSha256,
  observedPayloadSha256 = null,
  expectedParent = undefined
} = {}) {
  if (!isPlainObject(candidate) || !isPlainObject(candidate.revision)) {
    return { ok: false, reason: P02_APPLY_ERROR.CANDIDATE_INVALID };
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    return { ok: false, reason: P02_APPLY_ERROR.BYTES_MISSING };
  }
  /*
   * The evidence-recorded address must still equal the bytes in hand. Retained
   * evidence records what the bytes WERE; only this proves what they ARE.
   */
  if (!hex64(clean(observedRevisionBlobSha256)) ||
      clean(observedRevisionBlobSha256) !== clean(candidate.revisionBlobSha256)) {
    return { ok: false, reason: P02_APPLY_ERROR.BYTES_CHANGED };
  }

  const revision = candidate.revision;
  if (clean(revision.revisionId) !== clean(candidate.revisionId) ||
      !clean(revision.objectId) || !clean(revision.objectDomain) ||
      !hex64(clean(revision.payloadSha256)) || !isPlainObject(revision.payload)) {
    return { ok: false, reason: P02_APPLY_ERROR.ENVELOPE_INVALID };
  }
  if (observedPayloadSha256 !== null &&
      clean(observedPayloadSha256) !== clean(revision.payloadSha256)) {
    return { ok: false, reason: P02_APPLY_ERROR.PAYLOAD_IDENTITY_INVALID };
  }

  /* The parent PAIR must be exactly what the caller proved, both halves. */
  if (expectedParent !== undefined) {
    const expectedId = expectedParent?.revisionId ?? null;
    const expectedBlob = expectedParent?.revisionBlobSha256 ?? null;
    if ((revision.previousRevisionId ?? null) !== expectedId ||
        (revision.previousRevisionBlobSha256 ?? null) !== expectedBlob) {
      return { ok: false, reason: P02_APPLY_ERROR.PARENT_PAIR_MISMATCH };
    }
  }

  const closureType = revision.closureType ?? null;
  /*
   * A closure carries no content payload to import, so it has no source
   * identity to resolve and must not be asked for one.
   */
  const sourceRevisionId = closureType === null
    ? payloadSourceRevisionId(revision.payload)
    : null;
  if (closureType === null && !sourceRevisionId) {
    return { ok: false, reason: P02_APPLY_ERROR.PAYLOAD_IDENTITY_INVALID };
  }

  return {
    ok: true,
    reason: null,
    closureType,
    /* For the protocol ledger. Never written into canonical identity. */
    envelope: Object.freeze({
      revisionId: clean(revision.revisionId),
      revisionBlobSha256: clean(candidate.revisionBlobSha256),
      payloadSha256: clean(revision.payloadSha256)
    }),
    /* For canonical validation and import. Never a protocol anchor. */
    source: Object.freeze({
      revisionId: sourceRevisionId,
      payload: revision.payload
    })
  };
}

/*
 * The platform-neutral Apply sequence. Ports do the platform work; the ORDER
 * and the refusals are here.
 */
export function createP02ApplyComposition({
  readRevisionBytes,
  sha256HexBytes,
  provenChainFor,
  admittedPairsFor,
  stageApplyIntent,
  recheckCanonicalPrecondition,
  importCanonicalPayload,
  readCanonicalConvergence,
  commitApplied,
  applyClosure = null
} = {}) {
  requireFunction(readRevisionBytes, P02_APPLY_ERROR.DEPENDENCY_INVALID);
  requireFunction(sha256HexBytes, P02_APPLY_ERROR.DEPENDENCY_INVALID);
  requireFunction(provenChainFor, P02_APPLY_ERROR.DEPENDENCY_INVALID);
  requireFunction(admittedPairsFor, P02_APPLY_ERROR.DEPENDENCY_INVALID);
  requireFunction(stageApplyIntent, P02_APPLY_ERROR.DEPENDENCY_INVALID);
  requireFunction(recheckCanonicalPrecondition, P02_APPLY_ERROR.DEPENDENCY_INVALID);
  requireFunction(importCanonicalPayload, P02_APPLY_ERROR.DEPENDENCY_INVALID);
  requireFunction(readCanonicalConvergence, P02_APPLY_ERROR.DEPENDENCY_INVALID);
  requireFunction(commitApplied, P02_APPLY_ERROR.DEPENDENCY_INVALID);
  if (applyClosure !== null) requireFunction(applyClosure, P02_APPLY_ERROR.DEPENDENCY_INVALID);

  async function applyOneHop({
    objectDomain, objectId, objectKey, syncPeerId,
    selectedLeaf, currentAnchor = null
  } = {}) {
    const scope = { objectDomain, objectId, objectKey, syncPeerId };
    if (!clean(objectId) || !hex64(clean(objectKey)) || !isPlainObject(selectedLeaf)) {
      return refuse(P02_APPLY_VERDICT.INTEGRITY, P02_APPLY_ERROR.CANDIDATE_INVALID);
    }

    let chain;
    try {
      chain = await provenChainFor({ ...scope, leaf: selectedLeaf });
    } catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || 'chain-unavailable',
        { blockReason: 'transport' });
    }
    const admittedPairs = new Set(
      (await admittedPairsFor(scope) || []).map((pair) =>
        pairKey(pair.revisionId, pair.revisionBlobSha256))
    );

    const selection = selectApplyHop({ chain, currentAnchor, admittedPairs });
    if (selection.alreadyApplied === true) {
      /* Idempotent: nothing to do, and explicitly not a mutation. */
      return Object.freeze({
        schema: P02_APPLY_V2.SCHEMA,
        verdict: P02_APPLY_VERDICT.ALREADY_APPLIED,
        applied: false, canonicalMutated: false, reason: null, remaining: 0,
        outcome: P02_ATTEMPT_OUTCOME.NO_EFFECT
      });
    }
    if (selection.hop === null) {
      const blocked = selection.reason === P02_APPLY_ERROR.HOP_NOT_ADMITTED;
      return refuse(
        blocked ? P02_APPLY_VERDICT.BLOCKED : P02_APPLY_VERDICT.NO_ELIGIBLE_HOP,
        selection.reason,
        blocked ? { blockReason: 'transport' } : {}
      );
    }
    const hop = selection.hop;

    /* Apply-time byte verification. The bytes are re-read now, not trusted
     * from admission. */
    let read;
    try {
      read = await readRevisionBytes({ ...scope, ...hop });
    } catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || 'revision-read-failed',
        { blockReason: 'transport' });
    }
    const status = clean(read?.status);
    if (status === 'absent' || status === 'missing') {
      return refuse(P02_APPLY_VERDICT.BLOCKED, P02_APPLY_ERROR.BYTES_MISSING,
        { blockReason: 'transport' });
    }
    if (status === 'blocked(permission)') {
      return refuse(P02_APPLY_VERDICT.BLOCKED, 'permission', { blockReason: 'permission' });
    }
    if (status !== 'verified' || !(read?.bytes instanceof Uint8Array)) {
      return refuse(P02_APPLY_VERDICT.INTEGRITY, clean(read?.reason) || status || 'unverified');
    }

    const observed = clean(await sha256HexBytes(read.bytes));
    const verification = verifyApplyCandidate({
      candidate: { ...hop, revision: read.value },
      bytes: read.bytes,
      observedRevisionBlobSha256: observed,
      expectedParent: currentAnchor === null
        ? undefined
        : { revisionId: currentAnchor.revisionId, revisionBlobSha256: currentAnchor.revisionBlobSha256 }
    });
    if (!verification.ok) {
      return refuse(P02_APPLY_VERDICT.INTEGRITY, verification.reason);
    }

    /*
     * Closures bypass content import entirely: there is no payload to write,
     * and asking whether one converges with canonical content has no answer.
     */
    if (verification.closureType !== null) {
      if (applyClosure === null) {
        return refuse(P02_APPLY_VERDICT.NO_ELIGIBLE_HOP, 'closure-apply-unavailable');
      }
      let closureResult;
      try {
        closureResult = await applyClosure({
          ...scope, closureType: verification.closureType, envelope: verification.envelope
        });
      } catch (error) {
        return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || 'closure-apply-failed',
          { blockReason: 'transport' });
      }
      if (closureResult?.ok !== true) {
        return refuse(P02_APPLY_VERDICT.INTEGRITY, clean(closureResult?.reason) || 'closure-apply-refused');
      }
      await commitApplied({
        ...scope,
        revisionId: verification.envelope.revisionId,
        revisionBlobSha256: verification.envelope.revisionBlobSha256,
        payloadSha256: verification.envelope.payloadSha256,
        direction: P02_APPLY_V2.DIRECTION_APPLIED,
        closureType: verification.closureType
      });
      return Object.freeze({
        schema: P02_APPLY_V2.SCHEMA,
        verdict: P02_APPLY_VERDICT.APPLIED,
        applied: true, canonicalMutated: true, closure: true,
        reason: null,
        envelope: verification.envelope,
        remaining: selection.remaining
      });
    }

    /*
     * Durable intent is the mutation boundary. A fresh operation stages before
     * canonical import. A retained pending intent is uncertainty, never retry
     * permission: first prove whether the prior import already converged. If it
     * did, commit without another import; otherwise leave it pending and block.
     */
    let staged;
    try {
      staged = await stageApplyIntent({
        ...scope,
        hop,
        selectedLeaf,
        currentAnchor,
        verification
      });
    } catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED,
        clean(error?.code) || P02_APPLY_ERROR.INTENT_STAGE_FAILED);
    }
    const stageVerdict = clean(staged?.verdict);
    if (stageVerdict === 'already-applied' || stageVerdict === 'pending-existing') {
      let recovery;
      try {
        recovery = await readCanonicalConvergence({
          ...scope, hop, selectedLeaf, currentAnchor, verification, staged
        });
      } catch (error) {
        return refuse(P02_APPLY_VERDICT.BLOCKED,
          clean(error?.code) || P02_APPLY_ERROR.READBACK_FAILED);
      }
      if (recovery?.state !== 'converged') {
        return refuse(P02_APPLY_VERDICT.BLOCKED,
          stageVerdict === 'pending-existing'
            ? P02_APPLY_ERROR.PENDING_UNRESOLVED
            : P02_APPLY_ERROR.READBACK_FAILED,
          { pending: stageVerdict === 'pending-existing' });
      }
      if (stageVerdict === 'already-applied') {
        return Object.freeze({
          schema: P02_APPLY_V2.SCHEMA,
          verdict: P02_APPLY_VERDICT.ALREADY_APPLIED,
          applied: false, canonicalMutated: false, reason: null,
          remaining: selection.remaining,
          outcome: P02_ATTEMPT_OUTCOME.NO_EFFECT
        });
      }
      try {
        await commitApplied({
          ...scope,
          revisionId: verification.envelope.revisionId,
          revisionBlobSha256: verification.envelope.revisionBlobSha256,
          payloadSha256: verification.envelope.payloadSha256,
          direction: P02_APPLY_V2.DIRECTION_APPLIED,
          closureType: null,
          staged
        });
      } catch (error) {
        return refuse(P02_APPLY_VERDICT.BLOCKED,
          clean(error?.code) || P02_APPLY_ERROR.COMMIT_FAILED,
          { pending: true });
      }
      return Object.freeze({
        schema: P02_APPLY_V2.SCHEMA,
        verdict: P02_APPLY_VERDICT.PENDING_RECOVERED,
        applied: true, canonicalMutated: false, recovered: true, reason: null,
        envelope: verification.envelope,
        remaining: selection.remaining,
        isLeaf: selection.isLeaf === true,
        outcome: P02_ATTEMPT_OUTCOME.PROGRESS
      });
    }
    if (stageVerdict !== 'intent-staged') {
      return refuse(P02_APPLY_VERDICT.BLOCKED, P02_APPLY_ERROR.INTENT_STAGE_FAILED);
    }

    let precondition;
    try {
      precondition = await recheckCanonicalPrecondition({
        ...scope, hop, selectedLeaf, currentAnchor, verification, staged
      });
    } catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED,
        clean(error?.code) || P02_APPLY_ERROR.PRECONDITION_FAILED,
        { pending: true });
    }
    if (precondition?.ok !== true) {
      return refuse(P02_APPLY_VERDICT.BLOCKED,
        clean(precondition?.reason) || P02_APPLY_ERROR.PRECONDITION_FAILED,
        { pending: true });
    }

    /* Content apply. Canonical work uses the PAYLOAD's source identity. */
    let imported;
    try {
      imported = await importCanonicalPayload({
        ...scope,
        payload: verification.source.payload,
        sourceRevisionId: verification.source.revisionId
      });
    } catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED, clean(error?.code) || 'canonical-import-failed',
        { blockReason: 'transport' });
    }
    if (imported?.ok !== true) {
      return refuse(P02_APPLY_VERDICT.INTEGRITY, clean(imported?.reason) || 'canonical-import-refused');
    }

    let convergence;
    try {
      convergence = await readCanonicalConvergence({
        ...scope, hop, selectedLeaf, currentAnchor, verification, staged
      });
    } catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED,
        clean(error?.code) || P02_APPLY_ERROR.READBACK_FAILED,
        { pending: true, canonicalMutated: true });
    }
    if (convergence?.state !== 'converged') {
      return refuse(P02_APPLY_VERDICT.INTEGRITY,
        clean(convergence?.reason) || P02_APPLY_ERROR.READBACK_FAILED,
        { pending: true, canonicalMutated: true });
    }

    /*
     * The ledger records the ENVELOPE identity plus the payload hash and the
     * applied direction, in one lockstep write. Canonical state keeps the
     * source identity it has always used; the mint never enters it.
     */
    try {
      await commitApplied({
        ...scope,
        revisionId: verification.envelope.revisionId,
        revisionBlobSha256: verification.envelope.revisionBlobSha256,
        payloadSha256: verification.envelope.payloadSha256,
        direction: P02_APPLY_V2.DIRECTION_APPLIED,
        closureType: null,
        staged
      });
    } catch (error) {
      return refuse(P02_APPLY_VERDICT.BLOCKED,
        clean(error?.code) || P02_APPLY_ERROR.COMMIT_FAILED,
        { pending: true, canonicalMutated: true });
    }

    return Object.freeze({
      schema: P02_APPLY_V2.SCHEMA,
      verdict: P02_APPLY_VERDICT.APPLIED,
      applied: true, canonicalMutated: true, closure: false, reason: null,
      envelope: verification.envelope,
      /* Reported so a driver knows another pass is warranted. */
      remaining: selection.remaining,
      isLeaf: selection.isLeaf === true,
      outcome: P02_ATTEMPT_OUTCOME.PROGRESS
    });
  }

  return Object.freeze({ schema: P02_APPLY_V2.SCHEMA, applyOneHop });
}
