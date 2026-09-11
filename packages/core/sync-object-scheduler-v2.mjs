/*
 * P02 multi-object scheduler core (Wave 1 / Z5).
 *
 * Position (frozen P.1): reconcileOneObject() remains THE atomic per-object
 * convergence operation. This module sits strictly ABOVE it and decides only
 * which object runs next, when a retryable object becomes due again, and how
 * wakes coalesce. It never implements Receive or Apply semantics, never
 * classifies conflicts itself (Y-9 is the authority), never mutates canonical
 * object content, and never becomes a second convergence engine.
 *
 * Module boundary (frozen P.2): platform-neutral, outside the delivery
 * runtime. No timers, no listeners, no transport, no storage, no UI. Every
 * effectful capability arrives through an injected seam, and time arrives
 * through an injected clock so scheduling decisions are deterministic.
 *
 * Work authority (frozen P.3): canonical durable protocol state determines
 * WHAT needs work. The retry index below is a rebuildable memo of operational
 * metadata ONLY. Discarding it loses no canonical work, applies nothing,
 * fabricates nothing, and changes no conflict classification.
 */

import { P02_BLOCK_REASONS } from './sync-object-classifier-v2.mjs';

export const P02_SCHEDULER_V2 = Object.freeze({
  CANDIDATE_SCHEMA: 'h2o.studio.syncSchedulerCandidate.p02.v1',
  RETRY_INDEX_SCHEMA: 'h2o.studio.syncSchedulerRetryIndex.p02.v1'
});

/* Direction is descriptive attribution only; Z4 owns HOW transport executes. */
export const P02_SCHEDULER_DIRECTION = Object.freeze({
  PUBLISH: 'publish',
  RECEIVE: 'receive',
  NONE: 'none'
});

/*
 * Runnability is derived from the Y-9 classification and nothing else. The
 * scheduler never reinterprets a classification: it only decides whether a
 * class is permitted to run canonical mutation now.
 */
export const P02_RUNNABILITY = Object.freeze({
  RUNNABLE: 'runnable',
  IDLE: 'idle',
  BLOCKED: 'blocked',
  INDETERMINATE: 'indeterminate',
  INTEGRITY: 'integrity'
});

/* Small explicit operational taxonomy (frozen P.4 retry requirements). */
export const P02_ATTEMPT_OUTCOME = Object.freeze({
  PROGRESS: 'progress',
  NO_EFFECT: 'no-effect',
  TRANSIENT: 'transient',
  BLOCKED: 'blocked',
  INDETERMINATE: 'indeterminate',
  INTEGRITY: 'integrity'
});

/* Identity of an object within one drain. Domain + id, never the peer: the
 * scheduler runs for exactly one peer. */
function candidateKey(candidate) {
  return `${candidate?.objectDomain ?? ''}\u0000${candidate?.objectId ?? ''}`;
}

export const P02_SCHEDULER_DEFAULT_BACKOFF = Object.freeze({
  baseDelayMs: 1000,
  maxDelayMs: 300000,
  jitterRatio: 0.2
});

const RUNNABLE_CLASSIFICATIONS = Object.freeze(new Set([
  'local-ahead',
  'remote-ahead',
  'object-deleted'
]));

/*
 * Non-mutating conflict/indeterminate states. These are NOT timer-retried:
 * they become eligible again only when canonical/classifier state changes,
 * which every pass re-reads from scratch.
 */
const INDETERMINATE_CLASSIFICATIONS = Object.freeze(new Set([
  'diverged-unresolved',
  'resolution-target-missing',
  'resolution-conflict'
]));

/* Terminal until external intervention: never converted into blind retries. */
const INTEGRITY_CLASSIFICATIONS = Object.freeze(new Set([
  'integrity-quarantined',
  'unsupported-format'
]));

const BLOCKED_RE = /^blocked\(([a-z]+)\)$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SEP = '\u0000';

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]';
}

function requireFunction(value, code) {
  if (typeof value !== 'function') throw new TypeError(code);
  return value;
}

