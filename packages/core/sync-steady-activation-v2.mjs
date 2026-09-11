/*
 * O1-B2 — explicitly authorized, bounded P02 steady activation.
 *
 * T18 built the steady driver and left it dormant in three independent ways:
 * nothing called it, the gate refused, and the Rust lease refused. Closing the
 * rehearsal blocker means supplying the FIRST of those three - a caller - and
 * only the first. The other two remain exactly as they were, which is why this
 * module reads authority rather than granting it.
 *
 * WHAT THIS IS NOT. It is not a service. There is no timer, no listener, no
 * startup registration, no persisted `enabled` flag, and no loop. A pass
 * happens because someone deliberately asked for one, carrying two tokens, and
 * then it stops. A second pass needs a second decision.
 *
 * That matters more than it sounds. "generation = p02" is a statement about who
 * OWNS the data; it is not an instruction to start writing. If the mere presence
 * of a p02 record started a writer, then the standdown ceremony - whose whole
 * job is to write that record - would silently start production traffic as its
 * side effect. So no writer begins because a record exists. A writer begins
 * because an operator said so, and only for as many passes as they said.
 *
 * BOTH AUTHORITIES ARE READ, AND BOTH MUST AGREE. There are two records, and
 * they answer different questions:
 *
 *   the DB gate    must say P01 is REFUSED - proven through the production
 *                  predicate, not by string comparison
 *   the repo lease must say p02 - read through the same reader the Rust steady
 *                  lease consults
 *
 * Either one alone is a half-transition. Running on the repository record alone
 * would write while P01 may still be writing; running on the database record
 * alone would write without the lease that serialises writers. Both, or refuse.
 *
 * EVERY UNKNOWN REFUSES. Unreadable, malformed, absent, mismatched: none of
 * them is permission. This is the same rule the gate itself lives by, restated
 * at the point where it would actually cost something to get wrong.
 */

import { p01MutationPermitted, P02_GENERATION_STATE }
  from './sync-writer-generation-v2.mjs';

export const P02_STEADY_ACTIVATION = Object.freeze({
  SCHEMA: 'h2o.studio.syncSteadyActivation.p02.v1',
  /* Distinct from the standdown tokens: authorizing a standdown must not also
   * authorize a writer to start. */
  GOVERNED_CAMPAIGN: 'P02_T20_BOUNDED_STEADY_ACTIVATION',
  OPERATOR_AUTHORIZATION: 'P02_T20_OPERATOR_AUTHORIZED_BOUNDED_STEADY_PASS',
  /* A bound, not a default that can be raised at the call site into a loop. */
  MAX_BOUNDED_PASSES: 8
});

export const P02_ACTIVATION_REFUSAL = Object.freeze({
  NOT_AUTHORIZED: 'p02-steady-activation-not-authorized',
  REQUEST_INVALID: 'p02-steady-activation-request-invalid',
  PASS_BOUND_EXCEEDED: 'p02-steady-activation-pass-bound-exceeded',
  DATABASE_UNREADABLE: 'p02-steady-activation-database-generation-unreadable',
  DATABASE_NOT_P02: 'p02-steady-activation-database-generation-not-p02',
  P01_STILL_PERMITTED: 'p02-steady-activation-p01-still-permitted',
  REPOSITORY_UNREADABLE: 'p02-steady-activation-repository-generation-unreadable',
  REPOSITORY_NOT_P02: 'p02-steady-activation-repository-generation-not-p02',
  BINDING_INVALID: 'p02-steady-activation-binding-invalid',
  WRITER_IDENTITY_MISMATCH: 'p02-steady-activation-writer-identity-mismatch',
  COMPOSITION_INVALID: 'p02-steady-activation-composition-invalid'
});

/* The outcome classes a governed campaign must be able to tell apart. An
 * integrity refusal flattened into "no-op" is how a corrupt repository looks
 * like a quiet success. */
export const P02_ACTIVATION_OUTCOME = Object.freeze({
  REFUSED: 'refused',
  NO_OP: 'completed-no-op',
  APPLIED: 'applied',
  PUBLISHED: 'published',
  BLOCKED: 'blocked',
  RETRYABLE_TRANSPORT: 'retryable-transport',
  INTEGRITY: 'integrity',
  STALE_CAS: 'stale-cas'
});

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isFunction = (value) => typeof value === 'function';

const refusal = (reason, detail = {}) => Object.freeze({
  schema: P02_STEADY_ACTIVATION.SCHEMA,
  outcome: P02_ACTIVATION_OUTCOME.REFUSED,
  activated: false, passesRun: 0, mutated: false,
  reason, ...detail
});

