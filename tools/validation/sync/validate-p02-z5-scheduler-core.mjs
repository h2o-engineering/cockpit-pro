#!/usr/bin/env node
/*
 * P02 Wave 1 / Z5 — multi-object scheduler core validation.
 *
 * Proves the frozen P.1-P.7 scheduler contract and the Y-3 descriptor against
 * the real production module, with the real Y-9 classifier and the real
 * accepted reconcileOneObject() underneath via the Z2 harness.
 *
 * Disposable state only: no live Sync, no SQLite/IDB, no transport, no gate
 * activation, no V9 resolution, no Chrome/Desktop process.
 */

import assert from 'node:assert/strict';
import {
  P02ObjectScheduler,
  P02_ATTEMPT_OUTCOME,
  P02_RUNNABILITY,
  P02_SCHEDULER_DEFAULT_BACKOFF,
  P02_SCHEDULER_DIRECTION,
  P02_SCHEDULER_V2,
  blockReasonOf,
  classificationRunnability,
  computeBackoffDelayMs,
  createRetryIndex,
  createSchedulerCandidate,
  directionForClassification,
  retryEntryKey,
  rotationSelect,
  sortSchedulerCandidates
} from '../../../packages/core/sync-object-scheduler-v2.mjs';
import {
  DeterministicMultiObjectWorld,
  INVARIANT,
  makeRevision
} from './helpers/p02-deterministic-multi-object-harness.mjs';

const PEER_A = 'harness-peer-a';
const DOMAIN = 'studio.test.multi-object.v1';
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

let assertions = 0;
const scenarios = [];
const antiDegeneracy = [];

function check(condition, label) {
  assertions += 1;
  assert.ok(condition, label);
}

function equal(actual, expected, label) {
  assertions += 1;
  assert.equal(actual, expected, label);
}

function deepEqual(actual, expected, label) {
  assertions += 1;
  assert.deepEqual(actual, expected, label);
}

function scenario(name) {
  scenarios.push(name);
}

/* A control must go RED: the assertion it guards has to fail when broken. */
async function requireRed(id, body) {
  let red = false;
  try {
    await body();
  } catch (_) {
    red = true;
  }
  assertions += 1;
  assert.ok(red, `anti-degeneracy control ${id} must fail when the rule is broken`);
  antiDegeneracy.push(id);
}

function candidate(overrides = {}) {
  return createSchedulerCandidate({
    objectDomain: DOMAIN,
    objectId: 'object-1',
    objectKey: KEY_A,
    peer: PEER_A,
    direction: P02_SCHEDULER_DIRECTION.PUBLISH,
    classification: 'local-ahead',
    runnability: P02_RUNNABILITY.RUNNABLE,
    ...overrides
  });
}

/* ------------------------------------------------------------------ */
/* 1. Y-3 candidate/job descriptor contract                            */
/* ------------------------------------------------------------------ */
function verifyCandidateContract() {
  const one = candidate();
  equal(one.schema, P02_SCHEDULER_V2.CANDIDATE_SCHEMA, 'Y-3 candidate carries its schema');
  for (const field of ['objectDomain', 'objectId', 'peer', 'direction', 'classification',
    'priority', 'attemptCount', 'nextAttemptAt', 'blockClass', 'lastErrorClass',
    'wakeReason', 'reason']) {
    check(field in one, `Y-3 candidate exposes ${field}`);
  }
  check(Object.isFrozen(one), 'Y-3 candidate is immutable pure data');
  for (const forbidden of ['canonicalLocalHead', 'retainedEvidence', 'advertisedTips',
    'revisionId', 'revisionBlobSha256', 'payload']) {
    check(!(forbidden in one),
      `Y-3 candidate does not duplicate canonical evidence field ${forbidden}`);
  }
  assert.throws(() => createSchedulerCandidate({}), /p02-scheduler-candidate-invalid/);
  assertions += 1;
  assert.throws(() => candidate({ objectKey: 'short' }), /p02-scheduler-candidate-invalid/);
  assertions += 1;
  assert.throws(() => candidate({ attemptCount: -1 }), /p02-scheduler-candidate-invalid/);
  assertions += 1;

  const sorted = sortSchedulerCandidates([
    candidate({ objectId: 'object-3', objectKey: KEY_B }),
    candidate({ objectId: 'object-1' }),
    candidate({ objectId: 'object-2', objectKey: KEY_B })
  ]);
  deepEqual(sorted.map((item) => item.objectId), ['object-1', 'object-2', 'object-3'],
    'candidates sort deterministically by ordering key');
  const prioritised = sortSchedulerCandidates([
    candidate({ objectId: 'object-1' }),
    candidate({ objectId: 'object-9', objectKey: KEY_B, priority: 5 })
  ]);
  equal(prioritised[0].objectId, 'object-9', 'higher priority orders first');
  scenario('Z5-S01 Y-3 descriptor shape, immutability and deterministic ordering');
}