function strictIdentifier(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !CONTROL_RE.test(value);
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value;
  /*
   * Inputs may already be frozen (accepted reconcile results, Y-3 candidates).
   * Return those untouched: freezing must never write into a caller's object,
   * and preserving identity keeps cross-realm vm results comparable.
   */
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) value[key] = freezeDeep(value[key]);
    return Object.freeze(value);
  }
  return value;
}

/* Deterministic, dependency-free hash used only for reproducible jitter. */
function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function blockReasonOf(classification) {
  const match = BLOCKED_RE.exec(String(classification || ''));
  return match ? match[1] : null;
}

/*
 * Y-9 classification -> runnability. Pure lookup; the scheduler adds no
 * conflict meaning of its own.
 */
export function classificationRunnability(classification) {
  const value = String(classification || '');
  if (blockReasonOf(value) !== null) return P02_RUNNABILITY.BLOCKED;
  if (INTEGRITY_CLASSIFICATIONS.has(value)) return P02_RUNNABILITY.INTEGRITY;
  if (INDETERMINATE_CLASSIFICATIONS.has(value)) return P02_RUNNABILITY.INDETERMINATE;
  if (RUNNABLE_CLASSIFICATIONS.has(value)) return P02_RUNNABILITY.RUNNABLE;
  return P02_RUNNABILITY.IDLE;
}

export function directionForClassification(classification) {
  const value = String(classification || '');
  if (value === 'local-ahead') return P02_SCHEDULER_DIRECTION.PUBLISH;
  if (value === 'remote-ahead' || value === 'object-deleted') {
    return P02_SCHEDULER_DIRECTION.RECEIVE;
  }
  return P02_SCHEDULER_DIRECTION.NONE;
}

export function retryEntryKey({ peer, objectDomain, objectId }) {
  return `${peer}${SEP}${objectDomain}${SEP}${objectId}`;
}

/* Y-3 candidate/job descriptor: pure data, no capability, no authority. */
export function createSchedulerCandidate({
  objectDomain,
  objectId,
  objectKey,
  peer,
  direction,
  classification,
  runnability,
  reason = null,
  blockClass = null,
  priority = 0,
  attemptCount = 0,
  nextAttemptAt = 0,
  lastErrorClass = null,
  wakeReason = null,
  wakeGeneration = 0
} = {}) {
  if (!strictIdentifier(objectDomain) ||
      !strictIdentifier(objectId) ||
      !strictIdentifier(peer) ||
      typeof objectKey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(objectKey) ||
      !Object.values(P02_SCHEDULER_DIRECTION).includes(direction) ||
      !Object.values(P02_RUNNABILITY).includes(runnability) ||
      !Number.isInteger(attemptCount) || attemptCount < 0 ||
      typeof nextAttemptAt !== 'number' || Number.isNaN(nextAttemptAt) ||
      !Number.isFinite(priority)) {
    throw new TypeError('p02-scheduler-candidate-invalid');
  }
  return freezeDeep({
    schema: P02_SCHEDULER_V2.CANDIDATE_SCHEMA,
    objectDomain,
    objectId,
    objectKey,
    peer,
    direction,
    classification,
    runnability,
    reason,
    blockClass,
    priority,
    attemptCount,
    nextAttemptAt,
    lastErrorClass,
    wakeReason,
    wakeGeneration,
    orderingKey: `${objectDomain}${SEP}${objectId}${SEP}${peer}`
  });
}

export function sortSchedulerCandidates(candidates) {
  if (!Array.isArray(candidates)) {
    throw new TypeError('p02-scheduler-candidates-invalid');
  }
  return Object.freeze([...candidates].sort((left, right) =>
    (right.priority - left.priority) ||
      left.orderingKey.localeCompare(right.orderingKey) ||
      left.objectKey.localeCompare(right.objectKey)));
}

/*
 * Rebuildable retry/scheduler index (frozen P.3). Operational metadata only:
 * identity, next attempt time, attempt count, priority, error/block class and
 * wake attribution. It stores no head, no revision, no evidence and no
 * conflict verdict, so discarding it cannot lose or fabricate canonical work.
 */
