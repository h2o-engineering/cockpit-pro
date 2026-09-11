/*
 * O1-T19 — writer-generation record and its interpretation.
 *
 * One durable fact decides which writer generation owns this installation's
 * SYNC ARTIFACTS. Before the governed standdown P01 owns them; after, P02.
 * Every P01 path that can mutate a P01 sync artifact must consult this record
 * and refuse when the answer is p02.
 *
 * WHAT THE STANDDOWN IS, AND WHAT IT IS NOT (O1-B2.2 ownership ruling). Both
 * halves are load-bearing, and reading either one alone gets the product wrong:
 *
 *   Standdown stops P01 SYNC-ARTIFACT mutation capability. It is not a global
 *   freeze on canonical receive/apply, normal local editing, or separately
 *   governed operator ceremonies.
 *
 * Read the first half alone and a stood-down installation still publishes.
 * Read the second half alone and the standdown becomes a freeze: the user can
 * no longer rename a folder, an inbound convergence can no longer be applied,
 * and an operator ceremony that answers to its own authority is refused by a
 * record that was never its authority. The scope is the ARTIFACT, not the act
 * of writing - which is why the list of artifacts below is part of the contract
 * rather than a comment about it.
 *
 * THE FOUR ANSWERS ARE NOT THREE. It is tempting to collapse "no record" and
 * "could not read the record" into one, because both leave you without a value.
 * They must not be:
 *
 *   POSITIVELY OBSERVED ABSENT means the store answered, and there is nothing
 *   there. That is the pre-standdown world, and P01 must keep working exactly
 *   as it does today - anything else would stand P01 down merely because this
 *   new read exists.
 *
 *   UNOBSERVABLE means the store did not answer. We do not know which
 *   generation owns the data. Treating that as absent would let a transient
 *   storage failure re-authorize P01 writes into a repository that P02 already
 *   owns, which is the one outcome the whole standdown exists to prevent. It
 *   fails closed.
 *
 * So `readWriterGeneration` returns a state, never a bare string, and the
 * absence it reports is only ever an absence it actually saw.
 *
 * MALFORMED IS NOT ABSENT EITHER. A record we cannot parse is a record someone
 * wrote; guessing p01 because the JSON is bad would be guessing in the
 * dangerous direction.
 *
 * NOTHING HERE WRITES. The ceremony write belongs to a future governed
 * standdown, and this module deliberately offers no way to perform it - a
 * module that cannot write cannot accidentally stand P01 down.
 */

export const P02_WRITER_GENERATION = Object.freeze({
  /* The canonical key, identical on both platforms. */
  KEY: 'h2o:studio:sync:writer-generation:v1',
  SCHEMA: 'h2o.studio.syncWriterGeneration.v1',
  SCHEMA_VERSION: 1,
  P01: 'p01',
  P02: 'p02'
});

/*
 * The scope of the standdown, as data rather than prose, so a closure task can
 * assert against it and a future reader cannot narrow or widen it by memory.
 *
 * ARTIFACTS is the whole test. A path needs this gate when it produces or
 * mutates one of these; it does not need this gate merely because it writes
 * something durable. "Writes to disk" was never the criterion - if it were,
 * every local edit in the product would be refused the moment P01 stood down.
 */
