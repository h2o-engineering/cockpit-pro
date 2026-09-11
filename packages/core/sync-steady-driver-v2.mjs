/*
 * O1-T18 — dormant steady driver skeleton.
 *
 * This is deliberately thin. The accepted T03/T04 runtime already owns
 * single-flight, the trailing rerun, wake coalescing, per-run and per-step
 * authority consultation, the drain bound and its `exhausted` signal, selective
 * retry release and the dormant navigator.locks seam. Steady publication does
 * not need a second driver, and building one would guarantee the two drift on
 * exactly the properties that must not differ.
 *
 * So all this does is supply the ONE seam the runtime is missing: a
 * `reconcileOneObject` that performs a steady publication attempt and maps its
 * result into the accepted outcome taxonomy the scheduler already speaks.
 *
 * DORMANT BY CONSTRUCTION, IN THREE INDEPENDENT WAYS.
 *
 *   Nothing calls it. There is no startup registration, no timer, no listener,
 *   no visibility or storage hook anywhere in this file - the runtime only runs
 *   when its owner calls runPass, and nothing in production does.
 *
 *   The gate refuses. The runtime's own Y-10 gate reports mayWrite=false for
 *   every repository that has not been through the governed activation, so even
 *   an explicit runPass enumerates and classifies without mutating.
 *
 *   The lease refuses. Steady publication requires the Rust steady lease, which
 *   requires a p02 writer-generation record that nothing in the tree creates.
 *
 * Any one of those would make it inert. All three hold today, and each is
 * checked separately, because a future change that removes one should not
 * silently turn the product live.
 */

import { createP02ObjectRuntime } from './sync-object-runtime-v2.mjs';
import { P02_ATTEMPT_OUTCOME } from './sync-object-scheduler-v2.mjs';
import { P02_STEADY_OUTCOME } from './sync-steady-publication-v2.mjs';

export const P02_STEADY_DRIVER_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncSteadyDriver.p02.v1',
  DORMANT: true,
  /*
   * The exact seam a future governed activation connects. Recorded here so the
   * activation task does not have to rediscover it: an owner constructs this
   * driver with a real steady publication and calls wake()/runPass(). Nothing
   * else needs to change, and nothing else may.
   */
  ACTIVATION_SEAM: 'createP02SteadyDriver(...).runtime.runPass()'
});

/*
 * Map a steady publication result into the accepted scheduler taxonomy.
 *
 * The scheduler already knows how to retry each class - transient on a timer,
 * blocked and integrity on external state change - so the mapping decides the
 * retry policy. Getting it wrong is how a permanent refusal starts being
 * retried on a timer, or a transient one stops being retried at all.
 */
export function classifySteadyOutcome(steadyResult) {
  const outcome = steadyResult?.outcome;
  switch (outcome) {
    case P02_STEADY_OUTCOME.COMMITTED:
      return { ok: true, verdict: 'published' };
    case P02_STEADY_OUTCOME.RECOVERED:
      /* Real progress: a retained intent was reconciled. */
      return { ok: true, verdict: 'published', recovered: true };
    case P02_STEADY_OUTCOME.NOT_ELIGIBLE:
      return { verdict: 'no-active' };
    case P02_STEADY_OUTCOME.STALE_BASE:
      /* The plan described a base that moved. Re-planning needs a fresh read,
       * which the next pass performs anyway - so this is a no-effect replan,
       * not a failure to back off from. */
      return { verdict: 'stale' };
    case P02_STEADY_OUTCOME.AUTHORITY_REFUSED:
      return { ok: false, errorCode: `blocked(${steadyResult?.blockReason || 'permission'})` };
    case P02_STEADY_OUTCOME.BLOCKED:
      return { verdict: 'blocked', errorCode: `blocked(${steadyResult?.blockReason || 'transport'})` };
    case P02_STEADY_OUTCOME.INTEGRITY:
    default:
      return { ok: false, errorClass: 'integrity' };
  }
}

export function createP02SteadyDriver({
  steadyPublication,
  enumerate,
  classify,
  authority,
  gate,
  peerId,
  clock,
  p01WriterActive = null,
  realmLock = null,
  onTrace = null
} = {}) {
  if (typeof steadyPublication?.publishObject !== 'function') {
    throw new TypeError('p02-steady-driver-publication-invalid');
  }

  const runtime = createP02ObjectRuntime({
    peerId, clock, enumerate, classify, authority, gate,
    p01WriterActive, realmLock, onTrace,
    /*
     * The single seam. The runtime decides WHETHER to run this - gate, per-run
     * and per-step authority, single-flight, capacity - and this decides what
     * one attempt does.
     */
    reconcileOneObject: async (candidate) => {
      const steady = await steadyPublication.publishObject({
        objectDomain: candidate.objectDomain,
        objectId: candidate.objectId,
        objectKey: candidate.objectKey,
        /* Publication identity belongs to this driver, never to the remote
         * peer whose descriptor happened to make the object schedulable. A
         * candidate is work scope, not writer authority. */
        writerSyncPeerId: peerId
      });
      return { ...classifySteadyOutcome(steady), steady };
    }
  });

  return Object.freeze({
    schema: P02_STEADY_DRIVER_V2.SCHEMA,
    dormant: true,
    /* No start(), no register(), no arm(). An owner drives the runtime. */
    runtime,
    outcomeFor: classifySteadyOutcome,
    P02_ATTEMPT_OUTCOME
  });
}