export function createRetryIndex(entries = {}) {
  return {
    schema: P02_SCHEDULER_V2.RETRY_INDEX_SCHEMA,
    entries: { ...entries }
  };
}

export function computeBackoffDelayMs({
  attemptCount,
  baseDelayMs = P02_SCHEDULER_DEFAULT_BACKOFF.baseDelayMs,
  maxDelayMs = P02_SCHEDULER_DEFAULT_BACKOFF.maxDelayMs,
  jitterRatio = P02_SCHEDULER_DEFAULT_BACKOFF.jitterRatio,
  jitterKey = ''
} = {}) {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) {
    throw new TypeError('p02-scheduler-backoff-attempt-invalid');
  }
  const exponent = Math.min(attemptCount - 1, 30);
  const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exponent));
  if (!(jitterRatio > 0)) return raw;
  const span = Math.floor(raw * Math.min(jitterRatio, 1));
  if (span <= 0) return raw;
  /* Deterministic, bounded, subtractive jitter: never exceeds maxDelayMs. */
  const offset = fnv1a32(`${jitterKey}${SEP}${attemptCount}`) % (span + 1);
  return raw - offset;
}

/*
 * Selected scheduling policy (frozen P.5 leaves the policy to implementation).
 *
 * Smallest deterministic starvation-free rule: keep one rotation cursor over
 * the deterministic ordering key and always take the next candidate strictly
 * after it, wrapping to the first. A continuously eligible object therefore
 * yields the slot to every other eligible object before it can be chosen
 * again, so no eligible non-blocked object waits longer than one rotation.
 * Round-robin is NOT frozen by this choice; only starvation-freedom is.
 */
export function rotationSelect(candidates, cursorKey = '') {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const ordered = sortSchedulerCandidates(candidates);
  return ordered.find((candidate) => candidate.orderingKey > cursorKey) || ordered[0];
}

export class P02ObjectScheduler {
  constructor({
    peerId,
    clock,
    enumerate,
    classify,
    execute,
    authority,
    retryIndex = null,
    backoff = {},
    selectCandidate = rotationSelect,
    onTrace = null
  } = {}) {
    /* Objects that reported no-effect during the current drain. Reset by
     * runSteps; initialised here so a direct runOnce() is still valid. */
    this.settledThisDrain = new Set();
    if (!strictIdentifier(peerId)) throw new TypeError('p02-scheduler-peer-invalid');
    if (!isPlainObject(clock) && typeof clock !== 'function') {
      throw new TypeError('p02-scheduler-clock-invalid');
    }
    this.peerId = peerId;
    this.now = typeof clock === 'function'
      ? clock
      : requireFunction(clock.now, 'p02-scheduler-clock-invalid').bind(clock);
    this.enumerate = requireFunction(enumerate, 'p02-scheduler-enumerate-invalid');
    this.classify = requireFunction(classify, 'p02-scheduler-classify-invalid');
    this.execute = requireFunction(execute, 'p02-scheduler-execute-invalid');
    this.authority = requireFunction(authority, 'p02-scheduler-authority-invalid');
    this.selectCandidate = requireFunction(
      selectCandidate,
      'p02-scheduler-policy-invalid'
    );
    this.onTrace = onTrace === null
      ? null
      : requireFunction(onTrace, 'p02-scheduler-trace-invalid');
    this.backoff = { ...P02_SCHEDULER_DEFAULT_BACKOFF, ...backoff };
    this.retryIndex = retryIndex || createRetryIndex();
    /* Rebuildable rotation position; not canonical, not a completion marker. */
    this.cursorKey = '';
    this.wakeGeneration = 0;
    this.pendingWakeReasons = [];
    this.trace = [];
  }

  /*
   * Wake coalescing (frozen P.4). Redundant wakes collapse into one pending
   * pass; distinct reasons are preserved for attribution. A wake is a trigger,
   * never work authority: every pass re-reads canonical state.
   */
  wake(reason = 'unspecified') {
    this.wakeGeneration += 1;
    if (!this.pendingWakeReasons.includes(reason)) {
      this.pendingWakeReasons.push(reason);
    }
    return this.wakeGeneration;
  }