export const P02_STANDDOWN_SCOPE = Object.freeze({
  SCHEMA: 'h2o.studio.syncStanddownScope.v1',

  STATEMENT: 'Standdown stops P01 sync-artifact mutation capability. It is not '
    + 'a global freeze on canonical receive/apply, normal local editing, or '
    + 'separately governed operator ceremonies.',

  OBLIGATION: 'Every P01 path that can mutate P01 sync artifacts must consult '
    + 'writer-generation.',

  /* What P01 publishes outward. Mutating one of these is what the gate governs. */
  ARTIFACTS: Object.freeze([
    'sync-folder latest.json and its per-peer device mirror',
    'chrome-latest.json export bundle',
    'h2o-local-publication.v1.json local publication slot',
    'round2-item9-delivery.json delivery envelope',
    'WebDAV object repository revision blobs and head documents',
    'the publication and export ledgers recording those publications'
  ]),

  /* Deliberately NOT governed by this record. Each answers to its own authority,
   * and gating it here would refuse a writer the standdown is meant to preserve. */
  OUT_OF_SCOPE: Object.freeze([
    { kind: 'receive-canonical-convergence',
      why: 'applying peer-observed evidence to local canonical state is the '
        + 'inbound direction; a standdown transfers who PUBLISHES, and an '
        + 'installation that can no longer accept convergence is not stood '
        + 'down, it is deaf' },
    { kind: 'ordinary-local-edit',
      why: 'the user editing their own data was never P01 publication; '
        + 'refusing it would make standdown indistinguishable from a freeze' },
    { kind: 'generic-shared-persistence-substrate',
      why: 'gating a substrate refuses every feature that shares it. The '
        + 'boundary is the P01 FEATURE ENTRY POINT that reaches it - which '
        + 'must consult the gate - not the substrate itself' },
    { kind: 'separately-governed-operator-ceremony',
      why: 'a ceremony with its own explicit operator authority is not '
        + 'governed by this record, and answering to two authorities would '
        + 'make neither of them the authority' }
  ])
});

export const P02_GENERATION_STATE = Object.freeze({
  /* The store answered and there is no record. Pre-standdown: P01 owns. */
  ABSENT_OBSERVED: 'absent-observed',
  /* A well-formed record naming a generation. */
  RECORDED: 'recorded',
  /* Something is there that we cannot interpret. */
  MALFORMED: 'malformed',
  /* The store did not answer. We do not know. */
  UNOBSERVED: 'unobserved'
});

export const P02_GENERATION_ERROR = Object.freeze({
  UNOBSERVED: 'generation-unobserved',
  MALFORMED: 'generation-record-malformed',
  STOOD_DOWN: 'p01-writer-stood-down',
  STORE_INVALID: 'p02-writer-generation-store-invalid'
});

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/*
 * A record read from a shared keyspace is untrusted input. Every required field
 * must be present and well-formed; a partially-valid record is malformed,
 * because acting on half a record is acting on a guess.
 */
function parseRecord(value) {
  const record = typeof value === 'string'
    ? (() => { try { return JSON.parse(value); } catch (_) { return null; } })()
    : value;
  if (!isPlainObject(record)) return null;
  if (record.schemaVersion !== P02_WRITER_GENERATION.SCHEMA_VERSION) return null;
  const generation = clean(record.generation);
  if (generation !== P02_WRITER_GENERATION.P01 &&
      generation !== P02_WRITER_GENERATION.P02) {
    return null;
  }
  /* A p02 record is a standdown DECISION, so it must say when it was taken, by
   * whom, and why. A p02 record with no provenance is not a decision anyone
   * can audit, and standing P01 down on it would be standing down on hearsay. */
  if (generation === P02_WRITER_GENERATION.P02) {
    const standdownAt = clean(record.standdownAt);
    if (!standdownAt || !Number.isFinite(Date.parse(standdownAt))) return null;
    if (!clean(record.decidedByWriterSyncPeerId)) return null;
    if (!clean(record.reason)) return null;
  }
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    generation,
    standdownAt: clean(record.standdownAt) || null,
    decidedByWriterSyncPeerId: clean(record.decidedByWriterSyncPeerId) || null,
    reason: clean(record.reason) || null
  });
}

/*
 * Read the generation. `store.read(key)` must resolve to the stored value, to
 * null for a proven absence, and REJECT when it could not read - the three are
 * distinguished here and nowhere else.
 */
