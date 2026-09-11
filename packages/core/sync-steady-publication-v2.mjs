/*
 * O1-T18 — steady publication composition.
 *
 * Publication N+1, over a writer that already owns a pointer and a library of
 * other objects. The first publication (V8-C3) could build its snapshot from
 * nothing; this one cannot, because everything else the writer advertises has
 * to survive the write.
 *
 * COMPLETE IN SOURCE, INERT IN PRODUCT. Nothing here registers a listener, arms
 * a timer, binds a real repository or creates a writer-generation record. The
 * only way to reach it is for a caller to construct it and call it, and the only
 * caller today is a disposable test. That is deliberate: steady publication has
 * no authority to run until the governed standdown (T19) records the p02
 * generation and a separate activation gate opens.
 *
 * THE CAS TOKEN IS THE LOAD-BEARING PART. `publishBatch` still has a
 * compatibility path that re-reads the pointer when no expected-current token is
 * supplied. Steady publication must NEVER take it. The token is captured from
 * the SAME readWriterState that supplied the merge base and travels with the
 * plan, so the precondition and the plan describe one state. Letting the
 * primitive re-read would silently rebaseline onto a pointer that moved after
 * planning, and the CAS would then confirm a state nobody inspected - which is
 * precisely the failure a CAS exists to prevent, arrived at through the code
 * that implements it.
 *
 * ORDER MATTERS, AND THE ORDER IS THE CONTRACT.
 *
 *   Intent recovery runs FIRST. An object with a retained intent is a
 *   publication already in flight; treating it as a fresh candidate would mint
 *   a competitor for a revision that may already exist in the repository.
 *
 *   The mint happens BEFORE durable intent and never again after it. Before the
 *   intent is written a mint can simply vanish - nothing references it. After
 *   it, the mint is the identity the repository may already hold, so recovery
 *   reuses it rather than starting over.
 *
 *   Durable intent is written BEFORE any repository mutation, so a crash between
 *   them leaves something to recover rather than an orphan nobody remembers.
 *
 * Platform-neutral. Every capability is injected; there is no store, filesystem,
 * native command or clock in this file.
 */

import {
  P02_PARENT_SELECTION,
  classifyIntentRecovery,
  evaluateOnboardingEligibility,
  selectPublicationParent
} from './sync-p02-descendant-publication-v2.mjs';
import { P02_HEADS_MERGE_V2, planHeadsMerge } from './sync-p02-heads-merge-v2.mjs';
import { P02_ATTEMPT_OUTCOME } from './sync-object-scheduler-v2.mjs';
import { P02_RECOVERY_DISPOSITION } from './sync-p02-descendant-publication-v2.mjs';

export const P02_STEADY_PUBLICATION_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncSteadyPublication.p02.v1',
  /* Stated in the module surface so a reader does not have to infer it. */
  DORMANT: true
});

export const P02_STEADY_OUTCOME = Object.freeze({
  COMMITTED: 'committed',
  /* Nothing to publish. Not a failure. */
  NOT_ELIGIBLE: 'not-eligible',
  /* A retained intent was reconciled instead of a new publication. */
  RECOVERED: 'recovered',
  /* The base moved under the plan. Re-plan on a fresh read. */
  STALE_BASE: 'stale-base',
  BLOCKED: 'blocked',
  INTEGRITY: 'integrity',
  /* Authority was withdrawn before anything was written. */
  AUTHORITY_REFUSED: 'authority-refused'
});