  consumeWakeAttribution() {
    const reasons = [...this.pendingWakeReasons].sort();
    this.pendingWakeReasons = [];
    return reasons.length === 0 ? null : reasons.join('+');
  }

  /* Discarding the index must never lose canonical pending work. */
  dropRetryIndex() {
    this.retryIndex = createRetryIndex();
    return this.retryIndex;
  }

  dropRotationState() {
    this.cursorKey = '';
  }

  /*
   * Transport restoration is evidence about the CHANNEL, not about the work.
   *
   * It therefore releases exactly the entries that are waiting on a timer -
   * which, by commitCompletion above, are exactly the transient ones - and
   * preserves every entry parked at Infinity. A blocked, indeterminate or
   * integrity entry is waiting for a canonical state change that a reachable
   * transport does not supply; releasing those on reconnect would re-dispatch
   * straight back into the same contradiction, and a flapping transport would
   * turn a quarantined object into a spin.
   *
   * Returns the released keys so a caller can report what it forgot.
   */
  dropTimedBackoff() {
    const released = [];
    for (const [key, entry] of Object.entries(this.retryIndex.entries)) {
      if (!Number.isFinite(entry?.nextAttemptAt)) continue;
      delete this.retryIndex.entries[key];
      released.push(key);
    }
    return released.sort();
  }

  retryEntry(candidateLike) {
    return this.retryIndex.entries[retryEntryKey({
      peer: this.peerId,
      objectDomain: candidateLike.objectDomain,
      objectId: candidateLike.objectId
    })] || null;
  }

  /*
   * Y-3 production: Y-1 descriptors + Y-9 classification + the rebuildable
   * retry memo. Strictly read-only - building candidates mutates nothing.
   */
  async buildCandidates() {
    const descriptors = await this.enumerate();
    if (!Array.isArray(descriptors)) {
      throw new TypeError('p02-scheduler-enumerate-result-invalid');
    }
    const wakeReason = this.pendingWakeReasons.length > 0
      ? [...this.pendingWakeReasons].sort().join('+')
      : null;
    const candidates = [];
    for (const descriptor of descriptors) {
      const verdict = await this.classify(descriptor);
      const classification = String(verdict?.classification || '');
      const runnability = classificationRunnability(classification);
      const entry = this.retryEntry(descriptor);
      candidates.push(createSchedulerCandidate({
        objectDomain: descriptor.objectDomain,
        objectId: descriptor.objectId,
        objectKey: descriptor.objectKey,
        peer: this.peerId,
        direction: directionForClassification(classification),
        classification,
        runnability,
        reason: verdict?.reason ?? null,
        blockClass: blockReasonOf(classification),
        priority: entry?.priority ?? 0,
        attemptCount: entry?.attemptCount ?? 0,
        nextAttemptAt: entry?.nextAttemptAt ?? 0,
        lastErrorClass: entry?.lastErrorClass ?? null,
        wakeReason,
        wakeGeneration: this.wakeGeneration
      }));
    }
    return sortSchedulerCandidates(candidates);
  }

  /*
   * Due = runnable classification AND backoff satisfied. Blocked,
   * indeterminate and integrity classes are never due; they re-enter only by
   * canonical/classifier state change, which the next pass re-reads.
   */
  /*
   * An object already attempted in THIS drain is excluded from the rest of it.
   * A no-effect attempt clears its retry entry, and a successful admission can
   * still classify from an earlier remote-ahead snapshot; either would leave
   * the same object immediately due again. The exclusion is per-drain and not
   * durable: the next explicit pass re-reads canonical state. Retryable,
   * blocked and indeterminate outcomes retain their normal retry entries.
   */
  dueCandidates(candidates, now) {
    return candidates.filter((candidate) =>
      candidate.runnability === P02_RUNNABILITY.RUNNABLE &&
      candidate.nextAttemptAt <= now &&
      !this.settledThisDrain.has(candidateKey(candidate)));
  }