export async function readWriterGeneration({ store } = {}) {
  if (!isPlainObject(store) || typeof store.read !== 'function') {
    /* No store is not the same as an empty store. */
    return Object.freeze({
      state: P02_GENERATION_STATE.UNOBSERVED,
      generation: null, record: null, reason: P02_GENERATION_ERROR.STORE_INVALID
    });
  }
  let raw;
  try {
    raw = await store.read(P02_WRITER_GENERATION.KEY);
  } catch (error) {
    return Object.freeze({
      state: P02_GENERATION_STATE.UNOBSERVED,
      generation: null, record: null,
      reason: clean(error?.code) || P02_GENERATION_ERROR.UNOBSERVED
    });
  }
  if (raw === null || raw === undefined) {
    /* Positively observed absence. This IS the pre-standdown answer. */
    return Object.freeze({
      state: P02_GENERATION_STATE.ABSENT_OBSERVED,
      generation: P02_WRITER_GENERATION.P01,
      record: null, reason: null
    });
  }
  const record = parseRecord(raw);
  if (record === null) {
    return Object.freeze({
      state: P02_GENERATION_STATE.MALFORMED,
      generation: null, record: null, reason: P02_GENERATION_ERROR.MALFORMED
    });
  }
  return Object.freeze({
    state: P02_GENERATION_STATE.RECORDED,
    generation: record.generation, record, reason: null
  });
}

/*
 * The single predicate every P01 MUTATION seam consults.
 *
 * It answers one question - may a P01 writer mutate right now - and it answers
 * it conservatively. Only two observations permit mutation: a proven absence,
 * and a well-formed record that says p01. Everything else refuses.
 */
export function p01MutationPermitted(observation) {
  const state = clean(observation?.state);
  if (state === P02_GENERATION_STATE.ABSENT_OBSERVED) {
    return Object.freeze({ permitted: true, reason: null, generation: P02_WRITER_GENERATION.P01 });
  }
  if (state === P02_GENERATION_STATE.RECORDED &&
      observation.generation === P02_WRITER_GENERATION.P01) {
    return Object.freeze({ permitted: true, reason: null, generation: P02_WRITER_GENERATION.P01 });
  }
  if (state === P02_GENERATION_STATE.RECORDED &&
      observation.generation === P02_WRITER_GENERATION.P02) {
    return Object.freeze({
      permitted: false, reason: P02_GENERATION_ERROR.STOOD_DOWN,
      generation: P02_WRITER_GENERATION.P02
    });
  }
  /* Malformed and unobserved both land here, and both fail closed. */
  return Object.freeze({
    permitted: false,
    reason: state === P02_GENERATION_STATE.MALFORMED
      ? P02_GENERATION_ERROR.MALFORMED
      : P02_GENERATION_ERROR.UNOBSERVED,
    generation: null
  });
}

/*
 * The gate a seam actually calls. One read, one verdict, and a typed refusal
 * that names which of the four observations produced it.
 *
 * Each platform must supply its OWN store. A Desktop writer that consulted a
 * Chrome record - or vice versa - would let one platform's readable store
 * authorize the other platform's writes, so the gate takes the store rather
 * than reaching for a shared one.
 */
export function createP01MutationGate({ store, seamName = 'p01-writer' } = {}) {
  const verdictFor = async () => {
    const observation = await readWriterGeneration({ store });
    const verdict = p01MutationPermitted(observation);
    return Object.freeze({
      ...verdict,
      seamName,
      observationState: observation.state,
      record: observation.record
    });
  };
  return Object.freeze({
    schema: P02_WRITER_GENERATION.SCHEMA,
    seamName,
    /* Read-only by construction: there is no write method to find. */
    async observe() { return readWriterGeneration({ store }); },
    /*
     * O1-B2.1. `p01MayMutate` is the name EVERY seam calls - the writer that
     * takes an injected gate, the global gate the classic scripts install, and
     * the native gate's equivalent. This surface used to offer only
     * `requirePermitted`, so a seam that asked it for `p01MayMutate` got
     * `undefined`, called it, threw a TypeError, and had that TypeError
     * swallowed by its own fail-closed catch - a gate that appeared wired and
     * answered nothing. One operation now has one name across every surface,
     * which removes the mismatch rather than documenting it.
     */
    p01MayMutate: verdictFor,
    /*
     * The boolean form two Desktop seams call by name. It exists here for the
     * same reason p01MayMutate does: those seams treat a MISSING method as "no
     * gate installed" and permit, so a surface lacking it would fail OPEN
     * rather than closed. Every gate surface offers every name a seam calls.
     */
    async p01MayMutateBoolean() {
      try { return (await verdictFor()).permitted === true; }
      catch (_) { return false; }
    },
    /* The original name, kept so existing callers keep resolving. */
    requirePermitted: verdictFor
  });
}

