/* H2O Studio Sync — cross-context Chrome P01 mutation admission.
 *
 * Normal P01 writers hold a shared Web Lock for their complete
 * mutation-capable lifetime. A future standdown owner queues the exclusive
 * form of the same lock and therefore waits for every already-admitted writer
 * while preventing later writers from overtaking it. This runtime barrier is
 * deliberately non-persistent: writer-generation remains the canonical
 * durable authority.
 */

export const CHROME_P01_MUTATION_ADMISSION = Object.freeze({
  SCHEMA: 'h2o.studio.syncP01MutationAdmission.v1',
  LEASE_SCHEMA: 'h2o.studio.syncP01MutationAdmissionLease.v1',
  HOLD_SCHEMA: 'h2o.studio.syncP01MutationStanddownHold.v1',
  LOCK_NAME: 'h2o:studio:sync:p01-mutation-admission:v1',
  ERROR: Object.freeze({
    SERIALIZATION_UNAVAILABLE: 'p01-mutation-admission-serialization-unavailable',
    HELD: 'p01-mutation-admission-held',
    LEASE_INVALID: 'p01-mutation-admission-lease-invalid',
    HOLD_BUSY: 'p01-mutation-admission-hold-busy',
    HOLD_RELEASED: 'p01-mutation-admission-hold-released',
    INPUT_INVALID: 'p01-mutation-admission-input-invalid'
  })
});

function codeError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function defaultLockManager() {
  return globalThis.navigator?.locks || null;
}

export function createChromeP01MutationAdmission({
  lockManager = defaultLockManager()
} = {}) {
  let sequence = 0;
  let localActiveCount = 0;
  let holdState = null;
  const activeLeases = new WeakSet();

  function locksOrFail() {
    if (!lockManager || typeof lockManager.request !== 'function') {
      throw codeError(
        CHROME_P01_MUTATION_ADMISSION.ERROR.SERIALIZATION_UNAVAILABLE
      );
    }
    return lockManager;
  }

  function createLease(label) {
    let releaseRequested = false;
    let finalized = false;
    const lease = Object.freeze({
      schema: CHROME_P01_MUTATION_ADMISSION.LEASE_SCHEMA,
      id: `p01-admission-${++sequence}`,
      label: clean(label) || 'p01-mutation',
      release() {
        if (releaseRequested) return false;
        releaseRequested = true;
        return true;
      }
    });
    activeLeases.add(lease);
    localActiveCount += 1;
    return Object.freeze({
      lease,
      finalize() {
        if (finalized) return false;
        finalized = true;
        lease.release();
        activeLeases.delete(lease);
        localActiveCount = Math.max(0, localActiveCount - 1);
        return true;
      }
    });
  }

  async function executeAdmitted({ generationCheck, operation }, lease) {
    let generation;
    try {
      generation = await generationCheck();
    } catch (_) {
      generation = { permitted: false, reason: 'generation-unobserved' };
    }
    if (generation?.permitted !== true) {
      throw codeError(
        clean(generation?.reason) || 'p01-writer-stood-down'
      );
    }
    return operation(lease, generation);
  }

  async function run({
    label = 'p01-mutation',
    generationCheck,
    operation,
    existingLease = null
  } = {}) {
    if (typeof generationCheck !== 'function' ||
        typeof operation !== 'function') {
      throw codeError(CHROME_P01_MUTATION_ADMISSION.ERROR.INPUT_INVALID);
    }
    if (existingLease !== null) {
      if (!activeLeases.has(existingLease)) {
        throw codeError(CHROME_P01_MUTATION_ADMISSION.ERROR.LEASE_INVALID);
      }
      return executeAdmitted({ generationCheck, operation }, existingLease);
    }
    const locks = locksOrFail();
    return locks.request(
      CHROME_P01_MUTATION_ADMISSION.LOCK_NAME,
      { mode: 'shared', ifAvailable: true },
      async (lock) => {
        if (!lock) {
          throw codeError(CHROME_P01_MUTATION_ADMISSION.ERROR.HELD);
        }
        const scope = createLease(label);
        try {
          return await executeAdmitted(
            { generationCheck, operation },
            scope.lease
          );
        } finally {
          scope.finalize();
        }
      }
    );
  }

  function beginStanddownHold() {
    const locks = locksOrFail();
    if (holdState) {
      throw codeError(CHROME_P01_MUTATION_ADMISSION.ERROR.HOLD_BUSY);
    }

    const acquired = deferred();
    const released = deferred();
    /* release-before-drain is a supported cancellation path; attach a sink so
     * it cannot become an unhandled rejection when the caller intentionally
     * declines to await a cancelled hold. awaitDrained still sees rejection. */
    void acquired.promise.catch(() => {});
    const state = {
      phase: 'queued',
      releaseRequested: false,
      acquired,
      released,
      task: null,
      handle: null
    };
    const handle = Object.freeze({
      schema: CHROME_P01_MUTATION_ADMISSION.HOLD_SCHEMA,
      async awaitDrained() {
        await acquired.promise;
        return Object.freeze({
          drained: true,
          localActiveCount,
          lockName: CHROME_P01_MUTATION_ADMISSION.LOCK_NAME
        });
      },
      releaseStanddownHold() {
        if (state.releaseRequested) return false;
        state.releaseRequested = true;
        if (state.phase === 'queued') {
          acquired.reject(codeError(
            CHROME_P01_MUTATION_ADMISSION.ERROR.HOLD_RELEASED
          ));
          /* A queued Web Lock cannot be synchronously removed without adding
           * an AbortSignal dependency to every supported Chrome generation.
           * It is allowed to reach the head and releases immediately. */
        }
        released.resolve();
        return true;
      }
    });
    state.handle = handle;
    holdState = state;

    try {
      /* Calling request synchronously is load-bearing: the exclusive request
       * enters the Web Locks queue before beginStanddownHold returns, so a
       * later shared/ifAvailable admission cannot overtake the hold. */
      state.task = Promise.resolve(locks.request(
        CHROME_P01_MUTATION_ADMISSION.LOCK_NAME,
        { mode: 'exclusive' },
        async () => {
          state.phase = 'held';
          if (!state.releaseRequested) acquired.resolve();
          await released.promise;
          state.phase = 'releasing';
        }
      )).catch((error) => {
        if (!state.releaseRequested) {
          acquired.reject(codeError(
            CHROME_P01_MUTATION_ADMISSION.ERROR.SERIALIZATION_UNAVAILABLE,
            error
          ));
        }
      }).finally(() => {
        state.phase = 'released';
        if (holdState === state) holdState = null;
      });
    } catch (error) {
      holdState = null;
      throw codeError(
        CHROME_P01_MUTATION_ADMISSION.ERROR.SERIALIZATION_UNAVAILABLE,
        error
      );
    }
    return handle;
  }

  async function diagnose() {
    let locks = null;
    if (lockManager && typeof lockManager.query === 'function') {
      try { locks = await lockManager.query(); } catch (_) { locks = null; }
    }
    return Object.freeze({
      schema: CHROME_P01_MUTATION_ADMISSION.SCHEMA,
      lockName: CHROME_P01_MUTATION_ADMISSION.LOCK_NAME,
      localActiveCount,
      holdPhase: holdState?.phase || 'absent',
      locks
    });
  }

  return Object.freeze({
    schema: CHROME_P01_MUTATION_ADMISSION.SCHEMA,
    run,
    beginStanddownHold,
    diagnose
  });
}