  /*
   * Completion marker. Advanced ONLY after the atomic canonical effect has
   * returned, never before (frozen P.4: apply before cursor advancement).
   * Overridable so anti-degeneracy controls can prove the ordering matters.
   */
  commitCompletion(candidate, outcome, now) {
    const key = retryEntryKey({
      peer: this.peerId,
      objectDomain: candidate.objectDomain,
      objectId: candidate.objectId
    });
    if (outcome.outcome === P02_ATTEMPT_OUTCOME.PROGRESS ||
        outcome.outcome === P02_ATTEMPT_OUTCOME.NO_EFFECT) {
      delete this.retryIndex.entries[key];
      return null;
    }
    const previous = this.retryIndex.entries[key] || null;
    const attemptCount = (previous?.attemptCount ?? 0) + 1;
    const entry = {
      peer: this.peerId,
      objectDomain: candidate.objectDomain,
      objectId: candidate.objectId,
      attemptCount,
      lastErrorClass: outcome.errorClass ?? outcome.outcome,
      blockedReason: outcome.blockClass ?? null,
      priority: previous?.priority ?? 0,
      wakeReason: candidate.wakeReason ?? null,
      /*
       * Only transient failures earn a timed retry. Blocked, indeterminate and
       * integrity outcomes wait for an external state change instead of
       * spinning on unchanged work.
       */
      nextAttemptAt: outcome.outcome === P02_ATTEMPT_OUTCOME.TRANSIENT
        ? now + computeBackoffDelayMs({
          attemptCount,
          ...this.backoff,
          jitterKey: key
        })
        : Number.POSITIVE_INFINITY
    };
    this.retryIndex.entries[key] = entry;
    return entry;
  }

  classifyOutcome(result, thrown = null) {
    if (thrown) {
      const code = String(thrown?.code || thrown?.message || 'transient');
      /* A canonical contradiction is a statement about state, not a hiccup:
       * retrying it on a timer would just re-read the same contradiction. */
      if (code === 'canonical-state-contradiction') {
        return { outcome: P02_ATTEMPT_OUTCOME.INTEGRITY, errorClass: code, blockClass: null };
      }
      /* A typed error keeps its identity; an untyped throw says nothing about
       * whether the condition persists, so it is treated as transient. */
      return {
        outcome: P02_ATTEMPT_OUTCOME.TRANSIENT,
        errorClass: thrown?.code ? code : 'transient',
        blockClass: null
      };
    }
    /* Receive/admission already speaks the scheduler's frozen outcome
     * vocabulary. Preserve that exact result instead of flattening every
     * successful function return to progress (which caused a no-effect second
     * read to be reported as another mutation). */
    const explicitOutcome = String(result?.outcome || '');
    if (Object.values(P02_ATTEMPT_OUTCOME).includes(explicitOutcome)) {
      return {
        outcome: explicitOutcome,
        errorClass: explicitOutcome === P02_ATTEMPT_OUTCOME.PROGRESS ||
          explicitOutcome === P02_ATTEMPT_OUTCOME.NO_EFFECT
          ? null
          : String(result?.reason || explicitOutcome),
        blockClass: result?.blockReason ?? null
      };
    }
    if (result && result.ok === false) {
      /* The core's contradiction path returns ok:false with a conflictClass and
       * an errorCode but no errorClass. Reading only errorClass classified that
       * as transient, so a canonical contradiction was retried on a timer
       * forever. A named conflict is indeterminate whether or not `ok` is set. */
      if (result.conflictClass) {
        return {
          outcome: P02_ATTEMPT_OUTCOME.INDETERMINATE,
          errorClass: String(result.conflictClass),
          blockClass: null
        };
      }
      const errorClass = String(result.errorClass || result.errorCode || 'transient');
      if (errorClass === 'integrity' || errorClass === 'malformed') {
        return { outcome: P02_ATTEMPT_OUTCOME.INTEGRITY, errorClass, blockClass: null };
      }
      if (errorClass === 'indeterminate' || errorClass === 'conflict') {
        return {
          outcome: P02_ATTEMPT_OUTCOME.INDETERMINATE,
          errorClass,
          blockClass: null
        };
      }
      if (errorClass.startsWith('blocked')) {
        return {
          outcome: P02_ATTEMPT_OUTCOME.BLOCKED,
          errorClass,
          blockClass: blockReasonOf(errorClass)
        };
      }
      return { outcome: P02_ATTEMPT_OUTCOME.TRANSIENT, errorClass, blockClass: null };
    }
    /*
     * F1b. The accepted core reports several real outcomes WITHOUT an `ok`
     * field, and collapsing every one of them to no-effect erased the
     * difference between "nothing to do" and "refused for a reason". A blocked
     * verdict carries that reason: a conflictClass means the attempt is
     * indeterminate and must wait for external state rather than a timer, while
     * an errorCode names an actual block class.
     */
    const verdict = String(result?.verdict || '');
    if (verdict === 'blocked') {
      const conflictClass = result?.conflictClass ? String(result.conflictClass) : '';
      if (conflictClass) {
        return {
          outcome: P02_ATTEMPT_OUTCOME.INDETERMINATE,
          errorClass: conflictClass,
          blockClass: null
        };
      }
      const errorCode = result?.errorCode ? String(result.errorCode) : '';
      if (errorCode) {
        return {
          outcome: P02_ATTEMPT_OUTCOME.BLOCKED,
          errorClass: errorCode,
          blockClass: blockReasonOf(errorCode) ??
            (P02_BLOCK_REASONS.includes(errorCode) ? errorCode : null)
        };
      }
      /* Blocked with no reason at all really is a no-op report. */
      return { outcome: P02_ATTEMPT_OUTCOME.NO_EFFECT, errorClass: verdict, blockClass: null };
    }
    if (verdict === 'stale' || verdict === 'no-active' || verdict === 'empty') {
      return { outcome: P02_ATTEMPT_OUTCOME.NO_EFFECT, errorClass: verdict, blockClass: null };
    }
    return { outcome: P02_ATTEMPT_OUTCOME.PROGRESS, errorClass: null, blockClass: null };
  }

