/*
 * P02 multi-object runtime composition (Wave 1 / Z7).
 *
 * This is THE single canonical automatic object-sync engine for P02. Desktop
 * foreground, Chrome foreground and the Chrome zero-page background worker all
 * drive this same object, so there is exactly one scheduler, one classifier
 * path, one capacity policy and one gate decision - never a per-context copy.
 *
 * Composition only. It owns no semantics of its own:
 *   Y-10 gate  -> may P02 read / write this repository at all
 *   Y-1        -> platform enumeration (injected)
 *   V9         -> capacity predicate over retained evidence
 *   Y-9        -> semantic classification (the only conflict authority)
 *   Z5         -> selection, fairness, retry, wake coalescing
 *   C1         -> reconcileOneObject() stays the atomic convergence operation
 *
 * INACTIVE BY DEFAULT: the gate reports mayWrite=false for every repository
 * state except an explicitly activated, supported one. A repository that has
 * never been through the governed V7/V8 activation campaign therefore yields
 * enumeration and classification only, and no mutation whatsoever.
 */

import {
  P02ObjectScheduler,
  P02_ATTEMPT_OUTCOME,
  P02_RUNNABILITY,
  classificationRunnability
} from './sync-object-scheduler-v2.mjs';
import {
  capacityBlockReason,
  P02_CAPACITY_LIMITS
} from './sync-evidence-capacity-v2.mjs';
import {
  P02_GATE_STATE,
  evaluateFormatGate
} from './sync-format-gate-v2.mjs';

export const P02_RUNTIME_V2 = Object.freeze({
  SCHEMA: 'h2o.studio.syncObjectRuntime.p02.v1',
  /* Smallest bounded drain compatible with an MV3 worker lifecycle. */
  DEFAULT_DRAIN_LIMIT: 8
});

function requireFunction(value, code) {
  if (typeof value !== 'function') throw new TypeError(code);
  return value;
}

/*
 * Dormant realm-exclusion seam (T04 infrastructure).
 *
 * A Chrome realm can run more than one script context over one repository - a
 * foreground page and the zero-page worker, or two windows - and the in-process
 * single-flight below cannot see across contexts. `navigator.locks` can, so the
 * seam is defined now, P02-named and exclusive, so the future Chrome driver has
 * one obvious place to plug in.
 *
 * It is deliberately INERT: `createP02ObjectRuntime` defaults `realmLock` to
 * null, nothing in this module constructs a seam, and no timer, alarm or
 * listener anywhere calls into it. Building one is an explicit act by a caller
 * that has decided to serialize a realm; until then the seam does nothing.
 */
export const P02_REALM_LOCK = Object.freeze({
  SCHEMA: 'h2o.studio.syncObjectRuntimeRealmLock.p02.v1',
  /* Fully qualified so it cannot collide with any other lock in the origin. */
  NAME: 'h2o.studio.sync.p02.object-runtime.realm'
});

export function createRealmLockSeam({
  locks = undefined,
  lockName = P02_REALM_LOCK.NAME
} = {}) {
  if (typeof lockName !== 'string' || lockName.trim() === '') {
    throw new TypeError('p02-realm-lock-name-invalid');
  }
  const manager = locks === undefined
    ? (typeof navigator === 'undefined' ? null : navigator?.locks ?? null)
    : locks;
  const available = typeof manager?.request === 'function';
  return Object.freeze({
    schema: P02_REALM_LOCK.SCHEMA,
    lockName,
    available,
    /*
     * Where the platform has no lock manager - Desktop, or an older realm -
     * the operation still runs. Cross-context exclusion is an ADDITIONAL
     * guarantee on top of in-process single-flight, never a precondition for
     * running at all, so an absent manager must not silently disable P02.
     */
    async runExclusive(operation) {
      requireFunction(operation, 'p02-realm-lock-operation-invalid');
      if (!available) return operation();
      return manager.request(lockName, { mode: 'exclusive' }, () => operation());
    }
  });
}

export const P02_RUNTIME_STATUS = Object.freeze({
  GATE_INACTIVE: 'gate-inactive',
  GATE_FAIL_CLOSED: 'gate-fail-closed',
  AUTHORITY_NON_MUTATING: 'authority-non-mutating',
  DUAL_WRITER_EXCLUDED: 'dual-writer-excluded',
  IDLE: 'idle',
  PROGRESSED: 'progressed'
});