export const P02_STEADY_ERROR = Object.freeze({
  DEPENDENCY_INVALID: 'p02-steady-publication-dependency-invalid',
  CAS_TOKEN_REQUIRED: 'p02-steady-publication-cas-token-required',
  BASE_UNPROVEN: 'p02-steady-publication-base-unproven',
  LEASE_REFUSED: 'p02-steady-publication-lease-refused',
  INTENT_FAILED: 'p02-steady-publication-intent-failed',
  PRODUCE_FAILED: 'p02-steady-publication-produce-failed',
  AUTHORITY_CHANGED: 'p02-steady-publication-authority-changed',
  SOURCE_TIMESTAMP_MISSING: 'p02-steady-publication-source-timestamp-missing'
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

const result = (outcome, reason, extra = {}) => Object.freeze({
  schema: P02_STEADY_PUBLICATION_V2.SCHEMA,
  outcome, reason: clean(reason) || null,
  published: outcome === P02_STEADY_OUTCOME.COMMITTED,
  repositoryMutated: extra.repositoryMutated === true,
  ...extra
});

export function createP02SteadyPublication({
  /* --- injected ports. Nothing is imported from a platform. --- */
  readWriterState,
  readProtocolState,
  readCanonicalProjection,
  proveAnchor,
  probeDescent,
  mintRevisionId,
  produceRevision,
  recordIntent,
  completePublication,
  abandonIntent,
  beginSteadyLease,
  finishSteadyLease,
  createTransport,
  observeAuthority,
  healPublishedIdentity = null,
  onTrace = null
} = {}) {
  for (const [port, name] of [
    [readWriterState, 'readWriterState'], [readProtocolState, 'readProtocolState'],
    [readCanonicalProjection, 'readCanonicalProjection'], [proveAnchor, 'proveAnchor'],
    [probeDescent, 'probeDescent'], [mintRevisionId, 'mintRevisionId'],
    [produceRevision, 'produceRevision'], [recordIntent, 'recordIntent'],
    [completePublication, 'completePublication'], [abandonIntent, 'abandonIntent'],
    [beginSteadyLease, 'beginSteadyLease'], [finishSteadyLease, 'finishSteadyLease'],
    [createTransport, 'createTransport'], [observeAuthority, 'observeAuthority']
  ]) {
    if (typeof port !== 'function') {
      throw new TypeError(`${P02_STEADY_ERROR.DEPENDENCY_INVALID}:${name}`);
    }
  }
  if (healPublishedIdentity !== null) {
    requireFunction(healPublishedIdentity, P02_STEADY_ERROR.DEPENDENCY_INVALID);
  }
  const trace = onTrace === null ? null : requireFunction(onTrace, P02_STEADY_ERROR.DEPENDENCY_INVALID);
  const emit = (record) => { if (trace) trace(record); };

  /*
   * Authority is observed twice: once before any work, and once immediately
   * before the mutating call. A grant captured at the start of an attempt is
   * not evidence that authority still holds when the write happens, and an
   * attempt that spans an authority change must abort rather than complete on
   * a grant that has since been withdrawn.
   */
  async function requireAuthority(scope, moment) {
    let authority;
    try {
      authority = await observeAuthority({ ...scope, moment });
    } catch (error) {
      return { ok: false, refusal: result(P02_STEADY_OUTCOME.BLOCKED,
        clean(error?.code) || 'authority-unreadable', { blockReason: 'transport' }) };
    }
    if (authority?.permitted !== true) {
      return { ok: false, refusal: result(P02_STEADY_OUTCOME.AUTHORITY_REFUSED,
        clean(authority?.reason) || 'authority-refused',
        { blockReason: clean(authority?.blockReason) || null, moment }) };
    }
    return { ok: true, authority };
  }

  /*
   * Step 3, and it runs before eligibility on purpose. A retained intent means a
   * publication is already in flight; asking whether the object is "dirty" would
   * answer a different question and could mint a competing revision for a
   * revision the repository may already hold.
   */
  async function reconcileRetainedIntent(scope, protocolState) {
    /*
     * Recovery applies only when there IS something to recover. Running the
     * classifier on an object with no retained intent would reach its pointer
     * check and abort on an unread pointer - turning "nothing in flight" into
     * "blocked", which would stop every ordinary publication before it began.
     */
    const hasRetainedIntent = clean(protocolState?.pendingOperation) !== '' ||
      clean(protocolState?.intendedRevisionId) !== '' ||
      isPlainObject(protocolState?.adoptIntent);
    if (!hasRetainedIntent) return { handled: false, noIntent: true };

    const disposition = classifyIntentRecovery({
      pendingOperation: protocolState?.pendingOperation ?? null,
      intendedRevisionId: protocolState?.intendedRevisionId ?? null,
      intendedRevisionBlobSha256: protocolState?.intendedRevisionBlobSha256 ?? null,
      adoptIntent: protocolState?.adoptIntent ?? null,
      pointerProof: protocolState?.pointerProof ?? {}
    });
    switch (disposition.disposition) {
      case P02_RECOVERY_DISPOSITION.ADOPT_AND_COMPLETE: {
        /* The repository proves the intended publication landed. Complete the
         * local record; do NOT republish and do NOT mint again. */
        await completePublication({
          ...scope,
          revisionId: protocolState.intendedRevisionId,
          revisionBlobSha256: protocolState.intendedRevisionBlobSha256,
          payloadSha256: protocolState.intendedPayloadSha256 ?? null,
          republished: false
        });
        return { handled: true, outcome: result(P02_STEADY_OUTCOME.RECOVERED,
          disposition.reason, { republished: false, reusedMint: protocolState.intendedRevisionId }) };
      }
      case P02_RECOVERY_DISPOSITION.ABANDON_AND_REPLAN:
      case P02_RECOVERY_DISPOSITION.ABANDON_EMPTY_INTENT: {
        /* Verified disproof, or nothing to adopt. Release the row and the slot
         * so the object is not pinned, then fall through to a fresh attempt. */
        await abandonIntent({ ...scope, retain: disposition.retain === true,
          releaseMemorySlot: disposition.releaseMemorySlot === true,
          reason: disposition.reason });
        return { handled: false, abandoned: disposition.reason };
      }
      case P02_RECOVERY_DISPOSITION.ABORT_UNREADABLE:
      default: {
        /* A read error is not disproof. Change nothing and try again later -
         * minting now would create a competitor for a revision that may be
         * sitting in the repository right now. */
        return { handled: true, outcome: result(P02_STEADY_OUTCOME.BLOCKED,
          disposition.reason, { blockReason: 'transport', retainedIntent: true }) };
      }
    }
  }

  /* Steps 4 and 5 of eligibility: an ordinary dirty object, or an onboarding
   * candidate. These are separate lanes, because a P01-converged object is not
   * dirty and widening the dirty rule to catch it would also catch objects that
   * must not publish. */
  function evaluateEligibility({ canonical, protocolState, ownHeadsGroup, ownPointer }) {
    if (protocolState?.integrityQuarantined === true) {
      return { eligible: false, reason: 'integrity-quarantined', integrity: true };
    }
    if (clean(protocolState?.blockReason)) {
      return { eligible: false, reason: clean(protocolState.blockReason), blocked: true };
    }
    if (protocolState?.divergedUnresolved === true) {
      return { eligible: false, reason: 'diverged-unresolved' };
    }
    if (protocolState?.retainedUnprovenParent === true) {
      return { eligible: false, reason: 'retained-unproven-parent' };
    }
    if (protocolState?.foreignLanePublicationActive === true) {
      return { eligible: false, reason: 'foreign-lane-publication-active' };
    }

    /* Ordinary change: the LATEST convergence direction's payload against
     * canonical. Never a revision-id comparison, and never both anchors OR-ed
     * together - that would call a publish-X, apply-Y, edit-back-X sequence
     * converged and lose the edit. */
    const direction = clean(protocolState?.convergedDirection);
    const canonicalPayload = clean(canonical?.payloadSha256);
    if (direction) {
      const anchorPayload = direction === 'applied'
        ? clean(protocolState?.appliedPayloadSha256)
        : clean(protocolState?.publishedPayloadSha256);
      if (!hex64(anchorPayload)) {
        /* A direction with no payload beside it is a half-written identity. */
        return { eligible: false, reason: 'anchor-payload-missing', integrity: true };
      }
      if (!hex64(canonicalPayload)) {
        return { eligible: false, reason: 'canonical-payload-unavailable' };
      }
      return canonicalPayload === anchorPayload
        ? { eligible: false, reason: 'converged' }
        : { eligible: true, lane: 'local-change' };
    }

    /* No P02 convergence at all: the onboarding lane decides, on PRESENCE. */
    const onboarding = evaluateOnboardingEligibility({
      ownPointer: ownPointer ?? {},
      ownHeadsGroup,
      pending: protocolState?.pendingOperation != null,
      blockReason: protocolState?.blockReason ?? null,
      integrityQuarantined: protocolState?.integrityQuarantined === true,
      /* Recovery has already run by the time we are here. */
      intentRecoveryComplete: true
    });
    return onboarding.eligible
      ? { eligible: true, lane: 'first-p02-onboarding' }
      : { eligible: false, reason: onboarding.reason };
  }

  /*
   * One steady publication attempt for one object. Every refusal returns; only
   * a genuinely committed publication reports COMMITTED.
   */
  async function publishObject({ objectDomain, objectId, objectKey, writerSyncPeerId } = {}) {
    const scope = { objectDomain, objectId, objectKey, writerSyncPeerId };
    if (!clean(objectId) || !hex64(clean(objectKey)) || !clean(writerSyncPeerId)) {
      return result(P02_STEADY_OUTCOME.INTEGRITY, P02_STEADY_ERROR.DEPENDENCY_INVALID);
    }

    const opening = await requireAuthority(scope, 'attempt-start');
    if (!opening.ok) return opening.refusal;

    /* Step 1: fresh canonical eligibility, never a cached projection. */
    let canonical;
    try {
      canonical = await readCanonicalProjection(scope);
    } catch (error) {
      return result(P02_STEADY_OUTCOME.BLOCKED, clean(error?.code) || 'canonical-unreadable',
        { blockReason: 'transport' });
    }

    let protocolState;
    try {
      protocolState = await readProtocolState(scope);
    } catch (error) {
      return result(P02_STEADY_OUTCOME.BLOCKED, clean(error?.code) || 'protocol-state-unreadable',
        { blockReason: 'transport' });
    }

    /* Step 2: heal-on-proof, if the platform offers it. A published pair with
     * no payload identity beside it can be repaired from repository proof
     * without publishing anything. */
    if (healPublishedIdentity !== null && protocolState?.publishedPayloadMissing === true) {
      try {
        const healed = await healPublishedIdentity(scope);
        if (healed?.healed === true) protocolState = await readProtocolState(scope);
      } catch (_) { /* Healing is opportunistic; failure is not fatal. */ }
    }

    /* Step 3: intent recovery, BEFORE eligibility. */
    const recovery = await reconcileRetainedIntent(scope, protocolState);
    if (recovery.handled) return recovery.outcome;
    if (recovery.abandoned) protocolState = await readProtocolState(scope);

    /*
     * Step 10 happens HERE, before eligibility, because the base is also the
     * source of the own-heads group that ROOT gating and onboarding depend on.
     * Reading it once and carrying it is what makes the CAS token and the merge
     * base describe the same state.
     */
    let base;
    try {
      base = await readWriterState({ writerSyncPeerId });
    } catch (error) {
      return result(P02_STEADY_OUTCOME.BLOCKED, clean(error?.code) || 'writer-state-unreadable',
        { blockReason: 'transport' });
    }
    const baseStatus = clean(base?.status);
    if (baseStatus !== 'verified' && baseStatus !== 'absent') {
      return result(P02_STEADY_OUTCOME.BLOCKED, P02_STEADY_ERROR.BASE_UNPROVEN,
        { blockReason: 'transport', baseStatus });
    }
    const baseHeads = baseStatus === 'verified'
      ? (Array.isArray(base?.snapshot?.heads) ? base.snapshot.heads : [])
      : [];
    const targetGroupKey = P02_HEADS_MERGE_V2.groupKey(objectDomain, objectId);
    const ownHeadsGroup = baseHeads.some((head) =>
      P02_HEADS_MERGE_V2.groupKey(head?.objectDomain, head?.objectId) === targetGroupKey)
      ? { objectKey, tips: baseHeads.filter((head) =>
        P02_HEADS_MERGE_V2.groupKey(head?.objectDomain, head?.objectId) === targetGroupKey) }
      : null;

    /* Step 4: eligibility. */
    const eligibility = evaluateEligibility({
      canonical, protocolState, ownHeadsGroup, ownPointer: { status: baseStatus }
    });
    if (!eligibility.eligible) {
      return result(
        eligibility.integrity ? P02_STEADY_OUTCOME.INTEGRITY
          : eligibility.blocked ? P02_STEADY_OUTCOME.BLOCKED
            : P02_STEADY_OUTCOME.NOT_ELIGIBLE,
        eligibility.reason,
        eligibility.blocked ? { blockReason: eligibility.reason } : {}
      );
    }

    /* Step 6: the parent, from repository-proven anchors only. */
    const parent = await selectPublicationParent({
      protocolState, convergedDirection: protocolState?.convergedDirection ?? null,
      proveAnchor: (pair) => proveAnchor({ ...scope, pair }),
      probeDescent: (candidate, seed) => probeDescent({ ...scope, candidate, seed }),
      ownHeadsGroup, ownPointerStatus: baseStatus
    });
    if (parent.selection === P02_PARENT_SELECTION.BLOCKED_TRANSPORT) {
      return result(P02_STEADY_OUTCOME.BLOCKED, parent.reason, { blockReason: 'transport' });
    }
    if (parent.selection === P02_PARENT_SELECTION.CONFLICT ||
        parent.selection === P02_PARENT_SELECTION.INTEGRITY) {
      return result(P02_STEADY_OUTCOME.INTEGRITY, parent.reason);
    }

    /*
     * Step 5: mint. This is the last moment a mint can vanish harmlessly - after
     * the intent below it becomes an identity the repository may hold.
     */
    let mintedRevisionId;
    try {
      mintedRevisionId = clean(await mintRevisionId(scope));
    } catch (error) {
      /* An entropy failure is an attempt outcome, not an escaping exception:
       * nothing durable exists yet, so the next pass simply mints again. */
      mintedRevisionId = '';
      return result(P02_STEADY_OUTCOME.BLOCKED,
        clean(error?.code) || 'mint-unavailable', { blockReason: 'transport' });
    }
    if (!mintedRevisionId) {
      return result(P02_STEADY_OUTCOME.BLOCKED, 'mint-unavailable', { blockReason: 'transport' });
    }

    /* Step 7: produce the immutable revision. */
    let produced;
    try {
      produced = await produceRevision({
        ...scope, revisionId: mintedRevisionId,
        p02Parent: parent.selection === P02_PARENT_SELECTION.ROOT ? null : {
          previousRevisionId: parent.parent.revisionId,
          previousRevisionBlobSha256: parent.parent.revisionBlobSha256,
          provenP02Parent: true
        }
      });
    } catch (error) {
      return result(P02_STEADY_OUTCOME.INTEGRITY,
        clean(error?.code) || P02_STEADY_ERROR.PRODUCE_FAILED);
    }
    /* The head timestamp comes from durable projected data. A wall clock would
     * make two publications of identical content produce different bytes. */
    const sourceUpdatedAtIso = clean(produced?.sourceUpdatedAtIso) ||
      clean(canonical?.sourceUpdatedAtIso);
    if (!sourceUpdatedAtIso || !Number.isFinite(Date.parse(sourceUpdatedAtIso))) {
      return result(P02_STEADY_OUTCOME.INTEGRITY, P02_STEADY_ERROR.SOURCE_TIMESTAMP_MISSING);
    }

    /*
     * Step 11: plan the merge against the base ALREADY READ. The plan carries
     * the CAS token from that same read.
     */
    let plan;
    try {
      plan = planHeadsMerge({
        baseWriterState: base,
        ownedWriterSyncPeerId: writerSyncPeerId,
        objectDomain, objectId, objectKey,
        replacementTips: [{
          objectDomain, objectId, objectKey,
          revisionId: mintedRevisionId,
          payloadSha256: produced.payloadSha256,
          revisionBlobSha256: produced.revisionBlobSha256,
          previousRevisionId: produced.revision?.previousRevisionId ?? null,
          previousRevisionBlobSha256: produced.revision?.previousRevisionBlobSha256 ?? null,
          sourceUpdatedAtIso,
          writerSyncPeerId,
          proven: true
        }]
      });
    } catch (error) {
      return result(P02_STEADY_OUTCOME.INTEGRITY, clean(error?.code) || 'merge-plan-refused');
    }
    /*
     * The token must exist for a steady publication. `undefined` would fall into
     * publishBatch's compatibility self-read, and a null token means "the
     * pointer was absent", which is the first-publication path's business.
     */
    if (!plan.firstOwnPublication && !hex64(plan.expectedCurrentHeadsSnapshotSha256)) {
      return result(P02_STEADY_OUTCOME.INTEGRITY, P02_STEADY_ERROR.CAS_TOKEN_REQUIRED);
    }

    /* Step 8: durable intent, BEFORE any repository mutation. */
    let acquisition;
    try {
      acquisition = await recordIntent({
        ...scope,
        intendedRevisionId: mintedRevisionId,
        intendedRevisionBlobSha256: produced.revisionBlobSha256,
        intendedPayloadSha256: produced.payloadSha256,
        /* The platform ledger may persist the complete immutable attempt.
         * Keeping these source-truth values beside the mint lets restart
         * recovery prove/adopt the SAME publication without minting or
         * rebuilding a subtly different plan. Existing platform adapters may
         * ignore the additional fields. */
        produced,
        heads: plan.heads,
        expectedCurrentHeadsSnapshotSha256:
          plan.expectedCurrentHeadsSnapshotSha256,
        canonicalAnchor: canonical,
        parentSelection: parent.selection
      });
    } catch (error) {
      return result(P02_STEADY_OUTCOME.BLOCKED,
        clean(error?.code) || P02_STEADY_ERROR.INTENT_FAILED, { blockReason: 'transport' });
    }

    /* Authority again, immediately before the mutating call. A grant taken at
     * the top of the attempt proves nothing about now. */
    const beforeMutation = await requireAuthority(scope, 'before-mutation');
    if (!beforeMutation.ok) {
      await abandonIntent({ ...scope, retain: true, reason: P02_STEADY_ERROR.AUTHORITY_CHANGED });
      return beforeMutation.refusal;
    }

    /* Step 9: the dormant steady lease. Today this always refuses, because no
     * repository carries a p02 writer-generation record. */
    let capability = null;
    try {
      const grant = await beginSteadyLease({
        ...scope,
        expectedCurrentHeadsSnapshotSha256: plan.expectedCurrentHeadsSnapshotSha256,
        revisionId: mintedRevisionId,
        revisionBlobSha256: produced.revisionBlobSha256
      });
      capability = clean(grant?.capability) || null;
    } catch (error) {
      await abandonIntent({ ...scope, retain: true, reason: clean(error?.code) || 'lease-refused' });
      return result(P02_STEADY_OUTCOME.BLOCKED,
        clean(error?.code) || P02_STEADY_ERROR.LEASE_REFUSED, { blockReason: 'permission' });
    }
    if (!capability) {
      await abandonIntent({ ...scope, retain: true, reason: P02_STEADY_ERROR.LEASE_REFUSED });
      return result(P02_STEADY_OUTCOME.BLOCKED, P02_STEADY_ERROR.LEASE_REFUSED,
        { blockReason: 'permission' });
    }

    try {
      /*
       * Steps 12 and 13. The token is passed EXPLICITLY. publishBatch's
       * compatibility self-read is unreachable from here by construction.
       */
      const transport = createTransport(capability);
      const batch = await transport.publishBatch({
        revisions: [produced.revisionInput ?? produced],
        heads: plan.heads,
        expectedCurrentHeadsSnapshotSha256: plan.expectedCurrentHeadsSnapshotSha256
      });
      if (!batch || batch.ok !== true) {
        /* A precondition failure means the base moved: re-plan on a fresh read
         * rather than retrying this plan against a state it never described. */
        await finishSteadyLease(capability, 'stale-base');
        await abandonIntent({ ...scope, retain: true, reason: 'stale-base' });
        return result(P02_STEADY_OUTCOME.STALE_BASE,
          clean(batch?.errorCode) || 'publish-precondition-failed',
          { expectedCurrentHeadsSnapshotSha256: plan.expectedCurrentHeadsSnapshotSha256 });
      }

      /* Step 14: only now may local state claim the publication. */
      await completePublication({
        ...scope,
        revisionId: mintedRevisionId,
        revisionBlobSha256: produced.revisionBlobSha256,
        payloadSha256: produced.payloadSha256,
        acquisition, republished: true
      });
      /* Step 15. */
      await finishSteadyLease(capability, 'committed');

      const committed = result(P02_STEADY_OUTCOME.COMMITTED, null, {
        repositoryMutated: true,
        revisionId: mintedRevisionId,
        revisionBlobSha256: produced.revisionBlobSha256,
        payloadSha256: produced.payloadSha256,
        parentSelection: parent.selection,
        lane: eligibility.lane,
        headsSnapshotSha256: batch.headsSnapshotSha256 ?? null,
        expectedCurrentHeadsSnapshotSha256: plan.expectedCurrentHeadsSnapshotSha256,
        casTokenSource: batch.casTokenSource ?? null,
        carriedHeadCount: plan.carriedHeadCount,
        outcome_: P02_ATTEMPT_OUTCOME.PROGRESS
      });
      emit({ ...scope, result: committed });
      return committed;
    } catch (error) {
      /* The intent is RETAINED: the write may have landed, and only repository
       * proof may decide. Abandoning here could strand a published revision. */
      await finishSteadyLease(capability, 'aborted');
      return result(P02_STEADY_OUTCOME.BLOCKED, clean(error?.code) || 'publish-failed',
        { blockReason: 'transport', retainedIntent: true });
    }
  }

  return Object.freeze({
    schema: P02_STEADY_PUBLICATION_V2.SCHEMA,
    dormant: true,
    publishObject
  });
}