/*
 * Map one runtime pass report into the campaign-facing outcome.
 *
 * The driver already maps a steady result into the scheduler taxonomy; this
 * maps that taxonomy into the classes a campaign acts on. The two are kept
 * separate because the scheduler's question is "retry how?" and the campaign's
 * is "did anything happen, and is it safe to continue?".
 */
export function classifyPassOutcome(report) {
  /* The runtime reports `dispatched`, one entry per attempt, already carrying
   * the accepted scheduler taxonomy. Reading that taxonomy rather than
   * re-deriving one keeps this mapping honest: a class the scheduler treats as
   * retryable must not be reported here as a quiet success. */
  const dispatched = Array.isArray(report?.dispatched) ? report.dispatched : [];
  const has = (outcome) => dispatched.some((entry) => clean(entry?.outcome) === outcome);

  /* Severity order. Integrity first, because an integrity refusal that arrives
   * alongside a published object is still the thing a campaign must stop on. */
  if (has('integrity')) return P02_ACTIVATION_OUTCOME.INTEGRITY;
  if (has('indeterminate')) return P02_ACTIVATION_OUTCOME.BLOCKED;
  if (has('blocked')) return P02_ACTIVATION_OUTCOME.BLOCKED;
  if (has('transient')) return P02_ACTIVATION_OUTCOME.RETRYABLE_TRANSPORT;

  if (has('progress')) {
    /* `progress` covers both directions; the dispatch entry says which. */
    const published = dispatched.some((entry) =>
      clean(entry?.outcome) === 'progress' && clean(entry?.direction) === 'publish');
    return published ? P02_ACTIVATION_OUTCOME.PUBLISHED : P02_ACTIVATION_OUTCOME.APPLIED;
  }
  /* A stale CAS surfaces as a no-effect publish attempt: the base moved, so the
   * pass did nothing and the next one re-plans. Distinguished from a genuine
   * no-op so a campaign can tell "nothing to do" from "someone else moved". */
  if (report?.staleBase === true) return P02_ACTIVATION_OUTCOME.STALE_CAS;
  return P02_ACTIVATION_OUTCOME.NO_OP;
}

/*
 * Build the activation seam.
 *
 * Every capability is injected, exactly as the receive and apply cores are, so
 * a platform supplies its production adapters and a test supplies disposable
 * fixtures over the SAME adapters. Nothing here reaches for a path, a database
 * or a transport of its own.
 */