/* ------------------------------------------------------------------ */
/* 2. Classification -> runnability (Y-9 is the only authority)        */
/* ------------------------------------------------------------------ */
function verifyRunnabilityMapping() {
  const expected = {
    'local-ahead': P02_RUNNABILITY.RUNNABLE,
    'remote-ahead': P02_RUNNABILITY.RUNNABLE,
    'object-deleted': P02_RUNNABILITY.RUNNABLE,
    converged: P02_RUNNABILITY.IDLE,
    'diverged-unresolved': P02_RUNNABILITY.INDETERMINATE,
    'resolution-target-missing': P02_RUNNABILITY.INDETERMINATE,
    'resolution-conflict': P02_RUNNABILITY.INDETERMINATE,
    'integrity-quarantined': P02_RUNNABILITY.INTEGRITY,
    'unsupported-format': P02_RUNNABILITY.INTEGRITY,
    'blocked(asset)': P02_RUNNABILITY.BLOCKED,
    'blocked(permission)': P02_RUNNABILITY.BLOCKED,
    'blocked(transport)': P02_RUNNABILITY.BLOCKED,
    'blocked(format)': P02_RUNNABILITY.BLOCKED,
    'blocked(capacity)': P02_RUNNABILITY.BLOCKED
  };
  for (const [classification, runnability] of Object.entries(expected)) {
    equal(classificationRunnability(classification), runnability,
      `${classification} maps to ${runnability}`);
  }
  equal(blockReasonOf('blocked(capacity)'), 'capacity', 'block reason is extracted, not invented');
  equal(blockReasonOf('converged'), null, 'non-blocked classes carry no block reason');
  equal(directionForClassification('local-ahead'), P02_SCHEDULER_DIRECTION.PUBLISH,
    'local-ahead attributes a publish direction');
  equal(directionForClassification('remote-ahead'), P02_SCHEDULER_DIRECTION.RECEIVE,
    'remote-ahead attributes a receive direction');
  equal(directionForClassification('diverged-unresolved'), P02_SCHEDULER_DIRECTION.NONE,
    'indeterminate states attribute no direction');
  scenario('Z5-S02 classification-to-runnability mapping covers every frozen H.2 class');
}

/* ------------------------------------------------------------------ */
/* 3. Bounded backoff with deterministic jitter                        */
/* ------------------------------------------------------------------ */
function verifyBackoff() {
  const first = computeBackoffDelayMs({ attemptCount: 1, jitterKey: 'k' });
  equal(computeBackoffDelayMs({ attemptCount: 1, jitterKey: 'k' }), first,
    'backoff is deterministic for identical inputs');
  check(computeBackoffDelayMs({ attemptCount: 4, jitterKey: 'k' }) > first,
    'backoff grows with attempt count');
  check(computeBackoffDelayMs({ attemptCount: 64, jitterKey: 'k' }) <=
    P02_SCHEDULER_DEFAULT_BACKOFF.maxDelayMs, 'backoff is bounded by the ceiling');
  check(computeBackoffDelayMs({ attemptCount: 3, jitterKey: 'a' }) !==
    computeBackoffDelayMs({ attemptCount: 3, jitterKey: 'b' }),
  'jitter varies by entry, without any wall clock or randomness');
  equal(computeBackoffDelayMs({ attemptCount: 2, jitterRatio: 0, jitterKey: 'k' }), 2000,
    'zero jitter yields the exact exponential value');
  assert.throws(() => computeBackoffDelayMs({ attemptCount: 0 }),
    /p02-scheduler-backoff-attempt-invalid/);
  assertions += 1;
  scenario('Z5-S03 bounded exponential backoff with deterministic injected jitter');
}

/* ------------------------------------------------------------------ */
/* 4. Rotation policy fairness (pure)                                  */
/* ------------------------------------------------------------------ */
function verifyRotationPolicy() {
  const pool = ['object-1', 'object-2', 'object-3']
    .map((objectId) => candidate({ objectId }));
  let cursor = '';
  const served = [];
  for (let step = 0; step < 6; step += 1) {
    const picked = rotationSelect(pool, cursor);
    served.push(picked.objectId);
    cursor = picked.orderingKey;
  }
  deepEqual(served, ['object-1', 'object-2', 'object-3', 'object-1', 'object-2', 'object-3'],
    'rotation wraps and serves every candidate once per cycle');
  equal(rotationSelect([], ''), null, 'empty candidate set selects nothing');
  scenario('Z5-S04 rotation policy is deterministic and starvation-free by construction');
}