  /*
   * Fresh read of the classifier for the selected object immediately before
   * dispatch. A selection is only ever a proposal: canonical/classifier state
   * is the authority, so a decision that has been superseded since the pass
   * began must never drive canonical mutation. Overridable so anti-degeneracy
   * controls can prove that removing this recheck is detectable.
   */
  async revalidate(selected) {
    return this.classify({
      objectDomain: selected.objectDomain,
      objectId: selected.objectId,
      objectKey: selected.objectKey
    });
  }

  /*
   * One serialized step (frozen P.1): global mutation ownership -> exactly one
   * eligible object -> the atomic execution seam -> re-evaluate. Concurrent
   * canonical Apply is deliberately not implemented.
   */
  async runOnce() {
    const now = this.now();
    const candidates = await this.buildCandidates();
    /* P.6: authority is re-read every pass and never cached across attempts. */
    const authority = await this.authority();
    /* A trusted W-2c owner may inject one ephemeral Receive/admission
     * capability. It is intentionally distinct from mode=auto: callers cannot
     * persist or synthesize automatic authority merely by running manually. */
    const mayMutate = authority?.valid === true &&
      (authority?.mode === 'auto' ||
        authority?.manualReceiveAdmission === true ||
        authority?.manualApply === true ||
        authority?.manualPublication === true);
    if (!mayMutate) {
      /* manual/notify: enumerated and classified, surfaced, never mutated. */
      return freezeDeep({
        dispatched: false,
        reason: 'authority-non-mutating',
        mode: authority?.mode ?? null,
        candidates
      });
    }
    const due = this.dueCandidates(candidates, now);
    if (due.length === 0) {
      return freezeDeep({
        dispatched: false,
        reason: 'no-due-candidates',
        mode: authority.mode,
        candidates
      });
    }
    const selected = this.selectCandidate(due, this.cursorKey);
    if (!selected) {
      return freezeDeep({
        dispatched: false,
        reason: 'no-selection',
        mode: authority.mode,
        candidates
      });
    }

    /*
     * Completion-race / stale-decision recheck. The selection above was made
     * from a snapshot; re-read the classifier for the selected object before
     * dispatching so a superseded decision can never drive canonical mutation.
     */
    const fresh = await this.revalidate(selected);
    const freshClassification = String(fresh?.classification || '');
    if (classificationRunnability(freshClassification) !== P02_RUNNABILITY.RUNNABLE) {
      /* Rotate so a churning object cannot pin the cursor, but do not run. */
      this.cursorKey = selected.orderingKey;
      return freezeDeep({
        dispatched: false,
        reason: 'stale-decision-revalidated',
        staleClassification: selected.classification,
        freshClassification,
        candidates
      });
    }

    /* Fairness position advances on dispatch; it is not a completion marker. */
    this.cursorKey = selected.orderingKey;
    const wakeReason = this.consumeWakeAttribution();
    const generationAtDispatch = this.wakeGeneration;

    /*
     * F1a. A thrown executor used to escape the pass entirely, so the attempt
     * was never completed and the object stayed dispatched forever - a single
     * throw could stall the queue permanently. A throw is an attempt outcome
     * like any other and is classified, recorded and retried on its own terms.
     */
    let result = null;
    let thrown = null;
    try {
      /* The fresh verdict is the load-bearing pre-dispatch decision. Pass it
       * through to the executor so W-3 consumes the exact selected leaf and
       * typed anchor context that was just revalidated, never a stale page or
       * scheduler snapshot. */
      result = await this.execute(selected, fresh);
    } catch (error) {
      thrown = error;
    }
    /* Canonical effect has now committed (or definitively not). */
    const outcome = this.classifyOutcome(result, thrown);
    /* One object is attempted at most once per bounded drain. A successful
     * Receive admission changes local evidence, but a second same-drain
     * selection can still be based on the earlier remote-ahead snapshot and
     * would duplicate tip-memo/admission work. The next explicit pass re-reads
     * canonical state from scratch. */
    if (outcome.outcome === P02_ATTEMPT_OUTCOME.NO_EFFECT ||
        outcome.outcome === P02_ATTEMPT_OUTCOME.PROGRESS) {
      this.settledThisDrain.add(candidateKey(selected));
    }
    const entry = this.commitCompletion(selected, outcome, now);

    const record = freezeDeep({
      dispatched: true,
      peerId: this.peerId,
      objectDomain: selected.objectDomain,
      objectId: selected.objectId,
      direction: selected.direction,
      classification: selected.classification,
      outcome: outcome.outcome,
      errorClass: outcome.errorClass,
      wakeReason,
      generationAtDispatch,
      supersededDuringAttempt: this.wakeGeneration !== generationAtDispatch,
      nextAttemptAt: entry?.nextAttemptAt ?? null,
      attemptCount: entry?.attemptCount ?? 0,
      candidate: selected,
      result
    });
    this.trace.push(record);
    if (this.onTrace) this.onTrace(record);
    return record;
  }