/*
 * The ceremony and rollback SPECIFICATIONS.
 *
 * Recorded as data rather than prose so the closure task can assert against
 * them, and deliberately NOT executable - there is no runner here, and nothing
 * in this module can write the record these steps describe.
 */
export const P02_STANDDOWN_CEREMONY = Object.freeze({
  SCHEMA: 'h2o.studio.syncStanddownCeremony.spec.v1',
  executable: false,
  steps: Object.freeze([
    { order: 1, step: 'verify-p02-foundation-and-authority',
      why: 'standing P01 down before P02 can write would leave no writer at all' },
    { order: 2, step: 'stop-new-p01-mutation-admission',
      why: 'draining is meaningless while new work is still being admitted' },
    { order: 3, step: 'drain-active-p01-mutation',
      why: 'a mutation in flight during the switch would land in a repository '
        + 'that no longer authorizes it' },
    { order: 4, step: 'verify-p01-writer-quiescence',
      why: 'draining is an action; quiescence is the observation that it worked' },
    { order: 5, step: 'recover-or-abandon-retained-p02-intents',
      why: 'retained intents must be reconciled WHILE P02 machinery is still '
        + 'authorized, because afterwards nothing may act on them' },
    { order: 6, step: 'write-generation-p02',
      why: 'the single durable fact that transfers ownership' },
    { order: 7, step: 'read-back-verify',
      why: 'a write that cannot be read back has not happened' },
    { order: 8, step: 'restart-both-platforms',
      why: 'a long-lived process may hold a pre-standdown observation' },
    { order: 9, step: 'prove-all-p01-mutation-paths-refused',
      why: 'the point of the ceremony is the refusal, so the refusal is what '
        + 'must be demonstrated' },
    { order: 10, step: 'steady-activation-under-its-own-separate-gate',
      why: 'standdown transfers ownership; it does not start anything' }
  ])
});

export const P02_ROLLBACK_CEREMONY = Object.freeze({
  SCHEMA: 'h2o.studio.syncGenerationRollback.spec.v1',
  executable: false,
  /* Rollback is not "change the string back". Between p02 and p01 there may be
   * P02 state in flight, and reverting ownership under it would strand it. */
  steps: Object.freeze([
    { order: 1, step: 'disable-steady-p02',
      why: 'no new P02 work may start while ownership is being reverted' },
    { order: 2, step: 'verify-no-active-p02-write-lease',
      why: 'a live lease means a write may be in progress right now' },
    { order: 3, step: 'recover-or-abandon-retained-p02-intents-under-p02-authority',
      why: 'the same drain rule as standdown, in the other direction - after '
        + 'the revert nothing may act on a P02 intent' },
    { order: 4, step: 'reconcile-repository-and-canonical-state',
      why: 'P01 is about to own data P02 has been writing' },
    { order: 5, step: 'write-generation-p01-under-governed-ceremony',
      why: 'ownership transfer is always a governed act, in both directions' },
    { order: 6, step: 'read-back-verify', why: 'as above' },
    { order: 7, step: 'restart-and-prove-durability', why: 'as above' },
    { order: 8, step: 're-prove-p01-mutation-capability',
      why: 'a rollback that leaves P01 still refusing has not rolled anything back' }
  ])
});