/* ------------------------------------------------------------------ */
/* Scheduler test rig over synthetic descriptors                       */
/* ------------------------------------------------------------------ */
function createRig({
  objects,
  mode = 'auto',
  valid = true,
  executeImpl = null,
  extra = {}
} = {}) {
  const state = new Map(objects.map((item) => [item.objectId, { ...item }]));
  const executed = [];
  const rig = {
    state,
    executed,
    clockMs: 0,
    mode,
    valid,
    authorityReads: 0
  };
  rig.scheduler = new P02ObjectScheduler({
    peerId: PEER_A,
    clock: () => rig.clockMs,
    enumerate: async () => [...state.values()].map((item) => ({
      objectDomain: DOMAIN,
      objectId: item.objectId,
      objectKey: item.objectKey
    })),
    classify: async (descriptor) => ({
      classification: state.get(descriptor.objectId).classification,
      reason: 'rig'
    }),
    authority: async () => {
      rig.authorityReads += 1;
      return { mode: rig.mode, valid: rig.valid };
    },
    execute: executeImpl
      ? (item) => executeImpl(item, rig)
      : async (item) => {
        executed.push(item.objectId);
        /* Default rig work converges the object, as real reconciliation does. */
        state.get(item.objectId).classification = 'converged';
        return { ok: true, verdict: 'reconciled' };
      },
    ...extra
  });
  return rig;
}

function rigObjects(count, classification = 'local-ahead') {
  return Array.from({ length: count }, (_, index) => ({
    objectId: `rig-${String(index).padStart(3, '0')}`,
    objectKey: (index % 2 === 0 ? 'c' : 'd').repeat(64),
    classification
  }));
}

/* ------------------------------------------------------------------ */
/* 5. Authority gates (P.6) — mode is re-read, never cached            */
/* ------------------------------------------------------------------ */
async function verifyAuthorityGates() {
  for (const mode of ['manual', 'notify']) {
    const rig = createRig({ objects: rigObjects(3), mode });
    const outcome = await rig.scheduler.runOnce();
    equal(outcome.dispatched, false, `${mode} mode dispatches no canonical mutation`);
    equal(outcome.reason, 'authority-non-mutating', `${mode} mode reports why it did not run`);
    equal(outcome.candidates.length, 3, `${mode} mode still enumerates and classifies`);
    equal(rig.executed.length, 0, `${mode} mode performs no execution`);
  }
  const invalid = createRig({ objects: rigObjects(2), mode: 'auto', valid: false });
  equal((await invalid.scheduler.runOnce()).dispatched, false,
    'auto mode without valid authority fails closed');

  /* Flip auto -> manual between passes: the decision must not be cached. */
  const rig = createRig({ objects: rigObjects(3) });
  await rig.scheduler.runOnce();
  equal(rig.executed.length, 1, 'auto mode dispatches exactly one object per pass');
  rig.mode = 'manual';
  const after = await rig.scheduler.runOnce();
  equal(after.dispatched, false, 'a mid-run mode change immediately suppresses mutation');
  equal(rig.executed.length, 1, 'no further execution after authority is withdrawn');
  equal(rig.authorityReads, 2, 'authority is re-read once per pass, never memoised');
  scenario('Z5-S05 manual/notify enumerate without mutating; auto is re-checked every pass');
}

/* ------------------------------------------------------------------ */
/* 6. Blocked / indeterminate / integrity exclusion                    */
/* ------------------------------------------------------------------ */
async function verifyNonRunnableExclusion() {
  const nonRunnable = [
    'blocked(asset)', 'blocked(permission)', 'blocked(transport)',
    'blocked(format)', 'blocked(capacity)',
    'diverged-unresolved', 'resolution-target-missing', 'resolution-conflict',
    'integrity-quarantined', 'unsupported-format', 'converged'
  ];
  for (const classification of nonRunnable) {
    const rig = createRig({
      objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification }]
    });
    const outcome = await rig.scheduler.runOnce();
    equal(outcome.dispatched, false, `${classification} is never dispatched`);
    equal(outcome.reason, 'no-due-candidates', `${classification} yields no due candidate`);
    equal(rig.executed.length, 0, `${classification} triggers no canonical effect`);
  }
  /* A permanently non-runnable object must not stop unrelated eligible work. */
  const mixed = createRig({
    objects: [
      { objectId: 'rig-000', objectKey: KEY_A, classification: 'blocked(capacity)' },
      { objectId: 'rig-001', objectKey: KEY_B, classification: 'local-ahead' },
      { objectId: 'rig-002', objectKey: KEY_B, classification: 'resolution-conflict' },
      { objectId: 'rig-003', objectKey: KEY_A, classification: 'remote-ahead' }
    ]
  });
  await mixed.scheduler.runSteps(6);
  deepEqual([...new Set(mixed.executed)].sort(), ['rig-001', 'rig-003'],
    'blocked and indeterminate objects never run while eligible peers progress');
  scenario('Z5-S06 every non-runnable frozen class is excluded from canonical mutation');
}