  /*
   * Bounded drain with a no-progress sentinel: stop as soon as a pass produces
   * no dispatch, so the loop never spins on unchanged work.
   */
  async runUntilIdle({ maxSteps = 1000 } = {}) {
    return this.runSteps(maxSteps);
  }

  async runSteps(maxSteps) {
    if (!Number.isInteger(maxSteps) || maxSteps < 0) {
      throw new TypeError('p02-scheduler-steps-invalid');
    }
    /* Fresh every drain: settled-ness is a statement about this pass only. */
    this.settledThisDrain = new Set();
    const results = [];
    for (let step = 0; step < maxSteps; step += 1) {
      const outcome = await this.runOnce();
      if (!outcome.dispatched) break;
      results.push(outcome);
    }
    return results;
  }

  snapshot() {
    return freezeDeep({
      peerId: this.peerId,
      cursorKey: this.cursorKey,
      wakeGeneration: this.wakeGeneration,
      pendingWakeReasons: [...this.pendingWakeReasons].sort(),
      retryIndex: {
        schema: this.retryIndex.schema,
        entries: Object.fromEntries(
          Object.entries(this.retryIndex.entries).sort(([left], [right]) =>
            left.localeCompare(right))
        )
      },
      dispatchedObjectIds: this.trace
        .filter((item) => item.dispatched)
        .map((item) => item.objectId)
    });
  }
}