/*
 * The drain size is an IMPLEMENTATION CHOICE, not frozen by N1. It exists only
 * to bound one wake inside a service-worker lifetime; correctness never
 * depends on its value because every pass re-reads canonical state.
 */
export function createP02ObjectRuntime({
  peerId,
  clock,
  enumerate,
  classify,
  reconcileOneObject,
  authority,
  gate,
  retainedEvidenceFor = null,
  p01WriterActive = null,
  realmLock = null,
  capacityLimits = P02_CAPACITY_LIMITS,
  drainLimit = P02_RUNTIME_V2.DEFAULT_DRAIN_LIMIT,
  onTrace = null
} = {}) {
  requireFunction(enumerate, 'p02-runtime-enumerate-invalid');
  requireFunction(classify, 'p02-runtime-classify-invalid');
  requireFunction(reconcileOneObject, 'p02-runtime-reconcile-invalid');
  requireFunction(authority, 'p02-runtime-authority-invalid');
  requireFunction(gate, 'p02-runtime-gate-invalid');

  let lastGate = null;
  /*
   * Single-flight driver state (T04). One realm, at most one active pass.
   * `queued` is the trailing-rerun flag, not a queue: any number of wakes that
   * arrive while a pass is running collapse into exactly one further pass,
   * because a pass re-reads canonical state and therefore already covers every
   * wake that preceded its start.
   */
  let inFlight = null;
  let queued = false;
  let coalescedWakes = 0;
  let passCount = 0;
  let dualWriterBlocked = false;

  /*
   * Classification wrapper. Capacity is a PREDICATE over current retained
   * evidence (V9): it is recomputed every pass and never stored, so clearing
   * the condition needs no scheduler or index repair. The gate can likewise
   * force a fail-closed classification without mutating anything.
   */
  async function classifyWithGuards(descriptor) {
    if (lastGate && lastGate.classification) {
      return { classification: lastGate.classification, reason: lastGate.reason };
    }
    if (retainedEvidenceFor) {
      const retained = await retainedEvidenceFor(descriptor);
      const blocked = capacityBlockReason({
        retained: retained || [], limits: capacityLimits
      });
      if (blocked) {
        return { classification: `blocked(${blocked})`, reason: 'evidence-capacity' };
      }
    }
    return classify(descriptor);
  }

  /*
   * Mutation is permitted only when the gate says this repository is activated
   * AND canonical mode authority allows it. Both are re-read every pass;
   * neither is cached across attempts.
   */
  async function mutationAuthority() {
    const decision = await authority();
    if (!lastGate?.mayWrite || dualWriterBlocked) {
      return { mode: decision?.mode ?? null, valid: false };
    }
    return decision;
  }

  const scheduler = new P02ObjectScheduler({
    peerId,
    clock,
    enumerate,
    classify: classifyWithGuards,
    authority: mutationAuthority,
    execute: (candidate, freshVerdict) =>
      reconcileOneObject(candidate, freshVerdict),
    onTrace
  });

  /*
   * One bounded pass: read the gate, then enumerate/classify/schedule.
   * Returns a report even when nothing may run, so callers can surface
   * eligibility without ever mutating.
   *
   * This is the pass BODY. It is never called directly from outside; every
   * entry point goes through the single-flight driver below, so the body may
   * assume it is the only pass running in this context.
   */
  async function executeOnePass({ maxSteps = drainLimit } = {}) {
    passCount += 1;
    lastGate = await gate();
    /*
     * Dual-writer exclusion (frozen O.1). P02 automatic publication and the
     * accepted P01 fixed-slot writer must never mutate the same domain
     * concurrently. Quiescing P01 is an operational prerequisite of the
     * activation campaign; this guard makes the boundary structural so the
     * two engines cannot overlap even if a gate were activated early.
     */
    dualWriterBlocked = typeof p01WriterActive === 'function'
      ? (await p01WriterActive()) === true
      : false;

    if (!lastGate || lastGate.mayRead === false) {
      /* Malformed or unsupported: fail closed, no writes, no "repair". */
      return Object.freeze({
        status: P02_RUNTIME_STATUS.GATE_FAIL_CLOSED,
        gate: lastGate ?? null,
        mutated: false,
        exhausted: false,
        dispatched: [],
        candidates: []
      });
    }

    if (dualWriterBlocked) {
      const candidates = await scheduler.buildCandidates();
      return Object.freeze({
        status: P02_RUNTIME_STATUS.DUAL_WRITER_EXCLUDED,
        gate: lastGate,
        mutated: false,
        exhausted: false,
        dispatched: [],
        candidates,
        reason: 'accepted-p01-writer-still-active'
      });
    }

    if (!lastGate.mayWrite) {
      /*
       * The normal Wave-1 posture. P02 enumerates and classifies so the
       * product can report state, and writes nothing at all.
       */
      const candidates = await scheduler.buildCandidates();
      return Object.freeze({
        status: P02_RUNTIME_STATUS.GATE_INACTIVE,
        gate: lastGate,
        mutated: false,
        exhausted: false,
        dispatched: [],
        candidates,
        initializationEligible: lastGate.initializationEligible === true
      });
    }

    /*
     * Per-RUN authority consultation. The scheduler re-reads authority per
     * STEP as well (P.6), and both reads are load-bearing for different
     * questions: this one decides whether the run may begin at all, and the
     * per-step one stops a drain the moment authority is withdrawn part-way
     * through. Neither is cached across the other.
     */
    const authorityDecision = await authority();
    /* W-2c manual Receive/admission is a one-call stage capability, not an
     * `auto` config impersonation. The Chrome composition can expose this
     * boolean only while its trusted manual request is executing; every other
     * caller retains the existing mode=auto rule. */
    const mayMutate = authorityDecision?.valid === true &&
      (authorityDecision?.mode === 'auto' ||
        authorityDecision?.manualReceiveAdmission === true ||
        authorityDecision?.manualApply === true ||
        authorityDecision?.manualPublication === true);
    if (!mayMutate) {
      const candidates = await scheduler.buildCandidates();
      return Object.freeze({
        status: P02_RUNTIME_STATUS.AUTHORITY_NON_MUTATING,
        gate: lastGate,
        mutated: false,
        exhausted: false,
        dispatched: [],
        candidates
      });
    }

    const results = await scheduler.runSteps(maxSteps);
    if (results.length === 0) {
      const candidates = await scheduler.buildCandidates();
      return Object.freeze({
        status: P02_RUNTIME_STATUS.IDLE,
        gate: lastGate,
        mutated: false,
        exhausted: false,
        dispatched: [],
        candidates
      });
    }
    /*
     * A DISPATCH IS NOT A MUTATION.
     *
     * This reported progress whenever any object was attempted, so a pass that
     * attempted a settled object and correctly did nothing still claimed
     * `status: progressed, mutated: true` over a byte-identical repository.
     * That made a correct no-op indistinguishable from a failed publication -
     * the single most misleading thing a pass report can do.
     *
     * Progress now means at least one attempt actually reported PROGRESS. The
     * per-attempt outcomes stay in `dispatched` either way, so nothing is
     * flattened: a caller can still tell no-effect from blocked from stale.
     */
    const progressed = results.some((item) =>
      item?.outcome === P02_ATTEMPT_OUTCOME.PROGRESS);
    return Object.freeze({
      status: progressed ? P02_RUNTIME_STATUS.PROGRESSED : P02_RUNTIME_STATUS.IDLE,
      gate: lastGate,
      mutated: progressed,
      /*
       * Explicit drain-bound signal. A pass that fills its step budget was
       * stopped by the bound, not by running out of work, so more may remain
       * and the caller should schedule another pass rather than conclude the
       * repository is settled. Inferring this from `dispatched.length` would
       * make every caller re-derive the drain limit.
       */
      exhausted: maxSteps > 0 && results.length >= maxSteps,
      dispatched: results.map((item) => ({
        objectId: item.objectId,
        direction: item.direction,
        classification: item.classification,
        outcome: item.outcome,
        /* Internal, capability-free typed result. Public worker routes redact
         * this before replying to the Studio page. */
        result: item.result ?? null
      })),
      candidates: []
    });
  }

  /*
   * Single-flight driver (T04). At most one active pass per realm.
   *
   * A wake that arrives mid-pass cannot simply be dropped: the pass may have
   * already read the state the wake is about. It cannot start a second
   * concurrent pass either, because P02 serializes canonical mutation. So it
   * sets `queued`, and the driver runs exactly ONE trailing pass afterwards -
   * which, re-reading canonical state from scratch, covers every wake that
   * arrived while the first pass was running, however many there were.
   *
   * `inFlight` is cleared in a `finally` that runs in the SAME synchronous
   * turn as the loop-exit decision. Without that, a wake landing between "no
   * trailing pass needed" and "driver released" would set `queued` on a
   * driver that had already stopped, and be lost. It also means a throw -
   * from the gate, the enumerator, anywhere - releases the realm instead of
   * wedging it shut until the process restarts.
   */
  async function drive(options) {
    let report = null;
    try {
      for (;;) {
        queued = false;
        report = realmLock
          ? await realmLock.runExclusive(() => executeOnePass(options))
          : await executeOnePass(options);
        /* A trusted manual stage is one Human activation and therefore one
         * pass. A wake that races it may mark the driver queued, but it must
         * never extend the ephemeral manual capability into a trailing pass.
         * The wake remains represented in scheduler state and a later owning
         * trigger may evaluate it after the manual capability is gone. */
        if (!queued || options?.singlePass === true) break;
      }
    } finally {
      inFlight = null;
      queued = false;
    }
    return report;
  }

  return Object.freeze({
    schema: P02_RUNTIME_V2.SCHEMA,
    scheduler,

    /* A wake is only ever "re-evaluate work", never work authority itself. */
    wake(reason = 'unspecified') {
      return scheduler.wake(reason);
    },

    gateDecision() {
      return lastGate;
    },

    /*
     * The driver entry point. A realm's wake handler is `wake(reason)` followed
     * by `runPass()`; nothing in this module ever calls either one itself - no
     * timer, no alarm, no listener - so P02 still runs only when its owner
     * decides to run it.
     *
     * A coalesced caller is handed the in-flight promise and therefore settles
     * on the report of the pass that actually covers its wake, rather than a
     * synthetic "busy" answer it would have to interpret.
     */
    runPass(options = {}) {
      if (inFlight) {
        queued = true;
        coalescedWakes += 1;
        return inFlight;
      }
      inFlight = drive(options);
      return inFlight;
    },

    /*
     * Transport restoration (T04). Backoff accumulated while the channel was
     * unreachable describes the channel, not the work, so holding an object
     * back for minutes after reachability returns is punishing it for someone
     * else's outage. Only timed backoff is released; see dropTimedBackoff.
     */
    noteTransportRestored(reason = 'transport-restored') {
      const released = scheduler.dropTimedBackoff();
      const generation = scheduler.wake(reason);
      return Object.freeze({ released: Object.freeze(released), generation });
    },

    /* Driver observability. Read-only; never a control surface. */
    driverState() {
      return Object.freeze({
        active: inFlight !== null,
        queued,
        coalescedWakes,
        passCount,
        realmLock: realmLock
          ? Object.freeze({ lockName: realmLock.lockName, available: realmLock.available })
          : null
      });
    },

    /*
     * Read-only eligibility report. Never mutates, so it is safe in Manual and
     * Notify modes and behind an inactive gate.
     */
    async report() {
      lastGate = await gate();
      const candidates = lastGate?.mayRead === false
        ? []
        : await scheduler.buildCandidates();
      return Object.freeze({
        gate: lastGate,
        candidates,
        runnable: candidates.filter((candidate) =>
          classificationRunnability(candidate.classification) === P02_RUNNABILITY.RUNNABLE
        ).map((candidate) => candidate.objectId),
        blocked: candidates.filter((candidate) =>
          candidate.runnability === P02_RUNNABILITY.BLOCKED
        ).map((candidate) => ({
          objectId: candidate.objectId, reason: candidate.blockClass
        }))
      });
    }
  });
}

/* Convenience: the inactive-gate decision a never-activated repository yields. */
export function inactiveGate(repositoryHasContent = true) {
  return evaluateFormatGate({ libraryInfo: null, repositoryHasContent });
}

export { P02_GATE_STATE };