/* ------------------------------------------------------------------ */
/* 7. blocked(capacity) is recoverable, and V9 stays unresolved        */
/* ------------------------------------------------------------------ */
async function verifyCapacityBoundary() {
  const rig = createRig({
    objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'blocked(capacity)' }]
  });
  equal((await rig.scheduler.runOnce()).dispatched, false,
    'blocked(capacity) is non-runnable');
  equal(Object.keys(rig.scheduler.retryIndex.entries).length, 0,
    'a capacity-blocked object creates no retry backlog and no timer spin');
  /*
   * Governed external relief (V9 territory) changes the classifier verdict.
   * The scheduler re-reads canonical state every pass, so the object becomes
   * eligible again without any scheduler-side record being repaired.
   */
  rig.state.get('rig-000').classification = 'remote-ahead';
  const after = await rig.scheduler.runOnce();
  equal(after.dispatched, true, 'capacity relief makes the object eligible again');
  deepEqual(rig.executed, ['rig-000'], 'the recovered object runs exactly once');
  scenario('Z5-S07 blocked(capacity) is a recoverable fail-closed state, not terminal');
}

/* ------------------------------------------------------------------ */
/* 8. Retry / backoff under the injected clock                         */
/* ------------------------------------------------------------------ */
async function verifyRetryUnderInjectedClock() {
  let failures = 0;
  const rig = createRig({
    objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'local-ahead' }],
    executeImpl: async (item, own) => {
      own.executed.push(item.objectId);
      failures += 1;
      if (failures <= 2) return { ok: false, errorClass: 'transport-unavailable' };
      return { ok: true, verdict: 'reconciled' };
    }
  });
  const key = retryEntryKey({ peer: PEER_A, objectDomain: DOMAIN, objectId: 'rig-000' });

  const first = await rig.scheduler.runOnce();
  equal(first.outcome, P02_ATTEMPT_OUTCOME.TRANSIENT, 'transport failure classes as transient');
  const entry = rig.scheduler.retryIndex.entries[key];
  equal(entry.attemptCount, 1, 'attempt count is memoised operationally');
  check(entry.nextAttemptAt > rig.clockMs, 'a transient failure schedules a future attempt');

  const tooEarly = await rig.scheduler.runOnce();
  equal(tooEarly.dispatched, false, 'backoff suppresses the retry until it is due');
  equal(rig.executed.length, 1, 'no execution happens before the backoff elapses');

  rig.clockMs = entry.nextAttemptAt;
  const second = await rig.scheduler.runOnce();
  equal(second.dispatched, true, 'advancing the injected clock makes the retry due');
  equal(rig.scheduler.retryIndex.entries[key].attemptCount, 2, 'attempts accumulate');
  check(rig.scheduler.retryIndex.entries[key].nextAttemptAt >
    entry.nextAttemptAt, 'backoff widens between attempts');

  rig.clockMs = rig.scheduler.retryIndex.entries[key].nextAttemptAt;
  const third = await rig.scheduler.runOnce();
  equal(third.outcome, P02_ATTEMPT_OUTCOME.PROGRESS, 'the retry eventually succeeds');
  equal(rig.scheduler.retryIndex.entries[key], undefined,
    'a successful attempt clears the retry entry');
  scenario('Z5-S08 bounded retry/backoff advances only under the injected clock');
}

/* ------------------------------------------------------------------ */
/* 9. Integrity failures are not blindly retried                       */
/* ------------------------------------------------------------------ */
async function verifyIntegrityIsNotRetried() {
  const rig = createRig({
    objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'local-ahead' }],
    executeImpl: async (item, own) => {
      own.executed.push(item.objectId);
      return { ok: false, errorClass: 'integrity' };
    }
  });
  const key = retryEntryKey({ peer: PEER_A, objectDomain: DOMAIN, objectId: 'rig-000' });
  const outcome = await rig.scheduler.runOnce();
  equal(outcome.outcome, P02_ATTEMPT_OUTCOME.INTEGRITY, 'integrity failure keeps its own class');
  equal(rig.scheduler.retryIndex.entries[key].nextAttemptAt, Number.POSITIVE_INFINITY,
    'integrity failure is terminal until external intervention, never timer-retried');
  rig.clockMs += 10 ** 9;
  equal((await rig.scheduler.runOnce()).dispatched, false,
    'no amount of elapsed time revives an integrity failure');
  equal(rig.executed.length, 1, 'integrity failure is never blindly re-executed');
  scenario('Z5-S09 integrity failures are terminal-until-intervention, not retry fodder');
}

async function verifyIndeterminateOutcome() {
  const rig = createRig({
    objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'local-ahead' }],
    executeImpl: async (item, own) => {
      own.executed.push(item.objectId);
      return { ok: false, errorClass: 'indeterminate' };
    }
  });
  const key = retryEntryKey({ peer: PEER_A, objectDomain: DOMAIN, objectId: 'rig-000' });
  const outcome = await rig.scheduler.runOnce();
  equal(outcome.outcome, P02_ATTEMPT_OUTCOME.INDETERMINATE,
    'a conflict/indeterminate result keeps its own operational class');
  equal(rig.scheduler.retryIndex.entries[key].nextAttemptAt, Number.POSITIVE_INFINITY,
    'indeterminate work waits for a state change, never for a timer');
  rig.clockMs += 10 ** 9;
  equal((await rig.scheduler.runOnce()).dispatched, false,
    'elapsed time alone never revives indeterminate work');
  scenario('Z5-S09b indeterminate results are distinguished from transient failures');
}