export function createBoundedSteadyActivation({
  /* -> the four-state observation from the production generation reader */
  observeDatabaseGeneration,
  /* -> { state: 'p02' | 'absent' | 'not-p02' | 'unreadable' } */
  observeRepositoryGeneration,
  /* -> { valid: boolean, writerKey, repositoryRoot } */
  resolveBinding,
  /* -> a driver built from the REAL createP02SteadyDriver over real adapters */
  buildDriver,
  onTrace = null
} = {}) {
  for (const port of [observeDatabaseGeneration, observeRepositoryGeneration,
    resolveBinding, buildDriver]) {
    if (!isFunction(port)) throw new TypeError(P02_ACTIVATION_REFUSAL.COMPOSITION_INVALID);
  }
  const trace = isFunction(onTrace) ? onTrace : () => {};

  /*
   * The preflight. Ordered so the cheapest refusal comes first and so no
   * authority is read at all until the request is authorized - an unauthorized
   * caller learns nothing about the installation's state.
   */
  async function preflight({ governedCampaign, operatorAuthorization, expectedWriterKey }) {
    if (governedCampaign !== P02_STEADY_ACTIVATION.GOVERNED_CAMPAIGN ||
        operatorAuthorization !== P02_STEADY_ACTIVATION.OPERATOR_AUTHORIZATION) {
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.NOT_AUTHORIZED) };
    }

    /* 1. The DB gate must say P01 is REFUSED. Asserted through the production
     * predicate: "the string says p02" and "P01 may not mutate" are different
     * claims, and only the second one is the one that matters. */
    let database;
    try { database = await observeDatabaseGeneration(); }
    catch (_) {
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.DATABASE_UNREADABLE) };
    }
    const state = clean(database?.state);
    if (state === P02_GENERATION_STATE.UNOBSERVED ||
        state === P02_GENERATION_STATE.MALFORMED) {
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.DATABASE_UNREADABLE,
        { observationState: state }) };
    }
    const verdict = p01MutationPermitted(database);
    if (verdict.permitted === true) {
      /* Absent or p01: P01 may still write. Starting a second writer here is
       * precisely the dual-writer state the standdown ordering prevents. */
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.DATABASE_NOT_P02,
        { observationState: state }) };
    }
    if (clean(verdict.reason) !== 'p01-writer-stood-down') {
      /* Refused for some OTHER reason - malformed, unobserved. A refusal we did
       * not intend is not a licence. */
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.P01_STILL_PERMITTED,
        { reason: verdict.reason }) };
    }

    /* 2. The binding, before the repository record - the record is read from a
     * path the binding decides. */
    let binding;
    try { binding = await resolveBinding(); }
    catch (_) {
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.BINDING_INVALID) };
    }
    if (binding?.valid !== true || !clean(binding?.writerKey) ||
        !clean(binding?.repositoryRoot)) {
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.BINDING_INVALID) };
    }
    if (clean(expectedWriterKey) && clean(expectedWriterKey) !== clean(binding.writerKey)) {
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.WRITER_IDENTITY_MISMATCH,
        { writerKey: binding.writerKey }) };
    }

    /* 3. The repository lease. */
    let repository;
    try { repository = await observeRepositoryGeneration(binding); }
    catch (_) {
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.REPOSITORY_UNREADABLE) };
    }
    const repositoryState = clean(repository?.state);
    if (repositoryState === 'unreadable') {
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.REPOSITORY_UNREADABLE) };
    }
    if (repositoryState !== 'p02') {
      return { ok: false, refusal: refusal(P02_ACTIVATION_REFUSAL.REPOSITORY_NOT_P02,
        { repositoryState }) };
    }

    return { ok: true, binding };
  }

  return Object.freeze({
    schema: P02_STEADY_ACTIVATION.SCHEMA,
    /* Read-only: a campaign can ask whether a pass WOULD be authorized without
     * running one. */
    async check(request = {}) {
      const result = await preflight(request);
      return result.ok
        ? Object.freeze({ authorized: true, writerKey: result.binding.writerKey,
          repositoryRoot: result.binding.repositoryRoot })
        : Object.freeze({ authorized: false, reason: result.refusal.reason });
    },

    /*
     * One explicitly authorized, bounded run. `passes` is a COUNT, not a
     * duration and not a condition: the seam cannot be asked to run "until
     * converged".
     */
    async runBoundedPass(request = {}) {
      const passes = request.passes === undefined ? 1 : request.passes;
      if (!Number.isInteger(passes) || passes < 1) {
        return refusal(P02_ACTIVATION_REFUSAL.REQUEST_INVALID);
      }
      if (passes > P02_STEADY_ACTIVATION.MAX_BOUNDED_PASSES) {
        return refusal(P02_ACTIVATION_REFUSAL.PASS_BOUND_EXCEEDED, { passes });
      }

      const pre = await preflight(request);
      if (!pre.ok) {
        trace({ stage: 'preflight', reason: pre.refusal.reason });
        return pre.refusal;
      }

      let driver;
      try { driver = await buildDriver(pre.binding); }
      catch (_) {
        return refusal(P02_ACTIVATION_REFUSAL.COMPOSITION_INVALID);
      }
      if (typeof driver?.runtime?.runPass !== 'function') {
        return refusal(P02_ACTIVATION_REFUSAL.COMPOSITION_INVALID);
      }

      const reports = [];
      const outcomes = [];
      for (let index = 0; index < passes; index += 1) {
        /* THE activation seam, verbatim from the accepted driver contract. */
        const report = await driver.runtime.runPass();
        reports.push(report);
        outcomes.push(classifyPassOutcome(report));
        trace({ stage: 'pass', index, outcome: outcomes[index] });
      }

      /* The run's outcome is its most serious pass outcome: a published pass
       * followed by an integrity refusal is not a success. */
      const severity = [
        P02_ACTIVATION_OUTCOME.INTEGRITY, P02_ACTIVATION_OUTCOME.BLOCKED,
        P02_ACTIVATION_OUTCOME.RETRYABLE_TRANSPORT, P02_ACTIVATION_OUTCOME.STALE_CAS,
        P02_ACTIVATION_OUTCOME.PUBLISHED, P02_ACTIVATION_OUTCOME.APPLIED,
        P02_ACTIVATION_OUTCOME.NO_OP
      ];
      const outcome = severity.find((candidate) => outcomes.includes(candidate))
        ?? P02_ACTIVATION_OUTCOME.NO_OP;

      return Object.freeze({
        schema: P02_STEADY_ACTIVATION.SCHEMA,
        outcome,
        activated: true,
        passesRun: reports.length,
        passOutcomes: Object.freeze(outcomes),
        mutated: outcomes.includes(P02_ACTIVATION_OUTCOME.PUBLISHED) ||
          outcomes.includes(P02_ACTIVATION_OUTCOME.APPLIED),
        writerKey: pre.binding.writerKey,
        repositoryRoot: pre.binding.repositoryRoot,
        reports: Object.freeze(reports)
      });
    }
  });
}