/* ------------------------------------------------------------------ */
/* 10. Wake coalescing and stale-decision revalidation                 */
/* ------------------------------------------------------------------ */
async function verifyWakeCoalescing() {
  const rig = createRig({ objects: rigObjects(2) });
  rig.scheduler.wake('remote-evidence');
  rig.scheduler.wake('remote-evidence');
  rig.scheduler.wake('permission-granted');
  equal(rig.scheduler.wakeGeneration, 3, 'each wake advances the generation stamp');
  deepEqual(rig.scheduler.pendingWakeReasons.sort(),
    ['permission-granted', 'remote-evidence'],
    'redundant wakes coalesce while distinct reasons survive');
  const outcome = await rig.scheduler.runOnce();
  equal(outcome.wakeReason, 'permission-granted+remote-evidence',
    'wake attribution reaches the dispatched attempt');
  equal(rig.scheduler.pendingWakeReasons.length, 0, 'consumed wakes do not replay');

  const second = await rig.scheduler.runOnce();
  equal(second.dispatched, true,
    'a superseded wake never removes an object that still has canonical work');
  deepEqual([...new Set(rig.executed)].sort(), ['rig-000', 'rig-001'],
    'coalescing loses no object');

  /* A decision that goes stale between selection and dispatch must not run. */
  const racing = createRig({
    objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'local-ahead' }]
  });
  let classifyCalls = 0;
  racing.scheduler.classify = async () => {
    classifyCalls += 1;
    return classifyCalls === 1
      ? { classification: 'local-ahead' }
      : { classification: 'blocked(permission)' };
  };
  const stale = await racing.scheduler.runOnce();
  equal(stale.dispatched, false, 'a stale scheduling decision is rejected before dispatch');
  equal(stale.reason, 'stale-decision-revalidated', 'the recheck is reported explicitly');
  equal(racing.executed.length, 0,
    'canonical state, not an old scheduler record, decides the dispatch');
  scenario('Z5-S10 wake coalescing plus completion-race revalidation before dispatch');
}

/* ------------------------------------------------------------------ */
/* 11. Restart / reconstruction; no durable op queue                   */
/* ------------------------------------------------------------------ */
async function verifyReconstruction() {
  const rig = createRig({
    objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'local-ahead' }],
    executeImpl: async (item, own) => {
      own.executed.push(item.objectId);
      return { ok: false, errorClass: 'transport-unavailable' };
    }
  });
  await rig.scheduler.runOnce();
  check(Object.keys(rig.scheduler.retryIndex.entries).length === 1, 'a retry memo exists');

  /* Losing the rebuildable index must lose no canonical pending work. */
  rig.scheduler.dropRetryIndex();
  rig.scheduler.dropRotationState();
  equal(Object.keys(rig.scheduler.retryIndex.entries).length, 0, 'the index is gone');
  const rebuilt = await rig.scheduler.buildCandidates();
  equal(rebuilt.length, 1, 'work is re-derived from canonical state, not from the index');
  equal(rebuilt[0].runnability, P02_RUNNABILITY.RUNNABLE,
    'the re-derived candidate is still eligible');
  equal(rebuilt[0].attemptCount, 0, 'only operational memo was lost, never the work itself');
  const afterLoss = await rig.scheduler.runOnce();
  equal(afterLoss.dispatched, true, 'the object still runs after index loss');

  /* A fresh process-equivalent scheduler converges to the same decisions. */
  const cold = createRig({ objects: rigObjects(4) });
  const coldTrace = (await cold.scheduler.runSteps(4)).map((item) => item.objectId);
  const warm = createRig({ objects: rigObjects(4) });
  const warmTrace = (await warm.scheduler.runSteps(4)).map((item) => item.objectId);
  deepEqual(warmTrace, coldTrace, 'reconstruction reproduces an identical schedule');
  equal(new Set(coldTrace).size, 4, 'reconstruction loses no object');

  const index = createRetryIndex();
  equal(index.schema, P02_SCHEDULER_V2.RETRY_INDEX_SCHEMA, 'the retry index is a typed memo');
  deepEqual(Object.keys(index.entries), [], 'a fresh index starts empty');
  scenario('Z5-S11 rebuildable index: dropping it loses no canonical work and fabricates none');
}

/* ------------------------------------------------------------------ */
/* 12. Scale + mixture matrix                                          */
/* ------------------------------------------------------------------ */
async function verifyScaleMatrix() {
  const results = {};
  for (const count of [1, 10, 100]) {
    const rig = createRig({ objects: rigObjects(count) });
    const trace = (await rig.scheduler.runSteps(count + 1)).map((item) => item.objectId);
    equal(trace.length, count, `${count}-object profile makes complete progress`);
    equal(new Set(trace).size, count, `${count}-object profile starves nobody`);
    const repeat = createRig({ objects: rigObjects(count) });
    deepEqual((await repeat.scheduler.runUntilIdle({ maxSteps: count + 1 }))
      .map((item) => item.objectId),
    trace, `${count}-object drain-to-idle is deterministic across runs`);
    results[`objects${count}`] = 'PASS';
  }

  /* Mixed population: a permanently blocked object cannot stall the rest. */
  const classifications = [
    'local-ahead', 'remote-ahead', 'converged', 'object-deleted',
    'blocked(asset)', 'blocked(permission)', 'blocked(transport)',
    'blocked(format)', 'blocked(capacity)', 'diverged-unresolved',
    'resolution-target-missing', 'resolution-conflict', 'integrity-quarantined',
    'unsupported-format'
  ];
  const mixed = createRig({
    objects: classifications.map((classification, index) => ({
      objectId: `mix-${String(index).padStart(3, '0')}`,
      objectKey: (index % 2 === 0 ? 'e' : 'f').repeat(64),
      classification
    }))
  });
  const runnableIds = classifications
    .map((classification, index) => ({ classification, index }))
    .filter(({ classification }) =>
      classificationRunnability(classification) === P02_RUNNABILITY.RUNNABLE)
    .map(({ index }) => `mix-${String(index).padStart(3, '0')}`);
  const mixedTrace = (await mixed.scheduler.runSteps(classifications.length + 2))
    .map((item) => item.objectId);
  deepEqual([...new Set(mixedTrace)].sort(), runnableIds.sort(),
    'exactly the runnable subset of a mixed population executes');
  results.mixedPopulation = 'PASS';

  /* One continuously eligible object must not monopolise the rotation. */
  const greedy = createRig({ objects: rigObjects(5) });
  greedy.scheduler.execute = async (item) => {
    greedy.executed.push(item.objectId);
    if (item.objectId !== 'rig-000') {
      greedy.state.get(item.objectId).classification = 'converged';
    }
    return { ok: true, verdict: 'reconciled' };
  };
  const greedyTrace = (await greedy.scheduler.runSteps(12)).map((item) => item.objectId);
  equal(new Set(greedyTrace).size, 5,
    'a permanently eligible object still yields to every peer');
  equal(greedyTrace[0], 'rig-000', 'rotation starts at the first ordered candidate');
  results.greedyFairness = 'PASS';
  scenario('Z5-S12 scale matrix 1/10/100 plus mixed and greedy populations stay fair');
  return results;
}

/* ------------------------------------------------------------------ */
/* 13. Integration with the Z2 harness (real reconcileOneObject)       */
/* ------------------------------------------------------------------ */
async function verifyHarnessIntegration() {
  const world = new DeterministicMultiObjectWorld();
  for (let index = 0; index < 6; index += 1) {
    const objectId = `z5-${String(index).padStart(2, '0')}`;
    await world.addObject(PEER_A, { objectDomain: DOMAIN, objectId });
    const root = await makeRevision({
      objectId,
      revisionId: `${objectId}-root`,
      writerSyncPeerId: PEER_A,
      payloadValue: index
    });
    await world.seedCanonical(PEER_A, objectId, root);
  }
  check(world.scheduler(PEER_A) instanceof P02ObjectScheduler,
    'the harness drives the real production scheduler, not a scratch one');
  equal(world.rebuildable.clockMs, 0, 'the harness starts at a deterministic zero clock');
  equal(world.advanceClock(5000), 5000, 'the harness clock advances only when told to');
  equal(world.scheduler(PEER_A).now(), 5000,
    'the scheduler reads the injected clock, never a wall clock');

  const progress = await world.runEligibleSteps(PEER_A, 8);
  equal(progress.length, 6, 'every seeded object converges through the real scheduler');
  equal(new Set(progress.map((item) => item.candidate.objectId)).size, 6,
    'the real scheduler starves no object over reconcileOneObject()');
  for (const item of progress) {
    equal(item.candidate.schema, P02_SCHEDULER_V2.CANDIDATE_SCHEMA,
      'dispatch carries a Y-3 candidate');
  }
  const invariantIds = await world.assertInvariants();
  deepEqual(invariantIds, Object.values(INVARIANT).sort(),
    'all Z2 invariants still hold with the production scheduler in place');

  /* Blocked objects are enumerated but never dispatched. */
  const blocked = new DeterministicMultiObjectWorld();
  await blocked.addObject(PEER_A, { objectDomain: DOMAIN, objectId: 'z5-blocked' });
  const blockedRoot = await makeRevision({
    objectId: 'z5-blocked',
    revisionId: 'z5-blocked-root',
    writerSyncPeerId: PEER_A
  });
  await blocked.seedCanonical(PEER_A, 'z5-blocked', blockedRoot);
  blocked.setCapacityBlocked(PEER_A, 'z5-blocked', true);
  equal(blocked.classify(PEER_A, 'z5-blocked').classification, 'blocked(capacity)',
    'the harness object is genuinely capacity-blocked');
  equal((await blocked.runEligibleSteps(PEER_A, 3)).length, 0,
    'no capacity-blocked object is ever dispatched');
  blocked.governedSyntheticCapacityRelief(PEER_A, 'z5-blocked');
  equal((await blocked.runEligibleSteps(PEER_A, 3)).length, 1,
    'governed relief restores eligibility with no scheduler repair');
  deepEqual(await blocked.assertInvariants(), Object.values(INVARIANT).sort(),
    'capacity recovery preserves every invariant');

  /* Anti-echo: a remote-applied revision is never republished by a replay. */
  const echo = new DeterministicMultiObjectWorld();
  await echo.addObject(PEER_A, { objectDomain: DOMAIN, objectId: 'z5-echo' });
  const remote = await makeRevision({
    objectId: 'z5-echo',
    revisionId: 'z5-echo-remote',
    writerSyncPeerId: 'harness-peer-b'
  });
  await echo.admitRevision(PEER_A, 'z5-echo', remote, { sourceWriter: 'harness-peer-b' });
  await echo.runEligibleSteps(PEER_A, 4);
  const snapshot = echo.objectSnapshot(PEER_A, 'z5-echo');
  check(!snapshot.publishedHashes.includes(remote.blobSha256),
    'a remote-applied revision is never echoed back as a local publication');
  deepEqual(await echo.assertInvariants(), Object.values(INVARIANT).sort(),
    'anti-echo provenance survives scheduler replay');

  /* Manual mode: enumerated and classified, never mutated. */
  const manual = new DeterministicMultiObjectWorld();
  await manual.addObject(PEER_A, { objectDomain: DOMAIN, objectId: 'z5-manual' });
  const manualRoot = await makeRevision({
    objectId: 'z5-manual',
    revisionId: 'z5-manual-root',
    writerSyncPeerId: PEER_A
  });
  await manual.seedCanonical(PEER_A, 'z5-manual', manualRoot);
  manual.setAuthorityMode(PEER_A, 'manual');
  equal((await manual.runEligibleSteps(PEER_A, 3)).length, 0,
    'manual mode dispatches nothing');
  const manualCandidates = await manual.scheduler(PEER_A).buildCandidates();
  equal(manualCandidates.length, 1, 'manual mode still enumerates and classifies the object');
  deepEqual(await manual.assertInvariants(), Object.values(INVARIANT).sort(),
    'manual mode remains non-mutating');

  /* Full-world restart reconstructs the same semantic outcome. */
  const restarted = world.restart();
  const afterRestart = await restarted.runEligibleSteps(PEER_A, 8);
  equal(afterRestart.length, 0,
    'a restart re-derives state and replays no already-converged work');
  deepEqual(await restarted.assertInvariants(), Object.values(INVARIANT).sort(),
    'restart fabricates nothing and loses nothing');
  scenario('Z5-S13 real scheduler over reconcileOneObject(): fairness, blocking, anti-echo, restart');
}

/* ------------------------------------------------------------------ */
/* 14. Anti-degeneracy controls                                        */
/* ------------------------------------------------------------------ */
async function verifyAntiDegeneracy() {
  /* AD01 — a policy that always picks the same object must starve peers. */
  await requireRed('Z5-AD01-always-same-object', async () => {
    const rig = createRig({
      objects: rigObjects(3),
      extra: { selectCandidate: (candidates) => sortSchedulerCandidates(candidates)[0] }
    });
    rig.scheduler.execute = async (item) => {
      rig.executed.push(item.objectId);
      return { ok: true, verdict: 'reconciled' };
    };
    /* Each bounded drain now attempts an object at most once, so exercise the
     * rotation policy across three distinct drains. A degenerate selector then
     * chooses the first object every time and the RED remains load-bearing. */
    const trace = [];
    for (let pass = 0; pass < 3; pass += 1) {
      trace.push(...(await rig.scheduler.runSteps(1)).map((item) => item.objectId));
    }
    assert.equal(new Set(trace).size, 3, 'degenerate policy must not be fair');
  });

  /* AD02 — skipping the stale-decision recheck dispatches superseded work. */
  await requireRed('Z5-AD02-stale-decision-dispatched', async () => {
    const rig = createRig({
      objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'local-ahead' }]
    });
    let calls = 0;
    rig.scheduler.classify = async () => {
      calls += 1;
      return calls === 1
        ? { classification: 'local-ahead' }
        : { classification: 'blocked(permission)' };
    };
    /* Degenerate variant: trust the stale selection instead of re-reading. */
    rig.scheduler.revalidate = async (selected) => ({
      classification: selected.classification
    });
    const outcome = await rig.scheduler.runOnce();
    assert.equal(outcome.dispatched, false,
      'a superseded decision must not reach canonical mutation');
  });

  /* AD03 — admitting blocked candidates executes a capacity-blocked object. */
  await requireRed('Z5-AD03-blocked-capacity-executed', async () => {
    const rig = createRig({
      objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'blocked(capacity)' }]
    });
    /*
     * Degenerate variant: admit non-runnable candidates AND report them as
     * runnable at revalidation. Both guards must be defeated for a blocked
     * object to reach execution, which is what makes the pair load-bearing.
     */
    rig.scheduler.dueCandidates = (candidates) => candidates;
    rig.scheduler.revalidate = async () => ({ classification: 'local-ahead' });
    await rig.scheduler.runOnce();
    assert.equal(rig.executed.length, 0,
      'a capacity-blocked object must never produce a canonical effect');
  });

  /* AD04 — advancing the completion marker before the effect. */
  await requireRed('Z5-AD04-marker-before-effect', async () => {
    let markerPresentDuringEffect = null;
    const key = retryEntryKey({ peer: PEER_A, objectDomain: DOMAIN, objectId: 'rig-000' });
    const rig = createRig({
      objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'local-ahead' }],
      executeImpl: async (item, own) => {
        /* Degenerate: stamp completion state before the canonical effect. */
        own.scheduler.commitCompletion(
          item,
          { outcome: P02_ATTEMPT_OUTCOME.TRANSIENT, errorClass: 'pre-stamped' },
          own.clockMs
        );
        markerPresentDuringEffect = own.scheduler.retryIndex.entries[key] !== undefined;
        own.executed.push(item.objectId);
        return { ok: false, errorClass: 'transport-unavailable' };
      }
    });
    await rig.scheduler.runOnce();
    assert.equal(markerPresentDuringEffect, false,
      'no completion marker may exist before the canonical effect returns');
  });

  /* AD05 — sourcing work from the index turns it into a durable op queue. */
  await requireRed('Z5-AD05-index-as-work-authority', async () => {
    const rig = createRig({
      objects: [{ objectId: 'rig-000', objectKey: KEY_A, classification: 'local-ahead' }]
    });
    /* Degenerate: enumerate only what the rebuildable index remembers. */
    rig.scheduler.enumerate = async () =>
      Object.values(rig.scheduler.retryIndex.entries).map((entry) => ({
        objectDomain: entry.objectDomain,
        objectId: entry.objectId,
        objectKey: KEY_A
      }));
    rig.scheduler.dropRetryIndex();
    const candidates = await rig.scheduler.buildCandidates();
    assert.equal(candidates.length, 1,
      'canonical work must survive loss of the rebuildable index');
  });

  /* AD06 — caching the authority decision keeps mutating after withdrawal. */
  await requireRed('Z5-AD06-stale-auto-mode', async () => {
    const rig = createRig({ objects: rigObjects(2) });
    let cached = null;
    rig.scheduler.authority = async () => {
      /* Degenerate: decide mode once and reuse it forever. */
      cached ||= { mode: rig.mode, valid: rig.valid };
      return cached;
    };
    await rig.scheduler.runOnce();
    rig.mode = 'manual';
    const after = await rig.scheduler.runOnce();
    assert.equal(after.dispatched, false,
      'withdrawn authority must immediately stop canonical mutation');
  });

  scenario('Z5-AD anti-degeneracy: fairness, staleness, blocking, ordering, index, authority');
}

async function main() {
  verifyCandidateContract();
  verifyRunnabilityMapping();
  verifyBackoff();
  verifyRotationPolicy();
  await verifyAuthorityGates();
  await verifyNonRunnableExclusion();
  await verifyCapacityBoundary();
  await verifyRetryUnderInjectedClock();
  await verifyIntegrityIsNotRetried();
  await verifyIndeterminateOutcome();
  await verifyWakeCoalescing();
  await verifyReconstruction();
  const scale = await verifyScaleMatrix();
  await verifyHarnessIntegration();
  await verifyAntiDegeneracy();

  console.log(JSON.stringify({
    verdict: 'P02_WAVE1_Z5_SCHEDULER_CORE_PASS',
    assertions,
    deterministicScenarios: scenarios.length,
    scenarios,
    scale,
    antiDegeneracyControls: antiDegeneracy,
    schedulingPolicy: 'deterministic-rotation-cursor (starvation-free; round-robin not frozen)',
    canonicalWorkAuthority: 'canonical-protocol-state',
    rebuildableSchedulerState: ['retry index', 'rotation cursor', 'wake attribution'],
    durableOpQueue: false,
    concurrentCanonicalApply: false,
    fastCheckAdopted: false,
    liveStateMutation: false,
    platformRuntimeWiring: false,
    v9Resolved: false
  }, null, 2));
}

await main();
